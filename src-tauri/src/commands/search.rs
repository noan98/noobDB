//! 検索系の IPC (#1261): グローバルオブジェクト検索・Where-used・DB 全体からの値検索。
//!
//! いずれもカタログまたは `SELECT` だけを使う読み取り操作で、`read_only` セッションでも
//! 動く。値検索が発行する走査 SQL は `ensure_allowed_for_session` (読み取り専用ガード)
//! を通してから実行する。
//!
//! 以前はフロントが「スキーマ取得 → JS でスコアリング / 定義本文の走査 / テーブルごとの
//! 直列クエリ」を担っていたが、ここでは Rust 側で一括取得・並列化し、結果 (上位 N 件 /
//! ヒット位置 / 進捗) だけを返す。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

use crate::commands::query::ensure_allowed_for_session;
use crate::commands::schema::fetch_columns_bulk;
use crate::db::data_search::{
    build_table_scan_sql, parse_scan_row, should_skip_table_for_scan, ColumnHit, MatchMode,
    ScanColumn,
};
use crate::db::object_search::{js_trim, ObjectHit, ObjectIndex};
use crate::db::types::{SchemaObject, TableColumnInfo};
use crate::db::where_used::{
    analyze_definition, snippet_applies_to_driver, supports_kind, DefinitionAnalysis,
    WhereUsedTarget,
};
use crate::db::{BulkDefinitions, DriverKind};
use crate::error::{AppError, Result};
use crate::snippets::{store as snippet_store, Snippet, SnippetScope};
use crate::state::{AppState, Session, StreamHandle, StreamKind};

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    // ポイズンしても中身は「途中まで積んだ結果」でしかなく壊れた不変条件は無いので続行する。
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

// ---------------------------------------------------------------------------
// 4. グローバルオブジェクト検索
// ---------------------------------------------------------------------------

/// 検索範囲。`current` は指定 DB だけ、`all` は接続上の全 DB。
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ObjectSearchScope {
    Current { database: String },
    All,
}

/// 全 DB 分の索引を (キャッシュ経由で) 返す。`information_schema` を 1 問い合わせで
/// 引き、失敗したら DB ごとの `schema_overview` に縮退して、読めない DB (権限不足など)
/// だけを飛ばす。
async fn all_databases_index(session: &Session) -> Result<Arc<ObjectIndex>> {
    let conn = &session.conn;
    let cache = &session.schema_cache;
    cache
        .object_index_all(|| async {
            let databases = cache.databases(|| conn.databases()).await?;
            let per_db = match conn.schema_overview_all(&databases).await {
                Ok(v) => v,
                Err(e) => {
                    tracing::warn!(error = %e, "bulk schema overview failed; falling back per database");
                    let mut acc = Vec::with_capacity(databases.len());
                    for db in &databases {
                        // 1 つの DB の取得失敗で全体を止めない (権限不足など)。
                        if let Ok(tables) = cache
                            .schema_overview(db, || conn.schema_overview(db))
                            .await
                        {
                            acc.push((db.clone(), tables));
                        }
                    }
                    acc
                }
            };
            Ok(Arc::new(ObjectIndex::build(
                per_db.iter().map(|(d, t)| (d.as_str(), t.as_slice())),
            )))
        })
        .await
}

async fn single_database_index(session: &Session, database: &str) -> Result<Arc<ObjectIndex>> {
    let conn = &session.conn;
    let cache = &session.schema_cache;
    cache
        .object_index_db(database, || async {
            let tables = cache
                .schema_overview(database, || conn.schema_overview(database))
                .await?;
            Ok(Arc::new(ObjectIndex::build([(
                database,
                tables.as_slice(),
            )])))
        })
        .await
}

/// [`search_schema_objects`] の本体 (Tauri の `State` 非依存)。空クエリでも索引の構築
/// (ウォームアップ) は行い、結果は空で返す。
pub async fn search_schema_objects_core(
    session: &Session,
    scope: &ObjectSearchScope,
    query: &str,
    limit: usize,
) -> Result<Vec<ObjectHit>> {
    let index = match scope {
        ObjectSearchScope::All => all_databases_index(session).await?,
        ObjectSearchScope::Current { database } => single_database_index(session, database).await?,
    };
    if js_trim(query).is_empty() {
        return Ok(Vec::new());
    }
    // スコアリングは CPU バウンド (数十万エントリで数十 ms) なので、IPC を処理する
    // ランタイムスレッドを塞がないよう blocking プールで走らせる。
    let query = query.to_string();
    tokio::task::spawn_blocking(move || index.search(&query, limit))
        .await
        .map_err(|e| AppError::Other(format!("object search task failed: {e}")))
}

/// スキーマ横断のオブジェクト検索 (テーブル名・カラム名の大小無視の部分一致)。全 DB 分の
/// 索引はセッションの `SchemaCache` に保持され、2 回目以降の検索は再取得しない。
/// `query` が空なら結果は空で、索引の事前構築 (ウォームアップ) だけを行う。
#[tauri::command]
pub async fn search_schema_objects(
    session_id: String,
    scope: ObjectSearchScope,
    query: String,
    limit: usize,
    state: State<'_, AppState>,
) -> Result<Vec<ObjectHit>> {
    let session = state
        .get(&session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;
    search_schema_objects_core(&session, &scope, &query, limit).await
}

// ---------------------------------------------------------------------------
// 5. Where-used
// ---------------------------------------------------------------------------

/// 該当 1 件 (オブジェクトの定義本文またはスニペット)。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WhereUsedMatch {
    #[serde(flatten)]
    pub analysis: DefinitionAnalysis,
    /// `"object"` または `"snippet"`。
    pub source: &'static str,
    /// オブジェクト種別。スニペットは `"snippet"`。
    pub kind: String,
    pub name: String,
    /// スキーマオブジェクトの一意識別子 (`get_object_definition` へそのまま渡す)。
    pub id: Option<String>,
    /// スニペットの ID (スニペットのときだけ)。
    pub snippet_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct WhereUsedFailure {
    pub kind: String,
    pub name: String,
    pub error: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct WhereUsedEmptyDefinition {
    pub kind: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WhereUsedReport {
    pub matches: Vec<WhereUsedMatch>,
    /// 定義を走査できたオブジェクト数 (スニペットを除く)。
    pub scanned_objects: usize,
    pub scanned_snippets: usize,
    /// 定義の取得に失敗したオブジェクト (権限不足など)。
    pub failed: Vec<WhereUsedFailure>,
    /// 定義本文が空で返ったオブジェクト。
    pub empty_definitions: Vec<WhereUsedEmptyDefinition>,
    /// キャンセルされ、途中までの結果であること。
    pub cancelled: bool,
}

/// 走査の途中経過。キャンセル時に「そこまでの結果」を返すため共有する。
#[derive(Debug, Default)]
pub struct WhereUsedState {
    matches: Vec<WhereUsedMatch>,
    scanned_objects: usize,
    scanned_snippets: usize,
    failed: Vec<WhereUsedFailure>,
    empty_definitions: Vec<WhereUsedEmptyDefinition>,
    done: usize,
    total: usize,
}

impl WhereUsedState {
    fn report(&self, cancelled: bool) -> WhereUsedReport {
        WhereUsedReport {
            matches: self.matches.clone(),
            scanned_objects: self.scanned_objects,
            scanned_snippets: self.scanned_snippets,
            failed: self.failed.clone(),
            empty_definitions: self.empty_definitions.clone(),
            cancelled,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum WhereUsedMessage {
    Progress {
        done: usize,
        total: usize,
    },
    Done {
        report: WhereUsedReport,
    },
    Error {
        error: String,
        connection_lost: bool,
    },
    /// キャンセル成立。`report` はそこまでに走査できた分。
    Cancelled {
        report: WhereUsedReport,
    },
}

/// 個別取得 (MySQL の `SHOW CREATE …` など) の同時実行数。プールは 5 接続なので、
/// 他の操作 (エディタの実行など) の分を残す。
const DEFINITION_FETCH_CONCURRENCY: usize = 3;

/// 対象自身 (ビューを検索したときのそのビュー) は自分の CREATE 文にヒットするので除く。
fn should_scan_object(obj: &SchemaObject, driver: DriverKind, target: &WhereUsedTarget) -> bool {
    supports_kind(driver, &obj.kind)
        && !(target.column.is_none()
            && (obj.kind == "view" || obj.kind == "materialized_view")
            && obj.name.to_lowercase() == target.table.to_lowercase())
}

/// 接続中プロファイルのスコープで絞り込んだスニペット (旧 UI の `scopeMatches`)。
fn visible_snippets(session: &Session, snippets: Vec<Snippet>) -> Vec<Snippet> {
    let mut group: Option<Option<String>> = None;
    snippets
        .into_iter()
        .filter(|s| match &s.scope {
            SnippetScope::Any => true,
            _ if session.profile_id.is_none() => false,
            SnippetScope::Profile { profile_id } => {
                session.profile_id.as_deref() == Some(profile_id.as_str())
            }
            SnippetScope::Group { group: want } => {
                let have = group.get_or_insert_with(|| {
                    crate::profiles::store::load_all().ok().and_then(|all| {
                        all.into_iter()
                            .find(|p| Some(&p.id) == session.profile_id.as_ref())
                            .map(|p| p.group.unwrap_or_default())
                    })
                });
                have.as_deref().unwrap_or("") == want.as_str()
            }
        })
        .collect()
}

/// [`find_where_used`] の本体。`state` に結果を積み、進捗は `on_progress` へ流す。
/// `snippets` は走査対象のスニペット (スコープ絞り込み済み) で、呼び出し側が渡す。
pub async fn find_where_used_core(
    session: Arc<Session>,
    database: &str,
    target: &WhereUsedTarget,
    snippets: &[Snippet],
    state: Arc<Mutex<WhereUsedState>>,
    on_progress: impl Fn(usize, usize) + Send + Sync + 'static,
) -> Result<()> {
    let driver = session.conn.driver_kind();
    let all = {
        let conn = &session.conn;
        session
            .schema_cache
            .schema_objects(database, || conn.schema_objects(database))
            .await?
    };
    let objects: Vec<SchemaObject> = all
        .into_iter()
        .filter(|o| should_scan_object(o, driver, target))
        .collect();
    let total = objects.len();
    lock(&state).total = total;
    on_progress(0, total);

    // 定義本文は可能なら 1 問い合わせでまとめて取る。取れない (MySQL / 失敗) 分は
    // オブジェクトごとに並列で取りに行く。
    let bulk: Arc<Option<BulkDefinitions>> =
        Arc::new(match session.conn.object_definitions_bulk(database).await {
            Ok(b) => b,
            Err(e) => {
                tracing::warn!(error = %e, "bulk definition fetch failed; fetching per object");
                None
            }
        });
    let on_progress = Arc::new(on_progress);
    let permits = Arc::new(Semaphore::new(DEFINITION_FETCH_CONCURRENCY));
    let target = Arc::new(target.clone());
    let database = Arc::new(database.to_string());
    let progress_step = (total / 100).max(1);

    let mut set: JoinSet<()> = JoinSet::new();
    for obj in objects {
        let session = session.clone();
        let bulk = bulk.clone();
        let permits = permits.clone();
        let target = target.clone();
        let database = database.clone();
        let state = state.clone();
        let on_progress = on_progress.clone();
        set.spawn(async move {
            let bulk_def = (*bulk)
                .as_ref()
                .and_then(|b| b.get(&obj))
                .map(str::to_string);
            let def: Result<String> = match bulk_def {
                Some(d) => Ok(d),
                None => match permits.acquire().await {
                    Ok(_permit) => {
                        session
                            .conn
                            .object_definition(&database, &obj.kind, &obj.name, obj.id.as_deref())
                            .await
                    }
                    Err(e) => Err(AppError::Other(e.to_string())),
                },
            };
            let outcome = def.map(|d| {
                if js_trim(&d).is_empty() {
                    None
                } else {
                    Some(analyze_definition(&d, &target, driver))
                }
            });
            let (done, total) = {
                let mut st = lock(&state);
                match outcome {
                    Ok(None) => {
                        st.scanned_objects += 1;
                        st.empty_definitions.push(WhereUsedEmptyDefinition {
                            kind: obj.kind.clone(),
                            name: obj.name.clone(),
                        });
                    }
                    Ok(Some(analysis)) => {
                        st.scanned_objects += 1;
                        if let Some(analysis) = analysis {
                            st.matches.push(WhereUsedMatch {
                                analysis,
                                source: "object",
                                kind: obj.kind.clone(),
                                name: obj.name.clone(),
                                id: obj.id.clone(),
                                snippet_id: None,
                            });
                        }
                    }
                    Err(e) => st.failed.push(WhereUsedFailure {
                        kind: obj.kind.clone(),
                        name: obj.name.clone(),
                        error: e.to_string(),
                    }),
                }
                st.done += 1;
                (st.done, st.total)
            };
            if done == total || done % progress_step == 0 {
                on_progress(done, total);
            }
        });
    }
    while let Some(res) = set.join_next().await {
        if let Err(e) = res {
            if e.is_panic() {
                return Err(AppError::Other(format!(
                    "where-used scan task panicked: {e}"
                )));
            }
        }
    }

    // スニペット本文 (定義取得の往復が無いので同期で走査する)。
    for s in snippets {
        if !snippet_applies_to_driver(s.driver.as_deref(), driver) {
            continue;
        }
        let analysis = analyze_definition(&s.sql, &target, driver);
        let mut st = lock(&state);
        st.scanned_snippets += 1;
        if let Some(analysis) = analysis {
            st.matches.push(WhereUsedMatch {
                analysis,
                source: "snippet",
                kind: "snippet".to_string(),
                name: s.name.clone(),
                id: None,
                snippet_id: Some(s.id.clone()),
            });
        }
    }
    Ok(())
}

/// テスト・統合用: 走査を最後まで実行してレポートを返す。
pub async fn find_where_used_report(
    session: Arc<Session>,
    database: &str,
    target: &WhereUsedTarget,
    snippets: &[Snippet],
    on_progress: impl Fn(usize, usize) + Send + Sync + 'static,
) -> Result<WhereUsedReport> {
    let state = Arc::new(Mutex::new(WhereUsedState::default()));
    find_where_used_core(
        session,
        database,
        target,
        snippets,
        state.clone(),
        on_progress,
    )
    .await?;
    let report = lock(&state).report(false);
    Ok(report)
}

/// ストリームの登録とタスクの起動を共通化する。`make_task` は登録トークンを受け取り、
/// 終了時に `forget_stream` を呼ぶ責任を持つ (`run_query_stream` と同じ競合対策)。
async fn register_and_spawn<F, Fut>(
    state: &AppState,
    stream_id: String,
    delivered_rows: Arc<AtomicU64>,
    on_cancel: Box<dyn Fn(u64) + Send + Sync>,
    make_task: F,
) where
    F: FnOnce(u64) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = ()> + Send + 'static,
{
    // register_stream をタスク本体より前に完了させるためのゲート (理由は
    // `run_query_stream` の同種コメントを参照)。
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel::<u64>();
    let handle = tokio::spawn(async move {
        let Ok(token) = ready_rx.await else {
            return;
        };
        make_task(token).await;
    });
    let token = state
        .register_stream(
            stream_id,
            StreamHandle {
                abort: handle.abort_handle(),
                delivered_rows,
                kind: StreamKind::Search,
                on_cancel: Some(on_cancel),
            },
        )
        .await;
    let _ = ready_tx.send(token);
}

/// あるオブジェクト (テーブル / 列) を参照しているビュー・ルーチン・トリガー・スニペットを
/// 洗い出す (Where-used、#1027)。定義本文の取得と走査は Rust 側で行い、ヒット位置だけを
/// `on_event` (Tauri Channel) で返す。進捗 (`progress`) と、`cancel_stream(stream_id)` による
/// 途中キャンセル (そこまでの結果を `cancelled`) に対応する。読み取りのみで read_only でも動く。
#[tauri::command]
pub async fn find_where_used(
    app: AppHandle,
    session_id: String,
    stream_id: String,
    database: String,
    target: WhereUsedTarget,
    on_event: Channel<WhereUsedMessage>,
    state: State<'_, AppState>,
) -> Result<()> {
    let session = state
        .get(&session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;
    let scan_state = Arc::new(Mutex::new(WhereUsedState::default()));
    let cancel_channel = on_event.clone();
    let cancel_state = scan_state.clone();
    let on_cancel: Box<dyn Fn(u64) + Send + Sync> = Box::new(move |_| {
        let report = lock(&cancel_state).report(true);
        let _ = cancel_channel.send(WhereUsedMessage::Cancelled { report });
    });
    let stream_id_for_task = stream_id.clone();
    register_and_spawn(
        state.inner(),
        stream_id,
        Arc::new(AtomicU64::new(0)),
        on_cancel,
        move |token| async move {
            let snippets = match snippet_store::load_all() {
                Ok(all) => visible_snippets(&session, all),
                Err(e) => {
                    tracing::warn!(error = %e, "where-used: failed to load snippets; skipping");
                    Vec::new()
                }
            };
            let progress_channel = on_event.clone();
            let result = find_where_used_core(
                session.clone(),
                &database,
                &target,
                &snippets,
                scan_state.clone(),
                move |done, total| {
                    let _ = progress_channel.send(WhereUsedMessage::Progress { done, total });
                },
            )
            .await;
            let message = match result {
                Ok(()) => WhereUsedMessage::Done {
                    report: lock(&scan_state).report(false),
                },
                Err(e) => WhereUsedMessage::Error {
                    connection_lost: e.is_connection_lost(),
                    error: e.to_string(),
                },
            };
            if let Err(e) = on_event.send(message) {
                tracing::warn!(session_id = %session.id, error = %e, "failed to send where-used result");
            }
            if let Some(state) = app.try_state::<AppState>() {
                state.forget_stream(&stream_id_for_task, token).await;
            }
        },
    )
    .await;
    Ok(())
}

// ---------------------------------------------------------------------------
// 7. DB 全体からの値検索
// ---------------------------------------------------------------------------

/// 値検索の走査 1 テーブルぶんの結果。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "status",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum DataSearchEntry {
    Hit {
        table: String,
        columns: Vec<ScanColumn>,
        hits: Vec<ColumnHit>,
    },
    NoHit {
        table: String,
    },
    Skipped {
        table: String,
        /// `"row-threshold"` / `"no-searchable-columns"` / `"error"`。
        reason: &'static str,
        #[serde(skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum DataSearchMessage {
    /// テーブルの走査を開始した (`index` は 0 始まりの通し番号)。
    Progress {
        index: usize,
        total: usize,
        table: String,
    },
    /// 1 テーブルの結果。テーブルの指定順に届く。
    Table {
        entry: DataSearchEntry,
    },
    Done {},
    Error {
        error: String,
        connection_lost: bool,
    },
    Cancelled {
        delivered_rows: u64,
    },
}

/// 並列に走査するテーブル数。プール (5 接続) の一部だけを使い、他の操作を止めない。
const DATA_SEARCH_CONCURRENCY: usize = 3;

/// この数以上のテーブルを走査するときは、列メタデータを DB 全体で 1 回の問い合わせに
/// まとめる。少数の選択ならテーブルごとの (キャッシュ経由の) 取得の方が軽い。
const BULK_COLUMNS_MIN_TABLES: usize = 5;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataSearchRequest {
    pub database: String,
    pub term: String,
    pub mode: MatchMode,
    /// 走査するテーブル (この順に結果を返す)。
    pub tables: Vec<String>,
    /// 概算行数がこれを超えるテーブルは走査しない。
    pub row_threshold: i64,
}

fn columns_to_scan(columns: &[TableColumnInfo]) -> Vec<ScanColumn> {
    columns
        .iter()
        .map(|c| ScanColumn {
            name: c.name.clone(),
            data_type: c.data_type.clone(),
        })
        .collect()
}

async fn scan_one_table(
    session: Arc<Session>,
    req: Arc<DataSearchRequest>,
    driver: DriverKind,
    table: String,
    estimate: Option<i64>,
    bulk_columns: Arc<HashMap<String, Vec<TableColumnInfo>>>,
    permits: Arc<Semaphore>,
) -> DataSearchEntry {
    let skipped = |reason: &'static str, detail: Option<String>| DataSearchEntry::Skipped {
        table: table.clone(),
        reason,
        detail,
    };
    if should_skip_table_for_scan(estimate, req.row_threshold) {
        return skipped("row-threshold", None);
    }
    let columns = match bulk_columns.get(&table) {
        Some(c) => c.clone(),
        None => {
            let conn = &session.conn;
            match session
                .schema_cache
                .columns(&req.database, &table, || {
                    conn.columns(&req.database, &table)
                })
                .await
            {
                Ok(c) => c,
                Err(e) => return skipped("error", Some(e.to_string())),
            }
        }
    };
    let scan_columns = columns_to_scan(&columns);
    let Some(scan) = build_table_scan_sql(
        driver,
        Some(&req.database),
        &table,
        &scan_columns,
        &req.term,
        req.mode,
    ) else {
        return skipped("no-searchable-columns", None);
    };
    // 読み取り専用ガード。走査 SQL は SELECT だけだが、強制は経路を問わず通す。
    if let Err(e) = ensure_allowed_for_session(&session, &scan.sql) {
        return skipped("error", Some(e.to_string()));
    }
    let Ok(_permit) = permits.acquire().await else {
        return skipped("error", Some("scan was shut down".to_string()));
    };
    match session.conn.execute(&scan.sql, Some(&req.database)).await {
        Ok(result) => {
            let row = result.rows.first().map(Vec::as_slice).unwrap_or(&[]);
            let hits = parse_scan_row(&scan.columns, row);
            if hits.is_empty() {
                DataSearchEntry::NoHit { table }
            } else {
                DataSearchEntry::Hit {
                    table,
                    columns: scan_columns,
                    hits,
                }
            }
        }
        Err(e) => skipped("error", Some(e.to_string())),
    }
}

/// [`data_search_stream`] の本体。各メッセージを `emit` へ順に渡し、`delivered` に
/// 送った結果テーブル数を反映する。キャンセルはタスクの abort で行う。
pub async fn data_search_core(
    session: Arc<Session>,
    req: DataSearchRequest,
    delivered: Arc<AtomicU64>,
    emit: impl Fn(DataSearchMessage),
) {
    let driver = session.conn.driver_kind();
    let req = Arc::new(req);
    let total = req.tables.len();

    // 概算行数 (スキップ判定用)。取れなければ「不明 = 除外しない」。
    let estimates: HashMap<String, Option<i64>> =
        match session.conn.table_row_estimates(&req.database).await {
            Ok(v) => v.into_iter().map(|e| (e.name, e.estimate)).collect(),
            Err(e) => {
                tracing::warn!(error = %e, "data search: row estimates unavailable");
                HashMap::new()
            }
        };

    // 列メタデータ。多数のテーブルを走査するなら DB 全体を 1 回で取る。
    let bulk_columns: Arc<HashMap<String, Vec<TableColumnInfo>>> =
        if total >= BULK_COLUMNS_MIN_TABLES {
            match fetch_columns_bulk(&session, &req.database).await {
                Ok(tables) => Arc::new(tables.into_iter().map(|t| (t.name, t.columns)).collect()),
                Err(e) => {
                    tracing::warn!(error = %e, "data search: bulk columns failed; using per-table");
                    Arc::new(HashMap::new())
                }
            }
        } else {
            Arc::new(HashMap::new())
        };

    let permits = Arc::new(Semaphore::new(DATA_SEARCH_CONCURRENCY));
    let mut set: JoinSet<(usize, DataSearchEntry)> = JoinSet::new();
    // 結果はテーブルの指定順に送る (並列でも表示順が実行ごとに変わらないように)。
    let mut buffered: Vec<Option<DataSearchEntry>> = vec![None; total];
    let mut next_to_emit = 0usize;
    let mut next_to_spawn = 0usize;

    loop {
        while next_to_spawn < total && set.len() < DATA_SEARCH_CONCURRENCY {
            let index = next_to_spawn;
            next_to_spawn += 1;
            let table = req.tables[index].clone();
            emit(DataSearchMessage::Progress {
                index,
                total,
                table: table.clone(),
            });
            let estimate = estimates.get(&table).copied().flatten();
            let fut = scan_one_table(
                session.clone(),
                req.clone(),
                driver,
                table,
                estimate,
                bulk_columns.clone(),
                permits.clone(),
            );
            set.spawn(async move { (index, fut.await) });
        }
        let Some(joined) = set.join_next().await else {
            break;
        };
        match joined {
            Ok((index, entry)) => {
                buffered[index] = Some(entry);
                while next_to_emit < total {
                    let Some(entry) = buffered[next_to_emit].take() else {
                        break;
                    };
                    emit(DataSearchMessage::Table { entry });
                    delivered.fetch_add(1, Ordering::SeqCst);
                    next_to_emit += 1;
                }
            }
            Err(e) => {
                emit(DataSearchMessage::Error {
                    error: format!("data search task failed: {e}"),
                    connection_lost: false,
                });
                return;
            }
        }
    }
    emit(DataSearchMessage::Done {});
}

/// DB 全体からの値検索 (#748)。テーブルごとの走査 SQL (`SUM(CASE …)`) を Rust 側で生成し、
/// 同時実行数を絞って並列に発行する。進捗・ヒットを `on_event` (Tauri Channel) へ逐次送り、
/// `cancel_stream(stream_id)` で走査中のテーブルごと中断できる。SELECT だけを発行し、
/// 読み取り専用ガードを通す。
#[tauri::command]
pub async fn data_search_stream(
    app: AppHandle,
    session_id: String,
    stream_id: String,
    request: DataSearchRequest,
    on_event: Channel<DataSearchMessage>,
    state: State<'_, AppState>,
) -> Result<()> {
    let session = state
        .get(&session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;
    let delivered = Arc::new(AtomicU64::new(0));
    let cancel_channel = on_event.clone();
    let on_cancel: Box<dyn Fn(u64) + Send + Sync> = Box::new(move |delivered_rows| {
        let _ = cancel_channel.send(DataSearchMessage::Cancelled { delivered_rows });
    });
    let stream_id_for_task = stream_id.clone();
    let delivered_for_task = delivered.clone();
    register_and_spawn(
        state.inner(),
        stream_id,
        delivered,
        on_cancel,
        move |token| async move {
            let channel = on_event.clone();
            data_search_core(session.clone(), request, delivered_for_task, move |msg| {
                if let Err(e) = channel.send(msg) {
                    tracing::warn!(error = %e, "failed to send data search message");
                }
            })
            .await;
            if let Some(state) = app.try_state::<AppState>() {
                state.forget_stream(&stream_id_for_task, token).await;
            }
        },
    )
    .await;
    Ok(())
}
