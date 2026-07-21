//! スキーマ健全性アドバイザ (#741) の IPC ラッパー。
//!
//! ライブセッションからテーブル/カラム/インデックス/外部キーのメタデータと
//! (縮退しうる) 未使用インデックス統計を集め、純ロジック (`db::advisor::analyze`)
//! に渡してレポートを返す。すべて読み取りの introspection なので `read_only`
//! セッションでも許可する (適用は生成 DDL のエディタ挿入 → 既存安全網経由)。

use std::collections::HashSet;

use tauri::State;

use crate::db::advisor::{analyze, AdvisorInput, SchemaHealthReport, TableMeta};
use crate::db::Connection;
use crate::error::{AppError, Result};
use crate::state::AppState;

/// `db` のスキーマを診断し、健全性の指摘リストを返す。ビューは
/// `schema_objects` の一覧で除外し、ベーステーブルのみを対象にする (PK 欠落
/// ルールがビューで誤検出しないように)。メタデータ収集は N+1 (テーブルごとに
/// `columns` / `list_indexes` を 1 往復) だが、明示実行のユーザ操作なので
/// `compare_schema` と同じく許容する。
#[tauri::command]
pub async fn analyze_schema_health(
    session_id: String,
    database: String,
    state: State<'_, AppState>,
) -> Result<SchemaHealthReport> {
    let session = state
        .get(&session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;
    collect_and_analyze(&session.conn, &database).await
}

/// Tauri State を介さずに診断のコア経路を駆動する。統合テスト (`__test_api`) と
/// コマンド本体が共有する。
pub(crate) async fn collect_and_analyze(
    conn: &Connection,
    database: &str,
) -> Result<SchemaHealthReport> {
    let driver = conn.driver_kind();

    // ベーステーブルのみを対象にする。`tables` はビュー/マテビューも含むため、
    // `schema_objects` の view / materialized_view を引いて除外する。
    let all_tables = conn.tables(database).await?;
    let objects = conn.schema_objects(database).await?;
    let view_names: HashSet<String> = objects
        .iter()
        .filter(|o| o.kind == "view" || o.kind == "materialized_view")
        .map(|o| o.name.clone())
        .collect();

    let mut tables = Vec::new();
    for name in all_tables {
        if view_names.contains(&name) {
            continue;
        }
        let columns = conn.columns(database, &name).await?;
        let indexes = conn.list_indexes(database, &name).await?;
        tables.push(TableMeta {
            name,
            columns,
            indexes,
        });
    }

    let foreign_keys = conn.foreign_keys(database).await?;
    let unused = conn.unused_indexes(database).await?;

    Ok(analyze(&AdvisorInput {
        driver,
        tables,
        foreign_keys,
        unused,
    }))
}
