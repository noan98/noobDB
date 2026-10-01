//! スキーマツリー用の集約 IPC (#1263)。
//!
//! ツリーの復元 / 更新 (`load_schema_tree`) と、スキーマ検索用の全 DB テーブル一覧
//! (`list_tables_all`) を 1 IPC にまとめる。以前はフロントが DB ごとに
//! `list_tables` → `table_row_estimates` → `list_schema_objects` →
//! `list_table_comments`、開いているテーブルごとに `describe_table` →
//! `list_indexes` を直列に呼んでいた。ここでは Rust 内で `tokio::join!` /
//! 有限並列にして、キャッシュ (`SchemaCache`) を経由する項目はキャッシュを使う。

use futures_util::stream::{self, StreamExt};
use serde::Serialize;
use tauri::State;

use crate::db::types::{
    DatabaseTables, IndexInfo, SchemaObject, TableColumnInfo, TableComment, TableRowEstimate,
};
use crate::error::{AppError, Result};
use crate::state::{AppState, Session};

use super::schema::{fetch_columns_bulk, fetch_indexes_bulk};

/// 同時に走らせる DB 数の上限。DB ごとに 4 問い合わせを並行するので、
/// 接続プールを食い尽くさない程度に絞る。
const DB_CONCURRENCY: usize = 4;
/// 同じ DB の開いているテーブルがこの数以上なら、テーブルごとの問い合わせではなく
/// DB 単位の一括取得 (#1255) を使う。
const BULK_THRESHOLD: usize = 4;

/// 開いている DB 1 件分のツリー内容。取得に失敗した項目は、従来のフロントの
/// 挙動に合わせて `None` (= 反映しない) か空配列になる。
#[derive(Debug, Clone, Serialize)]
pub struct SchemaTreeDatabase {
    pub database: String,
    /// テーブル一覧。取得失敗は `None` (再展開で再試行される)。
    pub tables: Option<Vec<String>>,
    /// 行数推定。取得失敗は `None` (バッジが出ないだけ)。
    pub row_estimates: Option<Vec<TableRowEstimate>>,
    /// ビュー / ルーチン / トリガー。取得失敗は空。
    pub objects: Vec<SchemaObject>,
    /// テーブルコメント。取得失敗は `None`。
    pub comments: Option<Vec<TableComment>>,
}

/// 開いているテーブル 1 件分の列とインデックス。`key` は要求の `db::table`。
#[derive(Debug, Clone, Serialize)]
pub struct SchemaTreeTable {
    pub key: String,
    pub columns: Vec<TableColumnInfo>,
    /// 取得失敗は空 (列表示は維持する)。
    pub indexes: Vec<IndexInfo>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SchemaTree {
    /// 接続が持つ全データベース名。
    pub databases: Vec<String>,
    /// `open_dbs` のうち実在するもの (要求順)。
    pub open: Vec<SchemaTreeDatabase>,
    /// 開いているテーブルのうち、開いている DB に実在し取得できたもの。
    pub tables: Vec<SchemaTreeTable>,
}

/// `"db::table"` を最初の `::` で分ける (フロントの `indexOf("::")` と同じ規則)。
fn split_table_key(key: &str) -> Option<(&str, &str)> {
    let sep = key.find("::")?;
    Some((&key[..sep], &key[sep + 2..]))
}

async fn load_database(session: &Session, database: &str) -> SchemaTreeDatabase {
    let conn = &session.conn;
    let cache = &session.schema_cache;
    let (tables, estimates, objects, comments) = tokio::join!(
        cache.tables(database, || conn.tables(database)),
        conn.table_row_estimates(database),
        cache.schema_objects(database, || conn.schema_objects(database)),
        conn.table_comments(database),
    );
    SchemaTreeDatabase {
        database: database.to_string(),
        tables: tables.ok(),
        row_estimates: estimates.ok(),
        objects: objects.unwrap_or_default(),
        comments: comments.ok(),
    }
}

/// 要求された開いているテーブルの列とインデックスを取得する。
async fn load_tables(
    session: &Session,
    wanted: Vec<(String, String, String)>, // (key, db, table)
) -> Vec<SchemaTreeTable> {
    let conn = &session.conn;
    let cache = &session.schema_cache;

    // DB ごとの件数を数え、多い DB は一括取得に切り替える。
    let mut per_db: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    for (_, db, _) in &wanted {
        *per_db.entry(db.as_str()).or_default() += 1;
    }
    let bulk_dbs: Vec<String> = per_db
        .iter()
        .filter(|(_, n)| **n >= BULK_THRESHOLD)
        .map(|(db, _)| db.to_string())
        .collect();
    let mut bulk_columns: std::collections::HashMap<String, Vec<crate::db::diff::TableColumns>> =
        std::collections::HashMap::new();
    let mut bulk_indexes: std::collections::HashMap<String, Vec<crate::db::types::TableIndexes>> =
        std::collections::HashMap::new();
    let bulk_results = stream::iter(bulk_dbs.iter().cloned())
        .map(|db| async move {
            let (c, i) = tokio::join!(
                fetch_columns_bulk(session, &db),
                fetch_indexes_bulk(session, &db)
            );
            (db, c.ok(), i.ok())
        })
        .buffered(DB_CONCURRENCY);
    futures_util::pin_mut!(bulk_results);
    while let Some((db, c, i)) = bulk_results.next().await {
        if let Some(c) = c {
            bulk_columns.insert(db.clone(), c);
        }
        if let Some(i) = i {
            bulk_indexes.insert(db, i);
        }
    }

    let bulk_columns = &bulk_columns;
    let bulk_indexes = &bulk_indexes;
    let results = stream::iter(wanted)
        .map(|(key, db, table)| async move {
            let columns = match bulk_columns.get(&db) {
                Some(all) => all
                    .iter()
                    .find(|t| t.name == table)
                    .map(|t| t.columns.clone()),
                None => cache
                    .columns(&db, &table, || conn.columns(&db, &table))
                    .await
                    .ok(),
            }?;
            let indexes = match bulk_indexes.get(&db) {
                Some(all) => all
                    .iter()
                    .find(|t| t.name == table)
                    .map(|t| t.indexes.clone())
                    .unwrap_or_default(),
                None => cache
                    .list_indexes(&db, &table, || conn.list_indexes(&db, &table))
                    .await
                    .unwrap_or_default(),
            };
            Some(SchemaTreeTable {
                key,
                columns,
                indexes,
            })
        })
        .buffered(DB_CONCURRENCY * 2);
    futures_util::pin_mut!(results);
    let mut out = Vec::new();
    while let Some(item) = results.next().await {
        if let Some(t) = item {
            out.push(t);
        }
    }
    out
}

pub(crate) async fn load_schema_tree_inner(
    session: &Session,
    open_dbs: Vec<String>,
    open_table_keys: Vec<String>,
) -> Result<SchemaTree> {
    let conn = &session.conn;
    let databases = session.schema_cache.databases(|| conn.databases()).await?;

    let mut seen = std::collections::HashSet::new();
    let open_names: Vec<String> = open_dbs
        .into_iter()
        .filter(|db| databases.contains(db) && seen.insert(db.clone()))
        .collect();

    let mut open = Vec::with_capacity(open_names.len());
    {
        let loaded = stream::iter(open_names.clone())
            .map(move |db| async move { load_database(session, &db).await })
            .buffered(DB_CONCURRENCY);
        futures_util::pin_mut!(loaded);
        while let Some(d) = loaded.next().await {
            open.push(d);
        }
    }

    // 開いているテーブルは、開いている DB のテーブル一覧に実在するものだけを取る。
    let wanted: Vec<(String, String, String)> = open_table_keys
        .iter()
        .filter_map(|key| {
            let (db, table) = split_table_key(key)?;
            let listed = open
                .iter()
                .find(|d| d.database == db)
                .and_then(|d| d.tables.as_ref())?;
            listed
                .iter()
                .any(|t| t == table)
                .then(|| (key.clone(), db.to_string(), table.to_string()))
        })
        .collect();
    let tables = load_tables(session, wanted).await;

    Ok(SchemaTree {
        databases,
        open,
        tables,
    })
}

/// スキーマツリーの復元 / 更新に必要な情報を 1 回で返す (#1263)。
/// 開いている DB それぞれのテーブル一覧・行数推定・非テーブルオブジェクト・
/// コメントと、開いているテーブルの列・インデックスを、Rust 内で並行取得する。
/// 読み取り専用の introspection。
#[tauri::command]
pub async fn load_schema_tree(
    session_id: String,
    open_dbs: Vec<String>,
    open_table_keys: Vec<String>,
    state: State<'_, AppState>,
) -> Result<SchemaTree> {
    let session = state
        .get(&session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;
    load_schema_tree_inner(&session, open_dbs, open_table_keys).await
}

/// 全データベースのテーブル一覧を SQL 1 本で返す (#1263)。スキーマ検索が、
/// DB 数ぶんの `list_tables` を無制限並列で呼んでいたのを置き換える。
/// 各 DB の内容は `list_tables` と同一。読み取り専用の introspection。
#[tauri::command]
pub async fn list_tables_all(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<DatabaseTables>> {
    let session = state
        .get(&session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;
    session.conn.tables_all().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_table_key_at_the_first_separator() {
        assert_eq!(split_table_key("db::tbl"), Some(("db", "tbl")));
        assert_eq!(split_table_key("db::a::b"), Some(("db", "a::b")));
        assert_eq!(split_table_key("nosep"), None);
        assert_eq!(split_table_key("::t"), Some(("", "t")));
    }
}
