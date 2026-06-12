//! Data comparison & sync — row diffing and DML generation.
//!
//! Pairs the rows of one table on two connections by primary key and classifies
//! each as source-only (→ `INSERT`), target-only (→ `DELETE`), or present on
//! both with differing non-key columns (→ `UPDATE`). The reconciling DML is
//! rendered as text (reusing [`SyncPlan`](super::sync::SyncPlan)) so it can be
//! previewed before applying.
//!
//! Aimed at master / configuration data, not bulk tables: the command layer
//! caps the rows it reads, and a table without a primary key is rejected since
//! there is nothing to pair on.
//!
//! Safety mirrors the schema sync: `DELETE` is emitted only when `allow_delete` is set,
//! and literals are escaped per driver (see [`sql_literal`]) so a value can
//! never break out of its quotes.

use serde::{Deserialize, Serialize};

use super::sync::{quote_ident, SyncKind, SyncPlan, SyncStatement};
use super::types::Value;
use super::DriverKind;

/// Where a row sits relative to the two tables. Identical rows are not stored.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RowStatus {
    SourceOnly,
    TargetOnly,
    Different,
}

/// One row-level difference. `key` carries the primary-key values that pair the
/// two sides; `source` / `target` hold the full rows where present.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RowDiff {
    pub status: RowStatus,
    pub key: Vec<Value>,
    pub source: Option<Vec<Value>>,
    pub target: Option<Vec<Value>>,
    /// For `Different`, the names of the non-key columns whose values differ.
    pub changed_columns: Vec<String>,
}

/// Result of comparing one table's rows across the two connections.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DataDiff {
    pub target_driver: DriverKind,
    pub table: String,
    /// All compared columns, in select order.
    pub columns: Vec<String>,
    /// Primary-key column names (a subset of `columns`).
    pub primary_key: Vec<String>,
    pub rows: Vec<RowDiff>,
    /// True if either side hit the row cap, so the diff is partial.
    pub truncated: bool,
    pub source_count: usize,
    pub target_count: usize,
}

/// Pairs `source` and `target` rows by their primary-key columns and returns
/// the non-identical rows. `pk_idx` lists the positions of the PK columns
/// within each row (which is laid out as `columns`).
///
/// Rows are matched on a tagged signature of their key values, so an integer
/// `1` never collides with the string `"1"`. Source order is preserved for
/// inserts / updates; target-only rows follow in target order.
pub fn compute_data_diff(
    columns: &[String],
    pk_idx: &[usize],
    source: &[Vec<Value>],
    target: &[Vec<Value>],
) -> Vec<RowDiff> {
    use std::collections::HashMap;

    let key_of = |row: &[Value]| -> Vec<Value> { pk_idx.iter().map(|&i| row[i].clone()).collect() };
    let sig = |key: &[Value]| -> String {
        key.iter()
            .map(|v| format!("{v:?}"))
            .collect::<Vec<_>>()
            .join("\u{1f}")
    };

    let mut target_by_sig: HashMap<String, &Vec<Value>> = HashMap::with_capacity(target.len());
    for row in target {
        target_by_sig.insert(sig(&key_of(row)), row);
    }

    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut out: Vec<RowDiff> = Vec::new();

    for s_row in source {
        let key = key_of(s_row);
        let s = sig(&key);
        match target_by_sig.get(&s) {
            Some(t_row) => {
                seen.insert(s);
                let changed = changed_columns(columns, pk_idx, s_row, t_row);
                if !changed.is_empty() {
                    out.push(RowDiff {
                        status: RowStatus::Different,
                        key,
                        source: Some(s_row.clone()),
                        target: Some((*t_row).clone()),
                        changed_columns: changed,
                    });
                }
            }
            None => out.push(RowDiff {
                status: RowStatus::SourceOnly,
                key,
                source: Some(s_row.clone()),
                target: None,
                changed_columns: Vec::new(),
            }),
        }
    }

    for t_row in target {
        let key = key_of(t_row);
        if seen.contains(&sig(&key)) {
            continue;
        }
        out.push(RowDiff {
            status: RowStatus::TargetOnly,
            key,
            source: None,
            target: Some(t_row.clone()),
            changed_columns: Vec::new(),
        });
    }

    out
}

/// Names of the non-key columns whose values differ between two paired rows.
fn changed_columns(
    columns: &[String],
    pk_idx: &[usize],
    source: &[Value],
    target: &[Value],
) -> Vec<String> {
    let mut changed = Vec::new();
    for (i, name) in columns.iter().enumerate() {
        if pk_idx.contains(&i) {
            continue;
        }
        if source.get(i) != target.get(i) {
            changed.push(name.clone());
        }
    }
    changed
}

/// Renders the DML that makes the target table's rows match the source's.
/// `INSERT`s come first, then `UPDATE`s, then `DELETE`s; `DELETE`s appear only
/// when `allow_delete` is set.
pub fn generate_data_sync_sql(diff: &DataDiff, allow_delete: bool) -> SyncPlan {
    let driver = diff.target_driver;
    let table_ident = quote_ident(driver, &diff.table);
    let mut statements: Vec<SyncStatement> = Vec::new();

    for row in &diff.rows {
        match row.status {
            RowStatus::SourceOnly => {
                if let Some(values) = &row.source {
                    statements.push(SyncStatement {
                        sql: insert_sql(driver, &table_ident, &diff.columns, values),
                        table: diff.table.clone(),
                        kind: SyncKind::InsertRow,
                        destructive: false,
                    });
                }
            }
            RowStatus::Different => {
                if let Some(values) = &row.source {
                    if let Some(sql) = update_sql(
                        driver,
                        &table_ident,
                        &diff.columns,
                        &diff.primary_key,
                        &row.changed_columns,
                        values,
                        &row.key,
                    ) {
                        statements.push(SyncStatement {
                            sql,
                            table: diff.table.clone(),
                            kind: SyncKind::UpdateRow,
                            destructive: false,
                        });
                    }
                }
            }
            RowStatus::TargetOnly => {
                if allow_delete {
                    statements.push(SyncStatement {
                        sql: delete_sql(driver, &table_ident, &diff.primary_key, &row.key),
                        table: diff.table.clone(),
                        kind: SyncKind::DeleteRow,
                        destructive: true,
                    });
                }
            }
        }
    }

    statements.sort_by_key(|s| s.kind.order());
    SyncPlan {
        statements,
        warnings: Vec::new(),
    }
}

fn insert_sql(
    driver: DriverKind,
    table_ident: &str,
    columns: &[String],
    values: &[Value],
) -> String {
    let cols = columns
        .iter()
        .map(|c| quote_ident(driver, c))
        .collect::<Vec<_>>()
        .join(", ");
    let vals = values
        .iter()
        .map(|v| sql_literal(driver, v))
        .collect::<Vec<_>>()
        .join(", ");
    format!("INSERT INTO {table_ident} ({cols}) VALUES ({vals})")
}

/// `UPDATE` setting only the changed columns, keyed on the primary key. Returns
/// `None` if there is nothing to set (shouldn't happen for a `Different` row).
fn update_sql(
    driver: DriverKind,
    table_ident: &str,
    columns: &[String],
    primary_key: &[String],
    changed: &[String],
    source_values: &[Value],
    key: &[Value],
) -> Option<String> {
    if changed.is_empty() {
        return None;
    }
    let set = changed
        .iter()
        .filter_map(|name| {
            let idx = columns.iter().position(|c| c == name)?;
            Some(format!(
                "{} = {}",
                quote_ident(driver, name),
                sql_literal(driver, &source_values[idx])
            ))
        })
        .collect::<Vec<_>>()
        .join(", ");
    Some(format!(
        "UPDATE {table_ident} SET {set} WHERE {}",
        pk_predicate(driver, primary_key, key)
    ))
}

fn delete_sql(
    driver: DriverKind,
    table_ident: &str,
    primary_key: &[String],
    key: &[Value],
) -> String {
    format!(
        "DELETE FROM {table_ident} WHERE {}",
        pk_predicate(driver, primary_key, key)
    )
}

/// `pk_a = v1 AND pk_b = v2 …`. A `NULL` key value uses `IS NULL` so the
/// predicate still matches (a PK is never NULL, but a composite unique key
/// surfaced as PK could be).
fn pk_predicate(driver: DriverKind, primary_key: &[String], key: &[Value]) -> String {
    primary_key
        .iter()
        .zip(key.iter())
        .map(|(name, value)| {
            let ident = quote_ident(driver, name);
            match value {
                Value::Null => format!("{ident} IS NULL"),
                _ => format!("{ident} = {}", sql_literal(driver, value)),
            }
        })
        .collect::<Vec<_>>()
        .join(" AND ")
}

/// Renders `value` as a SQL literal for `driver`, escaping so it can never
/// break out of its quotes. Strings double embedded single quotes; MySQL also
/// escapes backslashes (its default mode treats `\` as an escape char, unlike
/// the standard-conforming PostgreSQL / SQLite).
pub(crate) fn sql_literal(driver: DriverKind, value: &Value) -> String {
    match value {
        Value::Null => "NULL".to_string(),
        Value::Bool(b) => match driver {
            DriverKind::Postgres => (if *b { "TRUE" } else { "FALSE" }).to_string(),
            DriverKind::Mysql | DriverKind::Sqlite => (if *b { "1" } else { "0" }).to_string(),
        },
        Value::Int(i) => i.to_string(),
        Value::UInt(u) => u.to_string(),
        Value::Float(f) => f.to_string(),
        Value::String(s) => quote_string(driver, s),
        Value::Bytes(hex) => match driver {
            DriverKind::Mysql | DriverKind::Sqlite => format!("X'{hex}'"),
            DriverKind::Postgres => format!("'\\x{hex}'"),
        },
    }
}

fn quote_string(driver: DriverKind, s: &str) -> String {
    let escaped = match driver {
        DriverKind::Mysql => s.replace('\\', "\\\\").replace('\'', "''"),
        DriverKind::Postgres | DriverKind::Sqlite => s.replace('\'', "''"),
    };
    format!("'{escaped}'")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cols() -> Vec<String> {
        vec!["id".to_string(), "name".to_string(), "score".to_string()]
    }

    fn row(id: i64, name: &str, score: i64) -> Vec<Value> {
        vec![
            Value::Int(id),
            Value::String(name.to_string()),
            Value::Int(score),
        ]
    }

    #[test]
    fn classifies_inserts_updates_deletes() {
        let columns = cols();
        let pk = vec![0usize];
        let source = vec![row(1, "a", 10), row(2, "b", 20), row(3, "c", 30)];
        // id=1 changed score, id=2 identical, id=4 target-only.
        let target = vec![row(1, "a", 99), row(2, "b", 20), row(4, "d", 40)];
        let diffs = compute_data_diff(&columns, &pk, &source, &target);

        let by_status = |st: RowStatus| diffs.iter().filter(|r| r.status == st).count();
        assert_eq!(by_status(RowStatus::SourceOnly), 1); // id=3
        assert_eq!(by_status(RowStatus::Different), 1); // id=1
        assert_eq!(by_status(RowStatus::TargetOnly), 1); // id=4

        let changed = diffs
            .iter()
            .find(|r| r.status == RowStatus::Different)
            .unwrap();
        assert_eq!(changed.changed_columns, vec!["score".to_string()]);
        // id=2 is identical and must not appear.
        assert_eq!(diffs.len(), 3);
    }

    #[test]
    fn generates_dml_with_delete_gated() {
        let columns = cols();
        let pk = vec![0usize];
        let source = vec![row(1, "a", 10), row(3, "c", 30)];
        let target = vec![row(1, "a", 99), row(4, "d", 40)];
        let diffs = compute_data_diff(&columns, &pk, &source, &target);
        let diff = DataDiff {
            target_driver: DriverKind::Mysql,
            table: "scores".to_string(),
            columns,
            primary_key: vec!["id".to_string()],
            rows: diffs,
            truncated: false,
            source_count: 2,
            target_count: 2,
        };

        let without = generate_data_sync_sql(&diff, false);
        assert!(!without
            .statements
            .iter()
            .any(|s| s.kind == SyncKind::DeleteRow));
        let kinds: Vec<SyncKind> = without.statements.iter().map(|s| s.kind).collect();
        // INSERT (id=3) then UPDATE (id=1); no delete.
        assert_eq!(kinds, vec![SyncKind::InsertRow, SyncKind::UpdateRow]);
        assert_eq!(
            without.statements[0].sql,
            "INSERT INTO `scores` (`id`, `name`, `score`) VALUES (3, 'c', 30)"
        );
        assert_eq!(
            without.statements[1].sql,
            "UPDATE `scores` SET `score` = 10 WHERE `id` = 1"
        );

        let with = generate_data_sync_sql(&diff, true);
        let del = with
            .statements
            .iter()
            .find(|s| s.kind == SyncKind::DeleteRow)
            .unwrap();
        assert!(del.destructive);
        assert_eq!(del.sql, "DELETE FROM `scores` WHERE `id` = 4");
    }

    #[test]
    fn string_literals_are_escaped_per_driver() {
        let v = Value::String("O'Brien \\ x".to_string());
        // MySQL escapes the backslash too.
        assert_eq!(sql_literal(DriverKind::Mysql, &v), "'O''Brien \\\\ x'");
        // Postgres / SQLite leave the backslash literal.
        assert_eq!(sql_literal(DriverKind::Postgres, &v), "'O''Brien \\ x'");
        assert_eq!(sql_literal(DriverKind::Sqlite, &v), "'O''Brien \\ x'");
    }

    #[test]
    fn literal_rendering_covers_types() {
        assert_eq!(sql_literal(DriverKind::Postgres, &Value::Null), "NULL");
        assert_eq!(
            sql_literal(DriverKind::Postgres, &Value::Bool(true)),
            "TRUE"
        );
        assert_eq!(sql_literal(DriverKind::Mysql, &Value::Bool(true)), "1");
        assert_eq!(sql_literal(DriverKind::Mysql, &Value::Int(-5)), "-5");
        assert_eq!(
            sql_literal(DriverKind::Sqlite, &Value::Bytes("ab12".to_string())),
            "X'ab12'"
        );
        assert_eq!(
            sql_literal(DriverKind::Postgres, &Value::Bytes("ab12".to_string())),
            "'\\xab12'"
        );
    }

    #[test]
    fn composite_key_predicate_and_null_handling() {
        let pk = vec!["a".to_string(), "b".to_string()];
        let key = vec![Value::Int(1), Value::Null];
        assert_eq!(
            pk_predicate(DriverKind::Postgres, &pk, &key),
            "\"a\" = 1 AND \"b\" IS NULL"
        );
    }

    #[test]
    fn integer_and_string_keys_do_not_collide() {
        let columns = vec!["id".to_string(), "v".to_string()];
        let pk = vec![0usize];
        let source = vec![vec![Value::Int(1), Value::String("x".to_string())]];
        let target = vec![vec![
            Value::String("1".to_string()),
            Value::String("x".to_string()),
        ]];
        let diffs = compute_data_diff(&columns, &pk, &source, &target);
        // The int 1 and the string "1" are different keys → one insert + one delete-candidate.
        assert_eq!(diffs.len(), 2);
        assert!(diffs.iter().any(|r| r.status == RowStatus::SourceOnly));
        assert!(diffs.iter().any(|r| r.status == RowStatus::TargetOnly));
    }
}
