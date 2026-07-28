use crate::error::Result;
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
