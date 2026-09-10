use tauri::State;

use crate::db::types::{
    ForeignKey, IndexInfo, SchemaObject, TableColumnInfo, TableRowEstimate, TableRowIdentity,
    TableSchema, TableSizeInfo,
};
use crate::error::{AppError, Result};
use crate::state::AppState;

// スキーマ Cache (#1097) の方針: このファイルの introspection コマンドは
// `session.schema_cache` を経由して結果を再利用する。キャッシュのキー設計・
// invalidate 条件・接続単位の分離の保証は `cache` モジュールのドキュメント
// コメントを参照。`table_row_estimates` / `table_sizes` /
// `get_object_definition` は意図的にキャッシュ対象から外している (理由は
// `cache::SchemaCache` のドキュメント参照) — 常にドライバへ直接問い合わせる。

#[tauri::command]
pub async fn list_databases(session_id: String, state: State<'_, AppState>) -> Result<Vec<String>> {
    let session = state
        .get(&session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;
    let conn = &session.conn;
    session.schema_cache.databases(|| conn.databases()).await
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
    let conn = &session.conn;
    session
        .schema_cache
        .tables(&database, || conn.tables(&database))
        .await
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
    let conn = &session.conn;
    session
        .schema_cache
        .columns(&database, &table, || conn.columns(&database, &table))
        .await
}

/// テーブルの編集用の行識別戦略を返す (主キー不在時の rowid/ctid/全列一致
/// フォールバック、#849)。呼び出し側 (フロント) は主キーが解決できたときは
/// これを呼ぶ必要がない — `describe_table` の `key` だけで足りる。
#[tauri::command]
pub async fn table_row_identity(
    session_id: String,
    database: String,
    table: String,
    state: State<'_, AppState>,
) -> Result<TableRowIdentity> {
    let session = state
        .get(&session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;
    let conn = &session.conn;
    session
        .schema_cache
        .row_identity(&database, &table, || conn.row_identity(&database, &table))
        .await
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
    let conn = &session.conn;
    session
        .schema_cache
        .schema_overview(&database, || conn.schema_overview(&database))
        .await
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
    let conn = &session.conn;
    session
        .schema_cache
        .foreign_keys(&database, || conn.foreign_keys(&database))
        .await
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
    let conn = &session.conn;
    session
        .schema_cache
        .schema_objects(&database, || conn.schema_objects(&database))
        .await
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
    let conn = &session.conn;
    session
        .schema_cache
        .list_indexes(&database, &table, || conn.list_indexes(&database, &table))
        .await
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

/// このセッションのスキーマキャッシュ (#1097) を明示的に無効化する。
///
/// Schema Browser の「更新」ボタンなど、ユーザが明示的にスキーマの最新状態を
/// 見たいときに呼ぶ。無効化後の次の `list_databases` / `list_tables` /
/// `describe_table` / `table_row_identity` / `schema_overview` /
/// `foreign_keys` / `list_schema_objects` / `list_indexes` はキャッシュを
/// 経由せず必ずドライバへ再取得しに行く (DDL 実行時の自動 invalidate と同じ
/// `SchemaCache::invalidate_all` を呼ぶだけなので、無効化の網羅性はそちらと
/// 共通)。読み取り専用の操作であり `read_only` セッションでも常に許可する。
#[tauri::command]
pub async fn refresh_schema_cache(session_id: String, state: State<'_, AppState>) -> Result<()> {
    refresh_schema_cache_inner(state.inner(), &session_id).await
}

/// Core of [`refresh_schema_cache`] decoupled from Tauri's `State` wrapper so
/// integration tests can drive the exact command path (session lookup +
/// invalidate) without standing up a Tauri runtime.
pub(crate) async fn refresh_schema_cache_inner(state: &AppState, session_id: &str) -> Result<()> {
    let session = state
        .get(session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.to_string()))?;
    session.schema_cache.invalidate_all().await;
    tracing::debug!(session_id = %session_id, "schema cache refreshed on explicit request");
    Ok(())
}
