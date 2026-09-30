//! `.sql` スクリプトファイルのストリーミング実行 (#973)。
//!
//! ダンプ生成 (`commands::dump`) の対になる「リストア」の一級導線。ファイルを
//! 64 KiB ずつ読み、[`ScriptSplitter`] で確定した文から順にドライバへ流すので、
//! GB 級のダンプでもメモリに載るのは「いま実行している 1 文」だけで済む。
//!
//! ストリーミング 3 点セット (`register_stream` / `forget_stream` の世代トークン /
//! `stream_id` フィルタ) は `import_csv` と同じ形。イベントは `sql-script:progress`
//! / `:done` / `:error` / `:cancelled`。キャンセルは `cancel_stream` による子タスクの
//! abort で、トランザクション内で中断された場合は [`TxGuard`] の `Drop` が
//! ROLLBACK を後始末する (abort は future を drop するだけで、ドライバが握る
//! 専用接続のトランザクションは自動では閉じないため)。
//!
//! ## 安全網
//!
//! * **読み取り専用ガードは文ごとにバックエンドで強制する** — 分割後の各文を
//!   `ensure_allowed_for_session` (エディタ実行と同じ `is_read_only_sql_for` +
//!   緊急モード) に通してから実行する。
//! * トランザクション制御文 (`BEGIN` / `COMMIT` / `ROLLBACK` …) は生 SQL として
//!   プールへ流さず、明示トランザクションのプリミティブに読み替える
//!   ([`classify_tx_control`])。プールの別々の接続で `BEGIN` と `COMMIT` を実行すると
//!   トランザクションを開いたままの接続がプールへ戻ってしまうため。
//!   `wrap_in_transaction` のときはランナー自身が外側のトランザクションを持つので、
//!   スクリプト内の制御文は読み飛ばす (件数は `skippedControl` で返す)。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncRead, AsyncReadExt};

use crate::commands::query::{ensure_allowed_for_session, record_write_history};
use crate::db::script::{
    classify_tx_control, parse_use_database, split_script, ScriptSplitter, ScriptStatement,
    TxControl,
};
use crate::db::types::{Column, QueryResult, ServerMessage, StreamBatch, Value};
use crate::db::Connection;
use crate::error::{AppError, Result};
use crate::state::{AppState, Session, StreamHandle, StreamKind};

const EV_SCRIPT_PROGRESS: &str = "sql-script:progress";
const EV_SCRIPT_DONE: &str = "sql-script:done";
const EV_SCRIPT_ERROR: &str = "sql-script:error";

/// ファイルを読むチャンクサイズ。
const READ_CHUNK_BYTES: usize = 64 * 1024;
/// 進捗イベントの最小間隔。1 文ごとに emit すると 10 万文のダンプで IPC が溢れる。
const PROGRESS_INTERVAL: Duration = Duration::from_millis(150);
/// 失敗一覧に載せる SQL の最大文字数 (巨大な INSERT をそのまま返さない)。
const FAILURE_SQL_PREVIEW_CHARS: usize = 200;
/// continue-on-error で返す失敗一覧の上限。超えた分は件数 (`failedCount`) だけ数える。
const MAX_REPORTED_FAILURES: usize = 1000;

/// 実行オプション。`continue_on_error` と `wrap_in_transaction` は排他 —
/// all-or-nothing のトランザクションで「失敗をスキップして続行」は意味を持たない
/// (PostgreSQL ではエラー後のトランザクションが abort 状態になり後続がすべて失敗する)。
#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptOptions {
    /// 失敗した文をスキップして続行し、最後に失敗一覧を返す。
    #[serde(default)]
    pub continue_on_error: bool,
    /// スクリプト全体を 1 トランザクションで包む (失敗・キャンセル時は ROLLBACK)。
    /// MySQL の DDL は暗黙コミットするため原子的にはならない (#640)。
    #[serde(default)]
    pub wrap_in_transaction: bool,
}

/// 失敗した 1 文。`index` はスクリプト内の文の通し番号 (1 始まり、制御文を含む)、`line` はファイル内の
/// 開始行 (1 始まり)。
#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
pub struct ScriptFailure {
    pub index: u64,
    pub line: u64,
    pub sql: String,
    pub error: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct ScriptProgressEvent {
    #[serde(rename = "streamId")]
    pub stream_id: String,
    /// 実行を試みた文の数 (成功 + 失敗)。
    pub executed: u64,
    pub failed: u64,
    #[serde(rename = "bytesRead")]
    pub bytes_read: u64,
    #[serde(rename = "totalBytes")]
    pub total_bytes: u64,
    #[serde(rename = "elapsedMs")]
    pub elapsed_ms: u64,
}

#[derive(Debug, Serialize, Clone)]
pub struct ScriptDoneEvent {
    #[serde(rename = "streamId")]
    pub stream_id: String,
    pub executed: u64,
    pub succeeded: u64,
    #[serde(rename = "failedCount")]
    pub failed_count: u64,
    /// continue-on-error で失敗した文 (最大 [`MAX_REPORTED_FAILURES`] 件)。
    pub failures: Vec<ScriptFailure>,
    /// wrap-in-transaction で読み飛ばしたスクリプト内のトランザクション制御文の数。
    #[serde(rename = "skippedControl")]
    pub skipped_control: u64,
    #[serde(rename = "rowsAffected")]
    pub rows_affected: u64,
    #[serde(rename = "elapsedMs")]
    pub elapsed_ms: u64,
}

#[derive(Debug, Serialize, Clone)]
pub struct ScriptErrorEvent {
    #[serde(rename = "streamId")]
    pub stream_id: String,
    pub error: String,
    /// 停止の原因になった文 (ファイル読み込み等の準備段階の失敗なら `null`)。
    pub failure: Option<ScriptFailure>,
    /// 停止までに実行を試みた文の数。
    pub executed: u64,
    /// 開いていたトランザクションを ROLLBACK したか (その範囲の文は取り消された)。
    #[serde(rename = "rolledBack")]
    pub rolled_back: bool,
}

/// 進捗のスナップショット (コア → emit 側)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScriptProgress {
    pub executed: u64,
    pub failed: u64,
    pub bytes_read: u64,
    pub total_bytes: u64,
    pub elapsed_ms: u64,
}

/// スクリプト実行の結果。準備段階の失敗 (ファイルが開けない等) は `Err(AppError)`。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScriptRun {
    Done {
        executed: u64,
        succeeded: u64,
        failed_count: u64,
        failures: Vec<ScriptFailure>,
        skipped_control: u64,
        rows_affected: u64,
        elapsed_ms: u64,
    },
    Failed {
        message: String,
        failure: Option<ScriptFailure>,
        executed: u64,
        rolled_back: bool,
    },
}

/// ランナーが開いた明示トランザクションの後始末係。`active` のまま drop された
/// (= `cancel_stream` の abort でタスクごと破棄された) ときは、専用接続に
/// トランザクションが開いたまま残らないよう、ランタイム上で ROLLBACK を発行する。
struct TxGuard {
    session: Arc<Session>,
    active: bool,
}

impl Drop for TxGuard {
    fn drop(&mut self) {
        if !self.active {
            return;
        }
        let session = self.session.clone();
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                if let Err(e) = session.conn.finish_transaction(false).await {
                    tracing::warn!(session_id = %session.id, error = %e, "script: rollback after cancel failed");
                } else {
                    tracing::info!(session_id = %session.id, "script: rolled back the open transaction after cancel");
                }
            });
        }
    }
}

fn preview_sql(sql: &str) -> String {
    let one_line = sql.split_whitespace().collect::<Vec<_>>().join(" ");
    if one_line.chars().count() > FAILURE_SQL_PREVIEW_CHARS {
        let head: String = one_line.chars().take(FAILURE_SQL_PREVIEW_CHARS).collect();
        format!("{head}…")
    } else {
        one_line
    }
}

/// スクリプト実行の本体。Tauri ランタイムに依存しない (統合テストから直接駆動する)。
///
/// `committed` には「確定済み (= キャンセルしても残る) 文の数」を随時書き込む。
/// `cancel_stream` がそれを `deliveredRows` として報告する。
pub(crate) async fn run_script_core<R, F>(
    session: Arc<Session>,
    reader: R,
    total_bytes: u64,
    database: Option<String>,
    options: ScriptOptions,
    committed: Arc<AtomicU64>,
    on_progress: F,
) -> Result<ScriptRun>
where
    R: AsyncRead + Unpin,
    F: FnMut(ScriptProgress),
{
    run_script_core_with(
        session,
        reader,
        total_bytes,
        database,
        options,
        committed,
        on_progress,
        None,
    )
    .await
}

/// [`run_script_core`] の本体。`batch` が `Some` のときは**エディタのバッチ実行**
/// (#1256) として動き、各文の結果 (結果セットのプレビュー / 影響行数 / エラー /
/// スキップ) を `on_result` へ 1 文ずつ渡す。分割・read-only ガード・トランザクション
/// 制御文の読み替え・キャッシュ無効化は `.sql` スクリプト実行と同じ経路を共有する。
#[allow(clippy::too_many_arguments)]
async fn run_script_core_with<R, F>(
    session: Arc<Session>,
    mut reader: R,
    total_bytes: u64,
    database: Option<String>,
    options: ScriptOptions,
    committed: Arc<AtomicU64>,
    mut on_progress: F,
    batch: Option<BatchConfig>,
) -> Result<ScriptRun>
where
    R: AsyncRead + Unpin,
    F: FnMut(ScriptProgress),
{
    validate_options(options)?;
    let driver = session.conn.driver_kind();
    let tx_active = session.conn.transaction_active().await;
    // スクリプトファイル実行は、ユーザの明示トランザクションと干渉しないよう拒否する。
    // エディタのバッチ実行は従来どおり明示トランザクションの上で動かす (各文を
    // `execute_in_transaction` へ流し、BEGIN/COMMIT の読み替えはしない)。
    if tx_active && batch.is_none() {
        return Err(AppError::InvalidInput(
            "an explicit transaction is already active on this session; commit or roll it back before running a script".into(),
        ));
    }

    let started = Instant::now();
    let mut runner = Runner {
        guard: TxGuard {
            session: session.clone(),
            active: false,
        },
        session: session.clone(),
        driver,
        database,
        options,
        committed,
        seen: 0,
        executed: 0,
        succeeded: 0,
        failed_count: 0,
        failures: Vec::new(),
        skipped_control: 0,
        rows_affected: 0,
        pending_in_tx: 0,
        wrote: false,
        schema_changed: false,
        batch: batch.map(|cfg| BatchState {
            preview_rows: cfg.preview_rows.max(1),
            external_tx: tx_active,
            skipping: false,
            on_result: cfg.on_result,
        }),
    };

    if options.wrap_in_transaction {
        session
            .conn
            .begin_transaction(runner.database.as_deref())
            .await?;
        runner.guard.active = true;
    }

    let mut splitter = ScriptSplitter::new(driver);
    let mut decoder = encoding_rs::UTF_8.new_decoder();
    let mut raw = vec![0u8; READ_CHUNK_BYTES];
    let mut bytes_read = 0u64;
    let mut last_emit = Instant::now();
    let progress = |runner: &Runner, bytes_read: u64| ScriptProgress {
        executed: runner.executed,
        failed: runner.failed_count,
        bytes_read,
        total_bytes,
        elapsed_ms: started.elapsed().as_millis() as u64,
    };
    on_progress(progress(&runner, 0));

    let mut eof = false;
    while !eof {
        let n = match reader.read(&mut raw).await {
            Ok(n) => n,
            Err(e) => {
                return Ok(runner
                    .abort_with(format!("failed to read script: {e}"), None)
                    .await)
            }
        };
        eof = n == 0;
        bytes_read += n as u64;
        let mut text = String::with_capacity(
            decoder
                .max_utf8_buffer_length(n)
                .unwrap_or(READ_CHUNK_BYTES * 3),
        );
        // UTF-8 として不正なバイトは置換文字へロッシーにデコードする
        // (`read_text_file` と同じ縮退)。先頭の BOM は decoder が取り除く。
        let _ = decoder.decode_to_string(&raw[..n], &mut text, eof);
        let statements: Vec<ScriptStatement> = if eof {
            let mut v = match splitter.push(&text) {
                Ok(v) => v,
                Err(e) => return Ok(runner.abort_with(too_large_message(&e), None).await),
            };
            let last = std::mem::replace(&mut splitter, ScriptSplitter::new(driver));
            v.extend(last.finish());
            v
        } else {
            match splitter.push(&text) {
                Ok(v) => v,
                Err(e) => return Ok(runner.abort_with(too_large_message(&e), None).await),
            }
        };
        for stmt in statements {
            if let Some(stop) = runner.run_statement(stmt).await {
                return Ok(stop);
            }
            if last_emit.elapsed() >= PROGRESS_INTERVAL {
                on_progress(progress(&runner, bytes_read));
                last_emit = Instant::now();
            }
        }
        on_progress(progress(&runner, bytes_read));
        last_emit = Instant::now();
    }

    // スクリプトが BEGIN したまま終わった場合も、ランナーが開いたトランザクションは
    // 確定させて閉じる (開いたまま専用接続を握り続けない)。
    if runner.guard.active {
        if let Err(e) = runner.commit().await {
            return Ok(runner.abort_with(format!("commit failed: {e}"), None).await);
        }
    }
    runner.invalidate_caches().await;
    Ok(ScriptRun::Done {
        executed: runner.executed,
        succeeded: runner.succeeded,
        failed_count: runner.failed_count,
        failures: std::mem::take(&mut runner.failures),
        skipped_control: runner.skipped_control,
        rows_affected: runner.rows_affected,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

fn too_large_message(e: &crate::db::script::StatementTooLarge) -> String {
    format!(
        "statement starting at line {} exceeds {} bytes (unterminated string or comment?)",
        e.line, e.limit
    )
}

pub(crate) fn validate_options(options: ScriptOptions) -> Result<()> {
    if options.continue_on_error && options.wrap_in_transaction {
        return Err(AppError::InvalidInput(
            "continueOnError and wrapInTransaction cannot be combined".into(),
        ));
    }
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// エディタのバッチ実行 (`run_sql_batch`, #1256)
// ─────────────────────────────────────────────────────────────────────────────
//
// 複数文スクリプトをエディタから実行する経路。以前はフロントが文分割 → 1 文ごとに
// `run_query` / `run_in_transaction` を直列 await → 全行受け取ってから 200 行に
// 切り詰める、という構成で、IPC 往復が文の数だけ・転送量が結果の全行ぶん発生して
// いた。ここでは `.sql` スクリプトランナー (`run_script_core_with`) を文字列の
// `Cursor` で再利用し、Rust 側で分割・実行・プレビュー行の切り詰め (SELECT は
// `preview_rows` 件に達した時点で取得を打ち切る) まで行って、結果を Channel で
// まとめて (150ms 間引きで) 返す。

/// バッチ結果 1 文ぶんの状態。
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum BatchStatus {
    Ok,
    Error,
    Skipped,
}

/// バッチ実行の 1 文ぶんの結果。フロントの `BatchStatementResult` (`sqlScript.ts`)
/// と同じ形 (camelCase)。`rows` は `preview_rows` 件までに切り詰め済み。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchStatementResult {
    pub sql: String,
    pub status: BatchStatus,
    /// 結果セットを返した SELECT 系のときだけ。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub columns: Option<Vec<Column>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rows: Option<Vec<Vec<Value>>>,
    /// 書き込み系の影響行数。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rows_affected: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub elapsed_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// サーバの通知・警告 (#1165)。出力ログ用で、空なら省略する。
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub server_messages: Vec<ServerMessage>,
}

impl BatchStatementResult {
    /// 成功した 1 文。`columns` が空でなければ結果セット、空なら影響行数の結果とみなす
    /// (フロントの従来判定 `res.columns.length > 0` と同じ)。
    fn ok(sql: String, r: &QueryResult) -> Self {
        let is_select = !r.columns.is_empty();
        Self {
            sql,
            status: BatchStatus::Ok,
            columns: is_select.then(|| r.columns.clone()),
            rows: is_select.then(|| r.rows.clone()),
            rows_affected: (!is_select).then_some(r.rows_affected),
            elapsed_ms: Some(r.elapsed_ms),
            error: None,
            server_messages: r.server_messages.clone(),
        }
    }

    fn error(sql: String, error: String) -> Self {
        Self {
            sql,
            status: BatchStatus::Error,
            columns: None,
            rows: None,
            rows_affected: None,
            elapsed_ms: None,
            error: Some(error),
            server_messages: Vec::new(),
        }
    }

    fn skipped(sql: String) -> Self {
        Self {
            sql,
            status: BatchStatus::Skipped,
            columns: None,
            rows: None,
            rows_affected: None,
            elapsed_ms: None,
            error: None,
            server_messages: Vec::new(),
        }
    }
}

/// バッチ実行の設定 (コア → ランナー)。
struct BatchConfig {
    /// SELECT の結果として保持する最大行数。これに達したら取得を打ち切る。
    preview_rows: usize,
    on_result: Box<dyn FnMut(BatchStatementResult) + Send + Sync>,
}

struct BatchState {
    preview_rows: usize,
    /// 開始時点で呼び出し側の明示トランザクションが有効だった。全文をその接続で
    /// 実行し、BEGIN/COMMIT の読み替えもしない。
    external_tx: bool,
    /// エラー停止後の残りの文をスキップとして返している最中。
    skipping: bool,
    on_result: Box<dyn FnMut(BatchStatementResult) + Send + Sync>,
}

/// プレビュー上限で取得を打ち切るための目印エラー (呼び出し元で成功に読み替える)。
const PREVIEW_CAP_MARKER: &str = "batch preview row cap reached";

/// `sql` を実行し、結果行を `limit` 件までで打ち切る。SELECT 系は `execute_stream` の
/// `on_batch` で `limit` 件に達した時点で取得を止める (残りの行は読まない)。書き込み系は
/// 通常どおり影響行数を返す。
async fn execute_preview(
    conn: &Connection,
    sql: &str,
    database: Option<&str>,
    limit: usize,
) -> Result<QueryResult> {
    let limit = limit.max(1);
    let started = Instant::now();
    let mut rows: Vec<Vec<Value>> = Vec::new();
    let mut columns: Vec<Column> = Vec::new();
    let mut capped = false;
    let res = conn
        .execute_stream(sql, database, limit, limit, |batch| match batch {
            StreamBatch::Columns(c) => {
                columns = c;
                Ok(())
            }
            StreamBatch::Rows(mut r) => {
                let room = limit.saturating_sub(rows.len());
                let reached = r.len() >= room;
                r.truncate(room);
                rows.append(&mut r);
                if reached {
                    capped = true;
                    Err(AppError::Other(PREVIEW_CAP_MARKER.into()))
                } else {
                    Ok(())
                }
            }
        })
        .await;
    match res {
        Ok(mut r) => {
            r.rows = rows;
            Ok(r)
        }
        Err(AppError::Other(m)) if capped && m == PREVIEW_CAP_MARKER => {
            let n = rows.len() as u64;
            Ok(QueryResult {
                columns,
                rows,
                rows_affected: n,
                elapsed_ms: started.elapsed().as_millis() as u64,
                server_messages: Vec::new(),
            })
        }
        Err(e) => Err(e),
    }
}

/// バッチ実行の本体 (Tauri ランタイム非依存。統合テストからも駆動する)。`sql` を
/// 文字列の `Cursor` として [`run_script_core_with`] へ流す。`stop_on_error` が
/// true なら最初のエラーで残りをスキップ、false なら続行する。
pub(crate) async fn run_batch_core<G>(
    session: Arc<Session>,
    sql: String,
    database: Option<String>,
    stop_on_error: bool,
    preview_rows: usize,
    committed: Arc<AtomicU64>,
    on_result: G,
) -> Result<ScriptRun>
where
    G: FnMut(BatchStatementResult) + Send + Sync + 'static,
{
    let bytes = sql.into_bytes();
    let total = bytes.len() as u64;
    run_script_core_with(
        session,
        std::io::Cursor::new(bytes),
        total,
        database,
        ScriptOptions {
            continue_on_error: !stop_on_error,
            wrap_in_transaction: false,
        },
        committed,
        |_| {},
        Some(BatchConfig {
            preview_rows,
            on_result: Box::new(on_result),
        }),
    )
    .await
}

struct Runner {
    guard: TxGuard,
    session: Arc<Session>,
    driver: crate::db::DriverKind,
    database: Option<String>,
    options: ScriptOptions,
    committed: Arc<AtomicU64>,
    /// スクリプト内で出会った文の通し番号 (トランザクション制御文を含む)。
    seen: u64,
    executed: u64,
    succeeded: u64,
    failed_count: u64,
    failures: Vec<ScriptFailure>,
    skipped_control: u64,
    rows_affected: u64,
    /// 開いているトランザクション内で成功した (未確定の) 文の数。
    pending_in_tx: u64,
    wrote: bool,
    schema_changed: bool,
    /// エディタのバッチ実行モード (#1256)。`None` なら `.sql` スクリプト実行。
    batch: Option<BatchState>,
}

impl Runner {
    /// 1 文を実行する。停止すべきとき (エラーで止めるモードの失敗など) は
    /// 最終結果を `Some` で返す。
    async fn run_statement(&mut self, stmt: ScriptStatement) -> Option<ScriptRun> {
        self.seen += 1;
        // バッチ実行で前の文がエラー停止したあとの残りは、実行せずスキップとして返す。
        if self.batch.as_ref().is_some_and(|b| b.skipping) {
            self.emit_batch(BatchStatementResult::skipped(stmt.sql));
            return None;
        }
        // バッチ実行が呼び出し側の明示トランザクションの上で動くときは、制御文も
        // 従来どおり生の SQL として同じ接続へ流す (読み替えると UI 側のトランザクション
        // 状態 (`txActive`) と食い違う)。
        let external_tx = self.batch.as_ref().is_some_and(|b| b.external_tx);
        let ctl = if external_tx {
            None
        } else {
            classify_tx_control(self.driver, &stmt.sql)
        };
        if let Some(ctl) = ctl {
            let ctl_started = Instant::now();
            if self.options.wrap_in_transaction {
                self.skipped_control += 1;
                return None;
            }
            let result = match ctl {
                TxControl::Begin => {
                    if self.guard.active {
                        Err(AppError::InvalidInput(
                            "nested BEGIN: a transaction is already open in this script".into(),
                        ))
                    } else {
                        let r = self
                            .session
                            .conn
                            .begin_transaction(self.database.as_deref())
                            .await;
                        if r.is_ok() {
                            self.guard.active = true;
                        }
                        r
                    }
                }
                TxControl::Commit => {
                    if self.guard.active {
                        self.commit().await
                    } else {
                        Ok(())
                    }
                }
                TxControl::Rollback => {
                    if self.guard.active {
                        self.guard.active = false;
                        self.pending_in_tx = 0;
                        self.session.conn.finish_transaction(false).await
                    } else {
                        Ok(())
                    }
                }
            };
            return match result {
                Ok(()) => {
                    if self.batch.is_some() {
                        let elapsed = ctl_started.elapsed().as_millis() as u64;
                        self.emit_batch(BatchStatementResult::ok(
                            stmt.sql.clone(),
                            &QueryResult::empty(0, elapsed),
                        ));
                    }
                    None
                }
                Err(e) => self.on_failure(&stmt, e).await,
            };
        }

        self.executed += 1;
        if let Err(e) = ensure_allowed_for_session(&self.session, &stmt.sql) {
            return self.on_failure(&stmt, e).await;
        }
        let result = if let Some(preview_rows) = self.batch.as_ref().map(|b| b.preview_rows) {
            if self.guard.active || external_tx {
                // トランザクション経路は結果を全件受け取ってから切り詰める。
                self.session
                    .conn
                    .execute_in_transaction(&stmt.sql)
                    .await
                    .map(|mut r| {
                        r.rows.truncate(preview_rows);
                        r
                    })
            } else {
                execute_preview(
                    &self.session.conn,
                    &stmt.sql,
                    self.database.as_deref(),
                    preview_rows,
                )
                .await
            }
        } else if self.guard.active {
            self.session.conn.execute_in_transaction(&stmt.sql).await
        } else {
            self.session
                .conn
                .execute(&stmt.sql, self.database.as_deref())
                .await
        };
        match result {
            Ok(r) => {
                self.succeeded += 1;
                self.rows_affected = self.rows_affected.saturating_add(r.rows_affected);
                if !crate::db::is_read_only_sql_for(self.driver, &stmt.sql) {
                    self.wrote = true;
                }
                if crate::db::sql_may_change_schema(self.driver, &stmt.sql) {
                    self.schema_changed = true;
                }
                if let Some(db) = parse_use_database(self.driver, &stmt.sql) {
                    self.database = Some(db);
                }
                if self.batch.is_some() {
                    self.emit_batch(BatchStatementResult::ok(stmt.sql.clone(), &r));
                }
                if self.guard.active {
                    self.pending_in_tx += 1;
                } else if !external_tx {
                    self.committed.fetch_add(1, Ordering::SeqCst);
                }
                None
            }
            Err(e) => self.on_failure(&stmt, e).await,
        }
    }

    /// バッチ実行の 1 文ぶんの結果を通知する (バッチモード以外では何もしない)。
    fn emit_batch(&mut self, result: BatchStatementResult) {
        if let Some(b) = self.batch.as_mut() {
            (b.on_result)(result);
        }
    }

    async fn commit(&mut self) -> Result<()> {
        self.guard.active = false;
        self.session.conn.finish_transaction(true).await?;
        self.committed
            .fetch_add(self.pending_in_tx, Ordering::SeqCst);
        self.pending_in_tx = 0;
        Ok(())
    }

    async fn on_failure(&mut self, stmt: &ScriptStatement, e: AppError) -> Option<ScriptRun> {
        self.failed_count += 1;
        if self.batch.is_some() {
            return self.on_batch_failure(stmt, e).await;
        }
        let failure = ScriptFailure {
            index: self.seen,
            line: stmt.line,
            sql: preview_sql(&stmt.sql),
            error: e.to_string(),
        };
        tracing::warn!(
            session_id = %self.session.id,
            line = stmt.line,
            error = %e,
            "script statement failed"
        );
        if self.options.continue_on_error {
            if self.failures.len() < MAX_REPORTED_FAILURES {
                self.failures.push(failure);
            }
            return None;
        }
        let message = format!("line {}: {}", stmt.line, e);
        Some(self.abort_with(message, Some(failure)).await)
    }

    /// バッチ実行の失敗。エラーを 1 文の結果として通知し、停止モードなら残りを
    /// スキップ扱いにする。ランナー自身が開いたトランザクションは、中途半端な状態を
    /// 残さないようここで ROLLBACK する (`.sql` スクリプト実行の `abort_with` と同じ)。
    /// 常に `None` を返す — 打ち切りは `skipping` で表し、コアは最後まで文を読み進める。
    async fn on_batch_failure(&mut self, stmt: &ScriptStatement, e: AppError) -> Option<ScriptRun> {
        tracing::warn!(
            session_id = %self.session.id,
            line = stmt.line,
            error = %e,
            "batch statement failed"
        );
        self.emit_batch(BatchStatementResult::error(stmt.sql.clone(), e.to_string()));
        if !self.options.continue_on_error {
            if let Some(b) = self.batch.as_mut() {
                b.skipping = true;
            }
            if self.guard.active {
                self.guard.active = false;
                self.pending_in_tx = 0;
                if let Err(err) = self.session.conn.finish_transaction(false).await {
                    tracing::warn!(session_id = %self.session.id, error = %err, "batch: rollback failed");
                }
            }
        }
        None
    }

    /// 実行を止める。開いているトランザクションがあれば ROLLBACK する。
    async fn abort_with(&mut self, message: String, failure: Option<ScriptFailure>) -> ScriptRun {
        let mut rolled_back = false;
        if self.guard.active {
            self.guard.active = false;
            self.pending_in_tx = 0;
            match self.session.conn.finish_transaction(false).await {
                Ok(()) => rolled_back = true,
                Err(e) => {
                    tracing::warn!(session_id = %self.session.id, error = %e, "script: rollback failed")
                }
            }
        }
        self.invalidate_caches().await;
        ScriptRun::Failed {
            message,
            failure,
            executed: self.executed,
            rolled_back,
        }
    }

    async fn invalidate_caches(&self) {
        // Query Result / Schema Cache (#1097): 書き込みや DDL が 1 文でも成功して
        // いたら接続単位で丸ごと invalidate する (ROLLBACK された場合も含めて
        // fail-closed — 余分な再取得 1 回は安全側のコスト)。
        if self.wrote {
            self.session.query_cache.invalidate_all().await;
        }
        if self.schema_changed {
            self.session.schema_cache.invalidate_all().await;
        }
    }
}

/// 対象ファイルのメタデータを確認する (空パス・ディレクトリ・特殊ファイルを拒否)。
pub(crate) async fn script_file_size(path: &str) -> Result<u64> {
    if path.trim().is_empty() {
        return Err(AppError::InvalidInput("script file path is empty".into()));
    }
    let meta = tokio::fs::metadata(path).await?;
    if !meta.is_file() {
        return Err(AppError::InvalidInput(format!(
            "not a regular file: {path}"
        )));
    }
    Ok(meta.len())
}

/// `.sql` スクリプトファイルを文単位でストリーミング実行する (#973)。進捗は
/// `sql-script:*` イベント (`stream_id` で絞る) で通知し、`cancel_stream` で中断できる。
#[tauri::command]
pub async fn run_sql_script(
    app: AppHandle,
    session_id: String,
    stream_id: String,
    database: Option<String>,
    path: String,
    options: ScriptOptions,
    state: State<'_, AppState>,
) -> Result<()> {
    let session = state
        .get(&session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;
    validate_options(options)?;
    let total_bytes = script_file_size(&path).await?;
    if session.conn.transaction_active().await {
        return Err(AppError::InvalidInput(
            "an explicit transaction is already active on this session; commit or roll it back before running a script".into(),
        ));
    }

    let committed = Arc::new(AtomicU64::new(0));
    // register_stream をタスク本体より前に完了させるゲート (import_csv と同じ理由。
    // #685)。oneshot は世代トークンを運び、タスクはそれで自分の登録だけを消す。
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel::<u64>();
    let stream_id_for_task = stream_id.clone();
    let committed_for_task = committed.clone();
    let handle = tokio::spawn(async move {
        let Ok(token) = ready_rx.await else {
            return;
        };
        spawn_script(
            app,
            session,
            stream_id_for_task,
            token,
            database,
            path,
            total_bytes,
            options,
            committed_for_task,
        )
        .await;
    });
    let token = state
        .register_stream(
            stream_id,
            StreamHandle {
                abort: handle.abort_handle(),
                // 確定済み (キャンセルしても残る) 文の数。
                delivered_rows: committed,
                kind: StreamKind::Script,
                on_cancel: None,
            },
        )
        .await;
    let _ = ready_tx.send(token);
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn spawn_script(
    app: AppHandle,
    session: Arc<Session>,
    stream_id: String,
    stream_token: u64,
    database: Option<String>,
    path: String,
    total_bytes: u64,
    options: ScriptOptions,
    committed: Arc<AtomicU64>,
) {
    let file_name = std::path::Path::new(&path)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.clone());
    let summary = format!("-- SQL script {file_name}");
    let history_db = database.clone();

    let result = match tokio::fs::File::open(&path).await {
        Ok(file) => {
            let emit_app = app.clone();
            let emit_id = stream_id.clone();
            run_script_core(
                session.clone(),
                file,
                total_bytes,
                database,
                options,
                committed,
                move |p| {
                    if let Err(e) = emit_app.emit(
                        EV_SCRIPT_PROGRESS,
                        ScriptProgressEvent {
                            stream_id: emit_id.clone(),
                            executed: p.executed,
                            failed: p.failed,
                            bytes_read: p.bytes_read,
                            total_bytes: p.total_bytes,
                            elapsed_ms: p.elapsed_ms,
                        },
                    ) {
                        tracing::warn!(stream_id = %emit_id, error = %e, "failed to emit script progress event");
                    }
                },
            )
            .await
        }
        Err(e) => Err(AppError::from(e)),
    };

    // スクリプト実行はバルク書き込みになりうるので、CSV インポートと同じく履歴へ
    // 1 行の要約を残す (skip_history は record_write_history 側で尊重)。
    match &result {
        Ok(ScriptRun::Done {
            executed,
            rows_affected,
            elapsed_ms,
            failed_count,
            ..
        }) => {
            record_write_history(
                &session,
                format!("{summary} ({executed} statements, {failed_count} failed)"),
                history_db.as_deref(),
                Some(*rows_affected as i64),
                Some(*elapsed_ms as i64),
                None,
            )
            .await
        }
        Ok(ScriptRun::Failed { message, .. }) => {
            record_write_history(
                &session,
                summary.clone(),
                history_db.as_deref(),
                None,
                None,
                Some(message.clone()),
            )
            .await
        }
        Err(e) => {
            record_write_history(
                &session,
                summary.clone(),
                history_db.as_deref(),
                None,
                None,
                Some(e.to_string()),
            )
            .await
        }
    }

    let emitted = match result {
        Ok(ScriptRun::Done {
            executed,
            succeeded,
            failed_count,
            failures,
            skipped_control,
            rows_affected,
            elapsed_ms,
        }) => {
            tracing::info!(stream_id = %stream_id, executed, failed_count, elapsed_ms, "sql script completed");
            app.emit(
                EV_SCRIPT_DONE,
                ScriptDoneEvent {
                    stream_id: stream_id.clone(),
                    executed,
                    succeeded,
                    failed_count,
                    failures,
                    skipped_control,
                    rows_affected,
                    elapsed_ms,
                },
            )
        }
        Ok(ScriptRun::Failed {
            message,
            failure,
            executed,
            rolled_back,
        }) => {
            tracing::error!(stream_id = %stream_id, error = %message, "sql script stopped");
            app.emit(
                EV_SCRIPT_ERROR,
                ScriptErrorEvent {
                    stream_id: stream_id.clone(),
                    error: message,
                    failure,
                    executed,
                    rolled_back,
                },
            )
        }
        Err(e) => {
            tracing::error!(stream_id = %stream_id, error = %e, "sql script failed (setup)");
            app.emit(
                EV_SCRIPT_ERROR,
                ScriptErrorEvent {
                    stream_id: stream_id.clone(),
                    error: e.to_string(),
                    failure: None,
                    executed: 0,
                    rolled_back: false,
                },
            )
        }
    };
    if let Err(e) = emitted {
        tracing::warn!(stream_id = %stream_id, error = %e, "failed to emit script terminal event");
    }

    if let Some(state) = app.try_state::<AppState>() {
        state.forget_stream(&stream_id, stream_token).await;
    }
}

/// `run_sql_batch` が Channel で送るメッセージ (#1256)。`kind` タグ付きで、フロントの
/// `listenBatchStream` (`src/api/tauri.ts`) と `schemas.ts` の `batch*Message` が対応する。
#[derive(Debug, Serialize, Clone)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum BatchStreamMessage {
    /// 実行を始める直前に 1 度だけ。`total` は分割後の文の数。
    Started { total: u64 },
    /// 終わった文の結果を 150ms ごとにまとめて届ける (1 文ごとに送らない)。
    Results { results: Vec<BatchStatementResult> },
    Done {
        ok: u64,
        errors: u64,
        skipped: u64,
        elapsed_ms: u64,
    },
    Error {
        error: String,
        connection_lost: bool,
    },
    /// `cancel_stream` がこのストリームを止めたとき。`delivered_statements` は
    /// 確定済み (キャンセルしても残る) 文の数。
    Cancelled { delivered_statements: u64 },
}

/// 結果の間引き送信 + 件数集計。`run_script_core_with` の `on_result` と、終了時の
/// 最終フラッシュ (コマンド側) の両方から触るので `Arc<Mutex<_>>` で共有する。
struct BatchEmitter {
    channel: Channel<BatchStreamMessage>,
    pending: Vec<BatchStatementResult>,
    last_flush: Instant,
    ok: u64,
    errors: u64,
    skipped: u64,
}

impl BatchEmitter {
    fn push(&mut self, r: BatchStatementResult) {
        match r.status {
            BatchStatus::Ok => self.ok += 1,
            BatchStatus::Error => self.errors += 1,
            BatchStatus::Skipped => self.skipped += 1,
        }
        self.pending.push(r);
        if self.last_flush.elapsed() >= PROGRESS_INTERVAL {
            self.flush();
        }
    }

    fn flush(&mut self) {
        self.last_flush = Instant::now();
        if self.pending.is_empty() {
            return;
        }
        let results = std::mem::take(&mut self.pending);
        if let Err(e) = self.channel.send(BatchStreamMessage::Results { results }) {
            tracing::warn!(error = %e, "failed to send batch results message");
        }
    }
}

/// `Mutex` の毒化は無視してロックを取る (中身は単純な集計値で、毒化しても整合する)。
fn lock_emitter(m: &std::sync::Mutex<BatchEmitter>) -> std::sync::MutexGuard<'_, BatchEmitter> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// エディタの複数文 SQL をまとめて実行する (#1256)。分割・読み取り専用ガード・実行・
/// SELECT のプレビュー行の切り詰めまでバックエンドで行い、結果は Channel へ 150ms
/// 間引きでまとめて送る。キャンセルは `cancel_stream`。
///
/// 明示トランザクション中は各文を同じ接続 (`execute_in_transaction`) で実行する。
/// 履歴には記録しない (従来の `run_query` 直列実行と同じ)。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn run_sql_batch(
    app: AppHandle,
    session_id: String,
    stream_id: String,
    database: Option<String>,
    sql: String,
    stop_on_error: bool,
    preview_rows: usize,
    on_event: Channel<BatchStreamMessage>,
    state: State<'_, AppState>,
) -> Result<()> {
    let session = state
        .get(&session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;
    let total = split_script(session.conn.driver_kind(), &sql).len() as u64;
    if let Err(e) = on_event.send(BatchStreamMessage::Started { total }) {
        tracing::warn!(stream_id = %stream_id, error = %e, "failed to send batch started message");
    }

    let committed = Arc::new(AtomicU64::new(0));
    let cancel_channel = on_event.clone();
    // register_stream をタスク本体より前に完了させるゲート (`run_query_stream` と同じ理由)。
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel::<u64>();
    let stream_id_for_task = stream_id.clone();
    let committed_for_task = committed.clone();
    let handle = tokio::spawn(async move {
        let Ok(token) = ready_rx.await else {
            return;
        };
        let emitter = Arc::new(std::sync::Mutex::new(BatchEmitter {
            channel: on_event.clone(),
            pending: Vec::new(),
            last_flush: Instant::now(),
            ok: 0,
            errors: 0,
            skipped: 0,
        }));
        let sink = emitter.clone();
        let outcome = run_batch_core(
            session,
            sql,
            database,
            stop_on_error,
            preview_rows,
            committed_for_task,
            move |r| lock_emitter(&sink).push(r),
        )
        .await;
        let (ok, errors, skipped) = {
            let mut g = lock_emitter(&emitter);
            g.flush();
            (g.ok, g.errors, g.skipped)
        };
        let msg = match outcome {
            Ok(ScriptRun::Done { elapsed_ms, .. }) => BatchStreamMessage::Done {
                ok,
                errors,
                skipped,
                elapsed_ms,
            },
            Ok(ScriptRun::Failed { message, .. }) => BatchStreamMessage::Error {
                error: message,
                connection_lost: false,
            },
            Err(e) => BatchStreamMessage::Error {
                connection_lost: e.is_connection_lost(),
                error: e.to_string(),
            },
        };
        if let Err(e) = on_event.send(msg) {
            tracing::warn!(stream_id = %stream_id_for_task, error = %e, "failed to send batch terminal message");
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
                delivered_rows: committed,
                kind: StreamKind::Script,
                on_cancel: Some(Box::new(move |delivered| {
                    let _ = cancel_channel.send(BatchStreamMessage::Cancelled {
                        delivered_statements: delivered,
                    });
                })),
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
    fn options_are_mutually_exclusive() {
        assert!(validate_options(ScriptOptions {
            continue_on_error: true,
            wrap_in_transaction: true
        })
        .is_err());
        assert!(validate_options(ScriptOptions {
            continue_on_error: true,
            wrap_in_transaction: false
        })
        .is_ok());
    }

    #[test]
    fn preview_truncates_long_sql() {
        let long = format!("INSERT INTO t VALUES {}", "(1),".repeat(200));
        let p = preview_sql(&long);
        assert!(p.chars().count() <= FAILURE_SQL_PREVIEW_CHARS + 1);
        assert!(p.ends_with('…'));
        assert_eq!(preview_sql("SELECT\n  1"), "SELECT 1");
    }

    #[tokio::test]
    async fn rejects_empty_path_and_directories() {
        assert!(matches!(
            script_file_size("  ").await,
            Err(AppError::InvalidInput(_))
        ));
        let dir = std::env::temp_dir();
        assert!(matches!(
            script_file_size(&dir.to_string_lossy()).await,
            Err(AppError::InvalidInput(_))
        ));
    }
}
