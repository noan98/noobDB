//! Sandbox (branch) — pure helpers for issue #747.
//!
//! A "sandbox" is a local SQLite copy of selected tables (optionally expanded
//! along foreign keys) that the user can experiment on freely through the
//! normal editor/grid UI, then reconcile back into the source database on
//! their own terms. The heavy lifting — computing what changed and rendering
//! it as SQL — is **entirely reused** from the existing Diff/Sync feature
//! (`db::diff` / `db::data_diff` / `db::sync`): a sandbox writeback is, from
//! the target database's point of view, an ordinary sync apply. This module
//! only adds the sandbox-specific pieces those don't cover:
//!
//! * a reserved naming scheme for the frozen "base" snapshot mirrored
//!   alongside every live table, so the same SQLite connection can serve both
//!   sides of a diff (`shadow_table_name` / `is_shadow_table_name`);
//! * the transitive foreign-key closure used when the user asks to
//!   auto-include related tables (`fk_closure`);
//! * concurrent-edit ("did someone else touch this row since I copied it")
//!   conflict detection, computed as the intersection of two diffs against
//!   the same frozen base (`detect_conflicts`);
//! * a pure filter to drop the rows a conflict was resolved as "skip" for,
//!   before the trimmed [`DataDiff`] is handed to the existing
//!   `generate_data_sync_sql` command (`filter_out_keys`).
//!
//! All functions here are pure and driver-agnostic, kept unit-testable
//! without a database; `commands::sandbox` wires them to live connections.

use std::collections::{BTreeSet, HashMap, HashSet};

use serde::{Deserialize, Serialize};

use super::data_diff::{coerce_binary_key, key_signature, DataDiff, RowDiff, RowStatus};
use super::diff::{DiffStatus, SchemaDiff, TableColumns, TableDiff};
use super::types::{ForeignKey, TableColumnInfo, Value};

/// Table-name prefix reserved for the frozen "base" snapshot mirrored
/// alongside every live table copied into a sandbox. Never shown in the
/// table browser (the frontend filters names with this prefix) and never
/// written to after creation — it is the fixed reference point both diffs
/// (desired vs. conflicts) are computed against.
pub const SHADOW_PREFIX: &str = "__noobdb_sandbox_base__";

/// The shadow ("base snapshot") table name for a live table name.
pub fn shadow_table_name(table: &str) -> String {
    format!("{SHADOW_PREFIX}{table}")
}

/// True when `name` is a sandbox shadow table (reserved prefix), so the UI
/// can hide it from the table browser.
pub fn is_shadow_table_name(name: &str) -> bool {
    name.starts_with(SHADOW_PREFIX)
}

/// Default and maximum row copy limit per table when creating a sandbox.
/// The sandbox is meant for iterating on data-shaping logic, not for holding
/// bulk tables (mirrors the master-data cap `commands::diff` already applies
/// to data comparison).
pub const DEFAULT_ROW_LIMIT: u64 = 5_000;
pub const MAX_ROW_LIMIT: u64 = 100_000;

/// Clamps a caller-supplied row limit into `[1, MAX_ROW_LIMIT]`, defaulting to
/// `DEFAULT_ROW_LIMIT` when absent or zero.
pub fn clamp_row_limit(limit: Option<u64>) -> u64 {
    limit
        .filter(|&n| n > 0)
        .unwrap_or(DEFAULT_ROW_LIMIT)
        .min(MAX_ROW_LIMIT)
}

/// Transitive closure of `selected` along `fks`: repeatedly adds every table
/// referenced (via `referenced_table`) by a foreign key on a table already in
/// the set, until a fixed point is reached. Used when the user opts in to
/// "related tables" so a sandbox never ends up with a dangling foreign key
/// pointing at a table it didn't copy. Mirrors the FK-closure idea in
/// `schemaExport.ts` (frontend), reimplemented here since it must run
/// server-side against live `foreign_keys()` metadata.
///
/// Returns a sorted, deduplicated list (input order isn't meaningful once
/// tables are pulled in transitively).
pub fn fk_closure(selected: &[String], fks: &[ForeignKey]) -> Vec<String> {
    let mut set: BTreeSet<String> = selected.iter().cloned().collect();
    loop {
        let mut added = false;
        for fk in fks {
            if set.contains(&fk.table) && !set.contains(&fk.referenced_table) {
                set.insert(fk.referenced_table.clone());
                added = true;
            }
        }
        if !added {
            break;
        }
    }
    set.into_iter().collect()
}

/// Renders `value` as the `Option<String>` cell text `Connection::import_rows`
/// expects (it binds every value as text; SQLite's dynamic typing makes this
/// safe regardless of the declared column type). `Value::Bytes` — already
/// hex-encoded per the wire format — is copied through as hex text rather
/// than raw bytes: a known, documented approximation of the sandbox's local
/// SQLite copy (binary round-tripping through the sandbox isn't guaranteed
/// byte-for-byte; see the sandbox creation help text).
pub fn value_to_cell(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::Bool(b) => Some(if *b { "1" } else { "0" }.to_string()),
        Value::Int(i) => Some(i.to_string()),
        Value::UInt(u) => Some(u.to_string()),
        Value::Float(f) => Some(f.to_string()),
        Value::String(s) => Some(s.clone()),
        Value::Bytes(hex) => Some(hex.clone()),
    }
}

/// Applies [`value_to_cell`] across a whole row.
pub fn row_to_cells(row: &[Value]) -> Vec<Option<String>> {
    row.iter().map(value_to_cell).collect()
}

/// Doubles every `(table, columns)` pair into a live entry and a
/// [`shadow_table_name`] entry with identical columns, for a single
/// `compute_schema_diff` + `generate_sync_sql` pass that creates both copies
/// of every table in one set of `CREATE TABLE` statements at sandbox creation
/// time.
pub fn with_shadow_copies(tables: &[(String, Vec<TableColumnInfo>)]) -> Vec<TableColumns> {
    let mut out = Vec::with_capacity(tables.len() * 2);
    for (name, columns) in tables {
        out.push(TableColumns {
            name: name.clone(),
            columns: columns.clone(),
        });
        out.push(TableColumns {
            name: shadow_table_name(name),
            columns: columns.clone(),
        });
    }
    out
}

/// One row-level conflict: a primary key that changed both in the sandbox
/// (`desired_status`, relative to the frozen base) and on the real database
/// since the snapshot was taken (`external_status`). `external_row` is the
/// row's *current* value on the real database (`None` when it was deleted
/// there). The UI shows this alongside the sandbox's own change so the user
/// can choose to overwrite it (keep the sandbox's statement) or skip it
/// (drop the statement via [`filter_out_keys`] before generating SQL).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SandboxConflict {
    pub key: Vec<Value>,
    pub desired_status: RowStatus,
    pub external_status: RowStatus,
    pub external_row: Option<Vec<Value>>,
}

/// DECIMAL / NUMERIC 系の列型か。サンドボックスの SQLite では NUMERIC アフィニティの列になり、
/// 文字列 `"10.50"` が REAL 10.5 (整数値なら INTEGER) へ変換されて読み戻される。
fn is_decimal_type(data_type: &str) -> bool {
    let t = data_type.to_ascii_lowercase();
    t.contains("decimal") || t.contains("numeric")
}

/// 整数値の `f64` (2^53 未満) を `Value::Int` にそろえる。小数や範囲外は `None`。
fn integral_float(f: f64) -> Option<Value> {
    (f.is_finite() && f.fract() == 0.0 && f.abs() < 9_007_199_254_740_992.0)
        .then_some(Value::Int(f as i64))
}

/// DECIMAL 文字列を比較用の正準形にする。小数部が無い (またはすべて 0 の) 整数は
/// `i128` で厳密に読み `Int` / `UInt` (範囲外は正準な整数文字列) にするので、
/// 2^53 を超える DECIMAL(p,0) でも `...993` と `...992` を区別できる。小数部を持つ値だけ
/// `f64` に寄せる。注意: 小数部を持ち有効桁が 15 桁を超える値は `f64` の精度
/// (約 15〜17 桁) で丸められ、末尾の差を見逃しうる (SQLite の NUMERIC アフィニティ側も
/// REAL に丸めて保持するため、この比較ではそれ以上の精度を得られない)。
/// 数値として読めない文字列は `None`。
fn canonical_decimal(s: &str) -> Option<Value> {
    let (int_part, frac_part) = s.split_once('.').unwrap_or((s, ""));
    if frac_part.bytes().all(|b| b == b'0') && !int_part.is_empty() {
        if let Ok(n) = int_part
            .strip_prefix('+')
            .unwrap_or(int_part)
            .parse::<i128>()
        {
            return Some(if let Ok(i) = i64::try_from(n) {
                Value::Int(i)
            } else if let Ok(u) = u64::try_from(n) {
                Value::UInt(u)
            } else {
                Value::String(n.to_string())
            });
        }
    }
    s.parse::<f64>()
        .ok()
        .filter(|f| f.is_finite())
        .map(Value::Float)
}

/// 実 DB (MySQL の DECIMAL は `Value::String("10.50")`) とサンドボックス (SQLite から
/// 読み戻した `Float` / `Int`) で値の型が往復で変わる DECIMAL / NUMERIC 列を、比較用に
/// `Value::Float` へそろえた行を返す。そろえないと `values_equal` が型違いで不一致になり、
/// 元 DB で未変更の行まで「外部でも変更」の衝突として提示される。
/// 比較専用の正規化で、書き戻し SQL に使う行には適用しない。
pub fn normalize_decimal_cells(column_types: &[String], rows: &[Vec<Value>]) -> Vec<Vec<Value>> {
    let decimal: Vec<bool> = column_types.iter().map(|t| is_decimal_type(t)).collect();
    rows.iter()
        .map(|row| {
            row.iter()
                .enumerate()
                .map(|(i, v)| {
                    if !decimal.get(i).copied().unwrap_or(false) {
                        return v.clone();
                    }
                    match v {
                        Value::String(s) => {
                            canonical_decimal(s.trim()).unwrap_or_else(|| v.clone())
                        }
                        // SQLite が REAL で返した整数値 (10.0 など) は整数にそろえる。
                        Value::Float(f) => integral_float(*f).unwrap_or_else(|| v.clone()),
                        _ => v.clone(),
                    }
                })
                .collect()
        })
        .collect()
}

/// 元 DB の列定義を、サンドボックスのベース (SQLite を再 introspect したもの) と比べられる
/// 形にそろえる。SQLite のベースは `extra` (auto_increment など)・外部キー・列コメントを
/// 持たない (作成時に落とす) ので、元 DB 側のそれらを残すと、元 DB で何も変わっていなくても
/// `Different` になり「外部でも変更された表」の誤警告が出る。
pub fn normalize_columns_for_sqlite_base(tables: &mut [TableColumns]) {
    for table in tables {
        for col in &mut table.columns {
            col.extra = String::new();
            col.referenced_table = None;
            col.referenced_column = None;
            col.comment = None;
        }
    }
}

/// Finds every row that both `desired` (sandbox vs. frozen base) and
/// `external` (current real database vs. the *same* frozen base) touch —
/// i.e. both sides changed the same row independently since the snapshot.
/// Both diffs must have been computed against the same base and the same
/// primary key columns for the key signatures to line up.
pub fn detect_conflicts(desired: &DataDiff, external: &DataDiff) -> Vec<SandboxConflict> {
    let external_by_key: HashMap<String, &RowDiff> = external
        .rows
        .iter()
        .map(|r| (key_signature(&r.key), r))
        .collect();

    desired
        .rows
        .iter()
        .filter_map(|d| {
            let sig = key_signature(&d.key);
            external_by_key
                .get(&sig)
                .filter(|e| !is_converged(d, e, &desired.column_types))
                .map(|e| SandboxConflict {
                    key: d.key.clone(),
                    desired_status: d.status,
                    external_status: e.status,
                    external_row: e.source.clone(),
                })
        })
        .collect()
}

/// 両側が同じ内容に変えた (収束した) 行か。利用者に解決を求める意味が無いので
/// 衝突から外す (#1530):
/// - 両側とも更新で、変更後の行が一致する (書き戻しの UPDATE は同値の上書きで無害)。
/// - 両側とも削除 (書き戻しの DELETE は対象が無いだけで無害)。
///
/// 両側が同じ行を**追加**した場合は外さない: 書き戻しの INSERT が既存キーと重複して
/// 失敗するので、利用者が「スキップ」を選べる衝突として残す。
fn is_converged(desired: &RowDiff, external: &RowDiff, column_types: &[String]) -> bool {
    if desired.status != external.status {
        return false;
    }
    match desired.status {
        RowStatus::TargetOnly => true,
        RowStatus::Different => match (&desired.source, &external.source) {
            (Some(a), Some(b)) => {
                // DECIMAL 列は型が往復で変わる (Float と String) ので正規化して比べる。
                let a = normalize_decimal_cells(column_types, std::slice::from_ref(a));
                let b = normalize_decimal_cells(column_types, std::slice::from_ref(b));
                a == b
            }
            _ => false,
        },
        _ => false,
    }
}

/// Returns a copy of `diff` with every row whose key signature appears in
/// `skip_keys` removed. Used to drop the rows a conflict was resolved as
/// "skip (keep the external change, don't overwrite)" for, before the
/// trimmed diff is handed to `generate_data_sync_sql` to render the final
/// writeback SQL.
pub fn filter_out_keys(diff: &DataDiff, skip_keys: &[Vec<Value>]) -> DataDiff {
    // skip_keys は JSON を経由するため、BLOB/BINARY 主キーの Value::Bytes は
    // Value::String に化けている。列型から Bytes へ戻してから署名を取らないと
    // Debug 表現 (`Bytes(..)` / `String(..)`) が一致せずスキップが無視される。
    let skip: HashSet<String> = skip_keys
        .iter()
        .map(|k| {
            key_signature(&coerce_binary_key(
                &diff.columns,
                &diff.column_types,
                &diff.primary_key,
                k,
            ))
        })
        .collect();
    let rows = diff
        .rows
        .iter()
        .filter(|r| !skip.contains(&key_signature(&r.key)))
        .cloned()
        .collect();
    DataDiff {
        rows,
        ..diff.clone()
    }
}

/// Table names present in both `desired` (sandbox schema vs. frozen base) and
/// `external` (current real-database schema vs. the same frozen base) with a
/// non-`Same` status — i.e. the schema changed both in the sandbox and on the
/// real database since the snapshot. Informational only (schema conflicts
/// aren't auto-resolved row by row like data conflicts): the UI surfaces this
/// list as a warning before the user applies schema statements.
pub fn schema_conflict_tables(desired: &SchemaDiff, external: &SchemaDiff) -> Vec<String> {
    let desired_changed: HashMap<&str, &TableDiff> = desired
        .tables
        .iter()
        .filter(|t| t.status != DiffStatus::Same)
        .map(|t| (t.name.as_str(), t))
        .collect();
    let mut out: Vec<String> = external
        .tables
        .iter()
        .filter(|t| t.status != DiffStatus::Same)
        .filter(|t| {
            desired_changed
                .get(t.name.as_str())
                .is_some_and(|d| !schema_converged(d, t))
        })
        .map(|t| t.name.clone())
        .collect();
    out.sort();
    out
}

/// 両側が基準から同じ変更をした表か (データ側 `is_converged` と同じ考え方, #1612)。
/// 列ごとに「状態 + 変更後の定義 (型・NULL 可否・既定値)」が一致するときだけ収束とみなす。
/// 列差分が空の表や、方言差で型表記が揃わないものは衝突のまま残す (安全側)。
fn schema_converged(desired: &TableDiff, external: &TableDiff) -> bool {
    if desired.status != external.status
        || desired.columns.is_empty()
        || desired.columns.len() != external.columns.len()
    {
        return false;
    }
    let same_def = |a: &Option<TableColumnInfo>, b: &Option<TableColumnInfo>| match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => {
            a.data_type.eq_ignore_ascii_case(&b.data_type)
                && a.nullable == b.nullable
                && a.default == b.default
        }
        _ => false,
    };
    desired.columns.iter().all(|d| {
        external
            .columns
            .iter()
            .find(|e| e.name == d.name)
            .is_some_and(|e| {
                e.status == d.status
                    && same_def(&d.source, &e.source)
                    && same_def(&d.target, &e.target)
            })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::diff::ColumnDiff;
    use crate::db::DriverKind;

    fn fk(table: &str, referenced: &str) -> ForeignKey {
        ForeignKey {
            table: table.to_string(),
            column: "x_id".to_string(),
            referenced_table: referenced.to_string(),
            referenced_column: Some("id".to_string()),
            constraint_name: None,
            on_delete: None,
            on_update: None,
        }
    }

    #[test]
    fn shadow_naming_round_trips() {
        let shadow = shadow_table_name("orders");
        assert_eq!(shadow, "__noobdb_sandbox_base__orders");
        assert!(is_shadow_table_name(&shadow));
        assert!(!is_shadow_table_name("orders"));
    }

    #[test]
    fn clamp_row_limit_defaults_and_caps() {
        assert_eq!(clamp_row_limit(None), DEFAULT_ROW_LIMIT);
        assert_eq!(clamp_row_limit(Some(0)), DEFAULT_ROW_LIMIT);
        assert_eq!(clamp_row_limit(Some(10)), 10);
        assert_eq!(clamp_row_limit(Some(1_000_000)), MAX_ROW_LIMIT);
    }

    #[test]
    fn fk_closure_pulls_in_transitive_references() {
        // orders -> customers -> regions; orders is selected alone.
        let fks = vec![fk("orders", "customers"), fk("customers", "regions")];
        let result = fk_closure(&["orders".to_string()], &fks);
        assert_eq!(
            result,
            vec![
                "customers".to_string(),
                "orders".to_string(),
                "regions".to_string()
            ]
        );
    }

    #[test]
    fn fk_closure_is_a_noop_without_related_fks() {
        let fks = vec![fk("a", "b")];
        let result = fk_closure(&["z".to_string()], &fks);
        assert_eq!(result, vec!["z".to_string()]);
    }

    #[test]
    fn fk_closure_handles_cycles_without_looping_forever() {
        let fks = vec![fk("a", "b"), fk("b", "a")];
        let result = fk_closure(&["a".to_string()], &fks);
        assert_eq!(result, vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn value_to_cell_covers_every_variant() {
        assert_eq!(value_to_cell(&Value::Null), None);
        assert_eq!(value_to_cell(&Value::Bool(true)), Some("1".to_string()));
        assert_eq!(value_to_cell(&Value::Bool(false)), Some("0".to_string()));
        assert_eq!(value_to_cell(&Value::Int(-5)), Some("-5".to_string()));
        assert_eq!(value_to_cell(&Value::UInt(5)), Some("5".to_string()));
        assert_eq!(
            value_to_cell(&Value::String("hi".to_string())),
            Some("hi".to_string())
        );
        assert_eq!(
            value_to_cell(&Value::Bytes("ab12".to_string())),
            Some("ab12".to_string())
        );
    }

    #[test]
    fn with_shadow_copies_duplicates_every_table() {
        let cols = vec![TableColumnInfo {
            name: "id".to_string(),
            data_type: "int".to_string(),
            nullable: false,
            key: "PRI".to_string(),
            default: None,
            extra: String::new(),
            referenced_table: None,
            referenced_column: None,
            comment: None,
        }];
        let out = with_shadow_copies(&[("orders".to_string(), cols)]);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].name, "orders");
        assert_eq!(out[1].name, "__noobdb_sandbox_base__orders");
        // `TableColumnInfo` has no `PartialEq`; compare the field that matters
        // here (names survive the clone unchanged).
        assert_eq!(
            out[0].columns.iter().map(|c| &c.name).collect::<Vec<_>>(),
            out[1].columns.iter().map(|c| &c.name).collect::<Vec<_>>(),
        );
    }

    fn row_diff(status: RowStatus, key: i64, source: Option<i64>, target: Option<i64>) -> RowDiff {
        RowDiff {
            status,
            key: vec![Value::Int(key)],
            source: source.map(|v| vec![Value::Int(key), Value::Int(v)]),
            target: target.map(|v| vec![Value::Int(key), Value::Int(v)]),
            changed_columns: vec!["v".to_string()],
            key_unreliable: false,
        }
    }

    fn data_diff(rows: Vec<RowDiff>) -> DataDiff {
        DataDiff {
            target_driver: DriverKind::Mysql,
            table: "t".to_string(),
            columns: vec!["id".to_string(), "v".to_string()],
            column_types: vec!["BIGINT".to_string(), "BIGINT".to_string()],
            primary_key: vec!["id".to_string()],
            rows,
            truncated: false,
            source_count: 0,
            target_count: 0,
            generated_columns: Vec::new(),
        }
    }

    #[test]
    fn detect_conflicts_flags_keys_changed_on_both_sides() {
        // Sandbox changed row 1 (Different) and added row 2 (SourceOnly).
        let desired = data_diff(vec![
            row_diff(RowStatus::Different, 1, Some(99), Some(10)),
            row_diff(RowStatus::SourceOnly, 2, Some(20), None),
        ]);
        // Real DB independently changed row 1 too, and row 3 (no overlap).
        let external = data_diff(vec![
            row_diff(RowStatus::Different, 1, Some(50), Some(10)),
            row_diff(RowStatus::SourceOnly, 3, Some(30), None),
        ]);
        let conflicts = detect_conflicts(&desired, &external);
        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0].key, vec![Value::Int(1)]);
        assert_eq!(conflicts[0].desired_status, RowStatus::Different);
        assert_eq!(conflicts[0].external_status, RowStatus::Different);
        assert_eq!(
            conflicts[0].external_row,
            Some(vec![Value::Int(1), Value::Int(50)])
        );
    }

    #[test]
    fn detect_conflicts_skips_rows_both_sides_changed_to_the_same_value() {
        let desired = data_diff(vec![
            // 両側が同じ値 (99) に更新 → 収束。
            row_diff(RowStatus::Different, 1, Some(99), Some(10)),
            // 両側が別の値へ更新 → 衝突。
            row_diff(RowStatus::Different, 2, Some(1), Some(10)),
            // 両側が削除 → 収束。
            row_diff(RowStatus::TargetOnly, 3, None, Some(10)),
            // 両側が同じ行を追加 → INSERT が重複するので衝突のまま。
            row_diff(RowStatus::SourceOnly, 4, Some(7), None),
        ]);
        let external = data_diff(vec![
            row_diff(RowStatus::Different, 1, Some(99), Some(10)),
            row_diff(RowStatus::Different, 2, Some(2), Some(10)),
            row_diff(RowStatus::TargetOnly, 3, None, Some(10)),
            row_diff(RowStatus::SourceOnly, 4, Some(7), None),
        ]);
        let keys: Vec<Value> = detect_conflicts(&desired, &external)
            .into_iter()
            .flat_map(|c| c.key)
            .collect();
        assert_eq!(keys, vec![Value::Int(2), Value::Int(4)]);
    }

    #[test]
    fn detect_conflicts_empty_when_no_key_overlap() {
        let desired = data_diff(vec![row_diff(RowStatus::SourceOnly, 1, Some(1), None)]);
        let external = data_diff(vec![row_diff(RowStatus::SourceOnly, 2, Some(2), None)]);
        assert!(detect_conflicts(&desired, &external).is_empty());
    }

    #[test]
    fn filter_out_keys_drops_only_matching_rows() {
        let diff = data_diff(vec![
            row_diff(RowStatus::Different, 1, Some(1), Some(0)),
            row_diff(RowStatus::Different, 2, Some(2), Some(0)),
        ]);
        let filtered = filter_out_keys(&diff, &[vec![Value::Int(1)]]);
        assert_eq!(filtered.rows.len(), 1);
        assert_eq!(filtered.rows[0].key, vec![Value::Int(2)]);
        // Everything else is preserved verbatim.
        assert_eq!(filtered.table, diff.table);
        assert_eq!(filtered.target_driver, diff.target_driver);
    }

    #[test]
    fn filter_out_keys_matches_binary_pk_after_json_roundtrip() {
        let mut diff = data_diff(vec![RowDiff {
            status: RowStatus::Different,
            key: vec![Value::Bytes("aabb".into())],
            source: None,
            target: None,
            changed_columns: vec![],
            key_unreliable: false,
        }]);
        diff.columns = vec!["id".to_string()];
        diff.column_types = vec!["binary(16)".to_string()];
        // JSON 往復後は Bytes が String になる。
        let filtered = filter_out_keys(&diff, &[vec![Value::String("aabb".into())]]);
        assert!(filtered.rows.is_empty());
    }

    #[test]
    fn filter_out_keys_is_a_noop_with_no_skips() {
        let diff = data_diff(vec![row_diff(RowStatus::Different, 1, Some(1), Some(0))]);
        let filtered = filter_out_keys(&diff, &[]);
        assert_eq!(filtered.rows.len(), 1);
    }

    fn table_diff(name: &str, status: DiffStatus) -> TableDiff {
        TableDiff {
            name: name.to_string(),
            status,
            foreign_keys: vec![],
            columns: Vec::<ColumnDiff>::new(),
        }
    }

    fn schema_diff(tables: Vec<TableDiff>) -> SchemaDiff {
        SchemaDiff {
            source_driver: DriverKind::Sqlite,
            target_driver: DriverKind::Mysql,
            tables,
            warnings: Vec::new(),
        }
    }

    #[test]
    fn schema_conflict_tables_only_lists_tables_changed_on_both_sides() {
        let desired = schema_diff(vec![
            table_diff("orders", DiffStatus::Different),
            table_diff("customers", DiffStatus::Same),
        ]);
        let external = schema_diff(vec![
            table_diff("orders", DiffStatus::Different),
            table_diff("customers", DiffStatus::Different),
        ]);
        // customers changed externally but not in the sandbox -> not a
        // conflict (nothing to overwrite there); orders changed on both.
        assert_eq!(
            schema_conflict_tables(&desired, &external),
            vec!["orders".to_string()]
        );
    }

    fn col_info(name: &str, ty: &str) -> TableColumnInfo {
        TableColumnInfo {
            name: name.to_string(),
            data_type: ty.to_string(),
            nullable: true,
            key: String::new(),
            default: None,
            extra: String::new(),
            referenced_table: None,
            referenced_column: None,
            comment: None,
        }
    }

    fn changed_table(name: &str, new_type: &str) -> TableDiff {
        TableDiff {
            name: name.to_string(),
            status: DiffStatus::Different,
            foreign_keys: vec![],
            columns: vec![ColumnDiff {
                name: "qty".into(),
                status: DiffStatus::Different,
                source: Some(col_info("qty", new_type)),
                target: Some(col_info("qty", "int")),
                changed_fields: vec!["data_type".into()],
            }],
        }
    }

    #[test]
    fn schema_conflict_tables_skips_tables_both_sides_changed_identically() {
        // 両側が同じ ALTER を当てた表は収束済みなので衝突にしない (#1612)。
        let desired = schema_diff(vec![
            changed_table("same_alter", "bigint"),
            changed_table("diverged", "bigint"),
        ]);
        let external = schema_diff(vec![
            changed_table("same_alter", "BIGINT"),
            changed_table("diverged", "text"),
        ]);
        assert_eq!(
            schema_conflict_tables(&desired, &external),
            vec!["diverged".to_string()]
        );
    }

    #[test]
    fn schema_conflict_tables_empty_when_nothing_overlaps() {
        let desired = schema_diff(vec![table_diff("orders", DiffStatus::Different)]);
        let external = schema_diff(vec![table_diff("customers", DiffStatus::Different)]);
        assert!(schema_conflict_tables(&desired, &external).is_empty());
    }

    #[test]
    fn normalize_decimal_cells_unifies_string_int_and_float() {
        let types = vec!["int".to_string(), "decimal(10,2)".to_string()];
        let rows = vec![
            vec![Value::Int(1), Value::String("10.50".into())],
            vec![Value::Int(2), Value::Float(10.5)],
            vec![Value::Int(3), Value::Int(10)],
            vec![Value::Int(4), Value::String("n/a".into())],
            vec![Value::Int(5), Value::Null],
        ];
        let n = normalize_decimal_cells(&types, &rows);
        assert_eq!(n[0], vec![Value::Int(1), Value::Float(10.5)]);
        assert_eq!(n[1][1], n[0][1]);
        assert_eq!(n[2][1], Value::Int(10));
        // 数値に読めない値・NULL・非 DECIMAL 列はそのまま。
        assert_eq!(n[3][1], Value::String("n/a".into()));
        assert_eq!(n[4][1], Value::Null);
        assert_eq!(n[0][0], Value::Int(1));
    }

    #[test]
    fn normalize_decimal_cells_keeps_integers_beyond_2_pow_53_exact() {
        let types = vec!["decimal(20,0)".to_string()];
        let rows = vec![
            vec![Value::String("9007199254740993".into())],
            vec![Value::String("9007199254740992".into())],
            vec![Value::String("9007199254740993.00".into())],
            vec![Value::Int(9_007_199_254_740_993)],
            vec![Value::Float(10.0)],
            vec![Value::String("10.00".into())],
        ];
        let n = normalize_decimal_cells(&types, &rows);
        assert_ne!(n[0], n[1]);
        assert_eq!(n[0], n[2]);
        assert_eq!(n[0], n[3]);
        assert_eq!(n[4], n[5]);
    }

    #[test]
    fn decimal_rows_changed_to_the_same_value_converge_across_representations() {
        let mut desired = data_diff(vec![row_diff(RowStatus::Different, 1, Some(0), Some(0))]);
        let mut external = desired.clone();
        desired.column_types = vec!["int".to_string(), "decimal(10,2)".to_string()];
        desired.rows[0].source = Some(vec![Value::Int(1), Value::Float(10.5)]);
        external.rows[0].source = Some(vec![Value::Int(1), Value::String("10.50".into())]);
        assert!(detect_conflicts(&desired, &external).is_empty());
    }

    #[test]
    fn external_schema_compare_ignores_extra_fk_and_comment_missing_from_sqlite_base() {
        use super::super::diff::compute_schema_diff;
        let col = |extra: &str, fk: Option<&str>, comment: Option<&str>| TableColumnInfo {
            name: "id".to_string(),
            data_type: "int".to_string(),
            nullable: false,
            key: "PRI".to_string(),
            default: None,
            extra: extra.to_string(),
            referenced_table: fk.map(str::to_string),
            referenced_column: fk.map(|_| "id".to_string()),
            comment: comment.map(str::to_string),
        };
        let mut current = vec![TableColumns {
            name: "t".to_string(),
            columns: vec![col("auto_increment", Some("p"), Some("c"))],
        }];
        let base = vec![TableColumns {
            name: "t".to_string(),
            columns: vec![col("", None, None)],
        }];
        let before = compute_schema_diff(DriverKind::Mysql, DriverKind::Mysql, &current, &base);
        assert_eq!(before.tables[0].status, DiffStatus::Different);
        normalize_columns_for_sqlite_base(&mut current);
        let after = compute_schema_diff(DriverKind::Mysql, DriverKind::Mysql, &current, &base);
        assert_eq!(after.tables[0].status, DiffStatus::Same);
    }
}
