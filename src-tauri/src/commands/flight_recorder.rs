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
    build_redo_plan_with_generated, build_undo_plan_with_generated, invert_for_redo, UndoConflict,
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
        None,
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

/// 記録を消す。ピン留めした記録 (#1626) は `include_pinned` が true のときだけ消す
/// (既定は残す)。
#[tauri::command]
pub async fn clear_flight_records(
    profile_id: Option<String>,
    include_pinned: Option<bool>,
) -> Result<u64> {
    flight_store::clear(profile_id.as_deref(), include_pinned.unwrap_or(false)).await
}

/// 記録のピン留めを切り替える (#1626)。ピン留めした記録は件数・保持期間・容量の上限による
/// 自動削除の対象外。記録が無ければ `InvalidInput`、ピン留めの上限超過もエラー。
#[tauri::command]
pub async fn pin_flight_record(id: i64, pinned: bool) -> Result<()> {
    if flight_store::set_pinned(id, pinned).await? {
        Ok(())
    } else {
        Err(AppError::InvalidInput(format!(
            "flight record {id} not found"
        )))
    }
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
        // 実行する文は無いが、目的の状態が既に成立している (行が既に無い・手動で戻し済み)
        // ときは、記録を取り消し済み / やり直し済みにする。放置すると記録が永久に
        // 未取り消しのまま残り、押しても何も起きない Undo が並び続ける (#1600)。
        if plan.already_satisfied && plan.conflicts.is_empty() {
            let mut warnings = plan.warnings;
            if let Some(w) = mark_flight_state(id, redo).await {
                warnings.push(w);
            }
            return Ok(UndoOutcome {
                applied: true,
                rows_affected: 0,
                conflicts: plan.conflicts,
                warnings,
            });
        }
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

    // 逆 SQL は適用済みなので、記録の状態を保存できなくても失敗にはしない
    // (DB は元に戻っている)。ただし黙って成功扱いにせず、警告として利用者へ返す (#1600)。
    let mut warnings = plan.warnings;
    if let Some(w) = mark_flight_state(id, redo).await {
        warnings.push(w);
    }

    Ok(UndoOutcome {
        applied: true,
        rows_affected: result.rows_affected,
        conflicts: plan.conflicts,
        warnings,
    })
}

/// 取り消し (`redo` なら やり直し) 済みの状態を記録ストアへ保存する。失敗したら
/// 利用者に見せる警告文を返す (ログにも残す)。
async fn mark_flight_state(id: i64, redo: bool) -> Option<String> {
    let result = if redo {
        flight_store::mark_redone(id).await
    } else {
        flight_store::mark_undone(id).await
    };
    match result {
        Ok(()) => None,
        Err(e) => {
            tracing::warn!(error = %e, capture_id = id, redo, "failed to update flight recorder capture state");
            Some(if redo {
                "やり直しは適用しましたが、記録の状態を保存できませんでした (記録は取り消し済みのまま残ります)".to_string()
            } else {
                "取り消しは適用しましたが、記録の状態を保存できませんでした (記録は未取り消しのまま残ります。再度取り消さないでください)".to_string()
            })
        }
    }
}

/// バッチの全記録の取り消し / やり直し済みの状態を、ストア側の 1 トランザクションで保存する。
/// 途中で失敗しても一部だけ更新された状態にはならない。失敗したら警告文を返す。
async fn mark_flight_batch_state(
    records: &[crate::flight_recorder::WriteCaptureRecord],
    redo: bool,
) -> Option<String> {
    let ids: Vec<i64> = records.iter().map(|r| r.id).collect();
    match flight_store::mark_undone_many(&ids, !redo).await {
        Ok(()) => None,
        Err(e) => {
            tracing::warn!(error = %e, batch = ids.len(), redo, "failed to update flight recorder batch state");
            Some(if redo {
                "やり直しは適用しましたが、記録の状態を保存できませんでした (記録は取り消し済みのまま残ります)".to_string()
            } else {
                "取り消しは適用しましたが、記録の状態を保存できませんでした (記録は未取り消しのまま残ります。再度取り消さないでください)".to_string()
            })
        }
    }
}

/// 1 つの記録 (`id`) またはバッチ (`batch_id`) を指す (#1626)。ちょうど片方が必要。
enum FlightTarget {
    Record(i64),
    Batch(String),
}

fn flight_target(id: Option<i64>, batch_id: Option<String>) -> Result<FlightTarget> {
    match (id, batch_id) {
        (Some(id), None) => Ok(FlightTarget::Record(id)),
        (None, Some(b)) if !b.trim().is_empty() => Ok(FlightTarget::Batch(b)),
        _ => Err(AppError::InvalidInput(
            "exactly one of id / batchId is required".into(),
        )),
    }
}

/// 1 バッチで一度に取り消せる記録数の上限。記録 1 件ごとに現在行の取得が走るため。
const MAX_BATCH_RECORDS: usize = 500;

/// バッチ全体の取り消し (`redo` ならやり直し) 計画 (#1626)。取り消しは**後に実行した文から**
/// (id 降順)、やり直しは元の順 (id 昇順) に、各記録の計画を連結する。全体を 1 つの
/// トランザクションで適用するため、1 文でも衝突があれば (`force` でない限り) 何も適用しない。
///
/// 各記録の計画は「今のライブ行」に対して個別に立てるので、同じ行 (表 + 主キー) を複数の文が
/// 触ったバッチ (INSERT → DELETE、UPDATE → DELETE など) は、前の文の取り消し後の状態を
/// 織り込めず最終状態が誤る (衝突も出ないまま行が残る / 値が戻らない)。そうしたバッチは
/// [`check_batch_overlap`] で拒否し、記録を 1 件ずつ取り消してもらう。
pub(crate) async fn plan_batch(
    state: &AppState,
    session_id: &str,
    batch_id: &str,
    force: bool,
    redo: bool,
) -> Result<(
    crate::flight_recorder::undo::UndoPlan,
    Vec<crate::flight_recorder::WriteCaptureRecord>,
)> {
    let mut records = flight_store::list_batch(batch_id).await?;
    records.retain(|r| r.undone == redo);
    if records.is_empty() {
        return Err(AppError::InvalidInput(if redo {
            "no undone flight records in this batch".into()
        } else {
            "no flight records left to undo in this batch".into()
        }));
    }
    if records.len() > MAX_BATCH_RECORDS {
        return Err(AppError::InvalidInput(format!(
            "too many records in one batch (max {MAX_BATCH_RECORDS})"
        )));
    }
    if redo {
        records.reverse();
    }
    check_batch_overlap(&records)?;
    let database = records[0].database.clone();
    if records.iter().any(|r| r.database != database) {
        return Err(AppError::InvalidInput(
            "records in one batch target different databases".into(),
        ));
    }
    let mut merged = crate::flight_recorder::undo::UndoPlan {
        already_satisfied: true,
        ..Default::default()
    };
    for r in &records {
        let (plan, _) = plan_flight(state, session_id, r.id, force, redo).await?;
        merged.already_satisfied &= plan.already_satisfied || plan.statements.is_empty();
        merged.statements.extend(plan.statements);
        merged.conflicts.extend(plan.conflicts);
        merged.warnings.extend(plan.warnings);
    }
    if !merged.statements.is_empty() {
        merged.already_satisfied = false;
    }
    Ok((merged, records))
}

/// 表名の表記揺れ (`users` / `"users"` / `Users` / `public.users` / `"public"."users"`) を
/// 同じ表として扱うための正規化: 最後のドット以降を取り、引用符を外して小文字にする。
/// 別スキーマの同名表を同一視しうるが、重なり検出では安全側 (拒否側) に倒れるだけ。
fn normalize_table_name(name: &str) -> String {
    let mut last = String::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    for c in name.chars() {
        match quote {
            Some(q) if c == q => quote = None,
            Some(_) => cur.push(c),
            None => match c {
                '"' | '`' => quote = Some(c),
                '[' => quote = Some(']'),
                '.' => last = std::mem::take(&mut cur),
                _ => cur.push(c),
            },
        }
    }
    if !cur.is_empty() || last.is_empty() {
        last = cur;
    }
    last.to_lowercase()
}

/// バッチ内で、複数の記録が同じ行 (表 + 主キー、更新前後どちらでも) に触れていればエラー。
/// UPSERT の本体と companion は行が重ならない (新規行と既存行に分けて記録する) ので対象外になる。
pub(crate) fn check_batch_overlap(
    records: &[crate::flight_recorder::WriteCaptureRecord],
) -> Result<()> {
    let mut seen: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
    for r in records {
        let pk_idx: Vec<usize> = r
            .primary_key
            .iter()
            .filter_map(|n| r.columns.iter().position(|c| c == n))
            .collect();
        if pk_idx.is_empty() || pk_idx.len() != r.primary_key.len() {
            continue;
        }
        let mut mine = std::collections::HashSet::new();
        for row in r.before_rows.iter().chain(r.after_rows.iter()) {
            let Some(pk) = pk_idx
                .iter()
                .map(|&i| row.get(i).cloned())
                .collect::<Option<Vec<Value>>>()
            else {
                continue;
            };
            let key = format!(
                "{}\u{1}{}\u{1}{}",
                r.database.as_deref().unwrap_or(""),
                normalize_table_name(&r.table),
                serde_json::to_string(&pk)?
            );
            if let Some(other) = seen.get(&key) {
                return Err(AppError::InvalidInput(format!(
                    "flight records {other} and {} in this batch changed the same row of `{}`; undo/redo them one at a time instead of as a batch",
                    r.id, r.table
                )));
            }
            mine.insert(key);
        }
        for key in mine {
            seen.insert(key, r.id);
        }
    }
    Ok(())
}

#[derive(Debug, Serialize)]
pub struct UndoBatchPreviewResponse {
    pub statements: Vec<String>,
    pub conflicts: Vec<UndoConflict>,
    pub warnings: Vec<String>,
    /// 計画に含めた記録の id (適用順)。
    #[serde(rename = "recordIds")]
    pub record_ids: Vec<i64>,
}

/// バッチ (`batch_id`) の取り消し / やり直し計画を、適用せずに返す (#1626)。
#[tauri::command]
pub async fn preview_flight_batch(
    session_id: String,
    batch_id: String,
    redo: bool,
    state: State<'_, AppState>,
) -> Result<UndoBatchPreviewResponse> {
    let (plan, records) = plan_batch(state.inner(), &session_id, &batch_id, false, redo).await?;
    Ok(UndoBatchPreviewResponse {
        statements: plan.statements,
        conflicts: plan.conflicts,
        warnings: plan.warnings,
        record_ids: records.iter().map(|r| r.id).collect(),
    })
}

/// バッチを丸ごと取り消す / やり直す (#1626)。全記録の逆 SQL を 1 つのトランザクション
/// (`run_query_transaction_inner`、読み取り専用ガード・履歴記録は単発の Undo と同じ) で適用し、
/// 成功したら全記録を取り消し済み (やり直しなら未取り消し) にする。
#[tauri::command]
pub async fn apply_flight_batch(
    session_id: String,
    batch_id: String,
    force: bool,
    redo: bool,
    state: State<'_, AppState>,
) -> Result<UndoOutcome> {
    apply_flight_batch_inner(state.inner(), session_id, batch_id, force, redo).await
}

pub(crate) async fn apply_flight_batch_inner(
    state: &AppState,
    session_id: String,
    batch_id: String,
    force: bool,
    redo: bool,
) -> Result<UndoOutcome> {
    let (plan, records) = plan_batch(state, &session_id, &batch_id, force, redo).await?;
    let mut warnings = plan.warnings;
    if plan.statements.is_empty() {
        if plan.already_satisfied && plan.conflicts.is_empty() {
            if let Some(w) = mark_flight_batch_state(&records, redo).await {
                warnings.push(w);
            }
            return Ok(UndoOutcome {
                applied: true,
                rows_affected: 0,
                conflicts: plan.conflicts,
                warnings,
            });
        }
        return Ok(UndoOutcome {
            applied: false,
            rows_affected: 0,
            conflicts: plan.conflicts,
            warnings,
        });
    }
    if !plan.conflicts.is_empty() && !force {
        return Ok(UndoOutcome {
            applied: false,
            rows_affected: 0,
            conflicts: plan.conflicts,
            warnings,
        });
    }
    let database = records.first().and_then(|r| r.database.clone());
    let result =
        run_query_transaction_inner(state, session_id, plan.statements.clone(), database).await?;
    if let Some(w) = mark_flight_batch_state(&records, redo).await {
        warnings.push(w);
    }
    Ok(UndoOutcome {
        applied: true,
        rows_affected: result.rows_affected,
        conflicts: plan.conflicts,
        warnings,
    })
}

#[derive(Debug, Serialize)]
pub struct ExportPlanOutcome {
    pub statements: u64,
    pub conflicts: u64,
}

/// 取り消し / やり直しの SQL を `.sql` ファイルへ書き出す (#1626)。適用はしない — 「手元で
/// 確認してから流す」「別環境で実行する」ための保存用。単一の記録 (`id`) かバッチ (`batch_id`)
/// のどちらかを指定する。`force` が false なら衝突のある行の文は含めず、衝突は先頭の
/// コメントに列挙する。
#[tauri::command]
pub async fn export_flight_plan_sql(
    session_id: String,
    id: Option<i64>,
    batch_id: Option<String>,
    redo: bool,
    force: bool,
    path: String,
    state: State<'_, AppState>,
) -> Result<ExportPlanOutcome> {
    if path.trim().is_empty() {
        return Err(AppError::InvalidInput("save path is empty".into()));
    }
    let (plan, records) = match flight_target(id, batch_id)? {
        FlightTarget::Record(id) => {
            let (plan, record) = plan_flight(state.inner(), &session_id, id, force, redo).await?;
            (plan, vec![record])
        }
        FlightTarget::Batch(b) => plan_batch(state.inner(), &session_id, &b, force, redo).await?,
    };
    let driver = state
        .get(&session_id)
        .await
        .map(|s| s.conn.driver_kind())
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;
    let text = crate::flight_recorder::undo::plan_sql_text(driver, &records, &plan, redo);
    crate::commands::export::write_file_atomically(path, text.into_bytes()).await?;
    Ok(ExportPlanOutcome {
        statements: plan.statements.len() as u64,
        conflicts: plan.conflicts.len() as u64,
    })
}

/// 書き出し形式 (#1626)。
#[derive(Debug, Clone, Copy, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FlightExportFormat {
    Csv,
    Ndjson,
}

/// フライトレコーダの記録を CSV / NDJSON で書き出す (#1626)。`ids` を指定するとその記録だけ、
/// 省略すると `profile_id` (省略で全接続) の最新 `limit` 件を新しい順に書く。before / after は
/// JSON 文字列の列 (`before_rows` / `after_rows`)。行データを含むので、扱いは履歴と同じく
/// 利用者のローカルファイルのみ。書き出した件数を返す。
#[tauri::command]
pub async fn export_flight_records(
    path: String,
    format: FlightExportFormat,
    ids: Option<Vec<i64>>,
    profile_id: Option<String>,
    limit: Option<i64>,
) -> Result<u64> {
    if path.trim().is_empty() {
        return Err(AppError::InvalidInput("save path is empty".into()));
    }
    let records = match ids {
        Some(ids) if !ids.is_empty() => flight_store::get_many(&ids).await?,
        Some(_) => Vec::new(),
        None => {
            let limit = limit.unwrap_or(MAX_LIST_LIMIT).clamp(1, MAX_EXPORT_LIMIT);
            let summaries = flight_store::list(profile_id.as_deref(), limit).await?;
            let ids: Vec<i64> = summaries.iter().map(|s| s.id).collect();
            flight_store::get_many(&ids).await?
        }
    };
    if records.is_empty() {
        return Err(AppError::InvalidInput("no flight records to export".into()));
    }
    let (columns, rows) = flight_export_table(&records)?;
    let bytes = tokio::task::spawn_blocking(move || -> Result<Vec<u8>> {
        let mut buf: Vec<u8> = Vec::new();
        let fmt = match format {
            FlightExportFormat::Csv => crate::commands::export::ExportFormat::Csv,
            FlightExportFormat::Ndjson => crate::commands::export::ExportFormat::Ndjson,
        };
        crate::commands::export::write_export_to(
            &mut buf,
            fmt,
            &columns,
            &rows,
            None,
            &crate::commands::export::SqlExportOpts::build(None, None, None),
            None,
        )?;
        Ok(buf)
    })
    .await
    .map_err(|e| AppError::Other(format!("flight export task failed: {e}")))??;
    crate::commands::export::write_file_atomically(path, bytes).await?;
    Ok(records.len() as u64)
}

/// 書き出しの上限件数。
const MAX_EXPORT_LIMIT: i64 = 10_000;

/// 記録を書き出し用の表 (列 + 行) に並べる。列は固定。before / after は JSON 文字列。
fn flight_export_table(
    records: &[crate::flight_recorder::WriteCaptureRecord],
) -> Result<(Vec<crate::db::types::Column>, Vec<Vec<Value>>)> {
    use crate::db::types::Column;
    let names = [
        "id",
        "captured_at",
        "profile_id",
        "driver",
        "database",
        "table",
        "kind",
        "sql",
        "rows_affected",
        "undone",
        "pinned",
        "batch_id",
        "primary_key",
        "columns",
        "before_rows",
        "after_rows",
    ];
    let columns: Vec<Column> = names
        .iter()
        .map(|n| Column {
            name: (*n).to_string(),
            type_name: String::new(),
        })
        .collect();
    let opt = |v: &Option<String>| v.clone().map_or(Value::Null, Value::String);
    let mut rows = Vec::with_capacity(records.len());
    for r in records {
        let kind = serde_json::to_value(r.kind)?
            .as_str()
            .unwrap_or("other")
            .to_string();
        rows.push(vec![
            Value::from_i64_lossless(r.id),
            Value::String(r.captured_at.clone()),
            opt(&r.profile_id),
            Value::String(r.driver.clone()),
            opt(&r.database),
            Value::String(r.table.clone()),
            Value::String(kind),
            Value::String(r.sql.clone()),
            Value::from_i64_lossless(r.rows_affected),
            Value::from_i64_lossless(i64::from(r.undone)),
            Value::from_i64_lossless(i64::from(r.pinned)),
            opt(&r.batch_id),
            Value::String(serde_json::to_string(&r.primary_key)?),
            Value::String(serde_json::to_string(&r.columns)?),
            Value::String(serde_json::to_string(&r.before_rows)?),
            Value::String(serde_json::to_string(&r.after_rows)?),
        ]);
    }
    Ok((columns, rows))
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

    // 捕捉は `SELECT *` 相当なので生成列も `columns` に入る。生成列は INSERT / UPDATE で
    // 値を渡せないので逆 SQL から外す (#1600)。列情報を取れなくても取り消し自体は続ける。
    let generated_columns = session
        .conn
        .generated_columns(record.database.as_deref(), &record.table)
        .await
        .unwrap_or_default();
    let plan = if redo {
        build_redo_plan_with_generated(&record, &current_rows, force, &generated_columns)
    } else {
        build_undo_plan_with_generated(&record, &current_rows, force, &generated_columns)
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
            pinned: false,
            batch_id: None,
        }
    }

    fn rec(
        id: i64,
        table: &str,
        kind: WriteKind,
        before: &[i64],
        after: &[i64],
    ) -> WriteCaptureRecord {
        let mut r = record("sqlite", None);
        r.id = id;
        r.table = table.to_string();
        r.kind = kind;
        r.before_rows = before.iter().map(|k| vec![Value::Int(*k)]).collect();
        r.after_rows = after.iter().map(|k| vec![Value::Int(*k)]).collect();
        r
    }

    #[test]
    fn batch_overlap_rejects_records_touching_the_same_row() {
        // INSERT id=1 → DELETE id=1
        let ins = rec(1, "t", WriteKind::Insert, &[], &[1]);
        let del = rec(2, "t", WriteKind::Delete, &[1], &[]);
        assert!(matches!(
            check_batch_overlap(&[ins.clone(), del]),
            Err(AppError::InvalidInput(_))
        ));
        // UPDATE → DELETE
        let upd = rec(3, "t", WriteKind::Update, &[1], &[1]);
        let del = rec(4, "t", WriteKind::Delete, &[1], &[]);
        assert!(check_batch_overlap(&[upd, del]).is_err());
        // 主キーを書き換える UPDATE (前後どちらかが重なる)。
        let moved = rec(5, "t", WriteKind::Update, &[1], &[2]);
        let other = rec(6, "t", WriteKind::Insert, &[], &[2]);
        assert!(check_batch_overlap(&[moved, other]).is_err());
    }

    #[test]
    fn batch_overlap_normalizes_table_name_spellings() {
        for (a, b) in [
            ("users", "\"public\".\"users\""),
            ("Users", "users"),
            ("`users`", "db.users"),
            ("\"users\"", "public.users"),
        ] {
            let ins = rec(1, a, WriteKind::Insert, &[], &[1]);
            let del = rec(2, b, WriteKind::Delete, &[1], &[]);
            assert!(
                check_batch_overlap(&[ins, del]).is_err(),
                "{a} と {b} は同じ表"
            );
        }
        assert_eq!(normalize_table_name("\"a.b\".c"), "c");
        assert_eq!(normalize_table_name("\"a.b\""), "a.b");
        let x = rec(1, "users", WriteKind::Insert, &[], &[1]);
        let y = rec(2, "orders", WriteKind::Delete, &[1], &[]);
        assert!(check_batch_overlap(&[x, y]).is_ok());
    }

    #[test]
    fn batch_overlap_allows_disjoint_rows_and_tables() {
        let a = rec(1, "t", WriteKind::Insert, &[], &[1, 2]);
        let b = rec(2, "t", WriteKind::Update, &[3], &[3]);
        // 表が違えば同じ主キーでも重ならない (UPSERT の本体と companion も行は重ならない)。
        let c = rec(3, "u", WriteKind::Delete, &[1], &[]);
        assert!(check_batch_overlap(&[a, b, c]).is_ok());
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
