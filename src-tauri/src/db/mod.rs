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

    /// Bulk-inserts `rows` into `table` using batched multi-row INSERT
    /// statements wrapped in a single transaction (all-or-nothing). Each cell
    /// is `Some(text)` for a value or `None` for SQL NULL; the driver coerces
    /// the text to the destination column type. `on_progress` is invoked with
    /// the cumulative inserted-row count after each batch so callers can emit
    /// streaming progress; returning `Err` from it aborts the import and rolls
    /// back. Returns the total number of rows inserted.
    pub async fn import_rows<F>(
        &self,
        database: Option<&str>,
        table: &str,
        columns: &[String],
        rows: &[Vec<Option<String>>],
        batch_size: usize,
        on_progress: F,
    ) -> Result<u64>
    where
        F: FnMut(u64) -> Result<()>,
    {
        match self {
            Connection::MySql(c) => {
                c.import_rows(database, table, columns, rows, batch_size, on_progress)
                    .await
            }
            Connection::Postgres(c) => {
                c.import_rows(database, table, columns, rows, batch_size, on_progress)
                    .await
            }
            Connection::Sqlite(c) => {
                c.import_rows(database, table, columns, rows, batch_size, on_progress)
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

/// Returns true when `sql` is shaped like a read-only statement that the
/// read-only profile gate is willing to let through.
///
/// Allow list: `SELECT` / `SHOW` / `DESCRIBE` / `DESC` / `EXPLAIN` / `WITH`.
/// Trailing semicolons and whitespace are tolerated. `SELECT ... FOR UPDATE`,
/// `FOR SHARE` and the MySQL `LOCK IN SHARE MODE` form are rejected because
/// they acquire row locks even though they syntactically begin with `SELECT`.
///
/// This is intentionally a coarse prefix check — pathological cases such as
/// `WITH ... INSERT` (a writable CTE) will still slip past. The gate is a
/// best-effort safety net, not a parser.
pub fn is_read_only_sql(sql: &str) -> bool {
    let lower = sql.to_ascii_lowercase();
    let body = lower
        .trim()
        .trim_end_matches(|c: char| c == ';' || c.is_whitespace())
        .trim_start();
    let allowed_prefix = body.starts_with("select")
        || body.starts_with("show")
        || body.starts_with("describe")
        || body.starts_with("desc ")
        || body.starts_with("explain")
        || body.starts_with("with");
    if !allowed_prefix {
        return false;
    }
    if body.ends_with("for update")
        || body.ends_with("for share")
        || body.ends_with("lock in share mode")
    {
        return false;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::is_read_only_sql;

    #[test]
    fn allows_basic_selects_and_metadata_queries() {
        assert!(is_read_only_sql("SELECT 1"));
        assert!(is_read_only_sql("  select * from t"));
        assert!(is_read_only_sql("SHOW TABLES"));
        assert!(is_read_only_sql("DESCRIBE users"));
        assert!(is_read_only_sql("DESC users"));
        assert!(is_read_only_sql("EXPLAIN SELECT 1"));
        assert!(is_read_only_sql("WITH t AS (SELECT 1) SELECT * FROM t"));
    }

    #[test]
    fn tolerates_trailing_semicolons_and_whitespace() {
        assert!(is_read_only_sql("SELECT 1;"));
        assert!(is_read_only_sql("SELECT 1 ;  \n"));
        assert!(is_read_only_sql("SELECT 1;;\n;"));
    }

    #[test]
    fn rejects_mutations_and_ddl() {
        assert!(!is_read_only_sql("INSERT INTO t VALUES (1)"));
        assert!(!is_read_only_sql("UPDATE t SET a=1"));
        assert!(!is_read_only_sql("DELETE FROM t"));
        assert!(!is_read_only_sql("REPLACE INTO t VALUES (1)"));
        assert!(!is_read_only_sql("DROP TABLE t"));
        assert!(!is_read_only_sql("ALTER TABLE t ADD COLUMN c INT"));
        assert!(!is_read_only_sql("TRUNCATE t"));
        assert!(!is_read_only_sql("CREATE TABLE t (a INT)"));
        assert!(!is_read_only_sql("CALL my_proc()"));
        assert!(!is_read_only_sql(""));
        assert!(!is_read_only_sql("   "));
    }

    #[test]
    fn rejects_locking_selects() {
        assert!(!is_read_only_sql("SELECT * FROM t FOR UPDATE"));
        assert!(!is_read_only_sql("SELECT * FROM t for update;"));
        assert!(!is_read_only_sql("SELECT * FROM t FOR SHARE"));
        assert!(!is_read_only_sql("SELECT * FROM t LOCK IN SHARE MODE"));
    }
}
