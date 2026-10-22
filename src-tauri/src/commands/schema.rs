use std::sync::Arc;

use tauri::State;

use serde::Serialize;

use crate::commands::search::find_where_used_report;
use crate::db::column_deps::{
    foreign_key_dependencies, generated_column_dependencies, index_dependencies, ColumnDependency,
};
use crate::db::diff::TableColumns;
use crate::db::schema_insight::{
    build_table_statistics, incoming_foreign_keys as filter_incoming_foreign_keys,
    IncomingForeignKey, TableStatistic,
};
use crate::db::types::{
    ForeignKey, IndexInfo, RoutineSignature, SchemaObject, TableColumnInfo, TableComment,
    TableIndexes, TableRowEstimate, TableSchema,
};
use crate::db::where_used::WhereUsedTarget;
use crate::db::DriverKind;
use crate::error::{AppError, Result};
use crate::state::{AppState, Session};

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

/// ストアドプロシージャ / 関数のシグネチャ (パラメータ・戻り値) を返す (#1003)。
/// 「実行…」フォームの入力欄を組み立てるための読み取り専用 introspection で、
/// read_only セッションでも許可する (実際の実行は通常のクエリ経路
/// `run_query_stream` に乗り、`ensure_allowed_for_session` の安全網を通る)。
/// SQLite はエラー (未対応)。`get_object_definition` と同じく DDL 直後に
/// 古い値を返さないようキャッシュしない。
#[tauri::command]
pub async fn get_routine_signature(
    session_id: String,
    database: String,
    kind: String,
    name: String,
    id: Option<String>,
    state: State<'_, AppState>,
) -> Result<RoutineSignature> {
    let session = state
        .get(&session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;
    session
        .conn
        .routine_signature(&database, &kind, &name, id.as_deref())
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

/// 1 テーブル分の行数推定を返す (#1263)。`table_row_estimates` の 1 件版で、
/// DB 全体のカタログを読んで JS で 1 件に絞っていたテーブルオープン時の取得を
/// `TABLE_NAME = ?` / `relname = $2` の 1 行に置き換える。テーブルが無い・
/// ビュー・統計なし・SQLite は `None`。`table_row_estimates` と同じくキャッシュ
/// しない。
#[tauri::command]
pub async fn table_row_estimate(
    session_id: String,
    database: String,
    table: String,
    state: State<'_, AppState>,
) -> Result<Option<i64>> {
    let session = state
        .get(&session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;
    session.conn.table_row_estimate(&database, &table).await
}

/// DB 内のテーブル (とビュー) のコメント一覧を返す (#1002)。コメントを持つもの
/// だけ。SQLite はコメント機能が無いので常に空。カタログを読むだけの読み取り
/// 操作なので read_only でも許可する。コメント編集直後に古い値を見せないよう、
/// `table_row_estimates` と同じくキャッシュを経由しない。
#[tauri::command]
pub async fn list_table_comments(
    session_id: String,
    database: String,
    state: State<'_, AppState>,
) -> Result<Vec<TableComment>> {
    let session = state
        .get(&session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;
    session.conn.table_comments(&database).await
}

/// `database` の全テーブルの列メタデータを 1 回の問い合わせで取得し、テーブル
/// 単位の `columns` キャッシュも同時に埋める (#1255)。取得は常にドライバへ
/// 直接行う (ユーザ操作で開く画面が最新を見るため)。
pub(crate) async fn fetch_columns_bulk(
    session: &Session,
    database: &str,
) -> Result<Vec<TableColumns>> {
    let generation = session.schema_cache.generation();
    let tables = session.conn.columns_for_database(database).await?;
    session
        .schema_cache
        .store_columns_bulk(database, generation, &tables)
        .await;
    Ok(tables)
}

/// `database` の全テーブルのインデックスを 1 回の問い合わせで取得し、テーブル
/// 単位の `list_indexes` キャッシュも同時に埋める (#1255)。インデックスを持たない
/// テーブルは空配列としてキャッシュする。
pub(super) async fn fetch_indexes_bulk(
    session: &Session,
    database: &str,
) -> Result<Vec<TableIndexes>> {
    let conn = &session.conn;
    let generation = session.schema_cache.generation();
    let (indexes, table_names) = tokio::join!(
        conn.indexes_for_database(database),
        session
            .schema_cache
            .tables(database, || conn.tables(database))
    );
    let indexes = indexes?;
    if let Ok(names) = table_names {
        session
            .schema_cache
            .store_indexes_bulk(database, generation, &names, &indexes)
            .await;
    }
    Ok(indexes)
}

/// テーブルごとのサイズ・統計 (行数・データ/インデックス/合計サイズ) に、列数・
/// インデックス数・PK 有無・FK 数を合成して返す (テーブル統計ダッシュボード、
/// #562 / #660 / #1255)。以前はフロントが `table_sizes` + `schema_overview` +
/// `foreign_keys` + テーブル数ぶんの `list_indexes` を呼んで JS で結合していた
/// ものを、一括取得 (列・インデックス各 1 問い合わせ) と Rust 側の結合に置き換えた。
/// エンジンのカタログを読むだけで、読み取り操作なので read_only でも許可する。
#[tauri::command]
pub async fn table_statistics(
    session_id: String,
    database: String,
    state: State<'_, AppState>,
) -> Result<Vec<TableStatistic>> {
    let session = state
        .get(&session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;
    let conn = &session.conn;
    let (sizes, columns, indexes, foreign_keys) = tokio::join!(
        conn.table_sizes(&database),
        fetch_columns_bulk(&session, &database),
        fetch_indexes_bulk(&session, &database),
        session
            .schema_cache
            .foreign_keys(&database, || conn.foreign_keys(&database)),
    );
    let mut stats = build_table_statistics(sizes?, &columns?, &indexes?, &foreign_keys?);
    // 前回取得からの増減 (#1621)。補助情報なので、保存に失敗しても統計そのものは返す。
    let profile_id = session.profile_id.clone();
    let db = database.clone();
    let fallback = stats.clone();
    let attached = crate::commands::assertions::blocking_store(move || {
        crate::table_stat_store::attach_and_roll(profile_id.as_deref(), &db, &mut stats)?;
        Ok(stats)
    })
    .await;
    match attached {
        Ok(stats) => Ok(stats),
        Err(e) => {
            tracing::warn!(error = %e, "table statistics: failed to compare with the previous run");
            Ok(fallback)
        }
    }
}

/// `database` の全テーブル (とビュー) の列メタデータを 1 回で返す (#1255)。
/// スキーマエクスポートと ER 図が、テーブル数ぶんの `describe_table` の代わりに
/// 使う。各テーブルの内容は `describe_table` と同一。読み取り専用の introspection。
#[tauri::command]
pub async fn describe_database(
    session_id: String,
    database: String,
    state: State<'_, AppState>,
) -> Result<Vec<TableColumns>> {
    let session = state
        .get(&session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;
    fetch_columns_bulk(&session, &database).await
}

/// 列編集ダイアログ (`AlterTableModal`) の初期ロード一式 (#794 / #1002 / #1191 / #1255)。
#[derive(Debug, Clone, Serialize)]
pub struct AlterTableContext {
    /// 現在の列定義 (`describe_table` と同じ)。
    pub columns: Vec<TableColumnInfo>,
    /// テーブルコメント。無い・未対応 (SQLite) は空文字。
    pub table_comment: String,
    /// このテーブル自身が持つ外部キー (参照列 1 件につき 1 行)。FK の編集に
    /// 対応しないドライバ (SQLite) は空。
    pub foreign_keys: Vec<ForeignKey>,
    /// DB 内のテーブル名一覧 (FK の参照先候補)。
    pub table_names: Vec<String>,
    /// 取得に失敗して空で続行した付随情報の種別 (`"comments"` / `"foreign_keys"` /
    /// `"table_names"`)。文言はフロントが i18n で組み立てる (#1614)。
    pub warnings: Vec<String>,
}

/// `AlterTableModal` が開くときに必要な情報を 1 回で返す (#1255)。以前は
/// `describe_table` + DB 全体のテーブルコメント + DB 全体の FK + テーブル一覧を
/// フロントが 4 本呼び、JS で 1 テーブル分を抜き出していた。列の取得失敗は
/// エラーとして返し、コメント・FK・テーブル一覧は付随情報なので取得に失敗しても
/// 空で続行する (従来のフロントの挙動と同じ)。ただし失敗は握りつぶさず `warnings`
/// に種別を載せ、ダイアログが「表示が不完全」と出せるようにする (#1614)。
#[tauri::command]
pub async fn alter_table_context(
    session_id: String,
    database: String,
    table: String,
    state: State<'_, AppState>,
) -> Result<AlterTableContext> {
    let session = state
        .get(&session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;
    let conn = &session.conn;
    let driver = conn.driver_kind();
    let supports_comments = matches!(driver, DriverKind::Mysql | DriverKind::Postgres);
    let supports_constraints = supports_comments;

    let (columns, comments, foreign_keys, table_names) = tokio::join!(
        session
            .schema_cache
            .columns(&database, &table, || conn.columns(&database, &table)),
        async {
            if supports_comments {
                conn.table_comments(&database).await.map_err(|e| {
                    tracing::warn!(error = %e, "テーブルコメントの取得に失敗");
                })
            } else {
                Ok(Vec::new())
            }
        },
        async {
            if supports_constraints {
                session
                    .schema_cache
                    .foreign_keys(&database, || conn.foreign_keys(&database))
                    .await
                    .map_err(|e| {
                        tracing::warn!(error = %e, "外部キーの取得に失敗");
                    })
            } else {
                Ok(Vec::new())
            }
        },
        async {
            session
                .schema_cache
                .tables(&database, || conn.tables(&database))
                .await
                .map_err(|e| {
                    tracing::warn!(error = %e, "テーブル一覧の取得に失敗");
                })
        },
    );
    let mut warnings = Vec::new();
    if comments.is_err() {
        warnings.push("comments".to_string());
    }
    if foreign_keys.is_err() {
        warnings.push("foreign_keys".to_string());
    }
    if table_names.is_err() {
        warnings.push("table_names".to_string());
    }
    let comments = comments.unwrap_or_default();
    let foreign_keys = foreign_keys.unwrap_or_default();
    let table_names = table_names.unwrap_or_default();
    let table_comment = comments
        .into_iter()
        .find(|c| c.name == table)
        .map(|c| c.comment)
        .unwrap_or_default();
    Ok(AlterTableContext {
        columns: columns?,
        table_comment,
        foreign_keys: foreign_keys
            .into_iter()
            .filter(|f| f.table == table)
            .collect(),
        table_names,
        warnings,
    })
}

/// `table` を参照している外部キー (逆参照) を返す (#621 / #1255)。結果グリッドの
/// 「この行を参照している子テーブルの行へジャンプ」用。`foreign_keys` の
/// キャッシュを使うので、テーブルタブごとに呼んでも DB への問い合わせは DB 単位で
/// 1 回。以前はフロントが DB 全体の FK を保持し、描画のたびに JS で絞り込んでいた。
#[tauri::command]
pub async fn incoming_foreign_keys(
    session_id: String,
    database: String,
    table: String,
    state: State<'_, AppState>,
) -> Result<Vec<IncomingForeignKey>> {
    let session = state
        .get(&session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;
    let conn = &session.conn;
    let all = session
        .schema_cache
        .foreign_keys_shared(&database, || conn.foreign_keys(&database))
        .await?;
    Ok(filter_incoming_foreign_keys(&all, &table))
}

/// `column_dependencies` の結果 (#1758)。
#[derive(Debug, Clone, Serialize)]
pub struct ColumnDependencyReport {
    pub dependencies: Vec<ColumnDependency>,
    /// 取得に失敗して調べられなかった依存の種別 (`"definitions"` / `"indexes"` /
    /// `"foreign_keys"` / `"generated_columns"`)。空でなければ「検出が不完全」と表示する。
    pub warnings: Vec<String>,
}

/// DROP COLUMN の前に、`columns` を参照している依存オブジェクトを洗い出す (#1758)。
/// ビュー / マテビュー / トリガーは Where-used の定義走査、生成列・インデックス・FK (自列・
/// 被参照) はカタログから。読み取りのみなので `read_only` でも動く。依存の一部を取得できなくても
/// 取れた分は返し、取れなかった種別を `warnings` に載せる。
#[tauri::command]
pub async fn column_dependencies(
    session_id: String,
    database: String,
    table: String,
    columns: Vec<String>,
    state: State<'_, AppState>,
) -> Result<ColumnDependencyReport> {
    let session = state
        .get(&session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;
    column_dependencies_core(session, &database, &table, &columns).await
}

/// [`column_dependencies`] の本体 (Tauri 無しで統合テストから駆動する)。
pub async fn column_dependencies_core(
    session: Arc<Session>,
    database: &str,
    table: &str,
    columns: &[String],
) -> Result<ColumnDependencyReport> {
    let conn = &session.conn;
    let driver = conn.driver_kind();
    let mut warnings = Vec::new();
    let mut dependencies = Vec::new();
    if columns.is_empty() {
        return Ok(ColumnDependencyReport {
            dependencies,
            warnings,
        });
    }

    let (indexes, fks, generated) = tokio::join!(
        session
            .schema_cache
            .list_indexes(database, table, || conn.list_indexes(database, table)),
        session
            .schema_cache
            .foreign_keys_shared(database, || conn.foreign_keys(database)),
        conn.generated_column_exprs(database, table),
    );
    match indexes {
        Ok(idx) => dependencies.extend(index_dependencies(&idx, columns)),
        Err(e) => {
            tracing::warn!(error = %e, "列依存: インデックスの取得に失敗");
            warnings.push("indexes".to_string());
        }
    }
    match fks {
        Ok(all) => {
            let own: Vec<ForeignKey> = all.iter().filter(|f| f.table == table).cloned().collect();
            let incoming = filter_incoming_foreign_keys(&all, table);
            dependencies.extend(foreign_key_dependencies(table, &own, &incoming, columns));
        }
        Err(e) => {
            tracing::warn!(error = %e, "列依存: 外部キーの取得に失敗");
            warnings.push("foreign_keys".to_string());
        }
    }
    match generated {
        Ok(g) => dependencies.extend(generated_column_dependencies(
            driver, database, table, &g, columns,
        )),
        Err(e) => {
            tracing::warn!(error = %e, "列依存: 生成列の取得に失敗");
            warnings.push("generated_columns".to_string());
        }
    }

    // ビュー / マテビュー / トリガーの定義本文を列ごとに走査する (ルーチンは DROP を止めないので除く)。
    let mut definitions_incomplete = false;
    for column in columns {
        let target = WhereUsedTarget {
            database: database.to_string(),
            table: table.to_string(),
            column: Some(column.clone()),
        };
        match find_where_used_report(session.clone(), database, &target, &[], |_, _| {}).await {
            Ok(report) => {
                if !report.failed.is_empty() {
                    definitions_incomplete = true;
                }
                for m in report.matches {
                    if matches!(m.kind.as_str(), "view" | "materialized_view" | "trigger") {
                        dependencies.push(ColumnDependency {
                            column: column.clone(),
                            kind: m.kind,
                            name: m.name,
                            detail: None,
                            confidence: m.analysis.confidence,
                        });
                    }
                }
            }
            Err(e) => {
                tracing::warn!(error = %e, "列依存: 定義の走査に失敗");
                definitions_incomplete = true;
            }
        }
    }
    if definitions_incomplete {
        warnings.push("definitions".to_string());
    }
    Ok(ColumnDependencyReport {
        dependencies,
        warnings,
    })
}

/// このセッションのスキーマキャッシュ (#1097) を明示的に無効化する。
///
/// Schema Browser の「更新」ボタンなど、ユーザが明示的にスキーマの最新状態を
/// 見たいときに呼ぶ。無効化後の次の `list_databases` / `list_tables` /
/// `describe_table` / `schema_overview` /
/// `foreign_keys` / `list_schema_objects` / `list_indexes` はキャッシュを
/// 経由せず必ずドライバへ再取得しに行く (DDL 実行時の自動 invalidate と同じ
/// `SchemaCache::invalidate_all` を呼ぶだけなので、無効化の網羅性はそちらと
/// 共通)。読み取り専用の操作であり `read_only` セッションでも常に許可する。
#[tauri::command]
pub async fn refresh_schema_cache(session_id: String, state: State<'_, AppState>) -> Result<()> {
    refresh_schema_cache_inner(state.inner(), &session_id).await
}

/// 1 つのテーブルのスキーマキャッシュだけを無効化する (#1539)。ALTER / CREATE INDEX の
/// 適用後のように対象が分かるとき、接続全体の Refresh ([`refresh_schema_cache`]) の代わりに
/// 呼ぶと、他のテーブルの列・インデックスは再取得せずに済む。読み取り専用の操作で
/// `read_only` セッションでも許可する。`database` / `table` は大文字小文字を無視して照合する。
#[tauri::command]
pub async fn invalidate_table_cache(
    session_id: String,
    database: String,
    table: String,
    state: State<'_, AppState>,
) -> Result<()> {
    let session = state
        .get(&session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;
    session
        .schema_cache
        .invalidate_table(&database, &table)
        .await;
    Ok(())
}

/// テーブル一覧をキャッシュしたデータベースの取得時刻 (#1539)。
#[derive(Debug, Clone, serde::Serialize)]
pub struct SchemaCacheTime {
    pub database: String,
    /// UNIX epoch ミリ秒 (壁時計)。フロントがローカル時刻で表示する。
    pub fetched_at_ms: i64,
}

/// このセッションのスキーマキャッシュがいつ取得されたかを DB ごとに返す (#1539)。ツリーに
/// 「キャッシュ取得 HH:MM」を出し、Refresh が要るかをユーザが判断できるようにする。TTL 切れや
/// 未取得の DB は含まれない。キャッシュの内容そのものは返さない (時刻だけ)。
#[tauri::command]
pub async fn schema_cache_times(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<SchemaCacheTime>> {
    let session = state
        .get(&session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;
    Ok(session
        .schema_cache
        .tables_fetched_at()
        .await
        .into_iter()
        .map(|(database, fetched_at_ms)| SchemaCacheTime {
            database,
            fetched_at_ms,
        })
        .collect())
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
