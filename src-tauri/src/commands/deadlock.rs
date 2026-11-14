use tauri::State;

use crate::db::deadlock::{DeadlockAnalysis, SqliteTxHolder};
use crate::db::Connection;
use crate::error::{AppError, Result};
use crate::state::AppState;

/// デッドロック / ロック待ちの事後解析 (#2328)。エラー (MySQL 1213 / PostgreSQL 40P01 /
/// SQLite `SQLITE_BUSY`) のあと、サーバが残した報告を読んで 2 つ以上のトランザクションとロック対象・
/// 巻き戻された側を返す。`error_message` は PostgreSQL が DETAIL から循環を読むのに使い、
/// `error_age_secs` (エラーが返ってからの経過秒) は MySQL の最新報告が今回のエラーのものかの判定に使う。
/// サーバの状態カタログを読むだけなので read_only セッションでも許可する。履歴は汚さない。
/// SQLite は同じファイルを開き明示トランザクションを保持している他の接続も `holders` に載せる。
#[tauri::command]
pub async fn analyze_deadlock(
    session_id: String,
    error_message: Option<String>,
    error_age_secs: Option<i64>,
    state: State<'_, AppState>,
) -> Result<DeadlockAnalysis> {
    analyze_deadlock_inner(state.inner(), &session_id, error_message, error_age_secs).await
}

/// Core of [`analyze_deadlock`]. See `commands::server::server_info_inner` (#881).
pub async fn analyze_deadlock_inner(
    state: &AppState,
    session_id: &str,
    error_message: Option<String>,
    error_age_secs: Option<i64>,
) -> Result<DeadlockAnalysis> {
    let session = state
        .get(session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.to_string()))?;
    // エラー文は PostgreSQL の循環解析にだけ使う。資格情報リテラルを含みうる SQL 断片は
    // 画面に出さず (出力は pid / ロック名のみ)、ログにも書かない。
    let mut analysis = session
        .conn
        .analyze_deadlock(error_message.as_deref(), error_age_secs)
        .await?;
    if let (Connection::Sqlite(_), Some(view)) = (&session.conn, analysis.sqlite.as_mut()) {
        let path = session.connect_options.file_path.clone();
        let sessions: Vec<_> = state.sessions.read().await.values().cloned().collect();
        for other in sessions {
            if other.id == session.id
                || other.connect_options.file_path != path
                || !matches!(other.conn, Connection::Sqlite(_))
            {
                continue;
            }
            if other.conn.transaction_active().await {
                view.holders.push(SqliteTxHolder {
                    session_id: other.id.clone(),
                    profile_id: other.profile_id.clone(),
                });
            }
        }
    }
    Ok(analysis)
}
