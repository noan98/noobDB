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
/// strictly read-only. Used at every query entry point (and the streaming
/// export path in `commands::export`).
pub(crate) fn ensure_allowed_for_session(session: &Session, sql: &str) -> Result<()> {
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

/// Backend-enforced read-only guard for scheduled re-execution (auto-refresh).
///
/// Auto-refresh polls a statement on a timer with no human in the loop, so it
/// must never run a write — unlike interactive runs, the UI confirmation gates
/// (`confirmDangerousQueries` / production write approval) never fire here.
/// This is enforced for *every* session regardless of the profile's `read_only`
/// flag, so even a writable session can only auto-refresh SELECT-shaped SQL.
fn ensure_auto_refresh_read_only(sql: &str) -> Result<()> {
    if !is_read_only_sql(sql) {
        return Err(AppError::ReadOnly(
            "auto-refresh allows only read-only statements (SELECT / SHOW / DESCRIBE / EXPLAIN / WITH)"
                .into(),
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
    run_query_inner(state.inner(), &session_id, &sql, database.as_deref()).await
}

/// Core of [`run_query`] decoupled from Tauri's `State` wrapper so integration
/// tests can drive the exact command path (session lookup + read-only guard +
/// execute) without standing up a Tauri runtime. The `#[tauri::command]`
/// wrapper above is intentionally a one-liner over this.
pub(crate) async fn run_query_inner(
    state: &AppState,
    session_id: &str,
    sql: &str,
    database: Option<&str>,
) -> Result<QueryResult> {
    let session = state
        .get(session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.to_string()))?;
    ensure_allowed_for_session(&session, sql)?;
    session.conn.execute(sql, database).await
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
    run_query_transaction_inner(state.inner(), session_id, statements, database).await
}

/// Core of [`run_query_transaction`] decoupled from Tauri's `State` wrapper so
/// integration tests can exercise the per-statement read-only guard on the real
/// command path. See [`run_query_inner`].
pub(crate) async fn run_query_transaction_inner(
    state: &AppState,
    session_id: String,
    statements: Vec<String>,
    database: Option<String>,
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

// ── 明示トランザクションモード (#414) ──
//
// BEGIN で専用接続を確保し、その接続で文を逐次実行して、COMMIT/ROLLBACK で確定/破棄
// する。フロントはトランザクションが有効な間、エディタの実行を `run_in_transaction`
// 経由に切り替える (通常のストリーミング経路はプールの別接続を使うため tx に乗らない)。

/// 明示トランザクションを開始する。`database` は接続のスキーマ/DB コンテキスト。
#[tauri::command]
pub async fn begin_transaction(
    session_id: String,
    database: Option<String>,
    state: State<'_, AppState>,
) -> Result<()> {
    let session = state
        .get(&session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;
    session.conn.begin_transaction(database.as_deref()).await?;
    tracing::info!(session_id = %session_id, "explicit transaction begun");
    Ok(())
}

/// 明示トランザクション内で 1 文を実行する。読み取り専用ガードは通常実行と同じく適用。
#[tauri::command]
pub async fn run_in_transaction(
    session_id: String,
    sql: String,
    state: State<'_, AppState>,
) -> Result<QueryResult> {
    let session = state
        .get(&session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;
    ensure_allowed_for_session(&session, &sql)?;
    session.conn.execute_in_transaction(&sql).await
}

/// 明示トランザクションを確定 (commit=true) または破棄 (false) する。
#[tauri::command]
pub async fn finish_transaction(
    session_id: String,
    commit: bool,
    state: State<'_, AppState>,
) -> Result<()> {
    let session = state
        .get(&session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;
    session.conn.finish_transaction(commit).await?;
    tracing::info!(session_id = %session_id, commit, "explicit transaction finished");
    Ok(())
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
    auto_refresh: Option<bool>,
    state: State<'_, AppState>,
) -> Result<()> {
    let session = state
        .get(&session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;
    ensure_allowed_for_session(&session, &sql)?;
    // Scheduled re-execution (auto-refresh) is read-only no matter the session.
    let auto_refresh = auto_refresh.unwrap_or(false);
    if auto_refresh {
        ensure_auto_refresh_read_only(&sql)?;
    }
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
        auto_refresh,
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
    auto_refresh: bool,
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
            StreamBatch::Columns(columns) => emit_app
                .emit(
                    EV_QUERY_COLS,
                    StreamColumnsEvent {
                        stream_id: emit_id.clone(),
                        columns,
                    },
                )
                .map_err(|e| {
                    tracing::warn!(
                        stream_id = %emit_id,
                        error = %e,
                        "failed to emit columns event; aborting stream"
                    );
                    AppError::Other(format!("ipc emit failed: {e}"))
                }),
            StreamBatch::Rows(rows) => emit_app
                .emit(
                    EV_QUERY_ROWS,
                    StreamRowsEvent {
                        stream_id: emit_id.clone(),
                        rows,
                    },
                )
                .map_err(|e| {
                    tracing::warn!(
                        stream_id = %emit_id,
                        error = %e,
                        "failed to emit rows event; aborting stream"
                    );
                    AppError::Other(format!("ipc emit failed: {e}"))
                }),
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
            if let Err(e) = app.emit(
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
            ) {
                tracing::warn!(
                    session_id = %session.id,
                    stream_id = %stream_id,
                    error = %e,
                    "failed to emit done event"
                );
            }
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
            if let Err(emit_err) = app.emit(
                EV_QUERY_ERROR,
                StreamErrorEvent {
                    stream_id: stream_id.clone(),
                    error: e.to_string(),
                    timed_out: matches!(e, AppError::Timeout(_)),
                    connection_lost: e.is_connection_lost(),
                },
            ) {
                tracing::warn!(
                    session_id = %session.id,
                    stream_id = %stream_id,
                    error = %emit_err,
                    "failed to emit error event"
                );
            }
        }
    }

    // Auto-refresh re-runs the same statement on a timer; recording every tick
    // would flood the history with duplicates, so polling never writes history.
    if !auto_refresh {
        record_history(&session, &sql, database.as_deref(), &result).await;
    }

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
    // The read-only guard is intentionally skipped here: a preview runs the
    // statement inside a transaction that is always rolled back, so it never
    // persists a change. `preview_execute_with_limit` only accepts
    // INSERT/UPDATE/DELETE/REPLACE and rejects DDL (which would implicit-commit
    // and so can't be rolled back), keeping the read-only guarantee intact while
    // letting a read-only session dry-run a write to inspect its effect.
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
            if let Err(e) = app.emit(
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
            ) {
                tracing::warn!(
                    session_id = %session.id,
                    stream_id = %stream_id,
                    error = %e,
                    "failed to emit preview meta event"
                );
            }
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
            if let Err(e) = app.emit(
                EV_PREVIEW_DONE,
                PreviewDoneEvent {
                    stream_id: stream_id.clone(),
                },
            ) {
                tracing::warn!(
                    session_id = %session.id,
                    stream_id = %stream_id,
                    error = %e,
                    "failed to emit preview done event"
                );
            }
        }
        Err(e) => {
            tracing::warn!(
                session_id = %session.id,
                stream_id = %stream_id,
                error = %e,
                "preview stream failed"
            );
            if let Err(emit_err) = app.emit(
                EV_PREVIEW_ERROR,
                StreamErrorEvent {
                    stream_id: stream_id.clone(),
                    error: e.to_string(),
                    timed_out: false,
                    connection_lost: e.is_connection_lost(),
                },
            ) {
                tracing::warn!(
                    session_id = %session.id,
                    stream_id = %stream_id,
                    error = %emit_err,
                    "failed to emit preview error event"
                );
            }
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
        if let Err(e) = app.emit(
            event,
            PreviewRowsEvent {
                stream_id: stream_id.to_string(),
                rows: rows[i..end].to_vec(),
            },
        ) {
            tracing::warn!(
                stream_id = %stream_id,
                event = %event,
                error = %e,
                "failed to emit preview rows chunk"
            );
        }
        i = end;
    }
}

#[tauri::command]
pub async fn cancel_stream(stream_id: String, state: State<'_, AppState>) -> Result<bool> {
    Ok(state.cancel_stream(&stream_id).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auto_refresh_allows_read_only_statements() {
        for sql in [
            "SELECT * FROM users",
            "  select 1",
            "SHOW TABLES",
            "DESCRIBE users",
            "EXPLAIN SELECT 1",
            "WITH t AS (SELECT 1) SELECT * FROM t",
        ] {
            assert!(
                ensure_auto_refresh_read_only(sql).is_ok(),
                "expected `{sql}` to be allowed for auto-refresh"
            );
        }
    }

    #[test]
    fn auto_refresh_rejects_writes_and_ddl() {
        for sql in [
            "DELETE FROM users",
            "UPDATE users SET name = 'x'",
            "INSERT INTO users VALUES (1)",
            "DROP TABLE users",
            "TRUNCATE users",
            // Stacked statement hiding a write behind a SELECT.
            "SELECT 1; DELETE FROM users",
            // Data-modifying CTE.
            "WITH d AS (DELETE FROM users RETURNING *) SELECT * FROM d",
        ] {
            assert!(
                matches!(
                    ensure_auto_refresh_read_only(sql),
                    Err(AppError::ReadOnly(_))
                ),
                "expected `{sql}` to be rejected for auto-refresh"
            );
        }
    }
}
