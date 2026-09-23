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
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncRead, AsyncReadExt};

use crate::commands::query::{ensure_allowed_for_session, record_write_history};
use crate::db::script::{
    classify_tx_control, parse_use_database, ScriptSplitter, ScriptStatement, TxControl,
};
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
    mut reader: R,
    total_bytes: u64,
    database: Option<String>,
    options: ScriptOptions,
    committed: Arc<AtomicU64>,
    mut on_progress: F,
) -> Result<ScriptRun>
where
    R: AsyncRead + Unpin,
    F: FnMut(ScriptProgress),
{
    validate_options(options)?;
    let driver = session.conn.driver_kind();
    if session.conn.transaction_active().await {
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
}

impl Runner {
    /// 1 文を実行する。停止すべきとき (エラーで止めるモードの失敗など) は
    /// 最終結果を `Some` で返す。
    async fn run_statement(&mut self, stmt: ScriptStatement) -> Option<ScriptRun> {
        self.seen += 1;
        if let Some(ctl) = classify_tx_control(self.driver, &stmt.sql) {
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
                Ok(()) => None,
                Err(e) => self.on_failure(&stmt, e).await,
            };
        }

        self.executed += 1;
        if let Err(e) = ensure_allowed_for_session(&self.session, &stmt.sql) {
            return self.on_failure(&stmt, e).await;
        }
        let result = if self.guard.active {
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
                if self.guard.active {
                    self.pending_in_tx += 1;
                } else {
                    self.committed.fetch_add(1, Ordering::SeqCst);
                }
                None
            }
            Err(e) => self.on_failure(&stmt, e).await,
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
