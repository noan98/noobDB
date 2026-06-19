use tauri::State;

use crate::db::types::{
    ForeignKey, IndexInfo, SchemaObject, TableColumnInfo, TableRowEstimate, TableSchema,
    TableSizeInfo,
};
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

/// 非テーブルのスキーマオブジェクト一覧を返す。ビュー/マテビュー/ルーチン/トリガー。
#[tauri::command]
pub async fn list_schema_objects(
    session_id: String,
    database: String,
    state: State<'_, AppState>,
) -> Result<Vec<SchemaObject>> {
    let session = state
        .get(&session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;
    session.conn.schema_objects(&database).await
}

/// スキーマオブジェクトの定義 (DDL) を返す。
#[tauri::command]
pub async fn get_object_definition(
    session_id: String,
    database: String,
    kind: String,
    name: String,
    id: Option<String>,
    state: State<'_, AppState>,
) -> Result<String> {
    let session = state
        .get(&session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;
    session
        .conn
        .object_definition(&database, &kind, &name, id.as_deref())
        .await
}

/// テーブルのインデックス一覧を返す。名前・構成カラム・UNIQUE/PRIMARY/方式。
#[tauri::command]
pub async fn list_indexes(
    session_id: String,
    database: String,
    table: String,
    state: State<'_, AppState>,
) -> Result<Vec<IndexInfo>> {
    let session = state
        .get(&session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;
    session.conn.list_indexes(&database, &table).await
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

/// テーブルごとのサイズ・統計 (行数・データ/インデックス/合計サイズ) を返す。
/// エンジンのカタログを読むだけで、読み取り操作なので read_only でも許可する。
#[tauri::command]
pub async fn table_sizes(
    session_id: String,
    database: String,
    state: State<'_, AppState>,
) -> Result<Vec<TableSizeInfo>> {
    let session = state
        .get(&session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;
    session.conn.table_sizes(&database).await
}
