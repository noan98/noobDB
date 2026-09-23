use tauri::State;

use crate::db::profile::{ColumnProfile, DEFAULT_TOP_N};
use crate::error::{AppError, Result};
use crate::state::AppState;

/// 列データプロファイル (「列を探索」、#974)。NULL 率 / DISTINCT / MIN・MAX /
/// 上位頻出値 / (数値列のみ) ヒストグラムをサーバ側で全件集計して返す。
/// 生成する SQL はすべて単一の SELECT なので read_only セッションでも許可する。
/// `conn` を直接呼ぶ経路のためクエリ履歴 (`history.sqlite`) は汚さない
/// (`commands/inspector.rs` と同じ)。`approximate` は使えるドライバ
/// (PostgreSQL の統計情報 / DuckDB の `approx_count_distinct`) で DISTINCT を
/// 近似し、全件の `COUNT(DISTINCT)` を避ける。
#[tauri::command]
pub async fn profile_column(
    session_id: String,
    database: String,
    table: String,
    column: String,
    approximate: bool,
    top_n: Option<u32>,
    state: State<'_, AppState>,
) -> Result<ColumnProfile> {
    profile_column_inner(
        state.inner(),
        &session_id,
        &database,
        &table,
        &column,
        approximate,
        top_n,
    )
    .await
}

/// Core of [`profile_column`] without Tauri's `State` wrapper, so the
/// always-on SQLite integration suite can drive the exact command path
/// (session lookup + driver dispatch) — same pattern as
/// `commands::inspector::query_stats_support_inner` (#881).
pub async fn profile_column_inner(
    state: &AppState,
    session_id: &str,
    database: &str,
    table: &str,
    column: &str,
    approximate: bool,
    top_n: Option<u32>,
) -> Result<ColumnProfile> {
    let session = state
        .get(session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.to_string()))?;
    session
        .conn
        .column_profile(
            database,
            table,
            column,
            approximate,
            top_n.unwrap_or(DEFAULT_TOP_N),
        )
        .await
}
