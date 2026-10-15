use tauri::State;

use crate::db::types::{
    ServerInfo, ServerMetrics, SqliteMaintenanceAction, SqliteMaintenanceResult,
};
use crate::error::{AppError, Result};
use crate::state::AppState;

/// 接続中サーバの読み取り専用情報 (バージョン + 主要設定変数) を返す
/// (サーバ情報パネル #563 用)。`SHOW VARIABLES` / `pg_settings` / `PRAGMA`
/// など書き込みを伴わない経路のみを使うため、read_only セッションでも許可する。
/// アクティブ接続は既存のプロセスモニタ (`list_processes`) が担うため重複させない。
#[tauri::command]
pub async fn server_info(session_id: String, state: State<'_, AppState>) -> Result<ServerInfo> {
    server_info_inner(state.inner(), &session_id).await
}

/// Core of [`server_info`] without Tauri's `State` wrapper, so integration
/// tests can drive the exact command path without a Tauri runtime — same
/// pattern as `commands::query::run_query_inner` (#881).
pub async fn server_info_inner(state: &AppState, session_id: &str) -> Result<ServerInfo> {
    let session = state
        .get(session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.to_string()))?;
    session.conn.server_info().await
}

/// 監視ダッシュボード (#731) 用のサーバランタイムメトリクスを 1 サンプル返す。
/// `SHOW GLOBAL STATUS` / `pg_stat_activity` などメモリ上のカウンタを読むだけで
/// テーブル I/O やサーバ状態変更を伴わないため、`list_processes` と同じく read_only
/// セッションでも許可する。フロントは一定間隔でこれをポーリングし、在メモリの
/// リングバッファに蓄積して時系列グラフ化する。SQLite はサーバを持たずエラーを返す。
#[tauri::command]
pub async fn server_metrics(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<ServerMetrics> {
    server_metrics_inner(state.inner(), &session_id).await
}

/// Core of [`server_metrics`]. See [`server_info_inner`] (#881).
pub async fn server_metrics_inner(state: &AppState, session_id: &str) -> Result<ServerMetrics> {
    let session = state
        .get(session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.to_string()))?;
    session.conn.server_metrics().await
}

/// SQLite のメンテナンス (整合性検査 / 外部キー検査 / `PRAGMA optimize` / `ANALYZE`, #1625)。
/// 診断パネルから呼ぶ。検査 2 種は読み取りのみなので read_only セッションでも許可し、
/// 統計を更新する `optimize` / `analyze` は read_only セッションをバックエンドで拒否する。
/// SQLite 以外は非対応エラー。
#[tauri::command]
pub async fn sqlite_maintenance(
    session_id: String,
    action: SqliteMaintenanceAction,
    state: State<'_, AppState>,
) -> Result<SqliteMaintenanceResult> {
    sqlite_maintenance_inner(state.inner(), &session_id, action).await
}

/// Core of [`sqlite_maintenance`]. See [`server_info_inner`] (#881).
pub async fn sqlite_maintenance_inner(
    state: &AppState,
    session_id: &str,
    action: SqliteMaintenanceAction,
) -> Result<SqliteMaintenanceResult> {
    let session = state
        .get(session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.to_string()))?;
    if action.writes() && session.read_only {
        return Err(AppError::ReadOnly(
            "read-only session: this maintenance action updates statistics".into(),
        ));
    }
    let result = session.conn.sqlite_maintenance(action).await;
    if action.writes() {
        // 統計が変わると実行計画が変わりうる。キャッシュ済みの結果は捨てる。
        session.query_cache.invalidate_all().await;
    }
    result
}
