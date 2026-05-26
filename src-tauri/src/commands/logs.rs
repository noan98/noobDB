use crate::error::Result;
use crate::logs;

/// Application log contents plus the on-disk path, for the Settings log viewer.
#[derive(serde::Serialize)]
pub struct LogView {
    text: String,
    path: Option<String>,
}

#[tauri::command]
pub async fn read_logs() -> LogView {
    LogView {
        text: logs::read(),
        path: logs::path(),
    }
}

#[tauri::command]
pub async fn clear_logs() -> Result<()> {
    logs::clear().map_err(Into::into)
}
