use std::time::Instant;

use futures_util::StreamExt;
use sqlx::sqlite::{SqliteColumn, SqliteConnectOptions, SqlitePool, SqlitePoolOptions, SqliteRow};
use sqlx::{Acquire, Column as _, Row, TypeInfo, ValueRef};

use super::types::{Column, PreviewResult, QueryResult, StreamBatch, TableColumnInfo, Value};
use super::DbConnectOptions;
use crate::error::{AppError, Result};

/// Default "database" name reported to the UI tree. SQLite uses `main` for
/// the primary database attached to a connection. ATTACH is out of scope.
pub const DEFAULT_DB_NAME: &str = "main";

pub struct SqliteConn {
    pool: SqlitePool,
}

impl SqliteConn {
    pub async fn connect(opts: &DbConnectOptions) -> Result<Self> {
        let path = opts
            .file_path
            .as_deref()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| AppError::InvalidInput("SQLite file_path is required".into()))?;

        let connect = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(false)
            .foreign_keys(true);

        let pool = SqlitePoolOptions::new()
            .min_connections(0)
            // SQLite tolerates concurrent reads but writes serialise — keep
            // the pool small to avoid noisy SQLITE_BUSY retries.
            .max_connections(4)
            .acquire_timeout(std::time::Duration::from_secs(15))
            .connect_with(connect)
            .await?;
        Ok(Self { pool })
    }

    pub async fn close(&self) {
        self.pool.close().await;
    }

    pub async fn execute(&self, sql: &str, _database: Option<&str>) -> Result<QueryResult> {
        let started = Instant::now();
        let is_query = is_query_shape(sql);

        let mut conn = self.pool.acquire().await?;

        if is_query {
            let rows: Vec<SqliteRow> = sqlx::query(sqlx::AssertSqlSafe(sql))
                .fetch_all(&mut *conn)
                .await?;
            let columns = columns_of(&rows);
            let rows_out = rows.iter().map(row_to_values).collect();
            Ok(QueryResult {
                columns,
                rows: rows_out,
                rows_affected: 0,
                elapsed_ms: started.elapsed().as_millis() as u64,
            })
        } else {
            let result = sqlx::query(sqlx::AssertSqlSafe(sql))
                .execute(&mut *conn)
                .await?;
            Ok(QueryResult::empty(
                result.rows_affected(),
                started.elapsed().as_millis() as u64,
            ))
        }
    }

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
        let started = Instant::now();
        let is_query = is_query_shape(sql);

        let mut conn = self.pool.acquire().await?;

        if !is_query {
            let result = sqlx::query(sqlx::AssertSqlSafe(sql))
                .execute(&mut *conn)
                .await?;
            return Ok(QueryResult::empty(
                result.rows_affected(),
                started.elapsed().as_millis() as u64,
            ));
        }

        let initial = initial_batch.max(1);
        let chunk = chunk_size.max(1);
        let mut stream = sqlx::query(sqlx::AssertSqlSafe(sql)).fetch(&mut *conn);
        let mut columns: Vec<Column> = Vec::new();
        let mut columns_emitted = false;
        let mut buffer: Vec<Vec<Value>> = Vec::new();
        let mut total: usize = 0;
        let mut target = initial;

        while let Some(row) = stream.next().await {
            let row = row?;
            if !columns_emitted {
                columns = columns_of(std::slice::from_ref(&row));
                on_batch(StreamBatch::Columns(columns.clone()))?;
                columns_emitted = true;
            }
            buffer.push(row_to_values(&row));
            if buffer.len() >= target {
                total += buffer.len();
                let batch = std::mem::take(&mut buffer);
                on_batch(StreamBatch::Rows(batch))?;
                target = chunk;
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
        _database: Option<&str>,
        row_limit: usize,
    ) -> Result<PreviewResult> {
        let row_limit = row_limit.max(1);
        let trimmed = sql.trim_start().to_ascii_lowercase();
        let is_mutation = trimmed.starts_with("insert")
            || trimmed.starts_with("update")
            || trimmed.starts_with("delete")
            || trimmed.starts_with("replace");
        if !is_mutation {
            return Err(AppError::InvalidInput(
                "preview only supports INSERT/UPDATE/DELETE/REPLACE statements".into(),
            ));
        }

        let target = extract_target_table(sql);
        let primary_key = match target.as_deref() {
            Some(t) => fetch_primary_key(&self.pool, t).await.unwrap_or_default(),
            None => Vec::new(),
        };

        let mut conn = self.pool.acquire().await?;

        let before_sql = target.as_ref().map(|t| {
            let order = order_by_pk(&primary_key);
            format!("SELECT * FROM {}{} LIMIT {}", t, order, row_limit + 1)
        });

        let mut tx = conn.begin().await?;
        let started = Instant::now();

        let before_raw: Vec<SqliteRow> = match &before_sql {
            Some(q) => fetch_capped_sqlite(&mut tx, q, row_limit + 1).await?,
            None => Vec::new(),
        };

        let result = sqlx::query(sqlx::AssertSqlSafe(sql))
            .execute(&mut *tx)
            .await?;
        let rows_affected = result.rows_affected();

        let after_raw: Vec<SqliteRow> = match &before_sql {
            Some(q) => fetch_capped_sqlite(&mut tx, q, row_limit + 1).await?,
            None => Vec::new(),
        };

        let elapsed_ms = started.elapsed().as_millis() as u64;
        tx.rollback().await?;

        let truncated = before_raw.len() > row_limit || after_raw.len() > row_limit;
        let columns = if let Some(first) = before_raw.first().or_else(|| after_raw.first()) {
            columns_of(std::slice::from_ref(first))
        } else {
            Vec::new()
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

    /// Bulk INSERT via batched multi-row statements bound as parameters and
    /// wrapped in one transaction. Cells bind as text (`NULL` for `None`) and
    /// SQLite applies column affinity, so numeric-looking text lands in
    /// INTEGER/REAL columns as numbers.
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
        let ncols = columns.len();
        let cols_sql = columns
            .iter()
            .map(|c| quote_ident(c))
            .collect::<Vec<_>>()
            .join(", ");
        let table_ident = quote_ident(table);
        // SQLite's default bound-variable limit is conservative (historically
        // 999); keep each statement under it regardless of the requested size.
        let max_rows = (900 / ncols).max(1);
        let batch = batch_size.clamp(1, max_rows);

        let mut conn = self.pool.acquire().await?;
        let mut tx = conn.begin().await?;
        let mut inserted: u64 = 0;
        for chunk in rows.chunks(batch) {
            let sql = build_insert_sql(&table_ident, &cols_sql, ncols, chunk.len());
            let mut q = sqlx::query(sqlx::AssertSqlSafe(sql));
            for row in chunk {
                for ci in 0..ncols {
                    let cell = row.get(ci).cloned().unwrap_or(None);
                    q = q.bind(cell);
                }
            }
            q.execute(&mut *tx).await?;
            inserted += chunk.len() as u64;
            on_progress(inserted)?;
        }
        tx.commit().await?;
        Ok(inserted)
    }

    /// Runs `statements` sequentially inside a single transaction. If any
    /// statement fails the transaction is rolled back (the `Transaction` is
    /// dropped without committing) so the batch is all-or-nothing — no
    /// statement is left committed when a later one errors. Returns the total
    /// `rows_affected` across all statements on success.
    pub async fn execute_transaction(
        &self,
        statements: &[String],
        _database: Option<&str>,
    ) -> Result<u64> {
        if statements.is_empty() {
            return Ok(0);
        }
        let mut conn = self.pool.acquire().await?;
        let mut tx = conn.begin().await?;
        let mut affected: u64 = 0;
        for sql in statements {
            let result = sqlx::query(sqlx::AssertSqlSafe(sql.as_str()))
                .execute(&mut *tx)
                .await?;
            affected += result.rows_affected();
        }
        tx.commit().await?;
        Ok(affected)
    }

    pub async fn databases(&self) -> Result<Vec<String>> {
        // SQLite uses one database per connection (ATTACH not supported here).
        // Surface the conventional "main" alias so the tree UI has a node.
        Ok(vec![DEFAULT_DB_NAME.to_string()])
    }

    pub async fn tables(&self, _db: &str) -> Result<Vec<String>> {
        let rows: Vec<SqliteRow> = sqlx::query(
            "SELECT name FROM sqlite_master
             WHERE type IN ('table', 'view')
               AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
             ORDER BY name",
        )
        .fetch_all(&self.pool)
        .await?;
        rows.iter()
            .map(|r| r.try_get::<String, _>(0).map_err(Into::into))
            .collect()
    }

    pub async fn columns(&self, _db: &str, table: &str) -> Result<Vec<TableColumnInfo>> {
        // PRAGMA can't be bound — quote the identifier manually after rejecting
        // anything that could break the literal.
        if table.contains('"') || table.contains('\0') {
            return Err(AppError::InvalidInput("invalid table name".into()));
        }
        // PRAGMA foreign_key_list: id, seq, table, from, to, on_update, on_delete, match.
        // Map each local column ("from") to its referenced table and column ("to",
        // which is NULL when the FK targets the parent's primary key implicitly).
        let fk_sql = format!("PRAGMA foreign_key_list(\"{}\")", table);
        let fk_rows: Vec<SqliteRow> = sqlx::query(sqlx::AssertSqlSafe(fk_sql))
            .fetch_all(&self.pool)
            .await?;
        let mut fks: std::collections::HashMap<String, (String, Option<String>)> =
            std::collections::HashMap::new();
        for r in &fk_rows {
            let from = r.try_get::<String, _>("from").unwrap_or_default();
            if from.is_empty() {
                continue;
            }
            let ref_table = r.try_get::<String, _>("table").unwrap_or_default();
            let ref_column = r.try_get::<Option<String>, _>("to").ok().flatten();
            fks.entry(from).or_insert((ref_table, ref_column));
        }

        let sql = format!("PRAGMA table_info(\"{}\")", table);
        let rows: Vec<SqliteRow> = sqlx::query(sqlx::AssertSqlSafe(sql))
            .fetch_all(&self.pool)
            .await?;
        Ok(rows
            .into_iter()
            .map(|r| {
                // PRAGMA table_info: cid, name, type, notnull, dflt_value, pk
                let name = r.try_get::<String, _>("name").unwrap_or_default();
                let data_type = r.try_get::<String, _>("type").unwrap_or_default();
                let notnull = r.try_get::<i64, _>("notnull").unwrap_or(0);
                let dflt = r.try_get::<Option<String>, _>("dflt_value").ok().flatten();
                let pk = r.try_get::<i64, _>("pk").unwrap_or(0);
                let (referenced_table, referenced_column) = match fks.get(&name) {
                    Some((t, c)) => (Some(t.clone()), c.clone()),
                    None => (None, None),
                };
                TableColumnInfo {
                    name,
                    data_type,
                    nullable: notnull == 0,
                    key: if pk > 0 { "PRI".into() } else { String::new() },
                    default: dflt,
                    extra: String::new(),
                    referenced_table,
                    referenced_column,
                }
            })
            .collect())
    }
}

fn is_query_shape(sql: &str) -> bool {
    let trimmed = sql.trim_start().to_ascii_lowercase();
    trimmed.starts_with("select")
        || trimmed.starts_with("explain")
        || trimmed.starts_with("with")
        || trimmed.starts_with("values")
        || trimmed.starts_with("pragma")
}

fn columns_of(rows: &[SqliteRow]) -> Vec<Column> {
    let Some(first) = rows.first() else {
        return Vec::new();
    };
    first
        .columns()
        .iter()
        .map(|c: &SqliteColumn| Column {
            name: c.name().to_string(),
            type_name: c.type_info().name().to_string(),
        })
        .collect()
}

fn row_to_values(row: &SqliteRow) -> Vec<Value> {
    (0..row.columns().len())
        .map(|i| decode_cell(row, i))
        .collect()
}

fn decode_cell(row: &SqliteRow, i: usize) -> Value {
    let raw = match row.try_get_raw(i) {
        Ok(r) => r,
        Err(_) => return Value::Null,
    };
    if raw.is_null() {
        return Value::Null;
    }
    let type_name = raw.type_info().name().to_ascii_uppercase();

    // sqlx's sqlite driver exposes storage class names: INTEGER / REAL /
    // TEXT / BLOB / NULL. Honor the declared type for the common shapes,
    // and fall back through string/int/float/bytes for dynamically typed
    // columns where the declared type is something exotic like "DATETIME".
    if matches!(type_name.as_str(), "INTEGER" | "INT" | "BIGINT") {
        if let Ok(v) = row.try_get::<Option<i64>, _>(i) {
            return v.map(Value::Int).unwrap_or(Value::Null);
        }
    }
    if matches!(type_name.as_str(), "REAL" | "FLOAT" | "DOUBLE") {
        if let Ok(v) = row.try_get::<Option<f64>, _>(i) {
            return v.map(Value::Float).unwrap_or(Value::Null);
        }
    }
    if type_name == "BLOB" {
        if let Ok(v) = row.try_get::<Option<Vec<u8>>, _>(i) {
            return v
                .map(|b| Value::Bytes(data_encoding::HEXLOWER.encode(&b)))
                .unwrap_or(Value::Null);
        }
    }
    if matches!(type_name.as_str(), "BOOLEAN" | "BOOL") {
        if let Ok(v) = row.try_get::<Option<bool>, _>(i) {
            return v.map(Value::Bool).unwrap_or(Value::Null);
        }
        // BOOLEAN is stored as INTEGER in SQLite — fall through to int decode
        // so a `0`/`1` value still produces a usable Value.
        if let Ok(v) = row.try_get::<Option<i64>, _>(i) {
            return v.map(|n| Value::Bool(n != 0)).unwrap_or(Value::Null);
        }
    }

    // Default: try String, then numeric / bytes fallbacks.
    match row.try_get::<Option<String>, _>(i) {
        Ok(Some(s)) => Value::String(s),
        Ok(None) => Value::Null,
        Err(_) => {
            if let Ok(Some(v)) = row.try_get::<Option<i64>, _>(i) {
                return Value::Int(v);
            }
            if let Ok(Some(v)) = row.try_get::<Option<f64>, _>(i) {
                return Value::Float(v);
            }
            if let Ok(Some(b)) = row.try_get::<Option<Vec<u8>>, _>(i) {
                return Value::Bytes(data_encoding::HEXLOWER.encode(&b));
            }
            Value::Null
        }
    }
}

/// Best-effort extraction of the target table from a mutation statement.
/// Returns `None` for shapes we don't confidently recognise.
fn extract_target_table(sql: &str) -> Option<String> {
    let tokens = tokenize_sql(sql);
    let mut iter = tokens.into_iter().peekable();
    let first = iter.next()?;
    match first.to_ascii_lowercase().as_str() {
        "update" => {
            // SQLite supports `UPDATE OR ROLLBACK | OR ABORT | ...` after UPDATE
            if iter.peek().is_some_and(|t| t.eq_ignore_ascii_case("or")) {
                iter.next();
                iter.next(); // the conflict-resolution keyword
            }
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
        "insert" | "replace" => {
            // INSERT OR REPLACE INTO ... / REPLACE INTO ...
            if iter.peek().is_some_and(|t| t.eq_ignore_ascii_case("or")) {
                iter.next();
                iter.next();
            }
            let next = iter.next()?;
            if !next.eq_ignore_ascii_case("into") {
                return None;
            }
            iter.next()
        }
        _ => None,
    }
}

/// SQLite accepts both `"id"` and `` `id` `` identifier quoting. Tokenize
/// while keeping either kind intact; strip line and block comments first.
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

fn strip_sql_comments(sql: &str) -> String {
    let mut out = String::with_capacity(sql.len());
    let mut chars = sql.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '-' if matches!(chars.peek(), Some('-')) => {
                chars.next();
                for n in chars.by_ref() {
                    if n == '\n' {
                        out.push('\n');
                        break;
                    }
                }
            }
            '/' if matches!(chars.peek(), Some('*')) => {
                chars.next();
                let mut prev = '\0';
                for n in chars.by_ref() {
                    if prev == '*' && n == '/' {
                        break;
                    }
                    prev = n;
                }
                out.push(' ');
            }
            _ => out.push(c),
        }
    }
    out
}

async fn fetch_primary_key(pool: &SqlitePool, target: &str) -> Result<Vec<String>> {
    let table = strip_identifier_quotes(target);
    if table.contains('"') || table.contains('\0') {
        return Ok(Vec::new());
    }
    let sql = format!("PRAGMA table_info(\"{}\")", table);
    let rows: Vec<SqliteRow> = sqlx::query(sqlx::AssertSqlSafe(sql))
        .fetch_all(pool)
        .await?;
    let mut entries: Vec<(i64, String)> = rows
        .iter()
        .filter_map(|r| {
            let pk = r.try_get::<i64, _>("pk").ok()?;
            if pk <= 0 {
                return None;
            }
            let name = r.try_get::<String, _>("name").ok()?;
            Some((pk, name))
        })
        .collect();
    entries.sort_by_key(|(p, _)| *p);
    Ok(entries.into_iter().map(|(_, n)| n).collect())
}

/// Double-quotes a single identifier, doubling any embedded double quotes.
fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// Builds `INSERT INTO "tbl" ("c1", "c2") VALUES (?,?),(?,?)...` with `nrows`
/// placeholder tuples of `ncols` each.
fn build_insert_sql(table_ident: &str, cols_sql: &str, ncols: usize, nrows: usize) -> String {
    let mut tuple = String::with_capacity(ncols * 2 + 2);
    tuple.push('(');
    for c in 0..ncols {
        if c > 0 {
            tuple.push(',');
        }
        tuple.push('?');
    }
    tuple.push(')');
    let values = std::iter::repeat(tuple.as_str())
        .take(nrows)
        .collect::<Vec<_>>()
        .join(",");
    format!(
        "INSERT INTO {} ({}) VALUES {}",
        table_ident, cols_sql, values
    )
}

fn strip_identifier_quotes(s: &str) -> String {
    let s = s.trim();
    if (s.starts_with('"') && s.ends_with('"') && s.len() >= 2)
        || (s.starts_with('`') && s.ends_with('`') && s.len() >= 2)
    {
        let inner = &s[1..s.len() - 1];
        return inner.replace("\"\"", "\"").replace("``", "`");
    }
    s.to_string()
}

fn order_by_pk(pk_cols: &[String]) -> String {
    if pk_cols.is_empty() {
        return String::new();
    }
    let parts: Vec<String> = pk_cols
        .iter()
        .map(|c| format!("\"{}\"", c.replace('"', "\"\"")))
        .collect();
    format!(" ORDER BY {}", parts.join(", "))
}

async fn fetch_capped_sqlite(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    query: &str,
    cap: usize,
) -> Result<Vec<SqliteRow>> {
    let mut stream = sqlx::query(sqlx::AssertSqlSafe(query)).fetch(&mut **tx);
    let mut rows = Vec::with_capacity(cap.min(1024));
    while let Some(row) = stream.next().await {
        rows.push(row?);
        if rows.len() >= cap {
            break;
        }
    }
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_basic_update() {
        assert_eq!(
            extract_target_table("UPDATE users SET name = 'a' WHERE id = 1"),
            Some("users".into())
        );
    }

    #[test]
    fn parses_update_or_replace() {
        assert_eq!(
            extract_target_table("UPDATE OR IGNORE users SET name = 'a'"),
            Some("users".into())
        );
    }

    #[test]
    fn parses_quoted_update() {
        assert_eq!(
            extract_target_table("update \"users\" set name = 'a'"),
            Some("\"users\"".into())
        );
        assert_eq!(
            extract_target_table("update `users` set name = 'a'"),
            Some("`users`".into())
        );
    }

    #[test]
    fn parses_delete() {
        assert_eq!(
            extract_target_table("DELETE FROM orders WHERE id > 10"),
            Some("orders".into())
        );
    }

    #[test]
    fn parses_insert_and_replace() {
        assert_eq!(
            extract_target_table("INSERT INTO products (name) VALUES ('x')"),
            Some("products".into())
        );
        assert_eq!(
            extract_target_table("INSERT OR REPLACE INTO products (id) VALUES (1)"),
            Some("products".into())
        );
        assert_eq!(
            extract_target_table("REPLACE INTO products (id, name) VALUES (1, 'x')"),
            Some("products".into())
        );
    }

    #[test]
    fn rejects_non_mutation() {
        assert!(extract_target_table("SELECT * FROM users").is_none());
        assert!(extract_target_table("CREATE TABLE t (id INT)").is_none());
    }

    #[test]
    fn strips_identifier_quotes() {
        assert_eq!(strip_identifier_quotes("\"users\""), "users");
        assert_eq!(strip_identifier_quotes("`users`"), "users");
        assert_eq!(strip_identifier_quotes("users"), "users");
        assert_eq!(strip_identifier_quotes("  users  "), "users");
        assert_eq!(strip_identifier_quotes("\"with\"\"quote\""), "with\"quote");
    }
}
