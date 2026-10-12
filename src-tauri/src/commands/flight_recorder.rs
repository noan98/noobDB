//! IPC surface for the DML flight recorder / one-click undo (#735).
//!
//! `run_captured_write_inner` wraps a single write statement's execution with a
//! best-effort before/after capture (`Connection::capture_write`) and, when
//! successful, persists it to the local `flight_recorder.sqlite` store. It is
//! reached through `run_query_stream({ capture: true })` rather than an IPC
//! command of its own (#907).
//! `list_flight_records` / `clear_flight_records` mirror the existing history
//! commands. `preview_undo` / `undo_flight_record` compute (and, for the
//! latter, apply) the reverse SQL via `flight_recorder::undo::build_undo_plan`.
//! `preview_redo` / `redo_flight_record` (#1536) are the mirror image for a
//! record that was already undone: they re-apply the original write by planning
//! an undo of the *inverted* record (`undo::invert_for_redo`), then go through
//! the very same conflict detection / `force` / read-only guard / history path.
//!
//! **Undo re-uses the existing write path end to end**: it calls
//! [`crate::commands::query::run_query_transaction_inner`] — the very same
//! all-or-nothing transaction command the cell-edit Apply flow uses — so the
//! read-only guard, per-statement validation, and history recording all apply
//! identically to a reverse write as to any other. No safety net is bypassed.

use serde::Serialize;
use tauri::State;

use crate::db::types::{QueryResult, Value};
use crate::db::{DriverKind, WriteKind, DEFAULT_CAPTURE_ROW_CAP};
use crate::error::{AppError, Result};
use crate::flight_recorder::undo::{
    build_redo_plan, build_undo_plan, invert_for_redo, UndoConflict,
};
use crate::flight_recorder::{persist_capture, store as flight_store, WriteCaptureSummary};
use crate::state::AppState;

use super::query::{ensure_allowed_for_session, record_write_history, run_query_transaction_inner};

#[derive(Debug, Serialize)]
pub struct CapturedWriteResponse {
    pub result: QueryResult,
    pub capturable: bool,
    pub reason: Option<String>,
    #[serde(rename = "captureId")]
    pub capture_id: Option<i64>,
}

/// Executes a single write statement (INSERT/UPDATE/DELETE) and attempts to
/// record a reversible before/after image of it. The write always goes
/// through — capture failing (unresolvable table/PK, over the row cap, ...)
/// never blocks it, it just comes back with `capturable: false`. Honors the
/// session's `read_only` guard exactly like `run_query`, and records to query
/// history exactly like `run_query_transaction` (skipped for `skip_history`
/// sessions, which also skip the flight-recorder capture itself).
///
/// **Not an IPC command.** The UI records writes through
/// `run_query_stream({ capture: true })` (`commands::query::spawn_captured_write`),
/// which funnels into this same core; the non-streaming `run_captured_write`
/// wrapper had no caller and was removed in #907. Integration tests drive this
/// through `__test_api::run_captured_write_via_command`.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn run_captured_write_inner(
    state: &AppState,
    session_id: String,
    sql: String,
    database: Option<String>,
    row_cap: Option<u32>,
    retention_days: Option<u32>,
) -> Result<CapturedWriteResponse> {
    let session = state
        .get(&session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;
    ensure_allowed_for_session(&session, &sql)?;

    let row_cap = row_cap
        .map(|n| n as usize)
        .unwrap_or(DEFAULT_CAPTURE_ROW_CAP);
    let started = std::time::Instant::now();
    let outcome = crate::commands::query::run_captured_write(
        session.clone(),
        sql.clone(),
        database.clone(),
        row_cap,
        None,
    )
    .await;
    let elapsed_ms = started.elapsed().as_millis() as i64;

    match &outcome {
        Ok((result, _)) => {
            record_write_history(
                &session,
                sql.clone(),
                database.as_deref(),
                Some(result.rows_affected as i64),
                Some(elapsed_ms),
                None,
            )
            .await;
        }
        Err(e) => {
            record_write_history(
                &session,
                sql.clone(),
                database.as_deref(),
                None,
                None,
                Some(e.to_string()),
            )
            .await;
        }
    }

    // Query Result Cache (#1097): この経路は capture 対象 (単文の
    // INSERT/UPDATE/DELETE) の書き込みが実際に成功した場合のみ、判定を挟まず
    // 常に invalidate する (`commands::query::spawn_captured_write` と同じ理由)。
    if outcome.is_ok() {
        session.query_cache.invalidate_all().await;
    }

    let (result, capture) = outcome?;

    let capture_id = persist_capture(
        session.skip_history,
        session.profile_id.clone(),
        session.conn.driver_kind(),
        database.clone(),
        sql.clone(),
        &capture,
        retention_days.map(|d| d as i64),
    )
    .await;

    Ok(CapturedWriteResponse {
        result,
        capturable: capture.capturable,
        reason: capture.reason,
        capture_id,
    })
}

const DEFAULT_LIST_LIMIT: i64 = 200;
const MAX_LIST_LIMIT: i64 = 1000;

#[tauri::command]
pub async fn list_flight_records(
    profile_id: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<WriteCaptureSummary>> {
    let limit = limit.unwrap_or(DEFAULT_LIST_LIMIT).clamp(1, MAX_LIST_LIMIT);
    flight_store::list(profile_id.as_deref(), limit).await
}

#[tauri::command]
pub async fn clear_flight_records(profile_id: Option<String>) -> Result<u64> {
    flight_store::clear(profile_id.as_deref()).await
}

#[derive(Debug, Serialize)]
pub struct UndoPreviewResponse {
    pub statements: Vec<String>,
    pub conflicts: Vec<UndoConflict>,
    pub warnings: Vec<String>,
}

/// Fetches the live rows for `record`'s captured primary keys and returns the
/// undo plan (reverse SQL + conflicts) without applying it — used to render
/// the "review before you undo" dialog. Force is always `false` here; the
/// caller decides whether to force-apply via [`undo_flight_record`].
#[tauri::command]
pub async fn preview_undo(
    session_id: String,
    id: i64,
    state: State<'_, AppState>,
) -> Result<UndoPreviewResponse> {
    let (plan, _record) = plan_undo(state.inner(), &session_id, id, false).await?;
    Ok(UndoPreviewResponse {
        statements: plan.statements,
        conflicts: plan.conflicts,
        warnings: plan.warnings,
    })
}

#[derive(Debug, Serialize)]
pub struct UndoOutcome {
    pub applied: bool,
    #[serde(rename = "rowsAffected")]
    pub rows_affected: u64,
    pub conflicts: Vec<UndoConflict>,
    pub warnings: Vec<String>,
}

/// Applies the reverse SQL for capture `id`. When conflicts are found and
/// `force` is false, nothing is applied and the conflicts are returned so the
/// caller can show them and let the user choose to skip or retry with
/// `force: true`. Goes through [`run_query_transaction_inner`] — the same
/// all-or-nothing path, read-only guard, and history recording as any other
/// write (see module docs).
#[tauri::command]
pub async fn undo_flight_record(
    session_id: String,
    id: i64,
    force: bool,
    state: State<'_, AppState>,
) -> Result<UndoOutcome> {
    undo_flight_record_inner(state.inner(), session_id, id, force).await
}

/// Redo のプレビュー (#1536): 取り消し済みの記録を再適用する SQL と衝突を返す。
/// 何も適用しない。
#[tauri::command]
pub async fn preview_redo(
    session_id: String,
    id: i64,
    state: State<'_, AppState>,
) -> Result<UndoPreviewResponse> {
    let (plan, _record) = plan_redo(state.inner(), &session_id, id, false).await?;
    Ok(UndoPreviewResponse {
        statements: plan.statements,
        conflicts: plan.conflicts,
        warnings: plan.warnings,
    })
}

/// 取り消し済みの記録をやり直す (Redo, #1536)。[`undo_flight_record`] と同じ衝突検出・
/// `force`・読み取り専用ガード・履歴記録の経路を通る。
#[tauri::command]
pub async fn redo_flight_record(
    session_id: String,
    id: i64,
    force: bool,
    state: State<'_, AppState>,
) -> Result<UndoOutcome> {
    redo_flight_record_inner(state.inner(), session_id, id, force).await
}

/// Core of [`undo_flight_record`] decoupled from Tauri's `State` wrapper so
/// integration tests can drive the exact command path. See
/// `commands::query::run_query_inner`'s doc comment for the pattern.
pub(crate) async fn undo_flight_record_inner(
    state: &AppState,
    session_id: String,
    id: i64,
    force: bool,
) -> Result<UndoOutcome> {
    apply_flight_plan(state, session_id, id, force, false).await
}

/// 取り消し済みの記録を再適用する (Redo, #1536)。衝突検出・`force`・読み取り専用ガード・
/// 履歴記録は Undo と同じ `run_query_transaction_inner` 経路をそのまま通る。成功すると
/// 記録は「取り消し済み」から元の状態へ戻り、もう一度 Undo できる。
pub(crate) async fn redo_flight_record_inner(
    state: &AppState,
    session_id: String,
    id: i64,
    force: bool,
) -> Result<UndoOutcome> {
    apply_flight_plan(state, session_id, id, force, true).await
}

async fn apply_flight_plan(
    state: &AppState,
    session_id: String,
    id: i64,
    force: bool,
    redo: bool,
) -> Result<UndoOutcome> {
    let (plan, record) = plan_flight(state, &session_id, id, force, redo).await?;

    if plan.statements.is_empty() {
        return Ok(UndoOutcome {
            applied: false,
            rows_affected: 0,
            conflicts: plan.conflicts,
            warnings: plan.warnings,
        });
    }
    if !plan.conflicts.is_empty() && !force {
        return Ok(UndoOutcome {
            applied: false,
            rows_affected: 0,
            conflicts: plan.conflicts,
            warnings: plan.warnings,
        });
    }

    let result = run_query_transaction_inner(
        state,
        session_id,
        plan.statements.clone(),
        record.database.clone(),
    )
    .await?;

    if redo {
        if let Err(e) = flight_store::mark_redone(id).await {
            tracing::warn!(error = %e, capture_id = id, "failed to mark flight recorder capture as redone");
        }
    } else if let Err(e) = flight_store::mark_undone(id).await {
        tracing::warn!(error = %e, capture_id = id, "failed to mark flight recorder capture as undone");
    }

    Ok(UndoOutcome {
        applied: true,
        rows_affected: result.rows_affected,
        conflicts: plan.conflicts,
        warnings: plan.warnings,
    })
}

/// Shared core of [`preview_undo`] / [`undo_flight_record`]: loads the
/// record, verifies it against the session (driver match, not already
/// undone), re-fetches the live rows for the captured primary keys, and
/// builds the undo plan.
pub(crate) async fn plan_undo(
    state: &AppState,
    session_id: &str,
    id: i64,
    force: bool,
) -> Result<(
    crate::flight_recorder::undo::UndoPlan,
    crate::flight_recorder::WriteCaptureRecord,
)> {
    plan_flight(state, session_id, id, force, false).await
}

/// [`plan_undo`] の Redo 版 (#1536)。取り消し済みの記録だけを受け付け、元の書き込みを
/// 再適用する計画を返す。
pub(crate) async fn plan_redo(
    state: &AppState,
    session_id: &str,
    id: i64,
    force: bool,
) -> Result<(
    crate::flight_recorder::undo::UndoPlan,
    crate::flight_recorder::WriteCaptureRecord,
)> {
    plan_flight(state, session_id, id, force, true).await
}

async fn plan_flight(
    state: &AppState,
    session_id: &str,
    id: i64,
    force: bool,
    redo: bool,
) -> Result<(
    crate::flight_recorder::undo::UndoPlan,
    crate::flight_recorder::WriteCaptureRecord,
)> {
    let session = state
        .get(session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.to_string()))?;
    let record = flight_store::get(id)
        .await?
        .ok_or_else(|| AppError::InvalidInput(format!("flight record {id} not found")))?;
    if redo {
        if !record.undone {
            return Err(AppError::InvalidInput(format!(
                "flight record {id} has not been undone"
            )));
        }
    } else if record.undone {
        return Err(AppError::FlightAlreadyUndone);
    }
    ensure_record_matches_session(
        &record,
        session.profile_id.as_deref(),
        session.conn.driver_kind(),
    )?;

    // Redo は反転した記録 (INSERT ⇔ DELETE、before ⇔ after) に対する Undo 計画として扱う。
    let effective = if redo {
        invert_for_redo(&record)
    } else {
        record.clone()
    };

    let pk_idx: Vec<usize> = effective
        .primary_key
        .iter()
        .filter_map(|n| effective.columns.iter().position(|c| c == n))
        .collect();
    if pk_idx.len() != effective.primary_key.len() {
        return Err(AppError::FlightPrimaryKeyUnresolved);
    }
    let reference_rows: &[Vec<Value>] = match effective.kind {
        WriteKind::Insert => &effective.after_rows,
        _ => &effective.before_rows,
    };
    // 保存済み行が壊れている (JSON 破損・列削除後の再実行など) 場合に direct
    // index で panic しないよう `get()` を使い、キーを特定できない行は無視する
    // (`build_undo_plan` 側が同じ行を独立に検出して警告付きスキップする)。
    let pk_values: Vec<Vec<Value>> = reference_rows
        .iter()
        .filter_map(|r| pk_idx.iter().map(|&i| r.get(i).cloned()).collect())
        .collect();
    let current_rows = session
        .conn
        .fetch_rows_by_pk(
            &record.table,
            &record.primary_key,
            &pk_values,
            record.database.as_deref(),
        )
        .await?;

    let plan = if redo {
        build_redo_plan(&record, &current_rows, force)
    } else {
        build_undo_plan(&record, &current_rows, force)
    };
    Ok((plan, record))
}

/// Validates that a stored capture (`record`) can be undone against the
/// session it is being applied to: same driver (the reverse SQL's literal
/// escaping is driver-specific — applying it against the wrong driver could
/// produce invalid or, worse, differently-interpreted SQL) **and** same
/// profile (#735 review follow-up: a capture from one connection must never
/// be replayed against an unrelated one, even an ad-hoc session that happens
/// to use the same driver). `record.profile_id` is `None` for a capture taken
/// on an ad-hoc (profile-less) connection, so this only matches another
/// ad-hoc session — never a saved profile.
fn ensure_record_matches_session(
    record: &crate::flight_recorder::WriteCaptureRecord,
    session_profile_id: Option<&str>,
    session_driver: DriverKind,
) -> Result<()> {
    let record_driver = DriverKind::parse(&record.driver)
        .ok_or_else(|| AppError::InvalidInput(format!("unknown driver: {}", record.driver)))?;
    if record_driver != session_driver {
        return Err(AppError::FlightDriverMismatch);
    }
    if record.profile_id.as_deref() != session_profile_id {
        return Err(AppError::FlightProfileMismatch);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::WriteKind;
    use crate::flight_recorder::WriteCaptureRecord;

    fn record(driver: &str, profile_id: Option<&str>) -> WriteCaptureRecord {
        WriteCaptureRecord {
            id: 1,
            profile_id: profile_id.map(str::to_string),
            driver: driver.to_string(),
            database: None,
            table: "t".to_string(),
            kind: WriteKind::Update,
            sql: String::new(),
            primary_key: vec!["id".to_string()],
            columns: vec!["id".to_string()],
            column_types: vec!["INTEGER".to_string()],
            before_rows: Vec::new(),
            after_rows: Vec::new(),
            rows_affected: 0,
            captured_at: "2026-01-01T00:00:00Z".to_string(),
            undone: false,
        }
    }

    #[test]
    fn matches_when_driver_and_profile_agree() {
        let r = record("sqlite", Some("p1"));
        assert!(ensure_record_matches_session(&r, Some("p1"), DriverKind::Sqlite).is_ok());
    }

    #[test]
    fn matches_when_both_are_ad_hoc_without_a_profile() {
        let r = record("sqlite", None);
        assert!(ensure_record_matches_session(&r, None, DriverKind::Sqlite).is_ok());
    }

    #[test]
    fn rejects_driver_mismatch() {
        let r = record("mysql", Some("p1"));
        let err = ensure_record_matches_session(&r, Some("p1"), DriverKind::Sqlite).unwrap_err();
        assert!(matches!(err, AppError::FlightDriverMismatch));
    }

    #[test]
    fn rejects_profile_mismatch_even_with_the_same_driver() {
        let r = record("sqlite", Some("p1"));
        let err = ensure_record_matches_session(&r, Some("p2"), DriverKind::Sqlite).unwrap_err();
        assert!(matches!(err, AppError::FlightProfileMismatch));
    }

    #[test]
    fn rejects_ad_hoc_capture_replayed_against_a_saved_profile() {
        let r = record("sqlite", None);
        let err = ensure_record_matches_session(&r, Some("p1"), DriverKind::Sqlite).unwrap_err();
        assert!(matches!(err, AppError::FlightProfileMismatch));
    }

    #[test]
    fn rejects_unknown_stored_driver_string() {
        let r = record("oracle", Some("p1"));
        let err = ensure_record_matches_session(&r, Some("p1"), DriverKind::Sqlite).unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)));
    }
}
