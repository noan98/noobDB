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
    /// True if this row's key cannot be trusted to identify a single physical
    /// row: two or more rows collided onto the same key signature (a duplicate
    /// primary key — including distinct rows that share an identical `NULL`
    /// "key", which SQLite permits in a non-`INTEGER` primary key; see
    /// [`compute_data_diff`]). A *unique* key that merely contains a `NULL`
    /// (e.g. a composite key with one `NULL` facet) is **not** flagged — it is
    /// safely addressable with `pk = ... AND pk2 IS NULL`. When the key is
    /// unreliable, [`generate_data_sync_sql`] skips `UPDATE`/`DELETE` for the
    /// row (an `INSERT` for a `SourceOnly` row stays safe — it never touches an
    /// existing row) and surfaces a warning instead of guessing which physical
    /// row `pk = ...` is meant to match.
    ///
    /// `#[serde(default)]`: この `DataDiff` はフロントを往復して
    /// `generate_data_sync_sql` へ渡し戻される。フロントの zod スキーマは未知
    /// フィールドを破棄するため往復後の JSON にはこのフィールドが無く、default
    /// が無いとデシリアライズ自体が失敗する。default で `false` に戻るぶん
    /// フラグとしての保護は往復で失われるが、`generate_data_sync_sql` 側が
    /// キー値そのもの (往復しても残る) から NULL / 重複キーを再計算して補うため
    /// 実害はない。
    #[serde(default)]
    pub key_unreliable: bool,
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
    /// Column type names, in the same order as `columns` (same length). Used
    /// to restore `Value::Bytes` for BLOB columns after an IPC round trip
    /// re-serializes them as `Value::String` (see [`is_binary_type`]).
    pub column_types: Vec<String>,
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
///
/// 修正 L1: 同一キー署名に 2 行以上が畳まれる「重複キー」を検出したら
/// `key_unreliable` を立てて呼び出し側 (`generate_data_sync_sql`) に伝え、
/// `UPDATE`/`DELETE` の誤爆を防ぐ (`SourceOnly` の `INSERT` は既存行を書き換え
/// ないので安全であり許容する)。SQLite は非 `INTEGER` 主キーに `NULL` を許す
/// ため、複数の行が同じ `NULL` キー (`Value::Null` の Debug 表現) に畳まれる
/// のがこの重複の代表例。ただし単一行の `NULL` 含みキーは一意に特定できるので
/// 弾かない (`pk = ... AND pk2 IS NULL` で安全に扱える)。
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
    // 同じ sig の行が 2 件以上あれば重複キー — 後勝ちで上書きされてしまうので
    // どのキーが衝突したかを別途記録しておく。これが唯一の「信頼できない」条件:
    // 単一の NULL 含みキー (例: 複合キーの一部が NULL だが行を一意に特定できる)
    // は `pk = ... AND pk2 IS NULL` で安全に扱えるので弾かない。危険なのは
    // 「複数の物理行が同一キー (NULL 同士の畳み込みを含む) に潰れる」場合だけ。
    let mut dup_sigs: std::collections::HashSet<String> = std::collections::HashSet::new();
    for row in target {
        let s = sig(&key_of(row));
        if target_by_sig.insert(s.clone(), row).is_some() {
            dup_sigs.insert(s);
        }
    }
    let is_unreliable = |_key: &[Value], s: &str| dup_sigs.contains(s);

    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut out: Vec<RowDiff> = Vec::new();

    for s_row in source {
        let key = key_of(s_row);
        let s = sig(&key);
        let unreliable = is_unreliable(&key, &s);
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
                        key_unreliable: unreliable,
                    });
                }
            }
            None => out.push(RowDiff {
                status: RowStatus::SourceOnly,
                key,
                source: Some(s_row.clone()),
                target: None,
                changed_columns: Vec::new(),
                key_unreliable: unreliable,
            }),
        }
    }

    for t_row in target {
        let key = key_of(t_row);
        let s = sig(&key);
        if seen.contains(&s) {
            continue;
        }
        let unreliable = is_unreliable(&key, &s);
        out.push(RowDiff {
            status: RowStatus::TargetOnly,
            key,
            source: None,
            target: Some(t_row.clone()),
            changed_columns: Vec::new(),
            key_unreliable: unreliable,
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
        let eq = match (source.get(i), target.get(i)) {
            (Some(a), Some(b)) => values_equal(a, b),
            (a, b) => a == b,
        };
        if !eq {
            changed.push(name.clone());
        }
    }
    changed
}

/// Value equality that treats two `NaN` floats as equal. The derived
/// `PartialEq` on `Value` follows IEEE-754 (`NaN != NaN`), which would make a
/// column holding `NaN` on both sides compare as "changed" on every run —
/// and since `DataDiff` round-trips through `serde_json` (which turns
/// non-finite `f64` into `null`), the generated `UPDATE` would silently
/// clobber the value with `NULL`. Everything else falls back to `==`.
fn values_equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Float(x), Value::Float(y)) if x.is_nan() && y.is_nan() => true,
        _ => a == b,
    }
}

/// タグ付きのキー署名。整数 `1` と文字列 `"1"` を区別する (`compute_data_diff`
/// のペアリングと同じ表現)。`generate_data_sync_sql` の重複キー再計算でも使う。
fn key_signature(key: &[Value]) -> String {
    key.iter()
        .map(|v| format!("{v:?}"))
        .collect::<Vec<_>>()
        .join("\u{1f}")
}

/// Renders the DML that makes the target table's rows match the source's.
/// `INSERT`s come first, then `UPDATE`s, then `DELETE`s; `DELETE`s appear only
/// when `allow_delete` is set.
pub fn generate_data_sync_sql(diff: &DataDiff, allow_delete: bool) -> SyncPlan {
    let driver = diff.target_driver;
    let table_ident = quote_ident(driver, &diff.table);
    let mut statements: Vec<SyncStatement> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();

    // 行数上限で切り捨てられた比較結果は、source 側に実在する行を誤って
    // TargetOnly と分類しうる (ウィンドウのズレ)。DELETE は破壊的操作なので、
    // allow_delete の指定に関わらず一切生成しない。
    let skip_delete = diff.truncated;
    if skip_delete && diff.rows.iter().any(|r| r.status == RowStatus::TargetOnly) {
        warnings.push(
            "比較結果が行数上限で切り捨てられているため、削除 (DELETE) は安全のため \
             生成していません。全行を比較するには対象を絞るか上限を上げてください。"
                .to_string(),
        );
    }

    // 修正 L1: NULL / 重複した主キーの行は `pk = ...` / `pk IS NULL` が
    // 意図しない行に波及しうるため、UPDATE/DELETE は生成せず INSERT のみ許容する。
    // `key_unreliable` フラグは IPC 往復で失われる (上記 RowDiff の doc 参照) ため、
    // 往復しても残るキー値そのものから NULL キー・重複キーを再計算し、フラグと
    // OR して判定する (フラグに依存せず保護が効く)。
    let duplicate_key_sigs: std::collections::HashSet<String> = {
        let mut seen = std::collections::HashSet::new();
        let mut dups = std::collections::HashSet::new();
        for row in &diff.rows {
            let s = key_signature(&row.key);
            if !seen.insert(s.clone()) {
                dups.insert(s);
            }
        }
        dups
    };
    let is_unreliable = |row: &RowDiff| -> bool {
        row.key_unreliable || duplicate_key_sigs.contains(&key_signature(&row.key))
    };
    let mut skipped_unreliable = false;

    for row in &diff.rows {
        match row.status {
            RowStatus::SourceOnly => {
                if let Some(values) = &row.source {
                    let values = coerce_binary_values(&diff.columns, &diff.column_types, values);
                    statements.push(SyncStatement {
                        sql: insert_sql(driver, &table_ident, &diff.columns, &values),
                        table: diff.table.clone(),
                        kind: SyncKind::InsertRow,
                        destructive: false,
                    });
                }
            }
            RowStatus::Different => {
                if is_unreliable(row) {
                    skipped_unreliable = true;
                } else if let Some(values) = &row.source {
                    let values = coerce_binary_values(&diff.columns, &diff.column_types, values);
                    let key = coerce_binary_key(
                        &diff.columns,
                        &diff.column_types,
                        &diff.primary_key,
                        &row.key,
                    );
                    if let Some(sql) = update_sql(
                        driver,
                        &table_ident,
                        &diff.columns,
                        &diff.primary_key,
                        &row.changed_columns,
                        &values,
                        &key,
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
                if allow_delete && !skip_delete {
                    if is_unreliable(row) {
                        skipped_unreliable = true;
                    } else {
                        let key = coerce_binary_key(
                            &diff.columns,
                            &diff.column_types,
                            &diff.primary_key,
                            &row.key,
                        );
                        statements.push(SyncStatement {
                            sql: delete_sql(driver, &table_ident, &diff.primary_key, &key),
                            table: diff.table.clone(),
                            kind: SyncKind::DeleteRow,
                            destructive: true,
                        });
                    }
                }
            }
        }
    }

    if skipped_unreliable {
        warnings.push(
            "重複した主キー (複数の行が同一キーに畳まれるケース。NULL 同士の \
             畳み込みを含む) を持つ行が検出されたため、安全のため該当行の \
             UPDATE/DELETE は生成していません (INSERT が必要な行は通常どおり \
             生成されます)。対象テーブルの主キー定義を見直してください。"
                .to_string(),
        );
    }

    // 修正 L5 (既知の限界): 大文字小文字のみ異なる主キーを持つ SourceOnly/
    // TargetOnly のペアは、DB の照合順序 (collation) が大小無視 (例: MySQL の
    // `_ci` 系) の場合は本来同一行を指す。ここでは照合順序を introspection
    // していないため確実な判定はできず、ベストエフォートで気づきを促す警告に
    // 留める (完全な自動修正はスコープ外)。
    if has_case_insensitive_key_collision(&diff.rows) {
        warnings.push(
            "大文字小文字のみ異なる主キーが SourceOnly / TargetOnly の両方に検出されました。 \
             主キー列の照合順序が大文字小文字を区別しない設定 (例: MySQL の *_ci) の場合、 \
             生成された INSERT / DELETE が一意制約違反などで失敗する可能性があります。 \
             適用前に主キーの値と照合順序を確認してください。"
                .to_string(),
        );
    }

    statements.sort_by_key(|s| s.kind.order());
    SyncPlan {
        statements,
        warnings,
    }
}

/// True if some `SourceOnly` row's key and some `TargetOnly` row's key are
/// equal once string components are lower-cased — i.e. they likely refer to
/// the same logical row under a case-insensitive collation, but were split
/// into an add + a remove because the exact bytes differ. Best-effort only:
/// this module has no visibility into the target column's actual collation.
fn has_case_insensitive_key_collision(rows: &[RowDiff]) -> bool {
    let lower_key = |key: &[Value]| -> String {
        key.iter()
            .map(|v| match v {
                Value::String(s) => s.to_ascii_lowercase(),
                other => format!("{other:?}"),
            })
            .collect::<Vec<_>>()
            .join("\u{1f}")
    };

    let source_only_lower: std::collections::HashSet<String> = rows
        .iter()
        .filter(|r| r.status == RowStatus::SourceOnly)
        .map(|r| lower_key(&r.key))
        .collect();

    rows.iter()
        .filter(|r| r.status == RowStatus::TargetOnly)
        .any(|r| source_only_lower.contains(&lower_key(&r.key)))
}

/// True if `type_name` (a driver column type, e.g. `varbinary(255)`,
/// `BYTEA`, `blob`) holds binary data rather than text. Used to restore
/// `Value::Bytes` for values that came back as `Value::String` after an IPC
/// round trip (see the `DataDiff::column_types` doc comment).
fn is_binary_type(type_name: &str) -> bool {
    let upper = type_name.to_ascii_uppercase();
    upper.contains("BLOB") || upper.contains("BINARY") || upper.contains("BYTEA")
}

/// If `value` is a `Value::String` holding a hex-encoded BLOB (per
/// `type_name`), converts it back to `Value::Bytes` so `sql_literal` renders
/// it as a binary literal instead of quoted text. Anything else (including
/// `Value::Null`) passes through unchanged.
fn coerce_binary_value(type_name: Option<&str>, value: &Value) -> Value {
    match (type_name, value) {
        (Some(t), Value::String(hex)) if is_binary_type(t) => Value::Bytes(hex.clone()),
        _ => value.clone(),
    }
}

/// Looks up `name`'s type within `all_columns`/`all_types` (parallel arrays).
fn type_of_column<'a>(
    all_columns: &[String],
    all_types: &'a [String],
    name: &str,
) -> Option<&'a str> {
    all_columns
        .iter()
        .position(|c| c == name)
        .and_then(|i| all_types.get(i))
        .map(|s| s.as_str())
}

/// Applies [`coerce_binary_value`] to each of `values`, one per `columns[i]`.
fn coerce_binary_values(columns: &[String], all_types: &[String], values: &[Value]) -> Vec<Value> {
    columns
        .iter()
        .zip(values.iter())
        .map(|(name, value)| coerce_binary_value(type_of_column(columns, all_types, name), value))
        .collect()
}

/// Same as [`coerce_binary_values`] but for a primary-key value vector, whose
/// names (`key_columns`) are looked up against the full `columns`/`all_types`
/// arrays (a PK is a subset of the table's columns).
fn coerce_binary_key(
    columns: &[String],
    all_types: &[String],
    key_columns: &[String],
    key: &[Value],
) -> Vec<Value> {
    key_columns
        .iter()
        .zip(key.iter())
        .map(|(name, value)| coerce_binary_value(type_of_column(columns, all_types, name), value))
        .collect()
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
        Value::Float(f) => {
            if f.is_finite() {
                f.to_string()
            } else {
                // NaN / Infinity / -Infinity have no literal spelling in any
                // of the three dialects. PostgreSQL accepts the quoted
                // special values and implicitly casts them into a float
                // column; MySQL / SQLite have no such casting float type
                // literal and would either reject or silently mangle the
                // text, so fall back to NULL there (same policy as
                // `commands/dump.rs::sqlite_literal`).
                match driver {
                    DriverKind::Postgres => {
                        if f.is_nan() {
                            "'NaN'".to_string()
                        } else if *f > 0.0 {
                            "'Infinity'".to_string()
                        } else {
                            "'-Infinity'".to_string()
                        }
                    }
                    DriverKind::Mysql | DriverKind::Sqlite => "NULL".to_string(),
                }
            }
        }
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
            column_types: vec!["BIGINT".to_string(); columns.len()],
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

    #[test]
    fn nan_columns_do_not_appear_as_changed() {
        // 修正 5a: 両側とも NaN の浮動小数列は "Different" と誤判定されない。
        let columns = vec!["id".to_string(), "score".to_string()];
        let pk = vec![0usize];
        let source = vec![vec![Value::Int(1), Value::Float(f64::NAN)]];
        let target = vec![vec![Value::Int(1), Value::Float(f64::NAN)]];
        let diffs = compute_data_diff(&columns, &pk, &source, &target);
        assert!(
            diffs.is_empty(),
            "NaN == NaN の行が Different と誤判定された: {diffs:?}"
        );
    }

    #[test]
    fn non_nan_float_changes_are_still_detected() {
        let columns = vec!["id".to_string(), "score".to_string()];
        let pk = vec![0usize];
        let source = vec![vec![Value::Int(1), Value::Float(1.5)]];
        let target = vec![vec![Value::Int(1), Value::Float(2.5)]];
        let diffs = compute_data_diff(&columns, &pk, &source, &target);
        assert_eq!(diffs.len(), 1);
        assert_eq!(diffs[0].status, RowStatus::Different);
    }

    #[test]
    fn non_finite_float_literals_avoid_invalid_sql() {
        // 修正 5b: NaN/Infinity/-Infinity は各ドライバで安全な形にする。
        assert_eq!(
            sql_literal(DriverKind::Postgres, &Value::Float(f64::NAN)),
            "'NaN'"
        );
        assert_eq!(
            sql_literal(DriverKind::Postgres, &Value::Float(f64::INFINITY)),
            "'Infinity'"
        );
        assert_eq!(
            sql_literal(DriverKind::Postgres, &Value::Float(f64::NEG_INFINITY)),
            "'-Infinity'"
        );
        assert_eq!(
            sql_literal(DriverKind::Mysql, &Value::Float(f64::NAN)),
            "NULL"
        );
        assert_eq!(
            sql_literal(DriverKind::Sqlite, &Value::Float(f64::NAN)),
            "NULL"
        );
        assert_eq!(
            sql_literal(DriverKind::Mysql, &Value::Float(f64::INFINITY)),
            "NULL"
        );
        // 有限値は従来どおり。
        assert_eq!(sql_literal(DriverKind::Postgres, &Value::Float(1.5)), "1.5");
        assert_eq!(sql_literal(DriverKind::Mysql, &Value::Float(-2.0)), "-2");
    }

    #[test]
    fn truncated_diff_skips_delete_and_warns() {
        // 修正 6: truncated:true では allow_delete=true でも DELETE を生成しない。
        let columns = cols();
        let pk = vec![0usize];
        let source = vec![row(1, "a", 10)];
        let target = vec![row(1, "a", 10), row(4, "d", 40)];
        let diffs = compute_data_diff(&columns, &pk, &source, &target);
        let diff = DataDiff {
            target_driver: DriverKind::Mysql,
            table: "scores".to_string(),
            column_types: vec!["BIGINT".to_string(); columns.len()],
            columns,
            primary_key: vec!["id".to_string()],
            rows: diffs,
            truncated: true,
            source_count: 1,
            target_count: 2,
        };

        let plan = generate_data_sync_sql(&diff, true);
        assert!(
            !plan
                .statements
                .iter()
                .any(|s| s.kind == SyncKind::DeleteRow),
            "truncated diff generated a DELETE despite allow_delete"
        );
        assert!(
            !plan.warnings.is_empty(),
            "truncated diff with a TargetOnly row should produce a warning"
        );
    }

    #[test]
    fn non_truncated_diff_still_generates_delete() {
        // Guard: the existing `generates_dml_with_delete_gated` test already covers this
        // (truncated: false), but assert explicitly that truncation is the gate, not
        // allow_delete alone becoming a no-op.
        let columns = cols();
        let pk = vec![0usize];
        let source = vec![row(1, "a", 10)];
        let target = vec![row(1, "a", 10), row(4, "d", 40)];
        let diffs = compute_data_diff(&columns, &pk, &source, &target);
        let diff = DataDiff {
            target_driver: DriverKind::Mysql,
            table: "scores".to_string(),
            column_types: vec!["BIGINT".to_string(); columns.len()],
            columns,
            primary_key: vec!["id".to_string()],
            rows: diffs,
            truncated: false,
            source_count: 1,
            target_count: 2,
        };

        let plan = generate_data_sync_sql(&diff, true);
        assert!(plan
            .statements
            .iter()
            .any(|s| s.kind == SyncKind::DeleteRow));
        assert!(plan.warnings.is_empty());
    }

    #[test]
    fn blob_round_tripped_as_string_is_rendered_as_binary_literal() {
        // 修正 3: column_types が BLOB/BYTEA の列は、Value::String(hex) を
        // Value::Bytes として扱い、X'..' / '\x..' で出力する。
        let columns = vec!["id".to_string(), "payload".to_string()];
        let column_types = vec!["BIGINT".to_string(), "BLOB".to_string()];
        let source_row = vec![Value::Int(1), Value::String("a1b2".to_string())];
        let diff = DataDiff {
            target_driver: DriverKind::Mysql,
            table: "files".to_string(),
            columns: columns.clone(),
            column_types: column_types.clone(),
            primary_key: vec!["id".to_string()],
            rows: vec![RowDiff {
                status: RowStatus::SourceOnly,
                key: vec![Value::Int(1)],
                source: Some(source_row.clone()),
                target: None,
                changed_columns: Vec::new(),
                key_unreliable: false,
            }],
            truncated: false,
            source_count: 1,
            target_count: 0,
        };

        let mysql_plan = generate_data_sync_sql(&diff, false);
        assert!(mysql_plan.statements[0].sql.contains("X'a1b2'"));

        let sqlite_diff = DataDiff {
            target_driver: DriverKind::Sqlite,
            ..diff.clone()
        };
        let sqlite_plan = generate_data_sync_sql(&sqlite_diff, false);
        assert!(sqlite_plan.statements[0].sql.contains("X'a1b2'"));

        let postgres_diff = DataDiff {
            target_driver: DriverKind::Postgres,
            ..diff
        };
        let postgres_plan = generate_data_sync_sql(&postgres_diff, false);
        assert!(postgres_plan.statements[0].sql.contains("'\\xa1b2'"));
    }

    #[test]
    fn null_key_target_only_row_is_not_deleted() {
        // 修正 L1: 同一 NULL キーに複数行が畳まれる (重複キー) 場合、`pk IS NULL`
        // が複数行に波及しうるため DELETE を生成しない。
        let columns = vec!["id".to_string(), "name".to_string()];
        let pk = vec![0usize];
        let source: Vec<Vec<Value>> = vec![];
        // 2 行とも id=NULL — SQLite が許す非 INTEGER PK の NULL 重複を想定。
        let target = vec![
            vec![Value::Null, Value::String("orphan1".to_string())],
            vec![Value::Null, Value::String("orphan2".to_string())],
        ];
        let diffs = compute_data_diff(&columns, &pk, &source, &target);
        assert_eq!(diffs.len(), 2);
        assert!(
            diffs.iter().all(|r| r.key_unreliable),
            "重複 NULL キーの行はすべて unreliable のはず"
        );

        let diff = DataDiff {
            target_driver: DriverKind::Sqlite,
            table: "t".to_string(),
            column_types: vec!["TEXT".to_string(); columns.len()],
            columns,
            primary_key: vec!["id".to_string()],
            rows: diffs,
            truncated: false,
            source_count: 0,
            target_count: 2,
        };

        let plan = generate_data_sync_sql(&diff, true);
        assert!(
            !plan
                .statements
                .iter()
                .any(|s| s.kind == SyncKind::DeleteRow),
            "重複 NULL 主キーの行に対して DELETE を生成してはいけない"
        );
        assert!(
            !plan.warnings.is_empty(),
            "重複主キーをスキップしたことの警告が必要: {:?}",
            plan.warnings
        );
    }

    #[test]
    fn unique_null_composite_key_is_deletable_with_is_null() {
        // 修正 L1: 単一行の NULL 含みキーは一意に特定できるので弾かない。
        // 複合キー (a, b) の b が NULL でも、その行が 1 件なら
        // `a = ... AND b IS NULL` で安全に DELETE できる。
        let columns = vec!["a".to_string(), "b".to_string(), "v".to_string()];
        let pk = vec![0usize, 1usize];
        let source: Vec<Vec<Value>> = vec![];
        let target = vec![vec![
            Value::Int(1),
            Value::Null,
            Value::String("x".to_string()),
        ]];
        let diffs = compute_data_diff(&columns, &pk, &source, &target);
        assert_eq!(diffs.len(), 1);
        assert!(
            !diffs[0].key_unreliable,
            "一意な NULL 含み複合キーは unreliable ではない"
        );

        let diff = DataDiff {
            target_driver: DriverKind::Postgres,
            table: "t".to_string(),
            column_types: vec!["TEXT".to_string(); columns.len()],
            columns,
            primary_key: vec!["a".to_string(), "b".to_string()],
            rows: diffs,
            truncated: false,
            source_count: 0,
            target_count: 1,
        };

        let plan = generate_data_sync_sql(&diff, true);
        assert_eq!(
            plan.statements
                .iter()
                .filter(|s| s.kind == SyncKind::DeleteRow)
                .map(|s| s.sql.as_str())
                .collect::<Vec<_>>(),
            vec![r#"DELETE FROM "t" WHERE "a" = 1 AND "b" IS NULL"#]
        );
    }

    #[test]
    fn null_key_protection_survives_ipc_round_trip() {
        // 修正 L1 (往復対策): DataDiff はフロントを往復して generate へ戻る。
        // フロントの zod は未知フィールド (key_unreliable) を破棄するため、
        // 往復後の JSON には key_unreliable が無い。この状況を再現し、
        // (a) デシリアライズが #[serde(default)] で成功すること、
        // (b) それでも重複キー (同一 NULL キーに畳まれた 2 行) の DELETE が
        //     キー値からの再計算により抑止されること を確認する。
        // フラグに依存しない保護であることの回帰テスト。
        let json = r#"{
            "target_driver": "sqlite",
            "table": "t",
            "columns": ["id", "name"],
            "column_types": ["TEXT", "TEXT"],
            "primary_key": ["id"],
            "rows": [
                {
                    "status": "target_only",
                    "key": [null],
                    "source": null,
                    "target": [null, "orphan1"],
                    "changed_columns": []
                },
                {
                    "status": "target_only",
                    "key": [null],
                    "source": null,
                    "target": [null, "orphan2"],
                    "changed_columns": []
                }
            ],
            "truncated": false,
            "source_count": 0,
            "target_count": 2
        }"#;
        let diff: DataDiff =
            serde_json::from_str(json).expect("往復後の JSON をデシリアライズできる");
        assert!(
            !diff.rows[0].key_unreliable,
            "往復後はフラグが失われ false に戻る (default)"
        );

        let plan = generate_data_sync_sql(&diff, true);
        assert!(
            !plan
                .statements
                .iter()
                .any(|s| s.kind == SyncKind::DeleteRow),
            "往復後でも重複キーの DELETE を生成してはいけない"
        );
        assert!(
            !plan.warnings.is_empty(),
            "往復後でもスキップ警告が必要: {:?}",
            plan.warnings
        );
    }

    #[test]
    fn unique_null_key_different_row_is_updated_with_is_null() {
        // 修正 L1: 一意な NULL キーでペアリングされた Different 行は、単一行を
        // 特定できるので `pk IS NULL` で安全に UPDATE できる (弾かない)。
        let columns = vec!["id".to_string(), "score".to_string()];
        let pk = vec![0usize];
        let source = vec![vec![Value::Null, Value::Int(1)]];
        let target = vec![vec![Value::Null, Value::Int(2)]];
        let diffs = compute_data_diff(&columns, &pk, &source, &target);
        assert_eq!(diffs.len(), 1);
        assert_eq!(diffs[0].status, RowStatus::Different);
        assert!(
            !diffs[0].key_unreliable,
            "一意な NULL キーは unreliable ではない"
        );

        let diff = DataDiff {
            target_driver: DriverKind::Sqlite,
            table: "t".to_string(),
            column_types: vec!["INTEGER".to_string(); columns.len()],
            columns,
            primary_key: vec!["id".to_string()],
            rows: diffs,
            truncated: false,
            source_count: 1,
            target_count: 1,
        };

        let plan = generate_data_sync_sql(&diff, true);
        let updates: Vec<&str> = plan
            .statements
            .iter()
            .filter(|s| s.kind == SyncKind::UpdateRow)
            .map(|s| s.sql.as_str())
            .collect();
        assert_eq!(
            updates,
            vec![r#"UPDATE "t" SET "score" = 1 WHERE "id" IS NULL"#]
        );
    }

    #[test]
    fn duplicate_non_null_target_key_marks_rows_unreliable() {
        // 修正 L1: sig が衝突する重複 PK (通常は起こらないはずの壊れたデータ) も
        // 安全側に倒し、UPDATE/DELETE の対象から外す。
        let columns = vec!["id".to_string(), "v".to_string()];
        let pk = vec![0usize];
        let source: Vec<Vec<Value>> = vec![];
        // 同じキー `1` を持つ 2 行が target に存在する (本来 PK 制約で起こらない
        // はずの壊れたデータを想定)。
        let target = vec![
            vec![Value::Int(1), Value::String("a".to_string())],
            vec![Value::Int(1), Value::String("b".to_string())],
        ];
        let diffs = compute_data_diff(&columns, &pk, &source, &target);
        assert!(
            diffs.iter().all(|r| r.key_unreliable),
            "重複 PK の行はすべて unreliable のはず: {diffs:?}"
        );
    }

    #[test]
    fn non_null_unique_keys_are_not_flagged_unreliable() {
        // Guard: 通常の (NULL を含まず重複もない) キーは unreliable にならない。
        let columns = cols();
        let pk = vec![0usize];
        let source = vec![row(1, "a", 10)];
        let target = vec![row(1, "a", 99)];
        let diffs = compute_data_diff(&columns, &pk, &source, &target);
        assert_eq!(diffs.len(), 1);
        assert!(!diffs[0].key_unreliable);
    }

    #[test]
    fn case_insensitive_key_collision_warns() {
        // 修正 L5 (既知の限界): CI 照合の主キーでは 'ABC' と 'abc' が同一行を
        // 指すが、この層は照合順序を知らないため SourceOnly + TargetOnly に
        // 分解される。せめて気づけるようベストエフォートで警告する。
        let columns = vec!["code".to_string(), "v".to_string()];
        let pk = vec![0usize];
        let source = vec![vec![Value::String("ABC".to_string()), Value::Int(1)]];
        let target = vec![vec![Value::String("abc".to_string()), Value::Int(1)]];
        let diffs = compute_data_diff(&columns, &pk, &source, &target);
        assert_eq!(diffs.len(), 2);

        let diff = DataDiff {
            target_driver: DriverKind::Mysql,
            table: "t".to_string(),
            column_types: vec!["VARCHAR".to_string(); columns.len()],
            columns,
            primary_key: vec!["code".to_string()],
            rows: diffs,
            truncated: false,
            source_count: 1,
            target_count: 1,
        };
        let plan = generate_data_sync_sql(&diff, true);
        assert!(
            plan.warnings.iter().any(|w| w.contains("大文字小文字")),
            "CI 照合の可能性に気づく警告が必要: {:?}",
            plan.warnings
        );
    }

    #[test]
    fn distinct_keys_do_not_trigger_case_insensitive_warning() {
        // Guard: 大小文字を無視しても一致しないキー同士では警告しない。
        let columns = vec!["code".to_string(), "v".to_string()];
        let pk = vec![0usize];
        let source = vec![vec![Value::String("xyz".to_string()), Value::Int(1)]];
        let target = vec![vec![Value::String("abc".to_string()), Value::Int(1)]];
        let diffs = compute_data_diff(&columns, &pk, &source, &target);
        let diff = DataDiff {
            target_driver: DriverKind::Mysql,
            table: "t".to_string(),
            column_types: vec!["VARCHAR".to_string(); columns.len()],
            columns,
            primary_key: vec!["code".to_string()],
            rows: diffs,
            truncated: false,
            source_count: 1,
            target_count: 1,
        };
        let plan = generate_data_sync_sql(&diff, true);
        assert!(!plan.warnings.iter().any(|w| w.contains("大文字小文字")));
    }
}
