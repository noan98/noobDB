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

use super::{TaskAction, TaskDefinition};
use crate::commands::connection::{connect, disconnect, ConnectRequest, SshJumpRequest, SshRequest};
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
}

impl TaskOutcome {
    fn err(message: impl Into<String>) -> Self {
        Self {
            ok: false,
            error: Some(message.into()),
            output_path: None,
            rows: None,
            bytes: None,
        }
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
pub async fn run_once(app: &AppHandle, task: &TaskDefinition) -> TaskOutcome {
    if let TaskAction::ExportQuery { sql, .. } = &task.action {
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

    let outcome = run_action(app, &session_id, task).await;

    // 成功/失敗を問わず必ず切断する (常駐接続を増やさない)。切断自体の失敗は
    // ログに残すのみで、タスクの成否には影響させない (アクションはもう完了/
    // 失敗している)。
    let state = app.state::<AppState>();
    if let Err(e) = disconnect(session_id.clone(), state).await {
        tracing::warn!(session_id = %session_id, error = %e, "task scheduler: failed to close connection after run");
    }

    outcome
}

async fn run_action(app: &AppHandle, session_id: &str, task: &TaskDefinition) -> TaskOutcome {
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
                |_rows| {},
            )
            .await;
            match result {
                Ok((rows, bytes)) => TaskOutcome {
                    ok: true,
                    error: None,
                    output_path: Some(path),
                    rows: Some(rows as i64),
                    bytes: Some(bytes as i64),
                },
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
                },
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

    #[test]
    fn driver_kind_of_maps_known_names() {
        assert_eq!(driver_kind_of("mysql").unwrap(), DriverKind::Mysql);
        assert_eq!(driver_kind_of("postgres").unwrap(), DriverKind::Postgres);
        assert_eq!(driver_kind_of("sqlite").unwrap(), DriverKind::Sqlite);
        assert!(driver_kind_of("oracle").is_err());
    }
}
