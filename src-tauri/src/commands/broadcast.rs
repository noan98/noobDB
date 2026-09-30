//! 環境横断ブロードキャスト実行 + 比較 (#738, #1257)。
//!
//! 同じ読み取りクエリを N 個のセッションへ並行実行し、基準環境との差分サマリと
//! **上限付きの表示行**だけをフロントへ返す。従来は各環境の全行をフロントへ流し、
//! `broadcastCompare.ts` と `ResultGrid` の二か所で差分を計算していた。
//!
//! - 結果は 1 本の Tauri `Channel` に環境ごとの `Env` メッセージとして届く (基準環境が
//!   終わった時点で、先に終わっていた対象の差分もまとめて送る)。
//! - 各環境は独立したタスクで、`{run_id}:{session_id}` の stream id で個別に
//!   `cancel_stream` できる (1 環境の失敗/キャンセルは他に影響しない)。
//! - 読み取り専用はバックエンド強制 (`ensure_broadcast_read_only`)。
//! - 打ち切り (`MAX_BROADCAST_COMPARE_ROWS`) は表示行にも比較にも同じ値を使う。

use std::sync::atomic::AtomicU64;
use std::sync::Arc;
use std::time::Duration;

use futures_util::stream::{FuturesUnordered, StreamExt};
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
use tokio::task::JoinHandle;

use crate::commands::query::{
    ensure_allowed_for_session, ensure_broadcast_read_only, record_history,
};
use crate::db::apply_auto_limit_for;
use crate::db::broadcast_diff::{
    compare_environments, resolve_key_indices, BroadcastDiff, EnvSide, MAX_BROADCAST_COMPARE_ROWS,
};
use crate::db::types::{Column, QueryResult, StreamBatch, Value};
use crate::error::{AppError, Result};
use crate::state::{AppState, Session, StreamHandle, StreamKind};

/// 環境 1 件の実行結果 (フロントへ送る形)。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BroadcastEnvReport {
    pub session_id: String,
    /// `"done"` / `"error"`。
    pub status: &'static str,
    pub columns: Vec<Column>,
    /// 先頭 `MAX_BROADCAST_COMPARE_ROWS` 行までの表示行。
    pub rows: Vec<Vec<Value>>,
    /// 打ち切り前の総行数。
    pub total_rows: u64,
    pub elapsed_ms: u64,
    pub error: Option<String>,
    /// 基準環境との差分 (基準自身・基準が失敗/キャンセルのとき・自身が失敗のときは `null`)。
    pub diff: Option<BroadcastDiff>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum BroadcastMessage {
    Env(BroadcastEnvReport),
    Cancelled { session_id: String },
    Done {},
}

/// 1 環境の実行結果 (差分計算前)。
struct EnvRun {
    columns: Vec<Column>,
    rows: Vec<Vec<Value>>,
    total_rows: u64,
    elapsed_ms: u64,
    error: Option<String>,
}

impl EnvRun {
    fn failed(error: String) -> Self {
        Self {
            columns: Vec::new(),
            rows: Vec::new(),
            total_rows: 0,
            elapsed_ms: 0,
            error: Some(error),
        }
    }
}

async fn run_env(
    session: Arc<Session>,
    sql: String,
    auto_limit: Option<usize>,
    query_timeout_secs: Option<u64>,
) -> EnvRun {
    let effective_sql = match auto_limit {
        Some(n) => {
            apply_auto_limit_for(session.conn.driver_kind(), &sql, n).unwrap_or_else(|| sql.clone())
        }
        None => sql.clone(),
    };
    let mut columns: Vec<Column> = Vec::new();
    let mut rows: Vec<Vec<Value>> = Vec::new();
    let exec = session.conn.execute_stream(
        &effective_sql,
        None,
        MAX_BROADCAST_COMPARE_ROWS,
        MAX_BROADCAST_COMPARE_ROWS,
        |batch| {
            match batch {
                StreamBatch::Columns(c) => columns = c,
                StreamBatch::Rows(mut b) => {
                    // 表示/比較の上限までしか保持しない (総行数はドライバの集計を使う)。
                    let room = MAX_BROADCAST_COMPARE_ROWS.saturating_sub(rows.len());
                    b.truncate(room);
                    rows.append(&mut b);
                }
            }
            Ok(())
        },
    );
    let result: Result<QueryResult> = match query_timeout_secs {
        Some(secs) if secs > 0 => {
            match tokio::time::timeout(Duration::from_secs(secs), exec).await {
                Ok(r) => r,
                Err(_) => Err(AppError::Timeout(secs)),
            }
        }
        _ => exec.await,
    };
    record_history(&session, &sql, None, &result).await;
    match result {
        Ok(res) => EnvRun {
            columns,
            rows,
            total_rows: res.rows_affected,
            elapsed_ms: res.elapsed_ms,
            error: None,
        },
        Err(e) => EnvRun {
            columns: Vec::new(),
            rows: Vec::new(),
            total_rows: 0,
            elapsed_ms: 0,
            error: Some(e.to_string()),
        },
    }
}

fn report(session_id: &str, run: &EnvRun, diff: Option<BroadcastDiff>) -> BroadcastEnvReport {
    BroadcastEnvReport {
        session_id: session_id.to_string(),
        status: if run.error.is_some() { "error" } else { "done" },
        columns: run.columns.clone(),
        rows: run.rows.clone(),
        total_rows: run.total_rows,
        elapsed_ms: run.elapsed_ms,
        error: run.error.clone(),
        diff,
    }
}

/// 環境の stream id (個別キャンセル用)。フロントも同じ規則で組み立てる。
pub fn env_stream_id(run_id: &str, session_id: &str) -> String {
    format!("{run_id}:{session_id}")
}

/// 同じ読み取りクエリを基準 + 対象のセッションへ並行実行し、差分つきで返す。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn broadcast_compare(
    app: AppHandle,
    run_id: String,
    sql: String,
    baseline_session_id: String,
    target_session_ids: Vec<String>,
    auto_limit: Option<usize>,
    query_timeout_secs: Option<u64>,
    // 表の主キー列名 (テーブル閲覧タブ由来のとき)。結果に全列が無ければ無効。
    table_pk_columns: Vec<String>,
    // 結果列からユーザが選んだキー列名。表の主キーが解決できないときに使う。
    user_key_column: Option<String>,
    on_event: Channel<BroadcastMessage>,
    state: State<'_, AppState>,
) -> Result<()> {
    // 先に全セッションを検証する (1 つでも不正なら何も実行しない)。
    let mut ids = vec![baseline_session_id];
    ids.extend(target_session_ids);
    let mut sessions: Vec<Arc<Session>> = Vec::with_capacity(ids.len());
    for id in &ids {
        let session = state
            .get(id)
            .await
            .ok_or_else(|| AppError::SessionNotFound(id.clone()))?;
        ensure_allowed_for_session(&session, &sql)?;
        ensure_broadcast_read_only(session.conn.driver_kind(), &sql)?;
        sessions.push(session);
    }

    // 各環境を別タスクで起動し、`register_stream` が済んでから実処理を始める
    // (`run_query_stream` と同じ oneshot ゲート)。
    let mut handles: Vec<(String, u64, JoinHandle<EnvRun>)> = Vec::with_capacity(ids.len());
    for (id, session) in ids.iter().zip(sessions) {
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel::<u64>();
        let sql_for_task = sql.clone();
        let handle = tokio::spawn(async move {
            if ready_rx.await.is_err() {
                return EnvRun::failed("broadcast task was not registered".into());
            }
            run_env(session, sql_for_task, auto_limit, query_timeout_secs).await
        });
        let cancel_channel = on_event.clone();
        let cancelled_id = id.clone();
        let token = state
            .register_stream(
                env_stream_id(&run_id, id),
                StreamHandle {
                    abort: handle.abort_handle(),
                    delivered_rows: Arc::new(AtomicU64::new(0)),
                    kind: StreamKind::Query,
                    on_cancel: Some(Box::new(move |_| {
                        let _ = cancel_channel.send(BroadcastMessage::Cancelled {
                            session_id: cancelled_id.clone(),
                        });
                    })),
                },
            )
            .await;
        let _ = ready_tx.send(token);
        handles.push((id.clone(), token, handle));
    }

    tauri::async_runtime::spawn(async move {
        coordinate(
            app,
            run_id,
            handles,
            table_pk_columns,
            user_key_column,
            on_event,
        )
        .await;
    });
    Ok(())
}

/// 環境の完了を順に受け取り、基準が揃ったところで差分つきの `Env` を送る。
async fn coordinate(
    app: AppHandle,
    run_id: String,
    handles: Vec<(String, u64, JoinHandle<EnvRun>)>,
    table_pk_columns: Vec<String>,
    user_key_column: Option<String>,
    on_event: Channel<BroadcastMessage>,
) {
    let all_ids: Vec<String> = handles.iter().map(|(id, _, _)| id.clone()).collect();
    let mut pending = FuturesUnordered::new();
    for (idx, (sid, token, handle)) in handles.into_iter().enumerate() {
        pending.push(async move {
            let res = handle.await;
            (idx, sid, token, res)
        });
    }

    // None: 基準がまだ終わっていない / Some(None): 基準が失敗・キャンセル / Some(Some(run)): 基準の結果。
    let mut baseline: Option<Option<EnvRun>> = None;
    let mut waiting: Vec<(String, EnvRun)> = Vec::new();
    let mut send_failed = false;

    let diff_for = |base: &Option<EnvRun>, run: &EnvRun| -> Option<BroadcastDiff> {
        let base = base.as_ref()?;
        if base.error.is_some() || run.error.is_some() {
            return None;
        }
        if base.columns.is_empty() || run.columns.is_empty() {
            return None;
        }
        let pk = resolve_key_indices(&base.columns, &table_pk_columns, user_key_column.as_deref());
        Some(compare_environments(
            EnvSide {
                columns: &base.columns,
                rows: &base.rows,
                total: base.total_rows,
            },
            EnvSide {
                columns: &run.columns,
                rows: &run.rows,
                total: run.total_rows,
            },
            &pk,
            MAX_BROADCAST_COMPARE_ROWS,
        ))
    };

    while let Some((idx, sid, token, res)) = pending.next().await {
        if let Some(state) = app.try_state::<AppState>() {
            state
                .forget_stream(&env_stream_id(&run_id, &sid), token)
                .await;
        }
        // キャンセル (abort) 済みの環境は `cancel_stream` の通知が既に届いている。
        // パニックだけはここでエラーとして報告する。
        let run: Option<EnvRun> = match res {
            Ok(run) => Some(run),
            Err(e) if e.is_cancelled() => None,
            Err(e) => Some(EnvRun::failed(format!("broadcast task failed: {e}"))),
        };
        let mut outgoing: Vec<BroadcastEnvReport> = Vec::new();
        if idx == 0 {
            if let Some(r) = &run {
                outgoing.push(report(&sid, r, None));
            }
            baseline = Some(run);
            if let Some(base) = &baseline {
                for (wsid, wrun) in waiting.drain(..) {
                    let diff = diff_for(base, &wrun);
                    outgoing.push(report(&wsid, &wrun, diff));
                }
            }
        } else if let Some(r) = run {
            match &baseline {
                Some(base) => {
                    let diff = diff_for(base, &r);
                    outgoing.push(report(&sid, &r, diff));
                }
                None => waiting.push((sid, r)),
            }
        }
        for rep in outgoing {
            if on_event.send(BroadcastMessage::Env(rep)).is_err() {
                send_failed = true;
                break;
            }
        }
        if send_failed {
            break;
        }
    }

    if send_failed {
        // フロントが居なくなった: 残りの環境も止める。
        if let Some(state) = app.try_state::<AppState>() {
            for id in &all_ids {
                let _ = state.cancel_stream(&env_stream_id(&run_id, id)).await;
            }
        }
        return;
    }
    let _ = on_event.send(BroadcastMessage::Done {});
}
