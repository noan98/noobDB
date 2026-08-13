//! Microsoft SQL Server driver (#729).
//!
//! Unlike the other three drivers, this one is **not** built on `sqlx`
//! (which has no MSSQL backend) but on `tiberius`, a native async TDS client.
//! Consequently:
//!
//! * Errors come back as `tiberius::error::Error`, wrapped in the dedicated
//!   `AppError::Mssql` variant (see `error.rs`) rather than `AppError::Sqlx`.
//! * There is no `sqlx::Pool` to reuse, so this module hand-rolls a tiny
//!   connection pool (see [`MssqlPool`] below) instead of pulling in an extra
//!   pooling crate.
//! * Metadata introspection is scoped to the `dbo` schema. SQL Server allows
//!   arbitrary schemas per database (unlike the single-schema-per-connection
//!   model MySQL/PostgreSQL/SQLite fit into), and fully supporting that would
//!   ripple into every identifier this app generates (sync/export/import all
//!   assume a bare, single-part table name). This is a deliberate scope
//!   reduction for the initial driver (documented in the PR); multi-schema
//!   browsing can be layered on later without changing the wire format.
//! * A handful of newer observability features (`server_metrics`,
//!   `query_stats_support` / `live_queries` / `statement_stats`,
//!   `unused_indexes`) are not implemented yet and return the same
//!   "unsupported" shape SQLite uses for them — they are not part of this
//!   issue's acceptance criteria and SQL Server *could* support all of them
//!   (via `sys.dm_exec_*` / missing-index DMVs) in a follow-up.
//! * Client-certificate (mTLS) authentication is not exposed by `tiberius`'s
//!   `Config` API, so `ssl_client_cert` / `ssl_client_key` are ignored for
//!   this driver (server-cert verification via `ssl_root_cert` still works).

use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Instant;

use futures_util::StreamExt;
use tiberius::{AuthMethod, Client, ColumnType, Config, EncryptionLevel, QueryItem, Row as TdsRow};
use tokio::net::TcpStream;
use tokio::sync::{Mutex as AsyncMutex, OwnedSemaphorePermit, Semaphore};
use tokio_util::compat::{Compat, TokioAsyncWriteCompatExt};

use super::advisor::UnusedIndexStats;
use super::types::{
    Column, DbUserInfo, ForeignKey, IndexInfo, LiveQuery, PreviewResult, ProcessInfo, QueryResult,
    QueryStatsSupport, SchemaObject, ServerInfo, ServerMetrics, ServerVariable, StatementStat,
    StreamBatch, TableColumnInfo, TableRowEstimate, TableRowIdentity, TableSchema, TableSizeInfo,
    UserPrivileges, Value,
};
use super::{DbConnectOptions, SslMode};
use crate::error::{AppError, Result};

type MssqlClient = Client<Compat<TcpStream>>;

/// A tiny hand-rolled async connection pool (no extra pooling crate — see the
/// module doc comment). `idle` is a plain `std::sync::Mutex` (never held
/// across an `.await`) rather than a `tokio::sync::Mutex`, which lets
/// [`PooledConn`]'s `Drop` return a connection synchronously without needing
/// an async-drop workaround.
struct MssqlPoolInner {
    config: Config,
    idle: StdMutex<Vec<MssqlClient>>,
    sem: Arc<Semaphore>,
}

#[derive(Clone)]
struct MssqlPool(Arc<MssqlPoolInner>);

impl MssqlPool {
    /// Builds the pool and eagerly opens + validates one connection (parity
    /// with sqlx's `PoolOptions::connect_with`, which does the same so a bad
    /// host/credential surfaces at `connect()` time, not on the first query).
    async fn connect(opts: &DbConnectOptions, max_size: usize) -> Result<Self> {
        let config = build_config(opts)?;
        let inner = Arc::new(MssqlPoolInner {
            config,
            idle: StdMutex::new(Vec::new()),
            sem: Arc::new(Semaphore::new(max_size.max(1))),
        });
        let pool = Self(inner);
        let client = pool.open_new().await?;
        if let Ok(mut idle) = pool.0.idle.lock() {
            idle.push(client);
        }
        Ok(pool)
    }

    async fn open_new(&self) -> Result<MssqlClient> {
        let tcp = TcpStream::connect(self.0.config.get_addr())
            .await
            .map_err(AppError::Io)?;
        // Best-effort; a failure here (unsupported platform/socket state)
        // doesn't invalidate the connection, just its Nagle-disabling.
        let _ = tcp.set_nodelay(true);
        let client = Client::connect(self.0.config.clone(), tcp.compat_write()).await?;
        Ok(client)
    }

    async fn acquire(&self) -> Result<PooledConn> {
        let permit = self
            .0
            .sem
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| AppError::Other("mssql connection pool is closed".into()))?;
        let existing = self.0.idle.lock().ok().and_then(|mut idle| idle.pop());
        let client = match existing {
            Some(c) => c,
            None => self.open_new().await?,
        };
        Ok(PooledConn {
            pool: self.0.clone(),
            client: Some(client),
            discard: AtomicBool::new(false),
            _permit: permit,
        })
    }

    async fn close(&self) {
        // Nothing to flush server-side; dropping the idle clients closes
        // their TCP sockets. Blocks new acquisitions from succeeding in a
        // meaningful way is unnecessary since the `Session` holding this pool
        // is being torn down right after this call.
        if let Ok(mut idle) = self.0.idle.lock() {
            idle.clear();
        }
    }
}

/// One checked-out connection. Returns itself to the pool's idle list on
/// `Drop` unless [`PooledConn::mark_discard`] was called (used when a
/// connection is left in an unknown state, e.g. a `COMMIT`/`ROLLBACK` itself
/// failed — mirrors `PoolConnection::detach()` on the sqlx-backed drivers).
struct PooledConn {
    pool: Arc<MssqlPoolInner>,
    client: Option<MssqlClient>,
    discard: AtomicBool,
    _permit: OwnedSemaphorePermit,
}

impl PooledConn {
    /// Borrows the underlying client. Only `None` after this connection has
    /// already been returned/dropped, which never happens while a
    /// `PooledConn` value is still reachable — but this returns `Result`
    /// instead of unwrapping so a logic bug fails as a normal `AppError`
    /// rather than a panic (repository policy: no `unwrap`/`expect`/`panic`
    /// in non-test code).
    fn client_mut(&mut self) -> Result<&mut MssqlClient> {
        self.client
            .as_mut()
            .ok_or_else(|| AppError::Other("mssql pooled connection already released".into()))
    }

    fn mark_discard(&self) {
        self.discard.store(true, AtomicOrdering::Relaxed);
    }
}

impl Drop for PooledConn {
    fn drop(&mut self) {
        if self.discard.load(AtomicOrdering::Relaxed) {
            return;
        }
        if let Some(c) = self.client.take() {
            if let Ok(mut idle) = self.pool.idle.lock() {
                idle.push(c);
            }
        }
    }
}

/// Issues `BEGIN TRANSACTION`, discarding `conn` from the pool if it fails
/// (an unknown transactional state must never be handed back to the pool).
async fn begin_tx(conn: &mut PooledConn) -> Result<()> {
    let client = conn.client_mut()?;
    if let Err(e) = client.execute("BEGIN TRANSACTION", &[]).await {
        conn.mark_discard();
        return Err(e.into());
    }
    Ok(())
}

/// Issues `stmt` (`COMMIT TRANSACTION` / `ROLLBACK TRANSACTION`) to end a
/// transaction, discarding `conn` from the pool if *that itself* fails — a
/// connection must never be returned to the pool with a transaction still
/// open on it.
async fn finish_tx(conn: &mut PooledConn, stmt: &str) -> Result<()> {
    let client = conn.client_mut()?;
    match client.execute(stmt, &[]).await {
        Ok(_) => Ok(()),
        Err(e) => {
            conn.mark_discard();
            Err(e.into())
        }
    }
}

pub struct MssqlConn {
    pool: MssqlPool,
    /// 明示トランザクションで確保した専用接続。BEGIN〜COMMIT/ROLLBACK の間、
    /// すべての文をこの 1 本で実行して同一トランザクションに乗せる (他の 3
    /// ドライバと同じ方式)。
    tx: AsyncMutex<Option<PooledConn>>,
}

impl MssqlConn {
    pub async fn connect(opts: &DbConnectOptions) -> Result<Self> {
        let pool = MssqlPool::connect(opts, 5).await.map_err(|e| {
            tracing::error!(
                host = %opts.host,
                port = opts.port,
                user = %opts.user,
                error = %e,
                "mssql: failed to create connection pool"
            );
            e
        })?;
        Ok(Self {
            pool,
            tx: AsyncMutex::new(None),
        })
    }

    pub async fn close(&self) {
        self.pool.close().await;
    }

    pub async fn execute(&self, sql: &str, database: Option<&str>) -> Result<QueryResult> {
        let mut conn = self.pool.acquire().await?;
        let client = conn.client_mut()?;
        apply_use_database(client, database).await?;
        run_sql_on(client, sql).await
    }

    // ── 明示トランザクション ──

    pub async fn tx_begin(&self, database: Option<&str>) -> Result<()> {
        let mut guard = self.tx.lock().await;
        if guard.is_some() {
            return Err(AppError::InvalidInput(
                "a transaction is already active".into(),
            ));
        }
        let mut conn = self.pool.acquire().await?;
        {
            let client = conn.client_mut()?;
            apply_use_database(client, database).await?;
        }
        begin_tx(&mut conn).await?;
        *guard = Some(conn);
        Ok(())
    }

    pub async fn tx_execute(&self, sql: &str) -> Result<QueryResult> {
        let mut guard = self.tx.lock().await;
        let conn = guard
            .as_mut()
            .ok_or_else(|| AppError::InvalidInput("no active transaction".into()))?;
        let client = conn.client_mut()?;
        run_sql_on(client, sql).await
    }

    pub async fn tx_finish(&self, commit: bool) -> Result<()> {
        let mut guard = self.tx.lock().await;
        let mut conn = guard
            .take()
            .ok_or_else(|| AppError::InvalidInput("no active transaction".into()))?;
        if commit {
            if let Err(e) = finish_tx(&mut conn, "COMMIT TRANSACTION").await {
                // COMMIT 自体が失敗した接続は不定状態のため、ベストエフォートで
                // ROLLBACK を試みてからプールに返さない (他ドライバと同方針)。
                let _ = finish_tx(&mut conn, "ROLLBACK TRANSACTION").await;
                return Err(e);
            }
            Ok(())
        } else {
            finish_tx(&mut conn, "ROLLBACK TRANSACTION").await
        }
    }

    pub async fn tx_active(&self) -> bool {
        self.tx.lock().await.is_some()
    }

    pub async fn execute_stream<F>(
        &self,
        sql: &str,
        database: Option<&str>,
        initial_batch: usize,
        chunk_size: usize,
        mut on_batch: F,
    ) -> Result<QueryResult>
    where
        F: FnMut(StreamBatch) -> Result<()>,
    {
        let started = Instant::now();
        let mut conn = self.pool.acquire().await?;
        let client = conn.client_mut()?;
        apply_use_database(client, database).await?;

        if !is_query_shape(sql) {
            let result = client.execute(sql, &[]).await?;
            return Ok(QueryResult::empty(
                result.total(),
                started.elapsed().as_millis() as u64,
            ));
        }

        let initial = initial_batch.max(1);
        let chunk = chunk_size.max(1);
        let mut stream = client.query(sql, &[]).await?;
        let mut columns: Vec<Column> = Vec::new();
        let mut columns_emitted = false;
        let mut buffer: Vec<Vec<Value>> = Vec::new();
        let mut total: usize = 0;
        let mut target = initial;

        // Only the first result set is streamed (matching `run_sql_on`'s use
        // of `into_first_result`, and MySQL/PostgreSQL's single-statement
        // `fetch`), identified by `result_index() == 0`.
        while let Some(item) = stream.next().await {
            match item? {
                QueryItem::Metadata(meta) => {
                    if meta.result_index() == 0 && !columns_emitted {
                        columns = columns_of_meta(meta.columns());
                        on_batch(StreamBatch::Columns(columns.clone()))?;
                        columns_emitted = true;
                    }
                }
                QueryItem::Row(row) => {
                    if row.result_index() != 0 {
                        continue;
                    }
                    buffer.push(row_to_values(&row));
                    if buffer.len() >= target {
                        total += buffer.len();
                        let batch = std::mem::take(&mut buffer);
                        on_batch(StreamBatch::Rows(batch))?;
                        target = chunk;
                    }
                }
            }
        }
        if !buffer.is_empty() {
            total += buffer.len();
            on_batch(StreamBatch::Rows(std::mem::take(&mut buffer)))?;
        }
        if !columns_emitted {
            on_batch(StreamBatch::Columns(columns.clone()))?;
        }

        Ok(QueryResult {
            columns,
            rows: Vec::new(),
            rows_affected: total as u64,
            elapsed_ms: started.elapsed().as_millis() as u64,
        })
    }

    pub async fn preview_execute_with_limit(
        &self,
        sql: &str,
        database: Option<&str>,
        row_limit: usize,
    ) -> Result<PreviewResult> {
        let row_limit = row_limit.max(1);
        let trimmed = sql.trim_start().to_ascii_lowercase();
        let is_mutation = trimmed.starts_with("insert")
            || trimmed.starts_with("update")
            || trimmed.starts_with("delete");
        if !is_mutation {
            return Err(AppError::InvalidInput(
                "preview only supports INSERT/UPDATE/DELETE statements".into(),
            ));
        }
        if super::has_stacked_statements(sql) {
            return Err(AppError::InvalidInput(
                "preview does not support multiple statements".into(),
            ));
        }

        let target = extract_target_table(sql);
        let mut conn = self.pool.acquire().await?;
        {
            let client = conn.client_mut()?;
            apply_use_database(client, database).await?;
        }
        let primary_key = match target.as_deref() {
            Some(t) => {
                let client = conn.client_mut()?;
                fetch_primary_key(client, t).await.unwrap_or_default()
            }
            None => Vec::new(),
        };
        let before_sql = target.as_ref().map(|t| {
            let order = super::pk_order_clause(&primary_key, qi);
            format!("SELECT TOP ({}) * FROM {t}{order}", row_limit + 1)
        });

        begin_tx(&mut conn).await?;
        let started = Instant::now();

        let before_raw = match fetch_rows(&mut conn, before_sql.as_deref()).await {
            Ok(r) => r,
            Err(e) => {
                let _ = finish_tx(&mut conn, "ROLLBACK TRANSACTION").await;
                return Err(e);
            }
        };

        let exec_result = {
            let client = conn.client_mut()?;
            client.execute(sql, &[]).await
        };
        let rows_affected = match exec_result {
            Ok(r) => r.total(),
            Err(e) => {
                let _ = finish_tx(&mut conn, "ROLLBACK TRANSACTION").await;
                return Err(e.into());
            }
        };

        let after_raw = match fetch_rows(&mut conn, before_sql.as_deref()).await {
            Ok(r) => r,
            Err(e) => {
                let _ = finish_tx(&mut conn, "ROLLBACK TRANSACTION").await;
                return Err(e);
            }
        };

        let elapsed_ms = started.elapsed().as_millis() as u64;
        finish_tx(&mut conn, "ROLLBACK TRANSACTION").await?;

        let truncated = before_raw.len() > row_limit || after_raw.len() > row_limit;
        let columns = if !before_raw.is_empty() {
            columns_of_rows(&before_raw)
        } else {
            columns_of_rows(&after_raw)
        };
        let before_rows: Vec<Vec<Value>> = before_raw
            .iter()
            .take(row_limit)
            .map(row_to_values)
            .collect();
        let after_rows: Vec<Vec<Value>> = after_raw
            .iter()
            .take(row_limit)
            .map(row_to_values)
            .collect();

        Ok(PreviewResult {
            target_table: target,
            columns,
            primary_key,
            before_rows,
            after_rows,
            rows_affected,
            elapsed_ms,
            truncated,
        })
    }

    /// Bulk INSERT wrapped in one transaction, splicing values as string
    /// literals (like the PostgreSQL driver) rather than binding them so SQL
    /// Server's implicit conversion coerces text into the destination
    /// column's real type.
    pub async fn import_rows<F>(
        &self,
        database: Option<&str>,
        table: &str,
        columns: &[String],
        rows: &[Vec<Option<String>>],
        batch_size: usize,
        mut on_progress: F,
    ) -> Result<u64>
    where
        F: FnMut(u64) -> Result<()>,
    {
        if columns.is_empty() {
            return Err(AppError::InvalidInput("no columns to import".into()));
        }
        if rows.is_empty() {
            return Ok(0);
        }
        let ncols = columns.len();
        let cols_sql = columns.iter().map(|c| qi(c)).collect::<Vec<_>>().join(", ");
        let table_ident = qi(table);
        let batch = batch_size.clamp(1, 1000);

        let mut conn = self.pool.acquire().await?;
        {
            let client = conn.client_mut()?;
            apply_use_database(client, database).await?;
        }
        begin_tx(&mut conn).await?;
        let mut inserted: u64 = 0;
        for chunk in rows.chunks(batch) {
            let sql = build_multi_row_insert(&table_ident, &cols_sql, ncols, chunk);
            let step = {
                let client = conn.client_mut()?;
                client.execute(sql.as_str(), &[]).await
            };
            if let Err(e) = step {
                let _ = finish_tx(&mut conn, "ROLLBACK TRANSACTION").await;
                return Err(e.into());
            }
            inserted += chunk.len() as u64;
            if let Err(e) = on_progress(inserted) {
                let _ = finish_tx(&mut conn, "ROLLBACK TRANSACTION").await;
                return Err(e);
            }
        }
        finish_tx(&mut conn, "COMMIT TRANSACTION").await?;
        Ok(inserted)
    }

    /// Auto-commit insert of one chunk (no wrapping transaction). See
    /// [`super::Connection::try_insert_chunk`] (#687).
    pub(crate) async fn try_insert_chunk(
        &self,
        database: Option<&str>,
        table: &str,
        columns: &[String],
        rows: &[Vec<Option<String>>],
    ) -> Result<()> {
        if rows.is_empty() {
            return Ok(());
        }
        let cols_sql = columns.iter().map(|c| qi(c)).collect::<Vec<_>>().join(", ");
        let sql = build_multi_row_insert(&qi(table), &cols_sql, columns.len(), rows);
        let mut conn = self.pool.acquire().await?;
        let client = conn.client_mut()?;
        apply_use_database(client, database).await?;
        client.execute(sql.as_str(), &[]).await?;
        Ok(())
    }

    /// Row-by-row probe inside a rolled-back transaction to find the first
    /// rejected row. See [`super::Connection::probe_failing_row`] (#687).
    pub(crate) async fn probe_failing_row(
        &self,
        database: Option<&str>,
        table: &str,
        columns: &[String],
        rows: &[Vec<Option<String>>],
    ) -> Result<Option<(usize, String)>> {
        let mut conn = self.pool.acquire().await?;
        {
            let client = conn.client_mut()?;
            apply_use_database(client, database).await?;
        }
        begin_tx(&mut conn).await?;
        let cols_sql = columns.iter().map(|c| qi(c)).collect::<Vec<_>>().join(", ");
        let table_ident = qi(table);
        let mut failing: Option<(usize, String)> = None;
        for (i, row) in rows.iter().enumerate() {
            let sql = build_multi_row_insert(
                &table_ident,
                &cols_sql,
                columns.len(),
                std::slice::from_ref(row),
            );
            let step = {
                let client = conn.client_mut()?;
                client.execute(sql.as_str(), &[]).await
            };
            if let Err(e) = step {
                failing = Some((i, e.to_string()));
                break;
            }
        }
        let _ = finish_tx(&mut conn, "ROLLBACK TRANSACTION").await;
        Ok(failing)
    }

    /// SQL Server tables are always transactional (no MyISAM-like storage
    /// engine choice), matching PostgreSQL/SQLite.
    pub async fn table_is_transactional(
        &self,
        _database: Option<&str>,
        _table: &str,
    ) -> Result<bool> {
        Ok(true)
    }

    /// Runs `statements` sequentially inside a single transaction, rolling
    /// back the whole batch if any one fails. Unlike MySQL, SQL Server's DDL
    /// *is* transactional, so this is genuinely all-or-nothing even for a
    /// mixed DDL+DML batch (no #640-style caveat here).
    pub async fn execute_transaction(
        &self,
        statements: &[String],
        database: Option<&str>,
    ) -> Result<u64> {
        let mut conn = self.pool.acquire().await?;
        {
            let client = conn.client_mut()?;
            apply_use_database(client, database).await?;
        }
        begin_tx(&mut conn).await?;
        let mut total: u64 = 0;
        for stmt in statements {
            let step = {
                let client = conn.client_mut()?;
                run_sql_on(client, stmt).await
            };
            match step {
                Ok(r) => total += r.rows_affected,
                Err(e) => {
                    let _ = finish_tx(&mut conn, "ROLLBACK TRANSACTION").await;
                    return Err(e);
                }
            }
        }
        finish_tx(&mut conn, "COMMIT TRANSACTION").await?;
        Ok(total)
    }

    // ── スキーマ introspection (dbo スキーマ限定。モジュール doc 参照) ──

    pub async fn databases(&self) -> Result<Vec<String>> {
        let mut conn = self.pool.acquire().await?;
        let client = conn.client_mut()?;
        let rows = client
            .query("SELECT name FROM sys.databases ORDER BY name", &[])
            .await?
            .into_first_result()
            .await?;
        Ok(rows
            .iter()
            .filter_map(|r| r.get::<&str, _>(0).map(str::to_string))
            .collect())
    }

    pub async fn tables(&self, db: &str) -> Result<Vec<String>> {
        let mut conn = self.pool.acquire().await?;
        let client = conn.client_mut()?;
        apply_use_database(client, Some(db)).await?;
        let rows = client
            .query(
                "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES \
                 WHERE TABLE_SCHEMA = 'dbo' AND TABLE_TYPE IN ('BASE TABLE', 'VIEW') \
                 ORDER BY TABLE_NAME",
                &[],
            )
            .await?
            .into_first_result()
            .await?;
        Ok(rows
            .iter()
            .filter_map(|r| r.get::<&str, _>(0).map(str::to_string))
            .collect())
    }

    pub async fn columns(&self, db: &str, table: &str) -> Result<Vec<TableColumnInfo>> {
        let mut conn = self.pool.acquire().await?;
        let client = conn.client_mut()?;
        apply_use_database(client, Some(db)).await?;

        let base_rows = client
            .query(
                r#"SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT,
                          CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION, NUMERIC_SCALE
                   FROM INFORMATION_SCHEMA.COLUMNS
                   WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME = @P1
                   ORDER BY ORDINAL_POSITION"#,
                &[&table],
            )
            .await?
            .into_first_result()
            .await?;

        let pk_rows = client
            .query(
                r#"SELECT ku.COLUMN_NAME
                   FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
                   JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku
                     ON tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME
                    AND tc.TABLE_SCHEMA = ku.TABLE_SCHEMA
                    AND tc.TABLE_NAME = ku.TABLE_NAME
                   WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
                     AND tc.TABLE_SCHEMA = 'dbo' AND tc.TABLE_NAME = @P1"#,
                &[&table],
            )
            .await?
            .into_first_result()
            .await?;
        let pk_cols: std::collections::HashSet<String> = pk_rows
            .iter()
            .filter_map(|r| r.get::<&str, _>(0).map(str::to_string))
            .collect();

        let identity_rows = client
            .query(
                r#"SELECT c.name
                   FROM sys.columns c
                   JOIN sys.tables t ON t.object_id = c.object_id
                   JOIN sys.schemas s ON s.schema_id = t.schema_id
                   WHERE s.name = 'dbo' AND t.name = @P1 AND c.is_identity = 1"#,
                &[&table],
            )
            .await?
            .into_first_result()
            .await?;
        let identity_cols: std::collections::HashSet<String> = identity_rows
            .iter()
            .filter_map(|r| r.get::<&str, _>(0).map(str::to_string))
            .collect();

        let fk_rows = client
            .query(
                r#"SELECT cp.name AS col, tr.name AS ref_table, cr.name AS ref_col
                   FROM sys.foreign_keys fk
                   JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
                   JOIN sys.tables tp ON tp.object_id = fkc.parent_object_id
                   JOIN sys.schemas sp ON sp.schema_id = tp.schema_id
                   JOIN sys.columns cp ON cp.object_id = fkc.parent_object_id AND cp.column_id = fkc.parent_column_id
                   JOIN sys.tables tr ON tr.object_id = fkc.referenced_object_id
                   JOIN sys.columns cr ON cr.object_id = fkc.referenced_object_id AND cr.column_id = fkc.referenced_column_id
                   WHERE sp.name = 'dbo' AND tp.name = @P1"#,
                &[&table],
            )
            .await?
            .into_first_result()
            .await?;
        let fk_map: std::collections::HashMap<String, (String, String)> = fk_rows
            .iter()
            .filter_map(|r| {
                let col = r.get::<&str, _>(0)?.to_string();
                let rt = r.get::<&str, _>(1)?.to_string();
                let rc = r.get::<&str, _>(2)?.to_string();
                Some((col, (rt, rc)))
            })
            .collect();

        Ok(base_rows
            .iter()
            .map(|r| {
                let name = r.get::<&str, _>(0).unwrap_or_default().to_string();
                let base_type = r.get::<&str, _>(1).unwrap_or_default();
                let nullable = r
                    .get::<&str, _>(2)
                    .map(|s| s.eq_ignore_ascii_case("YES"))
                    .unwrap_or(false);
                let default = r.get::<&str, _>(3).map(str::to_string);
                let char_len = r.get::<i32, _>(4);
                let num_prec = r.get::<i32, _>(5);
                let num_scale = r.get::<i32, _>(6);
                let referenced = fk_map.get(&name);
                TableColumnInfo {
                    data_type: full_mssql_data_type(base_type, char_len, num_prec, num_scale),
                    nullable,
                    key: if pk_cols.contains(&name) {
                        "PRI".to_string()
                    } else {
                        String::new()
                    },
                    default,
                    extra: if identity_cols.contains(&name) {
                        "identity".to_string()
                    } else {
                        String::new()
                    },
                    referenced_table: referenced.map(|(t, _)| t.clone()),
                    referenced_column: referenced.map(|(_, c)| c.clone()),
                    name,
                }
            })
            .collect())
    }

    /// Row identity strategy for inline editing (#849). MSSQL has no
    /// SQL-visible physical row id comparable to SQLite's `rowid` / Postgres's
    /// `ctid` (`%%physloc%%` exists but isn't stable/documented enough to rely
    /// on), so the only fallback once a table has no PK is matching every
    /// column in the WHERE clause — same as MySQL.
    pub async fn row_identity(&self, db: &str, table: &str) -> Result<TableRowIdentity> {
        let cols = self.columns(db, table).await?;
        if let Some(identity) = super::row_identity_pk_or_none(&cols) {
            return Ok(identity);
        }
        Ok(TableRowIdentity {
            strategy: "all_columns".into(),
            hidden_column: None,
        })
    }

    pub async fn schema_overview(&self, db: &str) -> Result<Vec<TableSchema>> {
        let mut conn = self.pool.acquire().await?;
        let client = conn.client_mut()?;
        apply_use_database(client, Some(db)).await?;
        let rows = client
            .query(
                r#"SELECT TABLE_NAME, COLUMN_NAME
                   FROM INFORMATION_SCHEMA.COLUMNS
                   WHERE TABLE_SCHEMA = 'dbo'
                   ORDER BY TABLE_NAME, ORDINAL_POSITION"#,
                &[],
            )
            .await?
            .into_first_result()
            .await?;
        let pairs = rows
            .iter()
            .map(|r| {
                (
                    r.get::<&str, _>(0).unwrap_or_default().to_string(),
                    r.get::<&str, _>(1).unwrap_or_default().to_string(),
                )
            })
            .collect();
        Ok(super::group_columns_by_table(pairs))
    }

    pub async fn foreign_keys(&self, db: &str) -> Result<Vec<ForeignKey>> {
        let mut conn = self.pool.acquire().await?;
        let client = conn.client_mut()?;
        apply_use_database(client, Some(db)).await?;
        let rows = client
            .query(
                r#"SELECT tp.name, cp.name, tr.name, cr.name, fk.name
                   FROM sys.foreign_keys fk
                   JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
                   JOIN sys.tables tp ON tp.object_id = fkc.parent_object_id
                   JOIN sys.schemas sp ON sp.schema_id = tp.schema_id
                   JOIN sys.columns cp ON cp.object_id = fkc.parent_object_id AND cp.column_id = fkc.parent_column_id
                   JOIN sys.tables tr ON tr.object_id = fkc.referenced_object_id
                   JOIN sys.columns cr ON cr.object_id = fkc.referenced_object_id AND cr.column_id = fkc.referenced_column_id
                   WHERE sp.name = 'dbo'
                   ORDER BY tp.name, fk.name, fkc.constraint_column_id"#,
                &[],
            )
            .await?
            .into_first_result()
            .await?;
        Ok(rows
            .iter()
            .map(|r| ForeignKey {
                table: r.get::<&str, _>(0).unwrap_or_default().to_string(),
                column: r.get::<&str, _>(1).unwrap_or_default().to_string(),
                referenced_table: r.get::<&str, _>(2).unwrap_or_default().to_string(),
                referenced_column: r.get::<&str, _>(3).map(str::to_string),
                constraint_name: r.get::<&str, _>(4).map(str::to_string),
            })
            .collect())
    }

    pub async fn schema_objects(&self, db: &str) -> Result<Vec<SchemaObject>> {
        let mut conn = self.pool.acquire().await?;
        let client = conn.client_mut()?;
        apply_use_database(client, Some(db)).await?;
        let mut out: Vec<SchemaObject> = Vec::new();

        let views = client
            .query(
                "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.VIEWS WHERE TABLE_SCHEMA = 'dbo' ORDER BY TABLE_NAME",
                &[],
            )
            .await?
            .into_first_result()
            .await?;
        for r in &views {
            if let Some(name) = r.get::<&str, _>(0) {
                out.push(SchemaObject {
                    kind: "view".into(),
                    name: name.to_string(),
                    id: None,
                });
            }
        }

        let routines = client
            .query(
                "SELECT ROUTINE_NAME, ROUTINE_TYPE FROM INFORMATION_SCHEMA.ROUTINES \
                 WHERE ROUTINE_SCHEMA = 'dbo' ORDER BY ROUTINE_TYPE, ROUTINE_NAME",
                &[],
            )
            .await?
            .into_first_result()
            .await?;
        for r in &routines {
            let rtype = r.get::<&str, _>(1).unwrap_or_default();
            let kind = if rtype.eq_ignore_ascii_case("PROCEDURE") {
                "procedure"
            } else {
                "function"
            };
            if let Some(name) = r.get::<&str, _>(0) {
                out.push(SchemaObject {
                    kind: kind.into(),
                    name: name.to_string(),
                    id: None,
                });
            }
        }

        let triggers = client
            .query(
                r#"SELECT tr.name
                   FROM sys.triggers tr
                   JOIN sys.tables t ON t.object_id = tr.parent_id
                   JOIN sys.schemas s ON s.schema_id = t.schema_id
                   WHERE s.name = 'dbo' AND tr.parent_class = 1
                   ORDER BY tr.name"#,
                &[],
            )
            .await?
            .into_first_result()
            .await?;
        for r in &triggers {
            if let Some(name) = r.get::<&str, _>(0) {
                out.push(SchemaObject {
                    kind: "trigger".into(),
                    name: name.to_string(),
                    id: None,
                });
            }
        }
        Ok(out)
    }

    /// `OBJECT_DEFINITION` works uniformly for views/procedures/functions/
    /// triggers, unlike MySQL's per-kind `SHOW CREATE ...`, so `kind` is only
    /// used to validate the request.
    pub async fn object_definition(&self, db: &str, kind: &str, name: &str) -> Result<String> {
        if !matches!(kind, "view" | "procedure" | "function" | "trigger") {
            return Err(AppError::InvalidInput(format!(
                "unsupported object kind: {kind}"
            )));
        }
        let mut conn = self.pool.acquire().await?;
        let client = conn.client_mut()?;
        apply_use_database(client, Some(db)).await?;
        let qualified = format!("dbo.{name}");
        let row = client
            .query(
                "SELECT OBJECT_DEFINITION(OBJECT_ID(@P1))",
                &[&qualified.as_str()],
            )
            .await?
            .into_row()
            .await?;
        Ok(row
            .and_then(|r| r.get::<&str, _>(0).map(str::to_string))
            .unwrap_or_default())
    }

    pub async fn list_indexes(&self, db: &str, table: &str) -> Result<Vec<IndexInfo>> {
        let mut conn = self.pool.acquire().await?;
        let client = conn.client_mut()?;
        apply_use_database(client, Some(db)).await?;
        let rows = client
            .query(
                r#"SELECT i.name, c.name, i.is_unique, i.is_primary_key, i.type_desc, ic.key_ordinal
                   FROM sys.indexes i
                   JOIN sys.tables t ON t.object_id = i.object_id
                   JOIN sys.schemas s ON s.schema_id = t.schema_id
                   JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                   JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
                   WHERE s.name = 'dbo' AND t.name = @P1 AND i.name IS NOT NULL
                     AND ic.is_included_column = 0
                   ORDER BY i.name, ic.key_ordinal"#,
                &[&table],
            )
            .await?
            .into_first_result()
            .await?;
        let mut order: Vec<String> = Vec::new();
        let mut by_name: std::collections::HashMap<String, IndexInfo> =
            std::collections::HashMap::new();
        for r in &rows {
            let Some(name) = r.get::<&str, _>(0) else {
                continue;
            };
            let column = r.get::<&str, _>(1).map(str::to_string);
            let unique = r.get::<bool, _>(2).unwrap_or(false);
            let primary = r.get::<bool, _>(3).unwrap_or(false);
            let method = r.get::<&str, _>(4).map(str::to_string);
            let entry = by_name.entry(name.to_string()).or_insert_with(|| {
                order.push(name.to_string());
                IndexInfo {
                    name: name.to_string(),
                    columns: Vec::new(),
                    unique,
                    primary,
                    method,
                }
            });
            if let Some(col) = column {
                entry.columns.push(col);
            }
        }
        Ok(order
            .into_iter()
            .filter_map(|n| by_name.remove(&n))
            .collect())
    }

    pub async fn table_row_estimates(&self, db: &str) -> Result<Vec<TableRowEstimate>> {
        let mut conn = self.pool.acquire().await?;
        let client = conn.client_mut()?;
        apply_use_database(client, Some(db)).await?;
        // `sys.partitions` carries a per-partition row count maintained by the
        // engine (no scan); `index_id IN (0, 1)` restricts to the heap/
        // clustered-index partition so multi-partition and secondary-index
        // rows aren't double counted.
        let rows = client
            .query(
                r#"SELECT t.name, SUM(p.rows)
                   FROM sys.tables t
                   JOIN sys.schemas s ON s.schema_id = t.schema_id
                   JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0, 1)
                   WHERE s.name = 'dbo'
                   GROUP BY t.name
                   ORDER BY t.name"#,
                &[],
            )
            .await?
            .into_first_result()
            .await?;
        Ok(rows
            .iter()
            .filter_map(|r| {
                let name = r.get::<&str, _>(0)?.to_string();
                let estimate = r.get::<i64, _>(1);
                Some(TableRowEstimate { name, estimate })
            })
            .collect())
    }

    pub async fn table_sizes(&self, db: &str) -> Result<Vec<TableSizeInfo>> {
        let mut conn = self.pool.acquire().await?;
        let client = conn.client_mut()?;
        apply_use_database(client, Some(db)).await?;
        // Best-effort split of in-row data (allocation unit `type = 1`) vs.
        // everything else (LOB/row-overflow + all index partitions) into
        // `index_bytes`, matching the row-count restriction used by
        // `table_row_estimates`. `used_pages` is in 8 KiB pages.
        let rows = client
            .query(
                r#"SELECT t.name,
                          SUM(CASE WHEN p.index_id IN (0, 1) THEN p.rows ELSE 0 END),
                          SUM(CASE WHEN a.type = 1 THEN a.used_pages ELSE 0 END) * 8192,
                          SUM(CASE WHEN a.type <> 1 THEN a.used_pages ELSE 0 END) * 8192
                   FROM sys.tables t
                   JOIN sys.schemas s ON s.schema_id = t.schema_id
                   JOIN sys.partitions p ON p.object_id = t.object_id
                   JOIN sys.allocation_units a ON a.container_id = p.partition_id
                   WHERE s.name = 'dbo'
                   GROUP BY t.name
                   ORDER BY t.name"#,
                &[],
            )
            .await?
            .into_first_result()
            .await?;
        Ok(rows
            .iter()
            .filter_map(|r| {
                let name = r.get::<&str, _>(0)?.to_string();
                let row_estimate = r.get::<i64, _>(1);
                let data_bytes = r.get::<i64, _>(2);
                let index_bytes = r.get::<i64, _>(3);
                Some(TableSizeInfo {
                    name,
                    row_estimate,
                    data_bytes,
                    index_bytes,
                    total_bytes: super::sum_size_parts(data_bytes, index_bytes),
                })
            })
            .collect())
    }

    pub async fn server_info(&self) -> Result<ServerInfo> {
        let mut conn = self.pool.acquire().await?;
        let client = conn.client_mut()?;
        let version_row = client
            .query("SELECT @@VERSION", &[])
            .await?
            .into_row()
            .await?;
        let version = version_row
            .and_then(|r| r.get::<&str, _>(0).map(str::to_string))
            .unwrap_or_default();
        const SETTINGS: &[&str] = &[
            "max degree of parallelism",
            "cost threshold for parallelism",
            "remote query timeout (s)",
            "user options",
            "default language",
        ];
        let rows = client
            .query(
                "SELECT name, CAST(value_in_use AS NVARCHAR(4000)) \
                 FROM sys.configurations WHERE name IN (@P1, @P2, @P3, @P4, @P5) ORDER BY name",
                &[
                    &SETTINGS[0],
                    &SETTINGS[1],
                    &SETTINGS[2],
                    &SETTINGS[3],
                    &SETTINGS[4],
                ],
            )
            .await?
            .into_first_result()
            .await?;
        let variables = rows
            .iter()
            .filter_map(|r| {
                let name = r.get::<&str, _>(0)?.to_string();
                let value = r.get::<&str, _>(1).unwrap_or_default().to_string();
                Some(ServerVariable {
                    value: super::mask_sensitive_var(&name, value),
                    name,
                })
            })
            .collect();
        Ok(ServerInfo { version, variables })
    }

    /// #731 のサーバメトリクスダッシュボードは未実装 (モジュール doc 参照)。
    pub async fn server_metrics(&self) -> Result<ServerMetrics> {
        Err(AppError::InvalidInput(
            "server metrics are not yet supported for MSSQL".into(),
        ))
    }

    /// `sys.dm_exec_sessions` / `sys.dm_exec_requests` からアクティブなセッション
    /// を列挙する。`sys.dm_exec_sql_text` で直近/実行中の SQL テキストを解決する。
    pub async fn list_processes(&self) -> Result<Vec<ProcessInfo>> {
        let mut conn = self.pool.acquire().await?;
        let client = conn.client_mut()?;
        let rows = client
            .query(
                r#"SELECT s.session_id, s.login_name, s.host_name, DB_NAME(s.database_id),
                          s.status, r.wait_type, r.total_elapsed_time, t.text,
                          CAST(CASE WHEN s.session_id = @@SPID THEN 1 ELSE 0 END AS BIT)
                   FROM sys.dm_exec_sessions s
                   LEFT JOIN sys.dm_exec_requests r ON r.session_id = s.session_id
                   OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) t
                   WHERE s.is_user_process = 1
                   ORDER BY s.session_id"#,
                &[],
            )
            .await?
            .into_first_result()
            .await?;
        Ok(rows
            .iter()
            .map(|r| ProcessInfo {
                id: i64::from(r.get::<i16, _>(0).unwrap_or_default()),
                user: r.get::<&str, _>(1).map(str::to_string),
                host: r.get::<&str, _>(2).map(str::to_string),
                database: r.get::<&str, _>(3).map(str::to_string),
                command: r.get::<&str, _>(4).map(str::to_string),
                state: r.get::<&str, _>(5).map(str::to_string),
                // total_elapsed_time is milliseconds.
                time_secs: r.get::<i32, _>(6).map(|ms| (ms as i64) / 1000),
                query: r.get::<&str, _>(7).map(str::to_string),
                is_self: r.get::<bool, _>(8).unwrap_or(false),
            })
            .collect())
    }

    /// `KILL <spid>` — `id` は Rust の `i64` から直接 `Display` で埋め込む
    /// (SQL メタ文字を含み得ない数値なので識別子/リテラルのエスケープは不要。
    /// `KILL` はパラメータバインドを受け付けない T-SQL のステートメント)。
    pub async fn kill_process(&self, id: i64) -> Result<()> {
        let mut conn = self.pool.acquire().await?;
        let client = conn.client_mut()?;
        client.execute(format!("KILL {id}"), &[]).await?;
        Ok(())
    }

    /// #746 のライブクエリ・インスペクタは未実装 (モジュール doc 参照)。
    pub async fn query_stats_support(&self) -> Result<QueryStatsSupport> {
        Ok(QueryStatsSupport {
            live_tail: false,
            statements: false,
            live_tail_reason: Some("unsupported_driver".into()),
            statements_reason: Some("unsupported_driver".into()),
        })
    }

    pub async fn live_queries(&self) -> Result<Vec<LiveQuery>> {
        Err(AppError::InvalidInput(
            "live query tail is not yet supported for MSSQL".into(),
        ))
    }

    pub async fn statement_stats(&self) -> Result<Vec<StatementStat>> {
        Err(AppError::InvalidInput(
            "statement statistics are not yet supported for MSSQL".into(),
        ))
    }

    /// #732 のユーザ / 権限管理パネルは未実装 (モジュール doc 参照)。MySQL/
    /// PostgreSQL 同様 `sys.server_principals` / `sys.database_permissions` から
    /// 実装できるが、本 PR のスコープ外。SQLite の `list_db_users` と同じ「空では
    /// なくエラーで非対応を明示する」方針を踏襲する。
    pub async fn list_db_users(&self) -> Result<Vec<DbUserInfo>> {
        Err(AppError::InvalidInput(
            "users are not yet supported for MSSQL".into(),
        ))
    }

    /// See [`MssqlConn::list_db_users`].
    pub async fn user_privileges(
        &self,
        _user: &str,
        _host: Option<&str>,
    ) -> Result<UserPrivileges> {
        Err(AppError::InvalidInput(
            "users are not yet supported for MSSQL".into(),
        ))
    }

    /// #741 の未使用インデックス統計は未実装 (モジュール doc 参照)。
    pub async fn unused_indexes(&self, _db: &str) -> Result<UnusedIndexStats> {
        Ok(UnusedIndexStats {
            supported: false,
            reason: Some("unsupported_driver".into()),
            entries: Vec::new(),
        })
    }
}

/// Quotes an identifier the T-SQL way (`[ident]`). Thin wrapper so call sites
/// in this file read like the other drivers'.
fn qi(name: &str) -> String {
    super::sync::quote_ident(super::DriverKind::Mssql, name)
}

/// Switches the connection's current database with `USE [db]`, mirroring
/// MySQL's per-operation `USE` (SQL Server, like MySQL, lets one login browse
/// every database it can see — unlike PostgreSQL, which is one schema per
/// connection). A `None`/empty `database` leaves the connection on whatever
/// database it is already on.
async fn apply_use_database(client: &mut MssqlClient, database: Option<&str>) -> Result<()> {
    if let Some(db) = database {
        if !db.is_empty() {
            client.execute(format!("USE {}", qi(db)), &[]).await?;
        }
    }
    Ok(())
}

/// Runs one statement and decodes it, dispatching on whether `sql` looks like
/// a result-set-returning statement. Shared by `execute`, `tx_execute`, and
/// `execute_transaction`.
async fn run_sql_on(client: &mut MssqlClient, sql: &str) -> Result<QueryResult> {
    let started = Instant::now();
    if is_query_shape(sql) {
        let rows = client.query(sql, &[]).await?.into_first_result().await?;
        let columns = columns_of_rows(&rows);
        let rows_out = rows.iter().map(row_to_values).collect();
        Ok(QueryResult {
            columns,
            rows: rows_out,
            rows_affected: 0,
            elapsed_ms: started.elapsed().as_millis() as u64,
        })
    } else {
        let result = client.execute(sql, &[]).await?;
        Ok(QueryResult::empty(
            result.total(),
            started.elapsed().as_millis() as u64,
        ))
    }
}

async fn fetch_rows(conn: &mut PooledConn, sql: Option<&str>) -> Result<Vec<TdsRow>> {
    match sql {
        None => Ok(Vec::new()),
        Some(q) => {
            let client = conn.client_mut()?;
            Ok(client.query(q, &[]).await?.into_first_result().await?)
        }
    }
}

/// Statement shapes SQL Server is expected to return a result set for. `EXEC`
/// / `EXECUTE` (stored procedures, which may or may not return rows) are
/// deliberately **not** treated as query-shaped here — same simplification
/// PostgreSQL's `is_query_shape` makes for `CALL` — so they go through the
/// `execute()` (rows-affected) path. `WITH` reuses the driver-agnostic
/// mutating-CTE detector from `db::mysql` (T-SQL CTE syntax is the same ANSI
/// shape).
fn is_query_shape(sql: &str) -> bool {
    // T-SQL's comment syntax matches PostgreSQL's exactly (`--` needs no
    // trailing separator, `/* */` nests), so that flavor is reused rather
    // than adding a fourth `SqlFlavor` variant just for this.
    let cleaned = super::strip_sql_comments(sql, super::SqlFlavor::Postgres);
    let trimmed = cleaned.trim_start().to_ascii_lowercase();
    if trimmed.starts_with("with") {
        return !super::mysql::with_cte_is_mutation(sql);
    }
    trimmed.starts_with("select") || trimmed.starts_with("values")
}

/// Builds a `TypeInfo`-free `Column` list from a set of decoded rows —
/// tiberius rows carry their own column metadata, so this only needs the
/// first row (empty input yields no columns, matching the sqlx-backed
/// drivers' `columns_of`).
fn columns_of_rows(rows: &[TdsRow]) -> Vec<Column> {
    let Some(first) = rows.first() else {
        return Vec::new();
    };
    columns_of_meta(first.columns())
}

fn columns_of_meta(cols: &[tiberius::Column]) -> Vec<Column> {
    cols.iter()
        .map(|c| Column {
            name: c.name().to_string(),
            type_name: mssql_type_name(c.column_type()).to_string(),
        })
        .collect()
}

/// Readable T-SQL type name for a decoded [`ColumnType`]. Purely cosmetic
/// (shown in the result grid header / used for client-side type heuristics
/// like the other drivers' `type_name_matches`); it does not need to be the
/// exact declared type (e.g. `Intn` covers any nullable-int width tiberius
/// couldn't narrow from the wire metadata).
fn mssql_type_name(ct: ColumnType) -> &'static str {
    match ct {
        ColumnType::Null => "null",
        ColumnType::Bit | ColumnType::Bitn => "bit",
        ColumnType::Int1 => "tinyint",
        ColumnType::Int2 => "smallint",
        ColumnType::Int4 => "int",
        ColumnType::Int8 => "bigint",
        ColumnType::Intn => "int",
        ColumnType::Datetime4 => "smalldatetime",
        ColumnType::Float4 => "real",
        ColumnType::Float8 | ColumnType::Floatn => "float",
        ColumnType::Money | ColumnType::Money4 => "money",
        ColumnType::Datetime | ColumnType::Datetimen => "datetime",
        ColumnType::Guid => "uniqueidentifier",
        ColumnType::Decimaln => "decimal",
        ColumnType::Numericn => "numeric",
        ColumnType::Daten => "date",
        ColumnType::Timen => "time",
        ColumnType::Datetime2 => "datetime2",
        ColumnType::DatetimeOffsetn => "datetimeoffset",
        ColumnType::BigVarBin => "varbinary",
        ColumnType::BigBinary => "binary",
        ColumnType::BigVarChar => "varchar",
        ColumnType::BigChar => "char",
        ColumnType::NVarchar => "nvarchar",
        ColumnType::NChar => "nchar",
        ColumnType::Xml => "xml",
        ColumnType::Udt => "udt",
        ColumnType::Text => "text",
        ColumnType::Image => "image",
        ColumnType::NText => "ntext",
        ColumnType::SSVariant => "sql_variant",
    }
}

fn row_to_values(row: &TdsRow) -> Vec<Value> {
    (0..row.columns().len())
        .map(|i| decode_cell(row, i))
        .collect()
}

/// Decodes one cell. Scalar / text / binary / GUID / numeric types are read
/// straight off the row's [`tiberius::ColumnData`] variant (no ambiguity —
/// each Rust type in [`tiberius::FromSql`] maps to exactly one `ColumnData`
/// variant, unlike sqlx's declared-type-name dispatch the other drivers use).
/// Date/time types go through `chrono`'s `FromSql` impls (feature `chrono`)
/// since converting SQL Server's on-wire day-count/tick representation by
/// hand would duplicate non-trivial logic tiberius already has.
fn decode_cell(row: &TdsRow, i: usize) -> Value {
    let Some(col) = row.columns().get(i) else {
        return Value::Null;
    };
    match col.column_type() {
        ColumnType::Bit | ColumnType::Bitn => opt_val(row.get::<bool, _>(i), Value::Bool),
        ColumnType::Int1 => opt_val(row.get::<u8, _>(i), |v| Value::Int(v as i64)),
        ColumnType::Int2 => opt_val(row.get::<i16, _>(i), |v| Value::Int(v as i64)),
        ColumnType::Int4 | ColumnType::Intn => {
            opt_val(row.get::<i32, _>(i), |v| Value::Int(v as i64))
        }
        ColumnType::Int8 => opt_val(row.get::<i64, _>(i), Value::Int),
        ColumnType::Float4 => opt_val(row.get::<f32, _>(i), |v| Value::Float(v as f64)),
        ColumnType::Float8 | ColumnType::Floatn | ColumnType::Money | ColumnType::Money4 => {
            opt_val(row.get::<f64, _>(i), Value::Float)
        }
        ColumnType::Guid => opt_val(row.get::<tiberius::Uuid, _>(i), |v: tiberius::Uuid| {
            Value::String(v.to_string())
        }),
        ColumnType::Decimaln | ColumnType::Numericn => {
            opt_val(row.get::<rust_decimal::Decimal, _>(i), |v| {
                Value::String(v.to_string())
            })
        }
        ColumnType::BigVarBin | ColumnType::BigBinary | ColumnType::Image => {
            opt_val(row.get::<&[u8], _>(i), |v| {
                Value::Bytes(data_encoding::HEXLOWER.encode(v))
            })
        }
        ColumnType::Daten => opt_val(row.get::<chrono::NaiveDate, _>(i), |v| {
            Value::String(v.to_string())
        }),
        ColumnType::Timen => opt_val(row.get::<chrono::NaiveTime, _>(i), |v| {
            Value::String(v.to_string())
        }),
        ColumnType::Datetime
        | ColumnType::Datetimen
        | ColumnType::Datetime4
        | ColumnType::Datetime2 => opt_val(row.get::<chrono::NaiveDateTime, _>(i), |v| {
            Value::String(v.to_string())
        }),
        ColumnType::DatetimeOffsetn => {
            opt_val(row.get::<chrono::DateTime<chrono::Utc>, _>(i), |v| {
                Value::String(v.to_rfc3339())
            })
        }
        // Everything else (var/fixed char, XML, sql_variant, ...) reads as
        // text — the standard fallback tail the other drivers use too.
        _ => opt_val(row.get::<&str, _>(i), |v| Value::String(v.to_string())),
    }
}

/// `Row::get` returns `Option<T>` directly (no `Result` to unwrap — a type
/// mismatch here would be a bug in the match above, not user data), so this
/// just maps `Some`/`None` into `Value`/`Value::Null`.
fn opt_val<T>(v: Option<T>, f: impl FnOnce(T) -> Value) -> Value {
    v.map(f).unwrap_or(Value::Null)
}

/// Builds the `DbConnectOptions` connection settings into a `tiberius::Config`.
fn build_config(opts: &DbConnectOptions) -> Result<Config> {
    let mut config = Config::new();
    config.host(&opts.host);
    config.port(opts.port);
    if let Some(db) = &opts.database {
        if !db.is_empty() {
            config.database(db);
        }
    }
    config.application_name("noobDB");
    config.authentication(AuthMethod::sql_server(&opts.user, &opts.password));
    apply_tls(&mut config, opts);
    Ok(config)
}

/// Applies the driver-neutral [`SslMode`] to `config`. `None` mirrors the
/// other drivers' "leave the library default alone" reading, mapped here to
/// opportunistic encryption without certificate verification (tiberius has
/// no bare "prefer" mode — its default is actually `NotSupported`/plaintext
/// on non-TDS-7.4 negotiations, so `None` is deliberately mapped the same as
/// `Prefer` rather than left as the library default, to keep data encrypted
/// in transit whenever the server offers it).
///
/// Client-certificate (mTLS) settings (`ssl_client_cert` / `ssl_client_key`)
/// are **not applied** — `tiberius::Config` has no such option (#729 known
/// gap, documented in the module doc comment).
fn apply_tls(config: &mut Config, opts: &DbConnectOptions) {
    let root_cert = non_empty(&opts.ssl_root_cert);
    match opts.ssl_mode {
        None | Some(SslMode::Prefer) => {
            config.encryption(EncryptionLevel::On);
            config.trust_cert();
        }
        Some(SslMode::Disable) => {
            config.encryption(EncryptionLevel::NotSupported);
        }
        Some(SslMode::Require) => {
            config.encryption(EncryptionLevel::Required);
            config.trust_cert();
        }
        Some(SslMode::VerifyCa) | Some(SslMode::VerifyFull) => {
            config.encryption(EncryptionLevel::Required);
            if let Some(ca) = root_cert {
                config.trust_cert_ca(ca);
            }
            // No CA path: tiberius's default `TrustConfig::Default` verifies
            // the full chain (+ hostname) against the OS trust store, which
            // is the right behaviour for both `verify_ca` and `verify_full`
            // here — tiberius does not expose a "verify CA only, skip
            // hostname" mode, so the two collapse to the same behaviour
            // (documented gap, same as the custom-CA branch above).
        }
    }
}

/// Returns the trimmed path only when it is non-empty, so a blank form field
/// (serialized as `Some("")`) is treated as unset. Duplicated in each driver
/// module (see `mysql.rs`/`postgres.rs`) rather than shared.
fn non_empty(value: &Option<String>) -> Option<&str> {
    value.as_deref().map(str::trim).filter(|s| !s.is_empty())
}

/// `INFORMATION_SCHEMA.COLUMNS.DATA_TYPE` alone is the bare type name
/// (`varchar`, `decimal`) with no length/precision, so this rebuilds the
/// qualified form (`varchar(50)`, `decimal(10,2)`) the way `data_type` should
/// carry it (mirrors PostgreSQL's `full_pg_data_type`). SQL Server reports
/// `-1` for `(max)` character lengths.
fn full_mssql_data_type(
    base: &str,
    char_len: Option<i32>,
    num_prec: Option<i32>,
    num_scale: Option<i32>,
) -> String {
    let lower = base.to_ascii_lowercase();
    if let Some(len) = char_len {
        if matches!(
            lower.as_str(),
            "char" | "varchar" | "nchar" | "nvarchar" | "binary" | "varbinary"
        ) {
            return if len < 0 {
                format!("{base}(max)")
            } else {
                format!("{base}({len})")
            };
        }
    }
    if let (Some(p), Some(s)) = (num_prec, num_scale) {
        if matches!(lower.as_str(), "decimal" | "numeric") {
            return format!("{base}({p},{s})");
        }
    }
    base.to_string()
}

fn mssql_literal(cell: Option<&str>) -> String {
    match cell {
        None => "NULL".to_string(),
        Some(s) => format!("N'{}'", s.replace('\'', "''")),
    }
}

/// Builds `INSERT INTO tbl (c1, c2) VALUES (v1, v2), ...`, splicing each cell
/// as a literal (see [`MssqlConn::import_rows`] doc comment for why).
fn build_multi_row_insert(
    table_ident: &str,
    cols_sql: &str,
    ncols: usize,
    rows: &[Vec<Option<String>>],
) -> String {
    let mut sql = format!("INSERT INTO {table_ident} ({cols_sql}) VALUES ");
    for (r, row) in rows.iter().enumerate() {
        if r > 0 {
            sql.push(',');
        }
        sql.push('(');
        for ci in 0..ncols {
            if ci > 0 {
                sql.push(',');
            }
            let cell = row.get(ci).and_then(|c| c.as_deref());
            sql.push_str(&mssql_literal(cell));
        }
        sql.push(')');
    }
    sql
}

/// Tokenizes `sql` for the dry-run preview's target-table extraction, the
/// same job `db::mysql::tokenize_sql` does, but treating `[...]` as one
/// bracket-quoted token (T-SQL's identifier quoting) instead of backticks.
/// Nested/escaped `]]` inside a bracketed identifier is not handled — a rare
/// edge case for a best-effort feature that degrades to "PK unknown" on any
/// parse failure.
fn tokenize_sql(sql: &str) -> Vec<String> {
    let cleaned = super::strip_sql_comments(sql, super::SqlFlavor::Postgres);
    let mut tokens: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut in_bracket = false;
    for c in cleaned.chars() {
        if in_bracket {
            cur.push(c);
            if c == ']' {
                in_bracket = false;
            }
        } else if c == '[' {
            cur.push(c);
            in_bracket = true;
        } else if c.is_whitespace() || c == '(' || c == ')' || c == ',' || c == ';' {
            if !cur.is_empty() {
                tokens.push(std::mem::take(&mut cur));
            }
        } else {
            cur.push(c);
        }
    }
    if !cur.is_empty() {
        tokens.push(cur);
    }
    tokens
}

/// Best-effort target-table extraction for `UPDATE` / `DELETE FROM` /
/// `INSERT [INTO]`, used by the dry-run preview. `UPDATE TOP (n) tbl SET
/// ...` and other modifier-prefixed forms are not recognised (return `None`,
/// which degrades the preview to "target table unknown" rather than
/// mis-parsing).
fn extract_target_table(sql: &str) -> Option<String> {
    let tokens = tokenize_sql(sql);
    let mut iter = tokens.into_iter().peekable();
    let first = iter.next()?;
    match first.to_ascii_lowercase().as_str() {
        "update" => {
            let table = iter.next()?;
            if !iter.peek().is_some_and(|t| t.eq_ignore_ascii_case("set")) {
                return None;
            }
            Some(table)
        }
        "delete" => {
            let next = iter.next()?;
            if !next.eq_ignore_ascii_case("from") {
                return None;
            }
            iter.next()
        }
        "insert" => {
            let mut next = iter.next()?;
            if next.eq_ignore_ascii_case("into") {
                next = iter.next()?;
            }
            Some(next)
        }
        _ => None,
    }
}

/// Strips a `[...]`/schema-qualified target token down to the bare table
/// name for use as a `WHERE TABLE_NAME = @Pn` parameter (naive split on `.`
/// — doesn't handle a literal `.` inside a bracketed identifier, an
/// acceptable gap for this best-effort lookup).
fn bare_table_name(t: &str) -> String {
    let last = t.rsplit('.').next().unwrap_or(t);
    last.trim_start_matches('[')
        .trim_end_matches(']')
        .to_string()
}

/// Looks up the target table's primary-key columns in declaration order, for
/// pairing the preview's before/after row snapshots. Any failure (view
/// target, no PK, ...) degrades to "PK unknown" at the call site.
async fn fetch_primary_key(client: &mut MssqlClient, target: &str) -> Result<Vec<String>> {
    let bare = bare_table_name(target);
    let rows = client
        .query(
            r#"SELECT ku.COLUMN_NAME
               FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
               JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku
                 ON tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME
                AND tc.TABLE_SCHEMA = ku.TABLE_SCHEMA
                AND tc.TABLE_NAME = ku.TABLE_NAME
               WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY' AND ku.TABLE_NAME = @P1
               ORDER BY ku.ORDINAL_POSITION"#,
            &[&bare.as_str()],
        )
        .await?
        .into_first_result()
        .await?;
    Ok(rows
        .iter()
        .filter_map(|r| r.get::<&str, _>(0).map(str::to_string))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_query_shape_recognizes_select_and_with() {
        assert!(is_query_shape("SELECT * FROM t"));
        assert!(is_query_shape("  select 1"));
        assert!(is_query_shape("WITH c AS (SELECT 1 AS n) SELECT * FROM c"));
        // A mutating CTE body doesn't itself decide the shape — the
        // *outermost* (depth-0) statement's leading keyword does
        // (`with_cte_is_mutation`'s actual contract): here the outer
        // statement is `SELECT`, so the whole thing still returns a result
        // set (projecting the CTE's rows) and is query-shaped.
        assert!(is_query_shape(
            "WITH d AS (DELETE FROM t OUTPUT deleted.*) SELECT * FROM d"
        ));
        // Conversely, a `WITH` whose *outer* statement is a mutation is not
        // query-shaped, even though the CTE body itself is a plain SELECT.
        assert!(!is_query_shape("WITH x AS (SELECT 1) DELETE FROM t"));
        assert!(!is_query_shape("INSERT INTO t VALUES (1)"));
        assert!(!is_query_shape("UPDATE t SET a = 1"));
        assert!(!is_query_shape("DELETE FROM t"));
        assert!(!is_query_shape("EXEC sp_helpdb"));
        assert!(!is_query_shape("EXECUTE dbo.my_proc"));
    }

    #[test]
    fn quote_ident_brackets_and_doubles_embedded_bracket() {
        assert_eq!(qi("users"), "[users]");
        assert_eq!(qi("weird]name"), "[weird]]name]");
    }

    #[test]
    fn extract_target_table_covers_update_delete_insert() {
        assert_eq!(
            extract_target_table("UPDATE [dbo].[users] SET x = 1 WHERE id = 1"),
            Some("[dbo].[users]".to_string())
        );
        assert_eq!(
            extract_target_table("DELETE FROM users WHERE id = 1"),
            Some("users".to_string())
        );
        assert_eq!(
            extract_target_table("INSERT INTO users (id) VALUES (1)"),
            Some("users".to_string())
        );
        assert_eq!(
            extract_target_table("INSERT users (id) VALUES (1)"),
            Some("users".to_string())
        );
        // Multi-table UPDATE-lookalike / unrecognised shapes degrade to None.
        assert_eq!(extract_target_table("SELECT * FROM users"), None);
    }

    #[test]
    fn bare_table_name_strips_brackets_and_schema() {
        assert_eq!(bare_table_name("[dbo].[users]"), "users");
        assert_eq!(bare_table_name("dbo.users"), "users");
        assert_eq!(bare_table_name("users"), "users");
        assert_eq!(bare_table_name("[users]"), "users");
    }

    #[test]
    fn full_data_type_appends_length_and_precision() {
        assert_eq!(
            full_mssql_data_type("varchar", Some(50), None, None),
            "varchar(50)"
        );
        assert_eq!(
            full_mssql_data_type("nvarchar", Some(-1), None, None),
            "nvarchar(max)"
        );
        assert_eq!(
            full_mssql_data_type("decimal", None, Some(10), Some(2)),
            "decimal(10,2)"
        );
        assert_eq!(full_mssql_data_type("int", None, None, None), "int");
    }

    #[test]
    fn mssql_literal_escapes_quotes_and_nulls() {
        assert_eq!(mssql_literal(None), "NULL");
        assert_eq!(mssql_literal(Some("a'b")), "N'a''b'");
    }

    #[test]
    fn build_multi_row_insert_joins_tuples() {
        let rows = vec![
            vec![Some("1".to_string()), None],
            vec![Some("2".to_string()), Some("x".to_string())],
        ];
        assert_eq!(
            build_multi_row_insert("[t]", "[a], [b]", 2, &rows),
            "INSERT INTO [t] ([a], [b]) VALUES (N'1',NULL),(N'2',N'x')"
        );
    }

    #[test]
    fn mssql_type_name_covers_common_types() {
        assert_eq!(mssql_type_name(ColumnType::Int4), "int");
        assert_eq!(mssql_type_name(ColumnType::NVarchar), "nvarchar");
        assert_eq!(mssql_type_name(ColumnType::Decimaln), "decimal");
        assert_eq!(
            mssql_type_name(ColumnType::DatetimeOffsetn),
            "datetimeoffset"
        );
    }
}
