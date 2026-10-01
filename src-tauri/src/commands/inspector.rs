use std::time::Instant;

use tauri::State;

use crate::db::inspector::{normalize_sql_fingerprint, NPlusOneOptions, StatementDeltaRow};
use crate::db::types::{LiveQuery, QueryStatsSupport};
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
    let mut queries = session.conn.live_queries().await?;
    // 同型クエリキー (N+1 グルーピング用) はここで付ける (#1259)。
    for q in &mut queries {
        q.fingerprint = normalize_sql_fingerprint(&q.query);
    }
    Ok(queries)
}

/// ステートメント統計の記録を開始する (#1259)。現在の digest 累積スナップショットを
/// セッション状態に baseline として保持する (記録開始からの差分の基準)。サーバ側の
/// カウンタはリセットしない — 権限が無くても使えるよう、引き算は Rust 側で行う設計は
/// 従来のフロント実装と同じ。読み取り SELECT のみで、read_only セッションでも許可し、
/// 履歴は汚さない (`sample_live_queries` と同じ)。
#[tauri::command]
pub async fn start_statement_recording(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<()> {
    start_statement_recording_inner(state.inner(), &session_id).await
}

/// Core of [`start_statement_recording`]. See [`query_stats_support_inner`] (#881).
pub async fn start_statement_recording_inner(state: &AppState, session_id: &str) -> Result<()> {
    let session = state
        .get(session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.to_string()))?;
    let snapshot = session.conn.statement_stats().await?;
    session
        .inspector
        .lock()
        .await
        .start(snapshot, Instant::now());
    Ok(())
}

/// baseline (記録開始) からの digest 差分を返す (#1259)。`refresh` ならサーバの統計を
/// 取り直して直前との差分レートから N+1 目安も更新し、そうでなければ前回取得分を
/// `cumulative` (baseline 無視) の切替で再計算するだけ (サーバへは問い合わせない)。
/// 返すのは calls > 0 の行のみで、SQL 本文 (`fingerprint`) は digest の初出時だけ載せる。
/// 状態はセッション単位で、切断・再接続で破棄される。`start_statement_recording` 前に
/// `refresh` で呼ばれた場合はその時点を baseline として開始する。読み取りのみ。
#[tauri::command]
pub async fn sample_statement_delta(
    session_id: String,
    cumulative: bool,
    refresh: bool,
    n_plus_one_min_count: u32,
    n_plus_one_window_ms: u32,
    state: State<'_, AppState>,
) -> Result<Vec<StatementDeltaRow>> {
    sample_statement_delta_inner(
        state.inner(),
        &session_id,
        cumulative,
        refresh,
        NPlusOneOptions::sanitized(n_plus_one_min_count, n_plus_one_window_ms),
    )
    .await
}

/// Core of [`sample_statement_delta`]. See [`query_stats_support_inner`] (#881).
pub async fn sample_statement_delta_inner(
    state: &AppState,
    session_id: &str,
    cumulative: bool,
    refresh: bool,
    opts: NPlusOneOptions,
) -> Result<Vec<StatementDeltaRow>> {
    let session = state
        .get(session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.to_string()))?;
    // サーバへの問い合わせはロックの外で行う (refresh=false の再計算を待たせない)。
    let snapshot = if refresh {
        Some(session.conn.statement_stats().await?)
    } else {
        None
    };
    let mut inspector = session.inspector.lock().await;
    if let Some(snapshot) = snapshot {
        if inspector.has_baseline() {
            inspector.ingest(snapshot, Instant::now(), opts);
        } else {
            inspector.start(snapshot, Instant::now());
        }
    }
    Ok(inspector.rows(cumulative))
}
