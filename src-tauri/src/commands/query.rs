use tauri::State;

use crate::db::types::{PreviewResult, QueryResult};
use crate::error::{AppError, Result};
use crate::state::AppState;

#[tauri::command]
pub async fn run_query(
    session_id: String,
    sql: String,
    state: State<'_, AppState>,
) -> Result<QueryResult> {
    let session = state
        .get(&session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;
    session.conn.execute(&sql).await
}

#[tauri::command]
pub async fn preview_query(
    session_id: String,
    sql: String,
    state: State<'_, AppState>,
) -> Result<PreviewResult> {
    let session = state
        .get(&session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;
    session.conn.preview_execute(&sql).await
}
