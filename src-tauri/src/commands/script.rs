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
//!   ([`classify_tx_statement`])。プールの別々の接続で `BEGIN` と `COMMIT` を実行すると
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
    classify_tx_statement, parse_use_database, split_script, ScriptSplitter, ScriptStatement,
    TxControl,
};
use crate::db::script_analysis::{ScriptAnalysis, ScriptAnalyzer};
use crate::db::types::{Column, QueryResult, ServerMessage, StreamBatch, Value};
use crate::db::Connection;
use crate::error::{AppError, Result};
use crate::state::{AppState, Session, StreamHandle, StreamKind};
use crate::text_encoding::{self, EncodingDetector, TextEncoding};

const EV_SCRIPT_PROGRESS: &str = "sql-script:progress";
const EV_SCRIPT_DONE: &str = "sql-script:done";
const EV_SCRIPT_ERROR: &str = "sql-script:error";
/// 事前確認 (ドライラン) の完了イベント (#1535)。進捗は `sql-script:progress`、失敗は
/// `sql-script:error`、中断は `sql-script:cancelled` を実行本体と共有する。
const EV_SCRIPT_ANALYZED: &str = "sql-script:analyzed";

/// ファイルを読むチャンクサイズ。
const READ_CHUNK_BYTES: usize = 64 * 1024;
/// 進捗イベントの最小間隔。1 文ごとに emit すると 10 万文のダンプで IPC が溢れる。
const PROGRESS_INTERVAL: Duration = Duration::from_millis(150);
/// 失敗一覧に載せる SQL の最大文字数 (巨大な INSERT をそのまま返さない)。
const FAILURE_SQL_PREVIEW_CHARS: usize = 200;
/// continue-on-error で返す失敗一覧の上限。超えた分は件数 (`failedCount`) だけ数える。
const MAX_REPORTED_FAILURES: usize = 1000;
/// 「事前確認のあとでファイルが変わった」エラーの固定の目印 (メッセージの先頭)。フロントが
/// 文言ではなくこの目印で判定する (`src/scriptRun.ts` の `isAnalysisStaleError`)。
pub const FILE_CHANGED_MARKER: &str = "[script-file-changed]";
/// 個別除外できる文の数の上限 (リクエストが無制限に膨らまないように)。
const MAX_SKIP_STATEMENTS: usize = 100_000;

/// 実行オプション。`continue_on_error` と `wrap_in_transaction` は排他 —
/// all-or-nothing のトランザクションで「失敗をスキップして続行」は意味を持たない
/// (PostgreSQL ではエラー後のトランザクションが abort 状態になり後続がすべて失敗する)。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptOptions {
    /// 失敗した文をスキップして続行し、最後に失敗一覧を返す。
    #[serde(default)]
    pub continue_on_error: bool,
    /// スクリプト全体を 1 トランザクションで包む (失敗・キャンセル時は ROLLBACK)。
    /// MySQL の DDL は暗黙コミットするため原子的にはならない (#640)。
    #[serde(default)]
    pub wrap_in_transaction: bool,
    /// スクリプトファイルの文字コード (#1535)。`None` は自動判定 (BOM → UTF-8 →
    /// Shift_JIS / EUC-JP)。判定結果は [`open_script_file`] が返し、コアは
    /// `Some` になった値でデコードする。エディタのバッチ実行 (UTF-8 の文字列) では使わない。
    #[serde(default)]
    pub encoding: Option<TextEncoding>,
    /// この通し番号 (1 始まり、トランザクション制御文を含む。`ScriptFailure.index` と同じ)
    /// より前の文を実行せず読み飛ばす (#1535)。失敗した文からの再開に使う。0 / 1 は先頭から。
    /// 読み飛ばした文の `USE` による接続先 DB の切り替えだけは追従する。
    #[serde(default)]
    pub start_at_statement: u64,
    /// 実行せず読み飛ばす文の通し番号 (事前確認の一覧での個別除外、#1535)。
    #[serde(default)]
    pub skip_statements: Vec<u64>,
    /// 事前確認 (ドライラン) をしたときのファイルの大きさと更新時刻。指定されていて実行時の
    /// ファイルと違えば、除外・開始位置の文番号がずれるので実行前にエラーにする (#1535)。
    #[serde(default)]
    pub expected_file: Option<FileStamp>,
    /// スクリプトが BEGIN したまま COMMIT / ROLLBACK なしで終わったときの扱い (#1626)。
    /// 既定は取り消し。`wrap_in_transaction` の全体トランザクションには影響しない。
    #[serde(default)]
    pub unclosed_tx: UnclosedTxPolicy,
}

/// スクリプト終端の未閉じ BEGIN の扱い (#1626)。「実行を止めて確認」は事前確認の結果
/// (`unclosedTransaction`) を見たフロントが実行前に選ばせ、その結果をここへ渡す。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UnclosedTxPolicy {
    /// EOF で取り消す (既定。書き忘れが画面に出ないまま確定するのを防ぐ)。
    #[default]
    Rollback,
    /// EOF で確定する (ダンプの復元など、COMMIT を省く前提のスクリプト用)。
    Commit,
}

/// ファイルの大きさと更新時刻 (ミリ秒)。事前確認の後でファイルが書き換わっていないかの照合用。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStamp {
    pub size: u64,
    pub mtime_ms: u64,
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
    /// 事前確認で個別除外した文のうち、読み飛ばした数 (#1535)。
    #[serde(rename = "skippedExcluded")]
    pub skipped_excluded: u64,
    /// 開始位置 (`startAtStatement`) より前で読み飛ばした文の数 (#1535)。
    #[serde(rename = "skippedBeforeStart")]
    pub skipped_before_start: u64,
    /// スクリプトが BEGIN したまま COMMIT/ROLLBACK なしで終わり、ランナーが EOF で
    /// 取り消した (ROLLBACK) か。BEGIN 以降の変更が残っていないことを利用者へ伝える。
    #[serde(rename = "implicitRollback")]
    pub implicit_rollback: bool,
    /// 同じく BEGIN したまま終わったスクリプトを、利用者の選択 (`unclosedTx: "commit"`) で
    /// EOF に確定したか (#1626)。`implicitRollback` とは排他。
    #[serde(rename = "implicitCommit")]
    pub implicit_commit: bool,
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
    /// 失敗した時点でトランザクションが開いていたか (ROLLBACK の成否に関係なく true)。
    /// 開いていたなら、失敗した文だけから再開すると BEGIN 以降の文が欠けるので再開を出さない。
    #[serde(rename = "inTransaction")]
    pub in_transaction: bool,
    /// 開いていたトランザクションを始めた BEGIN 文の通し番号 (スクリプト内の BEGIN のとき。
    /// 全体を包む `wrapInTransaction` の場合は `null`)。ここから再開すれば取り消された範囲をやり直せる。
    #[serde(rename = "txBeginStatement")]
    pub tx_begin_statement: Option<u64>,
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
        skipped_excluded: u64,
        skipped_before_start: u64,
        implicit_rollback: bool,
        implicit_commit: bool,
        rows_affected: u64,
        elapsed_ms: u64,
    },
    Failed {
        message: String,
        failure: Option<ScriptFailure>,
        executed: u64,
        rolled_back: bool,
        in_transaction: bool,
        tx_begin_statement: Option<u64>,
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

/// チャンクが満たされる (または EOF) まで読む。`read` が短く返っても先頭 4 バイトの
/// BOM 判定などが崩れないようにする。
async fn fill_chunk(file: &mut tokio::fs::File, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut filled = 0;
    while filled < buf.len() {
        let n = file.read(&mut buf[filled..]).await?;
        if n == 0 {
            break;
        }
        filled += n;
    }
    Ok(filled)
}

/// スクリプトファイルを開く。**先にファイル全体を事前スキャン**し、文字コードの判定
/// (`requested` が `None` のとき、#1535) と、その文字コードとしてファイル全体が妥当かの
/// 確認を済ませる。不正なバイトがあれば 1 文も実行する前にエラーにする。チャンクごとの
/// 検査だけだと、後半に不正バイトがあるとき前半の文が実行済み (トランザクション無しなら
/// コミット済み) になる。返す文字コードは実行時のデコードにそのまま使う。
pub(crate) async fn open_script_file(
    path: &str,
    requested: Option<TextEncoding>,
) -> Result<(tokio::fs::File, TextEncoding)> {
    let mut scan = tokio::fs::File::open(path).await?;
    let mut detector = EncodingDetector::new(requested);
    let mut raw = vec![0u8; READ_CHUNK_BYTES];
    loop {
        let n = fill_chunk(&mut scan, &mut raw).await?;
        let eof = n < raw.len();
        detector.feed(&raw[..n], eof);
        if eof {
            break;
        }
    }
    let encoding = detector.finish().map_err(|e| e.into_app_error())?;
    Ok((tokio::fs::File::open(path).await?, encoding))
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
    validate_options(&options)?;
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
    // バッチ全体を 1 つのトランザクションで包む指定 (#1626) は、呼び出し側の明示トランザクションと
    // 二重になるので受け付けない。
    if tx_active && options.wrap_in_transaction {
        return Err(AppError::InvalidInput(
            "cannot wrap the batch in a transaction while an explicit transaction is active".into(),
        ));
    }

    let started = Instant::now();
    let encoding = options.encoding.unwrap_or(TextEncoding::Utf8);
    let skip_set: std::collections::HashSet<u64> =
        options.skip_statements.iter().copied().collect();
    let start_at = options.start_at_statement;
    let mut runner = Runner {
        guard: TxGuard {
            session: session.clone(),
            active: false,
        },
        session: session.clone(),
        driver,
        database,
        options,
        skip_set,
        start_at,
        skipped_excluded: 0,
        skipped_before_start: 0,
        committed,
        seen: 0,
        executed: 0,
        succeeded: 0,
        failed_count: 0,
        failures: Vec::new(),
        skipped_control: 0,
        rows_affected: 0,
        pending_in_tx: 0,
        tx_begin_index: None,
        tx_restart_unsafe: false,
        wrote: false,
        schema_changed: false,
        batch: batch.map(|cfg| BatchState {
            preview_rows: cfg.preview_rows.max(1),
            external_tx: tx_active,
            skipping: false,
            on_result: cfg.on_result,
            capture: cfg.capture,
        }),
        caches_invalidated: false,
    };

    if runner.options.wrap_in_transaction {
        session
            .conn
            .begin_transaction(runner.database.as_deref())
            .await?;
        runner.guard.active = true;
    }

    let mut splitter = ScriptSplitter::new(driver);
    let mut decoder = encoding.new_decoder();
    let mut raw = vec![0u8; READ_CHUNK_BYTES];
    let mut text = String::new();
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
        // 指定 / 判定した文字コードとして不正なバイトは**置換せずエラーにする**。
        // 別の文字コードの SQL を U+FFFD 混じりで実行すると、文字列リテラルが化けたまま
        // DB に書き込まれるため。先頭の BOM は decoder が取り除く。
        if !text_encoding::decode_chunk(&mut decoder, &raw[..n], eof, &mut text) {
            return Ok(runner
                .abort_with(not_decodable_message(encoding), None)
                .await);
        }
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

    // 開いたままのトランザクションは EOF で閉じる (開いたまま専用接続を握り続けない)。
    // ランナー自身が開いた (wrap_in_transaction) 場合は想定どおり確定する。スクリプトの
    // BEGIN が COMMIT / ROLLBACK なしで終わった場合は、書き忘れの可能性が高いので安全側に
    // 倒して取り消し (ROLLBACK)、利用者へ知らせる (#1601)。
    let mut implicit_rollback = false;
    let mut implicit_commit = false;
    if runner.guard.active {
        if runner.options.wrap_in_transaction {
            if let Err(e) = runner.commit().await {
                return Ok(runner.abort_with(format!("commit failed: {e}"), None).await);
            }
        } else if runner.options.unclosed_tx == UnclosedTxPolicy::Commit {
            // 利用者が確定を選んだ (#1626)。BEGIN 以降の文を確定済み件数へ数える。
            if let Err(e) = runner.commit().await {
                return Ok(runner.abort_with(format!("commit failed: {e}"), None).await);
            }
            implicit_commit = true;
        } else {
            if let Err(e) = runner.rollback_unclosed().await {
                return Ok(runner
                    .abort_with(
                        format!("rollback of the unclosed transaction failed: {e}"),
                        None,
                    )
                    .await);
            }
            implicit_rollback = true;
        }
    }
    runner.invalidate_caches().await;
    Ok(ScriptRun::Done {
        executed: runner.executed,
        succeeded: runner.succeeded,
        failed_count: runner.failed_count,
        failures: std::mem::take(&mut runner.failures),
        skipped_control: runner.skipped_control,
        skipped_excluded: runner.skipped_excluded,
        skipped_before_start: runner.skipped_before_start,
        implicit_rollback,
        implicit_commit,
        rows_affected: runner.rows_affected,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

fn not_decodable_message(encoding: TextEncoding) -> String {
    format!(
        "the script is not valid {}; pick the correct text encoding and try again",
        encoding.label()
    )
}

fn too_large_message(e: &crate::db::script::StatementTooLarge) -> String {
    format!(
        "statement starting at line {} exceeds {} bytes (unterminated string or comment?)",
        e.line, e.limit
    )
}

pub(crate) fn validate_options(options: &ScriptOptions) -> Result<()> {
    if options.continue_on_error && options.wrap_in_transaction {
        return Err(AppError::InvalidInput(
            "continueOnError and wrapInTransaction cannot be combined".into(),
        ));
    }
    if options.skip_statements.len() > MAX_SKIP_STATEMENTS {
        return Err(AppError::InvalidInput(format!(
            "too many excluded statements ({}, limit {MAX_SKIP_STATEMENTS})",
            options.skip_statements.len()
        )));
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
    /// `rows` がプレビュー上限で切り詰められている (結果にはまだ続きの行がある、#1534)。
    /// 切り詰めていなければ省略する。
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub truncated: bool,
    /// 結果セットの総行数。取得を途中で打ち切った場合は数えていないので省略する
    /// (`truncated` が true で `total_rows` が無ければ「先頭 N 行のみ・総数は不明」)。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_rows: Option<u64>,
}

/// SELECT の結果をプレビュー上限で切ったかどうか (#1534)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PreviewCut {
    truncated: bool,
    total_rows: Option<u64>,
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
            truncated: false,
            total_rows: None,
        }
    }

    /// SELECT のプレビュー切り詰め情報を載せる (#1534)。
    fn with_cut(mut self, cut: Option<PreviewCut>) -> Self {
        if let Some(cut) = cut {
            self.truncated = cut.truncated;
            self.total_rows = cut.total_rows;
        }
        self
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
            truncated: false,
            total_rows: None,
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
            truncated: false,
            total_rows: None,
        }
    }
}

/// バッチ実行の設定 (コア → ランナー)。
struct BatchConfig {
    /// SELECT の結果として保持する最大行数。これに達したら取得を打ち切る。
    preview_rows: usize,
    on_result: Box<dyn FnMut(BatchStatementResult) + Send + Sync>,
    /// 各 DML をフライトレコーダに記録する設定 (#1626)。`None` なら記録しない。
    capture: Option<BatchCaptureConfig>,
}

/// 1 回のバッチ実行で記録を試みる DML の上限 (#1626)。記録は 1 文ごとに専用トランザクションで
/// 対象行を読み直すため、数千文のスクリプト (mysqldump など) では実行時間とストアの両方が
/// 膨らむ。辞退された文も数えて、上限を超えた文は記録を試みずに実行する
/// (件数は `BatchCaptureStats::skipped` に数える)。
pub(crate) const BATCH_CAPTURE_LIMIT: u64 = 200;

/// バッチ実行の記録結果の集計 (#1626)。実行タスクと完了通知の両方から読むので共有する。
#[derive(Debug, Default)]
pub(crate) struct BatchCaptureStats {
    /// 記録できた文の数。
    pub captured: AtomicU64,
    /// 記録を辞退した (捕捉不可・上限超過・履歴を残さない接続) DML の数。
    pub skipped: AtomicU64,
}

/// バッチ実行の DML 記録の設定 (#1626)。同じ `batch_id` の記録はまとめて取り消せる。
#[derive(Clone)]
pub(crate) struct BatchCaptureConfig {
    pub row_cap: usize,
    pub retention_days: Option<i64>,
    pub batch_id: String,
    pub stats: Arc<BatchCaptureStats>,
}

struct BatchState {
    preview_rows: usize,
    /// 開始時点で呼び出し側の明示トランザクションが有効だった。全文をその接続で
    /// 実行し、BEGIN/COMMIT の読み替えもしない。
    external_tx: bool,
    /// エラー停止後の残りの文をスキップとして返している最中。
    skipping: bool,
    on_result: Box<dyn FnMut(BatchStatementResult) + Send + Sync>,
    capture: Option<BatchCaptureConfig>,
}

/// プレビュー上限で取得を打ち切るための目印エラー (呼び出し元で成功に読み替える)。
const PREVIEW_CAP_MARKER: &str = "batch preview row cap reached";

/// `sql` を実行し、結果行を `limit` 件までで打ち切る。SELECT 系は `execute_stream` の
/// `on_batch` で `limit` 件を超える行が見えた時点で取得を止める (残りの行は読まない)。
/// 書き込み系は通常どおり影響行数を返す (切り詰め情報は `None`)。
///
/// 切り詰めの有無を正しく言えるよう、1 バッチを `limit + 1` 件にして「`limit` 件を超える行が
/// ある」ことを確かめる。打ち切った場合は総行数を数えていないので `total_rows` は `None`。
async fn execute_preview(
    conn: &Connection,
    sql: &str,
    database: Option<&str>,
    limit: usize,
) -> Result<(QueryResult, Option<PreviewCut>)> {
    let limit = limit.max(1);
    let started = Instant::now();
    let mut rows: Vec<Vec<Value>> = Vec::new();
    let mut columns: Vec<Column> = Vec::new();
    let mut capped = false;
    let res = conn
        .execute_stream(
            sql,
            database,
            limit.saturating_add(1),
            limit.saturating_add(1),
            |batch| match batch {
                StreamBatch::Columns(c) => {
                    columns = c;
                    Ok(())
                }
                StreamBatch::Rows(mut r) => {
                    let room = limit.saturating_sub(rows.len());
                    let more = r.len() > room;
                    r.truncate(room);
                    rows.append(&mut r);
                    if more {
                        capped = true;
                        Err(AppError::Other(PREVIEW_CAP_MARKER.into()))
                    } else {
                        Ok(())
                    }
                }
            },
        )
        .await;
    match res {
        Ok(mut r) => {
            let is_query = !r.columns.is_empty() || !rows.is_empty();
            r.rows = rows;
            let cut = is_query.then_some(PreviewCut {
                truncated: false,
                total_rows: Some(r.rows.len() as u64),
            });
            Ok((r, cut))
        }
        Err(AppError::Other(m)) if capped && m == PREVIEW_CAP_MARKER => {
            let n = rows.len() as u64;
            Ok((
                QueryResult {
                    columns,
                    rows,
                    rows_affected: n,
                    elapsed_ms: started.elapsed().as_millis() as u64,
                    server_messages: Vec::new(),
                },
                Some(PreviewCut {
                    truncated: true,
                    total_rows: None,
                }),
            ))
        }
        Err(e) => Err(e),
    }
}

/// バッチ実行の本体 (Tauri ランタイム非依存。統合テストからも駆動する)。`sql` を
/// 文字列の `Cursor` として [`run_script_core_with`] へ流す。`stop_on_error` が
/// true なら最初のエラーで残りをスキップ、false なら続行する。
#[allow(clippy::too_many_arguments)]
pub(crate) async fn run_batch_core<G>(
    session: Arc<Session>,
    sql: String,
    database: Option<String>,
    stop_on_error: bool,
    preview_rows: usize,
    wrap_in_transaction: bool,
    capture: Option<BatchCaptureConfig>,
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
            wrap_in_transaction,
            ..ScriptOptions::default()
        },
        committed,
        |_| {},
        Some(BatchConfig {
            preview_rows,
            on_result: Box::new(on_result),
            capture,
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
    /// 個別除外する文の通し番号 (`options.skip_statements`)。
    skip_set: std::collections::HashSet<u64>,
    /// 開始位置 (`options.start_at_statement`)。
    start_at: u64,
    skipped_excluded: u64,
    skipped_before_start: u64,
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
    /// スクリプト内の BEGIN で開いたトランザクションの BEGIN 文の通し番号。COMMIT / ROLLBACK が
    /// 成功するまで残す (ROLLBACK が失敗しても「開いていた」ことを失敗報告に載せるため)。
    tx_begin_index: Option<u64>,
    /// 今のトランザクションを BEGIN からやり直すと二重適用になりうるか。失敗した文が COMMIT のとき
    /// (確定したか不明) と、MySQL でトランザクション内に暗黙 COMMIT する DDL が実行済みのとき。
    /// true なら失敗報告に BEGIN の番号を載せない (`in_transaction` は true のまま)。
    tx_restart_unsafe: bool,
    wrote: bool,
    schema_changed: bool,
    /// エディタのバッチ実行モード (#1256)。`None` なら `.sql` スクリプト実行。
    batch: Option<BatchState>,
    /// `invalidate_caches` を実行済みか (Drop での二重無効化を避ける)。
    caches_invalidated: bool,
}

/// `cancel_stream` がタスクを abort すると `run_script_core_with` の末尾に到達せず
/// キャッシュ無効化が走らない。確定済みの書き込み / DDL が DB に残るので、Drop 時に
/// まだ無効化していなければランタイム上で無効化する。
impl Drop for Runner {
    fn drop(&mut self) {
        if self.caches_invalidated || !(self.wrote || self.schema_changed) {
            return;
        }
        let session = self.session.clone();
        let (wrote, schema_changed) = (self.wrote, self.schema_changed);
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                if wrote {
                    session.query_cache.invalidate_all().await;
                }
                if schema_changed {
                    session.schema_cache.invalidate_all().await;
                }
            });
        }
    }
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
        // 失敗した文からの再開 (#1535): 開始位置より前の文は実行しない。ただし `USE` による
        // 接続先 DB の切り替えには追従する (以降の文が正しい DB に流れるように)。
        if self.start_at > 1 && self.seen < self.start_at {
            self.skipped_before_start += 1;
            if let Some(db) = parse_use_database(self.driver, &stmt.sql) {
                self.database = Some(db);
            }
            return None;
        }
        // バッチ実行が呼び出し側の明示トランザクションの上で動くときは、制御文も
        // 従来どおり生の SQL として同じ接続へ流す (読み替えると UI 側のトランザクション
        // 状態 (`txActive`) と食い違う)。
        let external_tx = self.batch.as_ref().is_some_and(|b| b.external_tx);
        let ctl = if external_tx {
            None
        } else {
            classify_tx_statement(self.driver, &stmt.sql)
        };
        // 事前確認の一覧で個別除外された文は実行しない (#1535)。ただしトランザクション制御文
        // (BEGIN / COMMIT / ROLLBACK) は除外できない — 片方だけ外すと取り消されるはずの範囲が
        // 確定したり、COMMIT が抜けたままになるので、番号が指定されていても無視して実行する。
        if ctl.is_none() && !self.skip_set.is_empty() && self.skip_set.contains(&self.seen) {
            self.skipped_excluded += 1;
            return None;
        }
        if let Some((ctl, tx_opts)) = ctl {
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
                    } else if let Err(msg) = &tx_opts {
                        Err(AppError::InvalidInput(msg.clone()))
                    } else {
                        let r = self
                            .session
                            .conn
                            .begin_transaction_with(
                                self.database.as_deref(),
                                tx_opts.unwrap_or_default(),
                            )
                            .await;
                        if r.is_ok() {
                            self.guard.active = true;
                            self.tx_begin_index = Some(self.seen);
                            self.tx_restart_unsafe = false;
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
                        let r = self.session.conn.finish_transaction(false).await;
                        if r.is_ok() {
                            self.tx_begin_index = None;
                        }
                        r
                    } else {
                        Ok(())
                    }
                }
            };
            if result.is_err() {
                if ctl == TxControl::Commit {
                    // COMMIT が失敗: 確定したかどうか分からないので BEGIN からのやり直しは勧めない。
                    self.tx_restart_unsafe = true;
                }
                if self.options.continue_on_error
                    && matches!(ctl, TxControl::Commit | TxControl::Rollback)
                    && !self.guard.active
                {
                    // 続行モードでは失敗した COMMIT / ROLLBACK のあとも実行が続く。トランザクションは
                    // もう閉じた扱いなので、後続の失敗を「トランザクション中」と報告しないよう忘れる。
                    self.tx_begin_index = None;
                }
            }
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
        let result: Result<(QueryResult, Option<PreviewCut>)> =
            if let Some(preview_rows) = self.batch.as_ref().map(|b| b.preview_rows) {
                if self.guard.active || external_tx {
                    // トランザクション経路は結果を全件受け取ってから切り詰める (総行数が分かる)。
                    self.session
                        .conn
                        .execute_in_transaction(&stmt.sql)
                        .await
                        .map(|mut r| {
                            let total = r.rows.len();
                            let is_query = !r.columns.is_empty();
                            r.rows.truncate(preview_rows);
                            let cut = is_query.then_some(PreviewCut {
                                truncated: total > preview_rows,
                                total_rows: Some(total as u64),
                            });
                            (r, cut)
                        })
                } else if let Some(cap) = self.batch_capture_for(&stmt.sql) {
                    self.run_captured_statement(&stmt.sql, &cap).await
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
                self.session
                    .conn
                    .execute_in_transaction(&stmt.sql)
                    .await
                    .map(|r| (r, None))
            } else {
                self.session
                    .conn
                    .execute(&stmt.sql, self.database.as_deref())
                    .await
                    .map(|r| (r, None))
            };
        match result {
            Ok((r, cut)) => {
                self.succeeded += 1;
                self.rows_affected = self.rows_affected.saturating_add(r.rows_affected);
                // mysqldump の大半を占める INSERT は、全文のマスク走査を省いて書き込み・
                // 非 DDL と決める (解析側 `script_analysis` と同じ早期判定)。
                let is_insert = crate::db::script_analysis::starts_with_word(&stmt.sql, "insert");
                if is_insert || !crate::db::is_read_only_sql_for(self.driver, &stmt.sql) {
                    self.wrote = true;
                }
                let may_change_schema =
                    !is_insert && crate::db::sql_may_change_schema(self.driver, &stmt.sql);
                if may_change_schema {
                    self.schema_changed = true;
                }
                if let Some(db) = parse_use_database(self.driver, &stmt.sql) {
                    self.database = Some(db);
                }
                if self.batch.is_some() {
                    self.emit_batch(BatchStatementResult::ok(stmt.sql.clone(), &r).with_cut(cut));
                }
                if self.guard.active {
                    if self.driver == crate::db::DriverKind::Mysql && may_change_schema {
                        // MySQL の DDL は暗黙 COMMIT する: ここまでのトランザクションは確定済み。
                        self.tx_restart_unsafe = true;
                    }
                    self.pending_in_tx += 1;
                } else if !external_tx {
                    self.committed.fetch_add(1, Ordering::SeqCst);
                }
                None
            }
            Err(e) => self.on_failure(&stmt, e).await,
        }
    }

    /// この文を記録つきで実行すべきなら、その設定を返す (#1626)。バッチ実行で記録が
    /// 有効、かつ単独の INSERT / UPDATE / DELETE のときだけ。トランザクションの内側
    /// (呼び出し側の明示トランザクション・全体を包む指定) は記録用の専用トランザクションを
    /// 開けないので対象外 (記録せずに実行する)。
    fn batch_capture_for(&self, sql: &str) -> Option<BatchCaptureConfig> {
        let cap = self.batch.as_ref()?.capture.clone()?;
        if self.guard.active
            || crate::db::classify_write_kind_for(self.driver, sql) == crate::db::WriteKind::Other
        {
            return None;
        }
        Some(cap)
    }

    /// 1 文を記録つきで実行して、プレビュー用の結果に整える (#1626)。記録の成否に
    /// 関わらず書き込み自体は行われる。上限 ([`BATCH_CAPTURE_LIMIT`]) を超えた文は記録しない。
    async fn run_captured_statement(
        &self,
        sql: &str,
        cap: &BatchCaptureConfig,
    ) -> Result<(QueryResult, Option<PreviewCut>)> {
        use std::sync::atomic::Ordering::SeqCst;
        if cap.stats.captured.load(SeqCst) + cap.stats.skipped.load(SeqCst) >= BATCH_CAPTURE_LIMIT {
            cap.stats.skipped.fetch_add(1, SeqCst);
            return self
                .session
                .conn
                .execute(sql, self.database.as_deref())
                .await
                .map(|r| (r, None));
        }
        let (result, capture) = super::query::run_captured_write(
            self.session.clone(),
            sql.to_string(),
            self.database.clone(),
            cap.row_cap,
            None,
        )
        .await?;
        let id = crate::flight_recorder::persist_capture(
            self.session.skip_history,
            self.session.profile_id.clone(),
            self.driver,
            self.database.clone(),
            sql.to_string(),
            &capture,
            cap.retention_days,
            Some(cap.batch_id.clone()),
        )
        .await;
        if id.is_some() {
            cap.stats.captured.fetch_add(1, SeqCst);
        } else {
            cap.stats.skipped.fetch_add(1, SeqCst);
        }
        Ok((result, None))
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
        self.tx_begin_index = None;
        self.committed
            .fetch_add(self.pending_in_tx, Ordering::SeqCst);
        self.pending_in_tx = 0;
        Ok(())
    }

    /// スクリプトの BEGIN が閉じられないまま EOF に達したときに取り消す。取り消した文は
    /// 確定済みの件数 (`committed`) に数えない。
    async fn rollback_unclosed(&mut self) -> Result<()> {
        self.guard.active = false;
        self.pending_in_tx = 0;
        self.tx_begin_index = None;
        self.session.conn.finish_transaction(false).await
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
        let in_transaction = self.guard.active || self.tx_begin_index.is_some();
        let tx_begin_statement = if self.tx_restart_unsafe {
            None
        } else {
            self.tx_begin_index
        };
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
            in_transaction,
            tx_begin_statement,
        }
    }

    async fn invalidate_caches(&mut self) {
        self.caches_invalidated = true;
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

/// `cancel_stream` による abort でも履歴へ 1 行残すためのガード。`disarm` されずに
/// drop された (= タスクが途中で破棄された) ときだけ、ランタイム上で中断の記録を書く。
struct CancelHistoryGuard {
    session: Arc<Session>,
    summary: String,
    database: Option<String>,
    committed: Arc<AtomicU64>,
    armed: bool,
}

impl Drop for CancelHistoryGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let session = self.session.clone();
        let summary = std::mem::take(&mut self.summary);
        let database = self.database.take();
        let committed = self.committed.load(Ordering::SeqCst);
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                record_write_history(
                    &session,
                    summary,
                    database.as_deref(),
                    None,
                    None,
                    Some(format!("cancelled ({committed} statements committed)")),
                )
                .await;
            });
        }
    }
}

/// 対象ファイルのメタデータを確認する (空パス・ディレクトリ・特殊ファイルを拒否)。
/// [`script_file_size`] に更新時刻を添えたもの (事前確認との照合用)。
pub(crate) async fn script_file_stamp(path: &str) -> Result<FileStamp> {
    if path.trim().is_empty() {
        return Err(AppError::InvalidInput("script file path is empty".into()));
    }
    let meta = tokio::fs::metadata(path).await?;
    if !meta.is_file() {
        return Err(AppError::InvalidInput(format!(
            "not a regular file: {path}"
        )));
    }
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as u64);
    Ok(FileStamp {
        size: meta.len(),
        mtime_ms,
    })
}

/// 事前確認のときのファイルと今のファイルが同じか確かめる。違えば文番号 (除外・開始位置) が
/// ずれるので、実行前にエラーにして再確認を促す (#1535)。
pub(crate) fn check_expected_file(expected: Option<FileStamp>, actual: FileStamp) -> Result<()> {
    match expected {
        Some(e) if e != actual => Err(AppError::InvalidInput(
            format!(
                "{FILE_CHANGED_MARKER} the script file changed after the dry run, so statement numbers may no longer match; run the dry run again"
            ),
        )),
        _ => Ok(()),
    }
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
    validate_options(&options)?;
    let stamp = script_file_stamp(&path).await?;
    check_expected_file(options.expected_file, stamp)?;
    let total_bytes = stamp.size;
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
    let mut cancel_guard = CancelHistoryGuard {
        session: session.clone(),
        summary: summary.clone(),
        database: history_db.clone(),
        committed: committed.clone(),
        armed: true,
    };

    let result = match open_script_file(&path, options.encoding).await {
        Ok((file, encoding)) => {
            // 判定した文字コードをコアへ渡す (コアは `Some` の値でデコードする)。
            let options = ScriptOptions {
                encoding: Some(encoding),
                ..options
            };
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
        Err(e) => Err(e),
    };

    cancel_guard.armed = false;
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
            skipped_excluded,
            skipped_before_start,
            implicit_rollback,
            implicit_commit,
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
                    skipped_excluded,
                    skipped_before_start,
                    implicit_rollback,
                    implicit_commit,
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
            in_transaction,
            tx_begin_statement,
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
                    in_transaction,
                    tx_begin_statement,
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
                    in_transaction: false,
                    tx_begin_statement: None,
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

// ─────────────────────────────────────────────────────────────────────────────
// 事前確認 / ドライラン (`analyze_sql_script`, #1535)
// ─────────────────────────────────────────────────────────────────────────────
//
// 実行前に「何が流れるか」を見せるための読み取り専用の走査。ファイルは実行時と同じく
// 64 KiB ずつ読んで [`ScriptSplitter`] で 1 文ずつ確定させ、[`ScriptAnalyzer`] が
// 件数・先頭の一覧・危険文・トランザクション制御文の位置だけを保持するので、GB 級でも
// メモリに載るのは「いま見ている 1 文」と有限個の集計だけ。DB には一切触れない。

/// 事前確認の完了イベント (`sql-script:analyzed`)。
#[derive(Debug, Serialize, Clone)]
pub struct ScriptAnalyzedEvent {
    #[serde(rename = "streamId")]
    pub stream_id: String,
    /// 実際に使った文字コード (自動判定の結果、または指定どおり)。
    pub encoding: TextEncoding,
    #[serde(rename = "totalBytes")]
    pub total_bytes: u64,
    /// 事前確認したときのファイルの大きさ・更新時刻。実行時に `expectedFile` として渡すと、
    /// 事前確認の後でファイルが変わっていれば実行前にエラーになる。
    #[serde(rename = "fileStamp")]
    pub file_stamp: FileStamp,
    #[serde(rename = "elapsedMs")]
    pub elapsed_ms: u64,
    pub analysis: ScriptAnalysis,
}

/// 事前確認の本体 (Tauri ランタイム非依存)。`reader` を `encoding` でデコードし、文ごとに
/// 解析する。`enforce_read_only` は「実行すると非読み取り専用の文が拒否される」セッションか。
pub(crate) async fn analyze_script_core<R, F>(
    driver: crate::db::DriverKind,
    enforce_read_only: bool,
    mut reader: R,
    total_bytes: u64,
    encoding: TextEncoding,
    mut on_progress: F,
) -> Result<ScriptAnalysis>
where
    R: AsyncRead + Unpin,
    F: FnMut(ScriptProgress),
{
    let started = Instant::now();
    let mut analyzer = ScriptAnalyzer::new(driver, enforce_read_only);
    let mut splitter = ScriptSplitter::new(driver);
    let mut decoder = encoding.new_decoder();
    let mut raw = vec![0u8; READ_CHUNK_BYTES];
    let mut text = String::new();
    let mut bytes_read = 0u64;
    let mut last_emit = Instant::now();
    let snapshot = |a: &ScriptAnalyzer, bytes_read: u64| ScriptProgress {
        executed: a.seen(),
        failed: a.dangerous_so_far(),
        bytes_read,
        total_bytes,
        elapsed_ms: started.elapsed().as_millis() as u64,
    };
    on_progress(snapshot(&analyzer, 0));

    let mut eof = false;
    while !eof {
        let n = reader.read(&mut raw).await.map_err(AppError::from)?;
        eof = n == 0;
        bytes_read += n as u64;
        if !text_encoding::decode_chunk(&mut decoder, &raw[..n], eof, &mut text) {
            return Err(AppError::InvalidInput(not_decodable_message(encoding)));
        }
        let mut statements = splitter
            .push(&text)
            .map_err(|e| AppError::InvalidInput(too_large_message(&e)))?;
        if eof {
            let last = std::mem::replace(&mut splitter, ScriptSplitter::new(driver));
            statements.extend(last.finish());
        }
        for stmt in &statements {
            analyzer.push(stmt);
        }
        if last_emit.elapsed() >= PROGRESS_INTERVAL || eof {
            on_progress(snapshot(&analyzer, bytes_read));
            last_emit = Instant::now();
        }
        // 長い走査の途中でもキャンセル (abort) が効くよう、チャンクごとに譲る。
        tokio::task::yield_now().await;
    }
    Ok(analyzer.finish())
}

/// `.sql` スクリプトを**実行せずに**走査し、文数・種別・危険文・トランザクション制御文の
/// 位置・先頭の文の一覧を返す事前確認 (#1535)。進捗は `sql-script:progress`
/// (`executed` = 走査済みの文数、`failed` = 見つけた危険文の数)、結果は
/// `sql-script:analyzed`、失敗は `sql-script:error`、中断は `cancel_stream` による
/// `sql-script:cancelled`。判定は実行時と同じ読み取り専用ガード / 危険文検出を文ごとに通す。
#[tauri::command]
pub async fn analyze_sql_script(
    app: AppHandle,
    session_id: String,
    stream_id: String,
    path: String,
    encoding: Option<TextEncoding>,
    state: State<'_, AppState>,
) -> Result<()> {
    let session = state
        .get(&session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;
    let stamp = script_file_stamp(&path).await?;
    let total_bytes = stamp.size;
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel::<u64>();
    let stream_id_for_task = stream_id.clone();
    let committed = Arc::new(AtomicU64::new(0));
    let handle = tokio::spawn(async move {
        let Ok(token) = ready_rx.await else {
            return;
        };
        spawn_analysis(
            app,
            session,
            stream_id_for_task,
            token,
            path,
            total_bytes,
            stamp,
            encoding,
        )
        .await;
    });
    let token = state
        .register_stream(
            stream_id,
            StreamHandle {
                abort: handle.abort_handle(),
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
async fn spawn_analysis(
    app: AppHandle,
    session: Arc<Session>,
    stream_id: String,
    stream_token: u64,
    path: String,
    total_bytes: u64,
    stamp: FileStamp,
    requested: Option<TextEncoding>,
) {
    let started = Instant::now();
    let driver = session.conn.driver_kind();
    // 実行時の `ensure_allowed_for_session` と同じ条件 (緊急モード中は拒否されない)。
    let enforce_read_only = session.read_only && !session.emergency_write_active();
    let result = match open_script_file(&path, requested).await {
        Ok((file, encoding)) => {
            let emit_app = app.clone();
            let emit_id = stream_id.clone();
            analyze_script_core(
                driver,
                enforce_read_only,
                file,
                total_bytes,
                encoding,
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
                        tracing::warn!(stream_id = %emit_id, error = %e, "failed to emit script analysis progress");
                    }
                },
            )
            .await
            .map(|analysis| (encoding, analysis))
        }
        Err(e) => Err(e),
    };
    let emitted = match result {
        Ok((encoding, analysis)) => {
            tracing::info!(stream_id = %stream_id, statements = analysis.total_statements, dangerous = analysis.dangerous_total, "sql script analyzed");
            app.emit(
                EV_SCRIPT_ANALYZED,
                ScriptAnalyzedEvent {
                    stream_id: stream_id.clone(),
                    encoding,
                    total_bytes,
                    file_stamp: stamp,
                    elapsed_ms: started.elapsed().as_millis() as u64,
                    analysis,
                },
            )
        }
        Err(e) => {
            tracing::error!(stream_id = %stream_id, error = %e, "sql script analysis failed");
            app.emit(
                EV_SCRIPT_ERROR,
                ScriptErrorEvent {
                    stream_id: stream_id.clone(),
                    error: e.to_string(),
                    failure: None,
                    executed: 0,
                    rolled_back: false,
                    in_transaction: false,
                    tx_begin_statement: None,
                },
            )
        }
    };
    if let Err(e) = emitted {
        tracing::warn!(stream_id = %stream_id, error = %e, "failed to emit script analysis terminal event");
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
        /// 全体を 1 つのトランザクションで包んで実行した (#1626)。
        wrapped: bool,
        /// `wrapped` でエラーがあり、成功扱いだった文も含めて全部取り消した (#1626)。
        rolled_back: bool,
        /// DML を記録したときのバッチ id (#1626)。1 件も記録していなければ `None`。
        batch_id: Option<String>,
        /// 記録できた DML の数と、記録を辞退した DML の数 (#1626)。
        captured: u64,
        capture_skipped: u64,
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
    // 全体を 1 つのトランザクションで包む (#1626)。いずれかの文が失敗したら全部取り消す。
    // `stop_on_error` が true で、呼び出し側の明示トランザクションが無いときだけ有効。
    wrap_in_transaction: Option<bool>,
    // 各 INSERT / UPDATE / DELETE をフライトレコーダに記録する (#1626)。同じバッチ id で
    // まとめて取り消せる。`wrap_in_transaction` のときは記録しない。
    capture: Option<bool>,
    capture_row_cap: Option<u32>,
    capture_retention_days: Option<u32>,
    on_event: Channel<BatchStreamMessage>,
    state: State<'_, AppState>,
) -> Result<()> {
    let session = state
        .get(&session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;
    // 件数 (Started の total) のための分割は数 MB の SQL では CPU を食うので、IPC の
    // ランタイム上では行わず、下で起動するタスク側で spawn_blocking に逃がす (#1530)。
    let driver = session.conn.driver_kind();
    let wrap = wrap_in_transaction.unwrap_or(false);
    if wrap && !stop_on_error {
        return Err(AppError::InvalidInput(
            "wrapping the batch in a transaction requires stop-on-error".into(),
        ));
    }
    let capture_stats = Arc::new(BatchCaptureStats::default());
    let capture_cfg = (capture.unwrap_or(false) && !wrap).then(|| BatchCaptureConfig {
        row_cap: capture_row_cap
            .map(|n| n as usize)
            .unwrap_or(crate::db::DEFAULT_CAPTURE_ROW_CAP),
        retention_days: capture_retention_days.map(|n| n as i64),
        batch_id: crate::flight_recorder::new_batch_id(),
        stats: capture_stats.clone(),
    });
    let batch_id_for_done = capture_cfg.as_ref().map(|c| c.batch_id.clone());

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
        let (sql, total) = match tokio::task::spawn_blocking(move || {
            let total = split_script(driver, &sql).len() as u64;
            (sql, total)
        })
        .await
        {
            Ok(v) => v,
            Err(e) => {
                let _ = on_event.send(BatchStreamMessage::Error {
                    error: format!("failed to split the script: {e}"),
                    connection_lost: false,
                });
                if let Some(state) = app.try_state::<AppState>() {
                    state.forget_stream(&stream_id_for_task, token).await;
                }
                return;
            }
        };
        if let Err(e) = on_event.send(BatchStreamMessage::Started { total }) {
            tracing::warn!(stream_id = %stream_id_for_task, error = %e, "failed to send batch started message");
        }
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
            wrap,
            capture_cfg,
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
            Ok(ScriptRun::Done { elapsed_ms, .. }) => {
                let captured = capture_stats.captured.load(Ordering::SeqCst);
                BatchStreamMessage::Done {
                    ok,
                    errors,
                    skipped,
                    elapsed_ms,
                    wrapped: wrap,
                    rolled_back: wrap && errors > 0,
                    batch_id: batch_id_for_done.filter(|_| captured > 0),
                    captured,
                    capture_skipped: capture_stats.skipped.load(Ordering::SeqCst),
                }
            }
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
        assert!(validate_options(&ScriptOptions {
            continue_on_error: true,
            wrap_in_transaction: true,
            ..ScriptOptions::default()
        })
        .is_err());
        assert!(validate_options(&ScriptOptions {
            continue_on_error: true,
            wrap_in_transaction: false,
            ..ScriptOptions::default()
        })
        .is_ok());
        assert!(validate_options(&ScriptOptions {
            skip_statements: vec![1; MAX_SKIP_STATEMENTS + 1],
            ..ScriptOptions::default()
        })
        .is_err());
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
    async fn open_script_file_rejects_invalid_utf8_after_the_first_chunk() {
        let dir = std::env::temp_dir().join(format!("noobdb_script_utf8_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let bad = dir.join("bad.sql");
        // 64KiB チャンクを超える ASCII の後ろに不正バイト。
        let mut data = b"SELECT 1;\n".repeat(READ_CHUNK_BYTES / 4);
        data.push(0xff);
        std::fs::write(&bad, &data).unwrap();
        // 後半の不正バイトは自動判定でも明示指定でも実行前に検出される。
        let err = open_script_file(&bad.to_string_lossy(), None)
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)));
        let err = open_script_file(&bad.to_string_lossy(), Some(TextEncoding::Utf8))
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)));
        let good = dir.join("good.sql");
        std::fs::write(&good, "SELECT '山田';\n").unwrap();
        let (_, enc) = open_script_file(&good.to_string_lossy(), None)
            .await
            .unwrap();
        assert_eq!(enc, TextEncoding::Utf8);
        // Shift_JIS のスクリプトは自動判定され、UTF-8 指定だと拒否される。
        let sj = dir.join("sjis.sql");
        std::fs::write(
            &sj,
            text_encoding::encode(
                "INSERT INTO t VALUES ('山田太郎');\n",
                TextEncoding::ShiftJis,
            )
            .unwrap(),
        )
        .unwrap();
        let (_, enc) = open_script_file(&sj.to_string_lossy(), None).await.unwrap();
        assert_eq!(enc, TextEncoding::ShiftJis);
        assert!(
            open_script_file(&sj.to_string_lossy(), Some(TextEncoding::Utf8))
                .await
                .is_err()
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn rejects_empty_path_and_directories() {
        assert!(matches!(
            script_file_stamp("  ").await,
            Err(AppError::InvalidInput(_))
        ));
        let dir = std::env::temp_dir();
        assert!(matches!(
            script_file_stamp(&dir.to_string_lossy()).await,
            Err(AppError::InvalidInput(_))
        ));
    }

    #[test]
    fn expected_file_must_match_when_given() {
        let a = FileStamp {
            size: 10,
            mtime_ms: 1000,
        };
        assert!(check_expected_file(None, a).is_ok());
        assert!(check_expected_file(Some(a), a).is_ok());
        for other in [
            FileStamp { size: 11, ..a },
            FileStamp {
                mtime_ms: 1001,
                ..a
            },
        ] {
            let err = check_expected_file(Some(a), other).unwrap_err();
            assert!(err.to_string().contains(FILE_CHANGED_MARKER));
        }
    }
}
