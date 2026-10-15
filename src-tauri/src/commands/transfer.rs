//! 接続間データ転送 (#986) — ソース接続のテーブル全件 / 単一結果セットを、別接続の
//! テーブルへスキーマ + データごと永続コピーする。
//!
//! 新しい DB 書き込み経路は増やさない:
//!
//! - **読み出し**は既存のストリーミング経路 `Connection::execute_stream`
//!   (`run_query_stream` / `export_query_stream` と同じバッチ列) をそのまま使う。
//!   ソースは読み取り専用文に限る (エクスポートと同じガード)。
//! - **書き込み**は既存のインポート経路 `Connection::import_rows` をバッチ単位で
//!   呼ぶ。DDL (CREATE / DROP) は通常の `execute` を通る。
//! - 型 / DDL のドライバ横断マッピングは純粋層 `db::transfer` に置いて単体テストする。
//!
//! **メモリに全件を載せない**: 読み出しタスクと書き込みループを容量の小さい
//! 有界チャネルで繋ぐ。`execute_stream` のコールバックは同期関数なので、チャネルが
//! 埋まっている間は `block_in_place` でそのワーカーだけを待たせる (= 背圧)。
//! 書き込みが遅ければ読み出しも止まり、同時に保持するのは高々数バッチ分になる。
//!
//! **安全網**: ターゲットが読み取り専用セッションなら (緊急書き込みモードでも)
//! バックエンドで拒否する (`import_csv` と同じ方針)。`is_production` /
//! `confirm_writes` の確認は UI レベル (`TransferModal`) の責務。
//!
//! **失敗 / キャンセル時の後始末**: 転送がテーブルを作成するモード
//! (`create` / `replace`) では、途中で失敗・キャンセルされたら作りかけのテーブルを
//! DROP する (中途半端なコピーを「完了したコピー」と取り違えさせない)。追記
//! (`append`) はバッチごとにコミットされるため、それまでに書き込んだ行は残る
//! (件数は `deliveredRows` / エラーイベントの `rows` で報告する)。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::commands::progress::{needs_final_emit, ProgressThrottle};
use crate::commands::query::{ensure_allowed_for_session, record_write_history};
use crate::db::transfer::{
    create_table_sql, drop_table_sql, hex_binary_columns, lossy_conversions, plan_columns_mapped,
    plan_warnings, select_cells, source_count_sql, source_select_sql, source_select_sql_ext,
    validate_target_table, value_to_cell, ColumnSpec, LossyConversion, TransferColumn,
    TransferMode,
};
use crate::db::types::{Column, StreamBatch};
use crate::db::upsert::{ConflictMode, ImportConflict};
use crate::db::{is_read_only_sql_for, DriverKind};
use crate::error::{AppError, Result};
use crate::state::{AppState, Session, StreamHandle, StreamKind};

/// 1 バッチ (= 1 回の `import_rows` 呼び出し) の既定行数。
const DEFAULT_TRANSFER_BATCH: usize = 1000;
/// 読み出し ⇔ 書き込み間に滞留させるバッチ数の上限 (背圧の効き具合)。
const CHANNEL_CAPACITY: usize = 2;

/// 転送前プレビューで型推定に読む先頭バッチの行数。
const PREVIEW_SAMPLE_ROWS: usize = 100;
/// プレビューが先頭バッチで読み出しを打ち切るための内部用の目印。
const PREVIEW_STOP: &str = "transfer preview sample complete";

pub(crate) const EV_TRANSFER_PROGRESS: &str = "transfer-stream:progress";
pub(crate) const EV_TRANSFER_DONE: &str = "transfer-stream:done";
pub(crate) const EV_TRANSFER_ERROR: &str = "transfer-stream:error";

/// 転送リクエスト。ソースは `source_table` (テーブル全件) か `source_sql`
/// (単一の読み取り専用クエリ) のどちらか一方。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferRequest {
    pub source_session_id: String,
    pub target_session_id: String,
    #[serde(default)]
    pub source_database: Option<String>,
    #[serde(default)]
    pub source_table: Option<String>,
    #[serde(default)]
    pub source_sql: Option<String>,
    #[serde(default)]
    pub target_database: Option<String>,
    pub target_table: String,
    #[serde(default)]
    pub mode: TransferMode,
    #[serde(default)]
    pub batch_size: Option<usize>,
    /// `mode == upsert` のときの衝突方針 (`skip` / `update`)。省略は `update`。
    /// 他のモードでは無視される (#1539)。
    #[serde(default)]
    pub conflict_mode: Option<ConflictMode>,
    /// `mode == upsert` のときの衝突判定キー列。省略 / 空は転送先テーブルの主キーを使う。
    #[serde(default)]
    pub key_columns: Option<Vec<String>>,
    /// 列の除外・改名・型上書き (#1623)。指定のない列はそのまま転送する。
    #[serde(default)]
    pub columns: Vec<ColumnSpec>,
    /// テーブル元の絞り込み条件 (`WHERE` の後ろに置く式。#1623)。クエリ元では指定できない。
    #[serde(default)]
    pub where_clause: Option<String>,
    /// 先頭 N 行だけ転送する (試験転送, #1623)。省略は全件。
    #[serde(default)]
    pub limit_rows: Option<u64>,
    /// 転送後にソース / 転送先の件数を照合する (#1623)。省略は true。テーブル元のときだけ
    /// ソース側を数える (`COUNT(*)` を転送の前後に 1 回ずつ発行する)。
    #[serde(default)]
    pub verify_counts: Option<bool>,
}

/// 転送の結果。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TransferOutcome {
    /// 書き込んだ行数。
    pub rows: u64,
    /// 転送先の列名 (重複除去後) と DDL 型。
    pub columns: Vec<TransferColumnInfo>,
    /// 損失のあるマッピングなどの注意書き。件数照合の食い違い (`integrity_warnings`) も含む。
    pub warnings: Vec<String>,
    /// 件数照合 (#1623) で見つかった食い違い。`warnings` の部分集合で、UI が転送前の
    /// 縮退警告と区別して完了時に知らせるために分けて持つ。
    pub integrity_warnings: Vec<String>,
}

/// 転送前プレビュー (#1532): 転送先の列定義と、値や型が縮退する列の一覧。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TransferPreview {
    pub columns: Vec<TransferColumnInfo>,
    pub lossy: Vec<LossyConversion>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TransferColumnInfo {
    pub name: String,
    pub source_type: String,
    pub target_type: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TransferProgressEvent {
    pub stream_id: String,
    pub rows: u64,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TransferDoneEvent {
    pub stream_id: String,
    pub rows: u64,
    pub elapsed_ms: u64,
    pub warnings: Vec<String>,
    /// 件数照合の食い違い (#1623)。
    pub integrity_warnings: Vec<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TransferErrorEvent {
    pub stream_id: String,
    pub message: String,
    /// 失敗までに書き込んだ行数。`create` / `replace` では作りかけのテーブルを
    /// DROP するので永続化はされない (情報提供のみ)。
    pub rows: u64,
}

/// 検証済みの転送計画 (セッション解決・ガード適用・ソース SQL 決定済み)。
pub(crate) struct PreparedTransfer {
    /// キャンセル時に `CreatedTableGuard` が DROP を直接 spawn せず預ける場所。
    /// [`CancelledTransferCleanup`] が DROP → キャッシュ無効化 → 履歴 を 1 タスクで順に
    /// 実行できるようにする (並行すると古いキャッシュを DROP 前に作り直しうる)。
    pub cancel_drop: Option<Arc<std::sync::Mutex<Option<DeferredDrop>>>>,
    pub source: Arc<Session>,
    pub target: Arc<Session>,
    pub source_sql: String,
    pub request: TransferRequest,
}

/// ターゲットが書き込み可能か。読み取り専用プロファイルは緊急書き込みモードでも
/// 拒否する (SQL 文ではない一括書き込みなので `import_csv` と同じ扱い)。
pub(crate) fn ensure_transfer_target_writable(session: &Session) -> Result<()> {
    if session.read_only {
        tracing::warn!(session_id = %session.id, "read-only guard rejected a data transfer");
        return Err(AppError::ReadOnly(
            "read-only profile: data transfer into this connection is not allowed".into(),
        ));
    }
    Ok(())
}

/// セッション解決とガードを行い、転送計画を組み立てる (I/O はしない)。
pub(crate) async fn prepare_transfer(
    state: &AppState,
    request: TransferRequest,
) -> Result<PreparedTransfer> {
    prepare_transfer_with(state, request, true).await
}

/// [`prepare_transfer`] の本体。`require_writable = false` は書き込みをしないプレビュー用で、
/// 読み取り専用の転送先でも列計画を見せる (スキーマアドバイザと同じ方針, #1612)。
async fn prepare_transfer_with(
    state: &AppState,
    request: TransferRequest,
    require_writable: bool,
) -> Result<PreparedTransfer> {
    let source = state
        .get(&request.source_session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(request.source_session_id.clone()))?;
    let target = state
        .get(&request.target_session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(request.target_session_id.clone()))?;
    if require_writable {
        ensure_transfer_target_writable(&target)?;
    }
    validate_target_table(&request.target_table)?;

    let source_driver = source.conn.driver_kind();
    let where_clause = request
        .where_clause
        .as_deref()
        .map(str::trim)
        .filter(|w| !w.is_empty());
    if request.limit_rows == Some(0) {
        return Err(AppError::InvalidInput(
            "limit_rows must be at least 1".into(),
        ));
    }
    let source_sql = match (
        request.source_table.as_deref().map(str::trim),
        request.source_sql.as_deref().map(str::trim),
    ) {
        (Some(t), None) if !t.is_empty() => {
            // 除外する列があるテーブル元は、SELECT リストをカタログから組んで読まない列を
            // サーバ側で省く (大きな BLOB 列などを無駄に転送しない)。
            let select_columns = excluded_aware_select_columns(&source, &request, t).await?;
            let sql = if select_columns.is_none() && where_clause.is_none() && request.limit_rows.is_none() {
                source_select_sql(source_driver, t)
            } else {
                source_select_sql_ext(
                    source_driver,
                    t,
                    select_columns.as_deref(),
                    where_clause,
                    request.limit_rows,
                )
            };
            if where_clause.is_some() {
                // 利用者が書いた式を埋め込むので、完成した SQL 全体に読み取り専用ガードを掛ける。
                ensure_allowed_for_session(&source, &sql)?;
                if !is_read_only_sql_for(source_driver, &sql) {
                    return Err(AppError::ReadOnly(
                        "transfer filter must keep the source statement read-only".into(),
                    ));
                }
            }
            sql
        }
        (None, Some(sql)) if !sql.is_empty() => {
            if where_clause.is_some() {
                return Err(AppError::InvalidInput(
                    "a WHERE filter can only be used with a table source".into(),
                ));
            }
            // エクスポートと同じく、ソースは読み取り専用文に限る (転送が
            // ソース側を書き換えることは決してない)。
            ensure_allowed_for_session(&source, sql)?;
            if !is_read_only_sql_for(source_driver, sql) {
                return Err(AppError::ReadOnly(
                    "transfer source must be a read-only statement (SELECT / WITH ...)".into(),
                ));
            }
            // 試験転送: サーバ側でも読み出しを打ち切る (付けられない文は読み手側で打ち切る)。
            match request.limit_rows {
                Some(n) => crate::db::apply_auto_limit_for(source_driver, sql, n as usize)
                    .unwrap_or_else(|| sql.to_string()),
                None => sql.to_string(),
            }
        }
        _ => {
            return Err(AppError::InvalidInput(
                "specify exactly one of source table or source query".into(),
            ))
        }
    };

    // 同じセッション上で「自分自身へ」作り直し/新規作成すると、ソースを DROP
    // したり読みながら書いたりすることになるので拒否する。
    if request.source_session_id == request.target_session_id
        && !request.mode.writes_existing_table()
    {
        let same_db = request.source_database.as_deref().unwrap_or("")
            == request.target_database.as_deref().unwrap_or("");
        if let Some(t) = request.source_table.as_deref() {
            if same_db && is_same_table_name(target.conn.driver_kind(), t, &request.target_table) {
                return Err(AppError::InvalidInput(
                    "source and target are the same table".into(),
                ));
            }
        } else if request.source_sql.is_some() {
            // クエリ元でも、転送先と同名のテーブルを読むなら置き換え (DROP) でソースが
            // 消える。クエリは `shop.users` のように別 DB を修飾して読めるので、DB の一致は
            // 見ず (同一セッションだけで判定し)、同名の識別子があれば拒否する (#1598)。
            if crate::db::where_used::mentions_table_name(
                &source_sql,
                request.target_table.trim(),
                source_driver,
            ) {
                return Err(AppError::InvalidInput(
                    "source query reads the target table".into(),
                ));
            }
        }
    }

    Ok(PreparedTransfer {
        cancel_drop: None,
        source,
        target,
        source_sql,
        request,
    })
}

/// 除外指定のあるテーブル元の SELECT リスト (残す列の名前)。除外が無ければ `None`。
/// カタログに無い列名の除外指定は無視する (ソースが変わった場合に備える)。
async fn excluded_aware_select_columns(
    source: &Session,
    request: &TransferRequest,
    table: &str,
) -> Result<Option<Vec<String>>> {
    if !request.columns.iter().any(|c| c.exclude) {
        return Ok(None);
    }
    let resolved = source
        .conn
        .resolve_database(request.source_database.as_deref())
        .await;
    let db = if resolved.is_empty() { "main" } else { resolved.as_str() };
    let all = source.conn.columns(db, table).await?;
    let kept: Vec<String> = all
        .into_iter()
        .map(|c| c.name)
        .filter(|n| !request.columns.iter().any(|s| s.exclude && &s.source == n))
        .collect();
    if kept.is_empty() {
        return Err(AppError::InvalidInput(
            "every column is excluded from the transfer".into(),
        ));
    }
    Ok(Some(kept))
}

/// 同一テーブル名か。PostgreSQL は引用符付き識別子で大文字小文字を区別する
/// (`Users` と `users` は別テーブル) ので厳密比較し、MySQL / SQLite は
/// 大文字小文字を無視した比較にする (#1598)。
fn is_same_table_name(driver: DriverKind, a: &str, b: &str) -> bool {
    let (a, b) = (a.trim(), b.trim());
    if driver == DriverKind::Postgres {
        a == b
    } else {
        a.eq_ignore_ascii_case(b)
    }
}

/// タスク破棄 (= キャンセル) 時に読み出しタスクも止めるためのガード。
struct AbortOnDrop(tokio::task::JoinHandle<Result<()>>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// 転送が作成したテーブルを、正常完了しなかったときに DROP するガード。エラー経路では
/// 明示的に `cleanup` を await し、キャンセル (future の drop) 経路では Drop で
/// バックグラウンドタスクへ投げる (Drop では await できないため)。
/// キャンセル時に実行する DROP (ターゲット・DB・SQL)。
pub(crate) struct DeferredDrop {
    target: Arc<Session>,
    database: Option<String>,
    sql: String,
}

/// 中断された書き込みと競合して DROP が一時的に失敗しうるので、少し待って再試行する。
async fn drop_with_retry(target: &Session, database: Option<&str>, sql: &str) {
    for attempt in 0..10 {
        match target.conn.execute(sql, database).await {
            Ok(_) => return,
            Err(e) if attempt == 9 => {
                tracing::warn!(error = %e, "failed to drop cancelled transfer's table");
            }
            Err(_) => tokio::time::sleep(std::time::Duration::from_millis(200)).await,
        }
    }
}

struct CreatedTableGuard {
    /// `Some` のとき、Drop で DROP を自前 spawn せずここへ預ける (後始末タスクが実行する)。
    deferred: Option<Arc<std::sync::Mutex<Option<DeferredDrop>>>>,
    target: Arc<Session>,
    database: Option<String>,
    drop_sql: String,
    armed: bool,
}

impl CreatedTableGuard {
    fn disarm(&mut self) {
        self.armed = false;
    }

    async fn cleanup(&mut self) {
        if self.armed {
            self.armed = false;
            if let Err(e) = self
                .target
                .conn
                .execute(&self.drop_sql, self.database.as_deref())
                .await
            {
                tracing::warn!(error = %e, "failed to drop partially transferred table");
            }
        }
    }
}

impl Drop for CreatedTableGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            tracing::warn!("no runtime to drop partially transferred table");
            return;
        };
        let target = self.target.clone();
        let database = self.database.clone();
        let sql = std::mem::take(&mut self.drop_sql);
        if let Some(slot) = &self.deferred {
            // 後始末タスク (CancelledTransferCleanup) が DROP → キャッシュ → 履歴を順に行う。
            if let Ok(mut g) = slot.lock() {
                *g = Some(DeferredDrop {
                    target,
                    database,
                    sql,
                });
                return;
            }
        }
        handle.spawn(async move {
            drop_with_retry(&target, database.as_deref(), &sql).await;
        });
    }
}

/// 転送タスクがキャンセル (`cancel_stream` による abort = future の drop) されたとき、
/// 通常完了時に走る後処理 ([`after_transfer`]: キャッシュ無効化 + 履歴) を代わりに行う
/// ガード。abort では `after_transfer` を呼ぶ行まで到達しないため、Append で途中まで
/// コミット済みの行があってもターゲットの `query_cache` が古いまま残り、書き込みも履歴に
/// 残らなかった。Drop では await できないのでバックグラウンドタスクへ投げる。
struct CancelledTransferCleanup {
    prepared: Arc<PreparedTransfer>,
    counter: Arc<AtomicU64>,
    started: Instant,
    armed: bool,
}

impl CancelledTransferCleanup {
    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for CancelledTransferCleanup {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            tracing::warn!("no runtime for cancelled transfer post-processing");
            return;
        };
        let prepared = self.prepared.clone();
        let rows = self.counter.load(Ordering::SeqCst);
        let elapsed_ms = self.started.elapsed().as_millis() as u64;
        let deferred = self.prepared.cancel_drop.clone();
        handle.spawn(async move {
            // 1. 作成済みテーブルの DROP (ガードが預けたもの) → 2. キャッシュ無効化 → 3. 履歴。
            let job = deferred.and_then(|slot| slot.lock().ok().and_then(|mut g| g.take()));
            if let Some(job) = job {
                drop_with_retry(&job.target, job.database.as_deref(), &job.sql).await;
            }
            let result: Result<TransferOutcome> = Err(AppError::Other(format!(
                "transfer cancelled ({rows} rows had been read)"
            )));
            after_transfer(&prepared, &result, elapsed_ms).await;
        });
    }
}

/// ターゲット側の準備 (列計画 + DDL)。最初のバッチ (または空結果の終端) で 1 回だけ呼ぶ。
async fn prepare_target(
    target: &Arc<Session>,
    request: &TransferRequest,
    columns: &[Column],
    sample: &[Vec<crate::db::types::Value>],
    guard: &mut Option<CreatedTableGuard>,
    deferred: &Option<Arc<std::sync::Mutex<Option<DeferredDrop>>>>,
) -> Result<(Vec<TransferColumn>, Option<Vec<usize>>)> {
    let driver = target.conn.driver_kind();
    let (plan, keep) = plan_columns_mapped(columns, sample, &request.columns)?;
    if plan.is_empty() {
        return Err(AppError::InvalidInput(
            "transfer source returned no columns".into(),
        ));
    }
    let db = request.target_database.as_deref().filter(|d| !d.is_empty());
    let table = request.target_table.trim();
    match request.mode {
        TransferMode::Append | TransferMode::Upsert => {}
        TransferMode::Create | TransferMode::Replace => {
            if request.mode == TransferMode::Replace {
                target
                    .conn
                    .execute(&drop_table_sql(driver, table), db)
                    .await?;
            }
            target
                .conn
                .execute(&create_table_sql(driver, table, &plan), db)
                .await?;
            *guard = Some(CreatedTableGuard {
                deferred: deferred.clone(),
                target: target.clone(),
                database: db.map(str::to_string),
                drop_sql: drop_table_sql(driver, table),
                armed: true,
            });
        }
    }
    Ok((plan, keep))
}

/// 転送の衝突設定を決める (#1539)。`upsert` 以外は従来どおり素の INSERT。
/// `upsert` ではキー列を、リクエストの指定 → 転送先テーブルの主キーの順に解決し、
/// 転送する列に含まれることを確かめる。名前は転送先の綴り (大文字小文字) に揃える。
async fn resolve_conflict(
    target: &Session,
    request: &TransferRequest,
    plan: &[TransferColumn],
) -> Result<ImportConflict> {
    if request.mode != TransferMode::Upsert {
        return Ok(ImportConflict::insert_only());
    }
    let wanted: Vec<String> = match request.key_columns.as_deref() {
        Some(keys) if !keys.is_empty() => keys.to_vec(),
        _ => {
            let db = request
                .target_database
                .as_deref()
                .filter(|d| !d.is_empty())
                .unwrap_or("");
            target
                .conn
                .columns(db, request.target_table.trim())
                .await?
                .into_iter()
                .filter(|c| c.key == "PRI")
                .map(|c| c.name)
                .collect()
        }
    };
    if wanted.is_empty() {
        return Err(AppError::InvalidInput(
            "upsert needs key columns: the target table has no primary key, so specify them".into(),
        ));
    }
    let mut keys = Vec::with_capacity(wanted.len());
    for w in &wanted {
        let found = plan
            .iter()
            .find(|c| c.name == *w)
            .or_else(|| plan.iter().find(|c| c.name.eq_ignore_ascii_case(w)))
            .ok_or_else(|| {
                AppError::InvalidInput(format!(
                    "upsert key column is not among the transferred columns: {w}"
                ))
            })?;
        if !keys.contains(&found.name) {
            keys.push(found.name.clone());
        }
    }
    let names: Vec<String> = plan.iter().map(|c| c.name.clone()).collect();
    let conflict = ImportConflict {
        mode: request.conflict_mode.unwrap_or(ConflictMode::Update),
        key_columns: keys,
    };
    // 転送する列がキー列だけのときは `update` で更新する列が無い。方言ごとの SQL が
    // 壊れないよう、その場合は `skip` に倒す。
    let conflict =
        if conflict.mode == ConflictMode::Update && names.len() == conflict.key_columns.len() {
            ImportConflict {
                mode: ConflictMode::Skip,
                ..conflict
            }
        } else {
            conflict
        };
    conflict.validate(&names)?;
    // MySQL の `ON DUPLICATE KEY UPDATE` は主キー以外の UNIQUE でも発火し、別の行を
    // 上書きしうる。取り込み (import) と同じ検証で、危険な表は実行前に拒否する。
    target
        .conn
        .check_upsert_keys(
            request.target_database.as_deref().filter(|d| !d.is_empty()),
            request.target_table.trim(),
            &names,
            &conflict,
        )
        .await?;
    Ok(conflict)
}

/// バッチ 1 つ分をテキストセルへ変換して既存のインポート経路で書き込む。
async fn write_batch(
    target: &Session,
    request: &TransferRequest,
    driver: DriverKind,
    plan: &[TransferColumn],
    rows: &[Vec<crate::db::types::Value>],
    batch_size: usize,
    conflict: &ImportConflict,
) -> Result<u64> {
    if rows.is_empty() {
        return Ok(0);
    }
    // SQLite の INTEGER に入らない BIGINT UNSIGNED は黙って REAL にせず行エラーにする。
    crate::db::transfer::check_sqlite_unsigned_range(driver, plan, rows)?;
    let names: Vec<String> = plan.iter().map(|c| c.name.clone()).collect();
    let cells: Vec<Vec<Option<String>>> = rows
        .iter()
        .map(|row| {
            plan.iter()
                .enumerate()
                .map(|(i, c)| row.get(i).and_then(|v| value_to_cell(driver, &c.ty, v)))
                .collect()
        })
        .collect();
    let db = request.target_database.as_deref().filter(|d| !d.is_empty());
    // SQLite / MySQL のバイナリ列は hex 文字列で bind し、値式側で unhex する
    // (全件投入後の UPDATE を不要にする #1530)。
    let hex_binary = hex_binary_columns(driver, plan);
    target
        .conn
        .import_rows_with_binary(
            db,
            request.target_table.trim(),
            &names,
            &cells,
            batch_size,
            // 衝突時の扱いは `TransferMode` / `resolve_conflict` で事前に決める
            // (upsert 以外は素の INSERT)。
            conflict,
            &hex_binary,
            |_| Ok(()),
        )
        .await
}

/// `SELECT COUNT(*)` の結果を数値として読む。取れなければ `None` (照合は付加機能なので
/// 失敗しても転送自体は失敗させない)。
async fn count_rows(session: &Session, sql: &str, database: Option<&str>) -> Option<u64> {
    use crate::db::types::Value;
    let res = session.conn.execute(sql, database).await.ok()?;
    match res.rows.first()?.first()? {
        Value::Int(n) => u64::try_from(*n).ok(),
        Value::UInt(n) => Some(*n),
        Value::String(s) => s.trim().parse().ok(),
        Value::Float(f) if *f >= 0.0 => Some(*f as u64),
        _ => None,
    }
}

/// 転送前に数えておく件数 (#1623)。
#[derive(Debug, Default, Clone, Copy)]
struct CountsBefore {
    /// テーブル元の対象行数 (WHERE 適用後)。
    source: Option<u64>,
    /// 転送先の既存行数 (追記系のみ)。
    target: Option<u64>,
}

fn verify_enabled(request: &TransferRequest) -> bool {
    request.verify_counts.unwrap_or(true)
}

fn target_count_sql(prepared: &PreparedTransfer) -> String {
    source_count_sql(
        prepared.target.conn.driver_kind(),
        prepared.request.target_table.trim(),
        None,
    )
}

fn source_where(request: &TransferRequest) -> Option<&str> {
    request.where_clause.as_deref()
}

async fn count_before(prepared: &PreparedTransfer) -> CountsBefore {
    let request = &prepared.request;
    if !verify_enabled(request) {
        return CountsBefore::default();
    }
    let source = match request.source_table.as_deref() {
        Some(t) => {
            let sql = source_count_sql(
                prepared.source.conn.driver_kind(),
                t.trim(),
                source_where(request),
            );
            count_rows(
                &prepared.source,
                &sql,
                request.source_database.as_deref().filter(|d| !d.is_empty()),
            )
            .await
        }
        None => None,
    };
    let target = if request.mode.writes_existing_table() {
        count_rows(
            &prepared.target,
            &target_count_sql(prepared),
            request.target_database.as_deref().filter(|d| !d.is_empty()),
        )
        .await
    } else {
        None
    };
    CountsBefore { source, target }
}

/// 転送前後の件数と書き込み件数を突き合わせ、食い違いの注意書きを返す (#1623)。
async fn verify_counts(
    prepared: &PreparedTransfer,
    before: CountsBefore,
    written: u64,
) -> Vec<String> {
    let request = &prepared.request;
    let mut out = Vec::new();
    if !verify_enabled(request) {
        return out;
    }
    let mut source_after = None;
    if let (Some(b), Some(t)) = (before.source, request.source_table.as_deref()) {
        let sql = source_count_sql(
            prepared.source.conn.driver_kind(),
            t.trim(),
            source_where(request),
        );
        source_after = count_rows(
            &prepared.source,
            &sql,
            request.source_database.as_deref().filter(|d| !d.is_empty()),
        )
        .await;
        let expected = request.limit_rows.map_or(b, |l| l.min(b));
        // upsert は衝突行を読み飛ばす / 更新するので、書き込み件数が行数と一致するとは限らない。
        if request.mode != TransferMode::Upsert && written != expected {
            out.push(format!(
                "row count mismatch: the source had {expected} row(s) to transfer but {written} were written"
            ));
        }
        if let Some(a) = source_after {
            if a != b {
                out.push(format!(
                    "the source row count changed during the transfer ({b} before, {a} after), so the copy may not match the source"
                ));
            }
        }
    }
    // 転送先: 作成系は書き込み件数 = 行数、追記は増分 = 書き込み件数。
    if request.mode != TransferMode::Upsert {
        let after = count_rows(
            &prepared.target,
            &target_count_sql(prepared),
            request.target_database.as_deref().filter(|d| !d.is_empty()),
        )
        .await;
        if let Some(after) = after {
            let delta = after.saturating_sub(before.target.unwrap_or(0));
            let baseline_known = !request.mode.writes_existing_table() || before.target.is_some();
            if baseline_known && delta != written {
                out.push(format!(
                    "target row count mismatch: {written} row(s) were written but the target table gained {delta}"
                ));
            }
        }
    }
    let _ = source_after;
    out
}

/// 転送本体。`counter` は書き込み済み行数 (キャンセル時に `cancel_stream` が読む)。
pub(crate) async fn run_transfer(
    prepared: &PreparedTransfer,
    counter: Arc<AtomicU64>,
    mut on_progress: impl FnMut(u64),
) -> Result<TransferOutcome> {
    let request = &prepared.request;
    let target = prepared.target.clone();
    let driver = target.conn.driver_kind();
    let batch_size = request
        .batch_size
        .unwrap_or(DEFAULT_TRANSFER_BATCH)
        .clamp(1, 10_000);

    // `block_in_place` はマルチスレッドランタイム専用 (Tauri の非同期ランタイムは
    // マルチスレッド)。current_thread 上で呼ぶと panic するので先に弾く。
    let rt = tokio::runtime::Handle::current();
    if rt.runtime_flavor() != tokio::runtime::RuntimeFlavor::MultiThread {
        return Err(AppError::Other(
            "data transfer requires a multi-threaded runtime".into(),
        ));
    }

    let (tx, mut rx) = tokio::sync::mpsc::channel::<StreamBatch>(CHANNEL_CAPACITY);
    let source = prepared.source.clone();
    let sql = prepared.source_sql.clone();
    let source_db = request.source_database.clone().filter(|d| !d.is_empty());
    let mut reader = AbortOnDrop(tokio::spawn(async move {
        source
            .conn
            .execute_stream(
                &sql,
                source_db.as_deref(),
                batch_size,
                batch_size,
                move |batch| {
                    let rt = tokio::runtime::Handle::current();
                    tokio::task::block_in_place(|| rt.block_on(tx.send(batch)))
                        .map_err(|_| AppError::Other("transfer writer stopped".into()))
                },
            )
            .await
            .map(|_| ())
    }));

    let mut guard: Option<CreatedTableGuard> = None;
    let body = async {
        let mut columns: Option<Vec<Column>> = None;
        let mut plan: Option<Vec<TransferColumn>> = None;
        let mut conflict: Option<ImportConflict> = None;
        let mut written: u64 = 0;
        // 列の除外 (#1623) があるときの、残すソース列の位置。
        let mut keep: Option<Vec<usize>> = None;
        // 試験転送 (#1623): 読んだ行数と、上限に達して読み出しを打ち切ったか。
        let limit = request.limit_rows;
        let mut read: u64 = 0;
        let mut stopped_early = false;
        while let Some(batch) = rx.recv().await {
            match batch {
                StreamBatch::Columns(c) => columns = Some(c),
                StreamBatch::Rows(mut rows) => {
                    if let Some(limit) = limit {
                        let remaining = limit.saturating_sub(read) as usize;
                        rows.truncate(remaining);
                        read += rows.len() as u64;
                    }
                    if plan.is_none() {
                        let cols = columns.as_deref().ok_or_else(|| {
                            AppError::Other("transfer source sent rows before columns".into())
                        })?;
                        let (p, k) = prepare_target(
                            &target,
                            request,
                            cols,
                            &rows,
                            &mut guard,
                            &prepared.cancel_drop,
                        )
                        .await?;
                        plan = Some(p);
                        keep = k;
                    }
                    let rows = match &keep {
                        Some(k) => rows.iter().map(|r| select_cells(r, k)).collect(),
                        None => rows,
                    };
                    let p = plan.as_deref().unwrap_or(&[]);
                    // 衝突設定は最初のバッチで 1 回だけ解決する (upsert のキー列解決で
                    // 転送先のカタログを引くため)。
                    if conflict.is_none() {
                        conflict = Some(resolve_conflict(&target, request, p).await?);
                    }
                    let c = conflict.as_ref().cloned().unwrap_or_default();
                    written +=
                        write_batch(&target, request, driver, p, &rows, batch_size, &c).await?;
                    counter.store(written, Ordering::SeqCst);
                    on_progress(written);
                    if limit.is_some_and(|l| read >= l) {
                        stopped_early = true;
                        break;
                    }
                }
            }
        }
        // チャネルが閉じた = 読み出しタスクが終わった (成功 or 失敗)。上限で打ち切った
        // ときは読み出し側が「書き込み側が止まった」エラーになりうるので無視する。
        drop(rx);
        let read_result = match (&mut reader.0).await {
            Ok(r) => r,
            Err(e) => Err(AppError::Other(format!("transfer reader failed: {e}"))),
        };
        if !stopped_early {
            read_result?;
        }
        let plan = match plan {
            Some(p) => p,
            // 0 行の結果でも、列定義どおりのテーブルは作る。
            None => {
                let mut cols = columns.ok_or_else(|| {
                    AppError::Other("transfer source returned no result set".into())
                })?;
                // 一部のドライバ (SQLite) は 0 行の結果で列定義を返せない。テーブル
                // 転送ならカタログから列定義を引いて空テーブルを作る。
                if cols.is_empty() {
                    if let Some(t) = request.source_table.as_deref() {
                        let db = request
                            .source_database
                            .as_deref()
                            .filter(|d| !d.is_empty())
                            .unwrap_or("main");
                        cols = prepared
                            .source
                            .conn
                            .columns(db, t.trim())
                            .await?
                            .into_iter()
                            .map(|c| Column {
                                name: c.name,
                                type_name: c.data_type,
                            })
                            .collect();
                    }
                }
                prepare_target(
                    &target,
                    request,
                    &cols,
                    &[],
                    &mut guard,
                    &prepared.cancel_drop,
                )
                .await?
                .0
            }
        };
        Ok::<_, AppError>((written, plan))
    };
    let result = body.await;

    match result {
        Ok((rows, plan)) => {
            if let Some(g) = guard.as_mut() {
                g.disarm();
            }
            // 追記は DDL を発行せず既存テーブルの型で書くので、型の縮退は起きない。
            let warnings = if request.mode.creates_table() {
                plan_warnings(driver, &plan)
            } else {
                Vec::new()
            };
            let columns = plan
                .iter()
                .map(|c| TransferColumnInfo {
                    name: c.name.clone(),
                    source_type: c.source_type.clone(),
                    target_type: crate::db::transfer::target_type_sql(driver, &c.ty),
                })
                .collect();
            Ok(TransferOutcome {
                rows,
                columns,
                warnings,
            })
        }
        Err(e) => {
            if let Some(g) = guard.as_mut() {
                g.cleanup().await;
            }
            Err(e)
        }
    }
}

/// `run_transfer` の後処理 (キャッシュ無効化 + 履歴)。
async fn after_transfer(
    prepared: &PreparedTransfer,
    result: &Result<TransferOutcome>,
    elapsed_ms: u64,
) {
    let target = &prepared.target;
    // DDL (CREATE / DROP) とバルク書き込みを伴うので、ターゲットのスキーマ /
    // クエリ結果キャッシュを丸ごと無効化する (失敗時も DROP 済みの可能性がある)。
    target.schema_cache.invalidate_all().await;
    target.query_cache.invalidate_all().await;
    let req = &prepared.request;
    let source_label = match (&req.source_table, &req.source_sql) {
        (Some(t), _) => format!("table {t}"),
        _ => "query".to_string(),
    };
    let summary = format!(
        "-- transfer ({:?}) {} from session {} into {}",
        req.mode, source_label, req.source_session_id, req.target_table
    );
    let db = req.target_database.as_deref();
    match result {
        Ok(o) => {
            record_write_history(
                target,
                summary,
                db,
                Some(o.rows as i64),
                Some(elapsed_ms as i64),
                None,
            )
            .await
        }
        Err(e) => record_write_history(target, summary, db, None, None, Some(e.to_string())).await,
    }
}

/// Tauri を介さずに転送を最後まで実行するコア (統合テスト用に `__test_api` から公開)。
pub async fn transfer_data_inner(
    state: &AppState,
    request: TransferRequest,
    counter: Arc<AtomicU64>,
    on_progress: impl FnMut(u64),
) -> Result<TransferOutcome> {
    let prepared = prepare_transfer(state, request).await?;
    let started = Instant::now();
    let result = run_transfer(&prepared, counter, on_progress).await;
    after_transfer(&prepared, &result, started.elapsed().as_millis() as u64).await;
    result
}

/// 転送を実行せずに、転送先の列定義と縮退する変換を返す (#1532)。ソースは先頭バッチだけ
/// 読んで打ち切る (書き込み・DDL は一切しない)。
pub async fn preview_transfer_inner(
    state: &AppState,
    mut request: TransferRequest,
) -> Result<TransferPreview> {
    if request.target_table.trim().is_empty() {
        request.target_table = "preview".into();
    }
    // プレビューは書き込まないので、読み取り専用の転送先でも許可する。
    let prepared = prepare_transfer_with(state, request, false).await?;
    let driver = prepared.target.conn.driver_kind();
    let request = &prepared.request;

    let mut columns: Option<Vec<Column>> = None;
    let mut sample: Vec<Vec<crate::db::types::Value>> = Vec::new();
    let mut stopped = false;
    let source_db = request.source_database.clone().filter(|d| !d.is_empty());
    // サーバ側でも読み出しを止めるため、ソース SQL に LIMIT を入れる。クライアントがストリームを
    // 捨てるだけだと MySQL / PostgreSQL はクエリを最後まで走らせ、残りを次の利用時に受信して
    // 捨てることになる (大きなテーブルで毎回全件読み出しになる)。LIMIT を入れられない文
    // (既に LIMIT があるなど) は元の SQL のまま先頭バッチで打ち切る。
    let source_driver = prepared.source.conn.driver_kind();
    let limited_sql =
        crate::db::apply_auto_limit_for(source_driver, &prepared.source_sql, PREVIEW_SAMPLE_ROWS)
            .unwrap_or_else(|| prepared.source_sql.clone());
    let res = prepared
        .source
        .conn
        .execute_stream(
            &limited_sql,
            source_db.as_deref(),
            PREVIEW_SAMPLE_ROWS,
            PREVIEW_SAMPLE_ROWS,
            |batch| match batch {
                StreamBatch::Columns(c) => {
                    columns = Some(c);
                    Ok(())
                }
                StreamBatch::Rows(rows) => {
                    sample = rows;
                    stopped = true;
                    // 型推定に必要な先頭バッチだけで十分。残りは読まずに打ち切る。
                    Err(AppError::Other(PREVIEW_STOP.into()))
                }
            },
        )
        .await;
    if let Err(e) = res {
        if !stopped {
            return Err(e);
        }
    }
    let mut cols = columns.unwrap_or_default();
    if cols.is_empty() {
        if let Some(t) = request.source_table.as_deref() {
            let db = request
                .source_database
                .as_deref()
                .filter(|d| !d.is_empty())
                .unwrap_or("main");
            cols = prepared
                .source
                .conn
                .columns(db, t.trim())
                .await?
                .into_iter()
                .map(|c| Column {
                    name: c.name,
                    type_name: c.data_type,
                })
                .collect();
        }
    }
    let plan = plan_columns(&cols, &sample);
    Ok(TransferPreview {
        columns: plan
            .iter()
            .map(|c| TransferColumnInfo {
                name: c.name.clone(),
                source_type: c.source_type.clone(),
                target_type: crate::db::transfer::target_type_sql(driver, &c.ty),
            })
            .collect(),
        lossy: lossy_conversions(driver, &plan),
    })
}

/// 転送前プレビュー (#1532)。書き込みはしない。
#[tauri::command]
pub async fn preview_transfer(
    request: TransferRequest,
    state: State<'_, AppState>,
) -> Result<TransferPreview> {
    preview_transfer_inner(&state, request).await
}

/// ソース接続の結果セットを別接続のテーブルへ転送する (#986)。進捗は
/// `transfer-stream:*` イベントで通知し、`cancel_stream` で中断できる。
#[tauri::command]
pub async fn transfer_data(
    app: AppHandle,
    stream_id: String,
    request: TransferRequest,
    state: State<'_, AppState>,
) -> Result<()> {
    // 入力・ガードのエラーは invoke の戻り値として即座に返す。
    let mut prepared = prepare_transfer(&state, request).await?;
    // キャンセル時の DROP をキャッシュ無効化・履歴と順序づけて実行できるよう預け先を用意する。
    prepared.cancel_drop = Some(Arc::new(std::sync::Mutex::new(None)));
    let prepared = Arc::new(prepared);
    let counter = Arc::new(AtomicU64::new(0));

    // register_stream をタスク本体より前に完了させるゲート (export / import と同じ
    // 理由。#685)。トークンで自分の登録だけを forget_stream する。
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel::<u64>();
    let stream_id_for_task = stream_id.clone();
    let counter_for_task = counter.clone();
    let handle = tokio::spawn(async move {
        let Ok(token) = ready_rx.await else {
            return;
        };
        let emit_app = app.clone();
        let emit_id = stream_id_for_task.clone();
        let started = Instant::now();
        // abort (キャンセル) されると以降の after_transfer に到達しないので、その場合は
        // このガードの Drop が代わりにキャッシュ無効化と履歴記録を行う。
        let mut cancel_cleanup = CancelledTransferCleanup {
            prepared: prepared.clone(),
            counter: counter_for_task.clone(),
            started,
            armed: true,
        };
        // 進捗イベントは 150ms ごとに間引く (#1258)。最終値は完了前に追い送りする。
        let emitted = Arc::new(AtomicU64::new(0));
        let emitted_cb = emitted.clone();
        let mut throttle = ProgressThrottle::standard();
        let result = run_transfer(&prepared, counter_for_task.clone(), move |rows| {
            if !throttle.ready() {
                return;
            }
            emitted_cb.store(rows, Ordering::SeqCst);
            let _ = emit_app.emit(
                EV_TRANSFER_PROGRESS,
                TransferProgressEvent {
                    stream_id: emit_id.clone(),
                    rows,
                },
            );
        })
        .await;
        if let Ok(outcome) = &result {
            if needs_final_emit(emitted.load(Ordering::SeqCst), outcome.rows) {
                let _ = app.emit(
                    EV_TRANSFER_PROGRESS,
                    TransferProgressEvent {
                        stream_id: stream_id_for_task.clone(),
                        rows: outcome.rows,
                    },
                );
            }
        }
        let elapsed_ms = started.elapsed().as_millis() as u64;
        cancel_cleanup.disarm();
        after_transfer(&prepared, &result, elapsed_ms).await;
        match result {
            Ok(outcome) => {
                tracing::info!(stream_id = %stream_id_for_task, rows = outcome.rows, "data transfer complete");
                let _ = app.emit(
                    EV_TRANSFER_DONE,
                    TransferDoneEvent {
                        stream_id: stream_id_for_task.clone(),
                        rows: outcome.rows,
                        elapsed_ms,
                        warnings: outcome.warnings,
                    },
                );
            }
            Err(e) => {
                tracing::error!(stream_id = %stream_id_for_task, error = %e, "data transfer failed");
                let _ = app.emit(
                    EV_TRANSFER_ERROR,
                    TransferErrorEvent {
                        stream_id: stream_id_for_task.clone(),
                        message: e.to_string(),
                        rows: counter_for_task.load(Ordering::SeqCst),
                    },
                );
            }
        }
        if let Some(state) = app.try_state::<AppState>() {
            state.forget_stream(&stream_id_for_task, token).await;
        }
    });
    let token = state
        .register_stream(
            stream_id,
            StreamHandle {
                abort: handle.abort_handle(),
                delivered_rows: counter,
                kind: StreamKind::Transfer,
                // Export / Import と同じく名前付きイベント
                // (`transfer-stream:cancelled`) でキャンセルを通知する。
                on_cancel: None,
            },
        )
        .await;
    let _ = ready_tx.send(token);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_table_name_is_case_sensitive_only_on_postgres_1598() {
        assert!(is_same_table_name(DriverKind::Mysql, "Users", " users "));
        assert!(is_same_table_name(DriverKind::Sqlite, "Users", "users"));
        assert!(!is_same_table_name(DriverKind::Postgres, "Users", "users"));
        assert!(is_same_table_name(DriverKind::Postgres, "users", "users"));
    }
}
