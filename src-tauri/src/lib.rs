mod commands;
mod db;
mod error;
mod history;
mod logs;
mod profiles;
mod snippets;
mod ssh;
mod state;

/// Test-only re-exports. Not part of the public API; subject to change.
#[doc(hidden)]
pub mod __test_api {
    pub use crate::db::data_diff::{
        compute_data_diff, generate_data_sync_sql, DataDiff, RowDiff, RowStatus,
    };
    pub use crate::db::diff::{compute_schema_diff, DiffStatus, SchemaDiff};
    pub use crate::db::sync::{generate_sync_sql, SyncKind, SyncPlan, SyncStatement};
    pub use crate::db::types::{QueryResult, Value};
    pub use crate::db::{Connection, DbConnectOptions, DriverKind};
    pub use crate::error::AppError;
    pub use crate::state::{AppState, Session};

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
            skip_history: true,
            _tunnel: None,
        }
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

    let result = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(state::AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::connection::test_connection,
            commands::connection::connect,
            commands::connection::disconnect,
            commands::query::run_query,
            commands::query::run_query_transaction,
            commands::query::run_query_stream,
            commands::query::preview_query_stream,
            commands::query::cancel_stream,
            commands::schema::list_databases,
            commands::schema::list_tables,
            commands::schema::describe_table,
            commands::schema::schema_overview,
            commands::schema::table_row_estimates,
            commands::diff::compare_schema,
            commands::diff::compare_table_data,
            commands::sync::generate_sync_sql,
            commands::sync::generate_data_sync_sql,
            commands::sync::apply_sync_sql,
            commands::profiles::list_profiles,
            commands::profiles::save_profile,
            commands::profiles::delete_profile,
            commands::snippets::list_snippets,
            commands::snippets::save_snippet,
            commands::snippets::delete_snippet,
            commands::history::list_history,
            commands::history::clear_history,
            commands::logs::read_logs,
            commands::logs::clear_logs,
            commands::export::export_query_result,
            commands::dump::dump_database,
            commands::import::parse_csv_preview,
            commands::import::import_csv,
        ])
        .run(tauri::generate_context!());

    if let Err(e) = result {
        tracing::error!(error = %e, "fatal error while running noobDB");
        panic!("error while running noobDB: {e}");
    }
}
