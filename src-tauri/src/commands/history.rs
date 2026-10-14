use crate::error::{AppError, Result};
use crate::history::store;
use crate::history::HistoryEntry;

/// Default page size when the caller doesn't specify one.
const DEFAULT_LIMIT: i64 = 200;
const MAX_LIMIT: i64 = 1000;

/// `status` filters to `"ok"`/`"error"` exactly; `from`/`to` are RFC3339
/// timestamp bounds (inclusive). All three are `None`-by-default and
/// additive to keep this IPC backward compatible with older frontend builds
/// that don't send them (#822).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn list_history(
    profile_id: Option<String>,
    limit: Option<i64>,
    search: Option<String>,
    status: Option<String>,
    from: Option<String>,
    to: Option<String>,
) -> Result<Vec<HistoryEntry>> {
    let limit = limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let search = search.filter(|s| !s.trim().is_empty());
    let status = status.filter(|s| !s.trim().is_empty());
    let from = from.filter(|s| !s.trim().is_empty());
    let to = to.filter(|s| !s.trim().is_empty());
    store::list(
        profile_id.as_deref(),
        limit,
        search.as_deref(),
        status.as_deref(),
        from.as_deref(),
        to.as_deref(),
    )
    .await
}

#[tauri::command]
pub async fn clear_history(profile_id: Option<String>) -> Result<u64> {
    store::clear(profile_id.as_deref()).await
}

/// 履歴 1 件の SQL 全文を返す (#1256)。一覧 (`list_history`) は要約 (`sql_preview`) と
/// 文字数 (`sql_len`) だけを運ぶので、復元・コピー・新規タブで開く等の必要な時に
/// 呼ぶ。履歴の上限超過や「履歴をクリア」で消えた行は `InvalidInput`。
#[tauri::command]
pub async fn get_history_sql(id: i64) -> Result<String> {
    store::get_sql(id)
        .await?
        .ok_or_else(|| AppError::InvalidInput(format!("history entry {id} no longer exists")))
}

/// 履歴の複数 id の SQL 全文をまとめて返す。戻り値は `ids` と同じ順・同じ長さで、削除済みなどで
/// 取れなかった行は `null`。履歴 AI 検索の候補取得が 1 件ずつ IPC を往復しないための一括版。
#[tauri::command]
pub async fn get_history_sqls(ids: Vec<i64>) -> Result<Vec<Option<String>>> {
    store::get_sqls(&ids).await
}

/// `profile_id` の直近の実行 SQL 全文だけを新しい順に返す (#1256)。エディタの ↑/↓
/// 履歴ナビとコマンドパレット向けで、`list_history` のようなメタデータは運ばない。
#[tauri::command]
pub async fn list_history_sql(
    profile_id: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<String>> {
    let limit = limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    store::list_sqls(profile_id.as_deref(), limit).await
}

/// 履歴の保持日数 (#1539)。0 は無効 (行数上限 10,000 件だけが効く)。
#[tauri::command]
pub async fn get_history_retention_days() -> Result<u32> {
    Ok(u32::try_from(store::retention_days().await?).unwrap_or(0))
}

/// 履歴の保持日数を保存し、期限切れの行をすぐ削除する。削除した行数を返す。
/// `flight_recorder` の保持日数と同じ意味で、範囲は 0〜3650 日。
#[tauri::command]
pub async fn set_history_retention_days(days: u32) -> Result<u64> {
    store::set_retention_days(i64::from(days)).await
}
