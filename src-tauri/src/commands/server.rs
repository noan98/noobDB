use tauri::State;

use crate::db::types::ServerInfo;
use crate::error::{AppError, Result};
use crate::state::AppState;

/// 接続中サーバの読み取り専用情報 (バージョン + 主要設定変数) を返す
/// (サーバ情報パネル #563 用)。`SHOW VARIABLES` / `pg_settings` / `PRAGMA`
/// など書き込みを伴わない経路のみを使うため、read_only セッションでも許可する。
/// アクティブ接続は既存のプロセスモニタ (`list_processes`) が担うため重複させない。
#[tauri::command]
pub async fn server_info(session_id: String, state: State<'_, AppState>) -> Result<ServerInfo> {
    let session = state
        .get(&session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;
    session.conn.server_info().await
}
