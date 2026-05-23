use crate::error::Result;
use crate::history::store;
use crate::history::HistoryEntry;

/// Default page size when the caller doesn't specify one.
const DEFAULT_LIMIT: i64 = 200;
const MAX_LIMIT: i64 = 1000;

#[tauri::command]
pub async fn list_history(
    profile_id: Option<String>,
    limit: Option<i64>,
    search: Option<String>,
) -> Result<Vec<HistoryEntry>> {
    let limit = limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let search = search.filter(|s| !s.trim().is_empty());
    store::list(profile_id.as_deref(), limit, search.as_deref()).await
}

#[tauri::command]
pub async fn clear_history(profile_id: Option<String>) -> Result<u64> {
    store::clear(profile_id.as_deref()).await
}
