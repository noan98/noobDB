use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::db::types::{Column, QueryResult, StreamBatch, Value};
use crate::db::{apply_auto_limit, is_read_only_sql};
use crate::error::{AppError, Result};
use crate::history::store as history_store;
use crate::history::NewHistoryEntry;
use crate::state::{AppState, Session};

/// Returns `Err(AppError::ReadOnly)` when the session is RO and `sql` is not
/// strictly read-only. Used at every query entry point.
fn ensure_allowed_for_session(session: &Session, sql: &str) -> Result<()> {
    if session.read_only && !is_read_only_sql(sql) {
        tracing::warn!(
            session_id = %session.id,
            sql = %sql_summary(sql),
            "read-only guard rejected a non-read-only statement"
        );
        return Err(AppError::ReadOnly(
            "read-only profile: only SELECT / SHOW / DESCRIBE / EXPLAIN / WITH are allowed".into(),
        ));
    }
    Ok(())
}

/// Collapses `sql` to a short, single-line summary for logging. Never used at
/// `info` level — the full statement (which may carry sensitive literals) is
/// only ever surfaced at `debug` and is truncated here regardless.
fn sql_summary(sql: &str) -> String {
    const MAX: usize = 80;
    let one_line = sql.split_whitespace().collect::<Vec<_>>().join(" ");
    if one_line.chars().count() > MAX {
        let head: String = one_line.chars().take(MAX).collect();
        format!("{head}…")
    } else {
        one_line
    }
}

#[tauri::command]
pub async fn run_query(
    session_id: String,
    sql: String,
    database: Option<String>,
    state: State<'_, AppState>,
) -> Result<QueryResult> {
    let session = state
        .get(&session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;
    ensure_allowed_for_session(&session, &sql)?;
    session.conn.execute(&sql, database.as_deref()).await
}

/// Applies `statements` as a single all-or-nothing transaction. Every
/// statement is checked against the read-only gate first, then the whole
/// batch is committed together; if any statement fails the backend rolls the
/// transaction back so no partial edit is left behind. Returns an empty
/// `QueryResult` carrying the total `rows_affected`.
#[tauri::command]
pub async fn run_query_transaction(
    session_id: String,
    statements: Vec<String>,
    database: Option<String>,
    state: State<'_, AppState>,
) -> Result<QueryResult> {
    let session = state
        .get(&session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;
    for sql in &statements {
        ensure_allowed_for_session(&session, sql)?;
    }
    tracing::debug!(
        session_id = %session.id,
        statements = statements.len(),
        database = ?database,
        "transaction starting"
    );
    let started = std::time::Instant::now();
    let result = session
        .conn
        .execute_transaction(&statements, database.as_deref())
        .await;
    let elapsed_ms = started.elapsed().as_millis() as u64;
    match &result {
        Ok(affected) => tracing::debug!(
            session_id = %session.id,
            elapsed_ms,
            rows_affected = *affected,
            "transaction committed"
        ),
        Err(e) => tracing::warn!(
            session_id = %session.id,
            error = %e,
            "transaction failed and was rolled back"
        ),
    }
    // The cell-edit Apply path is a primary write entry point, so record the
    // generated statements to history for auditability (skip_history honoured).
    let sql_text = statements.join("\n");
    match &result {
        Ok(affected) => {
            record_write_history(
                &session,
                sql_text,
                database.as_deref(),
                Some(*affected as i64),
                Some(elapsed_ms as i64),
                None,
            )
            .await
        }
        Err(e) => {
            record_write_history(
                &session,
                sql_text,
                database.as_deref(),
                None,
                None,
                Some(e.to_string()),
            )
            .await
        }
    }
    let affected = result?;
    Ok(QueryResult::empty(affected, elapsed_ms))
}

#[derive(Debug, Serialize, Clone)]
struct StreamColumnsEvent {
    #[serde(rename = "streamId")]
    stream_id: String,
    columns: Vec<Column>,
}

#[derive(Debug, Serialize, Clone)]
struct StreamRowsEvent {
    #[serde(rename = "streamId")]
    stream_id: String,
    rows: Vec<Vec<Value>>,
}

#[derive(Debug, Serialize, Clone)]
struct StreamDoneEvent {
    #[serde(rename = "streamId")]
    stream_id: String,
    #[serde(rename = "totalRows")]
    total_rows: u64,
    #[serde(rename = "rowsAffected")]
    rows_affected: u64,
    #[serde(rename = "elapsedMs")]
    elapsed_ms: u64,
    /// True when the result had columns (a SELECT-shaped statement). False
    /// for INSERT/UPDATE/etc. so the UI can show "rows affected" instead.
    #[serde(rename = "hasColumns")]
    has_columns: bool,
    /// The row cap that was auto-injected for this run, or `null` when none was
    /// applied. Lets the UI show a "auto LIMIT N applied" badge.
    #[serde(rename = "appliedAutoLimit")]
    applied_auto_limit: Option<u64>,
}

#[derive(Debug, Serialize, Clone)]
struct StreamErrorEvent {
    #[serde(rename = "streamId")]
    stream_id: String,
    error: String,
    /// True when the run was aborted by the execution-timeout guard rather than
    /// failing in the database, so the UI can show a dedicated timeout message.
    #[serde(rename = "timedOut")]
    timed_out: bool,
    /// True when the failure means the DB connection was lost (server closed it,
    /// socket broke, network dropped). Lets the UI drop the now-dead session and
    /// prompt a reconnect instead of leaving it stuck on "connected".
    #[serde(rename = "connectionLost")]
    connection_lost: bool,
}

const EV_QUERY_COLS: &str = "query-stream:columns";
const EV_QUERY_ROWS: &str = "query-stream:rows";
const EV_QUERY_DONE: &str = "query-stream:done";
const EV_QUERY_ERROR: &str = "query-stream:error";

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn run_query_stream(
    app: AppHandle,
    session_id: String,
    stream_id: String,
    sql: String,
    database: Option<String>,
    initial_batch: usize,
    chunk_size: usize,
    auto_limit: Option<usize>,
    query_timeout_secs: Option<u64>,
    state: State<'_, AppState>,
) -> Result<()> {
    let session = state
        .get(&session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;
    ensure_allowed_for_session(&session, &sql)?;
    let handle = tokio::spawn(spawn_query_stream(
        app,
        session,
        stream_id.clone(),
        sql,
        database,
        initial_batch,
        chunk_size,
        auto_limit,
        query_timeout_secs,
    ));
    state
        .register_stream(stream_id, handle.abort_handle())
        .await;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn spawn_query_stream(
    app: AppHandle,
    session: Arc<Session>,
    stream_id: String,
    sql: String,
    database: Option<String>,
    initial_batch: usize,
    chunk_size: usize,
    auto_limit: Option<usize>,
    query_timeout_secs: Option<u64>,
) {
    tracing::debug!(
        session_id = %session.id,
        stream_id = %stream_id,
        database = ?database,
        sql = %sql_summary(&sql),
        "query stream starting"
    );
    // Rewrite the statement with an automatic LIMIT when requested and the SQL
    // is eligible. `sql` stays the original so history records what the user
    // actually typed; only `effective_sql` carries the injected cap.
    let (effective_sql, applied_auto_limit) = match auto_limit {
        Some(n) => match apply_auto_limit(&sql, n) {
            Some(rewritten) => (rewritten, Some(n as u64)),
            None => (sql.clone(), None),
        },
        None => (sql.clone(), None),
    };
    let emit_app = app.clone();
    let emit_id = stream_id.clone();
    let exec = session.conn.execute_stream(
        &effective_sql,
        database.as_deref(),
        initial_batch,
        chunk_size,
        |batch| match batch {
            StreamBatch::Columns(columns) => {
                let _ = emit_app.emit(
                    EV_QUERY_COLS,
                    StreamColumnsEvent {
                        stream_id: emit_id.clone(),
                        columns,
                    },
                );
                Ok(())
            }
            StreamBatch::Rows(rows) => {
                let _ = emit_app.emit(
                    EV_QUERY_ROWS,
                    StreamRowsEvent {
                        stream_id: emit_id.clone(),
                        rows,
                    },
                );
                Ok(())
            }
        },
    );
    // When a positive timeout is configured, race the whole run against it.
    // Elapsing drops the streaming future, which returns the pooled connection
    // (mirroring the manual stop button), so the session stays usable.
    let result = match query_timeout_secs {
        Some(secs) if secs > 0 => {
            match tokio::time::timeout(std::time::Duration::from_secs(secs), exec).await {
                Ok(res) => res,
                Err(_) => Err(AppError::Timeout(secs)),
            }
        }
        _ => exec.await,
    };

    match &result {
        Ok(res) => {
            tracing::debug!(
                session_id = %session.id,
                stream_id = %stream_id,
                elapsed_ms = res.elapsed_ms,
                rows = res.rows_affected,
                has_columns = !res.columns.is_empty(),
                "query stream completed"
            );
            let _ = app.emit(
                EV_QUERY_DONE,
                StreamDoneEvent {
                    stream_id: stream_id.clone(),
                    total_rows: if res.columns.is_empty() {
                        0
                    } else {
                        res.rows_affected
                    },
                    rows_affected: res.rows_affected,
                    elapsed_ms: res.elapsed_ms,
                    has_columns: !res.columns.is_empty(),
                    applied_auto_limit: if res.columns.is_empty() {
                        None
                    } else {
                        applied_auto_limit
                    },
                },
            );
        }
        Err(e) => {
            if matches!(e, AppError::Timeout(_)) {
                tracing::warn!(
                    session_id = %session.id,
                    stream_id = %stream_id,
                    error = %e,
                    "query stream timed out"
                );
            } else {
                tracing::warn!(
                    session_id = %session.id,
                    stream_id = %stream_id,
                    error = %e,
                    "query stream failed"
                );
            }
            let _ = app.emit(
                EV_QUERY_ERROR,
                StreamErrorEvent {
                    stream_id: stream_id.clone(),
                    error: e.to_string(),
                    timed_out: matches!(e, AppError::Timeout(_)),
                    connection_lost: e.is_connection_lost(),
                },
            );
        }
    }

    record_history(&session, &sql, database.as_deref(), &result).await;

    if let Some(state) = app.try_state::<AppState>() {
        state.forget_stream(&stream_id).await;
    }
}

/// Persists one executed statement to the query history. Best-effort: failures
/// are logged but never surfaced to the caller, and sessions flagged
/// `skip_history` are skipped entirely. Only the streaming run path records
/// history, so internal pagination/edit queries don't pollute it.
async fn record_history(
    session: &Session,
    sql: &str,
    database: Option<&str>,
    result: &Result<QueryResult>,
) {
    if session.skip_history {
        return;
    }
    let driver = session.conn.driver_kind().as_str().to_string();
    let database = database.map(str::to_string);
    let executed_at = chrono::Utc::now().to_rfc3339();
    let entry = match result {
        Ok(res) => {
            let has_columns = !res.columns.is_empty();
            NewHistoryEntry {
                profile_id: session.profile_id.clone(),
                driver,
                database,
                sql: sql.to_string(),
                rows: has_columns.then_some(res.rows_affected as i64),
                rows_affected: (!has_columns).then_some(res.rows_affected as i64),
                elapsed_ms: Some(res.elapsed_ms as i64),
                status: "ok".to_string(),
                error: None,
                executed_at,
            }
        }
        Err(e) => NewHistoryEntry {
            profile_id: session.profile_id.clone(),
            driver,
            database,
            sql: sql.to_string(),
            rows: None,
            rows_affected: None,
            elapsed_ms: None,
            status: "error".to_string(),
            error: Some(e.to_string()),
            executed_at,
        },
    };
    if let Err(e) = history_store::record(entry).await {
        tracing::warn!("failed to record query history: {e}");
    }
}

/// Records a single write to history for the non-streaming write paths (inline
/// cell-edit Apply and CSV import). These never return columns, so the count is
/// always carried in `rows_affected`. Best-effort and `skip_history`-aware,
/// mirroring [`record_history`]. Pass `rows_affected`/`elapsed_ms` on success
/// and `error` on failure (the unused side stays `None`).
pub(crate) async fn record_write_history(
    session: &Session,
    sql: String,
    database: Option<&str>,
    rows_affected: Option<i64>,
    elapsed_ms: Option<i64>,
    error: Option<String>,
) {
    if session.skip_history {
        return;
    }
    let status = if error.is_some() { "error" } else { "ok" };
    let entry = NewHistoryEntry {
        profile_id: session.profile_id.clone(),
        driver: session.conn.driver_kind().as_str().to_string(),
        database: database.map(str::to_string),
        sql,
        rows: None,
        rows_affected,
        elapsed_ms,
        status: status.to_string(),
        error,
        executed_at: chrono::Utc::now().to_rfc3339(),
    };
    if let Err(e) = history_store::record(entry).await {
        tracing::warn!("failed to record query history: {e}");
    }
}

#[derive(Debug, Serialize, Clone)]
struct PreviewMetaEvent {
    #[serde(rename = "streamId")]
    stream_id: String,
    #[serde(rename = "targetTable")]
    target_table: Option<String>,
    columns: Vec<Column>,
    #[serde(rename = "primaryKey")]
    primary_key: Vec<String>,
    #[serde(rename = "rowsAffected")]
    rows_affected: u64,
    #[serde(rename = "elapsedMs")]
    elapsed_ms: u64,
    truncated: bool,
}

#[derive(Debug, Serialize, Clone)]
struct PreviewRowsEvent {
    #[serde(rename = "streamId")]
    stream_id: String,
    rows: Vec<Vec<Value>>,
}

#[derive(Debug, Serialize, Clone)]
struct PreviewDoneEvent {
    #[serde(rename = "streamId")]
    stream_id: String,
}

const EV_PREVIEW_META: &str = "preview-stream:meta";
const EV_PREVIEW_BEFORE: &str = "preview-stream:before-rows";
const EV_PREVIEW_AFTER: &str = "preview-stream:after-rows";
const EV_PREVIEW_DONE: &str = "preview-stream:done";
const EV_PREVIEW_ERROR: &str = "preview-stream:error";

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn preview_query_stream(
    app: AppHandle,
    session_id: String,
    stream_id: String,
    sql: String,
    database: Option<String>,
    row_limit: usize,
    chunk_size: usize,
    state: State<'_, AppState>,
) -> Result<()> {
    let session = state
        .get(&session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;
    ensure_allowed_for_session(&session, &sql)?;
    let handle = tokio::spawn(spawn_preview_stream(
        app,
        session,
        stream_id.clone(),
        sql,
        database,
        row_limit,
        chunk_size,
    ));
    state
        .register_stream(stream_id, handle.abort_handle())
        .await;
    Ok(())
}

async fn spawn_preview_stream(
    app: AppHandle,
    session: Arc<Session>,
    stream_id: String,
    sql: String,
    database: Option<String>,
    row_limit: usize,
    chunk_size: usize,
) {
    let result = session
        .conn
        .preview_execute_with_limit(&sql, database.as_deref(), row_limit)
        .await;
    match result {
        Ok(p) => {
            let _ = app.emit(
                EV_PREVIEW_META,
                PreviewMetaEvent {
                    stream_id: stream_id.clone(),
                    target_table: p.target_table.clone(),
                    columns: p.columns.clone(),
                    primary_key: p.primary_key.clone(),
                    rows_affected: p.rows_affected,
                    elapsed_ms: p.elapsed_ms,
                    truncated: p.truncated,
                },
            );
            emit_chunks(
                &app,
                &stream_id,
                EV_PREVIEW_BEFORE,
                &p.before_rows,
                chunk_size,
            );
            emit_chunks(
                &app,
                &stream_id,
                EV_PREVIEW_AFTER,
                &p.after_rows,
                chunk_size,
            );
            let _ = app.emit(
                EV_PREVIEW_DONE,
                PreviewDoneEvent {
                    stream_id: stream_id.clone(),
                },
            );
        }
        Err(e) => {
            tracing::warn!(
                session_id = %session.id,
                stream_id = %stream_id,
                error = %e,
                "preview stream failed"
            );
            let _ = app.emit(
                EV_PREVIEW_ERROR,
                StreamErrorEvent {
                    stream_id: stream_id.clone(),
                    error: e.to_string(),
                    timed_out: false,
                    connection_lost: e.is_connection_lost(),
                },
            );
        }
    }
    if let Some(state) = app.try_state::<AppState>() {
        state.forget_stream(&stream_id).await;
    }
}

fn emit_chunks(
    app: &AppHandle,
    stream_id: &str,
    event: &str,
    rows: &[Vec<Value>],
    chunk_size: usize,
) {
    let chunk = chunk_size.max(1);
    let mut i = 0;
    while i < rows.len() {
        let end = (i + chunk).min(rows.len());
        let _ = app.emit(
            event,
            PreviewRowsEvent {
                stream_id: stream_id.to_string(),
                rows: rows[i..end].to_vec(),
            },
        );
        i = end;
    }
}

#[tauri::command]
pub async fn cancel_stream(stream_id: String, state: State<'_, AppState>) -> Result<bool> {
    Ok(state.cancel_stream(&stream_id).await)
}
