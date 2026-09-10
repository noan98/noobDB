//! DuckDB driver (#709) — a file-backed analytical database, similar in
//! shape to SQLite but with a richer analytical SQL dialect (close to
//! PostgreSQL) and its own set of SQL data types.
//!
//! The official Rust binding (`duckdb` crate) wraps DuckDB's C API with a
//! **synchronous** API (no sqlx support), so every blocking DuckDB call in
//! this module runs on a Tokio blocking-pool thread via [`run_blocking`].
//!
//! ## Connection model
//!
//! Unlike the sqlx-backed drivers there is no connection pool. Instead this
//! module leans on a DuckDB-specific capability: **`Connection::try_clone`**
//! opens a new connection to the *already-open* database (same underlying
//! file, its own DuckDB-side transaction/session state). Every operation
//! that doesn't need to span multiple IPC round trips (`execute`,
//! `execute_stream`, `import_rows`, schema introspection, ...) clones a
//! fresh, private connection off `seed` and hands it to a blocking task —
//! this gives pool-like concurrency without hand-rolling a pool. The
//! explicit-transaction path (`begin_transaction` / `execute_in_transaction`
//! / `finish_transaction`) instead checks out **one** cloned connection into
//! `tx` and holds it for the lifetime of that transaction, mirroring
//! [`super::sqlite::SqliteConn`]'s dedicated `tx` connection.
//!
//! ## Value decoding
//!
//! `duckdb::types::Value` (via `Row::get::<_, duckdb::types::Value>`) always
//! succeeds and already carries a fully-typed, owned representation of every
//! cell — DuckDB's own `FromSql for Value` impl does the ValueRef → Value
//! conversion infallibly. [`duckdb_value_to_value`] then maps each DuckDB
//! variant onto this app's driver-neutral [`Value`]: integers/floats/bool/
//! text/blob map directly, and everything DuckDB-specific that doesn't fit
//! the common wire format (DECIMAL, TIMESTAMP/DATE/TIME/INTERVAL, LIST/
//! STRUCT/MAP/ARRAY/ENUM/UNION/GEOMETRY) falls back to a readable `String`
//! — the same "typed first, string fallback" pattern the other drivers use
//! for exotic column types.
//!
//! ## Bulk insert (CSV/JSON import, #687 skip-mode)
//!
//! DuckDB's prepared-statement parameter binding is strongly typed (unlike
//! SQLite's dynamic column affinity), so binding text parameters positionally
//! risks a type mismatch against the destination column. Following the same
//! choice `db/postgres.rs` made for the same reason, bulk insert here builds
//! **inline SQL literals** (escaped via [`duckdb_literal`]) instead of bound
//! parameters, relying on DuckDB's implicit cast of untyped string literals
//! to the destination column's type inside `INSERT ... VALUES (...)`.
use std::sync::Mutex as StdMutex;

use duckdb::types::{Type as DuckType, Value as DuckValue};

use super::advisor::UnusedIndexStats;
use super::types::{
    Column, DbUserInfo, ForeignKey, IndexInfo, LiveQuery, PreviewResult, ProcessInfo, QueryResult,
    QueryStatsSupport, SchemaObject, ServerInfo, ServerMetrics, ServerVariable, StatementStat,
    StreamBatch, TableColumnInfo, TableRowEstimate, TableRowIdentity, TableSchema, TableSizeInfo,
    UserPrivileges, Value,
};
use super::{init_sql_of, DbConnectOptions};
use crate::error::{AppError, Result};

// `databases()` / `tables()` / `columns()` treat the `db` parameter as a
// DuckDB **schema** name (the connection's catalog is fixed to the open
// file), the same convention `db/postgres.rs` uses for PostgreSQL schemas.
// DuckDB's default schema is `"main"`, mirroring SQLite's synthetic database
// name — but unlike SQLite's driver, `databases()` below discovers schemas
// dynamically via `information_schema` rather than hard-coding it, so there
// is no `DEFAULT_DB_NAME` constant here.

pub struct DuckDbConn {
    /// Cloned per call to give each operation its own private connection
    /// (see module docs). Wrapped in a plain `std::sync::Mutex` purely so
    /// `DuckDbConn` is `Sync` — the lock is only ever held for the instant it
    /// takes to call `try_clone()`, never across a query.
    seed: StdMutex<duckdb::Connection>,
    /// The dedicated connection backing an explicit transaction
    /// (`begin_transaction` / `execute_in_transaction` / `finish_transaction`).
    /// `None` when no transaction is active.
    tx: tokio::sync::Mutex<Option<duckdb::Connection>>,
    /// Session init SQL (#522), re-applied to every cloned connection by
    /// [`clone_conn`](Self::clone_conn) — see that method's doc comment for
    /// why a DuckDB clone needs this independently of the seed connection.
    init_sql: Option<String>,
}

impl DuckDbConn {
    pub async fn connect(opts: &DbConnectOptions) -> Result<Self> {
        let path = opts
            .file_path
            .as_deref()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| AppError::InvalidInput("DuckDB file_path is required".into()))?
            .to_string();
        // Unlike `duckdb::Connection::open` (which creates a fresh empty
        // database when the path doesn't exist), require the file to already
        // exist — mirroring the SQLite driver's `create_if_missing(false)` so
        // a typo'd path can't silently create a stray `.duckdb` file, and so
        // the connection form's "pick an existing file" dialog behaves the
        // same for both file-backed drivers.
        if tokio::fs::metadata(&path).await.is_err() {
            return Err(AppError::InvalidInput(format!(
                "DuckDB file does not exist: {path}"
            )));
        }
        let init_sql = init_sql_of(opts);
        let init_sql_for_seed = init_sql.clone();
        let seed = run_blocking(move || -> Result<duckdb::Connection> {
            let conn = duckdb::Connection::open(&path)?;
            if let Some(sql) = init_sql_for_seed {
                conn.execute_batch(&sql)?;
            }
            Ok(conn)
        })
        .await?;
        Ok(Self {
            seed: StdMutex::new(seed),
            tx: tokio::sync::Mutex::new(None),
            init_sql,
        })
    }

    /// DuckDB has no shared-pool handle to close from `&self` (unlike sqlx's
    /// `Pool::close`) — `duckdb::Connection::close` takes `self` by value.
    /// The seed connection (and every clone in flight) closes itself via
    /// `Drop` once this `DuckDbConn` — and thus its owning `Session` — is
    /// dropped, which is exactly when `disconnect` drops the session's `Arc`.
    /// Best-effort: proactively drop a held transaction connection so a
    /// dangling `BEGIN` doesn't keep a stray connection (and lock) alive any
    /// longer than necessary.
    pub async fn close(&self) {
        let mut guard = self.tx.lock().await;
        *guard = None;
    }

    /// Clones a fresh, private connection off `seed` and re-applies session
    /// init SQL (#522) to it. Unlike a network-based driver's connection pool
    /// (where sqlx's `after_connect` hook runs once per physical connection
    /// as the pool grows), a DuckDB clone does **not** inherit the original
    /// connection's session-scoped state (`SET`/`PRAGMA` settings like
    /// `search_path`/`memory_limit`) — each `try_clone()`'d connection starts
    /// from DuckDB's defaults. So init SQL must be reapplied here on every
    /// clone for the "runs on each physical connection" contract (CLAUDE.md
    /// #522) to actually hold — otherwise only the one-off seed connection
    /// from `connect` would ever see it, and every per-call clone used by the
    /// rest of this module would silently skip it. Both `try_clone()` and a
    /// short SET/PRAGMA batch are cheap, synchronous DuckDB C API calls (no
    /// I/O), so — like the plain clone — this is safe to call directly from
    /// async code without a `spawn_blocking` hop.
    fn clone_conn(&self) -> Result<duckdb::Connection> {
        let conn = {
            let guard = self
                .seed
                .lock()
                .map_err(|_| AppError::Other("duckdb: connection lock poisoned".into()))?;
            guard.try_clone()?
        };
        if let Some(sql) = &self.init_sql {
            conn.execute_batch(sql)?;
        }
        Ok(conn)
    }

    pub async fn execute(&self, sql: &str, _database: Option<&str>) -> Result<QueryResult> {
        let conn = self.clone_conn()?;
        let sql = sql.to_string();
        run_blocking(move || run_sql_on(&conn, &sql)).await
    }

    // ── 明示トランザクション ──

    pub async fn tx_begin(&self, _database: Option<&str>) -> Result<()> {
        let mut guard = self.tx.lock().await;
        if guard.is_some() {
            return Err(AppError::InvalidInput(
                "a transaction is already active".into(),
            ));
        }
        let conn = self.clone_conn()?;
        let conn = run_blocking(move || -> Result<duckdb::Connection> {
            conn.execute_batch("BEGIN TRANSACTION")?;
            Ok(conn)
        })
        .await?;
        *guard = Some(conn);
        Ok(())
    }

    pub async fn tx_execute(&self, sql: &str) -> Result<QueryResult> {
        let mut guard = self.tx.lock().await;
        let conn = guard
            .take()
            .ok_or_else(|| AppError::InvalidInput("no active transaction".into()))?;
        let sql = sql.to_string();
        // `run_blocking`'s outer `Result` only errors on a worker panic (in
        // which case there is no connection to hand back — the guard stays
        // `None`, correctly reflecting that the transaction can't continue).
        // On success it always carries the connection back, *and* the
        // statement's own `Result<QueryResult>` separately, so a failed
        // statement doesn't silently end the transaction: the connection is
        // restored and the caller must still call `finish_transaction`.
        let (conn, result) = run_blocking(move || {
            let result = run_sql_on(&conn, &sql);
            Ok((conn, result))
        })
        .await?;
        *guard = Some(conn);
        result
    }

    pub async fn tx_finish(&self, commit: bool) -> Result<()> {
        let mut guard = self.tx.lock().await;
        let conn = guard
            .take()
            .ok_or_else(|| AppError::InvalidInput("no active transaction".into()))?;
        run_blocking(move || {
            let stmt = if commit { "COMMIT" } else { "ROLLBACK" };
            conn.execute_batch(stmt)?;
            Ok(())
        })
        .await
    }

    pub async fn tx_active(&self) -> bool {
        self.tx.lock().await.is_some()
    }

    /// Runs `sql` on a fresh connection, streaming rows to `on_batch` in
    /// `initial_batch`/`chunk_size`-sized groups. The blocking DuckDB work
    /// happens on a dedicated worker thread that pushes batches through a
    /// **bounded** channel (`STREAM_CHANNEL_CAPACITY`) via `blocking_send` —
    /// unlike an unbounded channel, this backpressures the worker (and thus
    /// DuckDB row fetching) to the pace `on_batch` actually drains at, so a
    /// consumer that's slower than DuckDB can produce rows (e.g. writing each
    /// batch to disk for an export) can't let unbounded in-flight batches
    /// pile up in memory ahead of it. The async loop here calls `on_batch` in
    /// the normal (non-blocking-thread) async context, so `on_batch` never
    /// needs to be `Send`. Cancellation is best-effort: dropping the
    /// receiving loop (task abort) stops *consuming* further batches
    /// immediately, and the RAII guard around the worker's
    /// [`duckdb::InterruptHandle`] additionally asks DuckDB itself to stop
    /// the in-flight query as soon as it next checks for interruption.
    pub async fn execute_stream<F>(
        &self,
        sql: &str,
        _database: Option<&str>,
        initial_batch: usize,
        chunk_size: usize,
        mut on_batch: F,
    ) -> Result<QueryResult>
    where
        F: FnMut(StreamBatch) -> Result<()>,
    {
        let started = std::time::Instant::now();
        let conn = self.clone_conn()?;
        let sql_owned = sql.to_string();

        if !is_query_shape(sql) {
            let affected = run_blocking(move || {
                conn.execute(&sql_owned, [])
                    .map_err(AppError::from)
                    .map(|n| n as u64)
            })
            .await?;
            return Ok(QueryResult::empty(
                affected,
                started.elapsed().as_millis() as u64,
            ));
        }

        let initial = initial_batch.max(1);
        let chunk = chunk_size.max(1);
        // `interrupt_handle()` already returns an `Arc<InterruptHandle>` —
        // cheap to clone, so the worker thread and this guard each get their
        // own handle onto the same underlying interrupt state.
        let interrupt = conn.interrupt_handle();
        let mut interrupt_guard = InterruptOnDrop::new(interrupt);

        let (tx, mut rx) = tokio::sync::mpsc::channel::<StreamMsg>(STREAM_CHANNEL_CAPACITY);
        let worker = tokio::task::spawn_blocking(move || {
            let outcome = (|| -> Result<u64> {
                let mut stmt = conn.prepare(&sql_owned)?;
                let mut duck_rows = stmt.query([])?;
                let columns = duck_rows.as_ref().map(build_columns).unwrap_or_default();
                if tx
                    .blocking_send(StreamMsg::Columns(columns.clone()))
                    .is_err()
                {
                    return Ok(0);
                }
                let mut buffer: Vec<Vec<Value>> = Vec::new();
                let mut total: u64 = 0;
                let mut target = initial;
                while let Some(row) = duck_rows.next()? {
                    buffer.push(row_to_values(row, columns.len())?);
                    if buffer.len() >= target {
                        total += buffer.len() as u64;
                        if tx
                            .blocking_send(StreamMsg::Rows(std::mem::take(&mut buffer)))
                            .is_err()
                        {
                            return Ok(total);
                        }
                        target = chunk;
                    }
                }
                if !buffer.is_empty() {
                    total += buffer.len() as u64;
                    let _ = tx.blocking_send(StreamMsg::Rows(buffer));
                }
                Ok(total)
            })();
            match outcome {
                Ok(total) => {
                    let _ = tx.blocking_send(StreamMsg::Done(total));
                }
                Err(e) => {
                    let _ = tx.blocking_send(StreamMsg::Error(e));
                }
            }
        });

        let mut columns: Vec<Column> = Vec::new();
        let mut total: u64 = 0;
        let mut stream_err: Option<AppError> = None;
        while let Some(msg) = rx.recv().await {
            match msg {
                StreamMsg::Columns(cols) => {
                    columns = cols.clone();
                    on_batch(StreamBatch::Columns(cols))?;
                }
                StreamMsg::Rows(rows) => {
                    on_batch(StreamBatch::Rows(rows))?;
                }
                StreamMsg::Done(n) => {
                    total = n;
                    break;
                }
                StreamMsg::Error(e) => {
                    stream_err = Some(e);
                    break;
                }
            }
        }
        // The query finished delivering (or errored) — the interrupt handle
        // no longer needs to fire on drop.
        interrupt_guard.disarm();
        drop(interrupt_guard);
        // Best-effort: reap the worker thread so a panic surfaces in logs
        // instead of being silently dropped. Not awaited for correctness —
        // by this point the channel is already closed/drained.
        let _ = worker.await;

        if let Some(e) = stream_err {
            return Err(e);
        }
        Ok(QueryResult {
            columns,
            rows: Vec::new(),
            rows_affected: total,
            elapsed_ms: started.elapsed().as_millis() as u64,
        })
    }

    pub async fn preview_execute_with_limit(
        &self,
        sql: &str,
        _database: Option<&str>,
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
        if super::has_stacked_statements_for(super::DriverKind::DuckDb, sql) {
            return Err(AppError::InvalidInput(
                "preview does not support multiple statements".into(),
            ));
        }

        let target = extract_target_table(sql);
        let conn = self.clone_conn()?;
        let sql_owned = sql.to_string();
        let target_owned = target.clone();

        run_blocking(move || -> Result<PreviewResult> {
            let started = std::time::Instant::now();
            let primary_key = match &target_owned {
                Some(t) => fetch_primary_key_for_ident(&conn, t).unwrap_or_default(),
                None => Vec::new(),
            };
            conn.execute_batch("BEGIN TRANSACTION")?;
            let result = (|| -> Result<PreviewResult> {
                let before_sql = target_owned.as_ref().map(|t| {
                    let order = super::pk_order_clause(&primary_key, quote_ident);
                    format!("SELECT * FROM {}{} LIMIT {}", t, order, row_limit + 1)
                });
                let (before_cols, before_rows) = match &before_sql {
                    Some(q) => fetch_capped(&conn, q, row_limit + 1)?,
                    None => (Vec::new(), Vec::new()),
                };
                let affected = conn.execute(&sql_owned, [])? as u64;
                let (after_cols, after_rows) = match &before_sql {
                    Some(q) => fetch_capped(&conn, q, row_limit + 1)?,
                    None => (Vec::new(), Vec::new()),
                };
                let elapsed_ms = started.elapsed().as_millis() as u64;
                let truncated = before_rows.len() > row_limit || after_rows.len() > row_limit;
                let columns = if !before_cols.is_empty() {
                    before_cols
                } else {
                    after_cols
                };
                Ok(PreviewResult {
                    target_table: target_owned.clone(),
                    columns,
                    primary_key: primary_key.clone(),
                    before_rows: before_rows.into_iter().take(row_limit).collect(),
                    after_rows: after_rows.into_iter().take(row_limit).collect(),
                    rows_affected: affected,
                    elapsed_ms,
                    truncated,
                })
            })();
            // Always roll back — a preview never persists changes, whether
            // the mutation succeeded or failed.
            let _ = conn.execute_batch("ROLLBACK");
            result
        })
        .await
    }

    /// Bulk INSERT via inline-literal, batched multi-row statements wrapped
    /// in one transaction (all-or-nothing). See the module docs for why
    /// literals are used instead of bound parameters.
    pub async fn import_rows<F>(
        &self,
        _database: Option<&str>,
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
        let batch = batch_size.clamp(1, 1000);
        let table = table.to_string();
        let columns = columns.to_vec();
        let rows = rows.to_vec();
        let conn = self.clone_conn()?;
        // Grabbed before `conn` moves into the blocking closure so a caller
        // that aborts via `on_progress` (e.g. cancellation) can ask the
        // in-flight batch to stop instead of only stopping *after* every
        // remaining chunk has already been inserted.
        let interrupt = conn.interrupt_handle();

        // `on_progress` is a caller-supplied closure that is not `Send`, so
        // the blocking insert loop reports progress via a channel back to
        // this async fn instead of calling it from the worker thread.
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<u64>();
        let worker = tokio::task::spawn_blocking(move || -> Result<u64> {
            conn.execute_batch("BEGIN TRANSACTION")?;
            let result = (|| -> Result<u64> {
                let mut inserted: u64 = 0;
                for chunk in rows.chunks(batch) {
                    let sql = build_duckdb_insert(&table, &columns, chunk);
                    conn.execute_batch(&sql)?;
                    inserted += chunk.len() as u64;
                    let _ = tx.send(inserted);
                }
                Ok(inserted)
            })();
            match &result {
                Ok(_) => conn.execute_batch("COMMIT")?,
                Err(_) => {
                    let _ = conn.execute_batch("ROLLBACK");
                }
            }
            result
        });

        let mut abort_err: Option<AppError> = None;
        while let Some(n) = rx.recv().await {
            if let Err(e) = on_progress(n) {
                abort_err = Some(e);
                interrupt.interrupt();
                // Keep draining (unbounded `send` never blocks the worker)
                // rather than stopping early, so the loop always ends by the
                // channel closing when the worker finishes.
            }
        }
        // Await the join *before* deciding which error to surface — the
        // worker/transaction must be allowed to fully wind down (ROLLBACK
        // issued) before this function returns, regardless of which error
        // wins below. But once `on_progress` has failed (`abort_err` set,
        // `interrupt.interrupt()` already called above), that failure is
        // the real reason this import stopped, and it must take priority
        // over whatever `run_blocking_join` returns: an interrupted
        // `execute_batch` call surfaces DuckDB's own generic "interrupted"
        // error, which carries no information about *why* — checking
        // `abort_err` first (rather than `?`-propagating the join result
        // immediately) is what lets the caller's actual cancellation reason
        // reach them instead of being silently replaced by that generic
        // message. This mirrors the other three drivers' `on_progress(..)?`
        // contract, where the callback's own error is what propagates.
        let join_result = run_blocking_join(worker).await;
        if let Some(e) = abort_err {
            return Err(e);
        }
        join_result
    }

    /// Auto-commit insert of one chunk (no wrapping transaction). See
    /// [`super::Connection::try_insert_chunk`] (#687).
    pub(crate) async fn try_insert_chunk(
        &self,
        _database: Option<&str>,
        table: &str,
        columns: &[String],
        rows: &[Vec<Option<String>>],
    ) -> Result<()> {
        if rows.is_empty() {
            return Ok(());
        }
        let table = table.to_string();
        let columns = columns.to_vec();
        let rows = rows.to_vec();
        let conn = self.clone_conn()?;
        run_blocking(move || {
            let sql = build_duckdb_insert(&table, &columns, &rows);
            conn.execute_batch(&sql)?;
            Ok(())
        })
        .await
    }

    /// Row-by-row probe inside a rolled-back transaction to find the first
    /// rejected row. See [`super::Connection::probe_failing_row`] (#687).
    pub(crate) async fn probe_failing_row(
        &self,
        _database: Option<&str>,
        table: &str,
        columns: &[String],
        rows: &[Vec<Option<String>>],
    ) -> Result<Option<(usize, String)>> {
        let table = table.to_string();
        let columns = columns.to_vec();
        let rows = rows.to_vec();
        let conn = self.clone_conn()?;
        run_blocking(move || -> Result<Option<(usize, String)>> {
            conn.execute_batch("BEGIN TRANSACTION")?;
            let mut failure = None;
            for (i, row) in rows.iter().enumerate() {
                let sql = build_duckdb_insert(&table, &columns, std::slice::from_ref(row));
                if let Err(e) = conn.execute_batch(&sql) {
                    failure = Some((i, e.to_string()));
                    break;
                }
            }
            let _ = conn.execute_batch("ROLLBACK");
            Ok(failure)
        })
        .await
    }

    /// Runs `statements` sequentially inside a single transaction
    /// (all-or-nothing). DuckDB has transactional DDL (like PostgreSQL), so
    /// unlike MySQL a `CREATE TABLE` mixed into the batch rolls back cleanly
    /// with the rest on failure. Each statement is routed through the same
    /// [`is_query_shape`] check [`run_sql_on`] uses — a `SELECT` mixed into
    /// the batch (e.g. a user script that ends with a sanity-check query)
    /// runs via `query()` and its rows are counted but otherwise discarded
    /// (this API's contract is a single `rows_affected` total, not a
    /// per-statement result set), rather than going through `execute()`,
    /// which is meant for statements that don't return rows.
    pub async fn execute_transaction(
        &self,
        statements: &[String],
        _database: Option<&str>,
    ) -> Result<u64> {
        if statements.is_empty() {
            return Ok(0);
        }
        let statements = statements.to_vec();
        let conn = self.clone_conn()?;
        run_blocking(move || -> Result<u64> {
            conn.execute_batch("BEGIN TRANSACTION")?;
            let result = (|| -> Result<u64> {
                let mut affected = 0u64;
                for sql in &statements {
                    affected += if is_query_shape(sql) {
                        let mut stmt = conn.prepare(sql)?;
                        let mut duck_rows = stmt.query([])?;
                        let mut n = 0u64;
                        while duck_rows.next()?.is_some() {
                            n += 1;
                        }
                        n
                    } else {
                        conn.execute(sql, [])? as u64
                    };
                }
                Ok(affected)
            })();
            match &result {
                Ok(_) => conn.execute_batch("COMMIT")?,
                Err(_) => {
                    let _ = conn.execute_batch("ROLLBACK");
                }
            }
            result
        })
        .await
    }

    // ── スキーマ ──

    pub async fn databases(&self) -> Result<Vec<String>> {
        let conn = self.clone_conn()?;
        run_blocking(move || {
            let mut stmt = conn.prepare(
                "SELECT schema_name FROM information_schema.schemata \
                 WHERE catalog_name = current_catalog() \
                   AND schema_name NOT IN ('information_schema', 'pg_catalog') \
                 ORDER BY schema_name",
            )?;
            let names = stmt
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            Ok(names)
        })
        .await
    }

    /// DuckDB has no server-side user accounts (file-backed, like SQLite);
    /// surfaces the same explicit "unsupported" error as
    /// [`super::sqlite::SqliteConn::list_db_users`] so the IPC layer and UI
    /// treat both file drivers identically.
    pub async fn list_db_users(&self) -> Result<Vec<DbUserInfo>> {
        Err(AppError::InvalidInput(
            "users are not supported for DuckDB (file-backed, no server-side accounts)".into(),
        ))
    }

    /// See [`DuckDbConn::list_db_users`].
    pub async fn user_privileges(
        &self,
        _user: &str,
        _host: Option<&str>,
    ) -> Result<UserPrivileges> {
        Err(AppError::InvalidInput(
            "users are not supported for DuckDB (file-backed, no server-side accounts)".into(),
        ))
    }

    pub async fn list_processes(&self) -> Result<Vec<ProcessInfo>> {
        Err(AppError::InvalidInput(
            "process list is not supported for DuckDB (file-backed, no server processes)".into(),
        ))
    }

    pub async fn server_metrics(&self) -> Result<ServerMetrics> {
        Err(AppError::InvalidInput(
            "server metrics are not supported for DuckDB (file-backed, no server)".into(),
        ))
    }

    pub async fn kill_process(&self, _id: i64) -> Result<()> {
        Err(AppError::InvalidInput(
            "killing processes is not supported for DuckDB (file-backed, no server processes)"
                .into(),
        ))
    }

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
            "live query tail is not supported for DuckDB (file-backed, no server)".into(),
        ))
    }

    pub async fn statement_stats(&self) -> Result<Vec<StatementStat>> {
        Err(AppError::InvalidInput(
            "statement statistics are not supported for DuckDB (file-backed, no server)".into(),
        ))
    }

    pub async fn unused_indexes(&self, _db: &str) -> Result<UnusedIndexStats> {
        Ok(UnusedIndexStats {
            supported: false,
            reason: Some("unsupported_driver".into()),
            entries: Vec::new(),
        })
    }

    pub async fn tables(&self, db: &str) -> Result<Vec<String>> {
        let conn = self.clone_conn()?;
        let db = db.to_string();
        run_blocking(move || {
            let mut stmt = conn.prepare(
                "SELECT table_name FROM information_schema.tables \
                 WHERE table_schema = ? ORDER BY table_name",
            )?;
            let names = stmt
                .query_map(duckdb::params![db], |r| r.get::<_, String>(0))?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            Ok(names)
        })
        .await
    }

    pub async fn columns(&self, db: &str, table: &str) -> Result<Vec<TableColumnInfo>> {
        let conn = self.clone_conn()?;
        let db = db.to_string();
        let table = table.to_string();
        run_blocking(move || -> Result<Vec<TableColumnInfo>> {
            let pk_cols = fetch_primary_key_columns(&conn, &db, &table)?;
            let fks = fetch_foreign_keys_for(&conn, &db, &table)?;
            let mut fk_by_col: std::collections::HashMap<String, (String, Option<String>)> =
                std::collections::HashMap::new();
            for fk in fks {
                fk_by_col.insert(fk.column, (fk.referenced_table, fk.referenced_column));
            }

            let mut stmt = conn.prepare(
                "SELECT column_name, data_type, is_nullable, column_default \
                 FROM information_schema.columns \
                 WHERE table_schema = ? AND table_name = ? \
                 ORDER BY ordinal_position",
            )?;
            let mut duck_rows = stmt.query(duckdb::params![db, table])?;
            let mut out = Vec::new();
            while let Some(row) = duck_rows.next()? {
                let name: String = row.get(0)?;
                let data_type: String = row.get(1)?;
                let is_nullable: String = row.get(2)?;
                let default: Option<String> = row.get(3)?;
                let (referenced_table, referenced_column) = match fk_by_col.get(&name) {
                    Some((t, c)) => (Some(t.clone()), c.clone()),
                    None => (None, None),
                };
                out.push(TableColumnInfo {
                    key: if pk_cols.contains(&name) {
                        "PRI".into()
                    } else {
                        String::new()
                    },
                    name,
                    data_type,
                    nullable: is_nullable.eq_ignore_ascii_case("YES"),
                    default,
                    extra: String::new(),
                    referenced_table,
                    referenced_column,
                });
            }
            Ok(out)
        })
        .await
    }

    /// Row identity strategy for inline editing (#849). DuckDB exposes no
    /// stable, cheaply-selectable physical row id via SQL, so the only
    /// fallback once a table has no PK is matching every column in the WHERE
    /// clause — same as MySQL/MSSQL.
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

    pub async fn foreign_keys(&self, db: &str) -> Result<Vec<ForeignKey>> {
        let conn = self.clone_conn()?;
        let db = db.to_string();
        run_blocking(move || fetch_foreign_keys(&conn, &db)).await
    }

    pub async fn list_indexes(&self, db: &str, table: &str) -> Result<Vec<IndexInfo>> {
        let conn = self.clone_conn()?;
        let db = db.to_string();
        let table = table.to_string();
        run_blocking(move || -> Result<Vec<IndexInfo>> {
            let pk_cols = fetch_primary_key_in_schema(&conn, &db, &table)?;
            let mut out = Vec::new();
            if !pk_cols.is_empty() {
                out.push(IndexInfo {
                    name: format!("{table}_pkey"),
                    columns: pk_cols,
                    unique: true,
                    primary: true,
                    method: None,
                });
            }
            // `duckdb_indexes()` exposes user-created (non-PK) indexes with
            // their defining expression. Treated as best-effort/informational
            // only: DuckDB's internal metadata functions have shifted column
            // sets across releases, so a query failure here degrades to "no
            // extra indexes" instead of failing the whole schema panel (the
            // primary key above, from the SQL-standard information_schema
            // join, is unaffected).
            if let Ok(mut stmt) = conn.prepare(
                "SELECT index_name, is_unique, expressions \
                 FROM duckdb_indexes() \
                 WHERE schema_name = ? AND table_name = ? \
                 ORDER BY index_name",
            ) {
                if let Ok(mut duck_rows) = stmt.query(duckdb::params![db, table]) {
                    while let Ok(Some(row)) = duck_rows.next() {
                        let name: String = row.get(0).unwrap_or_default();
                        if name.is_empty() {
                            continue;
                        }
                        let unique: bool = row.get(1).unwrap_or(false);
                        let expressions: Vec<String> = row
                            .get::<_, Option<String>>(2)
                            .ok()
                            .flatten()
                            .map(|s| vec![s])
                            .unwrap_or_default();
                        out.push(IndexInfo {
                            name,
                            columns: expressions,
                            unique,
                            primary: false,
                            method: None,
                        });
                    }
                }
            }
            Ok(out)
        })
        .await
    }

    pub async fn schema_objects(&self, db: &str) -> Result<Vec<SchemaObject>> {
        // DuckDB has views but no stored procedures/functions/triggers in
        // the sense the other drivers expose (its "macros" are closer to
        // reusable SQL expressions than callable routines), so only views
        // are listed here.
        let conn = self.clone_conn()?;
        let db = db.to_string();
        run_blocking(move || -> Result<Vec<SchemaObject>> {
            let mut stmt = conn.prepare(
                "SELECT table_name FROM information_schema.views \
                 WHERE table_schema = ? ORDER BY table_name",
            )?;
            let names = stmt
                .query_map(duckdb::params![db], |r| r.get::<_, String>(0))?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            Ok(names
                .into_iter()
                .map(|name| SchemaObject {
                    kind: "view".into(),
                    name,
                    id: None,
                })
                .collect())
        })
        .await
    }

    pub async fn object_definition(&self, db: &str, kind: &str, name: &str) -> Result<String> {
        if kind != "view" {
            return Err(AppError::InvalidInput(format!(
                "unsupported object kind: {kind}"
            )));
        }
        let conn = self.clone_conn()?;
        let db = db.to_string();
        let name = name.to_string();
        run_blocking(move || -> Result<String> {
            let sql: Option<String> = conn
                .query_row(
                    "SELECT sql FROM duckdb_views() WHERE schema_name = ? AND view_name = ?",
                    duckdb::params![db, name],
                    |r| r.get(0),
                )
                .map_err(|_| {
                    AppError::InvalidInput(format!("no definition found for view '{name}'"))
                })?;
            sql.ok_or_else(|| {
                AppError::InvalidInput(format!("no definition found for view '{name}'"))
            })
        })
        .await
    }

    pub async fn schema_overview(&self, db: &str) -> Result<Vec<TableSchema>> {
        let conn = self.clone_conn()?;
        let db = db.to_string();
        run_blocking(move || -> Result<Vec<TableSchema>> {
            let mut stmt = conn.prepare(
                "SELECT table_name, column_name FROM information_schema.columns \
                 WHERE table_schema = ? ORDER BY table_name, ordinal_position",
            )?;
            let pairs = stmt
                .query_map(duckdb::params![db], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            Ok(super::group_columns_by_table(pairs))
        })
        .await
    }

    pub async fn table_row_estimates(&self, db: &str) -> Result<Vec<TableRowEstimate>> {
        let conn = self.clone_conn()?;
        let db = db.to_string();
        run_blocking(move || -> Result<Vec<TableRowEstimate>> {
            let mut stmt = conn.prepare(
                "SELECT table_name, estimated_size FROM duckdb_tables() \
                 WHERE schema_name = ? AND NOT internal ORDER BY table_name",
            )?;
            let rows = stmt
                .query_map(duckdb::params![db], |r| {
                    Ok(TableRowEstimate {
                        name: r.get::<_, String>(0)?,
                        estimate: r.get::<_, Option<i64>>(1)?,
                    })
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .await
    }

    pub async fn table_sizes(&self, db: &str) -> Result<Vec<TableSizeInfo>> {
        // DuckDB doesn't separately report index bytes; `estimated_size` from
        // `duckdb_tables()` is the closest cheap approximation and is
        // reported as both the row estimate and (best-effort) the data size.
        let estimates = self.table_row_estimates(db).await?;
        Ok(estimates
            .into_iter()
            .map(|e| TableSizeInfo {
                name: e.name,
                row_estimate: e.estimate,
                data_bytes: None,
                index_bytes: None,
                total_bytes: None,
            })
            .collect())
    }

    pub async fn server_info(&self) -> Result<ServerInfo> {
        let conn = self.clone_conn()?;
        run_blocking(move || -> Result<ServerInfo> {
            let version: String = conn
                .query_row("PRAGMA version", [], |r| r.get(0))
                .unwrap_or_default();
            const PRAGMAS: &[&str] = &["memory_limit", "threads"];
            let mut variables = Vec::with_capacity(PRAGMAS.len());
            for name in PRAGMAS {
                if let Ok(value) = conn.query_row(&format!("PRAGMA {name}"), [], |r| {
                    r.get::<_, String>(0)
                        .or_else(|_| r.get::<_, i64>(0).map(|v| v.to_string()))
                }) {
                    variables.push(ServerVariable {
                        name: (*name).to_string(),
                        value,
                    });
                }
            }
            Ok(ServerInfo { version, variables })
        })
        .await
    }
}

/// Capacity of the bounded channel [`DuckDbConn::execute_stream`]'s worker
/// thread uses to hand batches to the consuming async loop. A handful of
/// in-flight batches is enough to keep the pipeline full without a slow
/// consumer (e.g. streaming an export to a slow disk) letting DuckDB race
/// ahead and buffer unbounded rows in memory.
const STREAM_CHANNEL_CAPACITY: usize = 8;

/// Message sent from the `execute_stream` worker thread to the consuming
/// async loop over a bounded channel (see [`DuckDbConn::execute_stream`]).
enum StreamMsg {
    Columns(Vec<Column>),
    Rows(Vec<Vec<Value>>),
    Done(u64),
    Error(AppError),
}

/// RAII guard that calls `duckdb::InterruptHandle::interrupt()` on drop
/// unless [`disarm`](Self::disarm) was called first. Dropped when the
/// consuming future in `execute_stream` is aborted (task cancellation) or
/// finishes normally; in the cancellation case this actually asks the
/// in-flight DuckDB query to stop rather than merely abandoning it, so a
/// cancelled long-running analytical query doesn't keep burning CPU in the
/// background after the UI has moved on.
struct InterruptOnDrop {
    handle: std::sync::Arc<duckdb::InterruptHandle>,
    armed: bool,
}

impl InterruptOnDrop {
    fn new(handle: std::sync::Arc<duckdb::InterruptHandle>) -> Self {
        Self {
            handle,
            armed: true,
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for InterruptOnDrop {
    fn drop(&mut self) {
        if self.armed {
            self.handle.interrupt();
        }
    }
}

/// Runs a blocking DuckDB closure on the Tokio blocking-pool, translating a
/// worker-thread panic into an [`AppError`] instead of propagating it (which
/// `spawn_blocking`'s `JoinError` would otherwise force callers to handle
/// separately from every other DuckDB error).
async fn run_blocking<F, T>(f: F) -> Result<T>
where
    F: FnOnce() -> Result<T> + Send + 'static,
    T: Send + 'static,
{
    match tokio::task::spawn_blocking(f).await {
        Ok(r) => r,
        Err(e) => Err(AppError::Other(format!(
            "duckdb worker thread panicked: {e}"
        ))),
    }
}

/// Joins a raw `JoinHandle<Result<T>>` (used by [`DuckDbConn::import_rows`],
/// which needs to select over both the handle and a progress channel), with
/// the same panic-to-`AppError` translation as [`run_blocking`].
async fn run_blocking_join<T>(handle: tokio::task::JoinHandle<Result<T>>) -> Result<T> {
    match handle.await {
        Ok(r) => r,
        Err(e) => Err(AppError::Other(format!(
            "duckdb worker thread panicked: {e}"
        ))),
    }
}

/// Decides whether `sql` should run through the result-set path (`query`) or
/// the `execute` path that only reports the affected-row count. DuckDB's
/// query-shaped statements largely mirror PostgreSQL/SQLite: `SELECT`,
/// non-mutating `WITH ... SELECT`, and the introspection pseudo-statements
/// `SHOW` / `DESCRIBE` / `DESC` / `EXPLAIN` / `PRAGMA` / `SUMMARIZE`.
/// `WITH` は `db::mysql` 共有の `with_cte_is_mutation` へ委譲する。そのキーワード
/// 列挙は方言非依存だが、コメント/リテラルのマスクだけはドライバ別なので自分の
/// `DriverKind` を渡す (#1051 — DuckDB は `\` をただの文字として扱う)。
///
/// `FROM tbl` / `FROM tbl SELECT ...` (DuckDB's `FROM`-first shorthand) and
/// `TABLE tbl` (the PostgreSQL/DuckDB `SELECT * FROM tbl` shorthand) were
/// already added to the read-only allow-list in
/// [`super::is_read_only_sql_masked`] (#1005), but not here — so both passed
/// the read-only guard and then fell through to the `execute` branch below,
/// silently returning an empty result instead of the statement's rows
/// (#1054). Unlike the plain-prefix checks above, both are matched with
/// [`super::starts_with_word`] rather than `str::starts_with`: `from` in
/// particular is a common enough leading substring (e.g. an identifier like
/// `FROMAGE`) that a bare prefix check could misroute a non-`FROM` statement
/// into the query path, so the match requires the keyword to end at a
/// word boundary.
/// `pub(crate)` (raised from private) so the cross-driver golden test
/// (`tests/query_shape_golden.rs`, #971) can drive it via `__test_api`
/// without changing its behaviour.
pub(crate) fn is_query_shape(sql: &str) -> bool {
    let cleaned = strip_sql_comments(sql);
    let trimmed = cleaned.trim_start().to_ascii_lowercase();
    if trimmed.starts_with("with") {
        return !super::mysql::with_cte_is_mutation(super::DriverKind::DuckDb, sql);
    }
    trimmed.starts_with("select")
        || trimmed.starts_with("show")
        || trimmed.starts_with("describe")
        || trimmed.starts_with("desc")
        || trimmed.starts_with("explain")
        || trimmed.starts_with("pragma")
        || trimmed.starts_with("summarize")
        || trimmed.starts_with("values")
        || super::starts_with_word(&trimmed, "from")
        || super::starts_with_word(&trimmed, "table")
}

fn strip_sql_comments(sql: &str) -> String {
    // DuckDB's comment/string dialect (`--`/`/* */` incl. nesting, dollar
    // quoting, standard-conforming `'…'` strings) matches PostgreSQL's.
    super::strip_sql_comments(sql, super::SqlFlavor::Postgres)
}

/// Runs one statement on `conn`, choosing the query or execute path per
/// [`is_query_shape`]. Shared by `execute`, `tx_execute`, and the non-query
/// branch of `execute_stream`.
fn run_sql_on(conn: &duckdb::Connection, sql: &str) -> Result<QueryResult> {
    let started = std::time::Instant::now();
    if is_query_shape(sql) {
        let mut stmt = conn.prepare(sql)?;
        let mut duck_rows = stmt.query([])?;
        let columns = duck_rows.as_ref().map(build_columns).unwrap_or_default();
        let mut rows = Vec::new();
        while let Some(row) = duck_rows.next()? {
            rows.push(row_to_values(row, columns.len())?);
        }
        Ok(QueryResult {
            columns,
            rows,
            rows_affected: 0,
            elapsed_ms: started.elapsed().as_millis() as u64,
        })
    } else {
        let affected = conn.execute(sql, [])? as u64;
        Ok(QueryResult::empty(
            affected,
            started.elapsed().as_millis() as u64,
        ))
    }
}

fn fetch_capped(
    conn: &duckdb::Connection,
    sql: &str,
    cap: usize,
) -> Result<(Vec<Column>, Vec<Vec<Value>>)> {
    let mut stmt = conn.prepare(sql)?;
    let mut duck_rows = stmt.query([])?;
    let columns = duck_rows.as_ref().map(build_columns).unwrap_or_default();
    let mut rows = Vec::with_capacity(cap.min(1024));
    while let Some(row) = duck_rows.next()? {
        rows.push(row_to_values(row, columns.len())?);
        if rows.len() >= cap {
            break;
        }
    }
    Ok((columns, rows))
}

/// Builds the driver-neutral `Column` metadata from an executed `Statement`.
fn build_columns(stmt: &duckdb::Statement<'_>) -> Vec<Column> {
    let n = stmt.column_count();
    (0..n)
        .map(|i| Column {
            name: stmt
                .column_name(i)
                .map(|s| s.to_string())
                .unwrap_or_default(),
            type_name: duckdb_sql_type_name(&DuckType::from(&stmt.column_type(i))),
        })
        .collect()
}

fn row_to_values(row: &duckdb::Row<'_>, ncols: usize) -> Result<Vec<Value>> {
    (0..ncols)
        .map(|i| -> Result<Value> {
            let v: DuckValue = row.get(i)?;
            Ok(duckdb_value_to_value(v))
        })
        .collect()
}

/// Maps DuckDB's own dynamic `Value` (see module docs) onto this app's
/// driver-neutral [`Value`]. Integers/floats/bool/text/blob decode directly;
/// everything else (containers, DECIMAL, temporal types, ...) renders to a
/// readable `String` — the same typed-first/string-fallback pattern the
/// other drivers use for exotic column types.
fn duckdb_value_to_value(v: DuckValue) -> Value {
    match v {
        DuckValue::Null => Value::Null,
        DuckValue::Boolean(b) => Value::Bool(b),
        DuckValue::TinyInt(n) => Value::Int(n as i64),
        DuckValue::SmallInt(n) => Value::Int(n as i64),
        DuckValue::Int(n) => Value::Int(n as i64),
        // BIGINT/UBIGINT/HUGEINT/UHUGEINT are the widths that can actually
        // exceed JS's safe integer range (2^53-1) — TinyInt/SmallInt/Int and
        // their unsigned counterparts above always fit, so they stay as
        // plain `Value::Int` unconditionally. Route the wide ones through
        // the lossless helpers (`Value::from_i64_lossless` etc., #precision)
        // rather than a bare `Value::Int`/`Value::UInt`.
        DuckValue::BigInt(n) => Value::from_i64_lossless(n),
        DuckValue::HugeInt(n) => Value::from_i128_lossless(n),
        DuckValue::UHugeInt(n) => Value::from_u128_lossless(n),
        DuckValue::UTinyInt(n) => Value::Int(n as i64),
        DuckValue::USmallInt(n) => Value::Int(n as i64),
        DuckValue::UInt(n) => Value::Int(n as i64),
        DuckValue::UBigInt(n) => Value::from_u64_lossless(n),
        DuckValue::Float(f) => Value::Float(f as f64),
        DuckValue::Double(f) => Value::Float(f),
        DuckValue::Decimal(d) => Value::String(d.to_string()),
        DuckValue::Timestamp(unit, raw) => Value::String(format_timestamp(unit, raw)),
        DuckValue::Text(s) => Value::String(s),
        DuckValue::Blob(b) | DuckValue::Geometry(b) => {
            Value::Bytes(data_encoding::HEXLOWER.encode(&b))
        }
        DuckValue::Date32(days) => Value::String(format_date32(days)),
        DuckValue::Time64(unit, raw) => Value::String(format_time64(unit, raw)),
        DuckValue::Interval {
            months,
            days,
            nanos,
        } => Value::String(format_interval(months, days, nanos)),
        DuckValue::Enum(s) => Value::String(s),
        DuckValue::Union(inner) => duckdb_value_to_value(*inner),
        DuckValue::List(items) => Value::String(json_stringify(&DuckValue::List(items))),
        DuckValue::Struct(map) => Value::String(json_stringify(&DuckValue::Struct(map))),
        DuckValue::Array(items) => Value::String(json_stringify(&DuckValue::Array(items))),
        DuckValue::Map(map) => Value::String(json_stringify(&DuckValue::Map(map))),
        // `duckdb::types::Value` is `#[non_exhaustive]`: fall back to Debug
        // for any variant added by a future duckdb crate upgrade.
        other => Value::String(format!("{other:?}")),
    }
}

/// Renders a nested DuckDB container value (`LIST`/`STRUCT`/`ARRAY`/`MAP`) as
/// compact JSON text for display, since this app's wire format has no native
/// container `Value` variant. Huge (128-bit) integers nested inside a
/// container fall back to a JSON *string* of the exact value when they don't
/// fit in `i64`/`u64` (this app doesn't enable `serde_json`'s
/// arbitrary-precision feature, so a JSON number can't carry the full 128
/// bits) — matching the top-level scalar path's ([`duckdb_value_to_value`])
/// "typed first, string fallback" pattern instead of silently truncating to
/// `0`.
fn json_stringify(v: &DuckValue) -> String {
    serde_json::to_string(&duckdb_value_to_json(v)).unwrap_or_else(|_| format!("{v:?}"))
}

fn duckdb_value_to_json(v: &DuckValue) -> serde_json::Value {
    match v {
        DuckValue::Null => serde_json::Value::Null,
        DuckValue::Boolean(b) => (*b).into(),
        DuckValue::TinyInt(n) => (*n).into(),
        DuckValue::SmallInt(n) => (*n).into(),
        DuckValue::Int(n) => (*n).into(),
        DuckValue::BigInt(n) => (*n).into(),
        DuckValue::HugeInt(n) => i64::try_from(*n)
            .map(serde_json::Value::from)
            .unwrap_or_else(|_| n.to_string().into()),
        DuckValue::UHugeInt(n) => u64::try_from(*n)
            .map(serde_json::Value::from)
            .unwrap_or_else(|_| n.to_string().into()),
        DuckValue::UTinyInt(n) => (*n).into(),
        DuckValue::USmallInt(n) => (*n).into(),
        DuckValue::UInt(n) => (*n).into(),
        DuckValue::UBigInt(n) => (*n).into(),
        DuckValue::Float(f) => serde_json::Number::from_f64(*f as f64)
            .map(serde_json::Value::Number)
            .unwrap_or(serde_json::Value::Null),
        DuckValue::Double(f) => serde_json::Number::from_f64(*f)
            .map(serde_json::Value::Number)
            .unwrap_or(serde_json::Value::Null),
        DuckValue::Decimal(d) => d.to_string().into(),
        DuckValue::Text(s) => s.clone().into(),
        DuckValue::Enum(s) => s.clone().into(),
        DuckValue::Blob(b) | DuckValue::Geometry(b) => data_encoding::HEXLOWER.encode(b).into(),
        DuckValue::Date32(days) => format_date32(*days).into(),
        DuckValue::Time64(unit, raw) => format_time64(*unit, *raw).into(),
        DuckValue::Timestamp(unit, raw) => format_timestamp(*unit, *raw).into(),
        DuckValue::Interval {
            months,
            days,
            nanos,
        } => format_interval(*months, *days, *nanos).into(),
        DuckValue::List(items) | DuckValue::Array(items) => {
            serde_json::Value::Array(items.iter().map(duckdb_value_to_json).collect())
        }
        DuckValue::Struct(map) => {
            let mut obj = serde_json::Map::with_capacity(map.iter().count());
            for (k, v) in map.iter() {
                obj.insert(k.clone(), duckdb_value_to_json(v));
            }
            serde_json::Value::Object(obj)
        }
        DuckValue::Map(map) => serde_json::Value::Array(
            map.iter()
                .map(|(k, v)| {
                    serde_json::Value::Array(vec![duckdb_value_to_json(k), duckdb_value_to_json(v)])
                })
                .collect(),
        ),
        DuckValue::Union(inner) => duckdb_value_to_json(inner),
        other => format!("{other:?}").into(),
    }
}

fn format_date32(days: i32) -> String {
    match chrono::NaiveDate::from_ymd_opt(1970, 1, 1)
        .and_then(|epoch| epoch.checked_add_signed(chrono::Duration::days(days as i64)))
    {
        Some(d) => d.format("%Y-%m-%d").to_string(),
        None => format!("date32:{days}"),
    }
}

fn format_time64(unit: duckdb::types::TimeUnit, raw: i64) -> String {
    let micros = unit.to_micros(raw).rem_euclid(86_400_000_000);
    let secs = (micros / 1_000_000) as u32;
    let micros_rem = (micros % 1_000_000) as u32;
    match chrono::NaiveTime::from_num_seconds_from_midnight_opt(secs, micros_rem * 1000) {
        Some(t) => t.format("%H:%M:%S%.6f").to_string(),
        None => format!("time64:{raw}"),
    }
}

fn format_timestamp(unit: duckdb::types::TimeUnit, raw: i64) -> String {
    let micros = unit.to_micros(raw);
    let secs = micros.div_euclid(1_000_000);
    let micros_rem = micros.rem_euclid(1_000_000) as u32;
    match chrono::DateTime::from_timestamp(secs, micros_rem * 1000) {
        Some(dt) => dt.format("%Y-%m-%d %H:%M:%S%.6f").to_string(),
        None => format!("timestamp:{raw}"),
    }
}

fn format_interval(months: i32, days: i32, nanos: i64) -> String {
    format!("{months}mon {days}d {nanos}ns")
}

/// Maps a DuckDB column [`DuckType`] to its canonical DuckDB SQL type name
/// (`VARCHAR`, `BIGINT`, `TIMESTAMP`, ...) rather than the Rust-side variant
/// name, so it lines up with how every other driver reports `type_name` /
/// `data_type` (a real SQL type keyword) and with the frontend's
/// `classifyTypeName` exact-match tables (`src/components/cellTypeMeta.ts`).
fn duckdb_sql_type_name(t: &DuckType) -> String {
    match t {
        DuckType::Null => "NULL",
        DuckType::Boolean => "BOOLEAN",
        DuckType::TinyInt => "TINYINT",
        DuckType::SmallInt => "SMALLINT",
        DuckType::Int => "INTEGER",
        DuckType::BigInt => "BIGINT",
        DuckType::HugeInt => "HUGEINT",
        DuckType::UHugeInt => "UHUGEINT",
        DuckType::UTinyInt => "UTINYINT",
        DuckType::USmallInt => "USMALLINT",
        DuckType::UInt => "UINTEGER",
        DuckType::UBigInt => "UBIGINT",
        DuckType::Float => "FLOAT",
        DuckType::Double => "DOUBLE",
        DuckType::Decimal => "DECIMAL",
        DuckType::Timestamp => "TIMESTAMP",
        DuckType::Text => "VARCHAR",
        DuckType::Blob => "BLOB",
        DuckType::Geometry => "GEOMETRY",
        DuckType::Date32 => "DATE",
        DuckType::Time64 => "TIME",
        DuckType::Interval => "INTERVAL",
        DuckType::List(_) => "LIST",
        DuckType::Enum => "ENUM",
        DuckType::Struct(_) => "STRUCT",
        DuckType::Map(_, _) => "MAP",
        DuckType::Array(_, _) => "ARRAY",
        DuckType::Union => "UNION",
        DuckType::Variant => "VARIANT",
        DuckType::Any => "ANY",
        _ => "UNKNOWN",
    }
    .to_string()
}

/// Primary-key column names of `table` in `schema`, via the SQL-standard
/// `information_schema.table_constraints` + `key_column_usage` join (DuckDB
/// documents these as views built on top of `duckdb_constraints()`).
fn fetch_primary_key_columns(
    conn: &duckdb::Connection,
    schema: &str,
    table: &str,
) -> Result<std::collections::HashSet<String>> {
    let mut stmt = conn.prepare(
        "SELECT kcu.column_name \
         FROM information_schema.table_constraints tc \
         JOIN information_schema.key_column_usage kcu \
           ON tc.constraint_name = kcu.constraint_name \
          AND tc.table_schema = kcu.table_schema \
          AND tc.table_name = kcu.table_name \
         WHERE tc.constraint_type = 'PRIMARY KEY' \
           AND tc.table_schema = ? AND tc.table_name = ?",
    )?;
    let names = stmt
        .query_map(duckdb::params![schema, table], |r| r.get::<_, String>(0))?
        .collect::<std::result::Result<std::collections::HashSet<_>, _>>()?;
    Ok(names)
}

/// Like [`fetch_primary_key_columns`], but for a mutation target parsed out
/// of raw SQL (`extract_target_table`) — the identifier may still be quoted,
/// so it's normalised first. Returns the columns in declaration order
/// (`ORDER BY kcu.ordinal_position`), unlike the `HashSet` variant used for
/// membership tests.
///
/// **Not schema-scoped**: the caller only has a bare table name parsed out of
/// raw SQL (no schema qualifier to work with — `extract_target_table` doesn't
/// resolve `search_path`), so this can return the wrong table's PK if two
/// schemas both have a table of this name. Callers that *do* know the schema
/// (e.g. [`DuckDbConn::list_indexes`]) should use
/// [`fetch_primary_key_in_schema`] instead.
fn fetch_primary_key_for_ident(conn: &duckdb::Connection, ident: &str) -> Result<Vec<String>> {
    let table = strip_identifier_quotes(ident);
    let mut stmt = conn.prepare(
        "SELECT kcu.column_name \
         FROM information_schema.table_constraints tc \
         JOIN information_schema.key_column_usage kcu \
           ON tc.constraint_name = kcu.constraint_name \
          AND tc.table_schema = kcu.table_schema \
          AND tc.table_name = kcu.table_name \
         WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_name = ? \
         ORDER BY kcu.ordinal_position",
    )?;
    let names = stmt
        .query_map(duckdb::params![table], |r| r.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(names)
}

/// Like [`fetch_primary_key_for_ident`], but scoped to `schema` — used by
/// callers (e.g. [`DuckDbConn::list_indexes`]) that know exactly which schema
/// they're introspecting, so a same-named table in a different schema can't
/// leak its PK columns in.
fn fetch_primary_key_in_schema(
    conn: &duckdb::Connection,
    schema: &str,
    table: &str,
) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT kcu.column_name \
         FROM information_schema.table_constraints tc \
         JOIN information_schema.key_column_usage kcu \
           ON tc.constraint_name = kcu.constraint_name \
          AND tc.table_schema = kcu.table_schema \
          AND tc.table_name = kcu.table_name \
         WHERE tc.constraint_type = 'PRIMARY KEY' \
           AND tc.table_schema = ? AND tc.table_name = ? \
         ORDER BY kcu.ordinal_position",
    )?;
    let names = stmt
        .query_map(duckdb::params![schema, table], |r| r.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(names)
}

/// Every foreign-key relationship in `schema`, via the SQL-standard
/// `table_constraints` + `key_column_usage` + `referential_constraints`
/// join. Composite keys share `constraint_name`; `ordinal_position` pairs a
/// referencing column with its corresponding referenced column.
fn fetch_foreign_keys(conn: &duckdb::Connection, schema: &str) -> Result<Vec<ForeignKey>> {
    fetch_foreign_keys_where(conn, "tc.table_schema = ?", duckdb::params![schema])
}

/// Like [`fetch_foreign_keys`], but scoped to a single `table` — used by
/// [`DuckDbConn::columns`] so it doesn't have to pull (and then discard) every
/// other table's foreign keys in the schema just to look up one table's.
fn fetch_foreign_keys_for(
    conn: &duckdb::Connection,
    schema: &str,
    table: &str,
) -> Result<Vec<ForeignKey>> {
    fetch_foreign_keys_where(
        conn,
        "tc.table_schema = ? AND kcu.table_name = ?",
        duckdb::params![schema, table],
    )
}

fn fetch_foreign_keys_where(
    conn: &duckdb::Connection,
    extra_where: &str,
    params: &[&dyn duckdb::ToSql],
) -> Result<Vec<ForeignKey>> {
    let sql = format!(
        "SELECT kcu.table_name, kcu.column_name, ccu.table_name, ccu.column_name, \
                tc.constraint_name \
         FROM information_schema.table_constraints tc \
         JOIN information_schema.key_column_usage kcu \
           ON tc.constraint_name = kcu.constraint_name \
          AND tc.table_schema = kcu.table_schema \
         JOIN information_schema.referential_constraints rc \
           ON tc.constraint_name = rc.constraint_name \
          AND tc.table_schema = rc.constraint_schema \
         JOIN information_schema.key_column_usage ccu \
           ON rc.unique_constraint_name = ccu.constraint_name \
          AND rc.unique_constraint_schema = ccu.table_schema \
          AND kcu.ordinal_position = ccu.ordinal_position \
         WHERE tc.constraint_type = 'FOREIGN KEY' AND {extra_where} \
         ORDER BY kcu.table_name, tc.constraint_name, kcu.ordinal_position"
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut duck_rows = stmt.query(params)?;
    let mut out = Vec::new();
    while let Some(row) = duck_rows.next()? {
        out.push(ForeignKey {
            table: row.get(0)?,
            column: row.get(1)?,
            referenced_table: row.get(2)?,
            referenced_column: row.get::<_, Option<String>>(3)?,
            constraint_name: row.get::<_, Option<String>>(4)?,
        });
    }
    Ok(out)
}

/// Best-effort extraction of the target table from a mutation statement,
/// mirroring `db/sqlite.rs::extract_target_table`. Returns `None` for shapes
/// we don't confidently recognise.
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
            let next = iter.next()?;
            if !next.eq_ignore_ascii_case("into") {
                return None;
            }
            iter.next()
        }
        _ => None,
    }
}

/// Tokenizes `sql` keeping double-quoted identifiers intact, mirroring
/// `db/sqlite.rs::tokenize_sql`. DuckDB only recognises `"…"` for quoted
/// identifiers (no backtick support), but backticks are still treated as a
/// quote character here so a stray one can't split a token incorrectly.
fn tokenize_sql(sql: &str) -> Vec<String> {
    let cleaned = strip_sql_comments(sql);
    let mut tokens: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    for c in cleaned.chars() {
        if let Some(q) = quote {
            cur.push(c);
            if c == q {
                quote = None;
            }
        } else if c == '"' || c == '`' {
            cur.push(c);
            quote = Some(c);
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

fn strip_identifier_quotes(s: &str) -> String {
    let s = s.trim();
    if s.starts_with('"') && s.ends_with('"') && s.len() >= 2 {
        let inner = &s[1..s.len() - 1];
        return inner.replace("\"\"", "\"");
    }
    s.to_string()
}

/// Double-quotes a single identifier, doubling any embedded double quotes
/// (DuckDB's identifier-quoting rule, same as PostgreSQL/SQLite).
fn quote_ident(name: &str) -> String {
    super::sync::quote_ident(super::DriverKind::DuckDb, name)
}

/// Escapes a cell value as a DuckDB SQL string literal, or `NULL`. Used to
/// build inline-literal `INSERT` statements for bulk import (see module
/// docs) — DuckDB's standard-conforming strings mean only the embedded quote
/// needs doubling, same as PostgreSQL/SQLite.
fn duckdb_literal(cell: Option<&str>) -> String {
    match cell {
        None => "NULL".to_string(),
        Some(s) => format!("'{}'", s.replace('\'', "''")),
    }
}

/// Builds a multi-row `INSERT ... VALUES (...), (...)` with inline literals.
/// Shared by `import_rows`, `try_insert_chunk`, and `probe_failing_row`.
fn build_duckdb_insert(table: &str, columns: &[String], rows: &[Vec<Option<String>>]) -> String {
    let ncols = columns.len();
    let cols_sql = columns
        .iter()
        .map(|c| quote_ident(c))
        .collect::<Vec<_>>()
        .join(", ");
    let table_ident = quote_ident(table);
    let mut sql = format!("INSERT INTO {} ({}) VALUES ", table_ident, cols_sql);
    for (r, row) in rows.iter().enumerate() {
        if r > 0 {
            sql.push(',');
        }
        sql.push('(');
        for ci in 0..ncols {
            if ci > 0 {
                sql.push(',');
            }
            sql.push_str(&duckdb_literal(row.get(ci).and_then(|c| c.as_deref())));
        }
        sql.push(')');
    }
    sql
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_shape_recognises_plain_selects() {
        assert!(is_query_shape("SELECT * FROM t"));
        assert!(is_query_shape("  explain select 1"));
        assert!(is_query_shape("PRAGMA version"));
        assert!(is_query_shape("SUMMARIZE t"));
        assert!(is_query_shape("SHOW TABLES"));
    }

    #[test]
    fn query_shape_recognises_from_and_table_shorthand() {
        // #1054: `FROM`-first shorthand and `TABLE` are read-only per
        // `is_read_only_sql_masked` (#1005) but must also route through the
        // query path here, or the statement's rows are silently dropped.
        assert!(is_query_shape("FROM tbl"));
        assert!(is_query_shape("FROM tbl SELECT x"));
        assert!(is_query_shape("TABLE tbl"));
        // A plain `SELECT * FROM t` must still be recognised via the
        // `SELECT` branch, not be mistaken for `FROM`-first shorthand.
        assert!(is_query_shape("SELECT * FROM t"));
        // `FROMAGE` merely starts with the same 4 letters as `FROM`; the
        // word-boundary check in `starts_with_word` must not treat this
        // identifier-led (non-SQL) input as `FROM`-first shorthand.
        assert!(!is_query_shape("FROMAGE tbl"));
    }

    #[test]
    fn query_shape_treats_plain_dml_as_execute() {
        assert!(!is_query_shape("INSERT INTO t VALUES (1)"));
        assert!(!is_query_shape("UPDATE t SET x = 1"));
        assert!(!is_query_shape("DELETE FROM t WHERE id = 1"));
        assert!(!is_query_shape("CREATE TABLE t (id INT)"));
    }

    #[test]
    fn query_shape_keeps_with_select_as_query() {
        assert!(is_query_shape(
            "WITH cte AS (SELECT 1 AS n) SELECT * FROM cte"
        ));
    }

    #[test]
    fn query_shape_routes_with_dml_to_execute() {
        assert!(!is_query_shape(
            "WITH src AS (SELECT 1 AS id) INSERT INTO t SELECT * FROM src"
        ));
    }

    #[test]
    fn parses_basic_targets() {
        assert_eq!(
            extract_target_table("UPDATE users SET name = 'a' WHERE id = 1"),
            Some("users".into())
        );
        assert_eq!(
            extract_target_table("DELETE FROM orders WHERE id > 10"),
            Some("orders".into())
        );
        assert_eq!(
            extract_target_table("INSERT INTO products (name) VALUES ('x')"),
            Some("products".into())
        );
        assert!(extract_target_table("SELECT * FROM users").is_none());
    }

    #[test]
    fn strips_identifier_quotes() {
        assert_eq!(strip_identifier_quotes("\"users\""), "users");
        assert_eq!(strip_identifier_quotes("users"), "users");
        assert_eq!(strip_identifier_quotes("\"with\"\"quote\""), "with\"quote");
    }

    #[test]
    fn duckdb_literal_escapes_quotes_and_null() {
        assert_eq!(duckdb_literal(None), "NULL");
        assert_eq!(duckdb_literal(Some("a'b")), "'a''b'");
    }

    #[test]
    fn build_duckdb_insert_generates_multi_row_values() {
        // Every cell is always quoted as a text literal, even a
        // numeric-looking one like "1" — `build_duckdb_insert` relies on
        // DuckDB's implicit cast of an untyped string literal to the
        // destination column's type (module docs), it doesn't attempt to
        // detect numeric cells and emit them bare.
        let cols = vec!["id".to_string(), "name".to_string()];
        let rows = vec![
            vec![Some("1".to_string()), Some("a'b".to_string())],
            vec![None, Some("c".to_string())],
        ];
        assert_eq!(
            build_duckdb_insert("t", &cols, &rows),
            "INSERT INTO \"t\" (\"id\", \"name\") VALUES ('1','a''b'),(NULL,'c')"
        );
    }

    #[test]
    fn build_duckdb_insert_handles_no_rows() {
        let cols = vec!["id".to_string()];
        assert_eq!(
            build_duckdb_insert("t", &cols, &[]),
            "INSERT INTO \"t\" (\"id\") VALUES "
        );
    }

    #[test]
    fn format_date32_renders_ymd() {
        assert_eq!(format_date32(0), "1970-01-01");
        assert_eq!(format_date32(365), "1971-01-01");
        assert_eq!(format_date32(-1), "1969-12-31");
    }

    #[test]
    fn format_time64_renders_hms_micros() {
        use duckdb::types::TimeUnit;
        // 1h 1m 1.5s = 3661.5s = 3_661_500_000 microseconds.
        assert_eq!(
            format_time64(TimeUnit::Microsecond, 3_661_500_000),
            "01:01:01.500000"
        );
        assert_eq!(format_time64(TimeUnit::Second, 0), "00:00:00.000000");
    }

    #[test]
    fn format_timestamp_renders_date_and_time() {
        use duckdb::types::TimeUnit;
        assert_eq!(
            format_timestamp(TimeUnit::Microsecond, 0),
            "1970-01-01 00:00:00.000000"
        );
        // 90061.25s after epoch = 1970-01-02 01:01:01.25.
        assert_eq!(
            format_timestamp(TimeUnit::Microsecond, 90_061_250_000),
            "1970-01-02 01:01:01.250000"
        );
    }

    #[test]
    fn format_interval_renders_components() {
        assert_eq!(format_interval(1, 2, 3), "1mon 2d 3ns");
        assert_eq!(format_interval(0, 0, 0), "0mon 0d 0ns");
    }

    /// A `HugeInt`/`UHugeInt` nested inside a container (LIST/STRUCT/ARRAY/
    /// MAP) that doesn't fit in i64/u64 must fall back to a JSON *string* of
    /// the exact value, not silently saturate to `0` (#899 review nitpick —
    /// `0` would be actively misleading, unlike a string that preserves the
    /// real value even though it's no longer a JSON number).
    #[test]
    fn json_stringify_preserves_out_of_range_huge_ints_in_containers() {
        let huge = i128::MAX;
        let list = DuckValue::List(vec![DuckValue::HugeInt(huge)]);
        assert_eq!(json_stringify(&list), format!("[\"{huge}\"]"));

        let huge_u = u128::MAX;
        let list_u = DuckValue::List(vec![DuckValue::UHugeInt(huge_u)]);
        assert_eq!(json_stringify(&list_u), format!("[\"{huge_u}\"]"));

        // In-range values still render as plain JSON numbers.
        let list_small = DuckValue::List(vec![DuckValue::HugeInt(42)]);
        assert_eq!(json_stringify(&list_small), "[42]");
    }

    #[test]
    fn sql_type_names_match_duckdb_keywords() {
        assert_eq!(duckdb_sql_type_name(&DuckType::Text), "VARCHAR");
        assert_eq!(duckdb_sql_type_name(&DuckType::BigInt), "BIGINT");
        assert_eq!(duckdb_sql_type_name(&DuckType::Date32), "DATE");
        assert_eq!(duckdb_sql_type_name(&DuckType::Time64), "TIME");
        assert_eq!(duckdb_sql_type_name(&DuckType::Boolean), "BOOLEAN");
    }

    #[test]
    fn value_conversion_maps_common_scalars() {
        assert_eq!(duckdb_value_to_value(DuckValue::Null), Value::Null);
        assert_eq!(
            duckdb_value_to_value(DuckValue::Boolean(true)),
            Value::Bool(true)
        );
        assert_eq!(duckdb_value_to_value(DuckValue::BigInt(42)), Value::Int(42));
        assert_eq!(
            duckdb_value_to_value(DuckValue::Text("hi".into())),
            Value::String("hi".into())
        );
        // `u64::MAX` is nowhere near JS's safe integer range (2^53-1), so —
        // unlike the old unconditional `Value::UInt` mapping — this must now
        // fall back to an exact decimal string (#precision).
        assert_eq!(
            duckdb_value_to_value(DuckValue::UBigInt(u64::MAX)),
            Value::String(u64::MAX.to_string())
        );
    }

    /// #precision: BIGINT/UBIGINT/HUGEINT/UHUGEINT must stay lossless across
    /// JS's `Number.MAX_SAFE_INTEGER` (2^53-1) boundary — narrower than each
    /// type's own native range (`i64`/`u64`/`i128`/`u128`), so a value can
    /// fit comfortably in the DuckDB type yet still need to fall back to a
    /// string. Mirrors `Value::from_*_lossless`'s own boundary tests in
    /// `db/types.rs`, applied through the DuckDB decode path specifically.
    #[test]
    fn value_conversion_stays_lossless_across_js_safe_boundary() {
        const MAX_SAFE: i64 = 9_007_199_254_740_991;

        // BIGINT: exactly at the boundary stays a number; one past it (still
        // comfortably an `i64`) must become a string.
        assert_eq!(
            duckdb_value_to_value(DuckValue::BigInt(MAX_SAFE)),
            Value::Int(MAX_SAFE)
        );
        assert_eq!(
            duckdb_value_to_value(DuckValue::BigInt(MAX_SAFE + 1)),
            Value::String((MAX_SAFE + 1).to_string())
        );
        assert_eq!(
            duckdb_value_to_value(DuckValue::BigInt(-(MAX_SAFE + 1))),
            Value::String((-(MAX_SAFE + 1)).to_string())
        );

        // UBIGINT: same boundary, unsigned side.
        assert_eq!(
            duckdb_value_to_value(DuckValue::UBigInt(MAX_SAFE as u64)),
            Value::UInt(MAX_SAFE as u64)
        );
        assert_eq!(
            duckdb_value_to_value(DuckValue::UBigInt(MAX_SAFE as u64 + 1)),
            Value::String((MAX_SAFE as u64 + 1).to_string())
        );

        // HUGEINT: a value that fits comfortably in `i64` (so the *old*
        // "does it fit in i64" threshold would have kept it a number) but
        // exceeds 2^53 must still fall back to a string under the new,
        // narrower threshold.
        let hugeint_in_i64_but_unsafe = (MAX_SAFE as i128) + 1;
        assert_eq!(
            duckdb_value_to_value(DuckValue::HugeInt(hugeint_in_i64_but_unsafe)),
            Value::String(hugeint_in_i64_but_unsafe.to_string())
        );
        assert_eq!(
            duckdb_value_to_value(DuckValue::HugeInt(MAX_SAFE as i128)),
            Value::Int(MAX_SAFE)
        );

        // UHUGEINT: same "fits in u64 but exceeds 2^53" case.
        let uhugeint_in_u64_but_unsafe = (MAX_SAFE as u128) + 1;
        assert_eq!(
            duckdb_value_to_value(DuckValue::UHugeInt(uhugeint_in_u64_but_unsafe)),
            Value::String(uhugeint_in_u64_but_unsafe.to_string())
        );
        assert_eq!(
            duckdb_value_to_value(DuckValue::UHugeInt(MAX_SAFE as u128)),
            Value::UInt(MAX_SAFE as u64)
        );
    }

    #[test]
    fn value_conversion_falls_back_for_huge_ints() {
        let huge = i128::MAX;
        assert_eq!(
            duckdb_value_to_value(DuckValue::HugeInt(huge)),
            Value::String(huge.to_string())
        );
    }
}
