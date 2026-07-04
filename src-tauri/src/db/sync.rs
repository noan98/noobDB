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

use serde::{Deserialize, Serialize};

use super::diff::{DiffStatus, SchemaDiff, TableDiff};
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
            SyncKind::DropColumn => 3,
            SyncKind::DropTable => 4,
            SyncKind::InsertRow => 5,
            SyncKind::UpdateRow => 6,
            SyncKind::DeleteRow => 7,
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

    for table in &diff.tables {
        match table.status {
            DiffStatus::Same => {}
            DiffStatus::SourceOnly => {
                statements.push(create_table_stmt(driver, table));
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
        a.kind
            .order()
            .cmp(&b.kind.order())
            .then(a.table.cmp(&b.table))
    });

    SyncPlan {
        statements,
        warnings,
    }
}

/// Builds the `CREATE TABLE` for a source-only table from its source-side
/// column definitions, appending a `PRIMARY KEY (...)` clause for any columns
/// flagged `PRI`.
fn create_table_stmt(driver: DriverKind, table: &TableDiff) -> SyncStatement {
    let cols: Vec<&TableColumnInfo> = table
        .columns
        .iter()
        .filter_map(|c| c.source.as_ref())
        .collect();

    let mut lines: Vec<String> = cols.iter().map(|c| column_def(driver, c)).collect();

    let pk: Vec<String> = cols
        .iter()
        .filter(|c| c.key.eq_ignore_ascii_case("PRI"))
        .map(|c| quote_ident(driver, &c.name))
        .collect();
    if !pk.is_empty() {
        lines.push(format!("PRIMARY KEY ({})", pk.join(", ")));
    }

    let sql = format!(
        "CREATE TABLE {} (\n  {}\n)",
        quote_ident(driver, &table.name),
        lines.join(",\n  ")
    );
    SyncStatement {
        sql,
        table: table.name.clone(),
        kind: SyncKind::CreateTable,
        destructive: false,
    }
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
                // Only `extra` differed (PostgreSQL leaves it empty), nothing to do.
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
/// `auto_increment`) is MySQL-only.
fn column_def(driver: DriverKind, col: &TableColumnInfo) -> String {
    let mut def = format!("{} {}", quote_ident(driver, &col.name), col.data_type);
    if !col.nullable {
        def.push_str(" NOT NULL");
    }
    if let Some(clause) = default_clause(driver, col) {
        def.push(' ');
        def.push_str(&clause);
    }
    if driver == DriverKind::Mysql && !col.extra.is_empty() {
        def.push(' ');
        def.push_str(&col.extra);
    }
    def
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
///   出す。
/// - 文字列系の型 (`char`/`varchar`/`*text`/`enum`/`set`。長さ付きも判定可)
///   はクオートし直す — 空文字も `DEFAULT ''` として (消さずに) 出力する。
/// - それ以外 (数値・真偽値・日時のキーワードデフォルトなど) は従来どおり
///   逐語で出す。
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
fn is_mysql_string_default_type(data_type: &str) -> bool {
    const STRING_PREFIXES: [&str; 7] = [
        "char",
        "varchar",
        "tinytext",
        "mediumtext",
        "longtext",
        "text",
        "enum",
    ];
    let lower = data_type.to_ascii_lowercase();
    // "set('a','b')" も文字列扱い。
    lower.starts_with("set") || STRING_PREFIXES.iter().any(|p| lower.starts_with(p))
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
        DriverKind::Postgres | DriverKind::Sqlite => format!("\"{}\"", name.replace('"', "\"\"")),
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

    #[test]
    fn destructive_statements_gated_by_flag() {
        let table = TableDiff {
            name: "stale".to_string(),
            status: DiffStatus::TargetOnly,
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
            columns: vec![],
        };
        let plan = generate_sync_sql(&diff(DriverKind::Mysql, vec![table]), true);
        assert!(plan.statements.is_empty());
        assert!(plan.warnings.is_empty());
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
}
