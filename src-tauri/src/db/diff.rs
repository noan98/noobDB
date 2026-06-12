//! Schema comparison.
//!
//! Pure, driver-agnostic diffing of two schemas, each expressed as the table /
//! column metadata the introspection layer already produces (`TableColumnInfo`).
//! The command layer (`commands::diff`) fetches both sides from live sessions
//! and feeds them here; keeping the computation pure makes it unit-testable
//! without a database.
//!
//! This module is comparison / visualisation only: it classifies every table
//! and column as source-only, target-only, differing, or identical. Generating
//! the reconciling DDL is intentionally out of scope (see `super::sync`).

use serde::{Deserialize, Serialize};

use super::types::TableColumnInfo;
use super::DriverKind;

/// Where a table or column sits relative to the two schemas being compared.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiffStatus {
    /// Present only in the source schema (would be added to the target).
    SourceOnly,
    /// Present only in the target schema (would be removed from the target).
    TargetOnly,
    /// Present in both, but the definitions differ.
    Different,
    /// Present in both with identical definitions.
    Same,
}

/// One table paired with its full column metadata — the collected shape of one
/// side of the comparison. Built by the command layer from `Connection::tables`
/// + `Connection::columns`.
#[derive(Debug, Clone)]
pub struct TableColumns {
    pub name: String,
    pub columns: Vec<TableColumnInfo>,
}

/// Difference of a single column between the two schemas.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColumnDiff {
    pub name: String,
    pub status: DiffStatus,
    /// The source-side definition, when the column exists there.
    pub source: Option<TableColumnInfo>,
    /// The target-side definition, when the column exists there.
    pub target: Option<TableColumnInfo>,
    /// For `Different`, the attribute names that differ
    /// (`data_type` / `nullable` / `default` / `key` / `extra` /
    /// `foreign_key`). Empty for every other status.
    pub changed_fields: Vec<String>,
}

/// Difference of a single table between the two schemas.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableDiff {
    pub name: String,
    pub status: DiffStatus,
    /// Column-level diffs. For a `SourceOnly` / `TargetOnly` table every column
    /// is listed with that same one-sided status so the UI can render the full
    /// shape. For a table present on both sides only the columns that actually
    /// differ (added / removed / changed) are listed — identical columns are
    /// omitted to keep the diff focused. For a `Same` table this is empty.
    pub columns: Vec<ColumnDiff>,
}

/// The full result of comparing a source schema against a target schema. Tables
/// are sorted by name and include identical (`Same`) tables so the UI can show
/// a complete classification overview, not only the differences.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchemaDiff {
    pub source_driver: DriverKind,
    pub target_driver: DriverKind,
    pub tables: Vec<TableDiff>,
}

/// Compares `source` against `target`, classifying every table and (for tables
/// present on both sides) every column. The result lists tables sorted by name.
///
/// Table and column names are matched case-sensitively: within a single driver
/// the introspection layer reports names consistently, and treating a rename or
/// case change as add+remove is the safe, predictable behaviour for a diff.
pub fn compute_schema_diff(
    source_driver: DriverKind,
    target_driver: DriverKind,
    source: &[TableColumns],
    target: &[TableColumns],
) -> SchemaDiff {
    let names = sorted_union(
        source.iter().map(|t| t.name.as_str()),
        target.iter().map(|t| t.name.as_str()),
    );

    let tables = names
        .into_iter()
        .map(|name| {
            let src = source.iter().find(|t| t.name == name);
            let tgt = target.iter().find(|t| t.name == name);
            match (src, tgt) {
                (Some(s), None) => TableDiff {
                    name,
                    status: DiffStatus::SourceOnly,
                    columns: one_sided_columns(&s.columns, DiffStatus::SourceOnly),
                },
                (None, Some(t)) => TableDiff {
                    name,
                    status: DiffStatus::TargetOnly,
                    columns: one_sided_columns(&t.columns, DiffStatus::TargetOnly),
                },
                (Some(s), Some(t)) => {
                    let columns = diff_columns(&s.columns, &t.columns);
                    let status = if columns.is_empty() {
                        DiffStatus::Same
                    } else {
                        DiffStatus::Different
                    };
                    TableDiff {
                        name,
                        status,
                        columns,
                    }
                }
                // `names` is the union of the two sides, so at least one is Some.
                (None, None) => unreachable!(),
            }
        })
        .collect();

    SchemaDiff {
        source_driver,
        target_driver,
        tables,
    }
}

/// Builds a one-sided column list (every column reported with `status`), used
/// for a table that exists on only one side.
fn one_sided_columns(columns: &[TableColumnInfo], status: DiffStatus) -> Vec<ColumnDiff> {
    columns
        .iter()
        .map(|c| {
            let (source, target) = match status {
                DiffStatus::SourceOnly => (Some(c.clone()), None),
                DiffStatus::TargetOnly => (None, Some(c.clone())),
                _ => (Some(c.clone()), Some(c.clone())),
            };
            ColumnDiff {
                name: c.name.clone(),
                status,
                source,
                target,
                changed_fields: Vec::new(),
            }
        })
        .collect()
}

/// Diffs the columns of a table present on both sides. Only non-identical
/// columns are returned (added / removed / changed); identical columns are
/// omitted. Result is sorted by column name.
fn diff_columns(source: &[TableColumnInfo], target: &[TableColumnInfo]) -> Vec<ColumnDiff> {
    let names = sorted_union(
        source.iter().map(|c| c.name.as_str()),
        target.iter().map(|c| c.name.as_str()),
    );

    let mut out = Vec::new();
    for name in names {
        let src = source.iter().find(|c| c.name == name);
        let tgt = target.iter().find(|c| c.name == name);
        match (src, tgt) {
            (Some(s), None) => out.push(ColumnDiff {
                name,
                status: DiffStatus::SourceOnly,
                source: Some(s.clone()),
                target: None,
                changed_fields: Vec::new(),
            }),
            (None, Some(t)) => out.push(ColumnDiff {
                name,
                status: DiffStatus::TargetOnly,
                source: None,
                target: Some(t.clone()),
                changed_fields: Vec::new(),
            }),
            (Some(s), Some(t)) => {
                let changed = changed_fields(s, t);
                if !changed.is_empty() {
                    out.push(ColumnDiff {
                        name,
                        status: DiffStatus::Different,
                        source: Some(s.clone()),
                        target: Some(t.clone()),
                        changed_fields: changed,
                    });
                }
            }
            (None, None) => unreachable!(),
        }
    }
    out
}

/// Lists which attributes differ between two same-named columns. Type/key/extra
/// comparisons are case-insensitive (drivers may report e.g. `INT` vs `int`);
/// `default` is compared exactly since a default value is significant verbatim.
fn changed_fields(s: &TableColumnInfo, t: &TableColumnInfo) -> Vec<String> {
    let mut fields = Vec::new();
    if !s.data_type.eq_ignore_ascii_case(&t.data_type) {
        fields.push("data_type".to_string());
    }
    if s.nullable != t.nullable {
        fields.push("nullable".to_string());
    }
    if s.default != t.default {
        fields.push("default".to_string());
    }
    if !s.key.eq_ignore_ascii_case(&t.key) {
        fields.push("key".to_string());
    }
    if !s.extra.eq_ignore_ascii_case(&t.extra) {
        fields.push("extra".to_string());
    }
    if !opt_eq_ignore_case(&s.referenced_table, &t.referenced_table)
        || !opt_eq_ignore_case(&s.referenced_column, &t.referenced_column)
    {
        fields.push("foreign_key".to_string());
    }
    fields
}

fn opt_eq_ignore_case(a: &Option<String>, b: &Option<String>) -> bool {
    match (a, b) {
        (Some(x), Some(y)) => x.eq_ignore_ascii_case(y),
        (None, None) => true,
        _ => false,
    }
}

/// Sorted, de-duplicated union of two name iterators.
fn sorted_union<'a>(
    a: impl Iterator<Item = &'a str>,
    b: impl Iterator<Item = &'a str>,
) -> Vec<String> {
    let mut names: Vec<String> = a.chain(b).map(|s| s.to_string()).collect();
    names.sort();
    names.dedup();
    names
}

#[cfg(test)]
mod tests {
    use super::*;

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

    fn table(name: &str, columns: Vec<TableColumnInfo>) -> TableColumns {
        TableColumns {
            name: name.to_string(),
            columns,
        }
    }

    fn diff(source: &[TableColumns], target: &[TableColumns]) -> SchemaDiff {
        compute_schema_diff(DriverKind::Mysql, DriverKind::Mysql, source, target)
    }

    #[test]
    fn identical_schemas_report_all_same_with_no_column_diffs() {
        let s = vec![table(
            "users",
            vec![col("id", "int"), col("name", "varchar(50)")],
        )];
        let t = vec![table(
            "users",
            vec![col("id", "int"), col("name", "varchar(50)")],
        )];
        let d = diff(&s, &t);
        assert_eq!(d.tables.len(), 1);
        assert_eq!(d.tables[0].status, DiffStatus::Same);
        assert!(d.tables[0].columns.is_empty());
    }

    #[test]
    fn source_only_table_lists_all_columns_as_source_only() {
        let s = vec![table("only_src", vec![col("a", "int"), col("b", "text")])];
        let t = vec![];
        let d = diff(&s, &t);
        assert_eq!(d.tables.len(), 1);
        assert_eq!(d.tables[0].status, DiffStatus::SourceOnly);
        assert_eq!(d.tables[0].columns.len(), 2);
        assert!(d.tables[0]
            .columns
            .iter()
            .all(|c| c.status == DiffStatus::SourceOnly
                && c.source.is_some()
                && c.target.is_none()));
    }

    #[test]
    fn target_only_table_lists_all_columns_as_target_only() {
        let s = vec![];
        let t = vec![table("only_tgt", vec![col("a", "int")])];
        let d = diff(&s, &t);
        assert_eq!(d.tables[0].status, DiffStatus::TargetOnly);
        assert_eq!(d.tables[0].columns[0].status, DiffStatus::TargetOnly);
        assert!(d.tables[0].columns[0].source.is_none());
        assert!(d.tables[0].columns[0].target.is_some());
    }

    #[test]
    fn added_and_removed_columns_are_classified() {
        let s = vec![table("t", vec![col("id", "int"), col("only_src", "int")])];
        let t = vec![table("t", vec![col("id", "int"), col("only_tgt", "int")])];
        let d = diff(&s, &t);
        assert_eq!(d.tables[0].status, DiffStatus::Different);
        // Only the two differing columns appear; the identical `id` is omitted.
        assert_eq!(d.tables[0].columns.len(), 2);
        // Sorted by name: only_src, only_tgt.
        assert_eq!(d.tables[0].columns[0].name, "only_src");
        assert_eq!(d.tables[0].columns[0].status, DiffStatus::SourceOnly);
        assert_eq!(d.tables[0].columns[1].name, "only_tgt");
        assert_eq!(d.tables[0].columns[1].status, DiffStatus::TargetOnly);
    }

    #[test]
    fn changed_column_reports_each_differing_field() {
        let mut s_col = col("v", "int");
        s_col.nullable = true;
        s_col.default = Some("0".to_string());
        let mut t_col = col("v", "bigint");
        t_col.nullable = false;
        t_col.default = Some("1".to_string());
        let s = vec![table("t", vec![s_col])];
        let t = vec![table("t", vec![t_col])];
        let d = diff(&s, &t);
        let cd = &d.tables[0].columns[0];
        assert_eq!(cd.status, DiffStatus::Different);
        assert!(cd.changed_fields.contains(&"data_type".to_string()));
        assert!(cd.changed_fields.contains(&"nullable".to_string()));
        assert!(cd.changed_fields.contains(&"default".to_string()));
    }

    #[test]
    fn data_type_and_key_comparison_is_case_insensitive() {
        let mut s_col = col("id", "INT");
        s_col.key = "PRI".to_string();
        let mut t_col = col("id", "int");
        t_col.key = "pri".to_string();
        let s = vec![table("t", vec![s_col])];
        let t = vec![table("t", vec![t_col])];
        let d = diff(&s, &t);
        assert_eq!(d.tables[0].status, DiffStatus::Same);
    }

    #[test]
    fn foreign_key_change_is_detected() {
        let mut s_col = col("user_id", "int");
        s_col.referenced_table = Some("users".to_string());
        s_col.referenced_column = Some("id".to_string());
        let t_col = col("user_id", "int"); // no FK
        let s = vec![table("t", vec![s_col])];
        let t = vec![table("t", vec![t_col])];
        let d = diff(&s, &t);
        let cd = &d.tables[0].columns[0];
        assert_eq!(cd.status, DiffStatus::Different);
        assert_eq!(cd.changed_fields, vec!["foreign_key".to_string()]);
    }

    #[test]
    fn tables_are_sorted_and_union_is_deduplicated() {
        let s = vec![
            table("b", vec![col("x", "int")]),
            table("a", vec![col("x", "int")]),
        ];
        let t = vec![
            table("c", vec![col("x", "int")]),
            table("a", vec![col("x", "int")]),
        ];
        let d = diff(&s, &t);
        let names: Vec<&str> = d.tables.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(names, vec!["a", "b", "c"]);
        assert_eq!(d.tables[0].status, DiffStatus::Same); // a present both, identical
        assert_eq!(d.tables[1].status, DiffStatus::SourceOnly); // b
        assert_eq!(d.tables[2].status, DiffStatus::TargetOnly); // c
    }

    #[test]
    fn drivers_are_carried_through() {
        let d = compute_schema_diff(DriverKind::Postgres, DriverKind::Postgres, &[], &[]);
        assert_eq!(d.source_driver, DriverKind::Postgres);
        assert_eq!(d.target_driver, DriverKind::Postgres);
        assert!(d.tables.is_empty());
    }
}
