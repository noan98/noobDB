pub mod mysql;
pub mod postgres;
pub mod sqlite;
pub mod types;

use serde::{Deserialize, Serialize};

use crate::error::Result;
use types::{PreviewResult, QueryResult, StreamBatch, TableColumnInfo};

/// Plain options to address a DB endpoint. When connecting through an SSH tunnel,
/// `host`/`port` will already point to the local end of the tunnel.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DbConnectOptions {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: String,
    pub database: Option<String>,
    pub driver: DriverKind,
    /// Path to the database file for file-backed drivers (SQLite). Ignored
    /// by drivers that connect over TCP.
    #[serde(default)]
    pub file_path: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DriverKind {
    Mysql,
    Postgres,
    Sqlite,
}

/// Dispatch enum. Adding a new DB is a new variant + a new module.
pub enum Connection {
    MySql(mysql::MySqlConn),
    Postgres(postgres::PostgresConn),
    Sqlite(sqlite::SqliteConn),
}

impl Connection {
    pub async fn connect(opts: &DbConnectOptions) -> Result<Self> {
        match opts.driver {
            DriverKind::Mysql => Ok(Connection::MySql(mysql::MySqlConn::connect(opts).await?)),
            DriverKind::Postgres => Ok(Connection::Postgres(
                postgres::PostgresConn::connect(opts).await?,
            )),
            DriverKind::Sqlite => Ok(Connection::Sqlite(sqlite::SqliteConn::connect(opts).await?)),
        }
    }

    pub async fn execute(&self, sql: &str, database: Option<&str>) -> Result<QueryResult> {
        match self {
            Connection::MySql(c) => c.execute(sql, database).await,
            Connection::Postgres(c) => c.execute(sql, database).await,
            Connection::Sqlite(c) => c.execute(sql, database).await,
        }
    }

    pub async fn preview_execute(
        &self,
        sql: &str,
        database: Option<&str>,
    ) -> Result<PreviewResult> {
        match self {
            Connection::MySql(c) => c.preview_execute(sql, database).await,
            Connection::Postgres(c) => c.preview_execute(sql, database).await,
            Connection::Sqlite(c) => c.preview_execute(sql, database).await,
        }
    }

    pub async fn preview_execute_with_limit(
        &self,
        sql: &str,
        database: Option<&str>,
        row_limit: usize,
    ) -> Result<PreviewResult> {
        match self {
            Connection::MySql(c) => c.preview_execute_with_limit(sql, database, row_limit).await,
            Connection::Postgres(c) => c.preview_execute_with_limit(sql, database, row_limit).await,
            Connection::Sqlite(c) => c.preview_execute_with_limit(sql, database, row_limit).await,
        }
    }

    pub async fn execute_stream<F>(
        &self,
        sql: &str,
        database: Option<&str>,
        initial_batch: usize,
        chunk_size: usize,
        on_batch: F,
    ) -> Result<QueryResult>
    where
        F: FnMut(StreamBatch) -> Result<()>,
    {
        match self {
            Connection::MySql(c) => {
                c.execute_stream(sql, database, initial_batch, chunk_size, on_batch)
                    .await
            }
            Connection::Postgres(c) => {
                c.execute_stream(sql, database, initial_batch, chunk_size, on_batch)
                    .await
            }
            Connection::Sqlite(c) => {
                c.execute_stream(sql, database, initial_batch, chunk_size, on_batch)
                    .await
            }
        }
    }

    pub async fn databases(&self) -> Result<Vec<String>> {
        match self {
            Connection::MySql(c) => c.databases().await,
            Connection::Postgres(c) => c.databases().await,
            Connection::Sqlite(c) => c.databases().await,
        }
    }

    pub async fn tables(&self, db: &str) -> Result<Vec<String>> {
        match self {
            Connection::MySql(c) => c.tables(db).await,
            Connection::Postgres(c) => c.tables(db).await,
            Connection::Sqlite(c) => c.tables(db).await,
        }
    }

    pub async fn columns(&self, db: &str, table: &str) -> Result<Vec<TableColumnInfo>> {
        match self {
            Connection::MySql(c) => c.columns(db, table).await,
            Connection::Postgres(c) => c.columns(db, table).await,
            Connection::Sqlite(c) => c.columns(db, table).await,
        }
    }

    pub async fn close(&self) {
        match self {
            Connection::MySql(c) => c.close().await,
            Connection::Postgres(c) => c.close().await,
            Connection::Sqlite(c) => c.close().await,
        }
    }
}
