// 本体コードでの unwrap / expect / panic を段階的に禁止するクレートレベル lint。
// テストコードは src-tauri/clippy.toml の allow-*-in-tests で除外済み。
// やむを得ず残す箇所には #[allow(...)] + 根拠コメントを付けること。
#![warn(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod commands;
mod db;
mod error;
mod flight_recorder;
mod history;
mod logs;
mod profiles;
mod sandboxes;
mod snippets;
mod ssh;
mod state;
mod tasks;

/// Test-only re-exports. Not part of the public API; subject to change.
#[doc(hidden)]
pub mod __test_api {
    pub use crate::db::advisor::{
        analyze, AdvisorInput, HealthFinding, RuleId, SchemaHealthReport, Severity, SkippedRule,
        TableMeta, UnusedIndexEntry, UnusedIndexStats,
    };
    pub use crate::db::data_diff::{
        compute_data_diff, generate_data_sync_sql, DataDiff, RowDiff, RowStatus,
    };
    pub use crate::db::diff::{compute_schema_diff, ColumnDiff, DiffStatus, SchemaDiff, TableDiff};
    pub use crate::db::privileges::{
        generate_alter_password_sql, generate_create_user_sql, generate_drop_user_sql,
        generate_grant_sql, generate_revoke_sql, GrantSpec, PrivilegeFlags, UserSpec,
    };
    pub use crate::db::sync::{generate_sync_sql, SyncKind, SyncPlan, SyncStatement};
    pub use crate::db::types::{
        Column, DbUserInfo, ForeignKey, IndexInfo, LiveQuery, LocalTableMeta, PreviewResult,
        ProcessInfo, QueryResult, QueryStatsSupport, SchemaObject, ServerInfo, ServerMetrics,
        ServerVariable, StatementStat, StreamBatch, TableColumnInfo, TablePrivilegeRow,
        TableRowEstimate, TableSchema, TableSizeInfo, UserPrivileges, Value,
    };
    pub use crate::db::{
        apply_auto_limit, classify_write_kind, is_read_only_sql, is_session_init_sql, Connection,
        DbConnectOptions, DriverKind, SslMode, WriteCapture, WriteKind,
    };
    pub use crate::error::AppError;
    pub use crate::flight_recorder::undo::{build_undo_plan, UndoConflict, UndoPlan};
    pub use crate::flight_recorder::{NewWriteCapture, WriteCaptureRecord, WriteCaptureSummary};
    pub use crate::profiles::{ConnectionProfile, SshAuthMethod, SshJumpProfile, SshProfile};
    pub use crate::ssh::config_parser::{parse_proxy_jump, resolve_host, ResolvedSshHost};
    pub use crate::ssh::known_hosts::KnownHost;
    pub use crate::ssh::{SshConfig, SshJumpConfig, SshTunnel};
    pub use crate::state::{AppState, Session, StreamHandle, StreamKind};

    // zod ⇔ serde ゴールデン (#824) が代表インスタンスを組み立てるための追加の
    // レスポンス/永続化型の再エクスポート。いずれも非公開モジュール配下にあるため、
    // 内部モジュールを丸ごと public にせずここでピンポイントに公開する。
    pub use crate::commands::connection::ConnectResponse;
    pub use crate::commands::logs::LogView;
    pub use crate::commands::profiles::{ImportResult, ProfileWithSecretFlags};
    pub use crate::commands::query::CancelStreamResult;
    pub use crate::commands::sandbox::{
        filter_sandbox_data_diff, SandboxCreateResponse, SandboxSchemaDiffResult,
        SandboxTableDiffResult,
    };
    pub use crate::history::HistoryEntry;
    pub use crate::sandboxes::SandboxRecord;
    pub use crate::snippets::{Snippet, SnippetScope};

    // `commands::import::CsvPreview` はコマンドモジュール内に定義されているが、
    // フィクスチャ生成専用のため struct そのものを再公開する。
    pub use crate::commands::import::CsvPreview;

    // ローカル横断クエリ (#740) — Tauri を経由せずに統合テストから駆動できるよう、
    // 各 IPC ハンドラの `_inner` コア (State なし) を再公開する。
    pub use crate::commands::local::{
        create_local_session_inner, drop_local_table_inner, list_local_tables_inner,
        register_local_table_inner, save_local_database_inner, RegisterLocalTableRequest,
        MAX_LOCAL_TABLE_ROWS,
    };

    // ストリーミングイベントの emit ペイロード構造体 (#825)。上記と同じくフィクスチャ
    // 生成専用のピンポイント再エクスポート。`preview_query_stream` の行イベント
    // (PreviewRowsEvent) は `StreamRowsEvent` と同一シェイプのため個別公開せず、
    // フィクスチャは共有する (前者は非公開のまま)。
    pub use crate::commands::connection::ConnectPhaseEvent;
    pub use crate::commands::dump::{DumpDoneEvent, DumpErrorEvent, DumpProgressEvent};
    pub use crate::commands::export::{ExportDoneEvent, ExportErrorEvent, ExportProgressEvent};
    pub use crate::commands::import::{
        ImportDoneEvent, ImportErrorEvent, ImportProgressEvent, ImportStartedEvent, SkippedRowInfo,
    };
    pub use crate::commands::query::{
        PreviewDoneEvent, PreviewMetaEvent, StreamCancelledEvent, StreamColumnsEvent,
        StreamDoneEvent, StreamErrorEvent, StreamRowsEvent,
    };

    pub async fn connect(opts: &DbConnectOptions) -> crate::error::Result<Connection> {
        Connection::connect(opts).await
    }

    /// Builds a [`Session`] around a live connection for integration tests, so
    /// they can register it in an [`AppState`] and drive the real query
    /// commands. `skip_history` is forced on to keep tests from touching the
    /// on-disk history database.
    pub fn make_session(
        id: &str,
        conn: Connection,
        opts: DbConnectOptions,
        read_only: bool,
    ) -> Session {
        Session {
            id: id.to_string(),
            profile_id: None,
            conn,
            connect_options: opts,
            read_only,
            emergency_write: std::sync::atomic::AtomicBool::new(false),
            skip_history: true,
            reconnect_ssh: None,
            _tunnel: None,
            local_temp_file: None,
        }
    }

    /// Drives the `set_emergency_mode` IPC command's core path (session lookup
    /// + read-only precondition + flag flip) without a Tauri runtime.
    pub async fn set_emergency_mode_via_command(
        state: &AppState,
        session_id: &str,
        enabled: bool,
    ) -> crate::error::Result<()> {
        crate::commands::query::set_emergency_mode_inner(state, session_id, enabled).await
    }

    /// Drives the `reconnect` IPC command's core path (session lookup + in-place
    /// transport rebuild + same-id swap) without a Tauri runtime (#712).
    pub async fn reconnect_via_command(
        state: &AppState,
        session_id: &str,
    ) -> crate::error::Result<()> {
        crate::commands::connection::reconnect_inner(state, session_id).await
    }

    /// Drives the `run_query` IPC command's core path (session lookup +
    /// read-only guard + execute) without a Tauri runtime.
    pub async fn run_query_via_command(
        state: &AppState,
        session_id: &str,
        sql: &str,
        database: Option<&str>,
    ) -> crate::error::Result<QueryResult> {
        crate::commands::query::run_query_inner(state, session_id, sql, database).await
    }

    /// Drives the `run_query_transaction` IPC command's core path, exercising
    /// the per-statement read-only guard.
    pub async fn run_query_transaction_via_command(
        state: &AppState,
        session_id: &str,
        statements: Vec<String>,
        database: Option<&str>,
    ) -> crate::error::Result<QueryResult> {
        crate::commands::query::run_query_transaction_inner(
            state,
            session_id.to_string(),
            statements,
            database.map(str::to_string),
        )
        .await
    }

    /// The read-only guard the `import_csv` IPC command applies before any CSV
    /// rows reach the driver.
    pub fn ensure_import_writable(session: &Session) -> crate::error::Result<()> {
        crate::commands::import::ensure_import_writable(session)
    }

    /// Drives the captured-write core path (session lookup + read-only guard +
    /// capture + history recording) without a Tauri runtime (#735). Production
    /// reaches the same core through `run_query_stream({ capture: true })`
    /// (#907 removed the unused non-streaming IPC command).
    pub async fn run_captured_write_via_command(
        state: &AppState,
        session_id: &str,
        sql: &str,
        database: Option<&str>,
        row_cap: Option<u32>,
        retention_days: Option<u32>,
    ) -> crate::error::Result<crate::commands::flight_recorder::CapturedWriteResponse> {
        crate::commands::flight_recorder::run_captured_write_inner(
            state,
            session_id.to_string(),
            sql.to_string(),
            database.map(str::to_string),
            row_cap,
            retention_days,
        )
        .await
    }

    /// Drives the `undo_flight_record` IPC command's core path without a
    /// Tauri runtime (#735).
    pub async fn undo_flight_record_via_command(
        state: &AppState,
        session_id: &str,
        id: i64,
        force: bool,
    ) -> crate::error::Result<crate::commands::flight_recorder::UndoOutcome> {
        crate::commands::flight_recorder::undo_flight_record_inner(
            state,
            session_id.to_string(),
            id,
            force,
        )
        .await
    }

    /// Drives the `preview_undo` IPC command's core path without a Tauri
    /// runtime (#735).
    pub async fn preview_undo_via_command(
        state: &AppState,
        session_id: &str,
        id: i64,
    ) -> crate::error::Result<crate::commands::flight_recorder::UndoPreviewResponse> {
        let (plan, _record) =
            crate::commands::flight_recorder::plan_undo(state, session_id, id, false).await?;
        Ok(crate::commands::flight_recorder::UndoPreviewResponse {
            statements: plan.statements,
            conflicts: plan.conflicts,
            warnings: plan.warnings,
        })
    }

    /// Lists flight-recorder captures directly against the store, for tests
    /// that need to find a capture's id after `run_captured_write_via_command`.
    pub async fn list_flight_records_for_tests(
        profile_id: Option<&str>,
    ) -> crate::error::Result<Vec<crate::flight_recorder::WriteCaptureSummary>> {
        crate::flight_recorder::store::list(profile_id, 100).await
    }

    /// Drives the `kill_process` IPC command's core path (session lookup +
    /// read-only guard + driver kill) without a Tauri runtime.
    pub async fn kill_process_via_command(
        state: &AppState,
        session_id: &str,
        process_id: i64,
    ) -> crate::error::Result<()> {
        crate::commands::process::kill_process_inner(state, session_id, process_id).await
    }

    /// Drives the full schema-comparison path (`commands::diff`) without Tauri:
    /// collects both sides' table / column metadata from live connections and
    /// runs the pure diff. Lets integration tests verify real introspection
    /// feeds the diff correctly, not just the pure function in isolation.
    pub async fn compare_schemas(
        source: &Connection,
        source_db: &str,
        target: &Connection,
        target_db: &str,
    ) -> crate::error::Result<SchemaDiff> {
        let s = crate::commands::diff::collect_table_columns(source, source_db).await?;
        let t = crate::commands::diff::collect_table_columns(target, target_db).await?;
        Ok(compute_schema_diff(
            source.driver_kind(),
            target.driver_kind(),
            &s,
            &t,
        ))
    }

    /// Drives the `apply_sync_sql` IPC command's core path (session lookup +
    /// read-only guard + empty-statement guard + transactional apply) without a
    /// Tauri runtime, so integration tests can verify the destructive-write
    /// guards actually fire on the command layer (not just the pure generator).
    pub async fn apply_sync_sql_via_command(
        state: &AppState,
        session_id: &str,
        database: Option<&str>,
        statements: Vec<String>,
    ) -> crate::error::Result<u64> {
        crate::commands::sync::apply_sync_sql_inner(
            state,
            session_id.to_string(),
            database.map(str::to_string),
            statements,
        )
        .await
    }

    /// Drives the `apply_privilege_sql` IPC command's core path (session
    /// lookup + read-only guard + empty-statement guard + transactional
    /// apply) without a Tauri runtime, mirroring
    /// [`apply_sync_sql_via_command`].
    pub async fn apply_privilege_sql_via_command(
        state: &AppState,
        session_id: &str,
        database: Option<&str>,
        statements: Vec<String>,
    ) -> crate::error::Result<u64> {
        crate::commands::privileges::apply_privilege_sql_inner(
            state,
            session_id.to_string(),
            database.map(str::to_string),
            statements,
        )
        .await
    }

    /// Drives the `create_sandbox` IPC command's core path without a Tauri
    /// runtime (#747).
    #[allow(clippy::too_many_arguments)]
    pub async fn create_sandbox_via_command(
        state: &AppState,
        source_session_id: &str,
        source_database: Option<&str>,
        name: &str,
        tables: Vec<String>,
        include_related: bool,
        row_limit: Option<u64>,
    ) -> crate::error::Result<SandboxCreateResponse> {
        crate::commands::sandbox::create_sandbox_inner(
            state,
            source_session_id.to_string(),
            source_database.map(str::to_string),
            name.to_string(),
            tables,
            include_related,
            row_limit,
        )
        .await
    }

    /// Drives the `discard_sandbox` IPC command's core path without a Tauri
    /// runtime (#747).
    pub async fn discard_sandbox_via_command(
        state: &AppState,
        sandbox_id: &str,
        session_id: Option<&str>,
    ) -> crate::error::Result<()> {
        crate::commands::sandbox::discard_sandbox_inner(
            state,
            sandbox_id.to_string(),
            session_id.map(str::to_string),
        )
        .await
    }

    /// Drives the `sandbox_table_diff` IPC command's core path without a
    /// Tauri runtime (#747).
    #[allow(clippy::too_many_arguments)]
    pub async fn sandbox_table_diff_via_command(
        state: &AppState,
        sandbox_id: &str,
        sandbox_session_id: &str,
        table: &str,
        source_session_id: Option<&str>,
        limit: Option<usize>,
    ) -> crate::error::Result<SandboxTableDiffResult> {
        crate::commands::sandbox::sandbox_table_diff_inner(
            state,
            sandbox_id.to_string(),
            sandbox_session_id.to_string(),
            table.to_string(),
            source_session_id.map(str::to_string),
            limit,
        )
        .await
    }

    /// Drives the `sandbox_schema_diff` IPC command's core path without a
    /// Tauri runtime (#747).
    pub async fn sandbox_schema_diff_via_command(
        state: &AppState,
        sandbox_id: &str,
        sandbox_session_id: &str,
        source_session_id: Option<&str>,
    ) -> crate::error::Result<SandboxSchemaDiffResult> {
        crate::commands::sandbox::sandbox_schema_diff_inner(
            state,
            sandbox_id.to_string(),
            sandbox_session_id.to_string(),
            source_session_id.map(str::to_string),
        )
        .await
    }

    /// Drives the `sandbox_advance_base` IPC command's core path without a
    /// Tauri runtime (#747).
    pub async fn sandbox_advance_base_via_command(
        state: &AppState,
        sandbox_id: &str,
        sandbox_session_id: &str,
        table: &str,
        applied: DataDiff,
        allow_delete: bool,
    ) -> crate::error::Result<()> {
        crate::commands::sandbox::sandbox_advance_base_inner(
            state,
            sandbox_id.to_string(),
            sandbox_session_id.to_string(),
            table.to_string(),
            applied,
            allow_delete,
        )
        .await
    }

    /// Lists every sandbox's non-secret metadata (`list_sandboxes` IPC's core;
    /// already Tauri-free so this just re-exports it for test symmetry).
    pub fn list_sandboxes_via_command() -> crate::error::Result<Vec<SandboxRecord>> {
        crate::commands::sandbox::list_sandboxes()
    }

    /// Drives the schema-health advisor's full command path
    /// (`commands::advisor`) without Tauri: collects table / column / index /
    /// foreign-key metadata and unused-index stats from a live connection and
    /// runs the pure rule engine. Lets integration tests verify real
    /// introspection feeds the advisor correctly.
    pub async fn analyze_schema_health(
        conn: &Connection,
        database: &str,
    ) -> crate::error::Result<SchemaHealthReport> {
        crate::commands::advisor::collect_and_analyze(conn, database).await
    }

    /// Runs `sql` against MySQL via the text protocol, for statements the
    /// prepared-statement protocol rejects (e.g. CREATE/DROP PROCEDURE).
    pub async fn mysql_exec_text(opts: &DbConnectOptions, sql: &str) -> crate::error::Result<()> {
        crate::db::mysql::exec_text_protocol(opts, sql).await
    }

    /// Naive parser for `mysql://user:password@host:port/database` used in tests.
    pub fn parse_mysql_url(url: &str) -> Option<DbConnectOptions> {
        parse_tcp_url(url, "mysql://", 3306, DriverKind::Mysql)
    }

    /// Naive parser for `postgres://user:password@host:port/database`.
    pub fn parse_postgres_url(url: &str) -> Option<DbConnectOptions> {
        parse_tcp_url(url, "postgres://", 5432, DriverKind::Postgres)
            .or_else(|| parse_tcp_url(url, "postgresql://", 5432, DriverKind::Postgres))
    }

    /// Naive parser for `mssql://user:password@host:port/database` used in
    /// tests (#729).
    pub fn parse_mssql_url(url: &str) -> Option<DbConnectOptions> {
        parse_tcp_url(url, "mssql://", 1433, DriverKind::Mssql)
    }

    /// Build SQLite connect options from a filesystem path.
    pub fn sqlite_options(path: &str) -> DbConnectOptions {
        DbConnectOptions {
            host: String::new(),
            port: 0,
            user: String::new(),
            password: String::new(),
            database: None,
            driver: DriverKind::Sqlite,
            file_path: Some(path.to_string()),
            ssl_mode: None,
            ssl_root_cert: None,
            ssl_client_cert: None,
            ssl_client_key: None,
            init_sql: None,
        }
    }

    /// Build DuckDB connect options from a filesystem path (#709).
    pub fn duckdb_options(path: &str) -> DbConnectOptions {
        DbConnectOptions {
            host: String::new(),
            port: 0,
            user: String::new(),
            password: String::new(),
            database: None,
            driver: DriverKind::DuckDb,
            file_path: Some(path.to_string()),
            ssl_mode: None,
            ssl_root_cert: None,
            ssl_client_cert: None,
            ssl_client_key: None,
            init_sql: None,
        }
    }

    fn parse_tcp_url(
        url: &str,
        scheme: &str,
        default_port: u16,
        driver: DriverKind,
    ) -> Option<DbConnectOptions> {
        let rest = url.strip_prefix(scheme)?;
        let (creds, hostpart) = rest.split_once('@')?;
        let (user, password) = match creds.split_once(':') {
            Some((u, p)) => (u.to_string(), p.to_string()),
            None => (creds.to_string(), String::new()),
        };
        let (hostport, database) = match hostpart.split_once('/') {
            Some((hp, d)) => (
                hp,
                if d.is_empty() {
                    None
                } else {
                    Some(d.to_string())
                },
            ),
            None => (hostpart, None),
        };
        let (host, port) = match hostport.split_once(':') {
            Some((h, p)) => (h.to_string(), p.parse().ok()?),
            None => (hostport.to_string(), default_port),
        };
        Some(DbConnectOptions {
            host,
            port,
            user,
            password,
            database,
            driver,
            file_path: None,
            ssl_mode: None,
            ssl_root_cert: None,
            ssl_client_cert: None,
            ssl_client_key: None,
            init_sql: None,
        })
    }
}

use tracing_subscriber::{fmt, prelude::*, EnvFilter};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let filter =
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info,sqlx=warn"));

    // Tee events to stdout (terminal during `tauri dev`) and to a size-capped
    // file under the data dir that the Settings log viewer reads. The file layer
    // is dropped when no data dir is available, leaving stdout-only logging.
    let file_layer = logs::init().map(|writer| fmt::layer().with_ansi(false).with_writer(writer));
    tracing_subscriber::registry()
        .with(filter)
        .with(fmt::layer().with_writer(std::io::stdout))
        .with(file_layer)
        .init();

    tracing::info!(version = env!("CARGO_PKG_VERSION"), "noobDB starting");

    // ローカル横断クエリ (#740) の一時 DB は前回起動のセッション寿命に紐づくため、
    // 新しいプロセスの起動時点で前回分は必ず無効 — 異常終了で残った分をここで掃除する。
    commands::local::cleanup_stale_local_files();

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // 長時間クエリ完了時の OS デスクトップ通知 (#707)。フロントは
        // @tauri-apps/plugin-notification の JS API を直接呼ぶため、追加の
        // Tauri コマンド登録は不要 (capabilities に notification:default のみ追加)。
        .plugin(tauri_plugin_notification::init());

    // アプリ内自動更新 (#705)。updater / process はデスクトップ専用プラグインなので
    // desktop ターゲットのときだけ登録する (モバイル対応時にビルドが壊れないよう
    // Tauri 公式テンプレートと同じ cfg ガードを踏襲)。更新の検出/ダウンロード/適用は
    // フロント (`updater.ts`) が JS API で駆動し、ユーザ承認時のみ再起動する。
    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_process::init());
    }

    let result = builder
        .manage(state::AppState::default())
        // タスクスケジューラ (#730)。アプリ起動中のみ発火するバックグラウンド
        // Tokio タスクとして常駐する。状態は tasks.json / task_runs.sqlite の
        // ディスク上のみに持つため、AppState への追加は不要。
        .setup(|app| {
            tasks::scheduler::spawn(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::connection::test_connection,
            commands::connection::connect,
            commands::connection::cancel_connect,
            commands::connection::disconnect,
            commands::connection::reconnect,
            commands::connection::ping_session,
            commands::ssh::list_known_hosts,
            commands::ssh::forget_host_key,
            commands::ssh::trust_host_key,
            commands::ssh::resolve_ssh_config_host,
            commands::query::run_query,
            commands::query::run_query_transaction,
            commands::query::begin_transaction,
            commands::query::run_in_transaction,
            commands::query::finish_transaction,
            commands::query::run_query_stream,
            commands::query::set_emergency_mode,
            commands::query::preview_query_stream,
            commands::query::cancel_stream,
            commands::schema::list_databases,
            commands::schema::list_tables,
            commands::schema::describe_table,
            commands::schema::schema_overview,
            commands::schema::foreign_keys,
            commands::schema::list_indexes,
            commands::schema::list_schema_objects,
            commands::schema::get_object_definition,
            commands::schema::table_row_estimates,
            commands::schema::table_sizes,
            commands::server::server_info,
            commands::server::server_metrics,
            commands::process::list_processes,
            commands::process::kill_process,
            commands::privileges::list_db_users,
            commands::privileges::list_user_privileges,
            commands::privileges::generate_create_user_sql,
            commands::privileges::generate_drop_user_sql,
            commands::privileges::generate_alter_password_sql,
            commands::privileges::generate_grant_sql,
            commands::privileges::generate_revoke_sql,
            commands::privileges::apply_privilege_sql,
            commands::inspector::query_stats_support,
            commands::inspector::sample_live_queries,
            commands::inspector::sample_statement_stats,
            commands::advisor::analyze_schema_health,
            commands::diff::compare_schema,
            commands::diff::compare_table_data,
            commands::diff::diff_schema_snapshots,
            commands::sync::generate_sync_sql,
            commands::sync::generate_data_sync_sql,
            commands::sync::apply_sync_sql,
            commands::sandbox::create_sandbox,
            commands::sandbox::list_sandboxes,
            commands::sandbox::discard_sandbox,
            commands::sandbox::sandbox_table_diff,
            commands::sandbox::sandbox_schema_diff,
            commands::sandbox::filter_sandbox_data_diff,
            commands::sandbox::sandbox_advance_base,
            commands::profiles::list_profiles,
            commands::profiles::reveal_profile_secret,
            commands::profiles::save_profile,
            commands::profiles::delete_profile,
            commands::profiles::reorder_profiles,
            commands::profiles::export_profiles,
            commands::profiles::import_profiles,
            commands::snippets::list_snippets,
            commands::snippets::save_snippet,
            commands::snippets::delete_snippet,
            commands::history::list_history,
            commands::history::clear_history,
            commands::flight_recorder::list_flight_records,
            commands::flight_recorder::clear_flight_records,
            commands::flight_recorder::preview_undo,
            commands::flight_recorder::undo_flight_record,
            commands::logs::read_logs,
            commands::logs::clear_logs,
            commands::export::export_query_result,
            commands::export::export_query_stream,
            commands::dump::dump_database,
            commands::import::parse_csv_preview,
            commands::import::import_csv,
            commands::file::read_text_file,
            commands::file::write_binary_file,
            commands::local::create_local_session,
            commands::local::register_local_table,
            commands::local::list_local_tables,
            commands::local::drop_local_table,
            commands::local::save_local_database,
            commands::tasks::list_tasks,
            commands::tasks::save_task,
            commands::tasks::delete_task,
            commands::tasks::set_task_enabled,
            commands::tasks::run_task_now,
            commands::tasks::list_task_runs,
            commands::tasks::clear_task_runs,
            commands::tasks::get_scheduler_settings,
            commands::tasks::set_scheduler_settings,
        ])
        .run(tauri::generate_context!());

    if let Err(e) = result {
        tracing::error!(error = %e, "fatal error while running noobDB");
        // Tauri のイベントループ自体が起動失敗した場合はプロセスを即終了する以外に
        // 回復手段がない。ここでの panic は意図的であり、OS のクラッシュレポートに
        // 原因を残すためにも panic が最適な選択肢となる。
        #[allow(clippy::panic)]
        {
            panic!("error while running noobDB: {e}");
        }
    }
}
