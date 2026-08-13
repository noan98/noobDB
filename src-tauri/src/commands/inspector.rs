use tauri::State;

use crate::db::types::{LiveQuery, QueryStatsSupport, StatementStat};
use crate::error::{AppError, Result};
use crate::state::AppState;

/// ライブクエリ・インスペクタ (#746) の前提可否プローブ。MySQL は
/// `performance_schema` / consumer の状態、PostgreSQL は `pg_stat_statements`
/// の有無・可読性を調べ、使えない機能には理由コードを付けて返す (フロントは
/// コードを有効化手順つきのヘルプ文言にマップし、黙って空にしない。#587 の
/// 教訓)。読み取りのみなので read_only セッションでも許可する。
#[tauri::command]
pub async fn query_stats_support(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<QueryStatsSupport> {
    query_stats_support_inner(state.inner(), &session_id).await
}

/// Core of [`query_stats_support`] without Tauri's `State` wrapper, so
/// integration tests can drive the exact command path (session lookup +
/// driver dispatch) without a Tauri runtime — same pattern as
/// `commands::query::run_query_inner`. Lets the SQLite short-circuit
/// (`unsupported_driver`) be covered by the always-on SQLite suite instead of
/// only by the env-gated MySQL/PostgreSQL ones (#881).
pub async fn query_stats_support_inner(
    state: &AppState,
    session_id: &str,
) -> Result<QueryStatsSupport> {
    let session = state
        .get(session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.to_string()))?;
    session.conn.query_stats_support().await
}

/// ライブテール 1 サンプル: サーバが観測した実行中/直近ステートメントを返す。
/// エンジンのメモリ上の統計 (`performance_schema` / `pg_stat_activity`) を読む
/// だけの SELECT でテーブル I/O は発生せず、ポーリングしても安全。ポーリングの
/// 駆動はフロント (記録中のみ) が担い、バックエンドに常駐タスクは持たない —
/// パネルを閉じれば呼び出しが止まり、サーバ負荷は残らない。読み取り操作なので
/// read_only セッションでも許可する。`conn` を直接呼ぶ経路のためクエリ履歴
/// (`history.sqlite`) は汚さない。
#[tauri::command]
pub async fn sample_live_queries(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<LiveQuery>> {
    sample_live_queries_inner(state.inner(), &session_id).await
}

/// Core of [`sample_live_queries`]. See [`query_stats_support_inner`] (#881).
pub async fn sample_live_queries_inner(
    state: &AppState,
    session_id: &str,
) -> Result<Vec<LiveQuery>> {
    let session = state
        .get(session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.to_string()))?;
    session.conn.live_queries().await
}

/// digest (フィンガープリント) 単位の累積統計スナップショットを返す。
/// 「記録開始からの差分」はフロントの純ロジック (`queryInspector.ts`) が
/// 2 スナップショットの引き算で求める — サーバ側カウンタのリセット権限が
/// 無くても使えるようにするため。read_only セッションでも許可し、履歴は
/// 汚さない (`sample_live_queries` と同じ)。
#[tauri::command]
pub async fn sample_statement_stats(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<StatementStat>> {
    sample_statement_stats_inner(state.inner(), &session_id).await
}

/// Core of [`sample_statement_stats`]. See [`query_stats_support_inner`] (#881).
pub async fn sample_statement_stats_inner(
    state: &AppState,
    session_id: &str,
) -> Result<Vec<StatementStat>> {
    let session = state
        .get(session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.to_string()))?;
    session.conn.statement_stats().await
}
