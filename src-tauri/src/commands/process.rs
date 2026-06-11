use tauri::State;

use crate::db::types::ProcessInfo;
use crate::error::{AppError, Result};
use crate::state::AppState;

/// サーバ側プロセス/接続の一覧を返す (プロセス監視パネル用)。エンジンのメモリ上の
/// 状態 (`processlist` / `pg_stat_activity`) を読むだけでテーブル I/O は発生しない
/// ため、ポーリングしても安全。読み取り操作なので read_only セッションでも許可する。
#[tauri::command]
pub async fn list_processes(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<ProcessInfo>> {
    let session = state
        .get(&session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;
    session.conn.list_processes().await
}

/// `list_processes` が返した id のプロセス/接続を強制終了する。
#[tauri::command]
pub async fn kill_process(
    session_id: String,
    process_id: i64,
    state: State<'_, AppState>,
) -> Result<()> {
    kill_process_inner(state.inner(), &session_id, process_id).await
}

/// Core of [`kill_process`] decoupled from Tauri's `State` wrapper so
/// integration tests can drive the exact command path. KILL /
/// `pg_terminate_backend` はサーバ状態を変更する操作なので、`read_only`
/// プロファイルは **バックエンド強制** で拒否する (SQL 文として
/// `is_read_only_sql` を通らない経路のため、ここで明示的にガードする)。
pub(crate) async fn kill_process_inner(
    state: &AppState,
    session_id: &str,
    process_id: i64,
) -> Result<()> {
    let session = state
        .get(session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.to_string()))?;
    if session.read_only {
        tracing::warn!(
            session_id = %session.id,
            process_id,
            "read-only guard rejected a kill request"
        );
        return Err(AppError::ReadOnly(
            "killing processes is not allowed on a read-only session".into(),
        ));
    }
    tracing::info!(session_id = %session.id, process_id, "killing server process");
    session.conn.kill_process(process_id).await
}
