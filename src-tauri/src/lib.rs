mod commands;
mod db;
mod error;
mod profiles;
mod ssh;
mod state;

/// Test-only re-exports. Not part of the public API; subject to change.
#[doc(hidden)]
pub mod __test_api {
    pub use crate::db::{Connection, DbConnectOptions, DriverKind};

    pub async fn connect(opts: &DbConnectOptions) -> crate::error::Result<Connection> {
        Connection::connect(opts).await
    }

    /// Naive parser for `mysql://user:password@host:port/database` used in tests.
    pub fn parse_mysql_url(url: &str) -> Option<DbConnectOptions> {
        let rest = url.strip_prefix("mysql://")?;
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
            None => (hostport.to_string(), 3306u16),
        };
        Some(DbConnectOptions {
            host,
            port,
            user,
            password,
            database,
            driver: DriverKind::Mysql,
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
            commands::connection::list_sessions,
            commands::query::run_query,
            commands::query::preview_query,
            commands::query::run_query_stream,
            commands::query::preview_query_stream,
            commands::query::cancel_stream,
            commands::schema::list_databases,
            commands::schema::list_tables,
            commands::schema::describe_table,
            commands::profiles::list_profiles,
            commands::profiles::save_profile,
            commands::profiles::delete_profile,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tableX");
}
