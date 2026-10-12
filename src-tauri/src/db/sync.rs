//! Schema synchronisation — reconciling DDL generation.
//!
//! Turns a [`SchemaDiff`](super::diff::SchemaDiff) (target vs. source) into the
//! DDL that would make the *target* match the *source*: `CREATE TABLE` for
//! source-only tables, `ALTER TABLE ADD/MODIFY/DROP COLUMN` for differing
//! tables, and `DROP TABLE` for target-only tables.
//!
//! The generator is pure and driver-aware (MySQL / PostgreSQL / SQLite), which
//! keeps it unit-testable without a database; the command layer
//! (`commands::sync`) renders the plan and, on explicit confirmation, applies
//! the selected statements through a writable target session.
//!
//! Two safety rules are baked in here:
//! * **Destructive statements (`DROP TABLE` / `DROP COLUMN`) are emitted only
//!   when `allow_destructive` is set.** Otherwise they are silently skipped so
//!   a careless "apply everything" can never drop data.
//! * **Cases a driver cannot express are not faked.** SQLite cannot alter a
//!   column in place, so such diffs become a human-readable `warning` instead
//!   of an unsound statement. Callers surface warnings next to the SQL.
//!
//! This is best-effort DDL meant to be reviewed before applying: defaults are
//! reproduced verbatim from introspection, and PK/FK reshaping on an existing
//! column is reported as a warning rather than guessed at.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use super::diff::{DiffForeignKey, DiffStatus, SchemaDiff, TableDiff};
use super::table_ddl::{render_foreign_key, FkGroup};
use super::types::TableColumnInfo;
use super::DriverKind;

/// What a generated statement does, so the UI can group / badge it and gate the
/// destructive ones.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncKind {
    CreateTable,
    AddColumn,
    AlterColumn,
    /// `CREATE TABLE` 同期の外部キー (MySQL / PostgreSQL は全 CREATE の後の
    /// `ALTER TABLE ... ADD CONSTRAINT`。SQLite は CREATE TABLE 内に含めるので出ない)。
    AddForeignKey,
    DropColumn,
    DropTable,
    // Data-level statements (`db::data_diff`).
    InsertRow,
    UpdateRow,
    DeleteRow,
}

impl SyncKind {
    /// Apply-order priority: create first, drop last, so a single batch never
    /// drops something another statement still needs. Data statements
    /// (insert → update → delete) sort after schema statements.
    pub(crate) fn order(self) -> u8 {
        match self {
            SyncKind::CreateTable => 0,
            SyncKind::AddColumn => 1,
            SyncKind::AlterColumn => 2,
            SyncKind::AddForeignKey => 3,
            SyncKind::DropColumn => 4,
            SyncKind::DropTable => 5,
            SyncKind::InsertRow => 6,
            SyncKind::UpdateRow => 7,
            SyncKind::DeleteRow => 8,
        }
    }
}

/// One reconciling DDL statement.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncStatement {
    pub sql: String,
    pub table: String,
    pub kind: SyncKind,
    /// True for `DROP` statements — gated behind `allow_destructive` and
    /// flagged in the UI.
    pub destructive: bool,
}

/// The full reconciliation plan: executable statements plus notes about diffs
/// that could not be turned into a statement for the target driver.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncPlan {
    pub statements: Vec<SyncStatement>,
    pub warnings: Vec<String>,
}

/// Generates the DDL that makes the target match the source. Statements are
/// returned in a safe apply order (creates → adds → alters → drops). When
/// `allow_destructive` is false, `DROP TABLE` / `DROP COLUMN` are omitted.
pub fn generate_sync_sql(diff: &SchemaDiff, allow_destructive: bool) -> SyncPlan {
    let driver = diff.target_driver;
    let mut statements: Vec<SyncStatement> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();

    // 生成列の都合で CREATE TABLE 自体を出さない表。外部キーの参照先がこれだと
    // 適用に失敗するので、その FK は出さずに警告する。
    let uncreatable: HashSet<&str> = diff
        .tables
        .iter()
        .filter(|t| t.status == DiffStatus::SourceOnly && !can_create_table(driver, t))
        .map(|t| t.name.as_str())
        .collect();

    let drop_order = if allow_destructive {
        drop_table_order(diff, &mut warnings)
    } else {
        HashMap::new()
    };

    for table in &diff.tables {
        match table.status {
            DiffStatus::Same => {}
            DiffStatus::SourceOnly => {
                if let Some(stmt) =
                    create_table_stmt(driver, table, &uncreatable, &mut statements, &mut warnings)
                {
                    statements.push(stmt);
                }
            }
            DiffStatus::TargetOnly => {
                if allow_destructive {
                    statements.push(SyncStatement {
                        sql: format!("DROP TABLE {}", quote_ident(driver, &table.name)),
                        table: table.name.clone(),
                        kind: SyncKind::DropTable,
                        destructive: true,
                    });
                }
            }
            DiffStatus::Different => {
                alter_table(
                    driver,
                    table,
                    allow_destructive,
                    &mut statements,
                    &mut warnings,
                );
            }
        }
    }

    statements.sort_by(|a, b| {
        a.kind.order().cmp(&b.kind.order()).then_with(|| {
            if a.kind == SyncKind::DropTable {
                // 外部キーの子 → 親の順 (表名順ではなく依存順)。
                let rank = |s: &SyncStatement| drop_order.get(&s.table).copied().unwrap_or(0);
                rank(a).cmp(&rank(b)).then(a.table.cmp(&b.table))
            } else {
                a.table.cmp(&b.table)
            }
        })
    });

    SyncPlan {
        statements,
        warnings,
    }
}

/// `DROP TABLE` の順位 (小さいほど先)。target のみの表同士の外部キーを見て、
/// 子 (参照する側) を親 (参照される側) より先に落とす。循環があれば残りを名前順で
/// 末尾に回し、警告を出す。
fn drop_table_order(diff: &SchemaDiff, warnings: &mut Vec<String>) -> HashMap<String, usize> {
    let mut names: Vec<&str> = diff
        .tables
        .iter()
        .filter(|t| t.status == DiffStatus::TargetOnly)
        .map(|t| t.name.as_str())
        .collect();
    names.sort_unstable();
    // parent -> 参照している子 (自己参照は除く)
    let mut children: HashMap<&str, HashSet<&str>> = HashMap::new();
    for t in diff
        .tables
        .iter()
        .filter(|t| t.status == DiffStatus::TargetOnly)
    {
        for fk in &t.foreign_keys {
            let parent = fk.referenced_table.as_str();
            if parent != t.name && names.binary_search(&parent).is_ok() {
                children.entry(parent).or_default().insert(t.name.as_str());
            }
        }
    }
    let mut order: HashMap<String, usize> = HashMap::new();
    let mut remaining: Vec<&str> = names;
    while !remaining.is_empty() {
        let ready: Vec<&str> = remaining
            .iter()
            .copied()
            .filter(|n| {
                children
                    .get(n)
                    .map_or(true, |cs| cs.iter().all(|c| order.contains_key(*c)))
            })
            .collect();
        if ready.is_empty() {
            warnings.push(format!(
                "外部キーが循環しているため、DROP TABLE の順序を決められません (先に制約を外す必要があります): {}",
                remaining.join(", ")
            ));
            for n in &remaining {
                let next = order.len();
                order.insert((*n).to_string(), next);
            }
            break;
        }
        for n in &ready {
            let next = order.len();
            order.insert((*n).to_string(), next);
        }
        remaining.retain(|n| !ready.contains(n));
    }
    order
}

/// Builds the `CREATE TABLE` for a source-only table from its source-side
/// column definitions, appending a `PRIMARY KEY (...)` clause for any columns
/// flagged `PRI`.
/// 生成列を除いても主キーと列が残り、`CREATE TABLE` を出せるか。
fn can_create_table(driver: DriverKind, table: &TableDiff) -> bool {
    let mut any_column = false;
    for c in table.columns.iter().filter_map(|c| c.source.as_ref()) {
        if is_generated_column(driver, c) {
            if c.key.eq_ignore_ascii_case("PRI") {
                return false;
            }
        } else {
            any_column = true;
        }
    }
    any_column
}

fn create_table_stmt(
    driver: DriverKind,
    table: &TableDiff,
    uncreatable: &HashSet<&str>,
    fk_statements: &mut Vec<SyncStatement>,
    warnings: &mut Vec<String>,
) -> Option<SyncStatement> {
    let mut cols: Vec<&TableColumnInfo> = Vec::new();
    let mut pk_generated = false;
    for c in table.columns.iter().filter_map(|c| c.source.as_ref()) {
        if is_generated_column(driver, c) {
            warnings.push(generated_column_warning(&table.name, &c.name));
            if c.key.eq_ignore_ascii_case("PRI") {
                pk_generated = true;
            }
        } else {
            cols.push(c);
        }
    }

    // 生成列を除くと主キーが変わる / 列が無くなる場合は、誤った構造のテーブルを
    // 作らないよう CREATE TABLE 自体を出さない。
    if pk_generated || cols.is_empty() {
        warnings.push(format!(
            "{}: 生成列を除外すると主キーが変わる、または作成できる列が無いため CREATE TABLE を生成しません。手動で作成してください。",
            table.name
        ));
        return None;
    }

    let mut lines: Vec<String> = cols.iter().map(|c| column_def(driver, c)).collect();

    let pk: Vec<String> = cols
        .iter()
        .filter(|c| c.key.eq_ignore_ascii_case("PRI"))
        .map(|c| quote_ident(driver, &c.name))
        .collect();
    if !pk.is_empty() {
        lines.push(format!("PRIMARY KEY ({})", pk.join(", ")));
    }

    // 外部キー (制約単位。複合キー・ON DELETE / ON UPDATE を保つ)。SQLite は
    // ALTER TABLE で制約を足せないので CREATE TABLE 内に、MySQL / PostgreSQL は
    // 全 CREATE の後の `ALTER TABLE ... ADD CONSTRAINT` にする (参照先の作成順や
    // 循環参照を気にしなくて済む)。以前は黙って落としていた (#1530)。
    let col_names: HashSet<&str> = cols.iter().map(|c| c.name.as_str()).collect();
    for fk in &table.foreign_keys {
        if let Some(missing) = fk.columns.iter().find(|c| !col_names.contains(c.as_str())) {
            warnings.push(format!(
                "{}: 外部キー ({}) は CREATE TABLE から除いた列 {} を含むため出力しません。",
                table.name,
                fk.columns.join(", "),
                missing
            ));
            continue;
        }
        if uncreatable.contains(fk.referenced_table.as_str()) {
            warnings.push(format!(
                "{}: 外部キー ({}) の参照先 {} は CREATE TABLE を生成しないため出力しません。",
                table.name,
                fk.columns.join(", "),
                fk.referenced_table
            ));
            continue;
        }
        // MySQL (InnoDB) は `SET DEFAULT` の参照動作を拒否する (PostgreSQL ソース由来)。
        // 動作を外して既定にし、警告する。
        let mut fk = fk.clone();
        if driver == DriverKind::Mysql {
            for (label, action) in [
                ("ON DELETE", &mut fk.on_delete),
                ("ON UPDATE", &mut fk.on_update),
            ] {
                if action
                    .as_deref()
                    .is_some_and(|a| a.eq_ignore_ascii_case("SET DEFAULT"))
                {
                    *action = None;
                    warnings.push(format!(
                        "{}: 外部キー ({}) の {label} SET DEFAULT は MySQL (InnoDB) で使えないため外しました。",
                        table.name,
                        fk.columns.join(", ")
                    ));
                }
            }
        }
        let clause = render_foreign_key(driver, &fk_group(&fk));
        if driver == DriverKind::Sqlite {
            lines.push(clause);
        } else {
            fk_statements.push(SyncStatement {
                sql: format!(
                    "ALTER TABLE {} ADD {}",
                    quote_ident(driver, &table.name),
                    clause
                ),
                table: table.name.clone(),
                kind: SyncKind::AddForeignKey,
                destructive: false,
            });
        }
    }
    // 単一列の索引 (UNIQUE / INDEX) は列情報の `key` にしか無く、複合索引や名前を
    // 再現できない。省略したことを利用者に知らせる (外部キーの列は MySQL が索引を
    // 自動で作るので MUL でも除く)。
    let fk_cols: HashSet<&str> = table
        .foreign_keys
        .iter()
        .flat_map(|f| f.columns.iter().map(String::as_str))
        .collect();
    let indexed: Vec<&str> = cols
        .iter()
        .filter(|c| {
            c.key.eq_ignore_ascii_case("UNI")
                || (c.key.eq_ignore_ascii_case("MUL") && !fk_cols.contains(c.name.as_str()))
        })
        .map(|c| c.name.as_str())
        .collect();
    if !indexed.is_empty() {
        warnings.push(format!(
            "{}: 索引 (UNIQUE / INDEX) は CREATE TABLE に含まれません (対象列: {})。必要に応じて手動で作成してください。",
            table.name,
            indexed.join(", ")
        ));
    }

    let sql = render_create_table(&quote_ident(driver, &table.name), &lines);
    Some(SyncStatement {
        sql,
        table: table.name.clone(),
        kind: SyncKind::CreateTable,
        destructive: false,
    })
}

/// `DiffForeignKey` を DDL 再構成 (`db::table_ddl`) と共通の描画へ渡す形にする。
fn fk_group(fk: &DiffForeignKey) -> FkGroup<'_> {
    FkGroup {
        name: fk.name.as_deref(),
        referenced_table: &fk.referenced_table,
        columns: fk.columns.iter().map(String::as_str).collect(),
        referenced_columns: if fk.referenced_columns.is_empty() {
            fk.columns.iter().map(|_| None).collect()
        } else {
            fk.referenced_columns
                .iter()
                .map(|c| Some(c.as_str()))
                .collect()
        },
        on_delete: fk.on_delete.as_deref(),
        on_update: fk.on_update.as_deref(),
    }
}

/// Renders `CREATE TABLE <qualified> (\n  <line>,\n  ...\n)` from already
/// rendered body lines (column defs + table constraints). Shared by the sync
/// CREATE branch and the table-DDL reconstruction (`db::table_ddl`, #1001) so
/// both produce the same layout.
pub(crate) fn render_create_table(qualified: &str, lines: &[String]) -> String {
    format!("CREATE TABLE {} (\n  {}\n)", qualified, lines.join(",\n  "))
}

/// Emits add / modify / drop column statements for a table present on both
/// sides, pushing warnings for changes the driver cannot express.
fn alter_table(
    driver: DriverKind,
    table: &TableDiff,
    allow_destructive: bool,
    statements: &mut Vec<SyncStatement>,
    warnings: &mut Vec<String>,
) {
    let tident = quote_ident(driver, &table.name);
    for col in &table.columns {
        match col.status {
            DiffStatus::SourceOnly => {
                if let Some(src) = &col.source {
                    if is_generated_column(driver, src) {
                        warnings.push(generated_column_warning(&table.name, &src.name));
                        continue;
                    }
                    statements.push(SyncStatement {
                        sql: format!(
                            "ALTER TABLE {} ADD COLUMN {}",
                            tident,
                            column_def(driver, src)
                        ),
                        table: table.name.clone(),
                        kind: SyncKind::AddColumn,
                        destructive: false,
                    });
                }
            }
            DiffStatus::TargetOnly => {
                if allow_destructive {
                    statements.push(SyncStatement {
                        sql: format!(
                            "ALTER TABLE {} DROP COLUMN {}",
                            tident,
                            quote_ident(driver, &col.name)
                        ),
                        table: table.name.clone(),
                        kind: SyncKind::DropColumn,
                        destructive: true,
                    });
                }
            }
            DiffStatus::Different => {
                if let Some(src) = &col.source {
                    // target 側が生成列の場合も MODIFY で生成式が失われるため対象外。
                    let target_generated = col
                        .target
                        .as_ref()
                        .is_some_and(|t| is_generated_column(driver, t));
                    if is_generated_column(driver, src) || target_generated {
                        warnings.push(generated_column_warning(&table.name, &src.name));
                        continue;
                    }
                    modify_column(
                        driver,
                        &table.name,
                        &tident,
                        src,
                        &col.changed_fields,
                        statements,
                        warnings,
                    );
                }
            }
            DiffStatus::Same => {}
        }
    }
}

/// Emits the statement(s) that align an existing column with its source-side
/// definition. MySQL rewrites the whole column in one `MODIFY`; PostgreSQL
/// needs a separate `ALTER COLUMN` per facet; SQLite cannot do it at all.
fn modify_column(
    driver: DriverKind,
    table: &str,
    tident: &str,
    src: &TableColumnInfo,
    changed_fields: &[String],
    statements: &mut Vec<SyncStatement>,
    warnings: &mut Vec<String>,
) {
    let cident = quote_ident(driver, &src.name);
    match driver {
        DriverKind::Mysql => {
            // 修正 L3: key / foreign_key の差分は `MODIFY COLUMN` では反映され
            // ない (キー制約自体は変更されないため)。それだけの差分に対して
            // MODIFY を出しても差分は永遠に解消されない — それどころか、
            // source 側が auto_increment で target 側にキーが無いケースでは
            // 「Incorrect table definition; there can be only one auto column
            // and it must be defined as a key」で失敗するだけになる。
            // PostgreSQL 分岐と同じ方針で警告に落とす。
            let key_or_fk_changed = changed_fields
                .iter()
                .any(|f| f == "key" || f == "foreign_key");
            let other_changed = changed_fields
                .iter()
                .any(|f| f != "key" && f != "foreign_key");
            if other_changed {
                statements.push(SyncStatement {
                    sql: format!(
                        "ALTER TABLE {} MODIFY COLUMN {}",
                        tident,
                        column_def(driver, src)
                    ),
                    table: table.to_string(),
                    kind: SyncKind::AlterColumn,
                    destructive: false,
                });
            }
            if key_or_fk_changed {
                warnings.push(format!(
                    "{}.{}: キー / 外部キーの差分は自動生成の対象外です。MODIFY COLUMN では \
                     キー制約が変更されないため、必要に応じて手動で ALTER TABLE ... ADD/DROP \
                     {{PRIMARY KEY|INDEX|FOREIGN KEY}} を実行してください。",
                    table, src.name
                ));
            }
        }
        DriverKind::Postgres => {
            let mut emitted = false;
            if changed_fields.iter().any(|f| f == "data_type") {
                statements.push(pg_alter(
                    table,
                    format!(
                        "ALTER TABLE {tident} ALTER COLUMN {cident} TYPE {}",
                        src.data_type
                    ),
                ));
                emitted = true;
            }
            if changed_fields.iter().any(|f| f == "nullable") {
                let clause = if src.nullable {
                    "DROP NOT NULL"
                } else {
                    "SET NOT NULL"
                };
                statements.push(pg_alter(
                    table,
                    format!("ALTER TABLE {tident} ALTER COLUMN {cident} {clause}"),
                ));
                emitted = true;
            }
            if changed_fields.iter().any(|f| f == "default") {
                let stmt = match &src.default {
                    Some(d) => {
                        format!("ALTER TABLE {tident} ALTER COLUMN {cident} SET DEFAULT {d}")
                    }
                    None => format!("ALTER TABLE {tident} ALTER COLUMN {cident} DROP DEFAULT"),
                };
                statements.push(pg_alter(table, stmt));
                emitted = true;
            }
            // PK / FK reshaping on an existing column needs constraint juggling
            // we don't attempt; flag it so the user handles it deliberately.
            if changed_fields
                .iter()
                .any(|f| f == "key" || f == "foreign_key")
            {
                warnings.push(format!(
                    "{}.{}: key / foreign-key changes are not auto-generated; adjust constraints manually.",
                    table, src.name
                ));
            }
            if !emitted
                && !changed_fields
                    .iter()
                    .any(|f| f == "key" || f == "foreign_key")
            {
                // Only `extra` differed (e.g. a generated-column marker, which is not synced), nothing to do.
            }
        }
        DriverKind::Sqlite => {
            warnings.push(format!(
                "{}.{}: SQLite cannot alter a column in place; recreate the table to change it.",
                table, src.name
            ));
        }
    }
}

fn pg_alter(table: &str, sql: String) -> SyncStatement {
    SyncStatement {
        sql,
        table: table.to_string(),
        kind: SyncKind::AlterColumn,
        destructive: false,
    }
}

/// Renders a single column definition (`<ident> <type> [NOT NULL] [DEFAULT x]
/// [extra]`). `data_type` comes verbatim from introspection (including any
/// length/precision, e.g. `varchar(50)` / `character varying(50)`); the
/// `DEFAULT` clause is built by [`default_clause`]. `extra` (e.g.
/// `auto_increment`) is MySQL-only. Shared with the table-DDL reconstruction
/// (`db::table_ddl`, #1001) so "Copy DDL" renders columns exactly the way the
/// sync / sandbox CREATE path does.
pub(crate) fn column_def(driver: DriverKind, col: &TableColumnInfo) -> String {
    let mut def = format!("{} {}", quote_ident(driver, &col.name), col.data_type);
    if !col.nullable {
        def.push_str(" NOT NULL");
    }
    if let Some(clause) = default_clause(driver, col) {
        def.push(' ');
        def.push_str(&clause);
    }
    if driver == DriverKind::Mysql {
        let extra = mysql_extra_clause(&col.extra);
        if !extra.is_empty() {
            def.push(' ');
            def.push_str(&extra);
        }
        // MODIFY COLUMN は COMMENT 句を省くと列コメントを空に戻すため、
        // 取得済みのコメントは必ず出力する (単引用符・バックスラッシュは二重化)。
        if let Some(comment) = col.comment.as_deref().filter(|c| !c.is_empty()) {
            def.push_str(" COMMENT ");
            def.push_str(&mysql_quote_default(comment));
        }
    }
    def
}

/// 生成列 (MySQL の `STORED/VIRTUAL GENERATED`、PostgreSQL の
/// `GENERATED ALWAYS AS (...) STORED`)。`extra` で判定する。生成式を保持して
/// いないので、通常列として ADD / MODIFY / CREATE すると同期後のスキーマが
/// 静かに変わってしまう。自動同期の対象から外す。
/// `driver` は宛先。SQLite 宛て (サンドボックス作成) では外さない: 後続の取り込みが
/// 全列を INSERT するので、生成列を CREATE に含めて通常列として持たせる必要がある。
fn is_generated_column(driver: DriverKind, col: &TableColumnInfo) -> bool {
    driver != DriverKind::Sqlite && col.is_generated()
}

fn generated_column_warning(table: &str, column: &str) -> String {
    format!(
        "{table}.{column}: 生成列は自動同期の対象外です (生成式を保持していないため)。必要に応じて手動で追加・変更してください。"
    )
}

/// MySQL の `information_schema.COLUMNS.EXTRA` から DDL にそのまま書ける語だけを
/// 残す。`DEFAULT_GENERATED` / `STORED GENERATED` / `VIRTUAL GENERATED` は
/// 情報表示用のマーカーで、DDL に連結すると構文エラーになる
/// (`auto_increment` や `on update CURRENT_TIMESTAMP` は有効な句なので残す)。
fn mysql_extra_clause(extra: &str) -> String {
    let mut s = extra.to_string();
    for marker in ["DEFAULT_GENERATED", "STORED GENERATED", "VIRTUAL GENERATED"] {
        loop {
            let upper = s.to_ascii_uppercase();
            match upper.find(marker) {
                Some(i) => s.replace_range(i..i + marker.len(), " "),
                None => break,
            }
        }
    }
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// 修正 L2: `DEFAULT ...` 句を組み立てる。デフォルトが無ければ `None`。
///
/// MySQL の `information_schema.COLUMNS.COLUMN_DEFAULT` は文字列リテラルを
/// **クオートなし**で返す (列定義が `DEFAULT 'pending'` でも `COLUMN_DEFAULT`
/// は `pending` になる)。これを旧実装のように `DEFAULT {d}` で逐語埋め込む
/// と `DEFAULT pending` という不正な DDL になってしまう。加えて空文字
/// デフォルト (`DEFAULT ''`) は旧実装の `!d.is_empty()` ガードにより無音で
/// 消えていた (MODIFY 時にデフォルトが消失する)。ここでは MySQL のみ、型と
/// `extra` を見てクオートするかどうかを切り替える:
///
/// - `extra` に `DEFAULT_GENERATED` を含む場合 (`CURRENT_TIMESTAMP` や
///   MySQL 8.0 の式デフォルト `(expr)`) はクオートすると壊れるため逐語のまま
///   出す。**この分岐は下の型判定より先に評価される** — 呼び出し元
///   (このセレクトを含むこの関数自体) が `extra` を先に見て早期リターンする
///   ため、日時/バイナリ/JSON のような「式デフォルトが一般的な型」を下の
///   `is_mysql_string_default_type` に加えても、式デフォルト
///   (`CURRENT_TIMESTAMP` 等) は常にこの分岐で先に捕まり、二重クオート
///   (`DEFAULT '(CURRENT_TIMESTAMP)'` のような壊れた DDL) にはならない。
/// - 文字列リテラルとしてクオートし直すべき型
///   (`char`/`varchar`/`*text`/`enum`/`set`、および `date`/`datetime`/
///   `timestamp`/`time`/`year`/`binary`/`varbinary`/`*blob`/`json` —
///   これらは `information_schema.COLUMNS.COLUMN_DEFAULT` がクオート無しの
///   リテラル値をそのまま返す点で文字列型と同じ扱いが要る。例:
///   `date` 列のデフォルト `2020-01-01` を逐語で `DEFAULT 2020-01-01` と
///   出力すると構文エラーになる) はクオートし直す — 空文字も `DEFAULT ''`
///   として (消さずに) 出力する。
/// - それ以外 (数値・真偽値など) は従来どおり逐語で出す。
///
/// PostgreSQL / SQLite の `column_default` は introspection が既に
/// クオート/キャスト済みの式 (`'x'::character varying` 等) を返すため、
/// これらは常に逐語でよい (現状維持)。
fn default_clause(driver: DriverKind, col: &TableColumnInfo) -> Option<String> {
    let d = col.default.as_ref()?;
    if driver != DriverKind::Mysql {
        return Some(format!("DEFAULT {d}"));
    }
    if col.extra.to_ascii_uppercase().contains("DEFAULT_GENERATED") {
        return Some(format!("DEFAULT {d}"));
    }
    if is_mysql_string_default_type(&col.data_type) {
        return Some(format!("DEFAULT {}", mysql_quote_default(d)));
    }
    Some(format!("DEFAULT {d}"))
}

/// True if `data_type` (MySQL 表記。`varchar(50)` のように長さ付きでもよい)
/// が、デフォルト値を文字列リテラルとしてクオートすべき型かどうか。
///
/// 文字型に加え、日付・時刻型 (`date`/`datetime`/`timestamp`/`time`/`year`) と
/// バイナリ型 (`binary`/`varbinary`/`*blob`)・`json` も対象に含める。MySQL の
/// `information_schema.COLUMNS.COLUMN_DEFAULT` はこれらもクオート無しのリテラル
/// (例: `date` 列の `2020-01-01`) で返すため、文字列系と同じくクオートし直さ
/// ないと `DEFAULT 2020-01-01` のような不正な DDL になる (#H5)。式デフォルト
/// (`CURRENT_TIMESTAMP` 等) は呼び出し元 `default_clause` が `extra` の
/// `DEFAULT_GENERATED` で先に弾くため、ここに含めても二重クオートにはならない
/// (詳細は `default_clause` のドキュメントコメント参照)。
fn is_mysql_string_default_type(data_type: &str) -> bool {
    const STRING_PREFIXES: [&str; 18] = [
        "char",
        "varchar",
        "tinytext",
        "mediumtext",
        "longtext",
        "text",
        "enum",
        "date",
        "datetime",
        "timestamp",
        "time",
        "year",
        "binary",
        "varbinary",
        "tinyblob",
        "mediumblob",
        "longblob",
        "blob",
    ];
    let lower = data_type.to_ascii_lowercase();
    // "set('a','b')" も文字列扱い。`json` は前置詞衝突 (`char` 等) が無いので
    // 単体で判定する。
    lower.starts_with("set")
        || lower.starts_with("json")
        || STRING_PREFIXES.iter().any(|p| lower.starts_with(p))
}

/// MySQL の文字列デフォルトをクオートする。シングルクオートを二重化し、
/// MySQL の既定モード (`\` をエスケープ文字として扱う) に合わせてバック
/// スラッシュも二重化する (`db::data_diff::sql_literal` の MySQL 分岐と同じ
/// 規則)。
fn mysql_quote_default(d: &str) -> String {
    format!("'{}'", d.replace('\\', "\\\\").replace('\'', "''"))
}

/// Quotes an identifier for `driver`, doubling the embedded quote char. Shared
/// with the data-sync generator (`db::data_diff`).
pub(crate) fn quote_ident(driver: DriverKind, name: &str) -> String {
    match driver {
        DriverKind::Mysql => format!("`{}`", name.replace('`', "``")),
        DriverKind::Postgres | DriverKind::Sqlite => {
            format!("\"{}\"", name.replace('"', "\"\""))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::diff::{ColumnDiff, TableDiff};

    fn col(name: &str, data_type: &str) -> TableColumnInfo {
        TableColumnInfo {
            name: name.to_string(),
            data_type: data_type.to_string(),
            nullable: true,
            key: String::new(),
            default: None,
            extra: String::new(),
            referenced_table: None,
            referenced_column: None,
            comment: None,
        }
    }

    fn cdiff(
        name: &str,
        status: DiffStatus,
        source: Option<TableColumnInfo>,
        changed: &[&str],
    ) -> ColumnDiff {
        ColumnDiff {
            name: name.to_string(),
            status,
            source,
            target: None,
            changed_fields: changed.iter().map(|s| s.to_string()).collect(),
        }
    }

    fn diff(driver: DriverKind, tables: Vec<TableDiff>) -> SchemaDiff {
        SchemaDiff {
            source_driver: driver,
            target_driver: driver,
            tables,
        }
    }

    #[test]
    fn mysql_create_table_includes_columns_and_pk() {
        let mut id = col("id", "int");
        id.nullable = false;
        id.key = "PRI".to_string();
        id.extra = "auto_increment".to_string();
        let name = col("name", "varchar(50)");
        let table = TableDiff {
            name: "users".to_string(),
            status: DiffStatus::SourceOnly,
            foreign_keys: vec![],
            columns: vec![
                cdiff("id", DiffStatus::SourceOnly, Some(id), &[]),
                cdiff("name", DiffStatus::SourceOnly, Some(name), &[]),
            ],
        };
        let plan = generate_sync_sql(&diff(DriverKind::Mysql, vec![table]), false);
        assert_eq!(plan.statements.len(), 1);
        let sql = &plan.statements[0].sql;
        assert!(sql.contains("CREATE TABLE `users`"), "got: {sql}");
        assert!(
            sql.contains("`id` int NOT NULL auto_increment"),
            "got: {sql}"
        );
        assert!(sql.contains("`name` varchar(50)"), "got: {sql}");
        assert!(sql.contains("PRIMARY KEY (`id`)"), "got: {sql}");
    }

    fn fk(name: &str, cols: &[&str], ref_table: &str, ref_cols: &[&str]) -> DiffForeignKey {
        DiffForeignKey {
            name: Some(name.to_string()),
            columns: cols.iter().map(|c| c.to_string()).collect(),
            referenced_table: ref_table.to_string(),
            referenced_columns: ref_cols.iter().map(|c| c.to_string()).collect(),
            on_delete: Some("CASCADE".to_string()),
            on_update: None,
        }
    }

    fn pk_col(name: &str) -> TableColumnInfo {
        let mut c = col(name, "int");
        c.key = "PRI".to_string();
        c
    }

    fn fk_tables(foreign_keys: Vec<DiffForeignKey>) -> Vec<TableDiff> {
        // 名前順では orders が先だが、複合キーの参照先 users は後から作られる。
        vec![
            TableDiff {
                name: "orders".to_string(),
                status: DiffStatus::SourceOnly,
                foreign_keys,
                columns: vec![
                    cdiff("id", DiffStatus::SourceOnly, Some(pk_col("id")), &[]),
                    cdiff("a", DiffStatus::SourceOnly, Some(col("a", "int")), &[]),
                    cdiff("b", DiffStatus::SourceOnly, Some(col("b", "int")), &[]),
                ],
            },
            TableDiff {
                name: "users".to_string(),
                status: DiffStatus::SourceOnly,
                foreign_keys: vec![],
                columns: vec![
                    cdiff("a", DiffStatus::SourceOnly, Some(pk_col("a")), &[]),
                    cdiff("b", DiffStatus::SourceOnly, Some(pk_col("b")), &[]),
                ],
            },
        ]
    }

    #[test]
    fn foreign_keys_follow_all_creates_as_alter_on_mysql_and_postgres() {
        for driver in [DriverKind::Mysql, DriverKind::Postgres] {
            let tables = fk_tables(vec![fk("fk_o_u", &["a", "b"], "users", &["a", "b"])]);
            let plan = generate_sync_sql(&diff(driver, tables), false);
            let kinds: Vec<SyncKind> = plan.statements.iter().map(|s| s.kind).collect();
            assert_eq!(
                kinds,
                vec![
                    SyncKind::CreateTable,
                    SyncKind::CreateTable,
                    SyncKind::AddForeignKey
                ]
            );
            let q = |s: &str| quote_ident(driver, s);
            assert_eq!(
                plan.statements[2].sql,
                format!(
                    "ALTER TABLE {} ADD CONSTRAINT {} FOREIGN KEY ({}, {}) REFERENCES {} ({}, {}) ON DELETE CASCADE",
                    q("orders"),
                    q("fk_o_u"),
                    q("a"),
                    q("b"),
                    q("users"),
                    q("a"),
                    q("b")
                )
            );
            // CREATE TABLE 自体には FK を含めない。
            assert!(!plan.statements[0].sql.contains("FOREIGN KEY"));
        }
    }

    #[test]
    fn sqlite_foreign_keys_are_inline_in_create_table() {
        let tables = fk_tables(vec![fk("fk_o_u", &["a", "b"], "users", &["a", "b"])]);
        let plan = generate_sync_sql(&diff(DriverKind::Sqlite, tables), false);
        assert_eq!(plan.statements.len(), 2);
        assert!(plan.statements[0].sql.contains(
            "CONSTRAINT \"fk_o_u\" FOREIGN KEY (\"a\", \"b\") REFERENCES \"users\" (\"a\", \"b\") ON DELETE CASCADE"
        ));
    }

    #[test]
    fn no_foreign_keys_are_emitted_without_attached_info() {
        // サンドボックスなど FK を載せない経路では FK を出さない。
        for driver in [DriverKind::Mysql, DriverKind::Postgres, DriverKind::Sqlite] {
            let plan = generate_sync_sql(&diff(driver, fk_tables(vec![])), false);
            assert!(plan
                .statements
                .iter()
                .all(|s| !s.sql.contains("FOREIGN KEY")));
            assert!(plan
                .statements
                .iter()
                .all(|s| s.kind == SyncKind::CreateTable));
        }
    }

    #[test]
    fn foreign_key_to_uncreatable_table_is_skipped_with_warning() {
        let mut gen = pk_col("a");
        gen.extra = "STORED GENERATED".to_string();
        let mut tables = fk_tables(vec![fk("fk_o_u", &["a"], "users", &["a"])]);
        tables[1].columns[0] = cdiff("a", DiffStatus::SourceOnly, Some(gen), &[]);
        let plan = generate_sync_sql(&diff(DriverKind::Mysql, tables), false);
        assert!(plan
            .statements
            .iter()
            .all(|s| s.kind != SyncKind::AddForeignKey));
        assert!(plan.warnings.iter().any(|w| w.contains("外部キー")));
    }

    #[test]
    fn destructive_statements_gated_by_flag() {
        let table = TableDiff {
            name: "stale".to_string(),
            status: DiffStatus::TargetOnly,
            foreign_keys: vec![],
            columns: vec![cdiff("id", DiffStatus::TargetOnly, None, &[])],
        };
        let without = generate_sync_sql(&diff(DriverKind::Mysql, vec![table.clone()]), false);
        assert!(
            without.statements.is_empty(),
            "drop must be hidden by default"
        );
        let with = generate_sync_sql(&diff(DriverKind::Mysql, vec![table]), true);
        assert_eq!(with.statements.len(), 1);
        assert_eq!(with.statements[0].kind, SyncKind::DropTable);
        assert!(with.statements[0].destructive);
        assert_eq!(with.statements[0].sql, "DROP TABLE `stale`");
    }

    #[test]
    fn mysql_add_modify_drop_columns() {
        let added = col("added", "text");
        let mut changed_src = col("amount", "bigint");
        changed_src.nullable = false;
        let table = TableDiff {
            name: "t".to_string(),
            status: DiffStatus::Different,
            foreign_keys: vec![],
            columns: vec![
                cdiff("added", DiffStatus::SourceOnly, Some(added), &[]),
                cdiff(
                    "amount",
                    DiffStatus::Different,
                    Some(changed_src),
                    &["data_type", "nullable"],
                ),
                cdiff("gone", DiffStatus::TargetOnly, None, &[]),
            ],
        };
        let plan = generate_sync_sql(&diff(DriverKind::Mysql, vec![table]), true);
        let kinds: Vec<SyncKind> = plan.statements.iter().map(|s| s.kind).collect();
        // Sorted: add, alter, drop.
        assert_eq!(
            kinds,
            vec![
                SyncKind::AddColumn,
                SyncKind::AlterColumn,
                SyncKind::DropColumn
            ]
        );
        assert!(plan.statements[0].sql.contains("ADD COLUMN `added` text"));
        assert!(plan.statements[1]
            .sql
            .contains("MODIFY COLUMN `amount` bigint NOT NULL"));
        assert_eq!(plan.statements[2].sql, "ALTER TABLE `t` DROP COLUMN `gone`");
    }

    #[test]
    fn postgres_modify_is_granular_per_facet() {
        let mut src = col("v", "bigint");
        src.nullable = false;
        src.default = Some("0".to_string());
        let table = TableDiff {
            name: "t".to_string(),
            status: DiffStatus::Different,
            foreign_keys: vec![],
            columns: vec![cdiff(
                "v",
                DiffStatus::Different,
                Some(src),
                &["data_type", "nullable", "default"],
            )],
        };
        let plan = generate_sync_sql(&diff(DriverKind::Postgres, vec![table]), false);
        let sqls: Vec<&str> = plan.statements.iter().map(|s| s.sql.as_str()).collect();
        assert!(sqls.contains(&"ALTER TABLE \"t\" ALTER COLUMN \"v\" TYPE bigint"));
        assert!(sqls.contains(&"ALTER TABLE \"t\" ALTER COLUMN \"v\" SET NOT NULL"));
        assert!(sqls.contains(&"ALTER TABLE \"t\" ALTER COLUMN \"v\" SET DEFAULT 0"));
    }

    #[test]
    fn postgres_key_change_warns_instead_of_guessing() {
        let mut src = col("id", "int");
        src.key = "PRI".to_string();
        let table = TableDiff {
            name: "t".to_string(),
            status: DiffStatus::Different,
            foreign_keys: vec![],
            columns: vec![cdiff("id", DiffStatus::Different, Some(src), &["key"])],
        };
        let plan = generate_sync_sql(&diff(DriverKind::Postgres, vec![table]), false);
        assert!(plan.statements.is_empty());
        assert_eq!(plan.warnings.len(), 1);
        assert!(plan.warnings[0].contains("key"));
    }

    #[test]
    fn sqlite_add_and_drop_supported_modify_warns() {
        let added = col("added", "TEXT");
        let mut changed = col("v", "REAL");
        changed.nullable = false;
        let table = TableDiff {
            name: "t".to_string(),
            status: DiffStatus::Different,
            foreign_keys: vec![],
            columns: vec![
                cdiff("added", DiffStatus::SourceOnly, Some(added), &[]),
                cdiff("v", DiffStatus::Different, Some(changed), &["data_type"]),
                cdiff("gone", DiffStatus::TargetOnly, None, &[]),
            ],
        };
        let plan = generate_sync_sql(&diff(DriverKind::Sqlite, vec![table]), true);
        assert!(plan
            .statements
            .iter()
            .any(|s| s.sql == "ALTER TABLE \"t\" ADD COLUMN \"added\" TEXT"));
        assert!(plan
            .statements
            .iter()
            .any(|s| s.sql == "ALTER TABLE \"t\" DROP COLUMN \"gone\""));
        // The in-place modify is impossible on SQLite → a warning, not SQL.
        assert!(!plan
            .statements
            .iter()
            .any(|s| s.kind == SyncKind::AlterColumn));
        assert_eq!(plan.warnings.len(), 1);
        assert!(plan.warnings[0].contains("SQLite cannot alter"));
    }

    #[test]
    fn same_tables_produce_nothing() {
        let table = TableDiff {
            name: "t".to_string(),
            status: DiffStatus::Same,
            foreign_keys: vec![],
            columns: vec![],
        };
        let plan = generate_sync_sql(&diff(DriverKind::Mysql, vec![table]), true);
        assert!(plan.statements.is_empty());
        assert!(plan.warnings.is_empty());
    }

    // --- #1521: EXTRA マーカー除去と COMMENT 出力 ---------------------------

    #[test]
    fn mysql_extra_markers_are_stripped() {
        let mut c = col("created_at", "timestamp");
        c.nullable = false;
        c.default = Some("CURRENT_TIMESTAMP".to_string());
        c.extra = "DEFAULT_GENERATED".to_string();
        assert_eq!(
            column_def(DriverKind::Mysql, &c),
            "`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP"
        );
        c.extra = "DEFAULT_GENERATED on update CURRENT_TIMESTAMP".to_string();
        assert_eq!(
            column_def(DriverKind::Mysql, &c),
            "`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP on update CURRENT_TIMESTAMP"
        );
        c.extra = "auto_increment".to_string();
        assert!(column_def(DriverKind::Mysql, &c).ends_with(" auto_increment"));
    }

    #[test]
    fn mysql_generated_columns_are_excluded_with_warning() {
        let mut g = col("total", "int");
        g.extra = "STORED GENERATED".to_string();
        let mut v = col("v", "int");
        v.extra = "VIRTUAL GENERATED".to_string();
        let plain = col("id", "int");
        assert!(is_generated_column(DriverKind::Mysql, &g));
        assert!(is_generated_column(DriverKind::Mysql, &v));
        assert!(!is_generated_column(DriverKind::Mysql, &plain));

        let table = TableDiff {
            name: "t".into(),
            status: DiffStatus::SourceOnly,
            foreign_keys: vec![],
            columns: vec![
                cdiff("id", DiffStatus::SourceOnly, Some(plain.clone()), &[]),
                cdiff("total", DiffStatus::SourceOnly, Some(g.clone()), &[]),
            ],
        };
        let mut warnings = Vec::new();
        let stmt = create_table_stmt(
            DriverKind::Mysql,
            &table,
            &HashSet::new(),
            &mut Vec::new(),
            &mut warnings,
        )
        .unwrap();
        assert!(stmt.sql.contains("`id`") && !stmt.sql.contains("`total`"));
        assert_eq!(warnings.len(), 1);

        let alter = TableDiff {
            name: "t".into(),
            status: DiffStatus::Different,
            foreign_keys: vec![],
            columns: vec![
                cdiff("total", DiffStatus::SourceOnly, Some(g.clone()), &[]),
                cdiff("v", DiffStatus::Different, Some(v), &["data_type"]),
            ],
        };
        let plan = generate_sync_sql(&diff(DriverKind::Mysql, vec![alter]), false);
        assert!(plan.statements.is_empty());
        assert_eq!(plan.warnings.len(), 2);
    }

    #[test]
    fn mysql_create_table_skipped_when_generated_pk_or_no_columns() {
        let mut g = col("id", "int");
        g.extra = "STORED GENERATED".to_string();
        g.key = "PRI".to_string();
        let plain = col("name", "varchar(10)");
        let table = TableDiff {
            name: "t".into(),
            status: DiffStatus::SourceOnly,
            foreign_keys: vec![],
            columns: vec![
                cdiff("id", DiffStatus::SourceOnly, Some(g.clone()), &[]),
                cdiff("name", DiffStatus::SourceOnly, Some(plain), &[]),
            ],
        };
        let plan = generate_sync_sql(&diff(DriverKind::Mysql, vec![table]), false);
        assert!(plan.statements.is_empty());
        assert!(plan.warnings.iter().any(|w| w.contains("CREATE TABLE")));

        g.key = String::new();
        let only = TableDiff {
            name: "t2".into(),
            status: DiffStatus::SourceOnly,
            foreign_keys: vec![],
            columns: vec![cdiff("id", DiffStatus::SourceOnly, Some(g), &[])],
        };
        let plan = generate_sync_sql(&diff(DriverKind::Mysql, vec![only]), false);
        assert!(plan.statements.is_empty());
    }

    #[test]
    fn mysql_modify_skipped_when_target_is_generated() {
        let src = col("v", "int");
        let mut tgt = col("v", "bigint");
        tgt.extra = "VIRTUAL GENERATED".to_string();
        let mut cd = cdiff("v", DiffStatus::Different, Some(src), &["data_type"]);
        cd.target = Some(tgt);
        let table = TableDiff {
            name: "t".into(),
            status: DiffStatus::Different,
            foreign_keys: vec![],
            columns: vec![cd],
        };
        let plan = generate_sync_sql(&diff(DriverKind::Mysql, vec![table]), false);
        assert!(plan.statements.is_empty());
        assert_eq!(plan.warnings.len(), 1);
    }

    #[test]
    fn mysql_column_comment_is_emitted_and_escaped() {
        let mut c = col("amount", "int");
        c.comment = Some("金額's \\ 備考".to_string());
        assert_eq!(
            column_def(DriverKind::Mysql, &c),
            "`amount` int COMMENT '金額''s \\\\ 備考'"
        );
        // PostgreSQL / SQLite の列定義には COMMENT 句を付けない。
        assert!(!column_def(DriverKind::Postgres, &c).contains("COMMENT"));
        c.comment = Some(String::new());
        assert!(!column_def(DriverKind::Mysql, &c).contains("COMMENT"));
    }

    // --- 修正 L2: MySQL の DEFAULT クオート ---------------------------------

    #[test]
    fn mysql_string_default_is_quoted() {
        // COLUMN_DEFAULT は 'pending' に対し `pending` (クオートなし) を返す。
        let mut c = col("status", "varchar(20)");
        c.default = Some("pending".to_string());
        let sql = column_def(DriverKind::Mysql, &c);
        assert!(
            sql.contains("DEFAULT 'pending'"),
            "文字列デフォルトはクオートされるはず: {sql}"
        );
    }

    #[test]
    fn mysql_empty_string_default_is_preserved_quoted() {
        // 旧実装は `!d.is_empty()` で空文字デフォルトを無音に落としていた。
        let mut c = col("note", "varchar(255)");
        c.default = Some(String::new());
        let sql = column_def(DriverKind::Mysql, &c);
        assert!(
            sql.contains("DEFAULT ''"),
            "空文字デフォルトは消さずに DEFAULT '' として出すべき: {sql}"
        );
    }

    #[test]
    fn mysql_default_generated_expression_stays_verbatim() {
        // CURRENT_TIMESTAMP のような式デフォルトはクオートすると壊れる。
        let mut c = col("created_at", "timestamp");
        c.default = Some("CURRENT_TIMESTAMP".to_string());
        c.extra = "DEFAULT_GENERATED".to_string();
        let sql = column_def(DriverKind::Mysql, &c);
        assert!(
            sql.contains("DEFAULT CURRENT_TIMESTAMP") && !sql.contains("'CURRENT_TIMESTAMP'"),
            "DEFAULT_GENERATED は逐語のまま出すべき: {sql}"
        );
    }

    #[test]
    fn mysql_numeric_default_stays_unquoted() {
        let mut c = col("amount", "int");
        c.default = Some("0".to_string());
        let sql = column_def(DriverKind::Mysql, &c);
        assert!(
            sql.contains("DEFAULT 0") && !sql.contains("'0'"),
            "got: {sql}"
        );
    }

    #[test]
    fn mysql_string_default_with_quote_is_escaped() {
        let mut c = col("name", "varchar(50)");
        c.default = Some("O'Brien".to_string());
        let sql = column_def(DriverKind::Mysql, &c);
        assert!(sql.contains("DEFAULT 'O''Brien'"), "got: {sql}");
    }

    // --- #H5: 日付・バイナリ・JSON も COLUMN_DEFAULT がクオート無しで返る -----

    #[test]
    fn mysql_date_default_is_quoted() {
        // COLUMN_DEFAULT は 'date' 列の DEFAULT '2020-01-01' に対しても
        // クオート無しの `2020-01-01` を返す。逐語出力だと `DEFAULT 2020-01-01`
        // という構文エラーの DDL になっていた (#H5)。
        let mut c = col("published_on", "date");
        c.default = Some("2020-01-01".to_string());
        let sql = column_def(DriverKind::Mysql, &c);
        assert!(
            sql.contains("DEFAULT '2020-01-01'"),
            "date のリテラルデフォルトはクオートされるはず: {sql}"
        );
    }

    #[test]
    fn mysql_datetime_and_timestamp_literal_defaults_are_quoted() {
        let mut c = col("scheduled_at", "datetime");
        c.default = Some("2020-01-01 00:00:00".to_string());
        let sql = column_def(DriverKind::Mysql, &c);
        assert!(sql.contains("DEFAULT '2020-01-01 00:00:00'"), "got: {sql}");

        let mut c2 = col("archived_at", "timestamp");
        c2.default = Some("2020-01-01 00:00:00".to_string());
        // `extra` が DEFAULT_GENERATED でない = リテラルデフォルト (式ではない)。
        let sql2 = column_def(DriverKind::Mysql, &c2);
        assert!(
            sql2.contains("DEFAULT '2020-01-01 00:00:00'"),
            "got: {sql2}"
        );
    }

    #[test]
    fn mysql_time_and_year_literal_defaults_are_quoted() {
        let mut c = col("start_time", "time");
        c.default = Some("09:00:00".to_string());
        let sql = column_def(DriverKind::Mysql, &c);
        assert!(sql.contains("DEFAULT '09:00:00'"), "got: {sql}");

        let mut c2 = col("fiscal_year", "year");
        c2.default = Some("2020".to_string());
        let sql2 = column_def(DriverKind::Mysql, &c2);
        assert!(sql2.contains("DEFAULT '2020'"), "got: {sql2}");
    }

    #[test]
    fn mysql_binary_and_blob_literal_defaults_are_quoted() {
        let mut c = col("flag", "binary(4)");
        c.default = Some("0000".to_string());
        let sql = column_def(DriverKind::Mysql, &c);
        assert!(sql.contains("DEFAULT '0000'"), "got: {sql}");

        let mut c2 = col("code", "varbinary(8)");
        c2.default = Some("abc".to_string());
        let sql2 = column_def(DriverKind::Mysql, &c2);
        assert!(sql2.contains("DEFAULT 'abc'"), "got: {sql2}");

        for ty in ["tinyblob", "blob", "mediumblob", "longblob"] {
            let mut cb = col("data", ty);
            cb.default = Some("x".to_string());
            let sqlb = column_def(DriverKind::Mysql, &cb);
            assert!(
                sqlb.contains("DEFAULT 'x'"),
                "{ty} のリテラルデフォルトはクオートされるはず: {sqlb}"
            );
        }
    }

    #[test]
    fn mysql_json_literal_default_is_quoted() {
        let mut c = col("meta", "json");
        c.default = Some("{}".to_string());
        let sql = column_def(DriverKind::Mysql, &c);
        assert!(sql.contains("DEFAULT '{}'"), "got: {sql}");
    }

    #[test]
    fn mysql_date_default_generated_expression_stays_verbatim() {
        // date/timestamp 系を is_mysql_string_default_type に追加しても、
        // 式デフォルト (DEFAULT_GENERATED) は default_clause がそれより先に
        // 判定するため二重クオートされない、という前提を固定する。
        let mut c = col("created_on", "date");
        c.default = Some("(CURRENT_DATE)".to_string());
        c.extra = "DEFAULT_GENERATED".to_string();
        let sql = column_def(DriverKind::Mysql, &c);
        assert!(
            sql.contains("DEFAULT (CURRENT_DATE)") && !sql.contains("'(CURRENT_DATE)'"),
            "DEFAULT_GENERATED は date 型でも逐語のまま出すべき: {sql}"
        );
    }

    #[test]
    fn postgres_default_stays_verbatim() {
        // PostgreSQL の column_default は introspection が既にクオート/
        // キャスト済みの式を返すので、この層では変更しない (現状維持)。
        let mut c = col("status", "character varying(20)");
        c.default = Some("'pending'::character varying".to_string());
        let sql = column_def(DriverKind::Postgres, &c);
        assert!(
            sql.contains("DEFAULT 'pending'::character varying"),
            "got: {sql}"
        );
    }

    // --- 修正 L3: MySQL の key/FK のみの差分は MODIFY を出さず警告に -------

    #[test]
    fn mysql_key_only_diff_warns_without_modify() {
        let mut src = col("id", "int");
        src.key = "PRI".to_string();
        let table = TableDiff {
            name: "t".to_string(),
            status: DiffStatus::Different,
            foreign_keys: vec![],
            columns: vec![cdiff("id", DiffStatus::Different, Some(src), &["key"])],
        };
        let plan = generate_sync_sql(&diff(DriverKind::Mysql, vec![table]), false);
        assert!(
            plan.statements.is_empty(),
            "key のみの差分では MODIFY を出してはいけない: {plan:?}"
        );
        assert_eq!(plan.warnings.len(), 1);
        assert!(plan.warnings[0].contains("キー"));
    }

    #[test]
    fn mysql_foreign_key_only_diff_warns_without_modify() {
        let src = col("user_id", "int");
        let table = TableDiff {
            name: "t".to_string(),
            status: DiffStatus::Different,
            foreign_keys: vec![],
            columns: vec![cdiff(
                "user_id",
                DiffStatus::Different,
                Some(src),
                &["foreign_key"],
            )],
        };
        let plan = generate_sync_sql(&diff(DriverKind::Mysql, vec![table]), false);
        assert!(plan.statements.is_empty());
        assert_eq!(plan.warnings.len(), 1);
    }

    #[test]
    fn mysql_mixed_key_and_type_diff_still_modifies_and_warns() {
        // data_type と key の両方が変わっているケース: MODIFY は出す (型部分は
        // 直る) が、key 部分は反映されないことを警告で補足する。
        let mut src = col("v", "bigint");
        src.key = "PRI".to_string();
        let table = TableDiff {
            name: "t".to_string(),
            status: DiffStatus::Different,
            foreign_keys: vec![],
            columns: vec![cdiff(
                "v",
                DiffStatus::Different,
                Some(src),
                &["data_type", "key"],
            )],
        };
        let plan = generate_sync_sql(&diff(DriverKind::Mysql, vec![table]), false);
        assert_eq!(plan.statements.len(), 1);
        assert_eq!(plan.statements[0].kind, SyncKind::AlterColumn);
        assert!(plan.statements[0].sql.contains("MODIFY COLUMN"));
        assert_eq!(plan.warnings.len(), 1);
        assert!(plan.warnings[0].contains("キー"));
    }

    // --- 修正 L4: 長さ/精度付き data_type がそのまま比較・出力に使われる ----

    #[test]
    fn mysql_create_table_preserves_length_and_precision() {
        let mut price = col("price", "numeric(10,2)");
        price.nullable = false;
        let table = TableDiff {
            name: "t".to_string(),
            status: DiffStatus::SourceOnly,
            foreign_keys: vec![],
            columns: vec![cdiff("price", DiffStatus::SourceOnly, Some(price), &[])],
        };
        let plan = generate_sync_sql(&diff(DriverKind::Postgres, vec![table]), false);
        assert!(
            plan.statements[0].sql.contains("numeric(10,2)"),
            "長さ/精度付きの型が verbatim で出力されるべき: {}",
            plan.statements[0].sql
        );
    }

    #[test]
    fn postgres_varchar_length_change_generates_alter_type() {
        // K の introspection 変更後、data_type は `character varying(50)` の
        // ような完全型文字列になる。長さ違いが ALTER COLUMN ... TYPE に
        // そのまま反映されることを確認する。
        let src = col("name", "character varying(255)");
        let table = TableDiff {
            name: "t".to_string(),
            status: DiffStatus::Different,
            foreign_keys: vec![],
            columns: vec![cdiff(
                "name",
                DiffStatus::Different,
                Some(src),
                &["data_type"],
            )],
        };
        let plan = generate_sync_sql(&diff(DriverKind::Postgres, vec![table]), false);
        assert_eq!(plan.statements.len(), 1);
        assert_eq!(
            plan.statements[0].sql,
            "ALTER TABLE \"t\" ALTER COLUMN \"name\" TYPE character varying(255)"
        );
    }

    #[test]
    fn sqlite_destination_keeps_generated_source_columns_in_create() {
        // サンドボックス作成: MySQL / PG ソースの生成列は SQLite の CREATE に通常列として残る。
        for src_driver in [DriverKind::Mysql, DriverKind::Postgres] {
            let mut g = col("total", "int");
            g.extra = "STORED GENERATED".to_string();
            let table = TableDiff {
                name: "t".into(),
                status: DiffStatus::SourceOnly,
                foreign_keys: vec![],
                columns: vec![
                    cdiff("id", DiffStatus::SourceOnly, Some(col("id", "int")), &[]),
                    cdiff("total", DiffStatus::SourceOnly, Some(g), &[]),
                ],
            };
            let d = SchemaDiff {
                source_driver: src_driver,
                target_driver: DriverKind::Sqlite,
                tables: vec![table],
            };
            let plan = generate_sync_sql(&d, false);
            assert_eq!(plan.statements.len(), 1, "{src_driver:?}");
            assert!(
                plan.statements[0].sql.contains("\"total\""),
                "{src_driver:?}"
            );
            assert!(
                plan.warnings.is_empty(),
                "{src_driver:?}: {:?}",
                plan.warnings
            );
        }
    }

    #[test]
    fn postgres_generated_columns_are_detected_from_extra() {
        let mut g = col("g", "integer");
        g.extra = "STORED GENERATED".to_string();
        assert!(is_generated_column(DriverKind::Postgres, &g));
        assert!(!is_generated_column(
            DriverKind::Postgres,
            &col("p", "integer")
        ));
    }

    fn target_only(name: &str, fks: Vec<DiffForeignKey>) -> TableDiff {
        TableDiff {
            name: name.to_string(),
            status: DiffStatus::TargetOnly,
            foreign_keys: fks,
            columns: vec![],
        }
    }

    fn drop_order_of(plan: &SyncPlan) -> Vec<&str> {
        plan.statements
            .iter()
            .filter(|s| s.kind == SyncKind::DropTable)
            .map(|s| s.table.as_str())
            .collect()
    }

    #[test]
    fn drop_tables_are_ordered_children_first() {
        // 名前順なら "a_parent" が先だが、子 "z_child" を先に落とす必要がある。
        let d = diff(
            DriverKind::Postgres,
            vec![
                target_only("a_parent", vec![]),
                target_only("z_child", vec![fk("fk", &["pid"], "a_parent", &["id"])]),
            ],
        );
        let plan = generate_sync_sql(&d, true);
        assert_eq!(drop_order_of(&plan), vec!["z_child", "a_parent"]);
        assert!(plan.warnings.is_empty(), "{:?}", plan.warnings);
    }

    #[test]
    fn drop_tables_with_fk_cycle_warn() {
        let d = diff(
            DriverKind::Postgres,
            vec![
                target_only("a", vec![fk("f1", &["b_id"], "b", &["id"])]),
                target_only("b", vec![fk("f2", &["a_id"], "a", &["id"])]),
            ],
        );
        let plan = generate_sync_sql(&d, true);
        assert_eq!(drop_order_of(&plan).len(), 2);
        assert!(
            plan.warnings.iter().any(|w| w.contains("循環")),
            "{:?}",
            plan.warnings
        );
    }

    #[test]
    fn mysql_create_drops_set_default_fk_action_with_warning() {
        let mut id = col("id", "int");
        id.key = "PRI".to_string();
        let mut f = fk("fk_p", &["pid"], "parent", &["id"]);
        f.on_delete = Some("SET DEFAULT".to_string());
        let table = TableDiff {
            name: "child".to_string(),
            status: DiffStatus::SourceOnly,
            foreign_keys: vec![f],
            columns: vec![
                cdiff("id", DiffStatus::SourceOnly, Some(id), &[]),
                cdiff("pid", DiffStatus::SourceOnly, Some(col("pid", "int")), &[]),
            ],
        };
        let parent = TableDiff {
            name: "parent".to_string(),
            status: DiffStatus::Same,
            foreign_keys: vec![],
            columns: vec![],
        };
        let mut d = diff(DriverKind::Mysql, vec![table, parent]);
        d.source_driver = DriverKind::Postgres;
        let plan = generate_sync_sql(&d, false);
        let all: String = plan.statements.iter().map(|s| s.sql.clone()).collect();
        assert!(!all.contains("SET DEFAULT"), "{all}");
        assert!(
            plan.warnings.iter().any(|w| w.contains("SET DEFAULT")),
            "{:?}",
            plan.warnings
        );
    }
}
