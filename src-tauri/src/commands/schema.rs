use tauri::State;

use crate::db::types::{ForeignKey, TableColumnInfo, TableRowEstimate, TableSchema};
use crate::error::{AppError, Result};
use crate::state::AppState;

#[tauri::command]
pub async fn list_databases(session_id: String, state: State<'_, AppState>) -> Result<Vec<String>> {
    let session = state
        .get(&session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;
    session.conn.databases().await
}

#[tauri::command]
pub async fn list_tables(
    session_id: String,
    database: String,
    state: State<'_, AppState>,
) -> Result<Vec<String>> {
    let session = state
        .get(&session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;
    session.conn.tables(&database).await
}

#[tauri::command]
pub async fn describe_table(
    session_id: String,
    database: String,
    table: String,
    state: State<'_, AppState>,
) -> Result<Vec<TableColumnInfo>> {
    let session = state
        .get(&session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;
    session.conn.columns(&database, &table).await
}

#[tauri::command]
pub async fn schema_overview(
    session_id: String,
    database: String,
    state: State<'_, AppState>,
) -> Result<Vec<TableSchema>> {
    let session = state
        .get(&session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;
    session.conn.schema_overview(&database).await
}

#[tauri::command]
pub async fn foreign_keys(
    session_id: String,
    database: String,
    state: State<'_, AppState>,
) -> Result<Vec<ForeignKey>> {
    let session = state
        .get(&session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;
    session.conn.foreign_keys(&database).await
}

#[tauri::command]
pub async fn table_row_estimates(
    session_id: String,
    database: String,
    state: State<'_, AppState>,
) -> Result<Vec<TableRowEstimate>> {
    let session = state
        .get(&session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;
    session.conn.table_row_estimates(&database).await
}
