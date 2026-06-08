pub mod data_diff;
pub mod diff;
pub mod mysql;
pub mod postgres;
pub mod sqlite;
pub mod sync;
pub mod types;

use serde::{Deserialize, Serialize};

use crate::error::Result;
use types::{
    ForeignKey, IndexInfo, PreviewResult, QueryResult, StreamBatch, TableColumnInfo,
    TableRowEstimate, TableSchema,
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
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DriverKind {
    Mysql,
    Postgres,
    Sqlite,
}

impl DriverKind {
    /// Lowercase wire name, matching the serde representation. Used when
    /// persisting the driver alongside query history.
    pub fn as_str(&self) -> &'static str {
        match self {
            DriverKind::Mysql => "mysql",
            DriverKind::Postgres => "postgres",
            DriverKind::Sqlite => "sqlite",
        }
    }
}

/// Dispatch enum. Adding a new DB is a new variant + a new module.
pub enum Connection {
    MySql(mysql::MySqlConn),
    Postgres(postgres::PostgresConn),
    Sqlite(sqlite::SqliteConn),
}

impl Connection {
    /// The driver backing this connection.
    pub fn driver_kind(&self) -> DriverKind {
        match self {
            Connection::MySql(_) => DriverKind::Mysql,
            Connection::Postgres(_) => DriverKind::Postgres,
            Connection::Sqlite(_) => DriverKind::Sqlite,
        }
    }

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

    /// Every table (and view) in `db` paired with its column names, fetched in
    /// one round trip where the driver allows it. Feeds whole-schema editor
    /// autocomplete; prefer this over looping `tables` + `columns` from the
    /// frontend, which is N+1 and slow on large schemas.
    pub async fn schema_overview(&self, db: &str) -> Result<Vec<TableSchema>> {
        match self {
            Connection::MySql(c) => c.schema_overview(db).await,
            Connection::Postgres(c) => c.schema_overview(db).await,
            Connection::Sqlite(c) => c.schema_overview(db).await,
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
        }
    }

    /// Every index on `table` in `db` (#459): name, constituent columns (in
    /// order), and UNIQUE / PRIMARY flags. Dispatches per driver — MySQL uses
    /// `SHOW INDEX`, PostgreSQL reads `pg_index`/`pg_class`, SQLite loops
    /// `PRAGMA index_list` + `PRAGMA index_info`.
    pub async fn list_indexes(&self, db: &str, table: &str) -> Result<Vec<IndexInfo>> {
        match self {
            Connection::MySql(c) => c.list_indexes(db, table).await,
            Connection::Postgres(c) => c.list_indexes(db, table).await,
            Connection::Sqlite(c) => c.list_indexes(db, table).await,
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

/// Returns true when `sql` is shaped like a read-only statement that the
/// read-only profile gate is willing to let through.
///
/// Allow list: `SELECT` / `SHOW` / `DESCRIBE` / `DESC` / `EXPLAIN` / `WITH`.
/// Trailing semicolons and whitespace are tolerated. `SELECT ... FOR UPDATE`,
/// `FOR SHARE` and the MySQL `LOCK IN SHARE MODE` form are rejected because
/// they acquire row locks even though they syntactically begin with `SELECT`.
///
/// Beyond the leading keyword the body is masked (comments / string literals /
/// quoted identifiers blanked, reusing `mask_for_analysis`) and then:
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
pub fn is_read_only_sql(sql: &str) -> bool {
    let orig: Vec<char> = sql.chars().collect();
    let masked = mask_for_analysis(&orig);
    let masked_lower: String = masked.iter().collect::<String>().to_ascii_lowercase();
    let body = masked_lower
        .trim()
        .trim_end_matches(|c: char| c == ';' || c.is_whitespace())
        .trim_start();
    if body.is_empty() {
        return false;
    }
    let allowed_prefix = starts_with_word(body, "select")
        || starts_with_word(body, "show")
        || starts_with_word(body, "describe")
        || starts_with_word(body, "desc")
        || starts_with_word(body, "explain")
        || starts_with_word(body, "with");
    if !allowed_prefix {
        return false;
    }
    // Trailing separators were stripped above, so a remaining `;` can only be a
    // statement boundary with more SQL behind it.
    if body.contains(';') {
        return false;
    }
    for kw in [
        "insert", "update", "delete", "into", "create", "alter", "drop", "truncate", "call",
        "merge", "grant", "revoke",
    ] {
        if contains_word(body, kw) {
            return false;
        }
    }
    if body.ends_with("for update")
        || body.ends_with("for share")
        || body.ends_with("lock in share mode")
    {
        return false;
    }
    true
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
///   that already carries a `limit` / `offset` keyword, a write keyword
///   (`insert` / `update` / `delete` / `into` — guarding data-modifying CTEs and
///   `SELECT … INTO`), a locking clause, or that reads as a single-row aggregate
///   is left alone.
/// * *Any* `limit` token anywhere — even one inside a sub-query — makes us bail.
///   That can skip a query we could have safely capped, but it can never append
///   a second `LIMIT` after an existing top-level one (a syntax error). Skipping
///   is the safe direction.
///
/// The `LIMIT` is spliced in just after the last meaningful character — ahead of
/// any trailing `;` or comment — so it is never swallowed by a line comment.
pub fn apply_auto_limit(sql: &str, limit: usize) -> Option<String> {
    if limit == 0 {
        return None;
    }
    let orig: Vec<char> = sql.chars().collect();
    let masked = mask_for_analysis(&orig);
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
    if contains_word(body, "limit") || contains_word(body, "offset") {
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
    // (`… LOCK IN SHARE MODE LIMIT n` is invalid), so leave them untouched.
    if body.ends_with("for update")
        || body.ends_with("for share")
        || body.ends_with("lock in share mode")
    {
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

/// True when `sql` packs more than one statement — i.e. a `;` separates
/// statements rather than merely trailing the final one. Comments and the
/// interior of string / quoted-identifier literals are masked first (reusing
/// `mask_for_analysis`), so a `;` inside `'a;b'` or `-- drop; this` is not
/// mistaken for a separator. Trailing `;` and whitespace are tolerated.
///
/// Used to fail-closed on stacked queries in the dry-run preview path: a DDL
/// stacked after a DML (`UPDATE …; DROP TABLE …`) would implicitly commit on
/// MySQL and so escape the rollback that makes the preview safe. sqlx's
/// prepared-statement execution already rejects multi-statement strings, but
/// this makes that guarantee explicit instead of leaning on a library detail.
pub(crate) fn has_stacked_statements(sql: &str) -> bool {
    let orig: Vec<char> = sql.chars().collect();
    let masked = mask_for_analysis(&orig);
    let masked_str: String = masked.iter().collect();
    let body = masked_str.trim_end_matches(|c: char| c == ';' || c.is_whitespace());
    body.contains(';')
}

/// Replaces every comment and the interior of every string / quoted-identifier
/// literal with spaces, preserving the original char count so positions still
/// line up with the source. Newlines inside comments are kept so line-comment
/// boundaries survive.
fn mask_for_analysis(src: &[char]) -> Vec<char> {
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
        // Quoted literal / identifier: '…' "…" `…`.
        if c == '\'' || c == '"' || c == '`' {
            let quote = c;
            out.push(c);
            i += 1;
            while i < n {
                let d = src[i];
                // Backslash escape (MySQL string literals only).
                if d == '\\' && quote != '`' && i + 1 < n {
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
    use super::{apply_auto_limit, has_stacked_statements, is_read_only_sql};

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

    /// Shared CTE corpus (#286): mirrors the `READ_ONLY_CTE_CORPUS` table in
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

        // Issue #393: the five representative cases called out in the bug report.
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
}

/// `is_read_only_sql` / `apply_auto_limit` のプロパティベーステスト (#355)。
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
