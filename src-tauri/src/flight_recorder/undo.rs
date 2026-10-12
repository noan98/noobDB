//! Pure reverse-SQL generation and conflict detection for undoing a captured
//! write (#735). No I/O here — the command layer (`commands::flight_recorder`)
//! fetches the live "current" rows and feeds them in, so this stays testable
//! without a database.
//!
//! Reverse SQL is rendered entirely by [`crate::db::data_diff::generate_data_sync_sql`]
//! (the same generator schema/data sync already uses) by translating the
//! captured before/after image into a one-off [`DataDiff`]:
//!
//! | Original write | Undo intent | `RowDiff` shape                              |
//! |-----------------|-------------|-----------------------------------------------|
//! | `INSERT`        | `DELETE`    | `TargetOnly { target: <captured row> }`        |
//! | `DELETE`        | `INSERT`    | `SourceOnly { source: <captured row> }`        |
//! | `UPDATE`        | `UPDATE`    | `Different { source: <before>, target: <current> }` |
//!
//! No new literal-escaping or SQL-rendering code is written here — this
//! module only classifies rows and lets `generate_data_sync_sql` do the
//! rendering, so the reverse SQL is exactly as dialect-safe as schema/data
//! sync already is.

use std::collections::HashMap;

use serde::Serialize;

use crate::db::data_diff::{
    generate_data_sync_sql, restore_binary_rows, DataDiff, RowDiff, RowStatus,
};
use crate::db::types::Value;
use crate::db::{DriverKind, WriteKind};

use super::WriteCaptureRecord;

/// One row where the live database no longer matches what was captured (or,
/// for a `DELETE` undo, where a row now occupies the primary key that was
/// captured as absent). Surfaced to the user before applying so they can
/// choose to skip the whole undo or force it through anyway.
#[derive(Debug, Clone, Serialize)]
pub struct UndoConflict {
    pub key: Vec<Value>,
    /// What the flight recorder expected to find (the row as it stood right
    /// after the original write), or `None` when nothing was expected to
    /// exist there (a `DELETE` undo re-inserting a row).
    pub expected: Option<Vec<Value>>,
    /// What is actually there right now, or `None` when the row is gone.
    pub current: Option<Vec<Value>>,
}

/// The result of planning an undo: the reverse SQL to run (possibly empty —
/// e.g. every row already matches the desired end state) plus any detected
/// conflicts and generator warnings.
#[derive(Debug, Clone, Serialize, Default)]
pub struct UndoPlan {
    pub statements: Vec<String>,
    pub conflicts: Vec<UndoConflict>,
    pub warnings: Vec<String>,
}

/// Tagged signature identical in spirit to `db::data_diff`'s private
/// `key_signature` / `db::row_signature` — kept as its own tiny copy since
/// none of the three call sites share any other coupling worth introducing a
/// dependency for.
fn key_sig(values: &[Value]) -> String {
    values
        .iter()
        .map(|v| format!("{v:?}"))
        .collect::<Vec<_>>()
        .join("\u{1f}")
}

/// Extracts the primary-key values from `row` at `pk_idx`, or `None` if `row`
/// is shorter than expected. `WriteCaptureRecord` round-trips through JSON in
/// the local SQLite store, so a corrupted/truncated row (or a `columns`
/// mismatch after a schema change) must never panic here — the caller skips
/// the row (with a warning) instead (#735 review follow-up).
fn key_of(row: &[Value], pk_idx: &[usize]) -> Option<Vec<Value>> {
    pk_idx.iter().map(|&i| row.get(i).cloned()).collect()
}

/// Builds the reverse-SQL plan for `record`. `current_rows` are the live rows
/// re-fetched by primary key (via `Connection::fetch_rows_by_pk`, in the same
/// `columns` order as the capture) — pass an empty slice for any primary key
/// whose row no longer exists.
///
/// `force`: when `false` (the default "preview" / first-attempt mode), a row
/// whose live state has drifted from what was captured is left out of
/// `statements` and reported in `conflicts` instead, so nothing is applied
/// until the caller re-invokes with `force: true` after the user reviews the
/// conflicts. When `true`, every row that has *some* sane action gets a
/// statement anyway, computed against the row's *current* live value (so a
/// forced `UPDATE` undo, for example, only touches columns that still differ
/// from the desired before-value, not blindly overwriting whatever changed).
/// A row with nothing sensible to do (e.g. an `UPDATE` undo whose target row
/// no longer exists at all) never gets a statement, `force` or not.
pub fn build_undo_plan(
    record: &WriteCaptureRecord,
    current_rows: &[Vec<Value>],
    force: bool,
) -> UndoPlan {
    let pk_idx: Vec<usize> = record
        .primary_key
        .iter()
        .filter_map(|name| record.columns.iter().position(|c| c == name))
        .collect();
    if pk_idx.len() != record.primary_key.len() || pk_idx.is_empty() {
        return UndoPlan {
            statements: Vec::new(),
            conflicts: Vec::new(),
            warnings: vec!["主キー列を特定できませんでした".to_string()],
        };
    }

    let mut warnings: Vec<String> = Vec::new();
    // 退避側 (JSON 往復後は BLOB が `String`) とライブ側 (`Bytes`) の表現を、
    // `column_types` を手掛かりに `Bytes` へ揃えてから比較する。揃えないと BLOB 列を
    // 含む行は常に不一致になり、BLOB 主キーの行は INSERT/DELETE の Undo で
    // キーが一致せず誤った計画になる。
    let current_rows =
        &restore_binary_rows(&record.columns, &record.column_types, current_rows.to_vec());
    let record_before = restore_binary_rows(
        &record.columns,
        &record.column_types,
        record.before_rows.clone(),
    );
    let record_after = restore_binary_rows(
        &record.columns,
        &record.column_types,
        record.after_rows.clone(),
    );
    let current_by_key: HashMap<String, Vec<Value>> = current_rows
        .iter()
        .filter_map(|row| match key_of(row, &pk_idx) {
            Some(key) => Some((key_sig(&key), row.clone())),
            None => {
                warnings.push(
                    "現在のデータの一部の行が想定より短く、キーを特定できませんでした (無視して続行します)"
                        .to_string(),
                );
                None
            }
        })
        .collect();

    let mut rows: Vec<RowDiff> = Vec::new();
    let mut conflicts: Vec<UndoConflict> = Vec::new();

    match record.kind {
        WriteKind::Insert => {
            // Undo = DELETE the row the original INSERT created.
            for after in &record_after {
                let Some(key) = key_of(after, &pk_idx) else {
                    warnings
                        .push("退避された挿入行の一部が壊れているためスキップしました".to_string());
                    continue;
                };
                let current = current_by_key.get(&key_sig(&key)).cloned();
                match current {
                    None => {
                        // Already gone — the desired end state (row absent)
                        // already holds. Nothing to do, no conflict.
                    }
                    Some(cur) if cur == *after => {
                        rows.push(RowDiff {
                            status: RowStatus::TargetOnly,
                            key,
                            source: None,
                            target: Some(cur),
                            changed_columns: Vec::new(),
                            key_unreliable: false,
                        });
                    }
                    Some(cur) => {
                        conflicts.push(UndoConflict {
                            key: key.clone(),
                            expected: Some(after.clone()),
                            current: Some(cur.clone()),
                        });
                        if force {
                            rows.push(RowDiff {
                                status: RowStatus::TargetOnly,
                                key,
                                source: None,
                                target: Some(cur),
                                changed_columns: Vec::new(),
                                key_unreliable: false,
                            });
                        }
                    }
                }
            }
        }
        WriteKind::Delete => {
            // Undo = INSERT the row the original DELETE removed.
            for before in &record_before {
                let Some(key) = key_of(before, &pk_idx) else {
                    warnings
                        .push("退避された削除行の一部が壊れているためスキップしました".to_string());
                    continue;
                };
                let current = current_by_key.get(&key_sig(&key)).cloned();
                match current {
                    None => {
                        rows.push(RowDiff {
                            status: RowStatus::SourceOnly,
                            key,
                            source: Some(before.clone()),
                            target: None,
                            changed_columns: Vec::new(),
                            key_unreliable: false,
                        });
                    }
                    Some(cur) => {
                        // Something already occupies this primary key again —
                        // re-inserting would collide or silently coexist with
                        // unrelated data.
                        conflicts.push(UndoConflict {
                            key: key.clone(),
                            expected: None,
                            current: Some(cur),
                        });
                        if force {
                            rows.push(RowDiff {
                                status: RowStatus::SourceOnly,
                                key,
                                source: Some(before.clone()),
                                target: None,
                                changed_columns: Vec::new(),
                                key_unreliable: false,
                            });
                        }
                    }
                }
            }
        }
        WriteKind::Update => {
            // Undo = UPDATE back to the captured before-values. Pairs are
            // captured index-aligned (same PK) by `Connection::capture_write`.
            let n = record_before.len().min(record_after.len());
            for i in 0..n {
                let before = &record_before[i];
                let after = &record_after[i];
                let Some(key) = key_of(before, &pk_idx) else {
                    warnings
                        .push("退避された更新行の一部が壊れているためスキップしました".to_string());
                    continue;
                };
                let current = current_by_key.get(&key_sig(&key)).cloned();
                match current {
                    None => {
                        conflicts.push(UndoConflict {
                            key,
                            expected: Some(after.clone()),
                            current: None,
                        });
                        // Nothing sensible to UPDATE — the row is gone.
                    }
                    Some(cur) if cur == *after => {
                        rows.push(RowDiff {
                            status: RowStatus::Different,
                            key,
                            source: Some(before.clone()),
                            target: Some(cur),
                            changed_columns: changed_columns(
                                &record.columns,
                                &pk_idx,
                                before,
                                after,
                            ),
                            key_unreliable: false,
                        });
                    }
                    Some(cur) => {
                        conflicts.push(UndoConflict {
                            key: key.clone(),
                            expected: Some(after.clone()),
                            current: Some(cur.clone()),
                        });
                        if force {
                            rows.push(RowDiff {
                                status: RowStatus::Different,
                                key,
                                source: Some(before.clone()),
                                target: Some(cur.clone()),
                                changed_columns: changed_columns(
                                    &record.columns,
                                    &pk_idx,
                                    before,
                                    &cur,
                                ),
                                key_unreliable: false,
                            });
                        }
                    }
                }
            }
        }
        WriteKind::Other => {
            // Never captured, so never reaches here in practice; treat as
            // nothing to undo rather than panicking on an unexpected record.
        }
    }

    let driver = match DriverKind::parse(&record.driver) {
        Some(d) => d,
        None => {
            warnings.push(format!(
                "記録されたドライバ '{}' を解釈できませんでした",
                record.driver
            ));
            return UndoPlan {
                statements: Vec::new(),
                conflicts,
                warnings,
            };
        }
    };

    let row_count = rows.len();
    let diff = DataDiff {
        target_driver: driver,
        table: record.table.clone(),
        columns: record.columns.clone(),
        primary_key: record.primary_key.clone(),
        column_types: record.column_types.clone(),
        rows,
        truncated: false,
        source_count: row_count,
        target_count: row_count,
        generated_columns: Vec::new(),
    };
    // allow_delete=true is intentional and always safe here: a `DELETE`
    // statement is only ever generated for an `Insert`-undo `TargetOnly` row,
    // which is exactly the recorded row this specific undo action is about —
    // not a general destructive-sync toggle.
    let plan = generate_data_sync_sql(&diff, true);
    warnings.extend(plan.warnings);

    UndoPlan {
        statements: plan.statements.into_iter().map(|s| s.sql).collect(),
        conflicts,
        warnings,
    }
}

/// Redo (#1536) 用に、取り消し済みの記録を「その取り消しをさらに取り消す」向きへ反転する。
/// Undo の `INSERT` は `DELETE` を、`DELETE` は `INSERT` を、`UPDATE` は逆向きの
/// `UPDATE` を作る。Redo は元の書き込みの再適用なので、`INSERT` ⇔ `DELETE` を入れ替え、
/// before / after を入れ替えた記録に対して同じ [`build_undo_plan`] を使えばよい
/// (衝突検出・`force` の扱いも Undo と同一になり、新しい SQL 生成は要らない)。
///
/// | 元の書き込み | 反転後の記録 | Redo が流す文 |
/// |---|---|---|
/// | `INSERT` | `DELETE` (before = 元の after) | `INSERT` |
/// | `DELETE` | `INSERT` (after = 元の before) | `DELETE` |
/// | `UPDATE` | `UPDATE` (before ⇔ after) | 元の after への `UPDATE` |
pub fn invert_for_redo(record: &WriteCaptureRecord) -> WriteCaptureRecord {
    let mut inverted = record.clone();
    match record.kind {
        WriteKind::Insert => {
            inverted.kind = WriteKind::Delete;
            inverted.before_rows = record.after_rows.clone();
            inverted.after_rows = Vec::new();
        }
        WriteKind::Delete => {
            inverted.kind = WriteKind::Insert;
            inverted.before_rows = Vec::new();
            inverted.after_rows = record.before_rows.clone();
        }
        WriteKind::Update => {
            inverted.before_rows = record.after_rows.clone();
            inverted.after_rows = record.before_rows.clone();
        }
        WriteKind::Other => {}
    }
    inverted
}

/// 取り消し済みの記録を再適用する Redo の計画 (#1536)。`current_rows` は
/// [`invert_for_redo`] した記録の主キーで取り直したライブ行。
pub fn build_redo_plan(
    record: &WriteCaptureRecord,
    current_rows: &[Vec<Value>],
    force: bool,
) -> UndoPlan {
    build_undo_plan(&invert_for_redo(record), current_rows, force)
}

/// Non-key column names whose values differ between `before` and `after`, in
/// `columns` order. Mirrors `db::data_diff`'s private helper of the same
/// purpose; `generate_data_sync_sql` needs this list on the `Different`
/// `RowDiff` to know which columns to `SET`.
fn changed_columns(
    columns: &[String],
    pk_idx: &[usize],
    before: &[Value],
    after: &[Value],
) -> Vec<String> {
    let mut changed = Vec::new();
    for (i, name) in columns.iter().enumerate() {
        if pk_idx.contains(&i) {
            continue;
        }
        if before.get(i) != after.get(i) {
            changed.push(name.clone());
        }
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(kind: WriteKind) -> WriteCaptureRecord {
        WriteCaptureRecord {
            id: 1,
            profile_id: Some("p1".to_string()),
            driver: "sqlite".to_string(),
            database: None,
            table: "users".to_string(),
            kind,
            sql: "".to_string(),
            primary_key: vec!["id".to_string()],
            columns: vec!["id".to_string(), "name".to_string()],
            column_types: vec!["INTEGER".to_string(), "TEXT".to_string()],
            before_rows: Vec::new(),
            after_rows: Vec::new(),
            rows_affected: 0,
            captured_at: "2026-01-01T00:00:00Z".to_string(),
            undone: false,
        }
    }

    fn row(id: i64, name: &str) -> Vec<Value> {
        vec![Value::Int(id), Value::String(name.to_string())]
    }

    #[test]
    fn redo_of_insert_reinserts_the_row_when_it_is_absent() {
        let mut r = record(WriteKind::Insert);
        r.undone = true;
        r.after_rows = vec![row(1, "alice")];
        let plan = build_redo_plan(&r, &[], false);
        assert!(plan.conflicts.is_empty());
        assert_eq!(plan.statements.len(), 1);
        assert!(plan.statements[0].starts_with("INSERT INTO \"users\""));
    }

    #[test]
    fn redo_of_insert_conflicts_when_a_row_occupies_the_key() {
        let mut r = record(WriteKind::Insert);
        r.undone = true;
        r.after_rows = vec![row(1, "alice")];
        let plan = build_redo_plan(&r, &[row(1, "other")], false);
        assert_eq!(plan.conflicts.len(), 1);
        assert!(plan.statements.is_empty());
        let forced = build_redo_plan(&r, &[row(1, "other")], true);
        assert_eq!(forced.statements.len(), 1);
    }

    #[test]
    fn redo_of_delete_deletes_the_restored_row() {
        let mut r = record(WriteKind::Delete);
        r.undone = true;
        r.before_rows = vec![row(2, "bob")];
        let plan = build_redo_plan(&r, &[row(2, "bob")], false);
        assert!(plan.conflicts.is_empty());
        assert_eq!(
            plan.statements,
            vec![r#"DELETE FROM "users" WHERE "id" = 2"#]
        );
        // 既に消えているなら何もしない。
        assert!(build_redo_plan(&r, &[], false).statements.is_empty());
    }

    #[test]
    fn redo_of_update_reapplies_the_after_values() {
        let mut r = record(WriteKind::Update);
        r.undone = true;
        r.before_rows = vec![row(1, "alice")];
        r.after_rows = vec![row(1, "alice2")];
        // Undo 後なので、ライブ行は before の値。
        let plan = build_redo_plan(&r, &[row(1, "alice")], false);
        assert!(plan.conflicts.is_empty());
        assert_eq!(plan.statements.len(), 1);
        assert!(
            plan.statements[0].contains("alice2"),
            "{:?}",
            plan.statements
        );
        // Undo 後に別の値へ変わっていたら衝突。
        let plan = build_redo_plan(&r, &[row(1, "zzz")], false);
        assert_eq!(plan.conflicts.len(), 1);
        assert!(plan.statements.is_empty());
    }

    #[test]
    fn insert_undo_deletes_when_current_matches_captured_after() {
        let mut r = record(WriteKind::Insert);
        r.after_rows = vec![row(1, "alice")];
        let current = vec![row(1, "alice")];
        let plan = build_undo_plan(&r, &current, false);
        assert!(plan.conflicts.is_empty());
        assert_eq!(
            plan.statements,
            vec![r#"DELETE FROM "users" WHERE "id" = 1"#]
        );
    }

    #[test]
    fn insert_undo_is_a_noop_when_row_already_gone() {
        let mut r = record(WriteKind::Insert);
        r.after_rows = vec![row(1, "alice")];
        let plan = build_undo_plan(&r, &[], false);
        assert!(plan.conflicts.is_empty());
        assert!(plan.statements.is_empty());
    }

    #[test]
    fn insert_undo_flags_conflict_when_row_drifted() {
        let mut r = record(WriteKind::Insert);
        r.after_rows = vec![row(1, "alice")];
        let current = vec![row(1, "bob")]; // someone renamed it since
        let without_force = build_undo_plan(&r, &current, false);
        assert_eq!(without_force.conflicts.len(), 1);
        assert!(without_force.statements.is_empty());

        let forced = build_undo_plan(&r, &current, true);
        assert_eq!(forced.conflicts.len(), 1);
        assert_eq!(
            forced.statements,
            vec![r#"DELETE FROM "users" WHERE "id" = 1"#]
        );
    }

    #[test]
    fn delete_undo_inserts_when_pk_still_free() {
        let mut r = record(WriteKind::Delete);
        r.before_rows = vec![row(1, "alice")];
        let plan = build_undo_plan(&r, &[], false);
        assert!(plan.conflicts.is_empty());
        assert_eq!(
            plan.statements,
            vec![r#"INSERT INTO "users" ("id", "name") VALUES (1, 'alice')"#]
        );
    }

    #[test]
    fn delete_undo_flags_conflict_when_pk_reused() {
        let mut r = record(WriteKind::Delete);
        r.before_rows = vec![row(1, "alice")];
        let current = vec![row(1, "someone_else")];
        let without_force = build_undo_plan(&r, &current, false);
        assert_eq!(without_force.conflicts.len(), 1);
        assert!(without_force.statements.is_empty());

        let forced = build_undo_plan(&r, &current, true);
        assert_eq!(forced.statements.len(), 1);
    }

    #[test]
    fn update_undo_restores_before_values_when_undrifted() {
        let mut r = record(WriteKind::Update);
        r.before_rows = vec![row(1, "alice")];
        r.after_rows = vec![row(1, "alice2")];
        let current = vec![row(1, "alice2")]; // matches captured after — untouched since
        let plan = build_undo_plan(&r, &current, false);
        assert!(plan.conflicts.is_empty());
        assert_eq!(
            plan.statements,
            vec![r#"UPDATE "users" SET "name" = 'alice' WHERE "id" = 1"#]
        );
    }

    #[test]
    fn update_undo_flags_conflict_when_someone_else_changed_it_since() {
        let mut r = record(WriteKind::Update);
        r.before_rows = vec![row(1, "alice")];
        r.after_rows = vec![row(1, "alice2")];
        let current = vec![row(1, "carol")]; // drifted from the captured after-value
        let without_force = build_undo_plan(&r, &current, false);
        assert_eq!(without_force.conflicts.len(), 1);
        assert!(without_force.statements.is_empty());

        let forced = build_undo_plan(&r, &current, true);
        // Restores toward the before-value from whatever is live now.
        assert_eq!(
            forced.statements,
            vec![r#"UPDATE "users" SET "name" = 'alice' WHERE "id" = 1"#]
        );
    }

    #[test]
    fn update_undo_skips_row_entirely_when_it_no_longer_exists() {
        let mut r = record(WriteKind::Update);
        r.before_rows = vec![row(1, "alice")];
        r.after_rows = vec![row(1, "alice2")];
        let forced = build_undo_plan(&r, &[], true);
        assert_eq!(forced.conflicts.len(), 1);
        assert!(
            forced.statements.is_empty(),
            "nothing sensible to UPDATE when the row is gone, even with force"
        );
    }

    #[test]
    fn truncated_stored_row_is_skipped_with_a_warning_instead_of_panicking() {
        // #735 レビュー対応: 保存済み行 (JSON 往復) が壊れていて primary_key の
        // 列位置より短い場合、direct index の panic ではなく警告付きスキップに
        // なることを固定する。primary_key を columns の 2 番目 ("name") に
        // 向けることで、1 要素しかない壊れた行がその列位置を持たない状況を
        // 実際に再現する (id 列だけの主キーだと壊れた行の index 0 は残って
        // しまい、key_of が偶然成功してしまうため)。
        let mut r = record(WriteKind::Insert);
        r.primary_key = vec!["name".to_string()];
        r.after_rows = vec![vec![Value::Int(1)]]; // "name" 列が欠落した壊れた行
        let plan = build_undo_plan(&r, &[], false);
        assert!(plan.statements.is_empty());
        assert!(plan.conflicts.is_empty());
        assert!(!plan.warnings.is_empty());
    }

    #[test]
    fn truncated_current_row_is_skipped_with_a_warning_instead_of_panicking() {
        // primary_key を "name" (columns の index 1) に向け、1 要素しかない
        // 壊れた current 行がその列位置を欠いた状態を再現する (id だけの主キー
        // だと index 0 が残ってしまい key_of が成功してしまうため)。
        let mut r = record(WriteKind::Update);
        r.primary_key = vec!["name".to_string()];
        r.before_rows = vec![row(1, "alice")];
        r.after_rows = vec![row(1, "alice2")];
        let current = vec![vec![Value::Int(1)]]; // 壊れた現在行
        let plan = build_undo_plan(&r, &current, false);
        // The malformed current row is dropped from `current_by_key`, so the
        // target key resolves to "row is gone" instead.
        assert_eq!(plan.conflicts.len(), 1);
        assert!(!plan.warnings.is_empty());
    }

    #[test]
    fn unresolvable_primary_key_produces_a_warning_and_no_statements() {
        let mut r = record(WriteKind::Update);
        r.primary_key = vec!["missing_col".to_string()];
        r.before_rows = vec![row(1, "alice")];
        r.after_rows = vec![row(1, "alice2")];
        let plan = build_undo_plan(&r, &[], false);
        assert!(plan.statements.is_empty());
        assert!(!plan.warnings.is_empty());
    }

    fn blob_record(kind: WriteKind) -> WriteCaptureRecord {
        let mut r = record(kind);
        r.columns = vec!["id".to_string(), "data".to_string()];
        r.column_types = vec!["INTEGER".to_string(), "BLOB".to_string()];
        r
    }

    // JSON 往復後は BLOB 値が `String` に戻る。ライブ行 (`Bytes`) と比べても
    // 競合扱いにならないこと。
    #[test]
    fn update_undo_does_not_flag_blob_rows_as_conflicts_after_json_round_trip() {
        let mut r = blob_record(WriteKind::Update);
        r.before_rows = vec![vec![Value::Int(1), Value::String("00ff".into())]];
        r.after_rows = vec![vec![Value::Int(1), Value::String("ab12".into())]];
        let current = vec![vec![Value::Int(1), Value::Bytes("ab12".into())]];
        let plan = build_undo_plan(&r, &current, false);
        assert!(plan.conflicts.is_empty(), "{:?}", plan.conflicts);
        assert_eq!(plan.statements.len(), 1);
    }

    // BLOB 主キーの INSERT を取り消す: キーが一致して DELETE が出ること。
    #[test]
    fn insert_undo_matches_blob_primary_key_after_json_round_trip() {
        let mut r = blob_record(WriteKind::Insert);
        r.columns = vec!["id".to_string(), "name".to_string()];
        r.column_types = vec!["BLOB".to_string(), "TEXT".to_string()];
        r.after_rows = vec![vec![
            Value::String("deadbeef".into()),
            Value::String("x".into()),
        ]];
        let current = vec![vec![
            Value::Bytes("deadbeef".into()),
            Value::String("x".into()),
        ]];
        let plan = build_undo_plan(&r, &current, false);
        assert!(plan.conflicts.is_empty(), "{:?}", plan.conflicts);
        assert_eq!(plan.statements.len(), 1);
        assert!(
            plan.statements[0].starts_with("DELETE"),
            "{:?}",
            plan.statements
        );
    }
}
