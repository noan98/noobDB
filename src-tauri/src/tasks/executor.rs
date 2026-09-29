//! 1 回分のタスク実行 (#730)。プロファイルから接続を張り、アクション
//! (クエリ→エクスポート / ダンプ) を実行し、終了後に必ず切断する — 常駐接続を
//! 増やさない設計。`commands::connection::connect` / `disconnect` と、
//! `commands::export::run_export_to_file` / `commands::dump::run_dump` という
//! **既存の実行基盤をそのまま呼び出す**ことで、通常のクエリ/エクスポート/ダンプと
//! 同じ安全網・挙動を共有する。

use std::sync::atomic::AtomicU64;
use std::sync::Arc;
use std::time::Instant;

use chrono::{DateTime, Utc};
use tauri::{AppHandle, Manager};

use super::{NewAssertionResult, TaskAction, TaskDefinition};
use crate::assertions;
use crate::commands::assertions::run_assertion_with;
use crate::commands::connection::{
    connect, disconnect, ConnectRequest, SshJumpRequest, SshRequest,
};
use crate::commands::dump;
use crate::commands::export;
use crate::db::{is_read_only_sql, DriverKind};
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
}

impl TaskOutcome {
    fn err(message: impl Into<String>) -> Self {
        Self {
            ok: false,
            error: Some(message.into()),
            output_path: None,
            rows: None,
            bytes: None,
            assertion_results: Vec::new(),
        }
    }
}

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
pub async fn run_once(app: &AppHandle, task: &TaskDefinition) -> TaskOutcome {
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

    let profile = match load_profile(&task.profile_id) {
        Ok(p) => p,
        Err(e) => return TaskOutcome::err(e.to_string()),
    };

    let req = match build_connect_request(&profile) {
        Ok(r) => r,
        Err(e) => return TaskOutcome::err(e.to_string()),
    };

    let state = app.state::<AppState>();
    let session_id = match connect(app.clone(), req, None, None, state).await {
        Ok(resp) => resp.session_id,
        Err(e) => return TaskOutcome::err(format!("connect failed: {e}")),
    };

    let outcome = run_action(app, &session_id, task, &profile).await;

    // 成功/失敗を問わず必ず切断する (常駐接続を増やさない)。切断自体の失敗は
    // ログに残すのみで、タスクの成否には影響させない (アクションはもう完了/
    // 失敗している)。
    let state = app.state::<AppState>();
    if let Err(e) = disconnect(session_id.clone(), state).await {
        tracing::warn!(session_id = %session_id, error = %e, "task scheduler: failed to close connection after run");
    }

    outcome
}

async fn run_action(
    app: &AppHandle,
    session_id: &str,
    task: &TaskDefinition,
    profile: &ConnectionProfile,
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
                |_rows| {},
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
            let counter = Arc::new(AtomicU64::new(0));
            let result = dump::run_dump(
                app,
                &session,
                // タスク実行はフロントの購読者がいないので、進捗イベントの stream_id は
                // どのタブとも衝突しない専用の識別子で十分。
                &format!("task-{}", task.id),
                database,
                &path,
                options,
                &counter,
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
                },
                Err(e) => TaskOutcome::err(e.to_string()),
            }
        }
        TaskAction::RunAssertions {
            database,
            assertion_ids,
        } => {
            let all = match assertions::store::load_all() {
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
            let error = summarize_assertion_failures(&results);
            TaskOutcome {
                ok: error.is_none(),
                error,
                output_path: None,
                rows: Some(results.len() as i64),
                bytes: None,
                assertion_results: results,
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

    #[test]
    fn driver_kind_of_maps_known_names() {
        assert_eq!(driver_kind_of("mysql").unwrap(), DriverKind::Mysql);
        assert_eq!(driver_kind_of("postgres").unwrap(), DriverKind::Postgres);
        assert_eq!(driver_kind_of("sqlite").unwrap(), DriverKind::Sqlite);
        assert!(driver_kind_of("oracle").is_err());
    }
}
