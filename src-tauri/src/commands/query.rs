use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::db::is_read_only_sql;
use crate::db::types::{Column, PreviewResult, QueryResult, StreamBatch, Value};
use crate::error::{AppError, Result};
use crate::history::store as history_store;
use crate::history::NewHistoryEntry;
use crate::state::{AppState, Session};

/// Returns `Err(AppError::ReadOnly)` when the session is RO and `sql` is not
/// strictly read-only. Used at every query entry point.
fn ensure_allowed_for_session(session: &Session, sql: &str) -> Result<()> {
    if session.read_only && !is_read_only_sql(sql) {
        return Err(AppError::ReadOnly(
            "read-only profile: only SELECT / SHOW / DESCRIBE / EXPLAIN / WITH are allowed".into(),
        ));
    }
    Ok(())
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

#[tauri::command]
pub async fn preview_query(
    session_id: String,
    sql: String,
    database: Option<String>,
    state: State<'_, AppState>,
) -> Result<PreviewResult> {
    let session = state
        .get(&session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;
    ensure_allowed_for_session(&session, &sql)?;
    session
        .conn
        .preview_execute(&sql, database.as_deref())
        .await
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
}

#[derive(Debug, Serialize, Clone)]
struct StreamErrorEvent {
    #[serde(rename = "streamId")]
    stream_id: String,
    error: String,
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
    ));
    state
        .register_stream(stream_id, handle.abort_handle())
        .await;
    Ok(())
}

async fn spawn_query_stream(
    app: AppHandle,
    session: Arc<Session>,
    stream_id: String,
    sql: String,
    database: Option<String>,
    initial_batch: usize,
    chunk_size: usize,
) {
    let emit_app = app.clone();
    let emit_id = stream_id.clone();
    let result = session
        .conn
        .execute_stream(
            &sql,
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
        )
        .await;

    match &result {
        Ok(res) => {
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
                },
            );
        }
        Err(e) => {
            let _ = app.emit(
                EV_QUERY_ERROR,
                StreamErrorEvent {
                    stream_id: stream_id.clone(),
                    error: e.to_string(),
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
    #[serde(rename = "beforeTotal")]
    before_total: usize,
    #[serde(rename = "afterTotal")]
    after_total: usize,
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
                    before_total: p.before_rows.len(),
                    after_total: p.after_rows.len(),
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
            let _ = app.emit(
                EV_PREVIEW_ERROR,
                StreamErrorEvent {
                    stream_id: stream_id.clone(),
                    error: e.to_string(),
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
