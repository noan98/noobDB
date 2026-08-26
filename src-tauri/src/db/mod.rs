pub mod advisor;
pub mod data_diff;
pub mod diff;
pub mod duckdb;
pub mod format;
pub mod mssql;
pub mod mysql;
pub mod postgres;
/// ドライラン (プレビュー) のスナップショット取得を組み立てる共有ロジック。
/// ドライバ非依存の純粋な文字列処理なので、各ドライバの
/// `preview_execute_with_limit` から共有する (#preview-parity)。
pub mod preview;
pub mod privileges;
pub mod sandbox;
pub mod sqlite;
pub mod sync;
pub mod types;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};
use advisor::UnusedIndexStats;
use types::{
    Column, DbUserInfo, ForeignKey, IndexInfo, LiveQuery, LocalTableMeta, PreviewResult,
    ProcessInfo, QueryResult, QueryStatsSupport, SchemaObject, ServerInfo, ServerMetrics,
    StatementStat, StreamBatch, TableColumnInfo, TableRowEstimate, TableRowIdentity, TableSchema,
    TableSizeInfo, UserPrivileges, Value,
};

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
    /// TLS requirement level. `None` leaves the driver default untouched
    /// (sqlx defaults to `prefer`/`preferred`), preserving the behavior of
    /// profiles saved before TLS settings existed. Ignored by SQLite.
    #[serde(default)]
    pub ssl_mode: Option<SslMode>,
    /// Path to a CA (root) certificate used to verify the server certificate
    /// (PEM). Required for `verify_ca` / `verify_full` against a private CA.
    #[serde(default)]
    pub ssl_root_cert: Option<String>,
    /// Path to the client certificate (PEM) for mutual TLS (mTLS).
    #[serde(default)]
    pub ssl_client_cert: Option<String>,
    /// Path to the client private key (PEM) for mutual TLS (mTLS).
    #[serde(default)]
    pub ssl_client_key: Option<String>,
    /// Session-initialization SQL run on every physical pool connection right
    /// after it is established (via sqlx `after_connect`). May contain multiple
    /// `;`-separated statements. `None`/empty runs nothing. Must pass
    /// [`is_session_init_sql`] (SET / PRAGMA / read-only only). Non-secret.
    #[serde(default)]
    pub init_sql: Option<String>,
}

/// Driver-neutral TLS requirement level. Each driver's `connect` maps this to
/// its own sqlx enum (`PgSslMode` / `MySqlSslMode`). The variants are ordered
/// from least to most strict.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SslMode {
    /// Never use TLS (plaintext only).
    Disable,
    /// Use TLS when the server offers it, fall back to plaintext otherwise.
    /// No certificate verification. Matches the sqlx default.
    Prefer,
    /// Require TLS but do not verify the server certificate.
    Require,
    /// Require TLS and verify the server certificate against the CA.
    VerifyCa,
    /// Require TLS, verify the CA, and verify the server hostname (SAN).
    VerifyFull,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DriverKind {
    Mysql,
    Postgres,
    Sqlite,
    /// DuckDB (#709): a file-backed analytical database, addressed the same
    /// way as SQLite (`file_path`, no host/port/user/password, no SSH/TLS).
    /// `rename_all = "lowercase"` above already serializes this as `"duckdb"`.
    DuckDb,
    /// Microsoft SQL Server (#729). Backed by `tiberius` rather than `sqlx` —
    /// see `db/mssql.rs` for the driver module and `AppError::Mssql` for the
    /// dedicated error variant.
    Mssql,
}

impl DriverKind {
    /// Lowercase wire name, matching the serde representation. Used when
    /// persisting the driver alongside query history.
    pub fn as_str(&self) -> &'static str {
        match self {
            DriverKind::Mysql => "mysql",
            DriverKind::Postgres => "postgres",
            DriverKind::Sqlite => "sqlite",
            DriverKind::DuckDb => "duckdb",
            DriverKind::Mssql => "mssql",
        }
    }

    /// Parses the wire name back into a [`DriverKind`]. The inverse of
    /// [`DriverKind::as_str`]. Used by the flight recorder (#735) to validate
    /// that a stored capture's driver still matches the session it is being
    /// undone against before trusting its literals/escaping.
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "mysql" => Some(DriverKind::Mysql),
            "postgres" => Some(DriverKind::Postgres),
            "sqlite" => Some(DriverKind::Sqlite),
            "duckdb" => Some(DriverKind::DuckDb),
            "mssql" => Some(DriverKind::Mssql),
            _ => None,
        }
    }
}

/// Coarse classification of a single write statement's shape (#735 DML flight
/// recorder). Not a general-purpose SQL classifier — it only distinguishes the
/// three DML kinds the recorder knows how to capture a before/after image for
/// and reverse; everything else (`SELECT`, DDL, stacked statements, `REPLACE`,
/// ...) is `Other`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WriteKind {
    Insert,
    Update,
    Delete,
    Other,
}

/// Classifies `sql` per [`WriteKind`]. Comments and string/quoted-identifier
/// literals are masked first (same masking rules as [`is_read_only_sql`]),
/// and a statement packing more than one SQL statement
/// ([`has_stacked_statements`]) is always `Other` — the flight recorder only
/// ever captures a single, unambiguous write.
///
/// **Driver-less entry point**: masks conservatively (#852). `Other` means
/// "don't capture", so a mis-read can only cost a capture, never produce a
/// wrong one. Callers holding a session use [`classify_write_kind_for`].
pub fn classify_write_kind(sql: &str) -> WriteKind {
    if has_stacked_statements(sql) {
        return WriteKind::Other;
    }
    let orig: Vec<char> = sql.chars().collect();
    classify_write_kind_masked(&mask_for_analysis_conservative(&orig))
}

/// Driver-aware entry point for [`classify_write_kind`] (#852), so a MySQL
/// write using `\'` inside a literal still classifies (and stays capturable)
/// while the other dialects are analysed with their own escaping rules.
pub fn classify_write_kind_for(driver: DriverKind, sql: &str) -> WriteKind {
    if has_stacked_statements_for(driver, sql) {
        return WriteKind::Other;
    }
    let orig: Vec<char> = sql.chars().collect();
    classify_write_kind_masked(&mask_for_driver(driver, &orig))
}

/// Leading-keyword half of [`classify_write_kind`]; the stacked-statement
/// rejection happens in the two entry points so each can use its own flavour.
fn classify_write_kind_masked(masked: &[char]) -> WriteKind {
    let masked_lower: String = masked.iter().collect::<String>().to_ascii_lowercase();
    let body = masked_lower.trim();
    if starts_with_word(body, "insert") {
        WriteKind::Insert
    } else if starts_with_word(body, "update") {
        WriteKind::Update
    } else if starts_with_word(body, "delete") {
        WriteKind::Delete
    } else {
        WriteKind::Other
    }
}

/// Default per-statement row cap for flight-recorder capture (#735) when the
/// caller doesn't specify one. Mirrors the retention-row-count style default
/// elsewhere in the codebase (e.g. history's `MAX_HISTORY_ROWS`) but scoped to
/// a single write's affected-row window rather than total stored rows.
pub const DEFAULT_CAPTURE_ROW_CAP: usize = 10_000;

/// Result of attempting to capture a reversible before/after image around one
/// write statement (#735 DML flight recorder). Always returned alongside the
/// real [`QueryResult`] from [`Connection::capture_write`] — a capture that
/// fails (unresolvable target table/PK, row count over the cap, ...) never
/// blocks the write itself, since this is a best-effort safety net layered on
/// top of the existing read-only guard, not a transactional guarantee.
#[derive(Debug, Clone)]
pub struct WriteCapture {
    pub kind: WriteKind,
    pub capturable: bool,
    /// Human-readable (Japanese) reason when `capturable` is false.
    pub reason: Option<String>,
    pub table: Option<String>,
    pub primary_key: Vec<String>,
    pub columns: Vec<String>,
    pub column_types: Vec<String>,
    /// Rows removed/changed, keyed by primary key. Empty for `Insert`.
    pub before_rows: Vec<Vec<Value>>,
    /// Rows added/changed, keyed by primary key. Empty for `Delete`.
    pub after_rows: Vec<Vec<Value>>,
    pub rows_affected: u64,
}

impl WriteCapture {
    fn not_capturable(kind: WriteKind, reason: impl Into<String>) -> Self {
        WriteCapture {
            kind,
            capturable: false,
            reason: Some(reason.into()),
            table: None,
            primary_key: Vec::new(),
            columns: Vec::new(),
            column_types: Vec::new(),
            before_rows: Vec::new(),
            after_rows: Vec::new(),
            rows_affected: 0,
        }
    }

    fn not_capturable_with_meta(
        kind: WriteKind,
        reason: impl Into<String>,
        dry: &PreviewResult,
    ) -> Self {
        WriteCapture {
            kind,
            capturable: false,
            reason: Some(reason.into()),
            table: dry.target_table.clone(),
            primary_key: dry.primary_key.clone(),
            columns: dry.columns.iter().map(|c| c.name.clone()).collect(),
            column_types: dry.columns.iter().map(|c| c.type_name.clone()).collect(),
            before_rows: Vec::new(),
            after_rows: Vec::new(),
            rows_affected: 0,
        }
    }
}

/// Tagged signature of a row's values, used to tell whether the same physical
/// row appears in two row sets (e.g. an INSERT's before/after LIMIT-window
/// scan). Mirrors `data_diff`'s private `key_signature` helper; kept as a
/// separate copy here rather than exposing that one, since the two call sites
/// have no other coupling.
fn row_signature(values: &[Value]) -> String {
    values
        .iter()
        .map(|v| format!("{v:?}"))
        .collect::<Vec<_>>()
        .join("\u{1f}")
}

/// Returns the trimmed session-init SQL when present and it contains at least
/// one real statement, so drivers only attach an `after_connect` hook when there
/// is something to run. Comment-only / separator-only input (e.g. `-- note` or
/// `  ;  ;`) — which [`is_session_init_sql`] accepts as "runs nothing" — is
/// normalized to `None` here, so no empty statement is ever sent (MySQL rejects
/// an empty query with "Query was empty").
pub(crate) fn init_sql_of(opts: &DbConnectOptions) -> Option<String> {
    let sql = opts
        .init_sql
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())?;
    // Mask comments / string literals, then require a non-empty statement
    // between the `;` separators. Uses the same conservative mask as
    // [`is_session_init_sql`], so the "is there anything to run?" question and
    // the "is it allowed?" question always split the input the same way.
    let masked = mask_for_analysis_conservative(&sql.chars().collect::<Vec<_>>());
    let has_statement = masked
        .iter()
        .collect::<String>()
        .split(';')
        .any(|stmt| !stmt.trim().is_empty());
    has_statement.then(|| sql.to_string())
}

/// Dispatch enum. Adding a new DB is a new variant + a new module.
pub enum Connection {
    MySql(mysql::MySqlConn),
    Postgres(postgres::PostgresConn),
    Sqlite(sqlite::SqliteConn),
    // Boxed: `DuckDbConn` carries a `std::sync::Mutex<duckdb::Connection>` +
    // a `tokio::sync::Mutex<Option<duckdb::Connection>>` inline, which makes
    // it noticeably larger than the sqlx-backed variants —
    // `clippy::large_enum_variant` flags the resulting padding on every
    // `Connection` value (Windows clippy catches this; Linux's build didn't
    // regress but the lint is architecture-independent).
    DuckDb(Box<duckdb::DuckDbConn>),
    // Boxed: `MssqlConn` embeds `tiberius::Client`'s TDS connection state
    // directly (no internal `Arc`/pool indirection at the top level like the
    // sqlx-backed drivers), making it far larger than the other three
    // variants — `clippy::large_enum_variant` flags the resulting padding on
    // every `Connection` value.
    Mssql(Box<mssql::MssqlConn>),
}

/// A single row skipped by a resilient (skip-mode) import: its 0-based index
/// among the parsed data records and the driver's rejection reason (#687). The
/// command layer maps `index` to a 1-based record number and, for CSV/NDJSON, a
/// source line before surfacing it to the UI.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SkippedRow {
    pub index: usize,
    pub reason: String,
}

/// Result of a resilient (skip-mode) import: how many rows were inserted and
/// which were skipped (#687).
#[derive(Debug, Clone)]
pub struct ImportOutcome {
    pub inserted: u64,
    pub skipped: Vec<SkippedRow>,
}

impl Connection {
    /// The driver backing this connection.
    pub fn driver_kind(&self) -> DriverKind {
        match self {
            Connection::MySql(_) => DriverKind::Mysql,
            Connection::Postgres(_) => DriverKind::Postgres,
            Connection::Sqlite(_) => DriverKind::Sqlite,
            Connection::DuckDb(_) => DriverKind::DuckDb,
            Connection::Mssql(_) => DriverKind::Mssql,
        }
    }

    pub async fn connect(opts: &DbConnectOptions) -> Result<Self> {
        match opts.driver {
            DriverKind::Mysql => Ok(Connection::MySql(mysql::MySqlConn::connect(opts).await?)),
            DriverKind::Postgres => Ok(Connection::Postgres(
                postgres::PostgresConn::connect(opts).await?,
            )),
            DriverKind::Sqlite => Ok(Connection::Sqlite(sqlite::SqliteConn::connect(opts).await?)),
            DriverKind::DuckDb => Ok(Connection::DuckDb(Box::new(
                duckdb::DuckDbConn::connect(opts).await?,
            ))),
            DriverKind::Mssql => Ok(Connection::Mssql(Box::new(
                mssql::MssqlConn::connect(opts).await?,
            ))),
        }
    }

    pub async fn execute(&self, sql: &str, database: Option<&str>) -> Result<QueryResult> {
        match self {
            Connection::MySql(c) => c.execute(sql, database).await,
            Connection::Postgres(c) => c.execute(sql, database).await,
            Connection::Sqlite(c) => c.execute(sql, database).await,
            Connection::DuckDb(c) => c.execute(sql, database).await,
            Connection::Mssql(c) => c.execute(sql, database).await,
        }
    }

    /// Begin an explicit transaction on a dedicated held connection so
    /// subsequent `execute_in_transaction` calls all run on the same connection
    /// (and thus the same transaction). `database` sets the connection's
    /// default schema/db context. Errs if a transaction is already active.
    pub async fn begin_transaction(&self, database: Option<&str>) -> Result<()> {
        match self {
            Connection::MySql(c) => c.tx_begin(database).await,
            Connection::Postgres(c) => c.tx_begin(database).await,
            Connection::Sqlite(c) => c.tx_begin(database).await,
            Connection::DuckDb(c) => c.tx_begin(database).await,
            Connection::Mssql(c) => c.tx_begin(database).await,
        }
    }

    /// Run one statement inside the active explicit transaction. Errs if
    /// no transaction is active.
    pub async fn execute_in_transaction(&self, sql: &str) -> Result<QueryResult> {
        match self {
            Connection::MySql(c) => c.tx_execute(sql).await,
            Connection::Postgres(c) => c.tx_execute(sql).await,
            Connection::Sqlite(c) => c.tx_execute(sql).await,
            Connection::DuckDb(c) => c.tx_execute(sql).await,
            Connection::Mssql(c) => c.tx_execute(sql).await,
        }
    }

    /// Commit (`true`) or roll back (`false`) the active explicit transaction
    /// and release the held connection. Errs if none is active.
    pub async fn finish_transaction(&self, commit: bool) -> Result<()> {
        match self {
            Connection::MySql(c) => c.tx_finish(commit).await,
            Connection::Postgres(c) => c.tx_finish(commit).await,
            Connection::Sqlite(c) => c.tx_finish(commit).await,
            Connection::DuckDb(c) => c.tx_finish(commit).await,
            Connection::Mssql(c) => c.tx_finish(commit).await,
        }
    }

    /// Whether an explicit transaction is currently active.
    pub async fn transaction_active(&self) -> bool {
        match self {
            Connection::MySql(c) => c.tx_active().await,
            Connection::Postgres(c) => c.tx_active().await,
            Connection::Sqlite(c) => c.tx_active().await,
            Connection::DuckDb(c) => c.tx_active().await,
            Connection::Mssql(c) => c.tx_active().await,
        }
    }

    /// Lightweight connection liveness check: runs `SELECT 1` through the
    /// normal execute path (which dispatches per driver). Returns `Err` when the
    /// connection is dead — e.g. after an OS sleep or a dropped SSH tunnel — so
    /// callers can decide to reconnect. Cheap enough to run before a query or on
    /// window-focus.
    pub async fn health_check(&self) -> Result<()> {
        self.execute("SELECT 1", None).await.map(|_| ())
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
            Connection::DuckDb(c) => c.preview_execute_with_limit(sql, database, row_limit).await,
            Connection::Mssql(c) => c.preview_execute_with_limit(sql, database, row_limit).await,
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
            Connection::DuckDb(c) => {
                c.execute_stream(sql, database, initial_batch, chunk_size, on_batch)
                    .await
            }
            Connection::Mssql(c) => {
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
            Connection::DuckDb(c) => {
                c.import_rows(database, table, columns, rows, batch_size, on_progress)
                    .await
            }
            Connection::Mssql(c) => {
                c.import_rows(database, table, columns, rows, batch_size, on_progress)
                    .await
            }
        }
    }

    /// Insert one chunk of `rows` as a single auto-committed multi-row INSERT
    /// (no wrapping cross-chunk transaction), erroring atomically. The resilient
    /// skip-mode import (`import_rows_skipping`) uses this: a chunk that commits
    /// stays committed, and a chunk that fails is retried row by row (#687).
    pub(crate) async fn try_insert_chunk(
        &self,
        database: Option<&str>,
        table: &str,
        columns: &[String],
        rows: &[Vec<Option<String>>],
    ) -> Result<()> {
        match self {
            Connection::MySql(c) => c.try_insert_chunk(database, table, columns, rows).await,
            Connection::Postgres(c) => c.try_insert_chunk(database, table, columns, rows).await,
            Connection::Sqlite(c) => c.try_insert_chunk(database, table, columns, rows).await,
            Connection::DuckDb(c) => c.try_insert_chunk(database, table, columns, rows).await,
            Connection::Mssql(c) => c.try_insert_chunk(database, table, columns, rows).await,
        }
    }

    /// Find the first row in `rows` that the driver rejects, returning its
    /// 0-based index and the error text — **without persisting anything** (the
    /// rows are inserted one by one into a transaction that is always rolled
    /// back). Used by the abort-mode import to pinpoint which record caused an
    /// all-or-nothing failure (#687). Returns `None` if every row inserts (which
    /// shouldn't happen when called after a real failure, but is handled safely).
    pub async fn probe_failing_row(
        &self,
        database: Option<&str>,
        table: &str,
        columns: &[String],
        rows: &[Vec<Option<String>>],
    ) -> Result<Option<(usize, String)>> {
        match self {
            Connection::MySql(c) => c.probe_failing_row(database, table, columns, rows).await,
            Connection::Postgres(c) => c.probe_failing_row(database, table, columns, rows).await,
            Connection::Sqlite(c) => c.probe_failing_row(database, table, columns, rows).await,
            Connection::DuckDb(c) => c.probe_failing_row(database, table, columns, rows).await,
            Connection::Mssql(c) => c.probe_failing_row(database, table, columns, rows).await,
        }
    }

    /// Whether `table` supports transactional DML (rollback). Only MySQL has
    /// non-transactional storage engines (MyISAM etc.); PostgreSQL and SQLite are
    /// always transactional. Used to keep the resilient-import probe/retry paths
    /// off tables where a rollback wouldn't undo their side effects (#687 review
    /// follow-up).
    pub async fn table_is_transactional(
        &self,
        database: Option<&str>,
        table: &str,
    ) -> Result<bool> {
        match self {
            Connection::MySql(c) => c.table_is_transactional(database, table).await,
            Connection::Postgres(_)
            | Connection::Sqlite(_)
            | Connection::DuckDb(_)
            | Connection::Mssql(_) => Ok(true),
        }
    }

    /// Resilient bulk insert that **skips** rows the driver rejects instead of
    /// aborting the whole import (#687). Not all-or-nothing: each chunk is
    /// auto-committed; a chunk that fails is retried row by row so only the bad
    /// rows are dropped. Returns the inserted count and the list of skipped rows
    /// (0-based index + reason). `on_progress` receives the cumulative inserted
    /// count after each chunk.
    pub async fn import_rows_skipping<F>(
        &self,
        database: Option<&str>,
        table: &str,
        columns: &[String],
        rows: &[Vec<Option<String>>],
        batch_size: usize,
        mut on_progress: F,
    ) -> Result<ImportOutcome>
    where
        F: FnMut(u64) -> Result<()>,
    {
        if columns.is_empty() {
            return Err(AppError::InvalidInput("no columns to import".into()));
        }
        // Non-transactional engines (MyISAM etc.) can't roll back a partially
        // applied multi-row INSERT, so a failed chunk may leave some rows
        // committed — and the per-row retry below would then re-insert (i.e.
        // duplicate) them. Force single-row inserts there: a one-row INSERT is
        // atomic even on MyISAM, so a failure affects only that row and the
        // single-row fast-path records it without any retry. (#687 review
        // follow-up.) A query error defaults to transactional (InnoDB is the
        // overwhelming default), preserving the batched happy path.
        let transactional = self
            .table_is_transactional(database, table)
            .await
            .unwrap_or(true);
        // Cap the batch modestly: a chunk that still exceeds a driver's
        // statement/placeholder limit just fails and falls back to per-row, so
        // correctness never depends on this bound — it only keeps the happy path
        // in reasonably sized batches.
        let batch = if transactional { batch_size } else { 1 }.clamp(1, 500);
        let mut inserted: u64 = 0;
        let mut skipped: Vec<SkippedRow> = Vec::new();
        for (chunk_idx, chunk) in rows.chunks(batch).enumerate() {
            let start = chunk_idx * batch;
            match self.try_insert_chunk(database, table, columns, chunk).await {
                Ok(()) => inserted += chunk.len() as u64,
                // A single-row chunk can't be narrowed further, so record it
                // directly instead of re-issuing the same failing INSERT.
                Err(e) if chunk.len() == 1 => skipped.push(SkippedRow {
                    index: start,
                    reason: e.to_string(),
                }),
                Err(_) => {
                    // Isolate the bad rows: retry each row on its own. Good rows
                    // commit; failures are recorded and skipped.
                    for (i, row) in chunk.iter().enumerate() {
                        match self
                            .try_insert_chunk(database, table, columns, std::slice::from_ref(row))
                            .await
                        {
                            Ok(()) => inserted += 1,
                            Err(e) => skipped.push(SkippedRow {
                                index: start + i,
                                reason: e.to_string(),
                            }),
                        }
                    }
                }
            }
            on_progress(inserted)?;
        }
        Ok(ImportOutcome { inserted, skipped })
    }

    /// Runs `statements` sequentially inside a single transaction, rolling
    /// back the whole batch if any one fails (all-or-nothing). Returns the
    /// total `rows_affected` across all statements. Used by the inline
    /// cell-edit Apply path so a mid-batch failure can't leave earlier
    /// UPDATEs committed.
    pub async fn execute_transaction(
        &self,
        statements: &[String],
        database: Option<&str>,
    ) -> Result<u64> {
        match self {
            Connection::MySql(c) => c.execute_transaction(statements, database).await,
            Connection::Postgres(c) => c.execute_transaction(statements, database).await,
            Connection::Sqlite(c) => c.execute_transaction(statements, database).await,
            Connection::DuckDb(c) => c.execute_transaction(statements, database).await,
            Connection::Mssql(c) => c.execute_transaction(statements, database).await,
        }
    }

    pub async fn databases(&self) -> Result<Vec<String>> {
        match self {
            Connection::MySql(c) => c.databases().await,
            Connection::Postgres(c) => c.databases().await,
            Connection::Sqlite(c) => c.databases().await,
            Connection::DuckDb(c) => c.databases().await,
            Connection::Mssql(c) => c.databases().await,
        }
    }

    pub async fn tables(&self, db: &str) -> Result<Vec<String>> {
        match self {
            Connection::MySql(c) => c.tables(db).await,
            Connection::Postgres(c) => c.tables(db).await,
            Connection::Sqlite(c) => c.tables(db).await,
            Connection::DuckDb(c) => c.tables(db).await,
            Connection::Mssql(c) => c.tables(db).await,
        }
    }

    pub async fn columns(&self, db: &str, table: &str) -> Result<Vec<TableColumnInfo>> {
        match self {
            Connection::MySql(c) => c.columns(db, table).await,
            Connection::Postgres(c) => c.columns(db, table).await,
            Connection::Sqlite(c) => c.columns(db, table).await,
            Connection::DuckDb(c) => c.columns(db, table).await,
            Connection::Mssql(c) => c.columns(db, table).await,
        }
    }

    /// Row identity strategy for inline editing when a table has no usable
    /// primary key (#849) — see [`TableRowIdentity`] for what each driver
    /// reports and why.
    pub async fn row_identity(&self, db: &str, table: &str) -> Result<TableRowIdentity> {
        match self {
            Connection::MySql(c) => c.row_identity(db, table).await,
            Connection::Postgres(c) => c.row_identity(db, table).await,
            Connection::Sqlite(c) => c.row_identity(db, table).await,
            Connection::DuckDb(c) => c.row_identity(db, table).await,
            Connection::Mssql(c) => c.row_identity(db, table).await,
        }
    }

    /// Every table (and view) in `db` paired with its column names, fetched in
    /// one round trip where the driver allows it. Feeds whole-schema editor
    /// autocomplete; prefer this over looping `tables` + `columns` from the
    /// frontend, which is N+1 and slow on large schemas.
    pub async fn schema_overview(&self, db: &str) -> Result<Vec<TableSchema>> {
        match self {
            Connection::MySql(c) => c.schema_overview(db).await,
            Connection::Postgres(c) => c.schema_overview(db).await,
            Connection::Sqlite(c) => c.schema_overview(db).await,
            Connection::DuckDb(c) => c.schema_overview(db).await,
            Connection::Mssql(c) => c.schema_overview(db).await,
        }
    }

    /// Every foreign-key relationship in `db`, used to draw ER-diagram edges.
    /// One entry per referencing column; the columns of a composite key share a
    /// `constraint_name` so the UI can fold them into a single edge. Fetched in
    /// one round trip on MySQL/PostgreSQL; SQLite loops `PRAGMA foreign_key_list`
    /// per table (cheap on a local file).
    pub async fn foreign_keys(&self, db: &str) -> Result<Vec<ForeignKey>> {
        match self {
            Connection::MySql(c) => c.foreign_keys(db).await,
            Connection::Postgres(c) => c.foreign_keys(db).await,
            Connection::Sqlite(c) => c.foreign_keys(db).await,
            Connection::DuckDb(c) => c.foreign_keys(db).await,
            Connection::Mssql(c) => c.foreign_keys(db).await,
        }
    }

    /// Non-table schema objects in `db`: views, materialized views,
    /// routines (procedures/functions), and triggers. Dispatches per driver to
    /// `information_schema` / `pg_catalog` / `sqlite_master`. Kinds the driver
    /// doesn't support (e.g. SQLite routines) are simply absent.
    pub async fn schema_objects(&self, db: &str) -> Result<Vec<SchemaObject>> {
        match self {
            Connection::MySql(c) => c.schema_objects(db).await,
            Connection::Postgres(c) => c.schema_objects(db).await,
            Connection::Sqlite(c) => c.schema_objects(db).await,
            Connection::DuckDb(c) => c.schema_objects(db).await,
            Connection::Mssql(c) => c.schema_objects(db).await,
        }
    }

    /// The DDL/definition of a non-table schema object. `kind`/`name` are
    /// from [`schema_objects`]; `id` is the optional unique identifier (PostgreSQL
    /// oid) used to disambiguate overloaded functions / same-name triggers.
    pub async fn object_definition(
        &self,
        db: &str,
        kind: &str,
        name: &str,
        id: Option<&str>,
    ) -> Result<String> {
        match self {
            Connection::MySql(c) => c.object_definition(db, kind, name).await,
            Connection::Postgres(c) => c.object_definition(db, kind, name, id).await,
            Connection::Sqlite(c) => c.object_definition(db, kind, name).await,
            Connection::DuckDb(c) => c.object_definition(db, kind, name).await,
            Connection::Mssql(c) => c.object_definition(db, kind, name).await,
        }
    }

    /// Every index on `table` in `db`: name, constituent columns (in
    /// order), and UNIQUE / PRIMARY flags. Dispatches per driver — MySQL uses
    /// `SHOW INDEX`, PostgreSQL reads `pg_index`/`pg_class`, SQLite loops
    /// `PRAGMA index_list` + `PRAGMA index_info`.
    pub async fn list_indexes(&self, db: &str, table: &str) -> Result<Vec<IndexInfo>> {
        match self {
            Connection::MySql(c) => c.list_indexes(db, table).await,
            Connection::Postgres(c) => c.list_indexes(db, table).await,
            Connection::Sqlite(c) => c.list_indexes(db, table).await,
            Connection::DuckDb(c) => c.list_indexes(db, table).await,
            Connection::Mssql(c) => c.list_indexes(db, table).await,
        }
    }

    /// Approximate row counts for every base table in `db`, read from the
    /// engine's statistics catalogs rather than a `COUNT(*)` scan, so it stays
    /// cheap on large schemas. Values are approximate and may be stale or
    /// absent until the engine has gathered statistics (see
    /// [`TableRowEstimate`]). Views are omitted. SQLite has no such cheap
    /// statistic and returns an empty list.
    pub async fn table_row_estimates(&self, db: &str) -> Result<Vec<TableRowEstimate>> {
        match self {
            Connection::MySql(c) => c.table_row_estimates(db).await,
            Connection::Postgres(c) => c.table_row_estimates(db).await,
            Connection::Sqlite(c) => c.table_row_estimates(db).await,
            Connection::DuckDb(c) => c.table_row_estimates(db).await,
            Connection::Mssql(c) => c.table_row_estimates(db).await,
        }
    }

    /// Size and row statistics for every base table in `db`, read from the
    /// engine's catalogs (no `COUNT(*)` / table scan) so it stays cheap on
    /// large schemas. MySQL reads `information_schema.TABLES`, PostgreSQL the
    /// `pg_*_size` functions, SQLite aggregates `dbstat` when available. Byte
    /// and row fields are best-effort and may be absent (see [`TableSizeInfo`]).
    /// Views are omitted.
    pub async fn table_sizes(&self, db: &str) -> Result<Vec<TableSizeInfo>> {
        match self {
            Connection::MySql(c) => c.table_sizes(db).await,
            Connection::Postgres(c) => c.table_sizes(db).await,
            Connection::Sqlite(c) => c.table_sizes(db).await,
            Connection::DuckDb(c) => c.table_sizes(db).await,
            Connection::Mssql(c) => c.table_sizes(db).await,
        }
    }

    /// Read-only server information (version + configuration variables) for the
    /// server-info panel. MySQL uses `SELECT VERSION()` + `SHOW VARIABLES`,
    /// PostgreSQL `version()` + `pg_settings`, SQLite `sqlite_version()` + a
    /// curated set of `PRAGMA`s. No write is performed, so it is allowed on
    /// read-only sessions.
    pub async fn server_info(&self) -> Result<ServerInfo> {
        match self {
            Connection::MySql(c) => c.server_info().await,
            Connection::Postgres(c) => c.server_info().await,
            Connection::Sqlite(c) => c.server_info().await,
            Connection::DuckDb(c) => c.server_info().await,
            Connection::Mssql(c) => c.server_info().await,
        }
    }

    /// サーバランタイムの軽量メトリクス 1 サンプル (#731)。監視ダッシュボードが
    /// 一定間隔でポーリングし、フロントの在メモリ・リングバッファに蓄積して接続数 /
    /// QPS / ロック待ちの時系列を描く。MySQL は `SHOW GLOBAL STATUS`、PostgreSQL は
    /// `pg_stat_activity` / `pg_stat_database` の集計で、いずれもメモリ上のカウンタを
    /// 読むだけでテーブル I/O は無い。サーバ状態を変更しないため read_only セッション
    /// でも許可する。SQLite はサーバを持たずエラーを返す。
    pub async fn server_metrics(&self) -> Result<ServerMetrics> {
        match self {
            Connection::MySql(c) => c.server_metrics().await,
            Connection::Postgres(c) => c.server_metrics().await,
            Connection::Sqlite(c) => c.server_metrics().await,
            Connection::DuckDb(c) => c.server_metrics().await,
            Connection::Mssql(c) => c.server_metrics().await,
        }
    }

    /// Server-side processes/connections for the process monitor panel.
    /// Reads the engine's in-memory state (`processlist` / `pg_stat_activity`)
    /// — no table I/O — so it is cheap enough to poll. SQLite has no server
    /// processes and returns an error.
    pub async fn list_processes(&self) -> Result<Vec<ProcessInfo>> {
        match self {
            Connection::MySql(c) => c.list_processes().await,
            Connection::Postgres(c) => c.list_processes().await,
            Connection::Sqlite(c) => c.list_processes().await,
            Connection::DuckDb(c) => c.list_processes().await,
            Connection::Mssql(c) => c.list_processes().await,
        }
    }

    /// Terminates the server-side process/connection `id` (from
    /// [`Connection::list_processes`]): MySQL `KILL <id>`, PostgreSQL
    /// `pg_terminate_backend(pid)`. SQLite returns an error.
    pub async fn kill_process(&self, id: i64) -> Result<()> {
        match self {
            Connection::MySql(c) => c.kill_process(id).await,
            Connection::Postgres(c) => c.kill_process(id).await,
            Connection::Sqlite(c) => c.kill_process(id).await,
            Connection::DuckDb(c) => c.kill_process(id).await,
            Connection::Mssql(c) => c.kill_process(id).await,
        }
    }

    /// Server accounts/roles for the users & permissions panel (#732): MySQL
    /// `mysql.user`, PostgreSQL `pg_roles`. SQLite has no user model, and MSSQL
    /// is not yet implemented (could read `sys.server_principals` /
    /// `sys.database_permissions`, out of scope for this PR) — both return an
    /// error instead of an empty list for direct IPC callers (matching
    /// [`Connection::list_processes`]'s "unsupported" convention), and the
    /// frontend hides the panel entirely for SQLite.
    pub async fn list_db_users(&self) -> Result<Vec<DbUserInfo>> {
        match self {
            Connection::MySql(c) => c.list_db_users().await,
            Connection::Postgres(c) => c.list_db_users().await,
            Connection::Sqlite(c) => c.list_db_users().await,
            Connection::DuckDb(c) => c.list_db_users().await,
            Connection::Mssql(c) => c.list_db_users().await,
        }
    }

    /// The CRUD + DDL privilege matrix for one user/role (see
    /// [`UserPrivileges`]). `host` narrows a MySQL account (`user@host`);
    /// ignored by other drivers.
    pub async fn user_privileges(&self, user: &str, host: Option<&str>) -> Result<UserPrivileges> {
        match self {
            Connection::MySql(c) => c.user_privileges(user, host).await,
            Connection::Postgres(c) => c.user_privileges(user, host).await,
            Connection::Sqlite(c) => c.user_privileges(user, host).await,
            Connection::DuckDb(c) => c.user_privileges(user, host).await,
            Connection::Mssql(c) => c.user_privileges(user, host).await,
        }
    }

    /// ライブクエリ・インスペクタ (#746) の前提可否プローブ。MySQL は
    /// `performance_schema` と consumer の有効状態、PostgreSQL は
    /// `pg_stat_statements` の有無/可読性を調べ、不可なら理由コード付きで
    /// 縮退情報を返す (黙って空にしない)。読み取りのみでサーバ設定は変えない。
    pub async fn query_stats_support(&self) -> Result<QueryStatsSupport> {
        match self {
            Connection::MySql(c) => c.query_stats_support().await,
            Connection::Postgres(c) => c.query_stats_support().await,
            Connection::Sqlite(c) => c.query_stats_support().await,
            Connection::DuckDb(c) => c.query_stats_support().await,
            Connection::Mssql(c) => c.query_stats_support().await,
        }
    }

    /// ライブテール 1 サンプル: サーバが観測した実行中/直近ステートメント
    /// (MySQL `events_statements_current`/`_history`、PostgreSQL
    /// `pg_stat_activity`)。読み取り SELECT のみでポーリングしても安全。
    /// 自セッション由来と noobDB 内部クエリはドライバ側で除外する。
    /// SQLite はサーバを持たずエラーを返す。
    pub async fn live_queries(&self) -> Result<Vec<LiveQuery>> {
        match self {
            Connection::MySql(c) => c.live_queries().await,
            Connection::Postgres(c) => c.live_queries().await,
            Connection::Sqlite(c) => c.live_queries().await,
            Connection::DuckDb(c) => c.live_queries().await,
            Connection::Mssql(c) => c.live_queries().await,
        }
    }

    /// digest (フィンガープリント) 単位の累積統計スナップショット (MySQL
    /// `events_statements_summary_by_digest`、PostgreSQL `pg_stat_statements`)。
    /// 「記録開始からの差分」計算はフロントの純ロジックが担う。SQLite は
    /// エラーを返す。
    pub async fn statement_stats(&self) -> Result<Vec<StatementStat>> {
        match self {
            Connection::MySql(c) => c.statement_stats().await,
            Connection::Postgres(c) => c.statement_stats().await,
            Connection::Sqlite(c) => c.statement_stats().await,
            Connection::DuckDb(c) => c.statement_stats().await,
            Connection::Mssql(c) => c.statement_stats().await,
        }
    }

    /// スキーマ健全性アドバイザ (#741) の未使用インデックス統計。PostgreSQL は
    /// `pg_stat_user_indexes.idx_scan = 0`、MySQL は `sys.schema_unused_indexes`
    /// (performance_schema 有効時のみ)。前提を満たさなければ理由コード付きで
    /// 縮退する ([`UnusedIndexStats::supported`] = false)。SQLite はサーバ統計を
    /// 持たず `unsupported_driver` を返す。読み取りのみ。
    pub async fn unused_indexes(&self, db: &str) -> Result<UnusedIndexStats> {
        match self {
            Connection::MySql(c) => c.unused_indexes(db).await,
            Connection::Postgres(c) => c.unused_indexes(db).await,
            Connection::Sqlite(c) => c.unused_indexes(db).await,
            Connection::DuckDb(c) => c.unused_indexes(db).await,
            Connection::Mssql(c) => c.unused_indexes(db).await,
        }
    }

    pub async fn close(&self) {
        match self {
            Connection::MySql(c) => c.close().await,
            Connection::Postgres(c) => c.close().await,
            Connection::Sqlite(c) => c.close().await,
            Connection::DuckDb(c) => c.close().await,
            Connection::Mssql(c) => c.close().await,
        }
    }

    /// Executes a single write statement for real while attempting to record a
    /// reversible before/after image of the rows it touches (#735 DML flight
    /// recorder / one-click undo).
    ///
    /// Implemented once here (not per-driver) on top of the existing dry-run
    /// preview ([`Connection::preview_execute_with_limit`], which runs the
    /// statement in a transaction that is always rolled back) instead of
    /// duplicating its WHERE/target-table/PK extraction — the real write
    /// afterwards goes through the ordinary [`Connection::execute`] path.
    ///
    /// **The dry run's before/after snapshot is not trusted verbatim**: only
    /// MySQL/PostgreSQL's preview narrows it to the statement's own `WHERE`
    /// clause; SQLite's simpler implementation always re-scans the first
    /// `row_cap` rows of the table by primary-key order for *both* snapshots,
    /// regardless of `WHERE`. Rather than special-casing a driver, this method
    /// re-derives which rows the statement *actually* touched by pairing
    /// before/after on primary key and keeping only the pairs that changed
    /// (`UPDATE`) or that appear on only one side (`INSERT`/`DELETE`) —
    /// harmless no-ops on drivers that already narrowed the snapshot, and the
    /// fix that makes this correct on SQLite. The result is then cross-checked
    /// against the real write's authoritative `rows_affected`; any mismatch
    /// (a row hid outside the `row_cap` window, an ambiguous shape) declines
    /// capture rather than risk recording the wrong rows.
    ///
    /// **Known limitation (documented, not a bug):** because the snapshot
    /// comes from a *separate* dry run rather than the same transaction as the
    /// real write, there is a small window between the two in which another
    /// client could change the same rows — the captured "after" image would
    /// then not exactly match what the real write actually produced. This is
    /// acceptable for a best-effort safety net (the far larger and more likely
    /// drift window is between capture time and whenever the user chooses to
    /// undo, which the undo path's conflict check is designed to catch
    /// regardless). Capture failing for any reason (unresolvable target/PK,
    /// ambiguous row identification, a malformed statement that only reveals
    /// itself here) never blocks the write — it always still executes, just
    /// uncaptured.
    pub async fn capture_write(
        &self,
        sql: &str,
        database: Option<&str>,
        row_cap: usize,
    ) -> Result<(QueryResult, WriteCapture)> {
        let kind = classify_write_kind_for(self.driver_kind(), sql);
        if kind == WriteKind::Other {
            let result = self.execute(sql, database).await?;
            return Ok((
                result,
                WriteCapture::not_capturable(
                    kind,
                    "対象外の文 (SELECT / DDL / 複数文など) のため記録できません",
                ),
            ));
        }

        let row_cap = row_cap.max(1);
        let dry = match self
            .preview_execute_with_limit(sql, database, row_cap)
            .await
        {
            Ok(d) => d,
            Err(_) => {
                let result = self.execute(sql, database).await?;
                return Ok((
                    result,
                    WriteCapture::not_capturable(kind, "対象テーブル/主キーを特定できませんでした"),
                ));
            }
        };

        if dry.target_table.is_none() {
            let result = self.execute(sql, database).await?;
            return Ok((
                result,
                WriteCapture::not_capturable_with_meta(
                    kind,
                    "対象テーブルを特定できませんでした (複雑な JOIN 等)",
                    &dry,
                ),
            ));
        }
        if dry.primary_key.is_empty() {
            let result = self.execute(sql, database).await?;
            return Ok((
                result,
                WriteCapture::not_capturable_with_meta(
                    kind,
                    "対象テーブルに主キーがありません",
                    &dry,
                ),
            ));
        }

        let columns: Vec<String> = dry.columns.iter().map(|c| c.name.clone()).collect();
        let column_types: Vec<String> = dry.columns.iter().map(|c| c.type_name.clone()).collect();
        let table = dry.target_table.clone();
        let primary_key = dry.primary_key.clone();
        let pk_idx: Vec<usize> = primary_key
            .iter()
            .filter_map(|name| columns.iter().position(|c| c == name))
            .collect();
        if pk_idx.len() != primary_key.len() {
            let result = self.execute(sql, database).await?;
            return Ok((
                result,
                WriteCapture::not_capturable_with_meta(
                    kind,
                    "主キー列を特定できませんでした",
                    &dry,
                ),
            ));
        }
        let pk_of =
            |row: &[Value]| -> Vec<Value> { pk_idx.iter().map(|&i| row[i].clone()).collect() };

        let ambiguous_reason =
            "対象行を正確に特定できませんでした (対象行数が上限を超えている可能性があります)";

        // 重複した主キーシグネチャの防御 (#735 レビュー対応): SQLite は
        // INTEGER PRIMARY KEY 以外の主キーに NULL を許すため、複数の行が同じ
        // シグネチャに畳まれることがある (`db::data_diff` の `key_unreliable`
        // と同じ懸念)。UPDATE 経路はこのシグネチャを鍵にした HashMap で
        // before/after をペアリングするため、重複があると後勝ちで別の行の
        // after 値を誤って紐付けかねない。DELETE/INSERT 側も HashSet の
        // 有無判定だけで多重度を見ないため、同様に誤判定しうる。before/after
        // いずれかで重複が見つかったら、正確に特定できないとして記録を辞退する
        // (書き込み自体は必ず実行する)。
        fn has_duplicate_pk_signature(rows: &[Vec<Value>], pk_idx: &[usize]) -> bool {
            let mut seen = std::collections::HashSet::with_capacity(rows.len());
            for row in rows {
                let sig =
                    row_signature(&pk_idx.iter().map(|&i| row[i].clone()).collect::<Vec<_>>());
                if !seen.insert(sig) {
                    return true;
                }
            }
            false
        }
        if has_duplicate_pk_signature(&dry.before_rows, &pk_idx)
            || has_duplicate_pk_signature(&dry.after_rows, &pk_idx)
        {
            let result = self.execute(sql, database).await?;
            return Ok((
                result,
                WriteCapture::not_capturable_with_meta(
                    kind,
                    "主キーが重複しており対象行を正確に特定できませんでした",
                    &dry,
                ),
            ));
        }

        match kind {
            WriteKind::Update => {
                let after_by_key: std::collections::HashMap<String, Vec<Value>> = dry
                    .after_rows
                    .iter()
                    .map(|r| (row_signature(&pk_of(r)), r.clone()))
                    .collect();
                let mut before_changed = Vec::new();
                let mut after_changed = Vec::new();
                for b in &dry.before_rows {
                    if let Some(a) = after_by_key.get(&row_signature(&pk_of(b))) {
                        if a != b {
                            before_changed.push(b.clone());
                            after_changed.push(a.clone());
                        }
                    }
                }

                let result = self.execute(sql, database).await?;

                if before_changed.len() as u64 != result.rows_affected {
                    return Ok((
                        result,
                        WriteCapture::not_capturable_with_meta(kind, ambiguous_reason, &dry),
                    ));
                }

                Ok((
                    result.clone(),
                    WriteCapture {
                        kind,
                        capturable: true,
                        reason: None,
                        table,
                        primary_key,
                        columns,
                        column_types,
                        before_rows: before_changed,
                        after_rows: after_changed,
                        rows_affected: result.rows_affected,
                    },
                ))
            }
            WriteKind::Delete => {
                let after_sigs: std::collections::HashSet<String> = dry
                    .after_rows
                    .iter()
                    .map(|r| row_signature(&pk_of(r)))
                    .collect();
                let deleted_rows: Vec<Vec<Value>> = dry
                    .before_rows
                    .iter()
                    .filter(|r| !after_sigs.contains(&row_signature(&pk_of(r))))
                    .cloned()
                    .collect();

                let result = self.execute(sql, database).await?;

                if deleted_rows.len() as u64 != result.rows_affected {
                    return Ok((
                        result,
                        WriteCapture::not_capturable_with_meta(kind, ambiguous_reason, &dry),
                    ));
                }

                Ok((
                    result.clone(),
                    WriteCapture {
                        kind,
                        capturable: true,
                        reason: None,
                        table,
                        primary_key,
                        columns,
                        column_types,
                        before_rows: deleted_rows,
                        after_rows: Vec::new(),
                        rows_affected: result.rows_affected,
                    },
                ))
            }
            WriteKind::Insert => {
                let before_sigs: std::collections::HashSet<String> = dry
                    .before_rows
                    .iter()
                    .map(|r| row_signature(&pk_of(r)))
                    .collect();

                let result = self.execute(sql, database).await?;

                let new_rows: Vec<Vec<Value>> = dry
                    .after_rows
                    .iter()
                    .filter(|r| !before_sigs.contains(&row_signature(&pk_of(r))))
                    .cloned()
                    .collect();

                if new_rows.is_empty() || new_rows.len() as u64 != result.rows_affected {
                    return Ok((
                        result,
                        WriteCapture::not_capturable_with_meta(
                            kind,
                            "挿入行を特定できませんでした (対象範囲外、または複数行 INSERT)",
                            &dry,
                        ),
                    ));
                }

                Ok((
                    result.clone(),
                    WriteCapture {
                        kind,
                        capturable: true,
                        reason: None,
                        table,
                        primary_key,
                        columns,
                        column_types,
                        before_rows: Vec::new(),
                        after_rows: new_rows,
                        rows_affected: result.rows_affected,
                    },
                ))
            }
            WriteKind::Other => unreachable!("guarded above"),
        }
    }

    /// Refetches the current values of specific rows by primary key. Used by
    /// the flight recorder undo path (#735) to compare live data against a
    /// captured after-image before applying the reverse SQL (conflict check).
    ///
    /// Builds `SELECT * FROM <table> WHERE (<pk predicate>) OR (<pk
    /// predicate>) ...` — identifiers and literals are rendered through the
    /// same escaping already used by schema/data sync ([`sync::quote_ident`] /
    /// [`data_diff::sql_literal`]), so this introduces no new SQL-building
    /// code path. A read, so it is safe to call regardless of the session's
    /// read-only flag (the caller decides whether the *reverse write* is
    /// allowed).
    pub async fn fetch_rows_by_pk(
        &self,
        table: &str,
        primary_key: &[String],
        pk_rows: &[Vec<Value>],
        database: Option<&str>,
    ) -> Result<Vec<Vec<Value>>> {
        if pk_rows.is_empty() || primary_key.is_empty() {
            return Ok(Vec::new());
        }
        // #735 レビュー対応: 1 SELECT に全 pk_rows 分の `(...)  OR (...)` を
        // 詰め込むと、SQLite の式ツリー深さ上限 (既定 1000、`SQLITE_LIMIT_
        // EXPR_DEPTH`) を Undo 対象行数が多いときに超えてクエリ自体が失敗しうる。
        // 固定件数ずつチャンク分割し、複数 SELECT の結果を連結することで
        // 1 クエリあたりの式ツリーを浅く保つ。
        const CHUNK_SIZE: usize = 200;
        let driver = self.driver_kind();
        let table_ident = sync::quote_ident(driver, table);
        let mut all_rows = Vec::with_capacity(pk_rows.len());
        for chunk in pk_rows.chunks(CHUNK_SIZE) {
            let predicate = chunk
                .iter()
                .map(|key| {
                    let clause = primary_key
                        .iter()
                        .zip(key.iter())
                        .map(|(name, value)| {
                            let ident = sync::quote_ident(driver, name);
                            match value {
                                Value::Null => format!("{ident} IS NULL"),
                                _ => format!("{ident} = {}", data_diff::sql_literal(driver, value)),
                            }
                        })
                        .collect::<Vec<_>>()
                        .join(" AND ");
                    format!("({clause})")
                })
                .collect::<Vec<_>>()
                .join(" OR ");
            let sql = format!("SELECT * FROM {table_ident} WHERE {predicate}");
            let result = self.execute(&sql, database).await?;
            all_rows.extend(result.rows);
        }
        Ok(all_rows)
    }

    // ── ローカル横断クエリ (#740) ──
    //
    // Only meaningful on the local SQLite engine (see `commands/local.rs`);
    // MySQL/Postgres sessions never receive these calls through normal IPC
    // (the frontend only offers registration on a local session), but the
    // dispatch is still total so a stray direct call fails clearly instead of
    // panicking. Keeping these on the `Connection` enum — rather than as
    // free functions reaching into `Connection::Sqlite` from the command
    // layer — is what keeps a future local-engine swap (e.g. DuckDB, #709)
    // to just a new match arm here.

    /// Registers a result set as a local table (create + bulk insert +
    /// provenance metadata, atomically). See
    /// `db::sqlite::SqliteConn::register_local_table`.
    pub async fn register_local_table(
        &self,
        meta: &LocalTableMeta,
        columns: &[Column],
        rows: &[Vec<Value>],
    ) -> Result<()> {
        match self {
            Connection::Sqlite(c) => c.register_local_table(meta, columns, rows).await,
            Connection::MySql(_)
            | Connection::Postgres(_)
            | Connection::DuckDb(_)
            | Connection::Mssql(_) => Err(AppError::InvalidInput(
                "local table registration is only supported on the local SQLite engine".into(),
            )),
        }
    }

    /// Every table registered on this local session, newest first.
    pub async fn list_local_tables(&self) -> Result<Vec<LocalTableMeta>> {
        match self {
            Connection::Sqlite(c) => c.list_local_tables().await,
            Connection::MySql(_)
            | Connection::Postgres(_)
            | Connection::DuckDb(_)
            | Connection::Mssql(_) => Err(AppError::InvalidInput(
                "local table listing is only supported on the local SQLite engine".into(),
            )),
        }
    }

    /// Drops a registered local table and its provenance entry.
    pub async fn drop_local_table(&self, name: &str) -> Result<()> {
        match self {
            Connection::Sqlite(c) => c.drop_local_table(name).await,
            Connection::MySql(_)
            | Connection::Postgres(_)
            | Connection::DuckDb(_)
            | Connection::Mssql(_) => Err(AppError::InvalidInput(
                "dropping a local table is only supported on the local SQLite engine".into(),
            )),
        }
    }

    /// Persists a clean snapshot of the local database to `path` (the
    /// explicit "ファイルに保存" escape hatch out of the default volatile
    /// behavior).
    pub async fn vacuum_into(&self, path: &str) -> Result<()> {
        match self {
            Connection::Sqlite(c) => c.vacuum_into(path).await,
            Connection::MySql(_)
            | Connection::Postgres(_)
            | Connection::DuckDb(_)
            | Connection::Mssql(_) => Err(AppError::InvalidInput(
                "saving to file is only supported on the local SQLite engine".into(),
            )),
        }
    }
}

/// Folds `(table, column)` pairs into one `TableSchema` per table. The input
/// must be grouped by table (consecutive rows of the same table), which the
/// driver queries guarantee via `ORDER BY <table>, <ordinal>`; column order
/// within each table is preserved.
/// Case-insensitive membership test for a column's declared SQL type name.
///
/// Called once per cell on the row-decode hot path. Comparing the driver's
/// borrowed type name in place — rather than allocating an uppercased `String`
/// copy of it for every cell — avoids `rows * columns` short-lived heap
/// allocations when materialising a result set. `eq_ignore_ascii_case` matches
/// regardless of the case each driver reports (MySQL upper, Postgres lower,
/// SQLite as declared), so the candidate literals stay uppercase.
pub(crate) fn type_name_matches(name: &str, candidates: &[&str]) -> bool {
    candidates.iter().any(|c| name.eq_ignore_ascii_case(c))
}

/// Shared PK/empty short-circuit for `Connection::row_identity` (#849). A real
/// primary key always wins outright (the frontend already knows how to build
/// a WHERE clause from it), and a table with no columns at all has nothing to
/// identify a row by. Returns `None` in every other case, leaving the caller
/// to decide between a driver-specific physical row id (SQLite `rowid` /
/// PostgreSQL `ctid`) and the universal `all_columns` fallback.
pub(crate) fn row_identity_pk_or_none(cols: &[TableColumnInfo]) -> Option<TableRowIdentity> {
    if cols.iter().any(|c| c.key.eq_ignore_ascii_case("PRI")) {
        return Some(TableRowIdentity {
            strategy: "primary_key".into(),
            hidden_column: None,
        });
    }
    if cols.is_empty() {
        return Some(TableRowIdentity {
            strategy: "none".into(),
            hidden_column: None,
        });
    }
    None
}

/// Builds the driver-agnostic column metadata (`Column`) from the first row of
/// a result set. Shared by all three drivers — the sqlx `Row` / `Column` /
/// `TypeInfo` traits expose everything needed, so the per-driver copies were
/// identical modulo the concrete row type.
pub(crate) fn columns_of<R: sqlx::Row>(rows: &[R]) -> Vec<Column> {
    use sqlx::{Column as _, TypeInfo as _};
    let Some(first) = rows.first() else {
        return Vec::new();
    };
    first
        .columns()
        .iter()
        .map(|c| Column {
            name: c.name().to_string(),
            type_name: c.type_info().name().to_string(),
        })
        .collect()
}

/// Shared decode fallback tail for MySQL / Postgres: try `String`, else
/// hex-encode `Vec<u8>` (the JSON-safe BLOB representation), else `Null`.
/// SQLite keeps its own tail (it also tries int/float for dynamically typed
/// columns).
pub(crate) fn decode_string_or_bytes<R>(row: &R, i: usize) -> Value
where
    R: sqlx::Row,
    usize: sqlx::ColumnIndex<R>,
    for<'r> Option<String>: sqlx::Decode<'r, R::Database> + sqlx::Type<R::Database>,
    for<'r> Option<Vec<u8>>: sqlx::Decode<'r, R::Database> + sqlx::Type<R::Database>,
{
    match row.try_get::<Option<String>, _>(i) {
        Ok(Some(s)) => Value::String(s),
        Ok(None) => Value::Null,
        Err(_) => match row.try_get::<Option<Vec<u8>>, _>(i) {
            Ok(Some(b)) => Value::Bytes(data_encoding::HEXLOWER.encode(&b)),
            _ => Value::Null,
        },
    }
}

/// Combines the data and index byte parts a driver resolved into a `total`.
/// Returns `Some(sum)` when at least one part is present (treating an absent
/// part as 0), and `None` only when both are unknown — so a table with just one
/// measured part still reports a total rather than dropping to "unknown".
pub(crate) fn sum_size_parts(data: Option<i64>, index: Option<i64>) -> Option<i64> {
    match (data, index) {
        (None, None) => None,
        (a, b) => Some(a.unwrap_or(0) + b.unwrap_or(0)),
    }
}

/// Masks the value of a server variable whose name looks like it could hold a
/// secret, so the server-info panel (#563) never surfaces credentials even on a
/// server that exposes such a variable. `SHOW VARIABLES` / `pg_settings` do not
/// carry the connection password or a connection string in practice, so this is
/// defense-in-depth for custom/derived variables. The match is a case-insensitive
/// substring on the name; empty values are left untouched.
pub(crate) fn mask_sensitive_var(name: &str, value: String) -> String {
    if value.is_empty() {
        return value;
    }
    const SECRET_HINTS: &[&str] = &["password", "passwd", "secret", "private_key"];
    let lower = name.to_ascii_lowercase();
    if SECRET_HINTS.iter().any(|hint| lower.contains(hint)) {
        return "********".to_string();
    }
    value
}

pub(crate) fn group_columns_by_table(pairs: Vec<(String, String)>) -> Vec<TableSchema> {
    let mut out: Vec<TableSchema> = Vec::new();
    for (table, column) in pairs {
        match out.last_mut() {
            Some(last) if last.name == table => last.columns.push(column),
            _ => out.push(TableSchema {
                name: table,
                columns: vec![column],
            }),
        }
    }
    out
}

/// Builds `INSERT INTO tbl (c1, c2) VALUES (?,?),(?,?)...` with `nrows`
/// placeholder tuples of `ncols` each. Identifiers are pre-quoted by the
/// caller; only positional `?` placeholders are emitted here so values bind
/// as parameters rather than being spliced into the SQL text.
pub(crate) fn build_insert_sql(
    table_ident: &str,
    cols_sql: &str,
    ncols: usize,
    nrows: usize,
) -> String {
    let mut tuple = String::with_capacity(ncols * 2 + 2);
    tuple.push('(');
    for c in 0..ncols {
        if c > 0 {
            tuple.push(',');
        }
        tuple.push('?');
    }
    tuple.push(')');
    // Write the statement directly into one pre-sized buffer instead of
    // materialising a `Vec<&str>` of the repeated tuple and joining it.
    let mut out = String::with_capacity(
        "INSERT INTO  () VALUES ".len()
            + table_ident.len()
            + cols_sql.len()
            + nrows * (tuple.len() + 1),
    );
    out.push_str("INSERT INTO ");
    out.push_str(table_ident);
    out.push_str(" (");
    out.push_str(cols_sql);
    out.push_str(") VALUES ");
    for r in 0..nrows {
        if r > 0 {
            out.push(',');
        }
        out.push_str(&tuple);
    }
    out
}

/// ` ORDER BY pk1, pk2` clause with each column quoted by `quote`, or an
/// empty string when the table has no primary key.
pub(crate) fn pk_order_clause(pk_cols: &[String], quote: fn(&str) -> String) -> String {
    if pk_cols.is_empty() {
        return String::new();
    }
    let mut out = String::from(" ORDER BY ");
    for (i, c) in pk_cols.iter().enumerate() {
        if i > 0 {
            out.push_str(", ");
        }
        out.push_str(&quote(c));
    }
    out
}

/// Returns true when `sql` is shaped like a read-only statement that the
/// read-only profile gate is willing to let through.
///
/// Allow list: `SELECT` / `SHOW` / `DESCRIBE` / `DESC` / `EXPLAIN` / `WITH`
/// for every driver, plus two driver-conditioned extensions (#1005):
///
/// * **`VALUES` / `TABLE`, all drivers.** `VALUES (1),(2)` (a bare row
///   constructor) and `TABLE t` (PostgreSQL/DuckDB/MySQL 8.0.19+ shorthand for
///   `SELECT * FROM t`) can only ever produce a result set — neither syntax
///   has a form that mutates data — so allowing them is safe regardless of
///   whether the connected driver actually supports the statement (an
///   unsupported driver just fails at the database with a syntax error, which
///   is not a safety concern).
/// * **DuckDB only: `FROM` / `SUMMARIZE` / query-shaped `PRAGMA`.** DuckDB's
///   `FROM t` (FROM-first shorthand for `SELECT * FROM t`) and `SUMMARIZE t`
///   (read-only column statistics) are always read-only. `PRAGMA`, however,
///   has both a query form (`PRAGMA database_list`, `PRAGMA table_info('t')`)
///   and a *setting* form that changes session/database configuration
///   (`PRAGMA memory_limit='1GB'`, `PRAGMA threads=4`) — the latter is a
///   write in spirit even though it isn't `INSERT`/`UPDATE`/`DELETE`/DDL, so
///   `PRAGMA` is only allowed for DuckDB, and only when the masked body
///   contains no `=` (the setting form's syntax always has one; the query
///   form never does — see [`is_read_only_sql_masked`]). SQLite's own
///   `PRAGMA foreign_keys=ON` is exactly this setting form, and SQLite has no
///   query-only `PRAGMA` use case that would be lost by leaving it off the
///   allow list entirely, so `PRAGMA` stays unlisted for every driver other
///   than DuckDB (fail-closed, per the project's default policy — see
///   `CLAUDE.md`'s "読み取り専用ガードと自動 LIMIT").
///
/// Trailing semicolons and whitespace are tolerated. `SELECT ... FOR UPDATE`,
/// `FOR SHARE`, `FOR NO KEY UPDATE`, `FOR KEY SHARE` and the MySQL
/// `LOCK IN SHARE MODE` form — including their `NOWAIT` / `SKIP LOCKED` /
/// `OF <table>` suffixed variants (see [`has_locking_clause`]) — are rejected
/// because they acquire row locks even though they syntactically begin with
/// `SELECT`. Microsoft SQL Server table hints that do the same thing via
/// `WITH (...)` (`UPDLOCK` / `XLOCK` / `TABLOCKX` / `HOLDLOCK` / …, see
/// [`has_locking_table_hint`], #906) are rejected the same way.
///
/// Beyond the leading keyword the body is masked (comments / string literals /
/// quoted identifiers blanked) and then:
///
/// * any leftover `;` after trimming trailing separators means a second
///   statement is hiding behind the first (`SELECT 1; DELETE …`), so it is
///   rejected;
/// * a write / DDL keyword found anywhere in the body rejects the statement,
///   which catches data-modifying CTEs (`WITH … DELETE …`) and `SELECT … INTO`.
///
/// `replace` is intentionally absent from the keyword list: a `REPLACE INTO`
/// write already fails the leading-keyword check, and listing it would reject
/// the perfectly read-only `REPLACE()` string function. This remains a
/// best-effort safety net, not a parser; when in doubt it errs toward rejection.
///
/// **Driver-less entry point**: masks with the stricter
/// [`mask_for_analysis_conservative`] reading, i.e. `\` is *not* an escape
/// inside a string literal. That is the fail-closed direction for every
/// dialect (a literal can only close earlier, never later, so keywords are
/// revealed rather than hidden), at the cost of rejecting a small number of
/// legitimate MySQL statements that use `\'` inside a string. Callers that
/// know the session's driver should use [`is_read_only_sql_for`] instead so
/// MySQL keeps its own escaping rules. See [`mask_for_driver`] (#852).
pub fn is_read_only_sql(sql: &str) -> bool {
    let orig: Vec<char> = sql.chars().collect();
    // ドライバ不明のときは #1005 の DuckDB 限定拡張 (`FROM`/`SUMMARIZE`/`PRAGMA`)
    // を許可しない — `VALUES`/`TABLE` は全ドライバ共通なので `None` でも通す。
    is_read_only_sql_masked(None, &mask_for_analysis_conservative(&orig))
}

/// Driver-aware entry point for [`is_read_only_sql`] (#852): masks string
/// literals with `driver`'s own escaping rules (see [`mask_for_driver`]) so
/// PostgreSQL / SQLite / DuckDB / MSSQL are not analysed with MySQL's
/// backslash-escape reading, which fails open on payloads like
/// `SELECT '\'; DELETE FROM t; --'`. Also unlocks the DuckDB-only allow-list
/// extensions documented on [`is_read_only_sql`] (#1005).
pub fn is_read_only_sql_for(driver: DriverKind, sql: &str) -> bool {
    let orig: Vec<char> = sql.chars().collect();
    is_read_only_sql_masked(Some(driver), &mask_for_driver(driver, &orig))
}

/// Shared body of [`is_read_only_sql`] / [`is_read_only_sql_for`], operating on
/// an already-masked statement so the two entry points differ only in which
/// masking rules they applied. `driver` is `None` for the driver-less entry
/// point, which keeps the DuckDB-only extensions (`FROM` / `SUMMARIZE` /
/// `PRAGMA`) turned off since it cannot know whether they're safe.
fn is_read_only_sql_masked(driver: Option<DriverKind>, masked: &[char]) -> bool {
    let masked_lower: String = masked.iter().collect::<String>().to_ascii_lowercase();
    let body = masked_lower
        .trim()
        .trim_end_matches(|c: char| c == ';' || c.is_whitespace())
        .trim_start();
    if body.is_empty() {
        return false;
    }
    let mut allowed_prefix = starts_with_word(body, "select")
        || starts_with_word(body, "show")
        || starts_with_word(body, "describe")
        || starts_with_word(body, "desc")
        || starts_with_word(body, "explain")
        || starts_with_word(body, "with")
        // `VALUES (1),(2)` / `TABLE t`: 全ドライバ共通で安全 (書き込みへ転じる
        // 構文が存在しない。#1005 のドキュメントコメント参照)。
        || starts_with_word(body, "values")
        || starts_with_word(body, "table");
    if !allowed_prefix && driver == Some(DriverKind::DuckDb) {
        // DuckDB 限定の読み取り構文 (#1005)。
        allowed_prefix = starts_with_word(body, "from") || starts_with_word(body, "summarize");
        if !allowed_prefix && starts_with_word(body, "pragma") {
            // PRAGMA は照会形 (`PRAGMA database_list`) と設定形
            // (`PRAGMA memory_limit='1GB'`) の両方を持つ。設定形は構文上必ず
            // `=` を含む一方、照会形は含まないため、`=` の有無で近似する
            // (issue #1005 の提案どおり)。
            allowed_prefix = !body.contains('=');
        }
    }
    if !allowed_prefix {
        return false;
    }
    // Trailing separators were stripped above, so a remaining `;` can only be a
    // statement boundary with more SQL behind it.
    if body.contains(';') {
        return false;
    }
    for kw in [
        "insert",
        "update",
        "delete",
        "into",
        "create",
        "alter",
        "drop",
        "truncate",
        "call",
        "merge",
        "grant",
        "revoke",
        // 別エンジンへの書き込みパススルー関数群。これらはトップレベルの文自体は
        // `SELECT ...` のままなので許可プレフィックスは通過するが、実際の書き込み
        // SQL は引数の文字列リテラルの中に埋め込まれる — つまりマスクで空白化
        // される領域に隠れるため、通常の書き込みキーワード走査には一切引っかからない
        // (例: `SELECT * FROM OPENROWSET('SQLNCLI','Server=x;','UPDATE t SET a=1')`、
        // `SELECT dblink_exec('dbname=other','DELETE FROM accounts')`)。
        // `openrowset`/`openquery`/`opendatasource` は MSSQL のリンクサーバ経由
        // パススルー、`dblink`/`dblink_exec` は PostgreSQL の他 DB へのクエリ実行、
        // `load_extension` は SQLite のネイティブ拡張ロード (任意コード実行) で、
        // いずれも文字列引数の中身を実行させる/コードを実行させる関数呼び出し自体を
        // 検出しないと安全網が意味を失う。実クエリでこれらの名前がドライバを問わず
        // 正当な識別子 (列名など) として現れる可能性は極めて低いため、対象ドライバに
        // 関わらず全ドライバ共通で拒否する (fail-closed — 過検知のコストは低い一方、
        // 見逃しは任意書き込みに直結する)。
        "openrowset",
        "openquery",
        "opendatasource",
        "dblink",
        "dblink_exec",
        "load_extension",
    ] {
        if contains_word(body, kw) {
            return false;
        }
    }
    if has_locking_clause(body) {
        return false;
    }
    if has_locking_table_hint(body) {
        return false;
    }
    true
}

/// Row-locking clause phrases recognised by [`has_locking_clause`]: `SELECT
/// ... FOR UPDATE` / `FOR SHARE` (standard SQL / MySQL / PostgreSQL), the
/// PostgreSQL-only `FOR NO KEY UPDATE` / `FOR KEY SHARE`, and the MySQL-only
/// `LOCK IN SHARE MODE`. The two- and three-word phrases are checked before
/// the shorter `for update` / `for share` so callers scanning in this order
/// see the more specific match first (the phrases don't actually overlap as
/// substrings, but ordering longest-first keeps that invariant obvious).
const LOCKING_CLAUSES: &[&str] = &[
    "for no key update",
    "for key share",
    "for update",
    "for share",
    "lock in share mode",
];

/// True when masked/lowercased `body` contains a row-locking clause anywhere —
/// any of [`LOCKING_CLAUSES`] — including the PostgreSQL suffixed forms that
/// may follow the base phrase: `NOWAIT` (`FOR UPDATE NOWAIT`), `SKIP LOCKED`
/// (`FOR UPDATE SKIP LOCKED`), and `OF <table>[, ...]` (`FOR UPDATE OF t`,
/// also valid on `FOR SHARE` / `FOR NO KEY UPDATE` / `FOR KEY SHARE`). Rather
/// than parsing those suffixes explicitly, this matches the base phrase
/// anywhere in the body — safe because `body` has already had comments and
/// string/quoted-identifier literals masked to spaces, so any surviving
/// occurrence of e.g. `for update` is real SQL syntax, not a coincidental
/// column value, and any write keyword trailing a locking clause (which would
/// make the suffix invalid SQL) is independently caught by the write-keyword
/// scan that runs before this check in [`is_read_only_sql`].
///
/// Matching is word-bounded on the *whole* phrase — the character immediately
/// before it must be a non-word character (or start of string) and the
/// character immediately after must be a non-word character (or end of
/// string) — so a column named `for_updated_at` / `updated_at` is never
/// mistaken for the clause.
fn has_locking_clause(body: &str) -> bool {
    LOCKING_CLAUSES
        .iter()
        .any(|phrase| contains_word_phrase(body, phrase))
}

/// Like [`contains_word`], but `phrase` may itself contain literal spaces
/// (e.g. `"for update"`); the match still requires a non-word boundary
/// immediately before and after the whole phrase.
fn contains_word_phrase(haystack: &str, phrase: &str) -> bool {
    let hb = haystack.as_bytes();
    let pb = phrase.as_bytes();
    if pb.is_empty() || hb.len() < pb.len() {
        return false;
    }
    let mut i = 0;
    while i + pb.len() <= hb.len() {
        if &hb[i..i + pb.len()] == pb {
            let before_ok = i == 0 || !is_word_byte(hb[i - 1]);
            let after = i + pb.len();
            let after_ok = after >= hb.len() || !is_word_byte(hb[after]);
            if before_ok && after_ok {
                return true;
            }
        }
        i += 1;
    }
    false
}

/// Microsoft SQL Server table hints that make a `SELECT` acquire locks a plain
/// read would not (#906). Two families, both of which break the "a read-only
/// session takes no locks" guarantee that [`LOCKING_CLAUSES`] enforces for the
/// other drivers:
///
/// * **stronger lock mode than a shared read**: `UPDLOCK` (update locks),
///   `XLOCK` (exclusive locks), `TABLOCKX` (exclusive table lock).
/// * **longer lock duration than the statement**: `HOLDLOCK` and its synonym
///   `SERIALIZABLE`, `REPEATABLEREAD`, `READCOMMITTEDLOCK` — all hold their
///   locks until the end of the transaction rather than releasing them when
///   the statement finishes.
///
/// Deliberately **not** listed: `NOLOCK` / `READUNCOMMITTED` / `READPAST`
/// (which take *fewer* locks, and which the shared golden vectors already
/// assert are read-only) and the granularity-only hints `ROWLOCK` / `PAGLOCK` /
/// `TABLOCK`, which do not change the lock mode or duration a plain `SELECT`
/// would already use.
const LOCKING_TABLE_HINTS: &[&str] = &[
    "updlock",
    "xlock",
    "tablockx",
    "holdlock",
    "serializable",
    "repeatableread",
    "readcommittedlock",
];

/// True when masked/lowercased `body` carries a T-SQL table hint from
/// [`LOCKING_TABLE_HINTS`] inside a `WITH (...)` hint group (#906) — e.g.
/// `SELECT * FROM t WITH (UPDLOCK, HOLDLOCK)`.
///
/// The match is deliberately scoped to the interior of a `WITH (…)` group
/// rather than scanning the whole body for the bare words, so an ordinary
/// column named `updlock` or `serializable` (or a
/// `SET TRANSACTION ISOLATION LEVEL SERIALIZABLE` statement) is never mistaken
/// for a hint. Parenthesis depth is tracked while scanning the group because
/// hints may themselves be parameterised (`INDEX(0)`, `FORCESEEK (ix (col))`),
/// and every `WITH (…)` group in the statement is inspected so a hint on the
/// second table of a join is not missed.
///
/// Applied on **every** driver rather than only [`DriverKind::Mssql`]: `WITH
/// (…)` directly after a table reference is not valid read-only syntax on the
/// other dialects (a CTE is `WITH <name> AS (…)`), so there is nothing to
/// false-positive on, and keeping one rule for all drivers means the shared
/// golden vectors need a single expected verdict per statement.
///
/// **Known limit**: the legacy hint form without `WITH` (`FROM t (UPDLOCK)`,
/// deprecated by Microsoft) is not recognised, since a bare parenthesised
/// group after an identifier is ambiguous with ordinary expressions. Same
/// best-effort posture as the rest of this module.
fn has_locking_table_hint(body: &str) -> bool {
    let chars: Vec<char> = body.chars().collect();
    let n = chars.len();
    let mut i = 0;
    while i < n {
        // Find a word-bounded `with` followed only by whitespace before a `(`.
        if !(chars[i..].starts_with(&['w', 'i', 't', 'h'])
            && (i == 0 || !is_word_char(chars[i - 1])))
        {
            i += 1;
            continue;
        }
        let mut j = i + 4;
        if j < n && is_word_char(chars[j]) {
            i += 1;
            continue;
        }
        while j < n && chars[j].is_whitespace() {
            j += 1;
        }
        if j >= n || chars[j] != '(' {
            i += 1;
            continue;
        }
        // Collect the group's interior, tracking depth so a nested `(…)` in a
        // parameterised hint doesn't end the scan early.
        let mut depth = 0usize;
        let mut group = String::new();
        while j < n {
            match chars[j] {
                '(' => {
                    depth += 1;
                    if depth > 1 {
                        group.push(' ');
                    }
                }
                ')' => {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                    group.push(' ');
                }
                c => group.push(c),
            }
            j += 1;
        }
        let hinted = group
            .split(|c: char| !is_word_char(c))
            .any(|word| LOCKING_TABLE_HINTS.contains(&word));
        if hinted {
            return true;
        }
        i = j.max(i + 1);
    }
    false
}

/// Appends an automatic `LIMIT <limit>` to an ad-hoc `SELECT` / `WITH ... SELECT`
/// that does not already constrain its own row window, returning the rewritten
/// SQL. Returns `None` when the statement should run untouched.
///
/// The check is deliberately conservative: when in doubt it returns `None` (run
/// the user's SQL verbatim) so we never break a working statement or silently
/// truncate something we misread.
///
/// * Comments (`-- …`, `# …`, `/* … */`) and the contents of string / quoted
///   identifier literals are masked before analysis, so a `limit` living inside
///   a comment or a `'literal'` never trips detection — and a `` `limit` ``
///   column name is not mistaken for the clause.
/// * Only statements beginning with `select` or `with` are eligible. Anything
///   that already carries a `limit` / `offset` / `fetch` keyword (the last
///   covers the SQL-standard `FETCH FIRST/NEXT … ROWS ONLY` pagination clause
///   that PostgreSQL and DuckDB both accept — appending a trailing `LIMIT`
///   after it is a syntax error, mirroring the guard [`apply_auto_limit_mssql`]
///   already has for T-SQL's `OFFSET … FETCH NEXT … ROWS ONLY`), a write
///   keyword (`insert` / `update` / `delete` / `into` — guarding
///   data-modifying CTEs and `SELECT … INTO`), a locking clause, or that reads
///   as a single-row aggregate is left alone.
/// * *Any* `limit` token anywhere — even one inside a sub-query — makes us bail.
///   That can skip a query we could have safely capped, but it can never append
///   a second `LIMIT` after an existing top-level one (a syntax error). Skipping
///   is the safe direction. The same reasoning applies to `offset` and `fetch`.
///
/// The `LIMIT` is spliced in just after the last meaningful character — ahead of
/// any trailing `;` or comment — so it is never swallowed by a line comment.
///
/// **Driver-less entry point**: masks conservatively, same rationale as
/// [`is_read_only_sql`] (#852). Revealing more keywords can only make this
/// return `None` (run the statement untouched), which is the safe direction.
/// Callers that know the driver go through [`apply_auto_limit_for`].
pub fn apply_auto_limit(sql: &str, limit: usize) -> Option<String> {
    let orig: Vec<char> = sql.chars().collect();
    apply_auto_limit_masked(&orig, &mask_for_analysis_conservative(&orig), limit)
}

/// Shared body of [`apply_auto_limit`] and its driver-aware caller, operating
/// on the original chars plus an already-masked copy of the same length.
fn apply_auto_limit_masked(orig: &[char], masked: &[char], limit: usize) -> Option<String> {
    if limit == 0 {
        return None;
    }
    let masked_lower: String = masked.iter().collect::<String>().to_ascii_lowercase();

    let body = masked_lower
        .trim()
        .trim_end_matches(|c: char| c == ';' || c.is_whitespace())
        .trim_start();
    if body.is_empty() {
        return None;
    }
    if !(starts_with_word(body, "select") || starts_with_word(body, "with")) {
        return None;
    }
    if contains_word(body, "limit") || contains_word(body, "offset") || contains_word(body, "fetch")
    {
        return None;
    }
    // Data-modifying CTEs (`WITH … DELETE`) and `SELECT … INTO` must not get a
    // trailing LIMIT spliced onto them. `replace`/`merge` are intentionally not
    // listed here: `REPLACE()` is a common string function, not a write.
    for kw in ["insert", "update", "delete", "into"] {
        if contains_word(body, kw) {
            return None;
        }
    }
    // Locking reads put the LIMIT in the wrong place if appended at the very end
    // (`… LOCK IN SHARE MODE LIMIT n` is invalid, and `LIMIT` can't be spliced
    // in before a trailing `NOWAIT` / `SKIP LOCKED` / `OF <table>` suffix
    // either), so leave any statement carrying a locking clause untouched. See
    // [`has_locking_clause`] for the recognised phrases and suffixed forms.
    if has_locking_clause(body) {
        return None;
    }
    if is_aggregate_only(body) {
        return None;
    }

    // Splice ` LIMIT n` after the last meaningful character. Trailing `;`,
    // whitespace and comments were turned into spaces by the mask, so stripping
    // them here lands the insertion ahead of any trailing comment/semicolon.
    let mut end = masked.len();
    while end > 0 {
        let c = masked[end - 1];
        if c.is_whitespace() || c == ';' {
            end -= 1;
        } else {
            break;
        }
    }
    let mut out: String = orig[..end].iter().collect();
    out.push_str(&format!(" LIMIT {limit}"));
    out.extend(orig[end..].iter());
    Some(out)
}

/// Driver-aware entry point for the automatic row cap: MySQL / PostgreSQL /
/// SQLite all understand a trailing `LIMIT n` and go through
/// [`apply_auto_limit`] unchanged, but Microsoft SQL Server (#729) has no
/// `LIMIT` keyword — the equivalent is `TOP (n)` spliced right after the
/// leading `SELECT` (and `DISTINCT`, if present). Callers that know the
/// target driver (`commands::query`) should use this instead of calling
/// [`apply_auto_limit`] directly.
///
/// String literals are masked with `driver`'s own escaping rules
/// ([`mask_for_driver`], #852) rather than always assuming MySQL's.
pub fn apply_auto_limit_for(driver: DriverKind, sql: &str, limit: usize) -> Option<String> {
    match driver {
        // T-SQL has no backslash string escapes, so the MSSQL rewriter's own
        // conservative mask already matches `mask_for_driver(Mssql, …)`.
        DriverKind::Mssql => apply_auto_limit_mssql(sql, limit),
        DriverKind::Mysql | DriverKind::Postgres | DriverKind::Sqlite | DriverKind::DuckDb => {
            let orig: Vec<char> = sql.chars().collect();
            let masked = mask_for_driver(driver, &orig);
            apply_auto_limit_masked(&orig, &masked, limit)
        }
    }
}

/// `TOP (n)` variant of [`apply_auto_limit`] for Microsoft SQL Server (#729).
/// Shares the same eligibility checks (masked/lowercased body, write-keyword
/// scan, aggregate-only detection) but rewrites by inserting `TOP (n)` right
/// after the leading `SELECT` [`DISTINCT`] keywords rather than appending a
/// trailing clause, because that is where T-SQL's row-cap syntax lives
/// (`SELECT [DISTINCT] TOP (n) ...`).
///
/// **Deliberately conservative beyond what [`apply_auto_limit`] checks**:
/// only a bare `SELECT ...` is rewritten. `WITH ... SELECT` (CTEs) are left
/// untouched (`None`) — unlike a trailing `LIMIT`, `TOP` must be spliced
/// right after the *specific* `SELECT` keyword that starts the outermost
/// query, and locating that (as opposed to the first `SELECT` textually,
/// which is typically inside the CTE body) is not attempted here. This is
/// the same "when in doubt, don't rewrite" philosophy as the rest of this
/// module. A statement that already contains `TOP`, `OFFSET`, or `FETCH`
/// (T-SQL's `OFFSET ... FETCH NEXT ... ROWS ONLY` pagination clause) is left
/// alone, same as an existing `LIMIT`/`OFFSET` on the other drivers.
///
/// **Driver-less entry point**: masks conservatively, which happens to match
/// MSSQL's own rules (`\` is not a string escape in T-SQL), so this and
/// [`apply_auto_limit_for`]`(DriverKind::Mssql, …)` always agree.
pub fn apply_auto_limit_mssql(sql: &str, limit: usize) -> Option<String> {
    let orig: Vec<char> = sql.chars().collect();
    apply_auto_limit_mssql_masked(&orig, &mask_for_analysis_conservative(&orig), limit)
}

/// Shared body of [`apply_auto_limit_mssql`] and its driver-aware caller.
fn apply_auto_limit_mssql_masked(orig: &[char], masked: &[char], limit: usize) -> Option<String> {
    if limit == 0 {
        return None;
    }
    let masked_lower: String = masked.iter().collect::<String>().to_ascii_lowercase();

    let body = masked_lower
        .trim()
        .trim_end_matches(|c: char| c == ';' || c.is_whitespace())
        .trim_start();
    if body.is_empty() {
        return None;
    }
    // `WITH ...` (CTEs) intentionally unsupported here — see doc comment.
    if !starts_with_word(body, "select") {
        return None;
    }
    if contains_word(body, "top") || contains_word(body, "offset") || contains_word(body, "fetch") {
        return None;
    }
    for kw in ["insert", "update", "delete", "into"] {
        if contains_word(body, kw) {
            return None;
        }
    }
    if has_locking_clause(body) {
        return None;
    }
    if is_aggregate_only(body) {
        return None;
    }
    // T-SQL's `TOP` only caps the `SELECT` it's spliced into, not the whole
    // statement — unlike the trailing `LIMIT` the other drivers get, which
    // caps the entire `UNION`/`INTERSECT`/`EXCEPT` result. Inserting `TOP (n)`
    // right after the leading `SELECT` here would only bound the *first*
    // branch, leaving `SELECT ... UNION ALL SELECT ...` unbounded on its
    // later branches — a silently-broken cap is worse than no cap, since the
    // caller believes the row count is under control. Same "when in doubt,
    // don't rewrite" posture as the rest of this function: decline instead.
    // Depth-tracked ([`has_top_level_set_operator`]) so a set operator
    // entirely inside a subquery (`FROM (SELECT a UNION SELECT b) x`) does
    // not trigger this — only one joining the statement's own top-level
    // `SELECT` branches does.
    if has_top_level_set_operator(body) {
        return None;
    }

    // Locate the leading `SELECT` (and optional `DISTINCT`) in the
    // *untrimmed* masked/lowercased text, so indices still line up with
    // `orig`. `body` above was only used for the eligibility checks. Compares
    // `Vec<char>` slices throughout (never byte-slices the `String`) so this
    // stays correct even if a non-ASCII identifier appears later in the SQL.
    let full: Vec<char> = masked_lower.chars().collect();
    let mut start = 0usize;
    while start < full.len() && full[start].is_whitespace() {
        start += 1;
    }
    // `body` starting with "select" guarantees this prefix is present.
    let mut end = start + "select".len();
    let mut after_ws = end;
    while after_ws < full.len() && full[after_ws].is_whitespace() {
        after_ws += 1;
    }
    let distinct: Vec<char> = "distinct".chars().collect();
    if full.len() >= after_ws + distinct.len()
        && full[after_ws..after_ws + distinct.len()] == distinct[..]
        && (after_ws + distinct.len() == full.len()
            || !is_word_char(full[after_ws + distinct.len()]))
    {
        end = after_ws + distinct.len();
    }

    let mut out: String = orig[..end].iter().collect();
    out.push_str(&format!(" TOP ({limit})"));
    out.extend(orig[end..].iter());
    Some(out)
}

/// True when `sql` packs more than one statement — i.e. a `;` separates
/// statements rather than merely trailing the final one. Comments and the
/// interior of string / quoted-identifier literals are masked first (reusing
/// the same masking rules), so a `;` inside `'a;b'` or `-- drop; this` is not
/// mistaken for a separator. Trailing `;` and whitespace are tolerated.
///
/// Used to fail-closed on stacked queries in the dry-run preview path: a DDL
/// stacked after a DML (`UPDATE …; DROP TABLE …`) would implicitly commit on
/// MySQL and so escape the rollback that makes the preview safe. sqlx's
/// prepared-statement execution already rejects multi-statement strings, but
/// this makes that guarantee explicit instead of leaning on a library detail.
///
/// **Driver-less entry point**: masks conservatively (#852), which reveals at
/// least as many `;` separators as the MySQL reading would — the fail-closed
/// direction for a check whose `true` means "refuse to run this". Driver
/// modules use [`has_stacked_statements_for`].
pub(crate) fn has_stacked_statements(sql: &str) -> bool {
    let orig: Vec<char> = sql.chars().collect();
    has_stacked_statements_masked(&mask_for_analysis_conservative(&orig))
}

/// Driver-aware entry point for [`has_stacked_statements`] (#852). Each
/// driver's `preview_execute_with_limit` passes its own [`DriverKind`] so a
/// PostgreSQL / SQLite / DuckDB / MSSQL payload is not analysed with MySQL's
/// backslash-escape reading, which would hide the stacked `;` in
/// `UPDATE t SET s = '\'; DROP TABLE t; --'`.
pub(crate) fn has_stacked_statements_for(driver: DriverKind, sql: &str) -> bool {
    let orig: Vec<char> = sql.chars().collect();
    has_stacked_statements_masked(&mask_for_driver(driver, &orig))
}

fn has_stacked_statements_masked(masked: &[char]) -> bool {
    let masked_str: String = masked.iter().collect();
    let body = masked_str.trim_end_matches(|c: char| c == ';' || c.is_whitespace());
    body.contains(';')
}

/// Best-effort safety net for **session-initialization SQL** (#522), run on every
/// physical pool connection right after it is established. To keep init SQL from
/// becoming a data-mutation or DDL backdoor — and to stay consistent with
/// read-only sessions — **every** statement must be a non-mutating session
/// setting: it starts with `SET` (search_path / time_zone / sql_mode / NAMES /
/// ROLE / statement_timeout, ...) or `PRAGMA` (the SQLite analog), or it is a
/// read-only query per [`is_read_only_sql`]. A `USE`, `INSERT`, `CREATE`, etc.
/// makes the whole string invalid. Empty input (only whitespace / comments / bare
/// `;`) is allowed and runs nothing.
///
/// Comments and string / quoted-identifier literals are masked with
/// [`mask_for_analysis_conservative`] — this input is executed verbatim
/// against whichever driver the profile targets (including PostgreSQL /
/// SQLite, where `\` is not a string escape), and a MySQL-flavoured mask can
/// be tricked into treating a stray `\'` as an escaped quote, hiding a
/// stacked statement inside what it thinks is still an open string literal.
///
/// Statement boundaries are found by walking the masked/lowercased text
/// alongside the **original**, unmasked text at the same char positions
/// (both are produced by [`mask_for_analysis_conservative`], which preserves
/// the input's char count) rather than by `str::split`, because
/// [`is_allowed_set_statement`] needs the original — unmasked — text of each
/// `SET` statement to see *into* its string-literal argument (see that
/// function's doc comment for why).
pub fn is_session_init_sql(sql: &str) -> bool {
    let orig: Vec<char> = sql.chars().collect();
    let masked = mask_for_analysis_conservative(&orig);
    let masked_lower: Vec<char> = masked.iter().map(|c| c.to_ascii_lowercase()).collect();
    let n = masked_lower.len();
    let mut start = 0usize;
    let mut i = 0usize;
    while i <= n {
        if i == n || masked_lower[i] == ';' {
            let seg: String = masked_lower[start..i].iter().collect();
            let s = seg.trim();
            if !s.is_empty() {
                let orig_seg: String = orig[start..i].iter().collect();
                let allowed = (starts_with_word(s, "set")
                    && is_allowed_set_statement(s, &orig_seg))
                    || starts_with_word(s, "pragma")
                    || is_read_only_sql(s);
                if !allowed {
                    return false;
                }
            }
            start = i + 1;
        }
        i += 1;
    }
    true
}

/// Narrows the blanket `starts_with_word(s, "set")` allowance in
/// [`is_session_init_sql`]: a bare `SET` changes one session-local setting
/// and is safe (`SET SESSION …` / `SET LOCAL …` / `SET NAMES …` /
/// `SET ROLE …` / `SET search_path …` / `SET time_zone …` / `SET x = y`),
/// but a handful of `SET` sub-forms reach further than "this session" and
/// must not be let through a read-only profile's init SQL:
///
/// * `SET GLOBAL …` (MySQL) mutates server-wide configuration, not just the
///   current connection.
/// * `SET PASSWORD …` (MySQL) changes an account's credentials.
/// * `SET STATEMENT … FOR <stmt>` (MariaDB) wraps an arbitrary statement —
///   including DML/DDL — as a session-setting prefix, which would otherwise
///   sail through as "starts with SET".
/// * `SET (SESSION/GLOBAL/@@…)? sql_mode = '…NO_BACKSLASH_ESCAPES…'` (MySQL) —
///   see [`sets_no_backslash_escapes_mode`]: it doesn't reach beyond the
///   session, but it invalidates a premise every write-detection safety net
///   in this module relies on for the rest of the session (`is_read_only_sql`
///   / `has_stacked_statements` / `apply_auto_limit` / `classify_write_kind`,
///   via [`driver_backslash_escapes`]), so it's rejected here rather than let
///   through and silently desynchronising the mask from the server.
///
/// `s` must already be masked (literals/comments blanked) and lowercased, as
/// produced by [`is_session_init_sql`]. `orig_segment` is the *unmasked*
/// source text of the same statement (same slice of the original SQL,
/// case preserved) — needed only for the `sql_mode` check above, since the
/// mode name normally lives inside a string-literal argument that `s` has
/// had blanked out.
fn is_allowed_set_statement(s: &str, orig_segment: &str) -> bool {
    let rest = s["set".len()..].trim_start();
    let next_word: &str = rest
        .split(|c: char| !is_word_char(c))
        .find(|w| !w.is_empty())
        .unwrap_or("");
    // `PERSIST` / `PERSIST_ONLY` は MySQL 8.0 の永続化構文で、`GLOBAL` より
    // 影響が広い: グローバル変数を書き換えたうえで `mysqld-auto.cnf` に保存し、
    // **サーバ再起動後も残る**。セッション初期化 SQL は「このセッションの
    // 再現性を整える」ためのものなので、サーバ全体・他ユーザ・次回起動まで
    // 波及する設定は `GLOBAL` と同じく拒否する。
    if matches!(
        next_word,
        "global" | "password" | "statement" | "persist" | "persist_only"
    ) {
        return false;
    }
    !sets_no_backslash_escapes_mode(orig_segment)
}

/// True when `orig_segment` — the **unmasked** source text of a single `SET`
/// statement — sets MySQL/MariaDB's `sql_mode` to a value containing
/// `NO_BACKSLASH_ESCAPES` (e.g. `SET sql_mode = 'NO_BACKSLASH_ESCAPES'`,
/// `SET @@SESSION.sql_mode := 'STRICT_TRANS_TABLES,NO_BACKSLASH_ESCAPES'`).
///
/// This deliberately reads the **original, unmasked** text rather than the
/// masked/lowercased `s` every other check in [`is_session_init_sql`] uses:
/// the mode name is the *value* of a string-literal argument, so
/// [`mask_for_analysis_conservative`] has already blanked exactly the text
/// this check needs to see. Matching is a loose word-bounded "does
/// `sql_mode` and `no_backslash_escapes` both appear somewhere in this
/// statement", not a strict `SET sql_mode = '...'` shape, so the `SESSION` /
/// `GLOBAL` / `@@` / `:=` spelling variants above are all still caught —
/// erring toward over-detection is the fail-closed direction here.
///
/// **Why this matters**: [`driver_backslash_escapes`] treats MySQL/MariaDB's
/// `\` inside a string literal as an escape character unconditionally,
/// because that's the server default. But `NO_BACKSLASH_ESCAPES` flips that
/// per-session — once it's set, the *server* stops treating `\` as an escape,
/// while every safety net built on [`mask_for_driver`] (`is_read_only_sql` /
/// `has_stacked_statements` / `apply_auto_limit` / `classify_write_kind`)
/// keeps assuming it still is. That desync lets a payload like
/// `SELECT * FROM t WHERE x = '\'; DROP TABLE users -- '` be misread as one
/// still-open string literal (hiding the stacked `DROP TABLE`) when the real
/// server would see the literal close at the first `'` and execute the
/// second statement. Session-initialization SQL is the one place a read-only
/// profile could otherwise flip this mode for the rest of the session, so it
/// is rejected outright here rather than accepted and silently invalidating
/// every later mask on this connection.
fn sets_no_backslash_escapes_mode(orig_segment: &str) -> bool {
    let lower = orig_segment.to_ascii_lowercase();
    contains_word(&lower, "sql_mode") && contains_word(&lower, "no_backslash_escapes")
}

/// Replaces every comment and the interior of every string / quoted-identifier
/// literal with spaces, preserving the original char count so positions still
/// line up with the source. Newlines inside comments are kept so line-comment
/// boundaries survive. `\` is **not** treated as a string escape character.
///
/// PostgreSQL (with the default `standard_conforming_strings = on`), SQLite,
/// DuckDB and Microsoft SQL Server all treat `\` inside `'…'` as an ordinary
/// character, so a literal there is closed by the first unescaped, non-doubled
/// quote — not by skipping over a backslash-escaped one. Masking those
/// dialects with MySQL's reading (`backslash_escapes = true`) lets a payload
/// like `'\'; DELETE FROM t; --'` be mis-read as one still-open string,
/// hiding the `; DELETE …` as if it were inside the literal.
///
/// This is intentionally the more conservative reading: a string literal can
/// only close *earlier* than the MySQL-flavoured mask would judge, never
/// later, so real SQL keywords are never hidden that the MySQL mask would
/// have revealed — only the reverse. That means a small number of otherwise
/// legitimate MySQL statements containing `\'` inside a string could be
/// rejected; that's an acceptable false-negative (fail closed) for the
/// driver-less entry points that use this mask ([`is_read_only_sql`],
/// [`has_stacked_statements`], [`apply_auto_limit`], [`classify_write_kind`],
/// [`is_session_init_sql`]). Callers holding a [`DriverKind`] should use
/// [`mask_for_driver`] so MySQL keeps its own rules.
///
/// `pub(crate)` (rather than private) so `lib.rs::__test_api` can re-export a
/// thin `&str -> String` wrapper for the shared frontend/backend masking
/// golden (`tests/mask_golden.rs`, #988).
pub(crate) fn mask_for_analysis_conservative(src: &[char]) -> Vec<char> {
    mask_for_analysis_impl(src, false)
}

/// True when `driver` treats `\` inside a `'…'` / `"…"` string literal as an
/// escape character. Only MySQL/MariaDB does (with the default
/// `NO_BACKSLASH_ESCAPES` off); PostgreSQL (`standard_conforming_strings = on`),
/// SQLite, DuckDB and Microsoft SQL Server all read `\` as an ordinary
/// character, so a literal there closes at the first unescaped, non-doubled
/// quote.
fn driver_backslash_escapes(driver: DriverKind) -> bool {
    match driver {
        DriverKind::Mysql => true,
        DriverKind::Postgres | DriverKind::Sqlite | DriverKind::DuckDb | DriverKind::Mssql => false,
    }
}

/// Masks `src` for analysis using the string-escaping rules of `driver` (#852).
///
/// The safety nets built on this mask ([`is_read_only_sql_for`],
/// [`has_stacked_statements_for`], [`apply_auto_limit_for`],
/// [`classify_write_kind_for`]) used to mask with the MySQL-flavoured mask
/// regardless of the target driver, which **fails open** on the other
/// dialects: given `SELECT '\'; DELETE FROM t; --'`, the MySQL reading treats
/// `\'` as an escaped quote and swallows the `; DELETE …` as
/// still-inside-the-literal, so neither the stacked `;` nor the `delete`
/// keyword is visible. PostgreSQL / SQLite / DuckDB / MSSQL actually close the
/// literal at that quote and run a real stacked write.
///
/// Callers that know their driver should always route through the `*_for`
/// entry points; the driver-less variants deliberately fall back to the
/// stricter [`mask_for_analysis_conservative`] reading (see
/// [`is_read_only_sql`]).
///
/// `pub(crate)` (rather than private) for the same reason as
/// [`mask_for_analysis_conservative`] — re-exported for `tests/mask_golden.rs`
/// (#988).
pub(crate) fn mask_for_driver(driver: DriverKind, src: &[char]) -> Vec<char> {
    mask_for_analysis_impl(src, driver_backslash_escapes(driver))
}

/// Shared implementation for [`mask_for_analysis_conservative`] /
/// [`mask_for_driver`]. `backslash_escapes` controls whether
/// `\` inside a `'…'` / `"…"` literal is treated as escaping the following
/// character (MySQL) or as an ordinary character (PostgreSQL / SQLite).
fn mask_for_analysis_impl(src: &[char], backslash_escapes: bool) -> Vec<char> {
    let mut out: Vec<char> = Vec::with_capacity(src.len());
    let n = src.len();
    let mut i = 0;
    while i < n {
        let c = src[i];
        // Line comment: `-- …` or `# …`, terminated by newline.
        if (c == '-' && i + 1 < n && src[i + 1] == '-') || c == '#' {
            while i < n && src[i] != '\n' {
                out.push(' ');
                i += 1;
            }
            continue;
        }
        // MySQL "version comment" `/*! … */` (optionally with a 5-digit version
        // number right after the `!`, e.g. `/*!50000 … */`). Despite the `/*`
        // spelling, MySQL does **not** treat this as a comment — it's a
        // conditional-execution marker whose body actually *runs* (on servers
        // new enough to satisfy the optional version gate). Blanking the
        // interior the way a normal `/* … */` block comment is blanked would
        // hide real, executable SQL from every keyword/`;` scan built on this
        // mask (`SELECT * FROM t /*!50000 , (SELECT ... ) */` can smuggle a
        // write past [`is_read_only_sql`]). So only the opening delimiter
        // (`/*!` plus any immediately-following digits) is turned into spaces
        // here; the body is left for the normal per-character dispatch below
        // to keep scanning — so a quote or nested comment inside it is still
        // masked correctly — and the closing `*/`, which no rule below
        // specially recognises, simply passes through unchanged as two
        // ordinary characters (harmless: neither is a word character, so it
        // can't hide or fabricate a keyword boundary). Applied unconditionally
        // regardless of `backslash_escapes` (MySQL vs. conservative mask) per
        // the module's fail-closed policy — revealing more can only make a
        // check reject a statement it previously allowed, never the reverse.
        if c == '/' && i + 1 < n && src[i + 1] == '*' && i + 2 < n && src[i + 2] == '!' {
            out.push(' ');
            out.push(' ');
            out.push(' ');
            i += 3;
            while i < n && src[i].is_ascii_digit() {
                out.push(' ');
                i += 1;
            }
            continue;
        }
        // Block comment: `/* … */`.
        if c == '/' && i + 1 < n && src[i + 1] == '*' {
            out.push(' ');
            out.push(' ');
            i += 2;
            while i < n {
                if src[i] == '*' && i + 1 < n && src[i + 1] == '/' {
                    out.push(' ');
                    out.push(' ');
                    i += 2;
                    break;
                }
                out.push(if src[i] == '\n' { '\n' } else { ' ' });
                i += 1;
            }
            continue;
        }
        // Dollar-quoted string (PostgreSQL): `$$…$$` or `$tag$…$tag$`. Only
        // treated as a string when the opening tag is valid (empty or
        // identifier-like, not starting with a digit — `$1` is a parameter
        // placeholder) and a matching closing tag exists; otherwise the `$`
        // is left as-is so any keywords stay visible, which is the
        // fail-closed direction for the gates built on this mask. A `$`
        // straight after a word char is part of an identifier (MySQL allows
        // `$` in names), never an opening tag.
        if c == '$' && (i == 0 || !is_word_char(src[i - 1])) {
            if let Some(tag_len) = dollar_quote_tag_len(src, i) {
                if let Some(close) = find_dollar_tag(src, i + tag_len, &src[i..i + tag_len]) {
                    // Keep both delimiters, blank the interior (preserving
                    // newlines) so token boundaries and positions survive.
                    out.extend_from_slice(&src[i..i + tag_len]);
                    for &d in &src[i + tag_len..close] {
                        out.push(if d == '\n' { '\n' } else { ' ' });
                    }
                    out.extend_from_slice(&src[close..close + tag_len]);
                    i = close + tag_len;
                    continue;
                }
            }
        }
        // Quoted literal / identifier: '…' "…" `…`.
        if c == '\'' || c == '"' || c == '`' {
            let quote = c;
            out.push(c);
            i += 1;
            while i < n {
                let d = src[i];
                // Backslash escape (MySQL string literals only; skipped
                // entirely under the conservative/non-MySQL reading).
                if backslash_escapes && d == '\\' && quote != '`' && i + 1 < n {
                    out.push(' ');
                    out.push(' ');
                    i += 2;
                    continue;
                }
                if d == quote {
                    // Doubled quote is an escaped quote, not a terminator.
                    if i + 1 < n && src[i + 1] == quote {
                        out.push(' ');
                        out.push(' ');
                        i += 2;
                        continue;
                    }
                    out.push(quote);
                    i += 1;
                    break;
                }
                out.push(if d == '\n' { '\n' } else { ' ' });
                i += 1;
            }
            continue;
        }
        out.push(c);
        i += 1;
    }
    out
}

/// Which driver's string / comment syntaxes [`strip_sql_comments`] should
/// recognise. The differences that matter here:
///
/// * MySQL: `#` starts a line comment, `--` starts one only when followed by
///   whitespace or a control character (`x--1` is `x - (-1)`), backslash
///   escapes work inside `'…'` / `"…"` strings, and backticks quote
///   identifiers.
/// * PostgreSQL: dollar-quoted strings (`$$…$$` / `$tag$…$tag$`) must be
///   preserved verbatim, block comments nest, and backslash is not an escape
///   in standard strings.
/// * SQLite: like PostgreSQL minus dollar quotes and comment nesting, plus
///   backtick identifiers.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum SqlFlavor {
    MySql,
    Postgres,
    Sqlite,
}

/// Removes line (`-- …`, MySQL `# …`) and block (`/* … */`) comments from
/// `sql`, leaving everything else verbatim. String literals and quoted
/// identifiers are tracked so a comment marker *inside* a string — e.g.
/// `'a -- b'` or `'url: /*x*/'` — is not mistaken for a comment and the
/// string survives intact. Line comments keep their terminating newline;
/// block comments collapse to a single space (so `a/*x*/b` stays two tokens).
///
/// Used by the per-driver `tokenize_sql` / `extract_where_and_after` helpers
/// on the dry-run preview path.
pub(crate) fn strip_sql_comments(sql: &str, flavor: SqlFlavor) -> String {
    let src: Vec<char> = sql.chars().collect();
    let n = src.len();
    let mut out = String::with_capacity(sql.len());
    let mut i = 0;
    while i < n {
        let c = src[i];
        // Line comment: `-- …` up to newline, plus `# …` on MySQL. MySQL only
        // treats `--` as a comment opener when followed by whitespace or a
        // control character — `balance--1` is `balance - (-1)` there — while
        // PostgreSQL / SQLite need no separator.
        let dash_comment = c == '-'
            && i + 1 < n
            && src[i + 1] == '-'
            && match flavor {
                SqlFlavor::MySql => {
                    i + 2 < n && (src[i + 2].is_ascii_whitespace() || src[i + 2].is_ascii_control())
                }
                SqlFlavor::Postgres | SqlFlavor::Sqlite => true,
            };
        if dash_comment || (c == '#' && flavor == SqlFlavor::MySql) {
            while i < n && src[i] != '\n' {
                i += 1;
            }
            continue; // the newline itself is emitted by the loop below
        }
        // Block comment: `/* … */` → one space. PostgreSQL block comments
        // nest (`/* a /* b */ c */` is one comment), so track depth there;
        // MySQL / SQLite end at the first `*/`.
        if c == '/' && i + 1 < n && src[i + 1] == '*' {
            let mut depth = 1usize;
            i += 2;
            while i < n && depth > 0 {
                if src[i] == '*' && i + 1 < n && src[i + 1] == '/' {
                    depth -= 1;
                    i += 2;
                } else if flavor == SqlFlavor::Postgres
                    && src[i] == '/'
                    && i + 1 < n
                    && src[i + 1] == '*'
                {
                    depth += 1;
                    i += 2;
                } else {
                    i += 1;
                }
            }
            out.push(' ');
            continue;
        }
        // Dollar-quoted string (PostgreSQL): copy verbatim through the
        // matching closing tag. Without a closing tag the `$` is literal.
        if flavor == SqlFlavor::Postgres && c == '$' && (i == 0 || !is_word_char(src[i - 1])) {
            if let Some(tag_len) = dollar_quote_tag_len(&src, i) {
                if let Some(close) = find_dollar_tag(&src, i + tag_len, &src[i..i + tag_len]) {
                    out.extend(&src[i..close + tag_len]);
                    i = close + tag_len;
                    continue;
                }
            }
        }
        // String literal / quoted identifier: copy verbatim to the closing
        // delimiter (honouring doubled-quote escapes, and backslash escapes
        // in MySQL strings).
        if c == '\'' || c == '"' || c == '`' {
            let quote = c;
            let backslash_escapes = flavor == SqlFlavor::MySql && quote != '`';
            out.push(c);
            i += 1;
            while i < n {
                let d = src[i];
                if backslash_escapes && d == '\\' && i + 1 < n {
                    out.push(d);
                    out.push(src[i + 1]);
                    i += 2;
                    continue;
                }
                out.push(d);
                i += 1;
                if d == quote {
                    if i < n && src[i] == quote {
                        // Doubled quote: escaped delimiter, keep going.
                        out.push(quote);
                        i += 1;
                        continue;
                    }
                    break;
                }
            }
            continue;
        }
        out.push(c);
        i += 1;
    }
    out
}

/// Length (in chars, including both `$`) of a dollar-quote tag starting at
/// `src[i]` (which must be `$`), or `None` when what follows is not a valid
/// tag. Valid tags are `$$` or `$tag$` where `tag` is identifier-like and
/// does not start with a digit (`$1` is a Postgres parameter placeholder).
fn dollar_quote_tag_len(src: &[char], i: usize) -> Option<usize> {
    let n = src.len();
    let mut j = i + 1;
    if j < n && src[j].is_ascii_digit() {
        return None;
    }
    while j < n && (src[j].is_ascii_alphanumeric() || src[j] == '_') {
        j += 1;
    }
    (j < n && src[j] == '$').then_some(j + 1 - i)
}

/// Index of the next occurrence of `tag` in `src` at or after `from`.
fn find_dollar_tag(src: &[char], from: usize, tag: &[char]) -> Option<usize> {
    let n = src.len();
    let m = tag.len();
    (from..n.checked_sub(m)? + 1).find(|&k| src[k..k + m] == *tag)
}

fn is_word_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

fn is_word_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// True when `s` begins with `word` followed by a non-word boundary.
fn starts_with_word(s: &str, word: &str) -> bool {
    let sb = s.as_bytes();
    let wb = word.as_bytes();
    if sb.len() < wb.len() || &sb[..wb.len()] != wb {
        return false;
    }
    wb.len() >= sb.len() || !is_word_byte(sb[wb.len()])
}

/// True when `word` appears in `haystack` bounded by non-word characters.
/// `haystack` is expected to be lowercase ASCII keywords; matching by bytes is
/// safe because ASCII bytes never occur inside a multi-byte UTF-8 sequence.
fn contains_word(haystack: &str, word: &str) -> bool {
    let hb = haystack.as_bytes();
    let wb = word.as_bytes();
    if wb.is_empty() || hb.len() < wb.len() {
        return false;
    }
    let mut i = 0;
    while i + wb.len() <= hb.len() {
        if &hb[i..i + wb.len()] == wb {
            let before_ok = i == 0 || !is_word_byte(hb[i - 1]);
            let after = i + wb.len();
            let after_ok = after >= hb.len() || !is_word_byte(hb[after]);
            if before_ok && after_ok {
                return true;
            }
        }
        i += 1;
    }
    false
}

/// True when a plain `SELECT` returns a single aggregate row (no GROUP BY,
/// window functions or DISTINCT) so an automatic LIMIT would be pointless.
/// Errs toward `false`: when unsure we let the LIMIT through, which is the safe
/// direction (capping a result we misjudged is harmless; failing to cap a huge
/// one is the bug we are guarding against).
fn is_aggregate_only(body: &str) -> bool {
    if !starts_with_word(body, "select") {
        return false;
    }
    // GROUP BY, window functions (`OVER`) and DISTINCT can each yield many rows.
    if contains_word(body, "group")
        || contains_word(body, "over")
        || contains_word(body, "distinct")
    {
        return false;
    }
    let Some(list) = top_level_select_list(&body["select".len()..]) else {
        return false;
    };
    let items = split_top_level_commas(list);
    !items.is_empty() && items.iter().all(|item| is_aggregate_expr(item.trim()))
}

/// Returns the select list (text before the first depth-0 `from`), or `None`
/// when there is no top-level FROM.
fn top_level_select_list(s: &str) -> Option<&str> {
    let b = s.as_bytes();
    let mut depth = 0i32;
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'(' => depth += 1,
            b')' if depth > 0 => depth -= 1,
            b'f' if depth == 0 && i + 4 <= b.len() && &b[i..i + 4] == b"from" => {
                let before_ok = i == 0 || !is_word_byte(b[i - 1]);
                let after_ok = i + 4 >= b.len() || !is_word_byte(b[i + 4]);
                if before_ok && after_ok {
                    return Some(&s[..i]);
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

/// True when masked/lowercased `body` contains a `UNION` / `INTERSECT` /
/// `EXCEPT` set operator keyword at parenthesis depth 0 — i.e. one joining
/// the statement's *own* top-level `SELECT` to another branch, not one
/// buried inside a subquery. Depth-tracked the same way as
/// [`top_level_select_list`], so `SELECT * FROM (SELECT a UNION SELECT b) x`
/// (a `UNION` entirely inside a derived table) does not count, only
/// `SELECT a UNION SELECT b` at the top does. Used by
/// [`apply_auto_limit_mssql_masked`] (#mssql-top-set-ops) to decline rewriting
/// a `SELECT` whose T-SQL `TOP` would only cap one branch of a multi-branch
/// result.
fn has_top_level_set_operator(body: &str) -> bool {
    const KEYWORDS: [&str; 3] = ["union", "intersect", "except"];
    let b = body.as_bytes();
    let mut depth = 0i32;
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'(' => depth += 1,
            b')' if depth > 0 => depth -= 1,
            _ if depth == 0 => {
                for kw in KEYWORDS {
                    let kb = kw.as_bytes();
                    if i + kb.len() <= b.len() && &b[i..i + kb.len()] == kb {
                        let before_ok = i == 0 || !is_word_byte(b[i - 1]);
                        let after = i + kb.len();
                        let after_ok = after >= b.len() || !is_word_byte(b[after]);
                        if before_ok && after_ok {
                            return true;
                        }
                    }
                }
            }
            _ => {}
        }
        i += 1;
    }
    false
}

fn split_top_level_commas(s: &str) -> Vec<&str> {
    let b = s.as_bytes();
    let mut depth = 0i32;
    let mut parts = Vec::new();
    let mut start = 0;
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'(' => depth += 1,
            b')' if depth > 0 => depth -= 1,
            b',' if depth == 0 => {
                parts.push(&s[start..i]);
                start = i + 1;
            }
            _ => {}
        }
        i += 1;
    }
    parts.push(&s[start..]);
    parts
}

/// True when `item` is wholly an aggregate function call, e.g. `count(*)` or
/// `sum(x) as total`. The `(` requirement enforces a word boundary so column
/// names like `counter` or `mineral` do not match.
fn is_aggregate_expr(item: &str) -> bool {
    const AGGS: [&str; 16] = [
        "count",
        "sum",
        "avg",
        "min",
        "max",
        "group_concat",
        "std",
        "stddev",
        "stddev_pop",
        "stddev_samp",
        "var_pop",
        "var_samp",
        "variance",
        "bit_and",
        "bit_or",
        "bit_xor",
    ];
    AGGS.iter().any(|name| {
        item.strip_prefix(name)
            .is_some_and(|rest| rest.trim_start().starts_with('('))
    })
}

#[cfg(test)]
mod tests {
    use super::{
        apply_auto_limit, apply_auto_limit_for, apply_auto_limit_mssql, classify_write_kind,
        classify_write_kind_for, has_stacked_statements, has_stacked_statements_for,
        is_read_only_sql, is_read_only_sql_for, is_session_init_sql, mask_sensitive_var,
        sum_size_parts, DriverKind, SslMode, WriteKind,
    };

    /// Drivers whose string literals follow the standard reading (`\` is an
    /// ordinary character), i.e. everything except MySQL (#852).
    const STANDARD_DRIVERS: [DriverKind; 4] = [
        DriverKind::Postgres,
        DriverKind::Sqlite,
        DriverKind::DuckDb,
        DriverKind::Mssql,
    ];

    #[test]
    fn sum_size_parts_treats_missing_part_as_zero() {
        assert_eq!(sum_size_parts(None, None), None);
        assert_eq!(sum_size_parts(Some(100), None), Some(100));
        assert_eq!(sum_size_parts(None, Some(40)), Some(40));
        assert_eq!(sum_size_parts(Some(100), Some(40)), Some(140));
    }

    #[test]
    fn mask_sensitive_var_masks_only_secret_named_nonempty_values() {
        assert_eq!(mask_sensitive_var("max_connections", "151".into()), "151");
        assert_eq!(
            mask_sensitive_var("master_password", "hunter2".into()),
            "********"
        );
        assert_eq!(
            mask_sensitive_var("SSL_PRIVATE_KEY", "----".into()),
            "********"
        );
        // Empty values are never masked (nothing to hide; keeps NULL display).
        assert_eq!(mask_sensitive_var("admin_password", String::new()), "");
    }

    #[test]
    fn session_init_allows_set_pragma_and_read_only() {
        assert!(is_session_init_sql("SET search_path TO app, public"));
        assert!(is_session_init_sql("set time_zone = '+00:00'"));
        assert!(is_session_init_sql("SET sql_mode = 'STRICT_ALL_TABLES'"));
        assert!(is_session_init_sql("SET ROLE readonly"));
        assert!(is_session_init_sql("PRAGMA foreign_keys = ON"));
        // Multiple statements, each a setting, with trailing/blank separators.
        assert!(is_session_init_sql(
            "SET TIME ZONE 'UTC'; SET statement_timeout = 5000;"
        ));
        // Read-only queries are permitted (e.g. priming a cache / sanity probe).
        assert!(is_session_init_sql("SELECT set_config('x', 'y', false)"));
        // Empty / comment-only input runs nothing and is allowed.
        assert!(is_session_init_sql(""));
        assert!(is_session_init_sql("  ;  ;\n"));
        assert!(is_session_init_sql("-- just a comment"));
    }

    /// #906: T-SQL table hints that take stronger or longer-lived locks than a
    /// plain read must be rejected by the read-only guard, the same way
    /// `FOR UPDATE` / `LOCK IN SHARE MODE` already are on the other dialects.
    #[test]
    fn read_only_rejects_mssql_locking_table_hints() {
        for sql in [
            "SELECT * FROM [dbo].[users] WITH (UPDLOCK)",
            "SELECT * FROM users WITH (UPDLOCK, HOLDLOCK)",
            "SELECT * FROM users WITH (HOLDLOCK)",
            "SELECT * FROM users WITH (SERIALIZABLE)",
            "SELECT * FROM users WITH (REPEATABLEREAD)",
            "SELECT * FROM users WITH (READCOMMITTEDLOCK)",
            "SELECT * FROM users WITH (TABLOCKX)",
            "SELECT * FROM users WITH (XLOCK, ROWLOCK)",
            // No whitespace between `WITH` and `(`.
            "SELECT * FROM users WITH(UPDLOCK)",
            // Hint on the second table of a join.
            "SELECT a.id FROM a WITH (NOLOCK) JOIN b WITH (UPDLOCK) ON a.id = b.id",
            // Case and line breaks must not matter.
            "SELECT *\n  FROM users\n  WITH (updlock)",
        ] {
            assert!(
                !is_read_only_sql(sql),
                "expected {sql:?} to be rejected as a locking read"
            );
        }
    }

    /// The hint check must not fire on things that merely *look* like hints:
    /// lock-avoiding / granularity-only hints, ordinary CTEs, and columns that
    /// happen to be named after a hint (#906).
    #[test]
    fn read_only_allows_non_locking_hints_and_lookalikes() {
        for sql in [
            "SELECT * FROM users WITH (NOLOCK)",
            "SELECT * FROM users WITH (READUNCOMMITTED)",
            "SELECT * FROM users WITH (ROWLOCK)",
            "SELECT * FROM users WITH (TABLOCK)",
            // Parameterised hint: the nested `(0)` must not end the scan early.
            "SELECT * FROM users WITH (INDEX(0), NOLOCK)",
            // Columns named after hints, outside any WITH (...) group.
            "SELECT updlock, serializable FROM t",
            "SELECT * FROM t WHERE holdlock = 1",
            // Ordinary CTE — `WITH <name> AS (…)`, not a hint group.
            "WITH c AS (SELECT 1) SELECT * FROM c",
        ] {
            assert!(is_read_only_sql(sql), "expected {sql:?} to stay read-only");
        }
    }

    /// A statement that is a plain top-level `SELECT` can still smuggle a
    /// write past the keyword scan by handing it, as a string-literal
    /// argument, to a function that hands off execution to another engine —
    /// `OPENROWSET`/`OPENQUERY`/`OPENDATASOURCE` (MSSQL linked-server
    /// passthrough), `dblink`/`dblink_exec` (PostgreSQL cross-database query
    /// execution), and `load_extension` (SQLite native extension loading).
    /// All must be rejected, on every driver.
    #[test]
    fn read_only_rejects_cross_engine_write_passthrough() {
        for sql in [
            "SELECT * FROM OPENROWSET('SQLNCLI','Server=x;','UPDATE t SET a=1; SELECT 1') AS r",
            "SELECT * FROM OPENQUERY(linked_srv, 'DELETE FROM accounts')",
            "SELECT * FROM OPENDATASOURCE('SQLNCLI','Server=x;').db.dbo.t",
            "SELECT dblink_exec('dbname=other','DELETE FROM accounts')",
            "SELECT dblink('dbname=other','SELECT 1')",
            "SELECT load_extension('/tmp/evil.so')",
        ] {
            assert!(
                !is_read_only_sql(sql),
                "expected {sql:?} to be rejected as a cross-engine write passthrough"
            );
        }
        // Fail-closed: a column merely *named* after one of these functions is
        // also rejected. Over-detection here only costs an extra confirmation
        // prompt; under-detection would let a real payload through.
        assert!(!is_read_only_sql("SELECT openrowset FROM t"));
    }

    /// #mysql-versioned-comment: MySQL's `/*! … */` / `/*!50000 … */` "version
    /// comment" is not a comment at all — its body executes on servers new
    /// enough to satisfy the optional version gate — so the masking used by
    /// every safety net in this module must not blank it out the way a plain
    /// `/* … */` block comment is blanked, or a write hidden inside one would
    /// be invisible to the keyword scan.
    #[test]
    fn mask_reveals_mysql_versioned_comment_contents() {
        // A read-only body inside the version comment stays read-only.
        assert!(is_read_only_sql("SELECT /*!50000 * FROM users */ "));
        // Version number omitted (bare `/*!`) is still recognised as the same
        // non-comment construct.
        assert!(is_read_only_sql(
            "SELECT 1 /*! UNION SELECT password FROM users */"
        ));
        // A write keyword hidden inside the version comment must surface.
        assert!(!is_read_only_sql(
            "SELECT 1 /*!50000 , (SELECT DELETE FROM users) */"
        ));
        // An ordinary block comment (no `!`) is unaffected and still blanked.
        assert!(is_read_only_sql(
            "SELECT 1 /* normal comment with DELETE inside */"
        ));
    }

    #[test]
    fn init_sql_of_normalizes_comment_or_separator_only_to_none() {
        fn opts(init: Option<&str>) -> super::DbConnectOptions {
            super::DbConnectOptions {
                host: "h".into(),
                port: 1,
                user: "u".into(),
                password: String::new(),
                database: None,
                driver: super::DriverKind::Postgres,
                file_path: None,
                ssl_mode: None,
                ssl_root_cert: None,
                ssl_client_cert: None,
                ssl_client_key: None,
                init_sql: init.map(str::to_string),
            }
        }
        // No statement to run → None (so no after_connect hook runs an empty query).
        assert_eq!(super::init_sql_of(&opts(None)), None);
        assert_eq!(super::init_sql_of(&opts(Some("   "))), None);
        assert_eq!(super::init_sql_of(&opts(Some("  ;  ;\n"))), None);
        assert_eq!(super::init_sql_of(&opts(Some("-- just a comment"))), None);
        // A real statement is preserved (trimmed).
        assert_eq!(
            super::init_sql_of(&opts(Some("  SET time_zone = 'UTC'  "))).as_deref(),
            Some("SET time_zone = 'UTC'")
        );
        // A `;` inside a string literal is not a separator, so the statement counts.
        assert_eq!(
            super::init_sql_of(&opts(Some("SET application_name = 'a;b'"))).as_deref(),
            Some("SET application_name = 'a;b'")
        );
    }

    #[test]
    fn session_init_rejects_mutations_and_ddl() {
        assert!(!is_session_init_sql("INSERT INTO t VALUES (1)"));
        assert!(!is_session_init_sql("UPDATE t SET x = 1"));
        assert!(!is_session_init_sql("DELETE FROM t"));
        assert!(!is_session_init_sql("CREATE TABLE t (id int)"));
        assert!(!is_session_init_sql("DROP TABLE t"));
        assert!(!is_session_init_sql("USE other_db"));
        // One bad statement taints the whole multi-statement string.
        assert!(!is_session_init_sql("SET time_zone = 'UTC'; DELETE FROM t"));
        // A `;` hidden inside a string literal is not a statement boundary, so
        // this remains a single (allowed) SET statement.
        assert!(is_session_init_sql("SET application_name = 'a;b'"));
    }

    /// #852: the read-only guard used to mask with MySQL's backslash-escape
    /// rules on **every** driver, so `'\'` was read as an escaped quote and
    /// the `; DELETE …` behind it stayed hidden inside an apparently-open
    /// string literal. PostgreSQL / SQLite / DuckDB / MSSQL close the literal
    /// at that quote and would really run the stacked write.
    #[test]
    fn read_only_rejects_backslash_masked_stacked_write_on_standard_dialects() {
        const PAYLOADS: [&str; 3] = [
            r"SELECT '\'; DELETE FROM users; --'",
            r"SELECT '\'; DROP TABLE users; --'",
            // No write keyword at all — still a second statement.
            r"SELECT '\'; SELECT 2; --'",
        ];
        for sql in PAYLOADS {
            for driver in STANDARD_DRIVERS {
                assert!(
                    !is_read_only_sql_for(driver, sql),
                    "{driver:?} must not accept {sql:?} as read-only"
                );
            }
            // MySQL really does read this as one string literal, so it stays
            // read-only there — the whole point of the driver dimension.
            assert!(
                is_read_only_sql_for(DriverKind::Mysql, sql),
                "MySQL should still read {sql:?} as a single string literal"
            );
            // The driver-less entry point falls back to the strict reading.
            assert!(
                !is_read_only_sql(sql),
                "driver-less must fail closed on {sql:?}"
            );
        }
    }

    /// #1005: `VALUES (1),(2)` and `TABLE t` can only ever produce a result
    /// set (neither has a form that mutates data), so they're allowed for
    /// every driver — including the driver-less entry point — regardless of
    /// whether that driver's SQL dialect actually implements the statement.
    #[test]
    fn read_only_allows_values_and_table_for_every_driver() {
        for sql in [
            "VALUES (1), (2)",
            "VALUES (1)",
            "TABLE users",
            "TABLE users;",
        ] {
            assert!(is_read_only_sql(sql), "driver-less must accept {sql:?}");
            for driver in STANDARD_DRIVERS {
                assert!(
                    is_read_only_sql_for(driver, sql),
                    "{driver:?} must accept {sql:?}"
                );
            }
            assert!(
                is_read_only_sql_for(DriverKind::Mysql, sql),
                "Mysql must accept {sql:?}"
            );
        }
    }

    /// A statement hiding behind `VALUES`/`TABLE` is still a stacked second
    /// statement (#1005) — the new prefixes don't bypass the existing `;`
    /// check.
    #[test]
    fn read_only_rejects_stacked_statement_behind_values_and_table() {
        for sql in [
            "VALUES (1); DELETE FROM users",
            "TABLE users; DROP TABLE users",
        ] {
            assert!(!is_read_only_sql(sql), "must reject stacked {sql:?}");
            for driver in STANDARD_DRIVERS {
                assert!(
                    !is_read_only_sql_for(driver, sql),
                    "{driver:?} must reject stacked {sql:?}"
                );
            }
        }
    }

    /// #1005: DuckDB's FROM-first shorthand (`FROM t` for `SELECT * FROM t`)
    /// and `SUMMARIZE t` (read-only column statistics) are always read-only,
    /// but only DuckDB actually has this syntax — every other driver keeps
    /// rejecting it (fail-closed; `FROM`/`SUMMARIZE` simply aren't in their
    /// allow list, mirroring the fact that these dialects don't support the
    /// statement at all).
    #[test]
    fn read_only_duckdb_allows_from_and_summarize_only_for_duckdb() {
        for sql in ["FROM users", "FROM users LIMIT 10", "SUMMARIZE users"] {
            assert!(
                is_read_only_sql_for(DriverKind::DuckDb, sql),
                "DuckDB must accept {sql:?}"
            );
            for driver in STANDARD_DRIVERS {
                if driver == DriverKind::DuckDb {
                    continue;
                }
                assert!(
                    !is_read_only_sql_for(driver, sql),
                    "{driver:?} must still reject {sql:?} (not its syntax)"
                );
            }
            assert!(
                !is_read_only_sql_for(DriverKind::Mysql, sql),
                "Mysql must still reject {sql:?}"
            );
            assert!(!is_read_only_sql(sql), "driver-less must reject {sql:?}");
        }
        // Stacking behind the DuckDB-only prefixes is still caught.
        for sql in [
            "FROM users; DROP TABLE users",
            "SUMMARIZE users; DROP TABLE users",
        ] {
            assert!(
                !is_read_only_sql_for(DriverKind::DuckDb, sql),
                "DuckDB must reject stacked {sql:?}"
            );
        }
    }

    /// #1005: DuckDB's `PRAGMA` has both a query form (`PRAGMA database_list`,
    /// `PRAGMA table_info('t')` — read-only) and a setting form
    /// (`PRAGMA memory_limit='1GB'`, `PRAGMA threads=4` — changes session
    /// configuration, a write in spirit). The gate approximates the
    /// distinction by rejecting any masked body containing `=`, since the
    /// setting form's syntax always has one and the query form never does.
    /// SQLite's own setting-form `PRAGMA foreign_keys=ON` is exactly this
    /// shape, which is why `PRAGMA` stays unlisted for every driver other
    /// than DuckDB rather than trying to replicate the query/setting split
    /// per dialect (see the allow-list doc comment on `is_read_only_sql`).
    #[test]
    fn read_only_duckdb_pragma_query_form_allowed_setting_form_rejected() {
        for sql in ["PRAGMA database_list", "PRAGMA table_info('users')"] {
            assert!(
                is_read_only_sql_for(DriverKind::DuckDb, sql),
                "DuckDB must accept query-form {sql:?}"
            );
        }
        for sql in ["PRAGMA memory_limit='1GB'", "PRAGMA threads=4"] {
            assert!(
                !is_read_only_sql_for(DriverKind::DuckDb, sql),
                "DuckDB must reject setting-form {sql:?} (contains '=')"
            );
        }
        // No driver (DuckDB included) treats SQLite's classic setting-form
        // PRAGMA as read-only.
        for driver in STANDARD_DRIVERS {
            assert!(
                !is_read_only_sql_for(driver, "PRAGMA foreign_keys=ON"),
                "{driver:?} must reject PRAGMA foreign_keys=ON"
            );
        }
    }

    /// Core of #1005: every leading keyword that `db::duckdb::is_query_shape`
    /// (`src-tauri/src/db/duckdb.rs`) treats as query-shaped — routing the
    /// statement to the result-set-returning `query` path rather than
    /// `execute` — must also be read-only-eligible for DuckDB here, or a
    /// read-only session would reject a statement the driver itself is happy
    /// to run as a query. `is_query_shape` is a private helper owned by a
    /// concurrently in-flight branch (#971), so this pins the *keyword list*
    /// (read directly from its source, `with` / `select` / `show` /
    /// `describe` / `desc` / `explain` / `pragma` / `summarize` / `values`)
    /// with one representative read-only statement per keyword, rather than
    /// calling the private function directly.
    ///
    /// One deliberate, documented exception: `is_query_shape` treats *every*
    /// `PRAGMA` statement — including the setting form — as query-shaped
    /// (it only decides which `duckdb`-crate call to make, not whether the
    /// statement is safe to run in a read-only session), whereas the
    /// read-only gate must reject the setting form. That half of `PRAGMA` is
    /// intentionally excluded from this alignment check and is covered
    /// instead by `read_only_duckdb_pragma_query_form_allowed_setting_form_rejected`.
    #[test]
    fn read_only_duckdb_allows_every_is_query_shape_keyword() {
        let representative_read_only_statements = [
            ("with", "WITH t AS (SELECT 1) SELECT * FROM t"),
            ("select", "SELECT * FROM t"),
            ("show", "SHOW TABLES"),
            ("describe", "DESCRIBE t"),
            ("desc", "DESC t"),
            ("explain", "EXPLAIN SELECT 1"),
            ("pragma", "PRAGMA version"),
            ("summarize", "SUMMARIZE t"),
            ("values", "VALUES (1), (2)"),
        ];
        for (keyword, sql) in representative_read_only_statements {
            assert!(
                is_read_only_sql_for(DriverKind::DuckDb, sql),
                "is_query_shape keyword {keyword:?} ({sql:?}) must be read-only-eligible for DuckDB"
            );
        }
    }

    /// The same fail-open shape, but through the dry-run preview's
    /// stacked-statement gate (#852). A DDL stacked behind a DML escapes the
    /// rollback that makes the preview safe.
    #[test]
    fn stacked_statement_gate_is_driver_aware() {
        let sql = r"UPDATE t SET s = '\'; DROP TABLE t; --'";
        for driver in STANDARD_DRIVERS {
            assert!(
                has_stacked_statements_for(driver, sql),
                "{driver:?} must see the stacked DROP in {sql:?}"
            );
        }
        assert!(!has_stacked_statements_for(DriverKind::Mysql, sql));
        assert!(has_stacked_statements(sql), "driver-less must fail closed");
        // And the flight recorder refuses to capture it on those dialects.
        for driver in STANDARD_DRIVERS {
            assert_eq!(classify_write_kind_for(driver, sql), WriteKind::Other);
        }
        assert_eq!(
            classify_write_kind_for(DriverKind::Mysql, sql),
            WriteKind::Update
        );
        assert_eq!(classify_write_kind(sql), WriteKind::Other);
    }

    /// Auto-LIMIT must not splice a cap onto what is really a stacked write on
    /// the standard dialects (#852). Bailing out (`None`) is the safe answer.
    #[test]
    fn auto_limit_is_driver_aware() {
        let sql = r"SELECT * FROM t WHERE s = '\'; DELETE FROM t; --'";
        for driver in STANDARD_DRIVERS {
            assert!(
                apply_auto_limit_for(driver, sql, 100).is_none(),
                "{driver:?} must leave {sql:?} untouched"
            );
        }
        assert!(apply_auto_limit(sql, 100).is_none());
        // MySQL reads one literal, so the statement is an ordinary SELECT and
        // still gets capped.
        assert_eq!(
            apply_auto_limit_for(DriverKind::Mysql, sql, 100).as_deref(),
            Some(r"SELECT * FROM t WHERE s = '\'; DELETE FROM t; --' LIMIT 100")
        );
    }

    /// Regression test for the backslash-masking bypass: on PostgreSQL /
    /// SQLite, `\` is not a string escape, so `'\'` closes the literal right
    /// there. The MySQL-flavoured mask used to treat `\'` as an escaped quote
    /// and read the whole rest of the string (including `; DELETE …`) as
    /// still inside the literal, letting the stacked DELETE slip through as
    /// part of an apparently-single, allowed `SET` statement.
    #[test]
    fn session_init_rejects_backslash_masked_stacked_statement() {
        assert!(!is_session_init_sql(
            "SET application_name = '\\'; DELETE FROM important_table; SET application_name = 'ok'"
        ));
        // Legitimate init SQL across all three dialects still passes.
        assert!(is_session_init_sql("SET time_zone = 'UTC'"));
        assert!(is_session_init_sql("PRAGMA foreign_keys=ON"));
        assert!(is_session_init_sql("SELECT 1"));
    }

    /// Regression test: a bare `starts_with_word(s, "set")` check let through
    /// `SET` sub-forms that reach beyond the current session (server-wide
    /// config, account credentials, or a MariaDB `SET STATEMENT … FOR`
    /// wrapper around an arbitrary statement), even under a read-only
    /// profile's init SQL.
    #[test]
    fn session_init_rejects_set_global_password_and_statement_for() {
        assert!(!is_session_init_sql("SET GLOBAL read_only = 0"));
        assert!(!is_session_init_sql("SET PASSWORD FOR 'a'@'%' = 'x'"));
        assert!(!is_session_init_sql(
            "SET STATEMENT max_statement_time=0 FOR DELETE FROM users"
        ));
        // Ordinary session-scoped SET forms remain allowed.
        assert!(is_session_init_sql("SET SESSION time_zone='UTC'"));
        assert!(is_session_init_sql("SET NAMES utf8mb4"));
        assert!(is_session_init_sql("SET search_path TO app"));
    }

    /// `NO_BACKSLASH_ESCAPES` flips MySQL's own reading of `\` inside string
    /// literals for the rest of the session, which desyncs every mask built
    /// on [`super::driver_backslash_escapes`] (`is_read_only_sql` /
    /// `has_stacked_statements` / `apply_auto_limit` / `classify_write_kind`)
    /// from what the real server will do — so init SQL must not be able to
    /// set it, in any of its common spellings, case, or whitespace.
    #[test]
    fn session_init_rejects_no_backslash_escapes_sql_mode() {
        assert!(!is_session_init_sql(
            "SET sql_mode = 'NO_BACKSLASH_ESCAPES'"
        ));
        // 大小無視。
        assert!(!is_session_init_sql(
            "set SQL_MODE = 'no_backslash_escapes'"
        ));
        // 空白ゆれ (等号の前後にスペース無し)。
        assert!(!is_session_init_sql("SET sql_mode='NO_BACKSLASH_ESCAPES'"));
        // 他モードとのカンマ区切り併記 (実際の運用でよくある形)。
        assert!(!is_session_init_sql(
            "SET sql_mode = 'STRICT_TRANS_TABLES,NO_BACKSLASH_ESCAPES'"
        ));
        // SESSION / GLOBAL / @@ 修飾つき、`:=` 代入演算子。
        assert!(!is_session_init_sql(
            "SET SESSION sql_mode = 'NO_BACKSLASH_ESCAPES'"
        ));
        assert!(!is_session_init_sql(
            "SET @@sql_mode = 'NO_BACKSLASH_ESCAPES'"
        ));
        assert!(!is_session_init_sql(
            "SET @@SESSION.sql_mode := 'NO_BACKSLASH_ESCAPES'"
        ));
        // 複数文の 2 文目に隠れていても検出する (各 `;` 区切りを個別に見るため)。
        assert!(!is_session_init_sql(
            "SET time_zone = 'UTC'; SET sql_mode = 'NO_BACKSLASH_ESCAPES'"
        ));
        // sql_mode を他の値に設定するのは引き続き許可 (NO_BACKSLASH_ESCAPES を
        // 含まない限り安全)。
        assert!(is_session_init_sql("SET sql_mode = 'STRICT_ALL_TABLES'"));
        // sql_mode と無関係な設定文は引き続き許可。
        assert!(is_session_init_sql("SET time_zone = 'UTC'"));
    }

    // セッション初期化 SQL は「このセッションの再現性を整える」ものなので、
    // サーバ全体・次回起動まで波及する MySQL 8.0 の永続化構文は `GLOBAL` と
    // 同じく拒否する (`SET PERSIST` はグローバル変数の変更 + `mysqld-auto.cnf`
    // への保存、`SET PERSIST_ONLY` は保存のみ)。
    #[test]
    fn session_init_rejects_persist_and_persist_only() {
        assert!(!is_session_init_sql("SET PERSIST read_only = 0"));
        assert!(!is_session_init_sql(
            "SET PERSIST_ONLY sql_mode = 'STRICT_ALL_TABLES'"
        ));
        // 大小無視・空白ゆれ。
        assert!(!is_session_init_sql("set   persist   max_connections = 10"));
        assert!(!is_session_init_sql(
            "set persist_only innodb_log_file_size = 1"
        ));
        // 複数文の 2 文目に隠れていても検出する。
        assert!(!is_session_init_sql(
            "SET time_zone = 'UTC'; SET PERSIST read_only = 0"
        ));
        // `persist` で始まる**変数名**は永続化構文ではないので通す
        // (`SET persistent_foo = 1` のような設定を巻き込まないこと)。
        assert!(is_session_init_sql("SET persistent_foo = 1"));
    }

    /// #1051 の調査結果を固定する: `with_cte_is_mutation` (実行経路の振り分け)
    /// が MySQL 流のバックスラッシュ解釈を全ドライバへ適用していた間も、
    /// **読み取り専用ガードはこの入力でフェイルオープンしていなかった**。
    /// 両者は独立した安全網であり、`is_read_only_sql_for` は
    ///
    /// * #852 で既にドライバ別マスク ([`mask_for_driver`]) へ切り替え済みで、
    /// * データ変更 CTE を「主文の位置」ではなく **本文のどこかに書き込み
    ///   キーワードが露出しているか** で弾く
    ///
    /// ため、`\` をただの文字として読む 4 方言では `delete` がそのまま見えて
    /// 拒否される。MySQL だけはマスクが実サーバと同じく「閉じない文字列」と
    /// 読むので `delete` は現れず true を返すが、そのとき実サーバも同じ理由で
    /// この文を構文エラーにするため書き込みは起きない (安全網とサーバの解釈が
    /// 一致している状態であって、見逃しではない)。
    ///
    /// つまり #1051 で直したのは「データ変更が空の 0 件グリッドとして表示され
    /// `rows_affected` が失われる」実行経路の誤りであって、権限の穴ではない。
    #[test]
    fn read_only_guard_rejects_backslash_cte_on_standard_dialects() {
        let sql = r"WITH t AS (SELECT '\' AS x) DELETE FROM y";
        for driver in [
            DriverKind::Postgres,
            DriverKind::Sqlite,
            DriverKind::DuckDb,
            DriverKind::Mssql,
        ] {
            assert!(
                !is_read_only_sql_for(driver, sql),
                "{driver:?} must not accept a data-modifying CTE in a read-only session"
            );
        }
        // ドライバ非依存の呼び出し口 (保守的マスク = `\` はただの文字) でも拒否。
        assert!(!is_read_only_sql(sql));
        // MySQL は実サーバと同じく「閉じない文字列リテラル」と読むため、
        // 書き込みキーワードは現れない (この文自体が MySQL では構文エラー)。
        assert!(is_read_only_sql_for(DriverKind::Mysql, sql));
    }

    #[test]
    fn ssl_mode_serializes_to_snake_case_wire_names() {
        // The wire names must match the frontend union and the values the
        // connection form sends, so a rename here is a breaking change.
        let cases = [
            (SslMode::Disable, "\"disable\""),
            (SslMode::Prefer, "\"prefer\""),
            (SslMode::Require, "\"require\""),
            (SslMode::VerifyCa, "\"verify_ca\""),
            (SslMode::VerifyFull, "\"verify_full\""),
        ];
        for (mode, wire) in cases {
            assert_eq!(serde_json::to_string(&mode).unwrap(), wire);
            assert_eq!(serde_json::from_str::<SslMode>(wire).unwrap(), mode);
        }
    }

    #[test]
    fn db_options_default_to_no_tls_fields() {
        // Profiles saved before TLS settings existed omit the fields entirely;
        // they must deserialize to `None` so the driver default is preserved.
        let json = r#"{"host":"h","port":5432,"user":"u","password":"p",
            "database":null,"driver":"postgres"}"#;
        let opts: super::DbConnectOptions = serde_json::from_str(json).unwrap();
        assert!(opts.ssl_mode.is_none());
        assert!(opts.ssl_root_cert.is_none());
        assert!(opts.ssl_client_cert.is_none());
        assert!(opts.ssl_client_key.is_none());
    }

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

    /// Regression test (#J1): the row-locking check used a strict
    /// `ends_with("for update"/"for share"/"lock in share mode")`, so it
    /// missed every PostgreSQL variant that adds a suffix after the base
    /// phrase (`NOWAIT` / `SKIP LOCKED` / `OF <table>`) or uses one of the two
    /// PostgreSQL-only phrases (`FOR NO KEY UPDATE` / `FOR KEY SHARE`), all of
    /// which still acquire row locks and must be rejected.
    #[test]
    fn rejects_locking_select_variants_with_suffixes() {
        assert!(!is_read_only_sql("SELECT * FROM t FOR UPDATE NOWAIT"));
        assert!(!is_read_only_sql("SELECT * FROM t FOR UPDATE SKIP LOCKED"));
        assert!(!is_read_only_sql("SELECT * FROM t FOR UPDATE OF t"));
        assert!(!is_read_only_sql("SELECT * FROM t FOR NO KEY UPDATE"));
        assert!(!is_read_only_sql("SELECT * FROM t FOR KEY SHARE"));
        assert!(!is_read_only_sql("SELECT * FROM t FOR SHARE OF t"));
        // A column literally named `updated_at` must not be mistaken for the
        // `FOR UPDATE` clause (no `for` keyword precedes it here at all, but
        // this guards the word-boundary logic generally).
        assert!(is_read_only_sql("SELECT updated_at FROM t"));
    }

    #[test]
    fn rejects_multi_statement_even_with_read_only_lead() {
        assert!(!is_read_only_sql("SELECT 1; DELETE FROM t"));
        assert!(!is_read_only_sql("SELECT 1; SELECT 2"));
        assert!(!is_read_only_sql("SHOW TABLES; DROP TABLE t"));
        // A statement separator hidden after a real one is still a second
        // statement, even when the trailing one is itself read-only.
        assert!(!is_read_only_sql("select * from t ; select * from u ;"));
    }

    #[test]
    fn rejects_data_modifying_ctes() {
        assert!(!is_read_only_sql("WITH c AS (SELECT 1) DELETE FROM t"));
        assert!(!is_read_only_sql(
            "WITH c AS (DELETE FROM t RETURNING *) SELECT * FROM c"
        ));
        assert!(!is_read_only_sql(
            "WITH c AS (INSERT INTO t VALUES (1) RETURNING id) SELECT * FROM c"
        ));
        assert!(!is_read_only_sql("SELECT * FROM t INTO OUTFILE '/tmp/x'"));
    }

    /// Shared CTE corpus: mirrors the `READ_ONLY_CTE_CORPUS` table in
    /// `src/__tests__/dangerousSql.test.ts`. The frontend `isReadOnlySql` and
    /// this gate must agree on every entry — divergence is the integrity bug
    /// the corpus is meant to surface. When updating one side, update the other.
    const READ_ONLY_CTE_CORPUS: &[(&str, bool)] = &[
        // Pure SELECT CTEs — accepted as read-only.
        ("WITH t AS (SELECT 1) SELECT * FROM t", true),
        (
            "WITH RECURSIVE r(n) AS (SELECT 1 UNION SELECT n+1 FROM r WHERE n<5) SELECT * FROM r",
            true,
        ),
        (
            "WITH a AS (SELECT 1), b AS (SELECT 2) SELECT * FROM a JOIN b ON 1=1",
            true,
        ),
        // Write keyword hides inside a string literal — masking blanks it out.
        (
            "WITH c AS (SELECT 'delete from x' AS s) SELECT * FROM c",
            true,
        ),
        // Identifier prefix containing "delete" must not match the bare keyword.
        ("WITH c AS (SELECT deleted_at FROM logs) SELECT * FROM c", true),
        // Write keyword living only inside a trailing comment.
        ("WITH c AS (SELECT 1) SELECT * FROM c -- delete here", true),
        // `REPLACE()` is a string function, not the REPLACE INTO write keyword.
        (
            "WITH c AS (SELECT REPLACE(name, 'a', 'b') FROM t) SELECT * FROM c",
            true,
        ),
        // Mutation CTEs — rejected (not read-only).
        ("WITH c AS (SELECT 1) DELETE FROM t", false),
        ("WITH c AS (SELECT 1) UPDATE t SET x = 1", false),
        ("WITH c AS (SELECT 1) INSERT INTO t VALUES (1)", false),
        // Postgres data-modifying CTE bodies with RETURNING.
        ("WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d", false),
        (
            "WITH d AS (UPDATE t SET x = 1 RETURNING *) SELECT * FROM d",
            false,
        ),
        (
            "WITH d AS (INSERT INTO t VALUES (1) RETURNING id) SELECT * FROM d",
            false,
        ),
        // Multiple CTEs followed by a DML main statement.
        (
            "WITH a AS (SELECT 1), b AS (SELECT 2) DELETE FROM t WHERE id IN (SELECT 1 FROM a)",
            false,
        ),
        // Recursive CTE followed by a DML main statement.
        (
            "WITH RECURSIVE r(n) AS (SELECT 1 UNION SELECT n+1 FROM r WHERE n<5) DELETE FROM t WHERE id IN (SELECT n FROM r)",
            false,
        ),
        // SELECT ... INTO is a write-shaped statement even with a CTE prefix.
        ("WITH c AS (SELECT 1) SELECT * INTO backup FROM t", false),
    ];

    #[test]
    fn cte_corpus_matches_frontend_classification() {
        for (sql, expected) in READ_ONLY_CTE_CORPUS {
            assert_eq!(
                is_read_only_sql(sql),
                *expected,
                "diverges from frontend isReadOnlySql for: {sql}"
            );
        }
    }

    #[test]
    fn ignores_keywords_hidden_in_comments_and_literals() {
        // A write keyword living only inside a comment or string must not
        // reject an otherwise read-only statement.
        assert!(is_read_only_sql("SELECT * FROM t -- delete everything"));
        assert!(is_read_only_sql("SELECT * FROM t /* drop table */"));
        assert!(is_read_only_sql("SELECT 'delete from t' AS note"));
        // A semicolon inside a literal is not a statement separator.
        assert!(is_read_only_sql("SELECT 'a; b' AS s"));
    }

    #[test]
    fn does_not_misread_identifiers_containing_write_words() {
        assert!(is_read_only_sql("SELECT deleted_at, update_time FROM t"));
        assert!(is_read_only_sql(
            "SELECT * FROM updates WHERE created_at > 0"
        ));
        // REPLACE() is a string function, not a write statement.
        assert!(is_read_only_sql("SELECT REPLACE(name, 'a', 'b') FROM t"));
    }

    #[test]
    fn detects_stacked_statements() {
        assert!(has_stacked_statements(
            "INSERT INTO t VALUES (1); DROP TABLE t"
        ));
        assert!(has_stacked_statements("UPDATE t SET a = 1; DELETE FROM u"));
        assert!(has_stacked_statements("DELETE FROM t;\n DROP TABLE t;"));
        // A separator anywhere before the final statement counts, even when the
        // trailing statement is itself harmless.
        assert!(has_stacked_statements("UPDATE t SET a = 1; SELECT 1"));
        // Two SELECTs are still stacked — the function checks structure, not intent.
        assert!(has_stacked_statements("SELECT 1; SELECT 2"));
    }

    #[test]
    fn single_statement_is_not_stacked() {
        assert!(!has_stacked_statements("INSERT INTO t VALUES (1)"));
        assert!(!has_stacked_statements("UPDATE t SET a = 1"));
        // Trailing separators / whitespace are tolerated.
        assert!(!has_stacked_statements("DELETE FROM t;"));
        assert!(!has_stacked_statements("DELETE FROM t ;  \n"));
        assert!(!has_stacked_statements("DELETE FROM t;;\n;"));
    }

    #[test]
    fn stacked_check_ignores_semicolons_in_literals_and_comments() {
        // A `;` inside a string literal or comment is not a statement boundary.
        assert!(!has_stacked_statements("INSERT INTO t VALUES ('a; b')"));
        assert!(!has_stacked_statements(
            "UPDATE t SET note = 'x;y' WHERE id = 1"
        ));
        assert!(!has_stacked_statements("DELETE FROM t -- drop; this\n"));
        assert!(!has_stacked_statements("UPDATE t SET a = 1 /* ; */"));

        // Single-quoted string with embedded semicolon.
        assert!(!has_stacked_statements("SELECT 'hello;world'"));
        // Double-quoted identifier with embedded semicolon.
        assert!(!has_stacked_statements(r#"SELECT "col;name" FROM t"#));
        // Block comment containing a semicolon.
        assert!(!has_stacked_statements("SELECT /* comment; */ 1"));
        // Multiple semicolons inside a single string literal.
        assert!(!has_stacked_statements("INSERT INTO t VALUES ('a;b;c')"));
    }

    #[test]
    fn masks_postgres_dollar_quoted_strings() {
        // Keywords and semicolons inside `$$…$$` / `$tag$…$tag$` are string
        // content, not SQL.
        assert!(is_read_only_sql("SELECT $$delete from t$$ AS s"));
        assert!(is_read_only_sql("SELECT $tag$drop table x; -- $tag$ AS s"));
        assert!(!has_stacked_statements("SELECT $$a; b$$"));
        assert!(!has_stacked_statements(
            "INSERT INTO t VALUES ($body$x; y$body$)"
        ));
        // The closing tag must match the opening one exactly.
        assert!(!is_read_only_sql("SELECT $a$ delete from t $b$"));
    }

    #[test]
    fn dollar_quote_masking_fails_closed() {
        // Unterminated dollar quote: the `$` is literal, keywords stay visible.
        assert!(!is_read_only_sql("SELECT $$; DELETE FROM t"));
        // `$1`/`$2` are parameter placeholders, never opening tags — the
        // DELETE between them must not be swallowed as string content.
        assert!(!is_read_only_sql("SELECT $1; DELETE FROM t WHERE id = $1"));
        // `$` inside an identifier (MySQL allows it) is not an opening tag.
        assert!(is_read_only_sql("SELECT a$b FROM t"));
        assert!(!is_read_only_sql(
            "SELECT a$x$; DELETE FROM t WHERE c = a$x$"
        ));
    }

    #[test]
    fn auto_limit_ignores_keywords_inside_dollar_quotes() {
        assert_eq!(
            apply_auto_limit("SELECT $$limit 5$$ AS s", 1000).as_deref(),
            Some("SELECT $$limit 5$$ AS s LIMIT 1000"),
        );
    }

    #[test]
    fn strip_sql_comments_removes_comments_outside_strings() {
        use super::{strip_sql_comments, SqlFlavor};
        assert_eq!(
            strip_sql_comments("SELECT 1 -- bye\nFROM t", SqlFlavor::Postgres),
            "SELECT 1 \nFROM t"
        );
        assert_eq!(strip_sql_comments("a/*x*/b", SqlFlavor::Sqlite), "a b");
        // `#` line comments are MySQL-only.
        assert_eq!(
            strip_sql_comments("SELECT 1 # note", SqlFlavor::MySql),
            "SELECT 1 "
        );
        assert_eq!(
            strip_sql_comments("SELECT '#1' # note", SqlFlavor::Postgres),
            "SELECT '#1' # note"
        );
    }

    #[test]
    fn strip_sql_comments_keeps_markers_inside_strings() {
        use super::{strip_sql_comments, SqlFlavor};
        // `--` / `/*` inside a string literal are content, not comments.
        assert_eq!(
            strip_sql_comments(
                "UPDATE t SET note = 'a -- b' WHERE id = 1",
                SqlFlavor::MySql
            ),
            "UPDATE t SET note = 'a -- b' WHERE id = 1"
        );
        assert_eq!(
            strip_sql_comments(
                "UPDATE t SET url = 'http://x/*p*/q' WHERE id = 1",
                SqlFlavor::Postgres
            ),
            "UPDATE t SET url = 'http://x/*p*/q' WHERE id = 1"
        );
        // Doubled-quote escape keeps the string open across the marker.
        assert_eq!(
            strip_sql_comments("SELECT 'it''s -- fine'", SqlFlavor::Sqlite),
            "SELECT 'it''s -- fine'"
        );
        // MySQL backslash escape: `\'` does not close the string.
        assert_eq!(
            strip_sql_comments(r"SELECT 'a\' -- b'", SqlFlavor::MySql),
            r"SELECT 'a\' -- b'"
        );
        // Quoted identifiers survive too.
        assert_eq!(
            strip_sql_comments("SELECT `weird -- name` FROM t", SqlFlavor::MySql),
            "SELECT `weird -- name` FROM t"
        );
        // Postgres dollar-quoted bodies are copied verbatim.
        assert_eq!(
            strip_sql_comments("SELECT $fn$ -- not a comment $fn$", SqlFlavor::Postgres),
            "SELECT $fn$ -- not a comment $fn$"
        );
    }

    #[test]
    fn strip_sql_comments_mysql_dash_dash_needs_separator() {
        use super::{strip_sql_comments, SqlFlavor};
        // MySQL: `--` without a following space is subtraction of a negative
        // (`x--1` = `x - (-1)`), not a comment.
        assert_eq!(
            strip_sql_comments("UPDATE t SET x = x--1 WHERE id = 1", SqlFlavor::MySql),
            "UPDATE t SET x = x--1 WHERE id = 1"
        );
        assert_eq!(
            strip_sql_comments("SELECT balance--1 FROM t", SqlFlavor::MySql),
            "SELECT balance--1 FROM t"
        );
        // With the separator it is a comment again (newline kept).
        assert_eq!(
            strip_sql_comments("SELECT 1 -- note\nFROM t", SqlFlavor::MySql),
            "SELECT 1 \nFROM t"
        );
        // PostgreSQL / SQLite need no separator after `--`.
        assert_eq!(
            strip_sql_comments("SELECT balance--1 FROM t", SqlFlavor::Postgres),
            "SELECT balance"
        );
        assert_eq!(
            strip_sql_comments("SELECT balance--1 FROM t", SqlFlavor::Sqlite),
            "SELECT balance"
        );
    }

    #[test]
    fn strip_sql_comments_postgres_block_comments_nest() {
        use super::{strip_sql_comments, SqlFlavor};
        // PostgreSQL block comments nest: the whole thing is one comment.
        assert_eq!(
            strip_sql_comments("SELECT /* a /* b */ c */ 1", SqlFlavor::Postgres),
            "SELECT   1"
        );
        // MySQL / SQLite end at the first `*/` (no nesting).
        assert_eq!(
            strip_sql_comments("SELECT /* a /* b */ c */ 1", SqlFlavor::MySql),
            "SELECT   c */ 1"
        );
        // Unterminated nested comment swallows to end-of-input.
        assert_eq!(
            strip_sql_comments("SELECT /* a /* b */ c", SqlFlavor::Postgres),
            "SELECT  "
        );
    }

    #[test]
    fn auto_limit_appends_to_bare_select() {
        assert_eq!(
            apply_auto_limit("SELECT * FROM t", 1000).as_deref(),
            Some("SELECT * FROM t LIMIT 1000"),
        );
        assert_eq!(
            apply_auto_limit("select id, name from users where age > 18", 50).as_deref(),
            Some("select id, name from users where age > 18 LIMIT 50"),
        );
    }

    #[test]
    fn auto_limit_uses_the_requested_value() {
        let out = apply_auto_limit("SELECT * FROM t", 250).unwrap();
        assert!(out.ends_with("LIMIT 250"), "got: {out}");
    }

    #[test]
    fn auto_limit_splices_before_trailing_semicolon_and_comment() {
        assert_eq!(
            apply_auto_limit("SELECT * FROM t;", 1000).as_deref(),
            Some("SELECT * FROM t LIMIT 1000;"),
        );
        assert_eq!(
            apply_auto_limit("SELECT * FROM t; -- bye", 1000).as_deref(),
            Some("SELECT * FROM t LIMIT 1000; -- bye"),
        );
        assert_eq!(
            apply_auto_limit("SELECT * FROM t -- trailing\n", 1000).as_deref(),
            Some("SELECT * FROM t LIMIT 1000 -- trailing\n"),
        );
    }

    #[test]
    fn auto_limit_handles_with_select() {
        let out = apply_auto_limit("WITH c AS (SELECT 1 AS n) SELECT * FROM c", 1000).unwrap();
        assert!(out.ends_with("LIMIT 1000"), "got: {out}");
    }

    #[test]
    fn auto_limit_skips_when_limit_or_offset_present() {
        assert!(apply_auto_limit("SELECT * FROM t LIMIT 10", 1000).is_none());
        assert!(apply_auto_limit("SELECT * FROM t limit 10 offset 5", 1000).is_none());
        assert!(apply_auto_limit("SELECT * FROM t ORDER BY id OFFSET 5 ROWS", 1000).is_none());
    }

    #[test]
    fn auto_limit_skips_when_fetch_present() {
        // PostgreSQL/DuckDB's SQL-standard `FETCH FIRST/NEXT … ROWS ONLY`
        // pagination clause (#969). Appending a trailing `LIMIT` after it
        // would be a syntax error, so this must bail just like an existing
        // `LIMIT`/`OFFSET` does.
        assert!(
            apply_auto_limit("SELECT * FROM t ORDER BY id FETCH FIRST 10 ROWS ONLY", 1000)
                .is_none()
        );
        assert!(
            apply_auto_limit("SELECT * FROM t ORDER BY id FETCH NEXT 10 ROWS ONLY", 1000).is_none()
        );
        // Same clause combined with an explicit OFFSET.
        assert!(apply_auto_limit(
            "SELECT * FROM t ORDER BY id OFFSET 5 ROWS FETCH NEXT 10 ROWS ONLY",
            1000
        )
        .is_none());
        // Driver-aware entry point for PostgreSQL/DuckDB must agree.
        assert!(apply_auto_limit_for(
            DriverKind::Postgres,
            "SELECT * FROM t ORDER BY id FETCH FIRST 10 ROWS ONLY",
            1000
        )
        .is_none());
        assert!(apply_auto_limit_for(
            DriverKind::DuckDb,
            "SELECT * FROM t ORDER BY id FETCH FIRST 10 ROWS ONLY",
            1000
        )
        .is_none());
    }

    #[test]
    fn auto_limit_ignores_limit_in_subquery() {
        // A LIMIT anywhere (even a sub-query) makes us bail rather than risk a
        // double-LIMIT — the safe direction.
        assert!(apply_auto_limit("SELECT * FROM (SELECT id FROM big LIMIT 10) x", 1000).is_none());
    }

    #[test]
    fn auto_limit_ignores_limit_in_literals_and_comments() {
        let a = apply_auto_limit("SELECT * FROM t WHERE note = 'limit 5'", 1000).unwrap();
        assert_eq!(a, "SELECT * FROM t WHERE note = 'limit 5' LIMIT 1000");

        let b = apply_auto_limit("SELECT * FROM t /* LIMIT 5 */", 1000).unwrap();
        assert_eq!(b, "SELECT * FROM t LIMIT 1000 /* LIMIT 5 */");

        let c = apply_auto_limit("SELECT `limit` FROM t", 1000).unwrap();
        assert_eq!(c, "SELECT `limit` FROM t LIMIT 1000");
    }

    #[test]
    fn auto_limit_skips_writes_and_metadata() {
        assert!(apply_auto_limit("DELETE FROM t", 1000).is_none());
        assert!(apply_auto_limit("UPDATE t SET a = 1", 1000).is_none());
        assert!(apply_auto_limit("INSERT INTO t VALUES (1)", 1000).is_none());
        assert!(apply_auto_limit("SELECT * FROM t INTO OUTFILE '/tmp/x'", 1000).is_none());
        assert!(apply_auto_limit("WITH c AS (SELECT 1) DELETE FROM t", 1000).is_none());
        assert!(apply_auto_limit("EXPLAIN SELECT * FROM t", 1000).is_none());
        assert!(apply_auto_limit("SHOW TABLES", 1000).is_none());
        assert!(apply_auto_limit("SELECT * FROM t FOR UPDATE", 1000).is_none());
        assert!(apply_auto_limit("SELECT * FROM t LOCK IN SHARE MODE", 1000).is_none());
        assert!(apply_auto_limit("", 1000).is_none());
        assert!(apply_auto_limit("SELECT * FROM t", 0).is_none());
    }

    #[test]
    fn auto_limit_does_not_misread_identifiers_as_writes() {
        // Column names that merely contain a write keyword must still be capped.
        assert!(apply_auto_limit("SELECT deleted_at FROM t", 1000).is_some());
        assert!(apply_auto_limit("SELECT update_time FROM t", 1000).is_some());
        // REPLACE() is a string function, not a write statement.
        assert!(apply_auto_limit("SELECT REPLACE(name, 'a', 'b') FROM t", 1000).is_some());
    }

    #[test]
    fn auto_limit_skips_single_row_aggregates() {
        assert!(apply_auto_limit("SELECT COUNT(*) FROM t", 1000).is_none());
        assert!(apply_auto_limit("select sum(x), avg(y) from t", 1000).is_none());
        assert!(apply_auto_limit("SELECT group_concat(name) FROM t", 1000).is_none());
        assert!(
            apply_auto_limit("SELECT max(a) FROM t WHERE b IN (SELECT b FROM s)", 1000).is_none()
        );
    }

    #[test]
    fn auto_limit_applies_to_grouped_and_windowed_aggregates() {
        // GROUP BY and window functions return many rows, so they should be capped.
        assert!(apply_auto_limit("SELECT a, COUNT(*) FROM t GROUP BY a", 1000).is_some());
        assert!(apply_auto_limit("SELECT COUNT(*) OVER () FROM t", 1000).is_some());
        assert!(apply_auto_limit("SELECT DISTINCT count_col FROM t", 1000).is_some());
    }

    // ── ミューテーションテストで発見された生き残り変異を潰すケース ───────

    /// MISSED: `apply_auto_limit` 470行目 `trim_end_matches` の述語が
    /// `c == ';' || c.is_whitespace()` → `&&` に変異した場合、末尾セミコロンが
    /// `body` から除去されなくなる。この結果、末尾が `; FOR UPDATE` で終わるクエリ
    /// では `body.ends_with("for update")` が偽になりロックチェックを通過してしまう。
    /// `FOR UPDATE;` / `FOR SHARE;` / `LOCK IN SHARE MODE;` でもスキップされること、
    /// および通常クエリでは LIMIT がセミコロンの前に正しく挿入されることを確認する。
    #[test]
    fn auto_limit_skips_locking_select_with_trailing_semicolon() {
        // FOR UPDATE の後ろにセミコロン: trim_end_matches の述語変異で
        // body が "select * from t for update;" になり ends_with("for update") が偽になる
        assert!(
            apply_auto_limit("SELECT * FROM t FOR UPDATE;", 100).is_none(),
            "FOR UPDATE; should still skip LIMIT"
        );
        assert!(
            apply_auto_limit("SELECT * FROM t FOR SHARE;", 100).is_none(),
            "FOR SHARE; should still skip LIMIT"
        );
        assert!(
            apply_auto_limit("SELECT * FROM t LOCK IN SHARE MODE;", 100).is_none(),
            "LOCK IN SHARE MODE; should still skip LIMIT"
        );
        // セミコロンのみ末尾 (空白なし): LIMIT はセミコロンの前に来るべき
        let out = apply_auto_limit("SELECT * FROM t;", 100).unwrap();
        assert_eq!(out, "SELECT * FROM t LIMIT 100;", "got: {out}");
    }

    /// MISSED: `apply_auto_limit` 492行目 locking 句チェックの `||` が `&&` に
    /// 変異した場合、`FOR UPDATE` のみ (FOR SHARE を含まない) クエリが通り抜けて
    /// LIMIT が付与される。`FOR UPDATE` 単体でスキップされることを個別に確認する。
    #[test]
    fn auto_limit_skips_for_update_individually() {
        // FOR UPDATE のみ (FOR SHARE を含まない) — `||→&&` 変異で通り抜けを防ぐ
        assert!(
            apply_auto_limit("SELECT * FROM t FOR UPDATE", 100).is_none(),
            "FOR UPDATE should skip LIMIT"
        );
        // FOR SHARE のみ (FOR UPDATE を含まない) — 同様に確認
        assert!(
            apply_auto_limit("SELECT * FROM t FOR SHARE", 100).is_none(),
            "FOR SHARE should skip LIMIT"
        );
        // LOCK IN SHARE MODE も独立して確認
        assert!(
            apply_auto_limit("SELECT * FROM t LOCK IN SHARE MODE", 100).is_none(),
            "LOCK IN SHARE MODE should skip LIMIT"
        );
    }

    /// 修正 J1: `apply_auto_limit` のロック句チェックは末尾完全一致
    /// (`ends_with("for update"/"for share"/"lock in share mode")`) のみだった
    /// ため、`NOWAIT` / `SKIP LOCKED` / `OF <table>` の接尾辞が付くバリアントや
    /// PostgreSQL 専用の `FOR NO KEY UPDATE` / `FOR KEY SHARE` を取りこぼし、
    /// ロック句の後ろに ` LIMIT n` を付与して構文エラーを起こしていた。
    #[test]
    fn auto_limit_skips_locking_select_suffix_variants() {
        assert!(apply_auto_limit("SELECT * FROM t FOR UPDATE NOWAIT", 100).is_none());
        assert!(apply_auto_limit("SELECT * FROM t FOR UPDATE SKIP LOCKED", 100).is_none());
        assert!(apply_auto_limit("SELECT * FROM t FOR UPDATE OF t", 100).is_none());
        assert!(apply_auto_limit("SELECT * FROM t FOR NO KEY UPDATE", 100).is_none());
        assert!(apply_auto_limit("SELECT * FROM t FOR KEY SHARE", 100).is_none());
        assert!(apply_auto_limit("SELECT * FROM t FOR SHARE OF t", 100).is_none());
    }

    /// MISSED: `apply_auto_limit` 505行目 `while end > 0` が `while end >= 0` に
    /// 変異した場合、末尾が全て意味のある文字 (trailing whitespace/semicolon なし) の
    /// クエリでは挿入位置が正しく末尾 (= 元の文字列の末尾) になる。
    /// 末尾に空白を持たない素の SELECT で LIMIT が末尾に付くことを確認する。
    #[test]
    fn auto_limit_appends_at_exact_end_without_trailing_chars() {
        // 末尾に空白もセミコロンもない: LIMIT は元の文字列に直接連結されるべき
        let sql = "SELECT a FROM t WHERE b=1";
        let out = apply_auto_limit(sql, 77).unwrap();
        assert_eq!(out, "SELECT a FROM t WHERE b=1 LIMIT 77", "got: {out}");
    }

    /// 素の MSSQL `SELECT` は他ドライバの `LIMIT` と同じく `TOP (n)` が付く。
    #[test]
    fn auto_limit_mssql_inserts_top_on_bare_select() {
        let out = apply_auto_limit_mssql("SELECT a FROM t WHERE b = 1", 100).unwrap();
        assert_eq!(out, "SELECT TOP (100) a FROM t WHERE b = 1");
    }

    /// #mssql-top-set-ops: `TOP` は自分が属する `SELECT` にしか効かないため、
    /// トップレベルの `UNION`/`UNION ALL`/`INTERSECT`/`EXCEPT` を持つ文には
    /// 自動 LIMIT を付与しない (2 つ目以降の枝が無制限のままになるため)。
    #[test]
    fn auto_limit_mssql_declines_on_top_level_set_operators() {
        assert!(apply_auto_limit_mssql("SELECT a FROM x UNION SELECT a FROM y", 100).is_none());
        assert!(apply_auto_limit_mssql("SELECT a FROM x UNION ALL SELECT a FROM y", 100).is_none());
        assert!(apply_auto_limit_mssql("SELECT a FROM x INTERSECT SELECT a FROM y", 100).is_none());
        assert!(apply_auto_limit_mssql("SELECT a FROM x EXCEPT SELECT a FROM y", 100).is_none());
    }

    /// 括弧の中 (サブクエリ内) の集合演算では諦めない — 深さ 0 の判定であることの確認。
    #[test]
    fn auto_limit_mssql_top_level_set_operator_check_is_depth_aware() {
        // UNION はサブクエリの中だけ: 外側の SELECT には TOP が付いてよい。
        let out = apply_auto_limit_mssql(
            "SELECT * FROM (SELECT a FROM x UNION SELECT a FROM y) s",
            100,
        )
        .unwrap();
        assert_eq!(
            out,
            "SELECT TOP (100) * FROM (SELECT a FROM x UNION SELECT a FROM y) s"
        );
        // 外側 (深さ 0) に UNION があれば、内側に括弧があっても declines する。
        assert!(apply_auto_limit_mssql(
            "SELECT a FROM (SELECT b FROM z) x UNION SELECT a FROM y",
            100
        )
        .is_none());
    }

    /// `driver_kind` を知っている呼び出し口 (`apply_auto_limit_for`) でも同じ挙動。
    #[test]
    fn auto_limit_for_mssql_declines_on_top_level_union() {
        assert!(apply_auto_limit_for(
            DriverKind::Mssql,
            "SELECT a FROM x UNION SELECT a FROM y",
            100
        )
        .is_none());
    }

    // #735 DML フライトレコーダの分類器。
    #[test]
    fn classify_write_kind_recognises_the_three_dml_kinds() {
        assert_eq!(
            classify_write_kind("INSERT INTO t (a) VALUES (1)"),
            WriteKind::Insert
        );
        assert_eq!(
            classify_write_kind("  update t set a=1 where id=1"),
            WriteKind::Update
        );
        assert_eq!(
            classify_write_kind("DELETE FROM t WHERE id=1"),
            WriteKind::Delete
        );
    }

    #[test]
    fn classify_write_kind_treats_everything_else_as_other() {
        for sql in [
            "SELECT * FROM t",
            "CREATE TABLE t (id INT)",
            "DROP TABLE t",
            "REPLACE INTO t (a) VALUES (1)",
            "TRUNCATE t",
            "",
            "   ",
        ] {
            assert_eq!(
                classify_write_kind(sql),
                WriteKind::Other,
                "expected `{sql}` to classify as Other"
            );
        }
    }

    #[test]
    fn classify_write_kind_rejects_stacked_statements() {
        // A stacked statement is never captured, even if the first statement
        // alone would classify as a DML kind — the flight recorder only ever
        // captures a single, unambiguous write.
        assert_eq!(
            classify_write_kind("UPDATE t SET a=1; DROP TABLE t"),
            WriteKind::Other
        );
        assert_eq!(
            classify_write_kind("DELETE FROM t WHERE id=1; DELETE FROM t2"),
            WriteKind::Other
        );
    }

    #[test]
    fn classify_write_kind_ignores_keywords_hidden_in_comments_and_strings() {
        // A DML keyword living inside a comment or string literal must not be
        // mistaken for the statement's leading keyword.
        assert_eq!(
            classify_write_kind("-- insert style guide\nSELECT * FROM t"),
            WriteKind::Other
        );
        assert_eq!(
            classify_write_kind("SELECT 'update me' FROM t"),
            WriteKind::Other
        );
    }

    #[test]
    fn driver_kind_parse_round_trips_as_str() {
        for d in [
            DriverKind::Mysql,
            DriverKind::Postgres,
            DriverKind::Sqlite,
            DriverKind::DuckDb,
            DriverKind::Mssql,
        ] {
            assert_eq!(DriverKind::parse(d.as_str()), Some(d));
        }
        assert_eq!(DriverKind::parse("oracle"), None);
        assert_eq!(DriverKind::parse(""), None);
    }
}

/// `is_read_only_sql` / `apply_auto_limit` のプロパティベーステスト。
///
/// 手書きサンプル (上の `mod tests`) は具体的な既知ケースを固定で検証するが、
/// 安全網のバイパスは「想定していない入力」で起きる。ここでは proptest で入力を
/// ランダム探索し、入力の形に依らず常に成り立つべき不変条件 (許可外キーワードの
/// 先頭文は必ず拒否される / コメント・文字列リテラルに隠したキーワードは判定を
/// 変えない / 既存 LIMIT への二重付与は起きない 等) を検証する。反例が見つかれば
/// proptest が最小化して報告するため、安全網の穴を継続的に検出できる。
#[cfg(test)]
mod proptests {
    use super::{apply_auto_limit, is_read_only_sql};
    use proptest::prelude::*;

    /// 許可リスト外の先頭キーワード (書き込み / DDL 系)。これらで始まる文は
    /// 後続が何であれ読み取り専用として通してはならない。
    const DISALLOWED_LEADING: &[&str] = &[
        "insert", "update", "delete", "drop", "alter", "truncate", "create", "call", "merge",
        "grant", "revoke", "replace", "into",
    ];

    proptest! {
        // 先頭が許可外キーワードなら、後続テキストが何であっても必ず拒否される。
        // 読み取り専用ゲートをすり抜ける書き込み文が無いことの不変条件。
        #[test]
        fn rejects_any_disallowed_leading_keyword(
            idx in 0usize..DISALLOWED_LEADING.len(),
            rest in "[a-zA-Z0-9 _().,*='+-]{0,48}",
        ) {
            let sql = format!("{} {}", DISALLOWED_LEADING[idx], rest);
            prop_assert!(!is_read_only_sql(&sql), "leaked write SQL: {sql:?}");
        }

        // 既知の読み取り専用 SELECT に任意内容の行コメントを足しても判定は
        // 変わらない。コメントのマスク処理が、隠したキーワードに反応しないこと。
        #[test]
        fn line_comment_never_flips_to_unsafe(garbage in "[^\n]{0,64}") {
            let sql = format!("SELECT * FROM t -- {garbage}");
            prop_assert!(is_read_only_sql(&sql), "comment flipped verdict: {sql:?}");
        }

        // 文字列リテラルの内側に書き込みキーワードが現れても無視される
        // (リテラルのマスク処理)。クオートとバックスラッシュは除外し、リテラルが
        // 常に閉じる形にしている。
        #[test]
        fn string_literal_keyword_is_ignored(garbage in "[^'\\\\\n]{0,64}") {
            let sql = format!("SELECT '{garbage}' AS c FROM t");
            prop_assert!(is_read_only_sql(&sql), "literal flipped verdict: {sql:?}");
        }

        // 末尾以外にセミコロンで書き込み文を積み重ねた文は拒否される
        // (隠れた 2 文目の検出)。
        #[test]
        fn stacked_write_statement_is_rejected(
            idx in 0usize..DISALLOWED_LEADING.len(),
            tail in "[a-zA-Z0-9 _().,*=]{0,32}",
        ) {
            let sql = format!("SELECT 1; {} {}", DISALLOWED_LEADING[idx], tail);
            prop_assert!(!is_read_only_sql(&sql), "stacked write leaked: {sql:?}");
        }

        // 既に LIMIT を持つ SELECT には自動 LIMIT を二重付与しない。
        #[test]
        fn never_appends_to_existing_limit(n in 1usize..100_000) {
            let sql = format!("SELECT * FROM t LIMIT {n}");
            prop_assert!(apply_auto_limit(&sql, 100).is_none());
        }

        // 冪等性: 一度 LIMIT を付与した結果に再適用しても None を返す
        // (二重 LIMIT による構文エラーを作らない)。付与時は必ず `limit <n>` を含む。
        #[test]
        fn auto_limit_is_idempotent(
            tbl in "[a-z][a-z0-9_]{0,8}",
            n in 1usize..100_000,
        ) {
            let sql = format!("SELECT a, b FROM {tbl}");
            if let Some(limited) = apply_auto_limit(&sql, n) {
                let lower = limited.to_ascii_lowercase();
                prop_assert!(lower.contains(&format!("limit {n}")), "missing limit: {limited:?}");
                prop_assert!(
                    apply_auto_limit(&limited, n).is_none(),
                    "double limit applied: {limited:?}",
                );
            }
        }

        // COUNT(*) 等の単一行集計には自動 LIMIT を付けない。
        #[test]
        fn single_row_aggregate_is_never_limited(tbl in "[a-z][a-z0-9_]{0,8}") {
            for agg in ["COUNT(*)", "SUM(x)", "AVG(y)", "MAX(z)", "MIN(z)"] {
                let sql = format!("SELECT {agg} FROM {tbl}");
                prop_assert!(apply_auto_limit(&sql, 100).is_none(), "limited aggregate: {sql:?}");
            }
        }
    }
}
