//! 1 回分のタスク実行 (#730)。プロファイルから接続を張り、アクション
//! (クエリ→エクスポート / ダンプ) を実行し、終了後に必ず切断する — 常駐接続を
//! 増やさない設計。`commands::connection::connect` / `disconnect` と、
//! `commands::export::run_export_to_file` / `commands::dump::run_dump` という
//! **既存の実行基盤をそのまま呼び出す**ことで、通常のクエリ/エクスポート/ダンプと
//! 同じ安全網・挙動を共有する。

use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;

use chrono::{DateTime, Utc};
use tauri::{AppHandle, Manager};

use super::{runs, NewAssertionResult, TaskAction, TaskDefinition};
use crate::assertions;
use crate::commands::assertions::run_assertion_with;
use crate::commands::connection::{
    connect, disconnect, ConnectRequest, SshJumpRequest, SshRequest,
};
use crate::commands::dump;
use crate::commands::export;
use crate::commands::plan_watch::{self as plan_watch, PlanWatchRefresh};
use crate::commands::timelapse::{self as timelapse, CaptureOutcome};
use crate::db::{is_read_only_sql, is_read_only_sql_for, DriverKind};
use crate::error::AppError;
use crate::profiles::{self, ConnectionProfile};
use crate::state::AppState;

/// 実行 1 回分の結果。呼び出し元 (`scheduler` / `commands::tasks::run_task_now`) が
/// これを `NewTaskRun` へ変換して実行ログへ記録する。
pub struct TaskOutcome {
    pub ok: bool,
    pub error: Option<String>,
    pub output_path: Option<String>,
    pub rows: Option<i64>,
    pub bytes: Option<i64>,
    /// `RunAssertions` (#1170) の 1 アサーションごとの結果。他のアクションでは空。
    pub assertion_results: Vec<NewAssertionResult>,
    /// 接続を試みた回数 (#1537)。再試行なしなら 1。実行ログ (`TaskRun.attempts`) に残す。
    pub attempts: u32,
}

impl TaskOutcome {
    pub(crate) fn err(message: impl Into<String>) -> Self {
        Self {
            ok: false,
            error: Some(message.into()),
            output_path: None,
            rows: None,
            bytes: None,
            assertion_results: Vec::new(),
            attempts: 1,
        }
    }
}

/// 1 回のタスク実行の最大時間 (エクスポート / ダンプ / アサーション共通)。
const TASK_MAX_RUN_SECS: u64 = 6 * 60 * 60;

/// アサーション 1 件あたりのクエリタイムアウト。ユーザ操作と違い中止できない
/// 無人実行なので、固定の上限で必ず打ち切る。
const ASSERTION_QUERY_TIMEOUT_SECS: u64 = 120;

/// アサーション実行の結果から、タスクの成否とエラー要約を決める (純関数)。
/// 全件 pass なら `None`。違反 (`passed=false`) と実行エラーを 1 行にまとめる。
pub fn summarize_assertion_failures(results: &[NewAssertionResult]) -> Option<String> {
    let failed: Vec<String> = results
        .iter()
        .filter(|r| !r.passed)
        .map(|r| match (&r.error, r.observed) {
            (Some(e), _) => format!("{} (error: {e})", r.assertion_name),
            (None, Some(n)) => format!("{} (observed {n})", r.assertion_name),
            (None, None) => r.assertion_name.clone(),
        })
        .collect();
    if failed.is_empty() {
        return None;
    }
    Some(format!(
        "{} of {} assertions failed: {}",
        failed.len(),
        results.len(),
        failed.join(", ")
    ))
}

/// タイムラプス取得の結果から、タスクのエラー要約を決める (純関数)。取得に失敗したテーブルが
/// 無ければ `None`。内容が変わっただけ (`added`) はエラーではない (#1537)。
pub fn summarize_timelapse_failures(outcomes: &[CaptureOutcome]) -> Option<String> {
    let failed: Vec<String> = outcomes
        .iter()
        .filter_map(|o| {
            o.error
                .as_ref()
                .map(|e| format!("{}.{} ({e})", o.database, o.table))
        })
        .collect();
    if failed.is_empty() {
        return None;
    }
    Some(format!(
        "{} of {} watched tables failed to capture: {}",
        failed.len(),
        outcomes.len(),
        failed.join(", ")
    ))
}

/// 実行計画ウォッチの更新結果から、タスクのエラー要約を決める (純関数)。警告相当の変化
/// (`warned`) か更新エラーがあれば `Some`。情報レベルの変化だけなら `None` (通知しない)。
pub fn summarize_plan_watch(res: &PlanWatchRefresh) -> Option<String> {
    let mut parts = Vec::new();
    if !res.warned.is_empty() {
        // 要約が揃っているときは「名前 (対象: 変更前 → 変更後)」で内容まで載せる (#1621)。
        let described: Vec<String> = res
            .warned
            .iter()
            .enumerate()
            .map(|(i, name)| match res.warned_summaries.get(i) {
                Some(s) if !s.is_empty() => format!("{name} ({s})"),
                _ => name.clone(),
            })
            .collect();
        parts.push(format!(
            "plan regression detected: {}",
            described.join(", ")
        ));
    }
    if !res.errors.is_empty() {
        let errs: Vec<String> = res
            .errors
            .iter()
            .map(|e| format!("{} ({})", e.name, e.error))
            .collect();
        parts.push(format!(
            "{} watched queries failed to refresh: {}",
            errs.len(),
            errs.join(", ")
        ));
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("; "))
    }
}

/// エクスポートのストリーミング読み出しバッチサイズ。ユーザ操作の
/// `ExportModal` と違い調整 UI を持たないため固定値にする (十分に大きく、
/// メモリを圧迫しない値)。
const EXPORT_INITIAL_BATCH: usize = 500;
const EXPORT_CHUNK_SIZE: usize = 2000;

/// タスクを 1 回実行する。**接続を新規に張り、実行後に必ず切断する** —
/// 既存のセッションを再利用しない (#730 の要件)。読み取り専用 SQL かどうかは
/// 接続前に検証するので、不正なタスクは接続コストを払わずに拒否される。
/// `catch_up` (アプリ非起動中に過ぎたスケジュールの追い掛け実行かどうか) は実行
/// そのものには影響せず、呼び出し元が `NewTaskRun.catch_up` へそのまま転記する。
///
/// `progress` は進捗の件数 (エクスポートは書いた行数、ダンプは書いたバイト数、アサーションは
/// 実行済みの件数)。「今すぐ実行」(`commands::tasks::run_task_now`) が定期的に読んで
/// `task-run:progress` で知らせる (#1534)。スケジューラ経由では読む人がいない。
///
/// 実行中に future が破棄されても (「今すぐ実行」の中断) 接続が残らないよう、切断は
/// Drop ガードでも保証する。
pub async fn run_once(
    app: &AppHandle,
    task: &TaskDefinition,
    progress: &Arc<AtomicU64>,
) -> TaskOutcome {
    if let TaskAction::ExportQuery { sql, .. } = &task.action {
        // プロファイル (= ドライバ) を解決する前に弾くため、ドライバ非依存の
        // 保守的なマスクを使う `is_read_only_sql` を通す (#852)。判定は
        // `commands::tasks::validate_action` (保存時) と同一。
        if !is_read_only_sql(sql) {
            return TaskOutcome::err(
                "task SQL is not read-only (scheduler only allows SELECT / SHOW / DESCRIBE / EXPLAIN / WITH)",
            );
        }
    }

    let mut profile = match load_profile(&task.profile_id) {
        Ok(p) => p,
        Err(e) => return TaskOutcome::err(e.to_string()),
    };

    // 接続段階だけを再試行する (#1537)。クエリ / エクスポート / ダンプが始まった後の失敗は
    // 再試行しない (副作用の二重発生を避ける)。再試行しないタスクは従来どおり 1 回で終わる。
    let retry = task.connect_retry.normalized();
    let mut attempts: u32 = 0;
    let session_id = loop {
        attempts += 1;
        // 接続のたびに組み立て直す (`connect` が `ConnectRequest` を消費するため)。
        let req = match build_connect_request(&profile) {
            Ok(r) => r,
            Err(e) => return TaskOutcome::err(e.to_string()),
        };
        let state = app.state::<AppState>();
        match connect(app.clone(), req, None, None, state).await {
            Ok(resp) => break resp.session_id,
            Err(e) => {
                let retries_done = attempts - 1;
                if retries_done < retry.max_retries && is_retryable_connect_error(&e) {
                    let delay = retry.delay_secs(retries_done);
                    tracing::warn!(
                        task_id = %task.id,
                        attempt = attempts,
                        retry_in_secs = delay,
                        error = %e,
                        "task scheduler: connect failed; will retry"
                    );
                    tokio::time::sleep(std::time::Duration::from_secs(delay)).await;
                    // 待っている間に無効化・削除されたタスクは、定義を読み直して中止する。
                    // 読み直せなかったとき (一時的な I/O エラー等) は削除扱いにせず、警告だけ
                    // 残して再試行を続ける。
                    match super::store::load_all() {
                        Ok(all) => {
                            let current = all.into_iter().find(|t| t.id == task.id);
                            if let Some(reason) = retry_abort_reason(task.enabled, current.as_ref())
                            {
                                let mut outcome = TaskOutcome::err(format!(
                                    "connect retry aborted ({reason}) after {attempts} attempts: {e}"
                                ));
                                outcome.attempts = attempts;
                                return outcome;
                            }
                        }
                        Err(load_err) => {
                            tracing::warn!(
                                task_id = %task.id,
                                error = %load_err,
                                "task scheduler: failed to re-read the task definition before retrying; continuing"
                            );
                        }
                    }
                    // 待機中に接続先が修正されたかもしれないので、プロファイルも読み直す。
                    // プロファイルが削除されていたら中止し、I/O エラーなど一時的な失敗のときは
                    // 直前の内容で再試行を続ける。
                    match load_profile(&task.profile_id) {
                        Ok(p) => profile = p,
                        Err(AppError::InvalidInput(msg)) => {
                            let mut outcome = TaskOutcome::err(format!(
                                "connect retry aborted ({msg}) after {attempts} attempts: {e}"
                            ));
                            outcome.attempts = attempts;
                            return outcome;
                        }
                        Err(load_err) => {
                            tracing::warn!(
                                task_id = %task.id,
                                error = %load_err,
                                "task scheduler: failed to re-read the profile before retrying; continuing with the previous one"
                            );
                        }
                    }
                    continue;
                }
                let mut outcome = TaskOutcome::err(if attempts > 1 {
                    format!("connect failed after {attempts} attempts: {e}")
                } else {
                    format!("connect failed: {e}")
                });
                outcome.attempts = attempts;
                return outcome;
            }
        }
    };
    if attempts > 1 {
        tracing::info!(task_id = %task.id, attempts, "task scheduler: connected after retrying");
    }
    // 以降で future が途中で破棄されたら (中断)、Drop で切断を投げる。
    let mut disconnect_guard = DisconnectOnDrop {
        app: app.clone(),
        session_id: session_id.clone(),
        armed: true,
    };

    // 無人実行なのでロック待ち等で終わらないクエリが接続とタスクを溜めないよう、
    // タスク単位の最大実行時間で打ち切る。超過は error として記録される。
    let mut outcome = match tokio::time::timeout(
        std::time::Duration::from_secs(TASK_MAX_RUN_SECS),
        run_action(app, &session_id, task, &profile, progress),
    )
    .await
    {
        Ok(o) => o,
        Err(_) => TaskOutcome::err(format!(
            "task timed out after {TASK_MAX_RUN_SECS} seconds and was cancelled"
        )),
    };

    // 成功/失敗を問わず必ず切断する (常駐接続を増やさない)。切断自体の失敗は
    // ログに残すのみで、タスクの成否には影響させない (アクションはもう完了/
    // 失敗している)。
    let state = app.state::<AppState>();
    // `armed` は切断の await が終わってから下ろす。await の途中で中断 (Drop) されても
    // ガードが切断を引き継ぐ。disconnect は冪等 (既に無いセッションは何もしない) なので
    // 二重に呼ばれても安全。
    if let Err(e) = disconnect(session_id.clone(), state).await {
        tracing::warn!(session_id = %session_id, error = %e, "task scheduler: failed to close connection after run");
    }
    disconnect_guard.armed = false;

    outcome.attempts = attempts;
    outcome
}

/// 接続失敗を再試行してよいか (#1537)。一時的な瞬断・DB / SSH サーバの再起動で起こる
/// ネットワーク層の失敗だけを対象にする。認証失敗・ホスト鍵不一致・設定不備・TLS 証明書の
/// 問題は、待っても直らないうえ再試行で口座ロックや踏み台の fail2ban を招きうるので
/// 再試行しない。
pub fn is_retryable_connect_error(e: &AppError) -> bool {
    match e {
        AppError::ConnectTimeout { .. } | AppError::Io(_) => true,
        // SSH 層は認証失敗も `Ssh` で返るので、語の有無ではなく「接続段階の失敗」の
        // 接頭辞 (`ssh/tunnel.rs`) だけを許可する。認証・agent・鍵の不備は再試行しない。
        AppError::Ssh(msg) => crate::ssh::tunnel::is_ssh_connect_stage_failure(msg),
        AppError::Sqlx(err) => is_transient_sqlx_error(err),
        _ => false,
    }
}

/// 一時的と見なす sqlx のエラー。ネットワーク層の失敗に加え、DB の再起動中・接続数上限
/// (PostgreSQL 57P03 `cannot_connect_now` / 57P01 `admin_shutdown`、MySQL 1040
/// `Too many connections` / 1053 `Server shutdown in progress`) を含む。認証失敗
/// (PostgreSQL 28xxx / MySQL 1045) などは待っても直らないので含めない。
fn is_transient_sqlx_error(err: &sqlx::Error) -> bool {
    match err {
        sqlx::Error::Io(_)
        | sqlx::Error::PoolTimedOut
        | sqlx::Error::PoolClosed
        | sqlx::Error::WorkerCrashed => true,
        sqlx::Error::Database(db) => {
            if let Some(my) = db.try_downcast_ref::<sqlx::mysql::MySqlDatabaseError>() {
                return is_transient_mysql_code(my.number());
            }
            db.code()
                .is_some_and(|code| is_transient_sqlstate(code.as_ref()))
        }
        _ => false,
    }
}

/// PostgreSQL の SQLSTATE のうち、再起動・シャットダウン中のもの (純粋)。
fn is_transient_sqlstate(code: &str) -> bool {
    matches!(code, "57P03" | "57P01")
}

/// MySQL のエラー番号のうち、接続数上限・シャットダウン中のもの (純粋)。
fn is_transient_mysql_code(number: u16) -> bool {
    matches!(number, 1040 | 1053)
}

/// 再試行の待機のあとにタスク定義を読み直した結果、再試行を中止すべき理由 (純粋)。
/// `started_enabled` は実行開始時点で有効だったか。待機中に削除された、または有効から
/// 無効に変えられたタスクは中止する。無効なまま手動実行 (「今すぐ実行」) されたものは、
/// 無効であること自体は中止の理由にしない。
fn retry_abort_reason(
    started_enabled: bool,
    current: Option<&TaskDefinition>,
) -> Option<&'static str> {
    match current {
        None => Some("task was deleted"),
        Some(t) if started_enabled && !t.enabled => Some("task was disabled"),
        Some(_) => None,
    }
}

/// `RunAssertions` の `notify_only_on_increase` 用の判定 (#1537): 今回の失敗 ID の中に、
/// 直前の実行では失敗していなかったもの (= 新しく失敗したもの) があるか。`prev_failed` は
/// 直前の実行の失敗 ID (初回は `None` で、失敗 0 件を基準にする)。件数ではなく ID の差分で
/// 見るので、別の項目が直ると同時に別の項目が壊れた (件数は同じ) ときも通知できる。
pub fn assertion_failures_increased(
    failed: &HashSet<&str>,
    prev_failed: Option<&HashSet<String>>,
) -> bool {
    failed
        .iter()
        .any(|id| !prev_failed.is_some_and(|prev| prev.contains(*id)))
}

/// `run_once` の future が実行の途中で破棄されたとき (「今すぐ実行」の中断) に、張った接続を
/// 閉じるためのガード。通常終了では `armed` を下ろして `run_once` 自身が切断する。
struct DisconnectOnDrop {
    app: AppHandle,
    session_id: String,
    armed: bool,
}

impl Drop for DisconnectOnDrop {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let app = self.app.clone();
        let session_id = self.session_id.clone();
        tauri::async_runtime::spawn(async move {
            let state = app.state::<AppState>();
            if let Err(e) = disconnect(session_id.clone(), state).await {
                tracing::warn!(session_id = %session_id, error = %e, "task: failed to close connection after cancel");
            }
        });
    }
}

async fn run_action(
    app: &AppHandle,
    session_id: &str,
    task: &TaskDefinition,
    profile: &ConnectionProfile,
    progress: &Arc<AtomicU64>,
) -> TaskOutcome {
    let state = app.state::<AppState>();
    let Some(session) = state.get(session_id).await else {
        return TaskOutcome::err("session unexpectedly missing right after connect");
    };

    let now = Utc::now();
    match &task.action {
        TaskAction::ExportQuery {
            sql,
            database,
            format,
            output_path,
            sql_table,
            sql_batch_size,
        } => {
            // 接続前の検証 (ドライバ不明) に加えて、解決したドライバで再検証する
            // (PostgreSQL の `#` 演算子など、ドライバ別マスクで結果が変わる入力のため)。
            if !is_read_only_sql_for(session.conn.driver_kind(), sql) {
                return TaskOutcome::err(
                    "task SQL is not read-only (scheduler only allows SELECT / SHOW / DESCRIBE / EXPLAIN / WITH)",
                );
            }
            let path = resolve_output_path(output_path, now);
            let result = export::run_export_to_file(
                &session,
                sql,
                database.as_deref(),
                *format,
                &path,
                sql_table.clone(),
                *sql_batch_size,
                EXPORT_INITIAL_BATCH,
                EXPORT_CHUNK_SIZE,
                None,
                // スケジュール実行のエクスポートはマスキング (#733) 非対応 (タスク定義に
                // ルールを持たない)。マスクが必要な出力は ExportModal から行う。
                None,
                // スケジュール実行は表定義 (CREATE TABLE) を付けない (#1539。ExportModal から行う)。
                false,
                // 衝突時の書き方 (UPSERT) と CSV の文字コードは ExportModal / 一括書き出しの機能 (#1624)。
                None,
                None,
                |rows| progress.store(rows, Ordering::SeqCst),
            )
            .await;
            match result {
                Ok(outcome) => {
                    // xlsx で Excel の上限に当たったときは、実際にファイルへ書いた行数を
                    // 記録する (読んだ行数を載せると実行ログが出力内容と食い違う)。
                    let written = match &outcome.truncation {
                        Some(t) => {
                            tracing::warn!(
                                task_id = %task.id,
                                written_rows = t.written_rows,
                                dropped_rows = t.dropped_rows,
                                truncated_cells = t.truncated_cells,
                                "scheduled xlsx export hit an Excel limit; output is incomplete"
                            );
                            t.written_rows
                        }
                        None => outcome.rows,
                    };
                    TaskOutcome {
                        ok: true,
                        error: None,
                        output_path: Some(path),
                        rows: Some(written as i64),
                        bytes: Some(outcome.bytes as i64),
                        assertion_results: Vec::new(),
                        attempts: 1,
                    }
                }
                Err(e) => TaskOutcome::err(e.to_string()),
            }
        }
        TaskAction::Dump {
            database,
            output_path,
            options,
        } => {
            let path = resolve_output_path(output_path, now);
            let result = dump::run_dump(
                app,
                &session,
                // タスク実行はフロントの購読者がいないので、進捗イベントの stream_id は
                // どのタブとも衝突しない専用の識別子で十分。
                &format!("task-{}", task.id),
                database,
                // タスクの database は自由入力で、PostgreSQL では接続先 DB 名として扱う。
                true,
                &path,
                options,
                progress,
                Instant::now(),
            )
            .await;
            match result {
                Ok(bytes) => TaskOutcome {
                    ok: true,
                    error: None,
                    output_path: Some(path),
                    rows: None,
                    bytes: Some(bytes as i64),
                    assertion_results: Vec::new(),
                    attempts: 1,
                },
                Err(e) => TaskOutcome::err(e.to_string()),
            }
        }
        TaskAction::RunAssertions {
            database,
            assertion_ids,
            notify_only_on_increase,
        } => {
            // 比較元は今回の結果を記録する前に読む (`record_outcome` が後で記録する)。
            let prev_failed = if *notify_only_on_increase {
                match runs::last_failed_assertion_ids(&task.id).await {
                    Ok(n) => n,
                    Err(e) => {
                        tracing::warn!(task_id = %task.id, error = %e, "task scheduler: failed to read previous assertion failures");
                        None
                    }
                }
            } else {
                None
            };
            let all = match crate::commands::assertions::blocking_store(assertions::store::load_all)
                .await
            {
                Ok(v) => v,
                Err(e) => return TaskOutcome::err(e.to_string()),
            };
            let selected = assertions::select_for_task(
                &all,
                assertion_ids,
                &profile.id,
                profile.group.as_deref(),
            );
            if selected.is_empty() {
                return TaskOutcome::err("no assertions matched this task's profile scope");
            }
            let mut results = Vec::with_capacity(selected.len());
            for item in selected {
                progress.store(results.len() as u64, Ordering::SeqCst);
                match item {
                    Err(missing_id) => results.push(NewAssertionResult {
                        assertion_id: missing_id.clone(),
                        assertion_name: missing_id,
                        passed: false,
                        observed: None,
                        error: Some("assertion not found (deleted?)".into()),
                        elapsed_ms: 0,
                    }),
                    Ok(assertion) => {
                        let started = Instant::now();
                        // 1 件の失敗 (接続断・タイムアウト) で残りを止めない。
                        let r = run_assertion_with(
                            state.inner(),
                            session_id,
                            &assertion,
                            database.as_deref(),
                            Some(ASSERTION_QUERY_TIMEOUT_SECS),
                        )
                        .await;
                        results.push(match r {
                            Ok(o) => NewAssertionResult {
                                assertion_id: assertion.id.clone(),
                                assertion_name: assertion.name.clone(),
                                passed: o.passed,
                                observed: i64::try_from(o.observed).ok(),
                                error: None,
                                elapsed_ms: i64::try_from(o.elapsed_ms).unwrap_or(i64::MAX),
                            },
                            Err(e) => NewAssertionResult {
                                assertion_id: assertion.id.clone(),
                                assertion_name: assertion.name.clone(),
                                passed: false,
                                observed: None,
                                error: Some(e.to_string()),
                                elapsed_ms: i64::try_from(started.elapsed().as_millis())
                                    .unwrap_or(i64::MAX),
                            },
                        });
                    }
                }
            }
            let mut error = summarize_assertion_failures(&results);
            if *notify_only_on_increase {
                let failed: HashSet<&str> = results
                    .iter()
                    .filter(|r| !r.passed)
                    .map(|r| r.assertion_id.as_str())
                    .collect();
                if !assertion_failures_increased(&failed, prev_failed.as_ref()) {
                    // 失敗が増えていなければ既知の状態が続いているだけ。通知に乗せず ok で終える
                    // (合否の推移は `assertion_runs` に記録される)。
                    error = None;
                }
            }
            TaskOutcome {
                ok: error.is_none(),
                error,
                output_path: None,
                rows: Some(results.len() as i64),
                bytes: None,
                assertion_results: results,
                attempts: 1,
            }
        }
        TaskAction::TimelapseCapture { max_generations } => {
            match timelapse::capture_all(&session, *max_generations, Some(progress)).await {
                Ok(outcomes) => {
                    progress.store(outcomes.len() as u64, Ordering::SeqCst);
                    let error = summarize_timelapse_failures(&outcomes);
                    TaskOutcome {
                        ok: error.is_none(),
                        error,
                        output_path: None,
                        // 記録した世代数 (= 内容が変わったテーブルの数)。
                        rows: Some(outcomes.iter().filter(|o| o.added).count() as i64),
                        bytes: None,
                        assertion_results: Vec::new(),
                        attempts: 1,
                    }
                }
                Err(e) => TaskOutcome::err(e.to_string()),
            }
        }
        TaskAction::RefreshPlanWatch { snippet_ids } => {
            let only = (!snippet_ids.is_empty()).then_some(snippet_ids.as_slice());
            match plan_watch::refresh_plans(&session, &profile.id, only, Some(progress)).await {
                Ok(res) => {
                    let error = summarize_plan_watch(&res);
                    TaskOutcome {
                        ok: error.is_none(),
                        error,
                        output_path: None,
                        // 新しく記録した計画の世代数。
                        rows: Some(res.recorded as i64),
                        bytes: None,
                        assertion_results: Vec::new(),
                        attempts: 1,
                    }
                }
                Err(e) => TaskOutcome::err(e.to_string()),
            }
        }
    }
}

fn load_profile(profile_id: &str) -> Result<ConnectionProfile, AppError> {
    let all = profiles::store::load_all()?;
    all.into_iter()
        .find(|p| p.id == profile_id)
        .ok_or_else(|| AppError::InvalidInput(format!("profile not found: {profile_id}")))
}

fn driver_kind_of(driver: &str) -> Result<DriverKind, AppError> {
    match driver {
        "mysql" => Ok(DriverKind::Mysql),
        "postgres" => Ok(DriverKind::Postgres),
        "sqlite" => Ok(DriverKind::Sqlite),
        other => Err(AppError::InvalidInput(format!("unknown driver: {other}"))),
    }
}

/// `ConnectionProfile` から `ConnectRequest` を組み立てる。パスワード/
/// パスフレーズは常に空文字列にし (`profile_id` を渡すことで `connect` 内部の
/// `resolve_password` 等が keyring から解決する)、常に `read_only: true` を
/// 強制する — プロファイル自体が書き込み可能でも、スケジューラが張るセッションは
/// 読み取り専用に固定する多重の安全網 (#730)。
fn build_connect_request(profile: &ConnectionProfile) -> Result<ConnectRequest, AppError> {
    let driver = driver_kind_of(&profile.driver)?;
    // ジャンプホスト (#708) も同じく秘密は常に空にし、`connect` 側が
    // `profile_id` から keyring (kind `_hop0`) を解決する。
    let ssh = profile.ssh.as_ref().map(|s| SshRequest {
        host: s.host.clone(),
        port: s.port,
        user: s.user.clone(),
        auth_method: s.auth_method,
        private_key_path: s.private_key_path.clone(),
        passphrase: String::new(),
        password: String::new(),
        jump: s.jump.as_ref().map(|j| SshJumpRequest {
            host: j.host.clone(),
            port: j.port,
            user: j.user.clone(),
            auth_method: j.auth_method,
            private_key_path: j.private_key_path.clone(),
            passphrase: String::new(),
            password: String::new(),
        }),
    });
    Ok(ConnectRequest {
        profile_id: Some(profile.id.clone()),
        driver,
        host: profile.host.clone(),
        port: profile.port,
        user: profile.user.clone(),
        password: String::new(),
        database: profile.database.clone(),
        ssh,
        file_path: profile.file_path.clone(),
        ssl_mode: profile.ssl_mode,
        ssl_root_cert: profile.ssl_root_cert.clone(),
        ssl_client_cert: profile.ssl_client_cert.clone(),
        ssl_client_key: profile.ssl_client_key.clone(),
        init_sql: profile.init_sql.clone(),
        aws_iam: profile.aws_iam.clone(),
        ssm: profile.ssm.clone(),
        read_only: true,
        skip_history: true,
    })
}

/// 出力パステンプレート中のプレースホルダを展開する。対応するのは
/// `{date}` (`YYYY-MM-DD`) と `{datetime}` (`YYYYMMDD-HHMMSS`、UTC)。未知の
/// `{...}` はそのまま残す (誤検出よりわかりやすい失敗を優先)。
pub fn resolve_output_path(template: &str, now: DateTime<Utc>) -> String {
    let date = now.format("%Y-%m-%d").to_string();
    let datetime = now.format("%Y%m%d-%H%M%S").to_string();
    template
        .replace("{date}", &date)
        .replace("{datetime}", &datetime)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn dt() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 3, 4, 5, 6, 7).unwrap()
    }

    #[test]
    fn resolves_date_placeholder() {
        assert_eq!(
            resolve_output_path("sales-{date}.csv", dt()),
            "sales-2026-03-04.csv"
        );
    }

    #[test]
    fn resolves_datetime_placeholder() {
        assert_eq!(
            resolve_output_path("dump-{datetime}.sql", dt()),
            "dump-20260304-050607.sql"
        );
    }

    #[test]
    fn resolves_both_placeholders_and_repeats() {
        assert_eq!(
            resolve_output_path("{date}/{date}-{datetime}.csv", dt()),
            "2026-03-04/2026-03-04-20260304-050607.csv"
        );
    }

    #[test]
    fn leaves_path_without_placeholders_untouched() {
        assert_eq!(resolve_output_path("plain.csv", dt()), "plain.csv");
    }

    fn res(
        name: &str,
        passed: bool,
        observed: Option<i64>,
        error: Option<&str>,
    ) -> NewAssertionResult {
        NewAssertionResult {
            assertion_id: name.into(),
            assertion_name: name.into(),
            passed,
            observed,
            error: error.map(str::to_string),
            elapsed_ms: 1,
        }
    }

    #[test]
    fn summarize_returns_none_when_all_pass() {
        let r = vec![res("a", true, Some(0), None), res("b", true, Some(0), None)];
        assert_eq!(summarize_assertion_failures(&r), None);
        assert_eq!(summarize_assertion_failures(&[]), None);
    }

    #[test]
    fn summarize_lists_violations_and_errors() {
        let r = vec![
            res("a", true, Some(0), None),
            res("b", false, Some(4), None),
            res("c", false, None, Some("timeout")),
        ];
        assert_eq!(
            summarize_assertion_failures(&r).as_deref(),
            Some("2 of 3 assertions failed: b (observed 4), c (error: timeout)")
        );
    }

    fn capture(table: &str, added: bool, error: Option<&str>) -> CaptureOutcome {
        CaptureOutcome {
            watch_id: 1,
            database: "app".into(),
            table: table.into(),
            added,
            truncated: false,
            error: error.map(str::to_string),
        }
    }

    #[test]
    fn timelapse_summary_ignores_changes_and_lists_failures() {
        assert_eq!(summarize_timelapse_failures(&[]), None);
        let ok = vec![capture("a", true, None), capture("b", false, None)];
        assert_eq!(summarize_timelapse_failures(&ok), None);
        let bad = vec![capture("a", true, None), capture("b", false, Some("no pk"))];
        assert_eq!(
            summarize_timelapse_failures(&bad).as_deref(),
            Some("1 of 2 watched tables failed to capture: app.b (no pk)")
        );
    }

    #[test]
    fn plan_watch_summary_notifies_only_on_warnings_or_errors() {
        use crate::commands::plan_watch::PlanWatchRefreshError;
        // 情報レベルの変化 (changed > 0 だが warned は空) は通知しない。
        let info_only = PlanWatchRefresh {
            recorded: 2,
            changed: 2,
            ..Default::default()
        };
        assert_eq!(summarize_plan_watch(&info_only), None);
        let warned = PlanWatchRefresh {
            recorded: 1,
            changed: 1,
            warned: vec!["slow report".into()],
            ..Default::default()
        };
        assert_eq!(
            summarize_plan_watch(&warned).as_deref(),
            Some("plan regression detected: slow report")
        );
        // 変化の要約があれば本文に載せる (#1621)。
        let detailed = PlanWatchRefresh {
            warned: vec!["slow report".into(), "q9".into()],
            warned_summaries: vec!["orders: Index Scan → Parallel Seq Scan".into()],
            ..Default::default()
        };
        assert_eq!(
            summarize_plan_watch(&detailed).as_deref(),
            Some("plan regression detected: slow report (orders: Index Scan → Parallel Seq Scan), q9")
        );
        let both = PlanWatchRefresh {
            warned: vec!["q1".into()],
            errors: vec![PlanWatchRefreshError {
                snippet_id: "s".into(),
                name: "q2".into(),
                error: "boom".into(),
            }],
            ..Default::default()
        };
        assert_eq!(
            summarize_plan_watch(&both).as_deref(),
            Some("plan regression detected: q1; 1 watched queries failed to refresh: q2 (boom)")
        );
    }

    #[test]
    fn assertion_failures_increase_means_a_newly_failing_id() {
        let cur = |v: &[&'static str]| -> HashSet<&'static str> { v.iter().copied().collect() };
        let prev = |v: &[&str]| -> HashSet<String> { v.iter().map(|s| s.to_string()).collect() };
        // 初回は失敗 0 件が基準。
        assert!(!assertion_failures_increased(&cur(&[]), None));
        assert!(assertion_failures_increased(&cur(&["a"]), None));
        // 同じ失敗が続く / 減るだけなら通知しない。
        assert!(!assertion_failures_increased(
            &cur(&["a", "b"]),
            Some(&prev(&["a", "b"]))
        ));
        assert!(!assertion_failures_increased(
            &cur(&["a"]),
            Some(&prev(&["a", "b"]))
        ));
        assert!(!assertion_failures_increased(
            &cur(&[]),
            Some(&prev(&["a"]))
        ));
        // 新しく失敗した ID があれば通知する。
        assert!(assertion_failures_increased(
            &cur(&["a", "c"]),
            Some(&prev(&["a", "b"]))
        ));
        assert!(assertion_failures_increased(&cur(&["a"]), Some(&prev(&[]))));
        // 件数は同じでも、入れ替わりは新規の失敗 (b が直って c が壊れた)。
        assert!(assertion_failures_increased(
            &cur(&["c"]),
            Some(&prev(&["b"]))
        ));
    }

    #[test]
    fn only_transient_connect_errors_are_retried() {
        assert!(is_retryable_connect_error(&AppError::ConnectTimeout {
            phase: "tcp".into(),
            secs: 10
        }));
        assert!(is_retryable_connect_error(&AppError::Io(
            std::io::Error::new(std::io::ErrorKind::ConnectionRefused, "refused")
        )));
        assert!(is_retryable_connect_error(&AppError::Ssh(
            "ssh connect failed: connection reset".into()
        )));
        assert!(is_retryable_connect_error(&AppError::Sqlx(
            sqlx::Error::PoolTimedOut
        )));
        // 待っても直らない / 再試行が害になるもの。
        assert!(!is_retryable_connect_error(&AppError::Ssh(
            "ssh authentication failed".into()
        )));
        assert!(!is_retryable_connect_error(&AppError::SshKey("bad".into())));
        assert!(!is_retryable_connect_error(&AppError::InvalidInput(
            "unknown driver".into()
        )));
        assert!(!is_retryable_connect_error(&AppError::SshHostKeyMismatch {
            host: "h".into(),
            port: 22,
            expected: "a".into(),
            actual: "b".into()
        }));
        assert!(!is_retryable_connect_error(&AppError::Sqlx(
            sqlx::Error::RowNotFound
        )));
    }

    #[test]
    fn ssh_retry_is_decided_by_the_stage_not_by_a_substring() {
        // ホスト名に auth を含んでいても、接続段階の失敗なら再試行する。
        assert!(is_retryable_connect_error(&AppError::Ssh(
            "[host auth.example.com:22] ssh connect failed: timed out".into()
        )));
        // 認証・agent の不備は、メッセージに auth の語が無くても再試行しない。
        assert!(!is_retryable_connect_error(&AppError::Ssh(
            "[host h:22] ssh-agent holds no identities (add one with `ssh-add`)".into()
        )));
        assert!(!is_retryable_connect_error(&AppError::Ssh(
            "[host h:22] ssh password authentication failed".into()
        )));
    }

    #[test]
    fn db_restart_codes_are_transient_but_auth_codes_are_not() {
        for c in ["57P03", "57P01"] {
            assert!(is_transient_sqlstate(c), "{c}");
        }
        for c in ["28000", "28P01", "42P01", "08006"] {
            assert!(!is_transient_sqlstate(c), "{c}");
        }
        assert!(is_transient_mysql_code(1040));
        assert!(is_transient_mysql_code(1053));
        assert!(!is_transient_mysql_code(1045));
        assert!(!is_transient_mysql_code(1049));
    }

    fn task_with_enabled(enabled: bool) -> TaskDefinition {
        TaskDefinition {
            id: "t1".into(),
            name: "n".into(),
            profile_id: "p".into(),
            action: TaskAction::TimelapseCapture {
                max_generations: None,
            },
            schedule: crate::tasks::TaskSchedule::Interval { minutes: 5 },
            enabled,
            created_at: String::new(),
            updated_at: String::new(),
            next_run_at: None,
            last_run_at: None,
            last_status: None,
            connect_retry: Default::default(),
            pause_after_failures: 0,
            consecutive_failures: 0,
            auto_paused_at: None,
        }
    }

    #[test]
    fn retry_aborts_when_the_task_was_deleted_or_disabled_while_waiting() {
        assert!(retry_abort_reason(true, None).is_some());
        assert!(retry_abort_reason(true, Some(&task_with_enabled(false))).is_some());
        assert_eq!(
            retry_abort_reason(true, Some(&task_with_enabled(true))),
            None
        );
        // 無効なタスクの手動実行は、無効であることだけでは中止しない (削除は中止)。
        assert_eq!(
            retry_abort_reason(false, Some(&task_with_enabled(false))),
            None
        );
        assert!(retry_abort_reason(false, None).is_some());
    }

    #[test]
    fn driver_kind_of_maps_known_names() {
        assert_eq!(driver_kind_of("mysql").unwrap(), DriverKind::Mysql);
        assert_eq!(driver_kind_of("postgres").unwrap(), DriverKind::Postgres);
        assert_eq!(driver_kind_of("sqlite").unwrap(), DriverKind::Sqlite);
        assert!(driver_kind_of("oracle").is_err());
    }
}
