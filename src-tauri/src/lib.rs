mod commands;
mod db;
mod error;
mod history;
mod profiles;
mod snippets;
mod ssh;
mod state;

/// Test-only re-exports. Not part of the public API; subject to change.
#[doc(hidden)]
pub mod __test_api {
    pub use crate::db::types::Value;
    pub use crate::db::{Connection, DbConnectOptions, DriverKind};

    pub async fn connect(opts: &DbConnectOptions) -> crate::error::Result<Connection> {
        Connection::connect(opts).await
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

use tracing_subscriber::EnvFilter;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info,sqlx=warn")),
        )
        .init();

    tauri::Builder::default()
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
            commands::profiles::list_profiles,
            commands::profiles::save_profile,
            commands::profiles::delete_profile,
            commands::snippets::list_snippets,
            commands::snippets::save_snippet,
            commands::snippets::delete_snippet,
            commands::history::list_history,
            commands::history::clear_history,
            commands::export::export_query_result,
            commands::dump::dump_database,
            commands::import::parse_csv_preview,
            commands::import::import_csv,
        ])
        .run(tauri::generate_context!())
        .expect("error while running noobDB");
}
