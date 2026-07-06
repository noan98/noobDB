use serde::{Deserialize, Serialize};

/// DB-agnostic value type returned to the frontend as JSON.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Value {
    Null,
    Bool(bool),
    Int(i64),
    UInt(u64),
    Float(f64),
    String(String),
    /// Hex-encoded for arbitrary BLOBs to keep JSON safe.
    Bytes(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Column {
    pub name: String,
    pub type_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryResult {
    pub columns: Vec<Column>,
    pub rows: Vec<Vec<Value>>,
    pub rows_affected: u64,
    /// Wall-clock duration in milliseconds for client-side display.
    pub elapsed_ms: u64,
}

impl QueryResult {
    pub fn empty(rows_affected: u64, elapsed_ms: u64) -> Self {
        Self {
            columns: Vec::new(),
            rows: Vec::new(),
            rows_affected,
            elapsed_ms,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableColumnInfo {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub key: String,
    pub default: Option<String>,
    pub extra: String,
    /// When this column is a foreign key, the table it references; `None` otherwise.
    pub referenced_table: Option<String>,
    /// The referenced column for the foreign key, when the driver can resolve it.
    pub referenced_column: Option<String>,
}

/// One foreign-key relationship within a database, used to draw the ER
/// diagram's edges. There is one entry per referencing column; the columns of
/// a composite foreign key share the same `constraint_name`. `referenced_column`
/// is `None` only when the driver cannot resolve the target column (e.g. an
/// implicit SQLite foreign key onto a composite primary key) — the referencing
/// table/column and the referenced table are always present.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ForeignKey {
    pub table: String,
    pub column: String,
    pub referenced_table: String,
    pub referenced_column: Option<String>,
    /// Constraint name when the engine exposes one. Lets the UI group the
    /// columns of a composite key into a single edge. `None` when unavailable.
    pub constraint_name: Option<String>,
}

/// One index on a table. Carries the index name, its constituent columns
/// in order, and whether it is UNIQUE / the PRIMARY KEY. `method` is the access
/// method when the engine exposes one (e.g. PostgreSQL `btree`/`gin`, MySQL
/// `BTREE`/`HASH`); `None` for SQLite, which has no such concept.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexInfo {
    pub name: String,
    pub columns: Vec<String>,
    pub unique: bool,
    pub primary: bool,
    pub method: Option<String>,
}

/// A non-table schema object: a view, materialized view, stored
/// procedure, function, or trigger. `kind` is one of `view` /
/// `materialized_view` / `procedure` / `function` / `trigger` so the UI can
/// group them; `name` is the object's identifier within the database/schema.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchemaObject {
    pub kind: String,
    pub name: String,
    /// 同名衝突を避けるための一意識別子。PostgreSQL では関数/手続き/トリガーの
    /// `oid` を文字列で持ち、`object_definition` に渡して正しい 1 件を引く (オーバーロード
    /// 関数やテーブル別同名トリガーの取り違えを防ぐ)。名前で一意な種別 (ビュー等) や
    /// MySQL/SQLite では `None`。
    #[serde(default)]
    pub id: Option<String>,
}

/// One table (or view) and its column names, used to feed whole-schema SQL
/// autocomplete. Only names are carried — type/key metadata lives in the
/// per-table `TableColumnInfo` path, which the editor does not need for
/// completion.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableSchema {
    pub name: String,
    pub columns: Vec<String>,
}

/// Approximate row count for one base table, read from the engine's own
/// statistics catalogs (no `COUNT(*)` scan), so it stays cheap on large
/// schemas and never touches table data.
///
/// `estimate` is intentionally fuzzy:
/// - `Some(n)` is the engine's reported estimate. It may be stale (it updates
///   only when the engine gathers statistics) and, for some engines (InnoDB),
///   is approximate even when fresh.
/// - `None` means no cheap estimate is available — the driver has no such
///   statistic (SQLite), or the engine has not gathered one yet.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableRowEstimate {
    pub name: String,
    /// i64 精度方針 (#625): この値は JSON 数値としてフロントへ渡り、JS の `number`
    /// (安全整数 ±(2^53-1)) で受ける。2^53 を超える推定行数では精度が静かに落ちうるが、
    /// **概算表示 (`~1.2K`) 専用**であり超過は現実に起きない/起きても丸めに留まるため
    /// **許容する** (文字列化しない)。`TableSizeInfo` のバイト数や `ProcessInfo.id` /
    /// `time_secs` も同じ方針 (現実的なレンジが安全整数に収まる)。詳細は
    /// `src/api/schemas.ts` の `tableRowEstimate` コメントと `serde_schema_parity.rs`。
    pub estimate: Option<i64>,
}

/// Size and row statistics for one base table, used by the size/statistics
/// dashboard (#562). All byte counts come from the engine's own catalogs (no
/// table scan): MySQL `information_schema.TABLES` (`DATA_LENGTH` /
/// `INDEX_LENGTH`), PostgreSQL `pg_table_size` / `pg_indexes_size` /
/// `pg_total_relation_size`, SQLite `dbstat` aggregated per table (when the
/// build exposes it).
///
/// Every byte/row field is `Option` because an engine may not report it: SQLite
/// keeps no cheap row estimate (`row_estimate` stays `None`, mirroring
/// [`TableRowEstimate`]), and `dbstat` is absent on SQLite builds without
/// `SQLITE_ENABLE_DBSTAT_VTAB` (all size fields stay `None`). `total_bytes` is
/// the engine's reported total when available, otherwise the sum of the data
/// and index parts the driver could resolve.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableSizeInfo {
    pub name: String,
    pub row_estimate: Option<i64>,
    pub data_bytes: Option<i64>,
    pub index_bytes: Option<i64>,
    pub total_bytes: Option<i64>,
}

/// One name/value pair from a server's configuration or status catalogs, shown
/// in the server-info panel (#563). MySQL maps `SHOW VARIABLES`, PostgreSQL
/// `pg_settings` (name/setting), SQLite a curated set of `PRAGMA` results. The
/// value is always rendered as text — the panel is read-only and never edits.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerVariable {
    pub name: String,
    pub value: String,
}

/// Read-only snapshot of the connected server for the server-info panel (#563):
/// its version string and a searchable list of configuration variables. Active
/// connections are not duplicated here — the process monitor
/// ([`ProcessInfo`]) already covers them. Gathered purely with read-only
/// queries; no secret or connection-string material is included.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerInfo {
    pub version: String,
    pub variables: Vec<ServerVariable>,
}

/// One server-side process/connection shown in the process monitor panel.
/// MySQL maps rows from `processlist` (ID/USER/HOST/DB/COMMAND/STATE/TIME/
/// INFO), PostgreSQL from `pg_stat_activity` (pid/usename/client addr/datname/
/// state/wait_event/query age/query). SQLite is file-backed and has no server
/// processes — its driver returns an error instead of an empty list so the
/// frontend can tell "unsupported" from "nothing running".
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessInfo {
    /// MySQL connection id / PostgreSQL backend pid. The value passed back to
    /// `kill_process`.
    pub id: i64,
    pub user: Option<String>,
    /// Client endpoint: MySQL `HOST` (`addr:port`), PostgreSQL
    /// `client_addr:client_port` (`None` for local/unix-socket backends).
    pub host: Option<String>,
    pub database: Option<String>,
    /// Coarse activity: MySQL `COMMAND` (Query/Sleep/...), PostgreSQL `state`
    /// (active/idle/...).
    pub command: Option<String>,
    /// Finer detail: MySQL `STATE`, PostgreSQL `wait_event`.
    pub state: Option<String>,
    /// MySQL: seconds in the current command. PostgreSQL: seconds since the
    /// current/last query started. `None` when the engine reports none.
    pub time_secs: Option<i64>,
    /// The running (or last) SQL text, as the engine reports it.
    pub query: Option<String>,
    /// True when this row is the very connection that ran the listing query —
    /// i.e. one of this app's own pooled connections. Killing it drops the
    /// app's session, so the UI warns before doing that. Best-effort: the
    /// app's *other* pooled connections (same pool, different id) are not
    /// flagged because the engine cannot tell them apart from other clients.
    pub is_self: bool,
}

/// One unit produced by streaming SELECT execution. Columns are reported
/// once (before any rows) so the UI can render headers immediately, then
/// row batches arrive as they are read off the wire.
#[derive(Debug, Clone)]
pub enum StreamBatch {
    Columns(Vec<Column>),
    Rows(Vec<Vec<Value>>),
}

/// Result of a "dry-run" preview: the SQL is executed inside a transaction
/// that is rolled back afterwards, so the live database is unchanged.
/// `before_rows` and `after_rows` are snapshots of the auto-detected target
/// table (LIMIT 100). When the target table can't be parsed from the SQL,
/// they are empty and `target_table` is `None`.
///
/// `primary_key` carries the target table's primary-key column names (in
/// index order). The frontend uses them to pair before/after rows by PK so
/// the UPDATE diff is meaningful even if the underlying scan order differs
/// or the statement was DELETE/INSERT.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreviewResult {
    pub target_table: Option<String>,
    pub columns: Vec<Column>,
    pub primary_key: Vec<String>,
    pub before_rows: Vec<Vec<Value>>,
    pub after_rows: Vec<Vec<Value>>,
    pub rows_affected: u64,
    pub elapsed_ms: u64,
    /// True if either snapshot was truncated by the LIMIT.
    pub truncated: bool,
}
