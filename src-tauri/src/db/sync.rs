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
/// [extra]`). `data_type` and `default` come verbatim from introspection;
/// `extra` (e.g. `auto_increment`) is MySQL-only.
fn column_def(driver: DriverKind, col: &TableColumnInfo) -> String {
    let mut def = format!("{} {}", quote_ident(driver, &col.name), col.data_type);
    if !col.nullable {
        def.push_str(" NOT NULL");
    }
    if let Some(d) = &col.default {
        if !d.is_empty() {
            def.push_str(&format!(" DEFAULT {d}"));
        }
    }
    if driver == DriverKind::Mysql && !col.extra.is_empty() {
        def.push(' ');
        def.push_str(&col.extra);
    }
    def
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
}
