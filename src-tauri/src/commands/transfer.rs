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

use crate::commands::query::{ensure_allowed_for_session, record_write_history};
use crate::db::transfer::{
    binary_finalize_sql, create_table_sql, drop_table_sql, ensure_append_supported, plan_columns,
    plan_warnings, source_select_sql, validate_target_table, value_to_cell, TransferColumn,
    TransferMode,
};
use crate::db::types::{Column, StreamBatch};
use crate::db::{is_read_only_sql_for, DriverKind};
use crate::error::{AppError, Result};
use crate::state::{AppState, Session, StreamHandle, StreamKind};

/// 1 バッチ (= 1 回の `import_rows` 呼び出し) の既定行数。
const DEFAULT_TRANSFER_BATCH: usize = 1000;
/// 読み出し ⇔ 書き込み間に滞留させるバッチ数の上限 (背圧の効き具合)。
const CHANNEL_CAPACITY: usize = 2;

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
}

/// 転送の結果。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TransferOutcome {
    /// 書き込んだ行数。
    pub rows: u64,
    /// 転送先の列名 (重複除去後) と DDL 型。
    pub columns: Vec<TransferColumnInfo>,
    /// 損失のあるマッピングなどの注意書き。
    pub warnings: Vec<String>,
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
    let source = state
        .get(&request.source_session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(request.source_session_id.clone()))?;
    let target = state
        .get(&request.target_session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(request.target_session_id.clone()))?;
    ensure_transfer_target_writable(&target)?;
    validate_target_table(&request.target_table)?;

    let source_driver = source.conn.driver_kind();
    let source_sql = match (
        request.source_table.as_deref().map(str::trim),
        request.source_sql.as_deref().map(str::trim),
    ) {
        (Some(t), None) if !t.is_empty() => source_select_sql(source_driver, t),
        (None, Some(sql)) if !sql.is_empty() => {
            // エクスポートと同じく、ソースは読み取り専用文に限る (転送が
            // ソース側を書き換えることは決してない)。
            ensure_allowed_for_session(&source, sql)?;
            if !is_read_only_sql_for(source_driver, sql) {
                return Err(AppError::ReadOnly(
                    "transfer source must be a read-only statement (SELECT / WITH ...)".into(),
                ));
            }
            sql.to_string()
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
        && request.mode != TransferMode::Append
    {
        if let Some(t) = request.source_table.as_deref() {
            let same_db = request.source_database.as_deref().unwrap_or("")
                == request.target_database.as_deref().unwrap_or("");
            if same_db && t.trim().eq_ignore_ascii_case(request.target_table.trim()) {
                return Err(AppError::InvalidInput(
                    "source and target are the same table".into(),
                ));
            }
        }
    }

    Ok(PreparedTransfer {
        source,
        target,
        source_sql,
        request,
    })
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
struct CreatedTableGuard {
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
        handle.spawn(async move {
            // 中断された書き込み (DuckDB はブロッキングスレッド上で最後のバッチを
            // 走らせ切る) と競合して DROP が一時的に失敗しうるので、少し待って再試行する。
            for attempt in 0..10 {
                match target.conn.execute(&sql, database.as_deref()).await {
                    Ok(_) => return,
                    Err(e) if attempt == 9 => {
                        tracing::warn!(error = %e, "failed to drop cancelled transfer's table");
                    }
                    Err(_) => tokio::time::sleep(std::time::Duration::from_millis(200)).await,
                }
            }
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
) -> Result<Vec<TransferColumn>> {
    let driver = target.conn.driver_kind();
    let plan = plan_columns(columns, sample);
    if plan.is_empty() {
        return Err(AppError::InvalidInput(
            "transfer source returned no columns".into(),
        ));
    }
    let db = request.target_database.as_deref().filter(|d| !d.is_empty());
    let table = request.target_table.trim();
    match request.mode {
        TransferMode::Append => ensure_append_supported(driver, &plan)?,
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
                target: target.clone(),
                database: db.map(str::to_string),
                drop_sql: drop_table_sql(driver, table),
                armed: true,
            });
        }
    }
    Ok(plan)
}

/// バッチ 1 つ分をテキストセルへ変換して既存のインポート経路で書き込む。
async fn write_batch(
    target: &Session,
    request: &TransferRequest,
    driver: DriverKind,
    plan: &[TransferColumn],
    rows: &[Vec<crate::db::types::Value>],
    batch_size: usize,
) -> Result<u64> {
    if rows.is_empty() {
        return Ok(0);
    }
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
    target
        .conn
        .import_rows(
            db,
            request.target_table.trim(),
            &names,
            &cells,
            batch_size,
            // 転送は常に素の INSERT (衝突時の扱いは `TransferMode` 側で事前に決める)。
            &crate::db::upsert::ImportConflict::insert_only(),
            |_| Ok(()),
        )
        .await
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
        let mut written: u64 = 0;
        while let Some(batch) = rx.recv().await {
            match batch {
                StreamBatch::Columns(c) => columns = Some(c),
                StreamBatch::Rows(rows) => {
                    if plan.is_none() {
                        let cols = columns.as_deref().ok_or_else(|| {
                            AppError::Other("transfer source sent rows before columns".into())
                        })?;
                        plan =
                            Some(prepare_target(&target, request, cols, &rows, &mut guard).await?);
                    }
                    let p = plan.as_deref().unwrap_or(&[]);
                    written += write_batch(&target, request, driver, p, &rows, batch_size).await?;
                    counter.store(written, Ordering::SeqCst);
                    on_progress(written);
                }
            }
        }
        // チャネルが閉じた = 読み出しタスクが終わった (成功 or 失敗)。
        drop(rx);
        let read_result = match (&mut reader.0).await {
            Ok(r) => r,
            Err(e) => Err(AppError::Other(format!("transfer reader failed: {e}"))),
        };
        read_result?;
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
                prepare_target(&target, request, &cols, &[], &mut guard).await?
            }
        };
        if request.mode.creates_table() {
            let db = request.target_database.as_deref().filter(|d| !d.is_empty());
            for sql in binary_finalize_sql(driver, request.target_table.trim(), &plan) {
                target.conn.execute(&sql, db).await?;
            }
        }
        Ok::<_, AppError>((written, plan))
    };
    let result = body.await;

    match result {
        Ok((rows, plan)) => {
            if let Some(g) = guard.as_mut() {
                g.disarm();
            }
            let warnings = plan_warnings(driver, &plan);
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
    let prepared = prepare_transfer(&state, request).await?;
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
        let result = run_transfer(&prepared, counter_for_task.clone(), move |rows| {
            let _ = emit_app.emit(
                EV_TRANSFER_PROGRESS,
                TransferProgressEvent {
                    stream_id: emit_id.clone(),
                    rows,
                },
            );
        })
        .await;
        let elapsed_ms = started.elapsed().as_millis() as u64;
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
