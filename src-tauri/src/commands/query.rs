use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::db::types::{Column, QueryResult, StreamBatch, Value};
use crate::db::{apply_auto_limit, is_read_only_sql};
use crate::error::{AppError, Result};
use crate::history::store as history_store;
use crate::history::NewHistoryEntry;
use crate::state::{AppState, Session, StreamHandle, StreamKind};

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

// ── 明示トランザクションモード ──
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
    /// Rows already delivered to the frontend (via `:rows`/`:before-rows`/
    /// `:after-rows` batches) before the run failed. Lets the UI tell a
    /// partial result apart from a complete one on timeout/error (#685).
    #[serde(rename = "deliveredRows")]
    delivered_rows: u64,
}

/// Emitted once by `cancel_stream` when it successfully claims an active
/// stream (see [`crate::state::AppState::cancel_stream`]). The event name
/// (`query-stream:cancelled` / `preview-stream:cancelled` /
/// `export-stream:cancelled`) is chosen from the stream's registered
/// [`StreamKind`] so the right listener picks it up (#685).
#[derive(Debug, Serialize, Clone)]
struct StreamCancelledEvent {
    #[serde(rename = "streamId")]
    stream_id: String,
    #[serde(rename = "deliveredRows")]
    delivered_rows: u64,
}

const EV_QUERY_COLS: &str = "query-stream:columns";
const EV_QUERY_ROWS: &str = "query-stream:rows";
const EV_QUERY_DONE: &str = "query-stream:done";
const EV_QUERY_ERROR: &str = "query-stream:error";
const EV_QUERY_CANCELLED: &str = "query-stream:cancelled";
const EV_PREVIEW_CANCELLED: &str = "preview-stream:cancelled";
const EV_EXPORT_CANCELLED: &str = "export-stream:cancelled";

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
    // `register_stream` をタスク本体の実行より前に完了させるためのゲート。
    // `tokio::spawn` は返り値の `JoinHandle` からしか `AbortHandle` を得られないため
    // 文字通り「spawn より前に register」することはできないが、タスク本体を
    // oneshot の受信待ちから始めれば、`register_stream` が完了するまでタスクの
    // 実処理 (延いては末尾の `forget_stream`) が走らないことを保証できる。これが
    // 無いと、SQL 即エラーのような速いタスクが `register_stream` より先に
    // `forget_stream` してしまい、既に完了したタスクの `AbortHandle` がマップに
    // 残り続け、以後その `stream_id` への `cancel_stream` が誤って `true` を返す
    // (逆に登録前に forget されると後続の同 stream_id 登録を消してしまう競合窓もある)。
    // Shared counter incremented as row batches are emitted, so a cancel or
    // timeout can report how many rows had already reached the frontend
    // (#685). Cloned into the state map (read by `cancel_stream`) and into
    // the task itself (read when building the timeout/error event).
    let delivered_rows = Arc::new(AtomicU64::new(0));
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel::<()>();
    let stream_id_for_task = stream_id.clone();
    let delivered_rows_for_task = delivered_rows.clone();
    let handle = tokio::spawn(async move {
        let _ = ready_rx.await;
        spawn_query_stream(
            app,
            session,
            stream_id_for_task,
            sql,
            database,
            initial_batch,
            chunk_size,
            auto_limit,
            query_timeout_secs,
            auto_refresh,
            delivered_rows_for_task,
        )
        .await;
    });
    state
        .register_stream(
            stream_id,
            StreamHandle {
                abort: handle.abort_handle(),
                delivered_rows,
                kind: StreamKind::Query,
            },
        )
        .await;
    // タスク本体の実行を許可する。register_stream が確実に先に完了している。
    let _ = ready_tx.send(());
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
    delivered_rows: Arc<AtomicU64>,
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
    let delivered_rows_cb = delivered_rows.clone();
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
            StreamBatch::Rows(rows) => {
                // Count rows before emitting so a cancel racing this exact
                // point never under-reports what actually reached the UI.
                let emitted_len = rows.len() as u64;
                delivered_rows_cb.fetch_add(emitted_len, Ordering::SeqCst);
                emit_app
                    .emit(
                        EV_QUERY_ROWS,
                        StreamRowsEvent {
                            stream_id: emit_id.clone(),
                            rows,
                        },
                    )
                    .map_err(|e| {
                        // The UI never received these rows; roll back the count.
                        delivered_rows_cb.fetch_sub(emitted_len, Ordering::SeqCst);
                        tracing::warn!(
                            stream_id = %emit_id,
                            error = %e,
                            "failed to emit rows event; aborting stream"
                        );
                        AppError::Other(format!("ipc emit failed: {e}"))
                    })
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
                    delivered_rows: delivered_rows.load(Ordering::SeqCst),
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
    //
    // register_stream をタスク本体より前に完了させるためのゲート。理由は
    // run_query_stream 側の同種コメントを参照 (register/forget の順序が逆転すると
    // AbortHandle がマップに残り続けたり、後続の同 stream_id 登録を消してしまう)。
    let delivered_rows = Arc::new(AtomicU64::new(0));
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel::<()>();
    let stream_id_for_task = stream_id.clone();
    let delivered_rows_for_task = delivered_rows.clone();
    let handle = tokio::spawn(async move {
        let _ = ready_rx.await;
        spawn_preview_stream(
            app,
            session,
            stream_id_for_task,
            sql,
            database,
            row_limit,
            chunk_size,
            delivered_rows_for_task,
        )
        .await;
    });
    state
        .register_stream(
            stream_id,
            StreamHandle {
                abort: handle.abort_handle(),
                delivered_rows,
                kind: StreamKind::Preview,
            },
        )
        .await;
    let _ = ready_tx.send(());
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn spawn_preview_stream(
    app: AppHandle,
    session: Arc<Session>,
    stream_id: String,
    sql: String,
    database: Option<String>,
    row_limit: usize,
    chunk_size: usize,
    delivered_rows: Arc<AtomicU64>,
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
                &delivered_rows,
            );
            emit_chunks(
                &app,
                &stream_id,
                EV_PREVIEW_AFTER,
                &p.after_rows,
                chunk_size,
                &delivered_rows,
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
                    delivered_rows: delivered_rows.load(Ordering::SeqCst),
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
    delivered_rows: &AtomicU64,
) {
    let chunk = chunk_size.max(1);
    let mut i = 0;
    while i < rows.len() {
        let end = (i + chunk).min(rows.len());
        let emitted_len = (end - i) as u64;
        delivered_rows.fetch_add(emitted_len, Ordering::SeqCst);
        if let Err(e) = app.emit(
            event,
            PreviewRowsEvent {
                stream_id: stream_id.to_string(),
                rows: rows[i..end].to_vec(),
            },
        ) {
            // The UI never received this chunk; roll back the count.
            delivered_rows.fetch_sub(emitted_len, Ordering::SeqCst);
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

/// Result of [`cancel_stream`]. Replaces the plain boolean this command used
/// to return: without a row count, a cancelled run's partial rows are
/// indistinguishable from a complete result to the caller (#685).
#[derive(Debug, Serialize, Clone)]
pub struct CancelStreamResult {
    pub cancelled: bool,
    #[serde(rename = "deliveredRows")]
    pub delivered_rows: u64,
}

/// Aborts the streaming task registered for `stream_id` (any of
/// `run_query_stream` / `preview_query_stream` / `export_query_stream` /
/// `import_csv` — they all share `AppState.streams`). On a genuine cancel
/// (the stream was still running) this also emits the matching
/// `<kind>-stream:cancelled` event carrying the same row count, for parity
/// with the `:done`/`:error` terminal events (#685). The frontend's own
/// cancel flow detaches its listeners before calling this command (so it
/// never observes that event) and instead reads `deliveredRows` off the
/// return value directly — the event exists for any other consumer and for
/// architectural symmetry with the other streaming commands.
#[tauri::command]
pub async fn cancel_stream(
    app: AppHandle,
    stream_id: String,
    state: State<'_, AppState>,
) -> Result<CancelStreamResult> {
    match state.cancel_stream(&stream_id).await {
        Some((delivered_rows, kind)) => {
            let event = match kind {
                StreamKind::Query => Some(EV_QUERY_CANCELLED),
                StreamKind::Preview => Some(EV_PREVIEW_CANCELLED),
                StreamKind::Export => Some(EV_EXPORT_CANCELLED),
                // CSV import has no partial-result concept to surface (the
                // whole import is one all-or-nothing transaction), so it
                // isn't part of this event contract.
                StreamKind::Import => None,
            };
            if let Some(event) = event {
                if let Err(e) = app.emit(
                    event,
                    StreamCancelledEvent {
                        stream_id: stream_id.clone(),
                        delivered_rows,
                    },
                ) {
                    tracing::warn!(stream_id = %stream_id, error = %e, "failed to emit cancelled event");
                }
            }
            Ok(CancelStreamResult {
                cancelled: true,
                delivered_rows,
            })
        }
        None => Ok(CancelStreamResult {
            cancelled: false,
            delivered_rows: 0,
        }),
    }
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

    // I4: `run_query_stream` / `preview_query_stream` が使う「register_stream を
    // タスク本体の実行より前に完了させるゲート」の順序保証を確認する回帰テスト。
    // ゲートが無いと、SQL 即エラーのような速いタスクが register_stream より先に
    // forget_stream してしまい、完了済みタスクの AbortHandle がマップに残り続ける
    // (以後その stream_id への cancel_stream が誤って true を返す) 競合が起こりうる。
    // ここではその実装パターンそのものを AppState に対して再現し、
    // 「register_stream 完了時点でエントリが存在する」→「ゲート解放後にタスクが
    // forget_stream する」という順序が守られることを検証する。
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn stream_gate_ensures_register_happens_before_task_forgets_itself() {
        let state = Arc::new(AppState::default());
        let stream_id = "test-stream-gate".to_string();

        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel::<()>();
        let task_state = state.clone();
        let task_stream_id = stream_id.clone();
        // 実処理を模した「即完了するタスク」。ゲートを待ってから自分の登録を消す。
        let handle = tokio::spawn(async move {
            let _ = ready_rx.await;
            task_state.forget_stream(&task_stream_id).await;
        });
        state
            .register_stream(
                stream_id.clone(),
                StreamHandle {
                    abort: handle.abort_handle(),
                    delivered_rows: Arc::new(AtomicU64::new(0)),
                    kind: StreamKind::Query,
                },
            )
            .await;
        // register_stream が完了した時点でエントリが存在すること (forget がまだ
        // 走っていない = ゲートで正しく順序付けられている)。
        assert!(
            state.streams.read().await.contains_key(&stream_id),
            "stream should be registered before the gate is released"
        );
        let _ = ready_tx.send(());
        handle.await.unwrap();
        // タスクがゲート解放後に forget_stream を実行し、エントリが消えていること。
        assert!(
            !state.streams.read().await.contains_key(&stream_id),
            "stream should have been forgotten by the task after the gate opened"
        );
    }
}
