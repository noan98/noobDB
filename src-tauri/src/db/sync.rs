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

use super::ddl_extras::normalize_check;
use super::diff::{DiffForeignKey, DiffStatus, SchemaDiff, TableDiff};
use super::table_ddl::{render_check, render_foreign_key, render_generated_column, FkGroup};
use super::types::{CheckConstraintInfo, GeneratedColumnInfo, TableColumnInfo};
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
    /// `CREATE [UNIQUE] INDEX` (#1625)。
    AddIndex,
    /// `DROP INDEX` (#1625)。
    DropIndex,
    /// 既存テーブルの外部キー制約の削除 (#1625)。
    DropForeignKey,
    /// 既存テーブルへの CHECK 制約の追加 (`ALTER TABLE ... ADD CONSTRAINT ... CHECK`, #1837)。
    AddCheck,
    /// 既存テーブルの CHECK 制約の削除 (#1837)。
    DropCheck,
    /// ビュー / マテビュー / ルーチン / トリガー / シーケンスの作成 (#1879)。
    CreateObject,
    /// 定義が変わった非テーブルオブジェクトの置き換え (#1879)。ビュー等は DROP + CREATE、
    /// PostgreSQL の関数は `CREATE OR REPLACE`、シーケンスは `ALTER SEQUENCE`。
    ReplaceObject,
    /// target にだけある非テーブルオブジェクトの削除 (#1879)。
    DropObject,
    /// SQLite の列変更・外部キー変更のためのテーブル再作成 (新表 → コピー → DROP →
    /// RENAME → インデックス / トリガーの作り直し)。1 つの `SyncStatement` に複数文を持つ
    /// (#1625)。
    RebuildTable,
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
            SyncKind::AlterColumn | SyncKind::RebuildTable => 2,
            // 同名の索引・外部キーを作り直すときは DROP を先に、列の DROP より前に出す。
            // MySQL は外部キーを支えるインデックスを先に消すと ERROR 1553 になるので、
            // 外部キーの DROP をインデックスの DROP より前に出す。
            SyncKind::DropForeignKey | SyncKind::DropCheck => 3,
            SyncKind::DropIndex => 4,
            SyncKind::AddIndex => 5,
            SyncKind::AddForeignKey | SyncKind::AddCheck => 6,
            // 非テーブルオブジェクトの文は `generate_sync_sql` が並べ方を決めて差し込む
            // (表の作成後・列 / 表の削除前)。この値では並べ替えない。
            SyncKind::CreateObject | SyncKind::ReplaceObject | SyncKind::DropObject => 6,
            SyncKind::DropColumn => 7,
            SyncKind::DropTable => 8,
            SyncKind::InsertRow => 9,
            SyncKind::UpdateRow => 10,
            SyncKind::DeleteRow => 11,
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
    if allow_destructive {
        warnings.extend(diff.warnings.iter().cloned());
    }

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

    let kept_tables = if allow_destructive {
        sqlite_kept_tables(driver, diff)
    } else {
        HashMap::new()
    };

    for table in &diff.tables {
        match table.status {
            DiffStatus::Same => {}
            DiffStatus::SourceOnly => {
                if let Some(stmt) = create_table_stmt(
                    driver,
                    table,
                    diff.indexes_compared,
                    &uncreatable,
                    &mut statements,
                    &mut warnings,
                ) {
                    statements.push(stmt);
                    index_statements(
                        driver,
                        table,
                        false,
                        allow_destructive,
                        &mut statements,
                        &mut warnings,
                    );
                }
            }
            DiffStatus::TargetOnly => {
                if allow_destructive {
                    if let Some(child) = kept_tables.get(&table.name.to_ascii_lowercase()) {
                        warnings.push(format!(
                            "表 {} は表 {} から ON DELETE CASCADE / SET NULL 付きの外部キーで参照されています (残る表、または DROP を省いた表)。SQLite の DROP TABLE は暗黙の DELETE で {} の行を消す・書き換えるため、DROP TABLE を出力しません (先に外部キーを外してください)",
                            table.name, child, child
                        ));
                        continue;
                    }
                    statements.push(SyncStatement {
                        sql: format!("DROP TABLE {}", quote_ident(driver, &table.name)),
                        table: table.name.clone(),
                        kind: SyncKind::DropTable,
                        destructive: true,
                    });
                }
            }
            DiffStatus::Different => {
                let rebuilt = alter_table(
                    driver,
                    table,
                    allow_destructive,
                    &mut statements,
                    &mut warnings,
                );
                index_statements(
                    driver,
                    table,
                    rebuilt,
                    allow_destructive,
                    &mut statements,
                    &mut warnings,
                );
                foreign_key_statements(
                    driver,
                    table,
                    rebuilt,
                    allow_destructive,
                    &mut statements,
                    &mut warnings,
                );
                check_statements(
                    driver,
                    table,
                    rebuilt,
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

    object_statements(diff, allow_destructive, &mut statements, &mut warnings);

    SyncPlan {
        statements,
        warnings,
    }
}

/// 非テーブルオブジェクトの差分を同期文にして `statements` へ差し込む (#1879)。
///
/// 差し込み位置は、表の作成・列の追加と変更・索引・外部キーの後ろで、列と表の DROP の前
/// (新しい列を使うビューは作成後に、消す列を使うビュー / トリガーは先に置き換える・消す)。
/// シーケンスの作成だけは表の既定値から参照されるので先頭に置く。作成・置換は
/// 関数 → プロシージャ → ビュー → マテビュー → トリガーの順 (ビュー同士は参照順)、削除は
/// 逆順で、`allow_destructive` が無いと削除は出さない。
fn object_statements(
    diff: &SchemaDiff,
    allow_destructive: bool,
    statements: &mut Vec<SyncStatement>,
    warnings: &mut Vec<String>,
) {
    use super::object_diff::{
        create_object_sql, drop_object_sql, order_for_create, replace_object_sql,
    };
    let driver = diff.target_driver;
    let items = &diff.objects.items;
    let pick = |status: DiffStatus| -> Vec<&super::object_diff::ObjectDiff> {
        items.iter().filter(|o| o.status == status).collect()
    };
    let mk = |o: &super::object_diff::ObjectDiff, sql: String, kind: SyncKind, destructive| {
        SyncStatement {
            sql,
            table: o.name.clone(),
            kind,
            destructive,
        }
    };

    let mut early: Vec<SyncStatement> = Vec::new();
    let mut late: Vec<SyncStatement> = Vec::new();
    for o in order_for_create(&pick(DiffStatus::SourceOnly)) {
        let Some(def) = o.source_definition.as_deref() else {
            continue;
        };
        let stmt = mk(o, create_object_sql(def), SyncKind::CreateObject, false);
        if o.kind == "sequence" {
            early.push(stmt);
        } else {
            late.push(stmt);
        }
    }
    for o in order_for_create(&pick(DiffStatus::Different)) {
        let Some(def) = o.source_definition.as_deref() else {
            continue;
        };
        // MySQL のルーチン / トリガーは DROP + CREATE で、DDL が暗黙コミットされるため CREATE が
        // 失敗すると元の定義が戻らない。破壊的として扱い、許可がなければ出さずに警告する。
        let non_atomic = driver == DriverKind::Mysql
            && matches!(o.kind.as_str(), "procedure" | "function" | "trigger");
        if non_atomic && !allow_destructive {
            warnings.push(format!(
                "{} {}: MySQL はルーチン・トリガーを DROP + CREATE で置き換えます (DDL は暗黙コミットされ、CREATE に失敗すると元の定義が失われます)。「破壊的な操作を許可」を有効にすると出力します",
                o.kind, o.name
            ));
            continue;
        }
        let sql = replace_object_sql(driver, o, def);
        late.push(mk(o, sql, SyncKind::ReplaceObject, non_atomic));
    }
    if allow_destructive {
        let mut drops = order_for_create(&pick(DiffStatus::TargetOnly));
        drops.reverse();
        for o in drops {
            late.push(mk(
                o,
                drop_object_sql(driver, o),
                SyncKind::DropObject,
                true,
            ));
        }
    }

    // 前: シーケンスの作成。後: それ以外 (DropColumn より前に差し込む)。
    let at = statements
        .iter()
        .position(|s| s.kind.order() >= SyncKind::DropColumn.order())
        .unwrap_or(statements.len());
    statements.splice(at..at, late);
    statements.splice(0..0, early);
}

/// SQLite で target のみの表を `DROP TABLE` すると、残る表の ON DELETE CASCADE / SET NULL /
/// SET DEFAULT が暗黙の DELETE で発火して行を黙って消す・書き換える。DROP を省くべき
/// 表を「小文字の表名 -> 参照している表の名前」で返す。
/// 省いた表も残るので、それを CASCADE 等で参照する target のみの表の DROP も連鎖で
/// 行を消す。残す集合は不動点になるまで広げる。参照先の表記は DDL のままで大小が
/// 揺れうるため大小無視で照合する。MySQL / PostgreSQL は参照中の表の DROP がエラーに
/// なるので対象外。
fn sqlite_kept_tables(driver: DriverKind, diff: &SchemaDiff) -> HashMap<String, String> {
    let mut kept: HashMap<String, String> = HashMap::new();
    if driver != DriverKind::Sqlite {
        return kept;
    }
    let target_only: HashSet<String> = diff
        .tables
        .iter()
        .filter(|t| t.status == DiffStatus::TargetOnly)
        .map(|t| t.name.to_ascii_lowercase())
        .collect();
    let cascades = |fk: &super::diff::DiffForeignKey| {
        fk.on_delete.as_deref().is_some_and(|a| {
            let a = a.trim().to_ascii_uppercase();
            a == "CASCADE" || a.starts_with("SET")
        })
    };
    loop {
        let mut added = false;
        for t in &diff.tables {
            let survives = t.status != DiffStatus::TargetOnly
                || kept.contains_key(&t.name.to_ascii_lowercase());
            if !survives {
                continue;
            }
            // 残る既存の表は CASCADE / SET 系だけを見る (NO ACTION は従来どおり)。DROP を
            // 省いた表の行は残るので、その祖先は NO ACTION でも落とすと FK エラーで計画全体が
            // 失敗する。祖先も残して警告に回す。
            let any_action = t.status == DiffStatus::TargetOnly;
            for fk in t
                .foreign_keys
                .iter()
                .filter(|fk| any_action || cascades(fk))
            {
                let parent = fk.referenced_table.to_ascii_lowercase();
                if target_only.contains(&parent) && !kept.contains_key(&parent) {
                    kept.insert(parent, t.name.clone());
                    added = true;
                }
            }
        }
        if !added {
            return kept;
        }
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
        if is_generated_column(driver, c) && source_generated(table, &c.name).is_none() {
            if c.key.eq_ignore_ascii_case("PRI") {
                return false;
            }
        } else {
            any_column = true;
        }
    }
    any_column
}

/// source 側の生成列の式 (取得できていれば)。`SourceOnly` / `Different` の差分から引く。
fn source_generated<'a>(table: &'a TableDiff, column: &str) -> Option<&'a GeneratedColumnInfo> {
    table
        .generated_changes
        .iter()
        .filter_map(|g| g.source.as_ref())
        .find(|g| g.column == column)
}

/// 隠れた生成列 (SQLite の `table_info` に出ない) の定義。型・NOT NULL を持っていれば保つ。
fn render_hidden_generated(driver: DriverKind, g: &GeneratedColumnInfo) -> String {
    let mut def = quote_ident(driver, &g.column);
    if let Some(ty) = g.data_type.as_deref().filter(|t| !t.is_empty()) {
        def.push(' ');
        def.push_str(ty);
    }
    def.push_str(&format!(
        " GENERATED ALWAYS AS ({}) {}",
        g.expression,
        if g.is_virtual { "VIRTUAL" } else { "STORED" }
    ));
    if g.not_null {
        def.push_str(" NOT NULL");
    }
    def
}

/// 通常列の定義の並びに、隠れた生成列を元の列位置 (`position`, 全列での 0 始まり) へ差し込む。
/// 位置の無いものは末尾に足す。
fn interleave_hidden_generated(
    driver: DriverKind,
    visible: Vec<String>,
    hidden: &[&GeneratedColumnInfo],
) -> Vec<String> {
    let mut hidden: Vec<&GeneratedColumnInfo> = hidden.to_vec();
    hidden.sort_by_key(|g| g.position.unwrap_or(usize::MAX));
    let mut hidden = hidden.into_iter().peekable();
    let mut visible = visible.into_iter();
    let mut out = Vec::new();
    loop {
        let slot = out.len();
        if hidden
            .peek()
            .is_some_and(|g| g.position.is_some_and(|p| p <= slot))
        {
            if let Some(g) = hidden.next() {
                out.push(render_hidden_generated(driver, g));
            }
        } else if let Some(v) = visible.next() {
            out.push(v);
        } else if let Some(g) = hidden.next() {
            out.push(render_hidden_generated(driver, g));
        } else {
            break;
        }
    }
    out
}

fn create_table_stmt(
    driver: DriverKind,
    table: &TableDiff,
    indexes_compared: bool,
    uncreatable: &HashSet<&str>,
    fk_statements: &mut Vec<SyncStatement>,
    warnings: &mut Vec<String>,
) -> Option<SyncStatement> {
    let mut cols: Vec<&TableColumnInfo> = Vec::new();
    let mut pk_generated = false;
    for c in table.columns.iter().filter_map(|c| c.source.as_ref()) {
        // 生成式を取得できた生成列は通常列と同じく CREATE に含める (#1837)。
        if is_generated_column(driver, c) && source_generated(table, &c.name).is_none() {
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

    let lines: Vec<String> = cols
        .iter()
        .map(|c| match source_generated(table, &c.name) {
            Some(g) => render_generated_column(driver, c, &g.expression, g.is_virtual),
            None => column_def(driver, c),
        })
        .collect();
    // 列情報に出ない生成列 (SQLite の `table_info` は生成列を隠す) は元の位置へ差し込む。
    let hidden: Vec<&GeneratedColumnInfo> = table
        .generated_changes
        .iter()
        .filter_map(|g| g.source.as_ref())
        .filter(|g| !table.columns.iter().any(|c| c.name == g.column))
        .collect();
    let mut lines = interleave_hidden_generated(driver, lines, &hidden);

    let pk: Vec<String> = cols
        .iter()
        .filter(|c| c.key.eq_ignore_ascii_case("PRI"))
        .map(|c| quote_ident(driver, &c.name))
        .collect();
    if !pk.is_empty() {
        lines.push(format!("PRIMARY KEY ({})", pk.join(", ")));
    }

    // CHECK 制約 (#1837)。式が列を参照するので、列の後・外部キーの前に並べる。
    for c in table.check_changes.iter().filter_map(|c| c.source.as_ref()) {
        lines.push(render_check(driver, &c.name, &c.definition));
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
    // インデックスの差分を比較済みなら、`CREATE INDEX` で出す索引の列は警告から外す。
    let covered: HashSet<&str> = if indexes_compared {
        table
            .indexes
            .iter()
            .filter_map(|i| i.source.as_ref())
            .flat_map(|i| i.columns.iter().map(String::as_str))
            .collect()
    } else {
        HashSet::new()
    };
    let indexed: Vec<&str> = cols
        .iter()
        .filter(|c| {
            c.key.eq_ignore_ascii_case("UNI")
                || (c.key.eq_ignore_ascii_case("MUL") && !fk_cols.contains(c.name.as_str()))
        })
        .filter(|c| !covered.contains(c.name.as_str()))
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
/// sides, pushing warnings for changes the driver cannot express. Returns true
/// when a SQLite table rebuild covers every column / foreign-key change of the
/// table (so the caller must not emit per-constraint statements again).
fn alter_table(
    driver: DriverKind,
    table: &TableDiff,
    allow_destructive: bool,
    statements: &mut Vec<SyncStatement>,
    warnings: &mut Vec<String>,
) -> bool {
    if driver == DriverKind::Sqlite && sqlite_needs_rebuild(table) {
        if let Some(snapshot) = &table.target_snapshot {
            if !allow_destructive {
                // 再作成は破壊的なので出さない。警告を足し、非破壊な ADD COLUMN などは
                // 従来どおり列ごとの処理で出す (後退させない)。
                warnings.push(format!(
                    "{}: SQLite は列・外部キー・CHECK 制約・生成列の変更を ALTER で行えません。テーブルの再作成 SQL (旧表を DROP して作り直す) は「破壊的な操作を許可」を有効にすると出力します。",
                    table.name
                ));
            } else {
                let sql = sqlite_rebuild_sql(table, snapshot, warnings);
                let built = sql.is_some();
                if let Some(sql) = sql {
                    statements.push(SyncStatement {
                        sql,
                        table: table.name.clone(),
                        kind: SyncKind::RebuildTable,
                        destructive: true,
                    });
                }
                // 作れなかったとき (None) は列ごとの処理へ落とす。
                if built {
                    return true;
                }
            }
        }
    }
    let tident = quote_ident(driver, &table.name);
    for col in &table.columns {
        match col.status {
            DiffStatus::SourceOnly => {
                if let Some(src) = &col.source {
                    // 生成式を取得できた生成列は ADD COLUMN で足せる (#1837)。
                    let def = match source_generated(table, &src.name) {
                        Some(g) => {
                            render_generated_column(driver, src, &g.expression, g.is_virtual)
                        }
                        None if is_generated_column(driver, src) => {
                            warnings.push(generated_column_warning(&table.name, &src.name));
                            continue;
                        }
                        None => column_def(driver, src),
                    };
                    statements.push(SyncStatement {
                        sql: format!("ALTER TABLE {} ADD COLUMN {}", tident, def),
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
    generated_expression_warnings(driver, table, warnings);
    false
}

/// 列の差分に現れない生成式の違い (式だけが違う、既存列が生成列になる / でなくなる) を警告する
/// (#1837)。生成式は ALTER で安全に差し替えられない (PostgreSQL は版による、MySQL は列の
/// 再定義が要る) ので自動同期の対象外にし、差があること自体は隠さない。
fn generated_expression_warnings(
    driver: DriverKind,
    table: &TableDiff,
    warnings: &mut Vec<String>,
) {
    if driver == DriverKind::Sqlite {
        return;
    }
    for g in &table.generated_changes {
        let covered = table
            .columns
            .iter()
            .any(|c| c.name == g.column && c.status != DiffStatus::Same);
        if covered {
            continue;
        }
        let expr = |x: &Option<GeneratedColumnInfo>| {
            x.as_ref()
                .map(|x| x.expression.clone())
                .unwrap_or_else(|| "(なし)".to_string())
        };
        warnings.push(format!(
            "{}.{}: 生成式が違います (source: {} / target: {})。生成式は自動同期の対象外です。必要に応じて手動で変更してください。",
            table.name,
            g.column,
            expr(&g.source),
            expr(&g.target)
        ));
    }
}

/// 既存テーブルの CHECK 制約の差分を `ALTER TABLE` にする (#1837)。SQLite は ALTER で制約を
/// 変えられない: テーブル再作成 (`rebuilt`) が引き受けるか、無ければ警告に落とす。
fn check_statements(
    driver: DriverKind,
    table: &TableDiff,
    rebuilt: bool,
    allow_destructive: bool,
    statements: &mut Vec<SyncStatement>,
    warnings: &mut Vec<String>,
) {
    // SourceOnly テーブルの CHECK は CREATE TABLE に含めるのでここでは扱わない。
    if table.status != DiffStatus::Different || table.check_changes.is_empty() || rebuilt {
        return;
    }
    if driver == DriverKind::Sqlite {
        // 再作成コンテキストがある表は `alter_table` が (再作成 SQL か、非破壊のときの警告で)
        // 扱うので、ここで重ねて警告しない。
        if table.target_snapshot.is_some() {
            return;
        }
        warnings.push(format!(
            "{}: SQLite は CHECK 制約の追加・削除・変更を ALTER で行えません。テーブルの再作成が必要です (CHECK の差分: {} 件)。",
            table.name,
            table.check_changes.len()
        ));
        return;
    }
    let tident = quote_ident(driver, &table.name);
    let drop = |c: &CheckConstraintInfo,
                statements: &mut Vec<SyncStatement>,
                warnings: &mut Vec<String>| {
        if c.name.is_empty() {
            warnings.push(format!(
                "{}: CHECK 制約 ({}) は制約名を取得できず DROP できません。手動で削除してください。",
                table.name, c.definition
            ));
            return false;
        }
        let name = quote_ident(driver, &c.name);
        let sql = match driver {
            DriverKind::Mysql => format!("ALTER TABLE {tident} DROP CHECK {name}"),
            _ => format!("ALTER TABLE {tident} DROP CONSTRAINT {name}"),
        };
        statements.push(SyncStatement {
            sql,
            table: table.name.clone(),
            kind: SyncKind::DropCheck,
            destructive: true,
        });
        true
    };
    let add = |c: &CheckConstraintInfo, statements: &mut Vec<SyncStatement>| {
        statements.push(SyncStatement {
            sql: format!(
                "ALTER TABLE {tident} ADD {}",
                render_check(driver, &c.name, &c.definition)
            ),
            table: table.name.clone(),
            kind: SyncKind::AddCheck,
            destructive: false,
        });
    };
    for ch in &table.check_changes {
        match (ch.status, &ch.source, &ch.target) {
            (DiffStatus::SourceOnly, Some(s), _) => add(s, statements),
            (DiffStatus::TargetOnly, _, Some(t)) => {
                if allow_destructive {
                    drop(t, statements, warnings);
                }
            }
            (DiffStatus::Different, Some(s), Some(t)) => {
                if allow_destructive {
                    if drop(t, statements, warnings) {
                        add(s, statements);
                    }
                } else {
                    warnings.push(format!(
                        "{}: CHECK 制約 {} の式が違います。DROP → ADD が必要なため、破壊的な操作を許可すると出力します。",
                        table.name, ch.name
                    ));
                }
            }
            _ => {}
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
            if changed_fields.iter().any(|f| f == "comment") {
                let value = match src.comment.as_deref().filter(|c| !c.trim().is_empty()) {
                    Some(c) => format!("'{}'", c.replace('\'', "''")),
                    None => "NULL".to_string(),
                };
                statements.push(pg_alter(
                    table,
                    format!("COMMENT ON COLUMN {tident}.{cident} IS {value}"),
                ));
                emitted = true;
            }
            // PK / FK reshaping on an existing column needs constraint juggling
            // we don't attempt; flag it so the user handles it deliberately.
            if changed_fields
                .iter()
                .any(|f| f == "key" || f == "foreign_key")
            {
                warnings.push(format!(
                    "{}.{}: キー / 外部キーの差分は自動生成の対象外です。制約は手動で \
                     ALTER TABLE ... ADD/DROP {{PRIMARY KEY|CONSTRAINT}} を実行して調整してください。",
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
                "{}.{}: SQLite は既存の列を ALTER で変更できません。テーブルを作り直して反映してください \
                 (新定義で CREATE TABLE → INSERT ... SELECT でデータ移行 → DROP TABLE → RENAME)。",
                table, src.name
            ));
        }
    }
}

/// SQLite のテーブル再作成の前後に付ける PRAGMA。外部キー検査を切らずに旧表を `DROP` すると
/// 暗黙の `DELETE` で子表の `ON DELETE CASCADE` が発火して行が消える。`PRAGMA foreign_keys` は
/// トランザクション内では効かないため、`SqliteConn::execute_sync_transaction` (`apply_sync_sql` の経路) がこの 2 行を見つけて
/// トランザクションの外で切り替える (他のドライバ・直接実行では通常の文として実行される)。
pub(crate) const SQLITE_FK_OFF: &str = "PRAGMA foreign_keys=OFF";
pub(crate) const SQLITE_FK_ON: &str = "PRAGMA foreign_keys=ON";

/// SQLite で列の変更 (型・NOT NULL・DEFAULT など) か外部キーの変更があり、テーブルの
/// 再作成が要る表か。生成列は対象外 (SQLite 宛ては生成列を外さないので該当しない)。
/// SQLite の再作成後に持たせる CHECK 制約と生成列。target の定義へ `check_changes` /
/// `generated_changes` (source への揃え) を反映する。target を取得できていない
/// (`extras_known` が false) ときは何も足さない (元の定義は警告で知らせる)。
fn rebuilt_extras(
    table: &TableDiff,
    snap: &super::diff::TargetTableSnapshot,
) -> (Vec<CheckConstraintInfo>, Vec<GeneratedColumnInfo>) {
    if !snap.extras_known {
        return (Vec::new(), Vec::new());
    }
    let mut checks = snap.checks.clone();
    for ch in &table.check_changes {
        let same = |c: &CheckConstraintInfo, o: &CheckConstraintInfo| {
            normalize_check(&c.definition) == normalize_check(&o.definition)
        };
        match (ch.status, &ch.source, &ch.target) {
            (DiffStatus::TargetOnly, _, Some(t)) => checks.retain(|c| !same(c, t)),
            (DiffStatus::Different, Some(s), Some(t)) => {
                checks.retain(|c| !same(c, t));
                checks.push(s.clone());
            }
            (DiffStatus::SourceOnly, Some(s), _) => checks.push(s.clone()),
            _ => {}
        }
    }
    let mut generated = snap.generated.clone();
    for ch in &table.generated_changes {
        match (ch.status, &ch.source) {
            (DiffStatus::TargetOnly, _) => generated.retain(|g| g.column != ch.column),
            (DiffStatus::Different, Some(s)) => {
                generated.retain(|g| g.column != ch.column);
                generated.push(s.clone());
            }
            (DiffStatus::SourceOnly, Some(s)) => generated.push(s.clone()),
            _ => {}
        }
    }
    (checks, generated)
}

fn sqlite_needs_rebuild(table: &TableDiff) -> bool {
    table
        .columns
        .iter()
        .any(|c| c.status == DiffStatus::Different)
        || !table.fk_changes.is_empty()
        || !table.check_changes.is_empty()
        || !table.generated_changes.is_empty()
}

/// SQLite の「12 ステップ」のテーブル再作成 SQL を 1 つの文字列 (複数文) にして返す。
/// 新表を作る → `INSERT ... SELECT` で移す → 旧表を `DROP` → `RENAME` → インデックス /
/// トリガーを元の `CREATE` 文で作り直す。同じ表の列の追加・削除・外部キーの変更も一緒に
/// 反映する (target の列を source の定義へ差し替え、source だけの列を足す。target だけの列は
/// `DROP` の許可があるので落とす)。再現できない構文は警告に出す。
fn sqlite_rebuild_sql(
    table: &TableDiff,
    snap: &super::diff::TargetTableSnapshot,
    warnings: &mut Vec<String>,
) -> Option<String> {
    let driver = DriverKind::Sqlite;
    let status_of = |name: &str| table.columns.iter().find(|c| c.name == name);

    // 最終的な列 (target の並びを保ち、変更は source の定義へ、source のみの列は末尾に足す)。
    let mut finals: Vec<TableColumnInfo> = Vec::new();
    for tc in &snap.columns {
        match status_of(&tc.name) {
            Some(c) if c.status == DiffStatus::Different => {
                finals.push(c.source.clone().unwrap_or_else(|| tc.clone()));
            }
            Some(c) if c.status == DiffStatus::TargetOnly => {} // 破壊的操作を許可しているので落とす
            _ => finals.push(tc.clone()),
        }
    }
    let copied: Vec<String> = finals
        .iter()
        .filter(|f| snap.columns.iter().any(|t| t.name == f.name))
        .map(|f| quote_ident(driver, &f.name))
        .collect();
    for c in &table.columns {
        if c.status == DiffStatus::SourceOnly {
            if let Some(src) = &c.source {
                finals.push(src.clone());
            }
        }
    }
    if finals.is_empty() || copied.is_empty() {
        warnings.push(format!(
            "{}: 再作成後の列が無いため、テーブル再作成 SQL を生成しません。",
            table.name
        ));
        return None;
    }

    let original_upper = snap
        .original_sql
        .as_deref()
        .unwrap_or("")
        .to_ascii_uppercase();
    let pk: Vec<&TableColumnInfo> = finals
        .iter()
        .filter(|c| c.key.eq_ignore_ascii_case("PRI"))
        .collect();
    let autoincrement = original_upper.contains("AUTOINCREMENT")
        && pk.len() == 1
        && pk
            .first()
            .is_some_and(|c| c.data_type.eq_ignore_ascii_case("INTEGER"));
    let lines: Vec<String> = finals
        .iter()
        .map(|c| {
            if autoincrement && c.key.eq_ignore_ascii_case("PRI") {
                format!(
                    "{} INTEGER PRIMARY KEY AUTOINCREMENT",
                    quote_ident(driver, &c.name)
                )
            } else {
                column_def(driver, c)
            }
        })
        .collect();
    // 生成列 (#1837): 列定義は表制約 (PRIMARY KEY など) より前に並べる必要がある。
    // 差し込み位置は target の `table_xinfo` の cid (隠れた列を含む全列での位置) を基準にした
    // 概算。再作成で列を足す・消す・順序を変えると元の位置とはずれうる (生成列は他の列を
    // 参照するだけで位置に意味は無いので、値や制約の正しさには影響しない)。
    let (checks, generated) = rebuilt_extras(table, snap);
    let hidden: Vec<&GeneratedColumnInfo> = generated.iter().collect();
    let mut lines = interleave_hidden_generated(driver, lines, &hidden);
    if !autoincrement && !pk.is_empty() {
        let cols: Vec<String> = pk.iter().map(|c| quote_ident(driver, &c.name)).collect();
        lines.push(format!("PRIMARY KEY ({})", cols.join(", ")));
    }
    let names: HashSet<&str> = finals.iter().map(|c| c.name.as_str()).collect();
    for uq in &snap.unique_constraints {
        if uq.iter().all(|c| names.contains(c.as_str())) {
            let cols: Vec<String> = uq.iter().map(|c| quote_ident(driver, c)).collect();
            lines.push(format!("UNIQUE ({})", cols.join(", ")));
        } else {
            warnings.push(format!(
                "{}: UNIQUE ({}) は削除する列を含むため、再作成後の表には含めません。",
                table.name,
                uq.join(", ")
            ));
        }
    }

    // 外部キー: target の定義に fk_changes (source への揃え) を反映する。
    let mut fks: Vec<DiffForeignKey> = snap.foreign_keys.clone();
    for ch in &table.fk_changes {
        let sig = |f: &DiffForeignKey| {
            format!(
                "{}->{}",
                f.columns.join(",").to_ascii_lowercase(),
                f.referenced_table.to_ascii_lowercase()
            )
        };
        match ch.status {
            DiffStatus::TargetOnly => {
                if let Some(t) = &ch.target {
                    fks.retain(|f| sig(f) != sig(t));
                }
            }
            DiffStatus::Different => {
                if let (Some(s), Some(t)) = (&ch.source, &ch.target) {
                    fks.retain(|f| sig(f) != sig(t));
                    fks.push(s.clone());
                }
            }
            DiffStatus::SourceOnly => {
                if let Some(s) = &ch.source {
                    fks.push(s.clone());
                }
            }
            DiffStatus::Same => {}
        }
    }
    for fk in &fks {
        if let Some(missing) = fk.columns.iter().find(|c| !names.contains(c.as_str())) {
            warnings.push(format!(
                "{}: 外部キー ({}) は再作成後に存在しない列 {} を含むため含めません。",
                table.name,
                fk.columns.join(", "),
                missing
            ));
            continue;
        }
        lines.push(render_foreign_key(driver, &fk_group(fk)));
    }

    // CHECK 制約 (#1837): target の定義に差分 (source への揃え) を反映する。
    for c in &checks {
        // 削除する列を参照する CHECK は作り直しに失敗するので外して警告する。
        let haystack = mask_string_literals(&c.definition);
        if let Some(col) = snap
            .columns
            .iter()
            .filter(|tc| !names.contains(tc.name.as_str()))
            .find(|tc| references_identifier(&haystack, &tc.name))
        {
            warnings.push(format!(
                "{}: CHECK 制約 {} は削除する列 {} を参照するため、再作成後の表には含めません。",
                table.name, c.definition, col.name
            ));
            continue;
        }
        lines.push(render_check(driver, &c.name, &c.definition));
    }

    let tmp = format!("__noobdb_rebuild_{}", table.name);
    let tmp_ident = quote_ident(driver, &tmp);
    let tident = quote_ident(driver, &table.name);
    let mut create = render_create_table(&tmp_ident, &lines);
    if original_upper.contains("WITHOUT ROWID") {
        create.push_str(" WITHOUT ROWID");
    }
    let cols = copied.join(", ");
    let mut script: Vec<String> = vec![SQLITE_FK_OFF.to_string()];
    script.extend(
        snap.drop_views
            .iter()
            .map(|v| format!("DROP VIEW IF EXISTS {}", quote_ident(driver, v))),
    );
    script.extend([
        create,
        format!("INSERT INTO {tmp_ident} ({cols}) SELECT {cols} FROM {tident}"),
        format!("DROP TABLE {tident}"),
        format!("ALTER TABLE {tmp_ident} RENAME TO {tident}"),
    ]);
    // 作り直すインデックス・トリガー・ビュー。削除する列を参照するものは作り直しに失敗する
    // ので除き、計画で DROP / 作り直しする索引 (TargetOnly / Different) は旧表の DROP で
    // 消えるだけにする (Different は index_statements が source の定義で作る)。
    let dropped_columns: Vec<&str> = snap
        .columns
        .iter()
        .filter(|c| !names.contains(c.name.as_str()))
        .map(|c| c.name.as_str())
        .collect();
    let planned: HashSet<String> = table
        .indexes
        .iter()
        .filter(|i| matches!(i.status, DiffStatus::TargetOnly | DiffStatus::Different))
        .map(|i| i.name.to_ascii_lowercase())
        .collect();
    let mut recreate: Vec<String> = Vec::new();
    for sql in &snap.recreate_sql {
        if let Some(name) = created_index_name(sql) {
            if planned.contains(&name.to_ascii_lowercase()) {
                continue;
            }
        }
        let is_index = created_index_name(sql).is_some();
        // 索引は ON <表> の後ろ (列リストと WHERE) だけを見る。表名と同名の列や、文字列
        // リテラル内・NEW/OLD のような語に反応しない。トリガー・ビューは全文 (リテラル除外)。
        let haystack = if is_index {
            index_tail(sql)
        } else {
            mask_string_literals(sql)
        };
        if let Some(col) = dropped_columns
            .iter()
            .find(|c| references_identifier(&haystack, c))
        {
            let unique_note = if is_index && sql.to_ascii_uppercase().contains("UNIQUE") {
                " (UNIQUE インデックスのため、一意制約も失われます)"
            } else {
                ""
            };
            warnings.push(format!(
                "{}: 削除する列 {} を参照するため、次の定義は再作成後に作り直しません{}: {}",
                table.name,
                col,
                unique_note,
                sql.split_whitespace().collect::<Vec<_>>().join(" ")
            ));
            continue;
        }
        recreate.push(sql.trim().trim_end_matches(';').to_string());
    }
    script.extend(recreate.iter().cloned());
    script.push(SQLITE_FK_ON.to_string());

    // 警告: 再現できない構文・子表の参照・作り直す索引。
    let mut lost: Vec<&str> = Vec::new();
    for (kw, label) in [
        ("CHECK", "CHECK 制約"),
        ("COLLATE", "COLLATE"),
        ("GENERATED", "生成列"),
        ("STRICT", "STRICT"),
        ("ON CONFLICT", "ON CONFLICT 句"),
    ] {
        // CHECK 制約・生成列は取得できていれば再作成 SQL に含める (#1837)。
        if snap.extras_known && matches!(kw, "CHECK" | "GENERATED") {
            continue;
        }
        if original_upper.contains(kw) {
            lost.push(label);
        }
    }
    if !lost.is_empty() {
        warnings.push(format!(
            "{}: 元の CREATE TABLE に {} が含まれています。列情報から組み立てる再作成 SQL には含まれないため、適用前に SQL を確認して手で補ってください。",
            table.name,
            lost.join(" / ")
        ));
    }
    if !snap.referenced_by.is_empty() {
        warnings.push(format!(
            "{}: 次の表から外部キーで参照されています: {}。再作成中は PRAGMA foreign_keys=OFF にして旧表の DROP で子表の行が連鎖削除・書き換えされないようにします。適用後は PRAGMA foreign_key_check で参照整合性を確認してください。",
            table.name,
            snap.referenced_by.join(", ")
        ));
    }
    if !recreate.is_empty() {
        warnings.push(format!(
            "{}: インデックス・トリガー・ビュー {} 件を元の CREATE 文で作り直します。型変更した列を参照している場合は適用後に確認してください。",
            table.name,
            recreate.len()
        ));
    }
    if autoincrement {
        warnings.push(format!(
            "{}: AUTOINCREMENT の表を再作成すると sqlite_sequence は残っている最大 ID まで戻り、削除済みの ID が再利用されることがあります。",
            table.name
        ));
    }
    Some(script.join(";\n") + ";")
}

/// `CREATE [UNIQUE] INDEX [IF NOT EXISTS] name ON ...` から索引名を取り出す。索引以外は `None`。
fn created_index_name(sql: &str) -> Option<String> {
    let upper = sql.to_ascii_uppercase();
    let head = upper.trim_start();
    if !(head.starts_with("CREATE INDEX") || head.starts_with("CREATE UNIQUE INDEX")) {
        return None;
    }
    let pos = upper.find("INDEX")? + "INDEX".len();
    let mut rest = sql[pos..].trim_start();
    if rest.to_ascii_uppercase().starts_with("IF NOT EXISTS") {
        rest = rest["IF NOT EXISTS".len()..].trim_start();
    }
    // `schema.name` / `"schema"."name"` は最後の要素が索引名。
    let mut cur = rest;
    loop {
        let mut chars = cur.chars();
        let first = chars.next()?;
        let close = match first {
            '"' => Some('"'),
            '`' => Some('`'),
            '[' => Some(']'),
            _ => None,
        };
        let (part, consumed) = match close {
            Some(c) => {
                let body: String = chars.take_while(|&x| x != c).collect();
                let n = first.len_utf8() + body.len() + c.len_utf8();
                (body, n.min(cur.len()))
            }
            None => {
                let body: String = cur
                    .chars()
                    .take_while(|c| !c.is_whitespace() && *c != '(' && *c != '.')
                    .collect();
                let n = body.len();
                (body, n)
            }
        };
        cur = &cur[consumed..];
        match cur.strip_prefix('.') {
            Some(next) => cur = next,
            None => return Some(part),
        }
    }
}

/// 単引用符の文字列リテラルの中身を空白に置き換える (識別子の引用符は触らない)。
fn mask_string_literals(sql: &str) -> String {
    let mut out = String::with_capacity(sql.len());
    let mut in_lit = false;
    for c in sql.chars() {
        if in_lit {
            if c == '\'' {
                in_lit = false;
                out.push(c);
            } else {
                out.push(' ');
            }
        } else {
            if c == '\'' {
                in_lit = true;
            }
            out.push(c);
        }
    }
    out
}

/// `CREATE INDEX ... ON <表> (列, ...) WHERE ...` の最初の `(` 以降 (リテラルは除外済み)。
/// 見つからなければ空文字列。
fn index_tail(sql: &str) -> String {
    let masked = mask_string_literals(sql);
    let chars: Vec<char> = masked.chars().collect();
    let is_word = |c: char| c.is_alphanumeric() || c == '_';
    let mut i = 0;
    let mut seen_on = false;
    while i < chars.len() {
        let c = chars[i];
        let close = match c {
            '"' => Some('"'),
            '`' => Some('`'),
            '[' => Some(']'),
            _ => None,
        };
        if let Some(q) = close {
            i += 1;
            while i < chars.len() && chars[i] != q {
                i += 1;
            }
            i += 1;
            continue;
        }
        if seen_on && c == '(' {
            return chars[i..].iter().collect();
        }
        if !seen_on
            && (c == 'o' || c == 'O')
            && i + 1 < chars.len()
            && (chars[i + 1] == 'n' || chars[i + 1] == 'N')
            && (i == 0 || !is_word(chars[i - 1]))
            && (i + 2 >= chars.len() || !is_word(chars[i + 2]))
        {
            seen_on = true;
            i += 2;
            continue;
        }
        i += 1;
    }
    String::new()
}

/// `sql` が識別子 `name` を (大文字小文字を区別せず) 単語として含むか。引用符つきも拾う。
fn references_identifier(sql: &str, name: &str) -> bool {
    if name.is_empty() {
        return false;
    }
    let hay = sql.to_ascii_lowercase();
    let needle = name.to_ascii_lowercase();
    let is_word = |c: char| c.is_alphanumeric() || c == '_';
    let mut from = 0;
    while let Some(i) = hay[from..].find(&needle) {
        let start = from + i;
        let end = start + needle.len();
        let before_ok = hay[..start]
            .chars()
            .next_back()
            .map_or(true, |c| !is_word(c));
        let after_ok = hay[end..].chars().next().map_or(true, |c| !is_word(c));
        if before_ok && after_ok {
            return true;
        }
        from = start + needle.len().max(1);
    }
    false
}

/// インデックスの差分を `CREATE INDEX` / `DROP INDEX` にする (#1625)。主キーは対象外。
/// 定義が違うインデックスは `DROP` + `CREATE` なので破壊的操作の許可が要る。
fn index_statements(
    driver: DriverKind,
    table: &TableDiff,
    rebuilt: bool,
    allow_destructive: bool,
    statements: &mut Vec<SyncStatement>,
    warnings: &mut Vec<String>,
) {
    let tident = quote_ident(driver, &table.name);
    let create = |idx: &super::diff::DiffIndex,
                  statements: &mut Vec<SyncStatement>,
                  warnings: &mut Vec<String>| {
        match super::table_ddl::render_index(driver, &tident, &idx.to_info()) {
            Some(sql) => statements.push(SyncStatement {
                sql,
                table: table.name.clone(),
                kind: SyncKind::AddIndex,
                destructive: false,
            }),
            None => warnings.push(format!(
                "{}: インデックス {} は式を含む、または列が無いため自動生成できません。手動で作成してください。",
                table.name, idx.name
            )),
        }
    };
    let drop = |idx: &super::diff::DiffIndex,
                statements: &mut Vec<SyncStatement>,
                warnings: &mut Vec<String>| {
        let name = quote_ident(driver, &idx.name);
        let sql = match driver {
            DriverKind::Mysql => format!("DROP INDEX {name} ON {tident}"),
            _ => format!("DROP INDEX {name}"),
        };
        if driver == DriverKind::Postgres && idx.unique {
            warnings.push(format!(
                "{}: UNIQUE インデックス {} が UNIQUE 制約に紐づく場合、DROP INDEX は失敗します (ALTER TABLE ... DROP CONSTRAINT を使ってください)。",
                table.name, idx.name
            ));
        }
        statements.push(SyncStatement {
            sql,
            table: table.name.clone(),
            kind: SyncKind::DropIndex,
            destructive: true,
        });
    };
    for ch in &table.indexes {
        match (ch.status, &ch.source, &ch.target) {
            (DiffStatus::SourceOnly, Some(s), _) => create(s, statements, warnings),
            (DiffStatus::TargetOnly, _, Some(t)) => {
                // 再作成する表では旧表の DROP で索引ごと消えるので DROP INDEX は出さない。
                if allow_destructive && !rebuilt {
                    drop(t, statements, warnings);
                }
            }
            (DiffStatus::Different, Some(s), Some(t)) => {
                if allow_destructive {
                    if !rebuilt {
                        drop(t, statements, warnings);
                    }
                    create(s, statements, warnings);
                } else {
                    warnings.push(format!(
                        "{}: インデックス {} の定義 ({}) が違います。DROP INDEX → CREATE INDEX が必要なため、破壊的な操作を許可すると出力します。",
                        table.name,
                        ch.name,
                        ch.changed_fields.join(", ")
                    ));
                }
            }
            _ => {}
        }
    }
}

/// 既存テーブルの外部キーの差分 (追加・削除・参照動作の変更) を `ALTER TABLE` にする
/// (#1625)。SQLite は ALTER で制約を変えられない: テーブル再作成 (`rebuilt`) が引き受ける
/// か、無ければ警告に落とす。
fn foreign_key_statements(
    driver: DriverKind,
    table: &TableDiff,
    rebuilt: bool,
    allow_destructive: bool,
    statements: &mut Vec<SyncStatement>,
    warnings: &mut Vec<String>,
) {
    if table.fk_changes.is_empty() || rebuilt {
        return;
    }
    if driver == DriverKind::Sqlite {
        warnings.push(format!(
            "{}: SQLite は外部キーの追加・削除・変更を ALTER で行えません。テーブルの再作成が必要です (外部キーの差分: {} 件)。",
            table.name,
            table.fk_changes.len()
        ));
        return;
    }
    let tident = quote_ident(driver, &table.name);
    let drop =
        |fk: &DiffForeignKey, statements: &mut Vec<SyncStatement>, warnings: &mut Vec<String>| {
            let Some(name) = fk.name.as_deref() else {
                warnings.push(format!(
                "{}: 外部キー ({}) は制約名を取得できず DROP できません。手動で削除してください。",
                table.name,
                fk.columns.join(", ")
            ));
                return false;
            };
            let name = quote_ident(driver, name);
            let sql = match driver {
                DriverKind::Mysql => format!("ALTER TABLE {tident} DROP FOREIGN KEY {name}"),
                _ => format!("ALTER TABLE {tident} DROP CONSTRAINT {name}"),
            };
            statements.push(SyncStatement {
                sql,
                table: table.name.clone(),
                kind: SyncKind::DropForeignKey,
                destructive: true,
            });
            true
        };
    let add = |fk: &DiffForeignKey,
               statements: &mut Vec<SyncStatement>,
               warnings: &mut Vec<String>| {
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
        statements.push(SyncStatement {
            sql: format!(
                "ALTER TABLE {tident} ADD {}",
                render_foreign_key(driver, &fk_group(&fk))
            ),
            table: table.name.clone(),
            kind: SyncKind::AddForeignKey,
            destructive: false,
        });
    };
    for ch in &table.fk_changes {
        match (ch.status, &ch.source, &ch.target) {
            (DiffStatus::SourceOnly, Some(s), _) => add(s, statements, warnings),
            (DiffStatus::TargetOnly, _, Some(t)) => {
                if allow_destructive {
                    drop(t, statements, warnings);
                }
            }
            (DiffStatus::Different, Some(s), Some(t)) => {
                if allow_destructive {
                    // 名前を引き継いで同名で作り直す (source 側が名前を持たないとき)。
                    let mut s = s.clone();
                    if s.name.is_none() {
                        s.name = t.name.clone();
                    }
                    if drop(t, statements, warnings) {
                        add(&s, statements, warnings);
                    }
                } else {
                    warnings.push(format!(
                        "{}: 外部キー ({}) の {} が違います。DROP → ADD が必要なため、破壊的な操作を許可すると出力します。",
                        table.name,
                        s.columns.join(", "),
                        ch.changed_fields.join(", ")
                    ));
                }
            }
            _ => {}
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
            warnings: Vec::new(),
            indexes_compared: false,
            objects: Default::default(),
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
            ..Default::default()
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
                ..Default::default()
            },
            TableDiff {
                name: "users".to_string(),
                status: DiffStatus::SourceOnly,
                foreign_keys: vec![],
                columns: vec![
                    cdiff("a", DiffStatus::SourceOnly, Some(pk_col("a")), &[]),
                    cdiff("b", DiffStatus::SourceOnly, Some(pk_col("b")), &[]),
                ],
                ..Default::default()
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
            ..Default::default()
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
            ..Default::default()
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
            ..Default::default()
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
            ..Default::default()
        };
        let plan = generate_sync_sql(&diff(DriverKind::Postgres, vec![table]), false);
        assert!(plan.statements.is_empty());
        assert_eq!(plan.warnings.len(), 1);
        assert!(plan.warnings[0].contains("キー"));
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
            ..Default::default()
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
        assert!(plan.warnings[0].contains("SQLite は既存の列を ALTER で変更できません"));
    }

    #[test]
    fn same_tables_produce_nothing() {
        let table = TableDiff {
            name: "t".to_string(),
            status: DiffStatus::Same,
            foreign_keys: vec![],
            columns: vec![],
            ..Default::default()
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
            ..Default::default()
        };
        let mut warnings = Vec::new();
        let stmt = create_table_stmt(
            DriverKind::Mysql,
            &table,
            false,
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
            ..Default::default()
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
            ..Default::default()
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
            ..Default::default()
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
            ..Default::default()
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
            ..Default::default()
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
            ..Default::default()
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
            ..Default::default()
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
            ..Default::default()
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
            ..Default::default()
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
                ..Default::default()
            };
            let d = SchemaDiff {
                source_driver: src_driver,
                target_driver: DriverKind::Sqlite,
                tables: vec![table],
                warnings: Vec::new(),
                indexes_compared: false,
                objects: Default::default(),
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
            ..Default::default()
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
            ..Default::default()
        };
        let parent = TableDiff {
            name: "parent".to_string(),
            status: DiffStatus::Same,
            foreign_keys: vec![],
            columns: vec![],
            ..Default::default()
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

    fn same_child_referencing(parent: &str, on_delete: Option<&str>) -> TableDiff {
        let mut f = fk("fk_p", &["pid"], parent, &["id"]);
        f.on_delete = on_delete.map(str::to_string);
        TableDiff {
            name: "child".to_string(),
            status: DiffStatus::Same,
            foreign_keys: vec![f],
            columns: vec![],
            ..Default::default()
        }
    }

    fn target_only_parent() -> TableDiff {
        TableDiff {
            name: "parent".to_string(),
            status: DiffStatus::TargetOnly,
            foreign_keys: vec![],
            columns: vec![cdiff("id", DiffStatus::TargetOnly, None, &[])],
            ..Default::default()
        }
    }

    #[test]
    fn sqlite_drop_table_skipped_when_remaining_child_cascades() {
        for action in ["CASCADE", "SET NULL", "SET DEFAULT"] {
            let d = diff(
                DriverKind::Sqlite,
                vec![
                    same_child_referencing("parent", Some(action)),
                    target_only_parent(),
                ],
            );
            let plan = generate_sync_sql(&d, true);
            assert!(
                plan.statements
                    .iter()
                    .all(|s| s.kind != SyncKind::DropTable),
                "{action}: {:?}",
                plan.statements
            );
            assert!(
                plan.warnings
                    .iter()
                    .any(|w| w.contains("parent") && w.contains("child")),
                "{action}: {:?}",
                plan.warnings
            );
        }
    }

    #[test]
    fn drop_table_kept_when_no_cascading_remaining_child() {
        // NO ACTION の子、または MySQL / PostgreSQL (参照中の DROP はエラーで止まる) は従来どおり。
        let d = diff(
            DriverKind::Sqlite,
            vec![
                same_child_referencing("parent", Some("NO ACTION")),
                target_only_parent(),
            ],
        );
        assert_eq!(generate_sync_sql(&d, true).statements.len(), 1);
        for driver in [DriverKind::Mysql, DriverKind::Postgres] {
            let d = diff(
                driver,
                vec![
                    same_child_referencing("parent", Some("CASCADE")),
                    target_only_parent(),
                ],
            );
            assert_eq!(
                generate_sync_sql(&d, true).statements.len(),
                1,
                "{driver:?}"
            );
        }
    }

    #[test]
    fn postgres_comment_only_change_emits_comment_on_column() {
        let mut src = col("name", "text");
        src.comment = Some("ユーザ's名".to_string());
        let table = TableDiff {
            name: "users".to_string(),
            status: DiffStatus::Different,
            foreign_keys: vec![],
            columns: vec![cdiff(
                "name",
                DiffStatus::Different,
                Some(src),
                &["comment"],
            )],
            ..Default::default()
        };
        let plan = generate_sync_sql(&diff(DriverKind::Postgres, vec![table]), false);
        assert_eq!(plan.statements.len(), 1, "{:?}", plan.statements);
        assert_eq!(
            plan.statements[0].sql,
            "COMMENT ON COLUMN \"users\".\"name\" IS 'ユーザ''s名'"
        );
    }

    #[test]
    fn mysql_comment_only_change_emits_modify_column_with_comment() {
        let mut src = col("name", "varchar(10)");
        src.comment = Some("名前".to_string());
        let table = TableDiff {
            name: "users".to_string(),
            status: DiffStatus::Different,
            foreign_keys: vec![],
            columns: vec![cdiff(
                "name",
                DiffStatus::Different,
                Some(src),
                &["comment"],
            )],
            ..Default::default()
        };
        let plan = generate_sync_sql(&diff(DriverKind::Mysql, vec![table]), false);
        assert_eq!(plan.statements.len(), 1, "{:?}", plan.statements);
        assert!(plan.statements[0].sql.contains("COMMENT '名前'"));
    }

    fn tdiff(name: &str, status: DiffStatus, fks: Vec<DiffForeignKey>) -> TableDiff {
        TableDiff {
            name: name.to_string(),
            status,
            foreign_keys: fks,
            columns: vec![],
            ..Default::default()
        }
    }

    fn fk_to(parent: &str, on_delete: &str) -> DiffForeignKey {
        let mut f = fk("fk", &["pid"], parent, &["id"]);
        f.on_delete = Some(on_delete.to_string());
        f
    }

    fn drops(plan: &SyncPlan) -> Vec<&str> {
        plan.statements
            .iter()
            .filter(|s| s.kind == SyncKind::DropTable)
            .map(|s| s.table.as_str())
            .collect()
    }

    #[test]
    fn sqlite_cascade_chain_keeps_every_ancestor_of_a_remaining_table() {
        // grandparent <- parent (CASCADE) <- child (残る表, CASCADE)。
        // parent の DROP を省くなら grandparent の DROP も出してはいけない。
        let d = diff(
            DriverKind::Sqlite,
            vec![
                tdiff("child", DiffStatus::Same, vec![fk_to("parent", "CASCADE")]),
                tdiff("grandparent", DiffStatus::TargetOnly, vec![]),
                tdiff(
                    "parent",
                    DiffStatus::TargetOnly,
                    vec![fk_to("grandparent", "CASCADE")],
                ),
                tdiff("unrelated", DiffStatus::TargetOnly, vec![]),
            ],
        );
        let plan = generate_sync_sql(&d, true);
        assert_eq!(drops(&plan), vec!["unrelated"], "{:?}", plan.statements);
        assert!(plan.warnings.iter().any(|w| w.contains("grandparent")));
        assert!(plan.warnings.iter().any(|w| w.contains("parent")));
        // 残る表から NO ACTION で直接参照される表は従来どおり落とす。DROP を省いた parent が
        // NO ACTION で参照する祖先 gp は、落とすと FK エラーになるので残して警告する。
        let d = diff(
            DriverKind::Sqlite,
            vec![
                tdiff("child", DiffStatus::Same, vec![fk_to("parent", "CASCADE")]),
                tdiff("gp", DiffStatus::TargetOnly, vec![]),
                tdiff(
                    "parent",
                    DiffStatus::TargetOnly,
                    vec![fk_to("gp", "NO ACTION")],
                ),
            ],
        );
        assert!(drops(&generate_sync_sql(&d, true)).is_empty());
        let d = diff(
            DriverKind::Sqlite,
            vec![
                tdiff(
                    "child",
                    DiffStatus::Same,
                    vec![fk_to("parent", "NO ACTION")],
                ),
                tdiff("parent", DiffStatus::TargetOnly, vec![]),
            ],
        );
        assert_eq!(drops(&generate_sync_sql(&d, true)), vec!["parent"]);
    }

    #[test]
    fn sqlite_fk_reference_case_differences_are_matched_case_insensitively() {
        let d = diff(
            DriverKind::Sqlite,
            vec![
                tdiff("child", DiffStatus::Same, vec![fk_to("Parent", "CASCADE")]),
                tdiff("parent", DiffStatus::TargetOnly, vec![]),
            ],
        );
        assert!(drops(&generate_sync_sql(&d, true)).is_empty());
    }

    #[test]
    fn schema_diff_warnings_reach_destructive_plans_only() {
        let mut d = diff(DriverKind::Sqlite, vec![target_only_parent()]);
        d.warnings.push("fk 取得失敗".to_string());
        assert!(generate_sync_sql(&d, true)
            .warnings
            .iter()
            .any(|w| w == "fk 取得失敗"));
        assert!(generate_sync_sql(&d, false).warnings.is_empty());
    }

    fn dix(name: &str, cols: &[&str], unique: bool) -> super::super::diff::DiffIndex {
        super::super::diff::DiffIndex {
            name: name.to_string(),
            columns: cols.iter().map(|c| c.to_string()).collect(),
            unique,
            method: None,
            predicate: None,
            first_expression_at: None,
            key_column_count: None,
            column_options: vec![],
            nulls_not_distinct: false,
        }
    }

    fn idx_diff(
        status: DiffStatus,
        s: Option<super::super::diff::DiffIndex>,
        t: Option<super::super::diff::DiffIndex>,
    ) -> super::super::diff::IndexDiff {
        super::super::diff::IndexDiff {
            name: s
                .as_ref()
                .or(t.as_ref())
                .map(|i| i.name.clone())
                .unwrap_or_default(),
            status,
            source: s,
            target: t,
            changed_fields: vec!["columns".into()],
        }
    }

    #[test]
    fn index_differences_become_create_and_drop_with_destructive_gate() {
        let table = TableDiff {
            name: "t".into(),
            status: DiffStatus::Different,
            indexes: vec![
                idx_diff(DiffStatus::SourceOnly, Some(dix("a", &["x"], true)), None),
                idx_diff(DiffStatus::TargetOnly, None, Some(dix("b", &["y"], false))),
                idx_diff(
                    DiffStatus::Different,
                    Some(dix("c", &["x", "y"], false)),
                    Some(dix("c", &["x"], false)),
                ),
            ],
            ..Default::default()
        };
        let safe = generate_sync_sql(&diff(DriverKind::Mysql, vec![table.clone()]), false);
        assert_eq!(safe.statements.len(), 1);
        assert_eq!(
            safe.statements[0].sql,
            "CREATE UNIQUE INDEX `a` ON `t` (`x`)"
        );
        assert_eq!(safe.statements[0].kind, SyncKind::AddIndex);
        assert!(safe
            .warnings
            .iter()
            .any(|w| w.contains("`c`") || w.contains(" c ")));

        let full = generate_sync_sql(&diff(DriverKind::Mysql, vec![table]), true);
        let sqls: Vec<&str> = full.statements.iter().map(|s| s.sql.as_str()).collect();
        // DROP は CREATE より前 (同名の作り直し)
        assert_eq!(
            sqls,
            vec![
                "DROP INDEX `b` ON `t`",
                "DROP INDEX `c` ON `t`",
                "CREATE UNIQUE INDEX `a` ON `t` (`x`)",
                "CREATE INDEX `c` ON `t` (`x`, `y`)",
            ]
        );
        assert!(full.statements[0].destructive && !full.statements[2].destructive);
    }

    #[test]
    fn foreign_key_differences_become_alter_table_statements() {
        let f = |od: Option<&str>| DiffForeignKey {
            name: Some("fk_t_p".into()),
            columns: vec!["pid".into()],
            referenced_table: "p".into(),
            referenced_columns: vec!["id".into()],
            on_delete: od.map(str::to_string),
            on_update: None,
        };
        let table = TableDiff {
            name: "t".into(),
            status: DiffStatus::Different,
            fk_changes: vec![super::super::diff::ForeignKeyDiff {
                status: DiffStatus::Different,
                source: Some(f(Some("CASCADE"))),
                target: Some(f(None)),
                changed_fields: vec!["on_delete".into()],
            }],
            ..Default::default()
        };
        let pg = generate_sync_sql(&diff(DriverKind::Postgres, vec![table.clone()]), true);
        let sqls: Vec<&str> = pg.statements.iter().map(|s| s.sql.as_str()).collect();
        assert_eq!(
            sqls,
            vec![
                "ALTER TABLE \"t\" DROP CONSTRAINT \"fk_t_p\"",
                "ALTER TABLE \"t\" ADD CONSTRAINT \"fk_t_p\" FOREIGN KEY (\"pid\") REFERENCES \"p\" (\"id\") ON DELETE CASCADE",
            ]
        );
        let my = generate_sync_sql(&diff(DriverKind::Mysql, vec![table.clone()]), true);
        assert_eq!(
            my.statements[0].sql,
            "ALTER TABLE `t` DROP FOREIGN KEY `fk_t_p`"
        );
        let safe = generate_sync_sql(&diff(DriverKind::Postgres, vec![table.clone()]), false);
        assert!(safe.statements.is_empty() && !safe.warnings.is_empty());
        let lite = generate_sync_sql(&diff(DriverKind::Sqlite, vec![table]), true);
        assert!(lite.statements.is_empty());
        assert!(lite.warnings.iter().any(|w| w.contains("SQLite")));
    }

    #[test]
    fn sqlite_rebuild_script_keeps_unique_autoincrement_and_other_columns() {
        let mut id = col("id", "INTEGER");
        id.key = "PRI".into();
        let mut name_old = col("name", "TEXT");
        name_old.nullable = true;
        let mut name_new = col("name", "TEXT");
        name_new.nullable = false;
        let table = TableDiff {
            name: "p".into(),
            status: DiffStatus::Different,
            columns: vec![cdiff("name", DiffStatus::Different, Some(name_new), &["nullable"])],
            target_snapshot: Some(super::super::diff::TargetTableSnapshot {
                columns: vec![id, name_old, col("note", "TEXT")],
                unique_constraints: vec![vec!["note".into()]],
                recreate_sql: vec!["CREATE INDEX i ON p (name);".into()],
                original_sql: Some("CREATE TABLE p (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, note TEXT CHECK (note <> ''))".into()),
                referenced_by: vec!["c (ON DELETE CASCADE)".into()],
                ..Default::default()
            }),
            ..Default::default()
        };
        let d = diff(DriverKind::Sqlite, vec![table]);
        let safe = generate_sync_sql(&d, false);
        assert!(safe.statements.is_empty());
        assert!(safe.warnings.iter().any(|w| w.contains("破壊的")));
        let plan = generate_sync_sql(&d, true);
        assert_eq!(plan.statements.len(), 1);
        let stmt = &plan.statements[0];
        assert_eq!(stmt.kind, SyncKind::RebuildTable);
        assert!(stmt.destructive);
        let sql = &stmt.sql;
        assert!(sql.starts_with("PRAGMA foreign_keys=OFF;\n"));
        assert!(sql.ends_with("PRAGMA foreign_keys=ON;"));
        assert!(sql.contains("\"id\" INTEGER PRIMARY KEY AUTOINCREMENT"));
        assert!(sql.contains("\"name\" TEXT NOT NULL"));
        assert!(sql.contains("UNIQUE (\"note\")"));
        assert!(sql.contains(
            "INSERT INTO \"__noobdb_rebuild_p\" (\"id\", \"name\", \"note\") SELECT \"id\", \"name\", \"note\" FROM \"p\""
        ));
        assert!(
            sql.contains("DROP TABLE \"p\";\nALTER TABLE \"__noobdb_rebuild_p\" RENAME TO \"p\"")
        );
        assert!(sql.contains("CREATE INDEX i ON p (name);"));
        assert!(plan.warnings.iter().any(|w| w.contains("CHECK")));
        assert!(plan
            .warnings
            .iter()
            .any(|w| w.contains("c (ON DELETE CASCADE)")));
    }

    #[test]
    fn mysql_drops_the_foreign_key_before_the_index_that_backs_it() {
        let fk = DiffForeignKey {
            name: Some("fk_t_p".into()),
            columns: vec!["pid".into()],
            referenced_table: "p".into(),
            referenced_columns: vec!["id".into()],
            on_delete: None,
            on_update: None,
        };
        let table = TableDiff {
            name: "t".into(),
            status: DiffStatus::Different,
            fk_changes: vec![super::super::diff::ForeignKeyDiff {
                status: DiffStatus::TargetOnly,
                source: None,
                target: Some(fk),
                changed_fields: vec![],
            }],
            // 外部キーと同名の (外部キーを支える) インデックスも target にだけ在る。
            indexes: vec![idx_diff(
                DiffStatus::TargetOnly,
                None,
                Some(dix("fk_t_p", &["pid"], false)),
            )],
            ..Default::default()
        };
        let plan = generate_sync_sql(&diff(DriverKind::Mysql, vec![table]), true);
        let sqls: Vec<&str> = plan.statements.iter().map(|s| s.sql.as_str()).collect();
        assert_eq!(
            sqls,
            vec![
                "ALTER TABLE `t` DROP FOREIGN KEY `fk_t_p`",
                "DROP INDEX `fk_t_p` ON `t`",
            ]
        );
    }

    #[test]
    fn sqlite_without_destructive_still_adds_columns_when_a_rebuild_is_needed() {
        let mut name_new = col("name", "TEXT");
        name_new.nullable = false;
        let table = TableDiff {
            name: "p".into(),
            status: DiffStatus::Different,
            columns: vec![
                cdiff("name", DiffStatus::Different, Some(name_new), &["nullable"]),
                cdiff(
                    "extra",
                    DiffStatus::SourceOnly,
                    Some(col("extra", "TEXT")),
                    &[],
                ),
            ],
            target_snapshot: Some(super::super::diff::TargetTableSnapshot {
                columns: vec![col("id", "INTEGER"), col("name", "TEXT")],
                ..Default::default()
            }),
            ..Default::default()
        };
        let plan = generate_sync_sql(&diff(DriverKind::Sqlite, vec![table]), false);
        assert!(plan
            .statements
            .iter()
            .any(|s| s.kind == SyncKind::AddColumn && s.sql.contains("\"extra\"")));
        assert!(plan
            .statements
            .iter()
            .all(|s| s.kind != SyncKind::RebuildTable));
        assert!(plan.warnings.iter().any(|w| w.contains("破壊的")));
    }

    #[test]
    fn sqlite_rebuild_skips_definitions_that_reference_a_dropped_column() {
        let mut id = col("id", "INTEGER");
        id.key = "PRI".into();
        let table = TableDiff {
            name: "p".into(),
            status: DiffStatus::Different,
            columns: vec![
                cdiff("old", DiffStatus::TargetOnly, None, &[]),
                cdiff(
                    "name",
                    DiffStatus::Different,
                    Some(col("name", "VARCHAR")),
                    &["data_type"],
                ),
            ],
            indexes: vec![
                idx_diff(
                    DiffStatus::TargetOnly,
                    None,
                    Some(dix("idx_gone", &["name"], false)),
                ),
                idx_diff(
                    DiffStatus::Different,
                    Some(dix("idx_chg", &["name"], true)),
                    Some(dix("idx_chg", &["name"], false)),
                ),
            ],
            target_snapshot: Some(super::super::diff::TargetTableSnapshot {
                columns: vec![id, col("name", "TEXT"), col("old", "TEXT")],
                recreate_sql: vec![
                    "CREATE INDEX idx_old ON p (old)".into(),
                    "CREATE INDEX \"idx_gone\" ON p (name)".into(),
                    "CREATE INDEX idx_chg ON p (name)".into(),
                    "CREATE INDEX idx_keep ON p (id, name)".into(),
                    "CREATE TRIGGER trg AFTER UPDATE ON p BEGIN SELECT old.old; END".into(),
                ],
                ..Default::default()
            }),
            ..Default::default()
        };
        let plan = generate_sync_sql(&diff(DriverKind::Sqlite, vec![table]), true);
        let rebuild = plan
            .statements
            .iter()
            .find(|s| s.kind == SyncKind::RebuildTable)
            .unwrap();
        assert!(rebuild.sql.contains("CREATE INDEX idx_keep"));
        assert!(!rebuild.sql.contains("idx_old"));
        assert!(!rebuild.sql.contains("idx_gone"));
        assert!(!rebuild.sql.contains("CREATE INDEX idx_chg"));
        assert!(!rebuild.sql.contains("TRIGGER trg"));
        // 再作成する表では DROP INDEX を出さず、Different の索引は source の定義で作る。
        assert!(plan
            .statements
            .iter()
            .all(|s| s.kind != SyncKind::DropIndex));
        assert!(plan.statements.iter().any(|s| s.kind == SyncKind::AddIndex
            && s.sql.contains("UNIQUE")
            && s.sql.contains("idx_chg")));
        assert!(plan.warnings.iter().any(|w| w.contains("idx_old")));
    }

    #[test]
    fn index_name_and_identifier_helpers() {
        assert_eq!(
            created_index_name("CREATE UNIQUE INDEX IF NOT EXISTS \"a b\" ON t(x)").as_deref(),
            Some("a b")
        );
        assert_eq!(
            created_index_name("create index i1 on t(x)").as_deref(),
            Some("i1")
        );
        assert_eq!(created_index_name("CREATE TRIGGER x ON t"), None);
        assert!(references_identifier(
            "CREATE INDEX i ON p (\"Old\")",
            "old"
        ));
        assert!(!references_identifier("CREATE INDEX i ON p (older)", "old"));
    }

    #[test]
    fn created_index_name_takes_part_after_last_dot() {
        assert_eq!(
            created_index_name("CREATE INDEX main.idx ON t(x)").as_deref(),
            Some("idx")
        );
        assert_eq!(
            created_index_name("CREATE UNIQUE INDEX IF NOT EXISTS \"main\".\"idx\" ON t(x)")
                .as_deref(),
            Some("idx")
        );
        assert_eq!(
            created_index_name("CREATE INDEX \"a.b\" ON t(x)").as_deref(),
            Some("a.b")
        );
    }

    #[test]
    fn index_tail_ignores_table_name_literals_and_keywords() {
        let tail = index_tail("CREATE UNIQUE INDEX i ON tag (name) WHERE note = 'tag'");
        assert!(!references_identifier(&tail, "tag"));
        assert!(references_identifier(&tail, "name"));
        assert!(references_identifier(&tail, "note"));
        // 条件の文字列リテラルの中は列参照ではない。
        let tail = index_tail("CREATE INDEX i ON p (a) WHERE b = 'x new y'");
        assert!(!references_identifier(&tail, "new"));
        assert!(!references_identifier(&tail, "x"));
        // 引用符つきの表名・ON を含む索引名でも列リストを取り出す。
        let tail = index_tail("CREATE INDEX \"on(x)\" ON \"t(\" (c)");
        assert!(references_identifier(&tail, "c"));
        assert!(!references_identifier(&tail, "x"));
    }

    #[test]
    fn sqlite_rebuild_keeps_unique_index_when_dropped_column_has_table_name() {
        let mut id = col("id", "INTEGER");
        id.key = "PRI".into();
        let table = TableDiff {
            name: "tag".into(),
            status: DiffStatus::Different,
            columns: vec![
                cdiff("tag", DiffStatus::TargetOnly, None, &[]),
                cdiff(
                    "name",
                    DiffStatus::Different,
                    Some(col("name", "VARCHAR")),
                    &["data_type"],
                ),
            ],
            target_snapshot: Some(super::super::diff::TargetTableSnapshot {
                columns: vec![id, col("name", "TEXT"), col("tag", "TEXT")],
                recreate_sql: vec![
                    "CREATE UNIQUE INDEX u_name ON tag (name)".into(),
                    "CREATE UNIQUE INDEX u_tag ON tag (tag)".into(),
                    "CREATE INDEX i_lit ON tag (name) WHERE name <> 'tag'".into(),
                ],
                ..Default::default()
            }),
            ..Default::default()
        };
        let plan = generate_sync_sql(&diff(DriverKind::Sqlite, vec![table]), true);
        let rebuild = plan
            .statements
            .iter()
            .find(|s| s.kind == SyncKind::RebuildTable)
            .unwrap();
        assert!(rebuild.sql.contains("CREATE UNIQUE INDEX u_name"));
        assert!(rebuild.sql.contains("CREATE INDEX i_lit"));
        assert!(!rebuild.sql.contains("u_tag"));
        assert!(plan
            .warnings
            .iter()
            .any(|w| w.contains("u_tag") && w.contains("一意制約")));
    }

    fn ck(name: &str, def: &str) -> CheckConstraintInfo {
        CheckConstraintInfo {
            name: name.to_string(),
            definition: def.to_string(),
        }
    }

    fn gen(column: &str, expr: &str, is_virtual: bool) -> GeneratedColumnInfo {
        GeneratedColumnInfo::new(column, expr, is_virtual)
    }

    fn check_diff(
        status: DiffStatus,
        source: Option<CheckConstraintInfo>,
        target: Option<CheckConstraintInfo>,
    ) -> crate::db::diff::CheckDiff {
        crate::db::diff::CheckDiff {
            name: source
                .as_ref()
                .or(target.as_ref())
                .map(|c| c.name.clone())
                .unwrap_or_default(),
            status,
            source,
            target,
        }
    }

    fn check_table(changes: Vec<crate::db::diff::CheckDiff>) -> TableDiff {
        TableDiff {
            name: "t".to_string(),
            status: DiffStatus::Different,
            check_changes: changes,
            ..Default::default()
        }
    }

    #[test]
    fn mysql_and_postgres_add_check_with_alter_table() {
        let changes = vec![check_diff(
            DiffStatus::SourceOnly,
            Some(ck("a_pos", "CHECK (a > 0)")),
            None,
        )];
        for (driver, expect) in [
            (
                DriverKind::Mysql,
                "ALTER TABLE `t` ADD CONSTRAINT `a_pos` CHECK (a > 0)",
            ),
            (
                DriverKind::Postgres,
                "ALTER TABLE \"t\" ADD CONSTRAINT \"a_pos\" CHECK (a > 0)",
            ),
        ] {
            let plan = generate_sync_sql(&diff(driver, vec![check_table(changes.clone())]), false);
            assert_eq!(plan.statements.len(), 1, "{plan:?}");
            assert_eq!(plan.statements[0].sql, expect);
            assert_eq!(plan.statements[0].kind, SyncKind::AddCheck);
            assert!(!plan.statements[0].destructive);
        }
    }

    #[test]
    fn drop_and_change_check_are_destructive_and_use_driver_syntax() {
        let drop_change = vec![check_diff(
            DiffStatus::TargetOnly,
            None,
            Some(ck("a_pos", "CHECK (a > 0)")),
        )];
        let alter = vec![check_diff(
            DiffStatus::Different,
            Some(ck("a_pos", "CHECK (a > 1)")),
            Some(ck("a_pos", "CHECK (a > 0)")),
        )];
        let no = generate_sync_sql(
            &diff(DriverKind::Mysql, vec![check_table(drop_change.clone())]),
            false,
        );
        assert!(no.statements.is_empty());
        let my = generate_sync_sql(
            &diff(DriverKind::Mysql, vec![check_table(drop_change.clone())]),
            true,
        );
        assert_eq!(my.statements[0].sql, "ALTER TABLE `t` DROP CHECK `a_pos`");
        assert!(my.statements[0].destructive);
        let pg = generate_sync_sql(
            &diff(DriverKind::Postgres, vec![check_table(drop_change)]),
            true,
        );
        assert_eq!(
            pg.statements[0].sql,
            "ALTER TABLE \"t\" DROP CONSTRAINT \"a_pos\""
        );
        // 式の変更は DROP → ADD。DROP が先に並ぶ。
        let both = generate_sync_sql(
            &diff(DriverKind::Mysql, vec![check_table(alter.clone())]),
            true,
        );
        assert_eq!(both.statements.len(), 2);
        assert_eq!(both.statements[0].kind, SyncKind::DropCheck);
        assert_eq!(both.statements[1].kind, SyncKind::AddCheck);
        let warn = generate_sync_sql(&diff(DriverKind::Mysql, vec![check_table(alter)]), false);
        assert!(warn.statements.is_empty());
        assert!(
            warn.warnings.iter().any(|w| w.contains("a_pos")),
            "{warn:?}"
        );
    }

    #[test]
    fn sqlite_check_change_without_rebuild_context_warns() {
        let changes = vec![check_diff(
            DiffStatus::SourceOnly,
            Some(ck("", "CHECK (a > 0)")),
            None,
        )];
        let plan = generate_sync_sql(&diff(DriverKind::Sqlite, vec![check_table(changes)]), true);
        assert!(plan.statements.is_empty(), "{plan:?}");
        assert!(
            plan.warnings.iter().any(|w| w.contains("CHECK")),
            "{plan:?}"
        );
    }

    #[test]
    fn create_table_includes_checks_and_known_generated_columns() {
        let mut a = col("a", "int");
        a.nullable = false;
        let mut g = col("g", "int");
        g.extra = "VIRTUAL GENERATED".to_string();
        let table = TableDiff {
            name: "t".to_string(),
            status: DiffStatus::SourceOnly,
            columns: vec![
                cdiff("a", DiffStatus::SourceOnly, Some(a), &[]),
                cdiff("g", DiffStatus::SourceOnly, Some(g), &[]),
            ],
            check_changes: vec![check_diff(
                DiffStatus::SourceOnly,
                Some(ck("a_pos", "CHECK (`a` > 0)")),
                None,
            )],
            generated_changes: vec![crate::db::diff::GeneratedDiff {
                column: "g".to_string(),
                status: DiffStatus::SourceOnly,
                source: Some(gen("g", "`a` + 1", true)),
                target: None,
                changed_fields: vec![],
            }],
            ..Default::default()
        };
        let plan = generate_sync_sql(&diff(DriverKind::Mysql, vec![table]), false);
        let sql = &plan.statements[0].sql;
        assert!(
            sql.contains("`g` int GENERATED ALWAYS AS (`a` + 1) VIRTUAL"),
            "{sql}"
        );
        assert!(sql.contains("CONSTRAINT `a_pos` CHECK (`a` > 0)"), "{sql}");
        // 式が取れているので「生成列は自動同期の対象外」の警告は出ない。
        assert!(
            plan.warnings
                .iter()
                .all(|w| !w.contains("生成列は自動同期")),
            "{plan:?}"
        );
    }

    #[test]
    fn sqlite_create_table_adds_hidden_generated_columns_from_expressions() {
        let table = TableDiff {
            name: "t".to_string(),
            status: DiffStatus::SourceOnly,
            columns: vec![cdiff(
                "a",
                DiffStatus::SourceOnly,
                Some(col("a", "INT")),
                &[],
            )],
            check_changes: vec![check_diff(
                DiffStatus::SourceOnly,
                Some(ck("", "CHECK (a > 0)")),
                None,
            )],
            generated_changes: vec![crate::db::diff::GeneratedDiff {
                column: "g".to_string(),
                status: DiffStatus::SourceOnly,
                source: Some(gen("g", "a * 2", false)),
                target: None,
                changed_fields: vec![],
            }],
            ..Default::default()
        };
        let plan = generate_sync_sql(&diff(DriverKind::Sqlite, vec![table]), false);
        let sql = &plan.statements[0].sql;
        assert!(
            sql.contains("\"g\" GENERATED ALWAYS AS (a * 2) STORED"),
            "{sql}"
        );
        assert!(sql.contains("\n  CHECK (a > 0)"), "{sql}");
    }

    #[test]
    fn mysql_add_generated_column_uses_expression_and_expression_only_change_warns() {
        let mut g = col("g", "int");
        g.extra = "STORED GENERATED".to_string();
        let add = TableDiff {
            name: "t".to_string(),
            status: DiffStatus::Different,
            columns: vec![cdiff("g", DiffStatus::SourceOnly, Some(g), &[])],
            generated_changes: vec![crate::db::diff::GeneratedDiff {
                column: "g".to_string(),
                status: DiffStatus::SourceOnly,
                source: Some(gen("g", "`a` + 1", false)),
                target: None,
                changed_fields: vec![],
            }],
            ..Default::default()
        };
        let plan = generate_sync_sql(&diff(DriverKind::Mysql, vec![add]), false);
        assert_eq!(
            plan.statements[0].sql,
            "ALTER TABLE `t` ADD COLUMN `g` int GENERATED ALWAYS AS (`a` + 1) STORED"
        );
        let only_expr = TableDiff {
            name: "t".to_string(),
            status: DiffStatus::Different,
            generated_changes: vec![crate::db::diff::GeneratedDiff {
                column: "g".to_string(),
                status: DiffStatus::Different,
                source: Some(gen("g", "a + 1", false)),
                target: Some(gen("g", "a + 2", false)),
                changed_fields: vec!["expression".to_string()],
            }],
            ..Default::default()
        };
        let plan = generate_sync_sql(&diff(DriverKind::Mysql, vec![only_expr]), false);
        assert!(plan.statements.is_empty());
        assert!(
            plan.warnings
                .iter()
                .any(|w| w.contains("a + 1") && w.contains("a + 2")),
            "{plan:?}"
        );
    }

    #[test]
    fn sqlite_rebuild_carries_checks_and_generated_with_changes_applied() {
        use crate::db::diff::TargetTableSnapshot;
        let mut a = col("a", "INTEGER");
        a.key = "PRI".to_string();
        let table = TableDiff {
            name: "t".to_string(),
            status: DiffStatus::Different,
            check_changes: vec![
                check_diff(DiffStatus::TargetOnly, None, Some(ck("", "CHECK (a < 0)"))),
                check_diff(
                    DiffStatus::SourceOnly,
                    Some(ck("a_pos", "CHECK (a > 0)")),
                    None,
                ),
            ],
            generated_changes: vec![crate::db::diff::GeneratedDiff {
                column: "g".to_string(),
                status: DiffStatus::Different,
                source: Some(gen("g", "a * 3", false)),
                target: Some(gen("g", "a * 2", false)),
                changed_fields: vec!["expression".to_string()],
            }],
            target_snapshot: Some(TargetTableSnapshot {
                columns: vec![a],
                original_sql: Some(
                    "CREATE TABLE t (a INTEGER PRIMARY KEY CHECK (a < 0), g AS (a * 2) STORED)"
                        .into(),
                ),
                checks: vec![ck("", "CHECK (a < 0)"), ck("keep", "CHECK (a <> 5)")],
                generated: vec![gen("g", "a * 2", false)],
                extras_known: true,
                ..Default::default()
            }),
            ..Default::default()
        };
        let plan = generate_sync_sql(&diff(DriverKind::Sqlite, vec![table]), true);
        let sql = &plan.statements[0].sql;
        assert_eq!(plan.statements[0].kind, SyncKind::RebuildTable);
        assert!(sql.contains("CONSTRAINT \"a_pos\" CHECK (a > 0)"), "{sql}");
        assert!(sql.contains("CONSTRAINT \"keep\" CHECK (a <> 5)"), "{sql}");
        assert!(!sql.contains("CHECK (a < 0)"), "{sql}");
        assert!(
            sql.contains("\"g\" GENERATED ALWAYS AS (a * 3) STORED"),
            "{sql}"
        );
        assert!(!sql.contains("a * 2"), "{sql}");
        // 列定義は表制約 (PRIMARY KEY / CHECK) より前。
        let gpos = sql.find("GENERATED ALWAYS").expect("generated");
        assert!(gpos < sql.find("PRIMARY KEY (").expect("pk"), "{sql}");
        assert!(gpos < sql.find("CHECK (a > 0)").expect("check"), "{sql}");
        // 再現できたので「CHECK / 生成列が含まれない」警告は出ない。
        assert!(
            plan.warnings
                .iter()
                .all(|w| !w.contains("CHECK 制約 /") && !w.contains("生成列 /")),
            "{plan:?}"
        );
    }

    #[test]
    fn hidden_generated_columns_keep_type_not_null_and_position() {
        let mut g = gen("total", "price * qty", false);
        g.data_type = Some("REAL".to_string());
        g.not_null = true;
        g.position = Some(1);
        let lines = interleave_hidden_generated(
            DriverKind::Sqlite,
            vec!["\"id\" INTEGER".to_string(), "\"note\" TEXT".to_string()],
            &[&g],
        );
        assert_eq!(
            lines,
            vec![
                "\"id\" INTEGER",
                "\"total\" REAL GENERATED ALWAYS AS (price * qty) STORED NOT NULL",
                "\"note\" TEXT",
            ]
        );
        // 位置が無ければ末尾。
        g.position = None;
        let lines =
            interleave_hidden_generated(DriverKind::Sqlite, vec!["\"id\" INTEGER".into()], &[&g]);
        assert_eq!(lines.len(), 2);
        assert!(lines[1].starts_with("\"total\" REAL"));
    }
}

#[cfg(test)]
mod object_sync_tests {
    use super::*;
    use crate::db::diff::TableDiff;
    use crate::db::object_diff::{ObjectComparison, ObjectDiff};

    fn obj(kind: &str, name: &str, status: DiffStatus, src: Option<&str>) -> ObjectDiff {
        ObjectDiff {
            kind: kind.into(),
            name: name.into(),
            signature: None,
            table: None,
            status,
            source_definition: src.map(str::to_string),
            target_definition: (status == DiffStatus::TargetOnly
                || status == DiffStatus::Different)
                .then(|| "CREATE ... (target)".to_string()),
        }
    }

    fn diff(driver: DriverKind, tables: Vec<TableDiff>, items: Vec<ObjectDiff>) -> SchemaDiff {
        SchemaDiff {
            source_driver: driver,
            target_driver: driver,
            tables,
            warnings: Vec::new(),
            indexes_compared: true,
            objects: ObjectComparison {
                compared: true,
                items,
                unsupported_kinds: Vec::new(),
            },
        }
    }

    fn kinds(plan: &SyncPlan) -> Vec<SyncKind> {
        plan.statements.iter().map(|s| s.kind).collect()
    }

    #[test]
    fn mysql_creates_views_and_replaces_views_atomically() {
        let d = diff(
            DriverKind::Mysql,
            vec![],
            vec![
                obj(
                    "view",
                    "v_new",
                    DiffStatus::SourceOnly,
                    Some("CREATE VIEW `v_new` AS select 1"),
                ),
                obj(
                    "view",
                    "v_chg",
                    DiffStatus::Different,
                    Some("CREATE VIEW `v_chg` AS select 2"),
                ),
            ],
        );
        let plan = generate_sync_sql(&d, false);
        assert_eq!(
            kinds(&plan),
            vec![SyncKind::CreateObject, SyncKind::ReplaceObject]
        );
        assert_eq!(plan.statements[0].sql, "CREATE VIEW `v_new` AS select 1");
        assert_eq!(
            plan.statements[1].sql,
            "CREATE OR REPLACE VIEW `v_chg` AS select 2"
        );
        assert!(plan.statements.iter().all(|s| !s.destructive));
    }

    #[test]
    fn mysql_routine_replace_needs_destructive_and_warns_otherwise() {
        let d = diff(
            DriverKind::Mysql,
            vec![],
            vec![obj(
                "procedure",
                "p",
                DiffStatus::Different,
                Some("CREATE PROCEDURE `p`() SELECT 1"),
            )],
        );
        let off = generate_sync_sql(&d, false);
        assert!(off.statements.is_empty());
        assert!(
            off.warnings.iter().any(|w| w.contains("procedure p")),
            "{:?}",
            off.warnings
        );
        let on = generate_sync_sql(&d, true);
        assert_eq!(on.statements.len(), 1);
        assert!(on.statements[0].destructive);
        assert_eq!(
            on.statements[0].sql,
            "DROP PROCEDURE `p`;\nCREATE PROCEDURE `p`() SELECT 1"
        );
    }

    #[test]
    fn target_only_objects_are_dropped_only_when_destructive_is_allowed() {
        let d = diff(
            DriverKind::Sqlite,
            vec![],
            vec![
                obj("trigger", "t_old", DiffStatus::TargetOnly, None),
                obj("view", "v_old", DiffStatus::TargetOnly, None),
            ],
        );
        assert!(generate_sync_sql(&d, false).statements.is_empty());
        let plan = generate_sync_sql(&d, true);
        // 依存の逆順: トリガー → ビュー。
        let sqls: Vec<&str> = plan.statements.iter().map(|s| s.sql.as_str()).collect();
        assert_eq!(sqls, vec!["DROP TRIGGER \"t_old\"", "DROP VIEW \"v_old\""]);
        assert!(plan
            .statements
            .iter()
            .all(|s| s.destructive && s.kind == SyncKind::DropObject));
    }

    #[test]
    fn objects_are_placed_after_table_creation_and_before_table_drops() {
        let tables = vec![
            TableDiff {
                name: "new_t".into(),
                status: DiffStatus::SourceOnly,
                columns: vec![crate::db::diff::ColumnDiff {
                    name: "id".into(),
                    status: DiffStatus::SourceOnly,
                    source: Some(TableColumnInfo {
                        name: "id".into(),
                        data_type: "int".into(),
                        nullable: false,
                        key: String::new(),
                        default: None,
                        extra: String::new(),
                        referenced_table: None,
                        referenced_column: None,
                        comment: None,
                    }),
                    target: None,
                    changed_fields: vec![],
                }],
                ..Default::default()
            },
            TableDiff {
                name: "old_t".into(),
                status: DiffStatus::TargetOnly,
                ..Default::default()
            },
        ];
        let d = diff(
            DriverKind::Postgres,
            tables,
            vec![
                obj(
                    "view",
                    "v",
                    DiffStatus::SourceOnly,
                    Some("CREATE VIEW \"v\" AS\nSELECT id FROM new_t"),
                ),
                obj("trigger", "trg", DiffStatus::TargetOnly, None),
                obj(
                    "sequence",
                    "seq",
                    DiffStatus::SourceOnly,
                    Some("CREATE SEQUENCE \"seq\" AS bigint"),
                ),
            ],
        );
        let plan = generate_sync_sql(&d, true);
        assert_eq!(
            kinds(&plan),
            vec![
                SyncKind::CreateObject, // sequence は表より先
                SyncKind::CreateTable,
                SyncKind::CreateObject, // view
                SyncKind::DropObject,   // trigger
                SyncKind::DropTable,
            ]
        );
        assert!(plan.statements[0].sql.starts_with("CREATE SEQUENCE"));
    }

    #[test]
    fn postgres_replace_uses_single_statement_forms() {
        let mut f = obj(
            "function",
            "f",
            DiffStatus::Different,
            Some("CREATE OR REPLACE FUNCTION f() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql"),
        );
        f.signature = Some(String::new());
        let d = diff(
            DriverKind::Postgres,
            vec![],
            vec![
                f,
                obj(
                    "sequence",
                    "s",
                    DiffStatus::Different,
                    Some("CREATE SEQUENCE \"s\" AS bigint INCREMENT BY 5"),
                ),
                obj(
                    "view",
                    "v",
                    DiffStatus::Different,
                    Some("CREATE VIEW \"v\" AS\nSELECT 2"),
                ),
            ],
        );
        let plan = generate_sync_sql(&d, false);
        assert_eq!(plan.statements.len(), 3);
        for s in &plan.statements {
            assert_eq!(s.kind, SyncKind::ReplaceObject);
            assert!(!s.destructive, "{}", s.sql);
        }
        let sqls: Vec<&str> = plan.statements.iter().map(|s| s.sql.as_str()).collect();
        assert!(sqls
            .iter()
            .any(|s| s.starts_with("CREATE OR REPLACE FUNCTION f()")));
        assert!(sqls.contains(&"ALTER SEQUENCE \"s\" AS bigint INCREMENT BY 5"));
        assert!(sqls.iter().any(|s| s.starts_with("DO $noobdb$")));
    }

    #[test]
    fn same_objects_produce_no_statements() {
        let d = diff(
            DriverKind::Sqlite,
            vec![],
            vec![obj("view", "v", DiffStatus::Same, None)],
        );
        assert!(generate_sync_sql(&d, true).statements.is_empty());
    }
}
