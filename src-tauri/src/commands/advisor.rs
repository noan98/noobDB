//! スキーマ健全性アドバイザ (#741) の IPC ラッパー。
//!
//! ライブセッションからテーブル/カラム/インデックス/外部キーのメタデータと
//! (縮退しうる) 未使用インデックス統計を集め、純ロジック (`db::advisor::analyze`)
//! に渡してレポートを返す。すべて読み取りの introspection なので `read_only`
//! セッションでも許可する (適用は生成 DDL のエディタ挿入 → 既存安全網経由)。

use std::collections::{HashMap, HashSet};

use tauri::State;

use crate::db::advisor::{analyze, AdvisorInput, SchemaHealthReport, TableMeta};
use crate::db::types::{IndexInfo, TableColumnInfo};
use crate::db::Connection;
use crate::error::{AppError, Result};
use crate::state::AppState;

/// `db` のスキーマを診断し、健全性の指摘リストを返す。ビューは
/// `schema_objects` の一覧で除外し、ベーステーブルのみを対象にする (PK 欠落
/// ルールがビューで誤検出しないように)。メタデータ収集は列・インデックスとも
/// DB 全体を 1 問い合わせで取得する (#1255)。
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

    // 互いに依存しない 6 本の取得を同時に発行して往復待ちを重ねる (#1609)。
    // 以前は 1 本ずつ await しており、RTT の高いリモート DB では往復が 6 倍になっていた。
    // 列とインデックスは DB 全体を 1 問い合わせずつで取得する (#1255)。
    let (all_tables, objects, columns, indexes, foreign_keys, unused) = tokio::try_join!(
        conn.tables(database),
        conn.schema_objects(database),
        conn.columns_for_database(database),
        conn.indexes_for_database(database),
        conn.foreign_keys(database),
        conn.unused_indexes(database),
    )?;
    // ベーステーブルのみを対象にする。`tables` はビュー/マテビューも含むため、
    // `schema_objects` の view / materialized_view を引いて除外する。
    let view_names: HashSet<String> = objects
        .iter()
        .filter(|o| o.kind == "view" || o.kind == "materialized_view")
        .map(|o| o.name.clone())
        .collect();
    let mut columns_by_table: HashMap<String, Vec<TableColumnInfo>> =
        columns.into_iter().map(|t| (t.name, t.columns)).collect();
    let mut indexes_by_table: HashMap<String, Vec<IndexInfo>> =
        indexes.into_iter().map(|t| (t.name, t.indexes)).collect();

    let mut tables = Vec::new();
    for name in all_tables {
        if view_names.contains(&name) {
            continue;
        }
        tables.push(TableMeta {
            columns: columns_by_table.remove(&name).unwrap_or_default(),
            indexes: indexes_by_table.remove(&name).unwrap_or_default(),
            name,
        });
    }

    Ok(analyze(&AdvisorInput {
        driver,
        tables,
        foreign_keys,
        unused,
    }))
}
