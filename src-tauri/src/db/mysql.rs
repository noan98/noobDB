use std::time::Instant;

use futures_util::StreamExt;
use sqlx::mysql::{MySqlColumn, MySqlConnectOptions, MySqlPool, MySqlPoolOptions, MySqlRow};
use sqlx::pool::PoolConnection;
use sqlx::{Column as _, Connection as _, MySql, Row, TypeInfo, ValueRef};

use super::types::{
    Column, PreviewResult, QueryResult, StreamBatch, TableColumnInfo, TableSchema, Value,
};
use super::DbConnectOptions;
use crate::error::{AppError, Result};

pub struct MySqlConn {
    pool: MySqlPool,
}

impl MySqlConn {
    pub async fn connect(opts: &DbConnectOptions) -> Result<Self> {
        let mut connect = MySqlConnectOptions::new()
            .host(&opts.host)
            .port(opts.port)
            .username(&opts.user)
            .password(&opts.password);
        if let Some(db) = &opts.database {
            if !db.is_empty() {
                connect = connect.database(db);
            }
        }
        let pool = MySqlPoolOptions::new()
            .min_connections(0)
            .max_connections(5)
            .acquire_timeout(std::time::Duration::from_secs(15))
            .connect_with(connect)
            .await?;
        Ok(Self { pool })
    }

    pub async fn close(&self) {
        self.pool.close().await;
    }

    pub async fn execute(&self, sql: &str, database: Option<&str>) -> Result<QueryResult> {
        let started = Instant::now();
        let trimmed = sql.trim_start().to_ascii_lowercase();
        let is_query = trimmed.starts_with("select")
            || trimmed.starts_with("show")
            || trimmed.starts_with("describe")
            || trimmed.starts_with("desc ")
            || trimmed.starts_with("explain")
            || trimmed.starts_with("with");

        let mut conn = self.pool.acquire().await?;
        apply_use_database(&mut conn, database).await?;

        if is_query {
            let rows: Vec<MySqlRow> = sqlx::query(sqlx::AssertSqlSafe(sql))
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

    /// Runs `sql` inside a transaction that is always rolled back. Captures
    /// the before/after state of the mutation's target table so the caller
    /// can see what the statement would do without persisting it.
    ///
    /// Streams SELECT-shaped queries by yielding row batches through `on_batch`.
    /// `initial_batch` controls the size of the first batch (so the UI can
    /// show something immediately); subsequent batches use `chunk_size`.
    ///
    /// Non-query statements (INSERT/UPDATE/...) don't have rows to stream, so
    /// they execute as a single step and the returned `QueryResult` carries
    /// only `rows_affected`/`elapsed_ms`; no callbacks are made.
    ///
    /// `on_batch` is invoked synchronously between batches. Returning `Err`
    /// from it aborts the stream and the error bubbles out of this function.
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
        let trimmed = sql.trim_start().to_ascii_lowercase();
        let is_query = trimmed.starts_with("select")
            || trimmed.starts_with("show")
            || trimmed.starts_with("describe")
            || trimmed.starts_with("desc ")
            || trimmed.starts_with("explain")
            || trimmed.starts_with("with");

        let mut conn = self.pool.acquire().await?;
        apply_use_database(&mut conn, database).await?;

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
            // Empty result set: still tell the client the column shape so
            // headers can render.
            on_batch(StreamBatch::Columns(columns.clone()))?;
        }

        Ok(QueryResult {
            columns,
            rows: Vec::new(),
            rows_affected: total as u64,
            elapsed_ms: started.elapsed().as_millis() as u64,
        })
    }

    /// Only INSERT / UPDATE / DELETE / REPLACE are accepted — DDL like
    /// CREATE/DROP/ALTER/TRUNCATE causes an implicit commit on MySQL and so
    /// cannot be safely previewed via rollback.
    ///
    /// When the target table has a primary key, both snapshots are ORDERed by
    /// it and the AFTER snapshot is fetched by the exact PKs captured in
    /// BEFORE — so the same rows are shown in both panels even if the
    /// statement's WHERE clause stops matching after the change (e.g. an
    /// UPDATE that flips the very column the WHERE filters on).
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
            || trimmed.starts_with("delete")
            || trimmed.starts_with("replace");
        if !is_mutation {
            return Err(AppError::InvalidInput(
                "preview only supports INSERT/UPDATE/DELETE/REPLACE statements".into(),
            ));
        }

        let target = extract_target_table(sql);

        let mut conn = self.pool.acquire().await?;
        apply_use_database(&mut conn, database).await?;

        // Best-effort PK lookup — falls back to an empty Vec so a missing
        // primary key, view target, or stripped privileges just degrades to
        // the previous unordered snapshot behaviour.
        let primary_key: Vec<String> = match target.as_deref() {
            Some(t) => fetch_primary_key(&mut conn, t).await.unwrap_or_default(),
            None => Vec::new(),
        };
        let order_clause = build_pk_order_clause(&primary_key);

        // For UPDATE / DELETE we lift the user's WHERE clause out of the
        // statement and use it to filter the BEFORE snapshot. Without this
        // the snapshot is the first `row_limit` rows of the table by PK
        // order, which silently misses any affected rows past that window —
        // and the diff comes back as "(no affected rows)" even though the
        // statement did change something.
        //
        // We gate this on the target having a PK: the AFTER snapshot is
        // refetched by the BEFORE PKs (`fetch_after_by_pk`), which lines
        // the panes up row-for-row. Without a PK the fallback re-runs the
        // BEFORE query, and a WHERE-filtered re-run would return a
        // different row set after the UPDATE (e.g. `... SET flag=0 WHERE
        // flag=1` matches nothing once committed), breaking the pairing.
        let where_clause = if !primary_key.is_empty()
            && (trimmed.starts_with("update") || trimmed.starts_with("delete"))
        {
            extract_where_and_after(sql)
        } else {
            None
        };

        let before_sql = target.as_ref().map(|t| match &where_clause {
            // The user's clause is appended verbatim — it already includes
            // any ORDER BY / LIMIT they wrote. We don't add our own LIMIT
            // here (their LIMIT would clash); the fetch below caps the
            // collected rows at `row_limit + 1` instead.
            Some(w) => format!("SELECT * FROM {} {}", t, w),
            None => format!(
                "SELECT * FROM {}{} LIMIT {}",
                t,
                order_clause,
                row_limit + 1
            ),
        });

        let mut tx = conn.begin().await?;
        let started = Instant::now();

        let before_raw: Vec<MySqlRow> = match &before_sql {
            Some(q) => fetch_capped(&mut tx, q, row_limit + 1).await?,
            None => Vec::new(),
        };

        // Indices of the PK columns in the row layout — needed both to
        // re-fetch the AFTER snapshot by PK and so the frontend can pair
        // rows when computing the diff.
        let pk_indices: Vec<usize> = match (primary_key.is_empty(), before_raw.first()) {
            (false, Some(first)) => primary_key
                .iter()
                .filter_map(|name| {
                    first
                        .columns()
                        .iter()
                        .position(|c| c.name() == name.as_str())
                })
                .collect(),
            _ => Vec::new(),
        };
        // Only use PK-based AFTER refetch when every PK column was located.
        let captured_pks: Vec<Vec<Value>> =
            if !pk_indices.is_empty() && pk_indices.len() == primary_key.len() {
                before_raw
                    .iter()
                    .take(row_limit)
                    .map(|r| pk_indices.iter().map(|&i| decode_cell(r, i)).collect())
                    .collect()
            } else {
                Vec::new()
            };

        let result = sqlx::query(sqlx::AssertSqlSafe(sql))
            .execute(&mut *tx)
            .await?;
        let rows_affected = result.rows_affected();

        // PK-anchored refetch keeps the same rows visible after UPDATE/DELETE,
        // but for INSERT we want the LIMIT scan so newly inserted rows actually
        // show up in AFTER (their PKs weren't in BEFORE to anchor on).
        let is_insert = trimmed.starts_with("insert");
        let use_pk_anchor = !is_insert && target.is_some() && !captured_pks.is_empty();
        let after_raw: Vec<MySqlRow> = if use_pk_anchor {
            fetch_after_by_pk(
                &mut tx,
                target.as_ref().unwrap(),
                &primary_key,
                &captured_pks,
                &order_clause,
            )
            .await?
        } else {
            match &before_sql {
                Some(q) => {
                    sqlx::query(sqlx::AssertSqlSafe(q.as_str()))
                        .fetch_all(&mut *tx)
                        .await?
                }
                None => Vec::new(),
            }
        };

        let elapsed_ms = started.elapsed().as_millis() as u64;
        tx.rollback().await?;

        // AFTER is bounded by the captured PKs in the common path, but the
        // fallback runs the same LIMIT 101 query and can overshoot — guard
        // both sides so the banner stays accurate.
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
    /// wrapped in one transaction. Cells are bound as text (`NULL` for `None`)
    /// and MySQL coerces them to the destination column type, so a CSV column
    /// of `"42"` lands in an INT column without us having to know the schema.
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
        let cols_sql = columns
            .iter()
            .map(|c| quote_ident(c))
            .collect::<Vec<_>>()
            .join(", ");
        let table_ident = quote_ident(table);
        // MySQL caps a statement at 65,535 placeholders; stay well under.
        let max_rows = (65000 / ncols).max(1);
        let batch = batch_size.clamp(1, max_rows);

        let mut conn = self.pool.acquire().await?;
        apply_use_database(&mut conn, database).await?;
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
        database: Option<&str>,
    ) -> Result<u64> {
        if statements.is_empty() {
            return Ok(0);
        }
        let mut conn = self.pool.acquire().await?;
        apply_use_database(&mut conn, database).await?;
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
        let rows: Vec<MySqlRow> = sqlx::query("SHOW DATABASES").fetch_all(&self.pool).await?;
        rows.iter().map(|r| decode_text_col(r, 0)).collect()
    }

    pub async fn tables(&self, db: &str) -> Result<Vec<String>> {
        if db.contains('`') {
            return Err(AppError::InvalidInput("invalid database name".into()));
        }
        let sql = format!("SHOW TABLES IN `{}`", db);
        let rows: Vec<MySqlRow> = sqlx::query(sqlx::AssertSqlSafe(sql))
            .fetch_all(&self.pool)
            .await?;
        rows.iter().map(|r| decode_text_col(r, 0)).collect()
    }

    pub async fn columns(&self, db: &str, table: &str) -> Result<Vec<TableColumnInfo>> {
        // The referenced table/column live in KEY_COLUMN_USAGE. Pulling them via
        // correlated subqueries (rather than a JOIN) keeps exactly one row per
        // column even when a column participates in several key constraints.
        let rows: Vec<MySqlRow> = sqlx::query(
            r#"SELECT
                 c.COLUMN_NAME, c.COLUMN_TYPE, c.IS_NULLABLE, c.COLUMN_KEY,
                 c.COLUMN_DEFAULT, c.EXTRA,
                 (SELECT k.REFERENCED_TABLE_NAME
                    FROM information_schema.KEY_COLUMN_USAGE k
                   WHERE k.TABLE_SCHEMA = c.TABLE_SCHEMA
                     AND k.TABLE_NAME = c.TABLE_NAME
                     AND k.COLUMN_NAME = c.COLUMN_NAME
                     AND k.REFERENCED_TABLE_NAME IS NOT NULL
                   ORDER BY k.ORDINAL_POSITION
                   LIMIT 1) AS REFERENCED_TABLE_NAME,
                 (SELECT k.REFERENCED_COLUMN_NAME
                    FROM information_schema.KEY_COLUMN_USAGE k
                   WHERE k.TABLE_SCHEMA = c.TABLE_SCHEMA
                     AND k.TABLE_NAME = c.TABLE_NAME
                     AND k.COLUMN_NAME = c.COLUMN_NAME
                     AND k.REFERENCED_TABLE_NAME IS NOT NULL
                   ORDER BY k.ORDINAL_POSITION
                   LIMIT 1) AS REFERENCED_COLUMN_NAME
               FROM information_schema.COLUMNS c
               WHERE c.TABLE_SCHEMA = ? AND c.TABLE_NAME = ?
               ORDER BY c.ORDINAL_POSITION"#,
        )
        .bind(db)
        .bind(table)
        .fetch_all(&self.pool)
        .await?;

        Ok(rows
            .into_iter()
            .map(|r| TableColumnInfo {
                name: r.try_get::<String, _>(0).unwrap_or_default(),
                data_type: r.try_get::<String, _>(1).unwrap_or_default(),
                nullable: r
                    .try_get::<String, _>(2)
                    .map(|s| s.eq_ignore_ascii_case("YES"))
                    .unwrap_or(false),
                key: r.try_get::<String, _>(3).unwrap_or_default(),
                default: r.try_get::<Option<String>, _>(4).ok().flatten(),
                extra: r.try_get::<String, _>(5).unwrap_or_default(),
                referenced_table: r.try_get::<Option<String>, _>(6).ok().flatten(),
                referenced_column: r.try_get::<Option<String>, _>(7).ok().flatten(),
            })
            .collect())
    }

    pub async fn schema_overview(&self, db: &str) -> Result<Vec<TableSchema>> {
        let rows: Vec<MySqlRow> = sqlx::query(
            r#"SELECT TABLE_NAME, COLUMN_NAME
               FROM information_schema.COLUMNS
               WHERE TABLE_SCHEMA = ?
               ORDER BY TABLE_NAME, ORDINAL_POSITION"#,
        )
        .bind(db)
        .fetch_all(&self.pool)
        .await?;
        let pairs = rows
            .iter()
            .map(|r| {
                (
                    r.try_get::<String, _>(0).unwrap_or_default(),
                    r.try_get::<String, _>(1).unwrap_or_default(),
                )
            })
            .collect();
        Ok(super::group_columns_by_table(pairs))
    }
}

async fn apply_use_database(
    conn: &mut PoolConnection<MySql>,
    database: Option<&str>,
) -> Result<()> {
    let Some(db) = database else { return Ok(()) };
    if db.is_empty() {
        return Ok(());
    }
    if db.contains('`') {
        return Err(AppError::InvalidInput("invalid database name".into()));
    }
    // USE is not supported by MySQL's prepared statement protocol before 8.0.23
    // (and not at all on MariaDB). sqlx::query goes through PREPARE/EXECUTE and
    // gets back error 1295. raw_sql sends the statement via the text protocol,
    // which all supported server versions accept. We invoke `Executor::execute`
    // directly because `RawSql::execute` is an `async fn` whose lifetime bounds
    // produce a non-`Send` future when bubbled up through `#[tauri::command]`.
    let sql = format!("USE `{}`", db);
    sqlx::Executor::execute(&mut **conn, sqlx::raw_sql(sqlx::AssertSqlSafe(sql))).await?;
    Ok(())
}

// MySQL 8 marks the `Database` column of `SHOW DATABASES` (and `Tables_in_*`
// from `SHOW TABLES`) with the BINARY flag, which makes sqlx's `String`
// decoder refuse the column. Read raw bytes and convert manually so the same
// code works across MySQL 8 and MariaDB.
fn decode_text_col(row: &MySqlRow, i: usize) -> Result<String> {
    let bytes: Vec<u8> = row.try_get(i)?;
    String::from_utf8(bytes).map_err(|e| AppError::Other(e.to_string()))
}

fn columns_of(rows: &[MySqlRow]) -> Vec<Column> {
    let Some(first) = rows.first() else {
        return Vec::new();
    };
    first
        .columns()
        .iter()
        .map(|c: &MySqlColumn| Column {
            name: c.name().to_string(),
            type_name: c.type_info().name().to_string(),
        })
        .collect()
}

fn row_to_values(row: &MySqlRow) -> Vec<Value> {
    (0..row.columns().len())
        .map(|i| decode_cell(row, i))
        .collect()
}

fn decode_cell(row: &MySqlRow, i: usize) -> Value {
    let raw = match row.try_get_raw(i) {
        Ok(r) => r,
        Err(_) => return Value::Null,
    };
    if raw.is_null() {
        return Value::Null;
    }
    let type_name = raw.type_info().name().to_ascii_uppercase();

    // Try common scalar decodings first based on declared type, then fall back to string.
    if matches!(
        type_name.as_str(),
        "TINYINT" | "SMALLINT" | "MEDIUMINT" | "INT" | "BIGINT" | "YEAR"
    ) {
        if let Ok(v) = row.try_get::<Option<i64>, _>(i) {
            return v.map(Value::Int).unwrap_or(Value::Null);
        }
    }
    if matches!(
        type_name.as_str(),
        "TINYINT UNSIGNED"
            | "SMALLINT UNSIGNED"
            | "MEDIUMINT UNSIGNED"
            | "INT UNSIGNED"
            | "BIGINT UNSIGNED"
    ) {
        if let Ok(v) = row.try_get::<Option<u64>, _>(i) {
            return v.map(Value::UInt).unwrap_or(Value::Null);
        }
    }
    if matches!(type_name.as_str(), "FLOAT" | "DOUBLE") {
        if let Ok(v) = row.try_get::<Option<f64>, _>(i) {
            return v.map(Value::Float).unwrap_or(Value::Null);
        }
    }
    if type_name == "BOOLEAN" {
        if let Ok(v) = row.try_get::<Option<bool>, _>(i) {
            return v.map(Value::Bool).unwrap_or(Value::Null);
        }
    }
    if type_name == "DECIMAL" || type_name == "NEWDECIMAL" {
        if let Ok(v) = row.try_get::<Option<rust_decimal::Decimal>, _>(i) {
            return v
                .map(|d| Value::String(d.to_string()))
                .unwrap_or(Value::Null);
        }
    }
    if matches!(
        type_name.as_str(),
        "DATE" | "TIME" | "DATETIME" | "TIMESTAMP"
    ) {
        if let Ok(v) = row.try_get::<Option<chrono::NaiveDateTime>, _>(i) {
            return v
                .map(|d| Value::String(d.to_string()))
                .unwrap_or(Value::Null);
        }
        if let Ok(v) = row.try_get::<Option<chrono::NaiveDate>, _>(i) {
            return v
                .map(|d| Value::String(d.to_string()))
                .unwrap_or(Value::Null);
        }
    }
    if matches!(type_name.as_str(), "JSON") {
        if let Ok(v) = row.try_get::<Option<serde_json::Value>, _>(i) {
            return v
                .map(|j| Value::String(j.to_string()))
                .unwrap_or(Value::Null);
        }
    }
    if matches!(
        type_name.as_str(),
        "BLOB" | "TINYBLOB" | "MEDIUMBLOB" | "LONGBLOB" | "BINARY" | "VARBINARY"
    ) {
        if let Ok(v) = row.try_get::<Option<Vec<u8>>, _>(i) {
            return v
                .map(|b| Value::Bytes(data_encoding::HEXLOWER.encode(&b)))
                .unwrap_or(Value::Null);
        }
    }

    // Default: string (covers VARCHAR/TEXT/ENUM/SET/CHAR and unknown types)
    match row.try_get::<Option<String>, _>(i) {
        Ok(Some(s)) => Value::String(s),
        Ok(None) => Value::Null,
        Err(_) => match row.try_get::<Option<Vec<u8>>, _>(i) {
            Ok(Some(b)) => Value::Bytes(data_encoding::HEXLOWER.encode(&b)),
            _ => Value::Null,
        },
    }
}

/// Best-effort extraction of the target table from a mutation statement.
/// Returns `None` for shapes we don't confidently recognise (multi-table
/// UPDATE/DELETE, embedded subqueries, etc.) — callers fall back to a
/// snapshot-less preview in that case. The returned string is taken verbatim
/// from the user's SQL so quoting/qualification is preserved.
fn extract_target_table(sql: &str) -> Option<String> {
    let tokens = tokenize_sql(sql);
    let mut iter = tokens.into_iter().peekable();
    let first = iter.next()?;
    match first.to_ascii_lowercase().as_str() {
        "update" => {
            skip_modifiers(&mut iter, &["low_priority", "ignore"]);
            let table = iter.next()?;
            // Reject multi-table UPDATE (next token is `,` swallowed → next is another identifier
            // before `set`). If we see anything other than `set` next, give up.
            if !iter.peek().is_some_and(|t| t.eq_ignore_ascii_case("set")) {
                return None;
            }
            Some(table)
        }
        "delete" => {
            skip_modifiers(&mut iter, &["low_priority", "quick", "ignore"]);
            // Single-table DELETE form: `DELETE FROM tbl ...`. Multi-table
            // (`DELETE t1 FROM t1 JOIN t2 ...`) doesn't begin with FROM.
            let next = iter.next()?;
            if !next.eq_ignore_ascii_case("from") {
                return None;
            }
            iter.next()
        }
        "insert" | "replace" => {
            skip_modifiers(
                &mut iter,
                &["low_priority", "delayed", "high_priority", "ignore"],
            );
            let mut next = iter.next()?;
            if next.eq_ignore_ascii_case("into") {
                next = iter.next()?;
            }
            Some(next)
        }
        _ => None,
    }
}

/// Returns the substring of `sql` starting at the outermost `WHERE`
/// keyword (inclusive), or `None` if the statement has no top-level
/// `WHERE`. Comments are stripped first; string and identifier quoting
/// (`'...'`, `"..."`, `` `...` ``) plus parenthesis depth are tracked so
/// a `WHERE` nested in a subquery — e.g. inside the `SET` expression of
/// an `UPDATE` — is not mistaken for the outer clause.
///
/// Any trailing statement terminator (`;`) is stripped from the result so
/// the value can be concatenated directly into a wrapper SELECT. ORDER BY
/// and LIMIT clauses that the user wrote after WHERE are preserved
/// verbatim, so the BEFORE snapshot honours them too.
fn extract_where_and_after(sql: &str) -> Option<String> {
    let cleaned = strip_sql_comments(sql);
    let bytes = cleaned.as_bytes();
    let n = bytes.len();
    let mut depth: i32 = 0;
    let mut in_single = false;
    let mut in_double = false;
    let mut in_backtick = false;
    let mut i: usize = 0;
    while i < n {
        let c = bytes[i];
        if in_single {
            if c == b'\\' && i + 1 < n {
                i += 2;
                continue;
            }
            if c == b'\'' {
                // Doubled '' inside '...' is an escaped quote, not the end.
                if i + 1 < n && bytes[i + 1] == b'\'' {
                    i += 2;
                    continue;
                }
                in_single = false;
            }
        } else if in_double {
            if c == b'\\' && i + 1 < n {
                i += 2;
                continue;
            }
            if c == b'"' {
                if i + 1 < n && bytes[i + 1] == b'"' {
                    i += 2;
                    continue;
                }
                in_double = false;
            }
        } else if in_backtick {
            if c == b'`' {
                in_backtick = false;
            }
        } else {
            match c {
                b'\'' => in_single = true,
                b'"' => in_double = true,
                b'`' => in_backtick = true,
                b'(' => depth += 1,
                b')' if depth > 0 => {
                    depth -= 1;
                }
                _ if depth == 0
                    && i + 5 <= n
                    && bytes[i..i + 5].eq_ignore_ascii_case(b"where")
                    && (i == 0 || !is_ident_byte(bytes[i - 1]))
                    && (i + 5 == n || !is_ident_byte(bytes[i + 5])) =>
                {
                    let mut tail = cleaned[i..].trim();
                    if let Some(stripped) = tail.strip_suffix(';') {
                        tail = stripped.trim_end();
                    }
                    return if tail.is_empty() {
                        None
                    } else {
                        Some(tail.to_string())
                    };
                }
                _ => {}
            }
        }
        i += 1;
    }
    None
}

fn is_ident_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'$'
}

/// Backtick-quotes a single identifier, doubling any embedded backticks.
fn quote_ident(name: &str) -> String {
    format!("`{}`", name.replace('`', "``"))
}

/// Builds `INSERT INTO tbl (c1, c2) VALUES (?,?),(?,?)...` with `nrows`
/// placeholder tuples of `ncols` each. Identifiers are pre-quoted by the
/// caller; only positional `?` placeholders are emitted here so values bind
/// as parameters rather than being spliced into the SQL text.
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

fn skip_modifiers<I: Iterator<Item = String>>(
    iter: &mut std::iter::Peekable<I>,
    modifiers: &[&str],
) {
    while let Some(t) = iter.peek() {
        let lc = t.to_ascii_lowercase();
        if modifiers.iter().any(|m| *m == lc) {
            iter.next();
        } else {
            break;
        }
    }
}

/// Split SQL into whitespace/punctuation-delimited tokens while keeping
/// backtick-quoted identifiers intact, including dotted forms like
/// `` `db`.`table` ``. Comments are stripped first.
fn tokenize_sql(sql: &str) -> Vec<String> {
    let cleaned = strip_sql_comments(sql);
    let mut tokens: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut in_backtick = false;
    for c in cleaned.chars() {
        if in_backtick {
            cur.push(c);
            if c == '`' {
                in_backtick = false;
            }
        } else if c == '`' {
            cur.push(c);
            in_backtick = true;
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

/// Looks up the target table's primary-key columns via `SHOW KEYS`. Returns
/// them in `Seq_in_index` order (so composite PKs are ordered correctly).
/// On any failure — view target, MERGE table, lacking SELECT on the table —
/// the caller treats an empty result as "PK unknown" and degrades gracefully.
async fn fetch_primary_key(conn: &mut PoolConnection<MySql>, target: &str) -> Result<Vec<String>> {
    // `target` is taken verbatim from the user's SQL (already quoted as
    // needed). `SHOW KEYS FROM ...` accepts both `tbl` and `` `db`.`tbl` ``.
    let sql = format!("SHOW KEYS FROM {} WHERE Key_name = 'PRIMARY'", target);
    let rows: Vec<MySqlRow> = sqlx::query(sqlx::AssertSqlSafe(sql))
        .fetch_all(&mut **conn)
        .await?;
    let mut entries: Vec<(u64, String)> = rows
        .iter()
        .filter_map(|r| {
            // SHOW KEYS reports Seq_in_index as INT UNSIGNED on MariaDB and
            // BIGINT UNSIGNED on MySQL 8 — sqlx's strict type check rejects
            // `i64` for either, so the previous decoder silently dropped
            // every row and PK detection always returned empty. Fall back
            // through signed shapes too so future server versions don't
            // re-break this without warning.
            let seq = decode_seq_in_index(r)?;
            let col = r.try_get::<String, _>("Column_name").ok()?;
            Some((seq, col))
        })
        .collect();
    entries.sort_by_key(|(s, _)| *s);
    Ok(entries.into_iter().map(|(_, c)| c).collect())
}

/// Returns `Seq_in_index` as a `u64`, tolerating either signed or unsigned
/// integer column types. Both branches of the index sequence are >= 1, so
/// negative values aren't expected from any server.
fn decode_seq_in_index(r: &MySqlRow) -> Option<u64> {
    if let Ok(v) = r.try_get::<u64, _>("Seq_in_index") {
        return Some(v);
    }
    if let Ok(v) = r.try_get::<u32, _>("Seq_in_index") {
        return Some(v as u64);
    }
    if let Ok(v) = r.try_get::<i64, _>("Seq_in_index") {
        return Some(v.max(0) as u64);
    }
    if let Ok(v) = r.try_get::<i32, _>("Seq_in_index") {
        return Some(v.max(0) as u64);
    }
    None
}

/// Streams `query` and collects up to `cap` rows, then drops the stream
/// so MySQL closes the cursor without sending the rest. Used for the
/// preview BEFORE snapshot when the query is filtered by the user's WHERE
/// clause and could otherwise match an unbounded number of rows — the cap
/// keeps memory bounded while still letting us detect overshoot (caller
/// passes `row_limit + 1`).
async fn fetch_capped(
    tx: &mut sqlx::Transaction<'_, MySql>,
    query: &str,
    cap: usize,
) -> Result<Vec<MySqlRow>> {
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

fn build_pk_order_clause(pk_cols: &[String]) -> String {
    if pk_cols.is_empty() {
        return String::new();
    }
    let parts: Vec<String> = pk_cols
        .iter()
        .map(|c| format!("`{}`", c.replace('`', "``")))
        .collect();
    format!(" ORDER BY {}", parts.join(", "))
}

/// Refetches the AFTER snapshot using the exact PKs captured in BEFORE.
/// Without this, an `UPDATE t SET flag=1 WHERE flag=0` would have a different
/// row set after, and ORDER BY pk would let inserts/deletes shift everything.
/// Anchoring by PK keeps the panels lined up row-for-row.
async fn fetch_after_by_pk(
    tx: &mut sqlx::Transaction<'_, MySql>,
    target: &str,
    pk_cols: &[String],
    captured_pks: &[Vec<Value>],
    order_clause: &str,
) -> Result<Vec<MySqlRow>> {
    if captured_pks.is_empty() {
        return Ok(Vec::new());
    }
    let pk_idents: Vec<String> = pk_cols
        .iter()
        .map(|c| format!("`{}`", c.replace('`', "``")))
        .collect();
    // Single-column PK → `WHERE pk IN (?, ?, ...)`. Composite PK →
    // `WHERE (a,b) IN ((?,?), (?,?), ...)`. MySQL supports the row-constructor
    // form natively, so we don't need to fall back to OR chains.
    let row_placeholder = if pk_idents.len() == 1 {
        "?".to_string()
    } else {
        format!(
            "({})",
            std::iter::repeat("?")
                .take(pk_idents.len())
                .collect::<Vec<_>>()
                .join(",")
        )
    };
    let placeholders = std::iter::repeat(row_placeholder.as_str())
        .take(captured_pks.len())
        .collect::<Vec<_>>()
        .join(",");
    let lhs = if pk_idents.len() == 1 {
        pk_idents[0].clone()
    } else {
        format!("({})", pk_idents.join(","))
    };
    let sql = format!(
        "SELECT * FROM {} WHERE {} IN ({}){}",
        target, lhs, placeholders, order_clause
    );
    let mut q = sqlx::query(sqlx::AssertSqlSafe(sql));
    for row_pks in captured_pks {
        for v in row_pks {
            q = bind_value(q, v);
        }
    }
    Ok(q.fetch_all(&mut **tx).await?)
}

/// Binds one of our cross-driver `Value` variants onto a sqlx query. Only the
/// scalar shapes a primary key can take are wired up — anything else is
/// passed through as NULL, which simply means the corresponding row drops out
/// of the AFTER snapshot rather than producing a type-mismatch error.
fn bind_value<'q>(
    q: sqlx::query::Query<'q, MySql, sqlx::mysql::MySqlArguments>,
    v: &'q Value,
) -> sqlx::query::Query<'q, MySql, sqlx::mysql::MySqlArguments> {
    match v {
        Value::Null => q.bind(Option::<i64>::None),
        Value::Bool(b) => q.bind(*b),
        Value::Int(i) => q.bind(*i),
        Value::UInt(u) => q.bind(*u),
        Value::Float(f) => q.bind(*f),
        Value::String(s) => q.bind(s.as_str()),
        // PKs over BLOB columns are exotic; binding the hex-encoded text
        // would not round-trip. Treat as NULL — better to lose a row from
        // AFTER than to mis-bind.
        Value::Bytes(_) => q.bind(Option::<i64>::None),
    }
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
            '#' => {
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
    fn parses_qualified_update() {
        assert_eq!(
            extract_target_table("update `mydb`.`users` set name = 'a'"),
            Some("`mydb`.`users`".into())
        );
    }

    #[test]
    fn parses_delete() {
        assert_eq!(
            extract_target_table("DELETE FROM orders WHERE id > 10"),
            Some("orders".into())
        );
        assert_eq!(
            extract_target_table("DELETE LOW_PRIORITY IGNORE FROM orders"),
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
            extract_target_table("REPLACE INTO products (id, name) VALUES (1, 'x')"),
            Some("products".into())
        );
        assert_eq!(
            extract_target_table("insert ignore into `t` set a = 1"),
            Some("`t`".into())
        );
    }

    #[test]
    fn rejects_multi_table_update() {
        assert!(extract_target_table("UPDATE a JOIN b ON a.id=b.id SET a.x=1").is_none());
        assert!(extract_target_table("UPDATE a, b SET a.x = b.x WHERE a.id = b.id").is_none());
    }

    #[test]
    fn rejects_non_mutation() {
        assert!(extract_target_table("SELECT * FROM users").is_none());
        assert!(extract_target_table("CREATE TABLE t (id INT)").is_none());
    }

    #[test]
    fn strips_comments_before_parsing() {
        let sql = "/* comment */ -- line\n# hash\nUPDATE users SET x = 1";
        assert_eq!(extract_target_table(sql), Some("users".into()));
    }

    #[test]
    fn extracts_outer_where_from_update() {
        assert_eq!(
            extract_where_and_after("UPDATE users SET name = 'a' WHERE id = 1"),
            Some("WHERE id = 1".into())
        );
    }

    #[test]
    fn extracts_outer_where_from_delete() {
        assert_eq!(
            extract_where_and_after("DELETE FROM orders WHERE total > 100"),
            Some("WHERE total > 100".into())
        );
    }

    #[test]
    fn extract_where_returns_none_when_absent() {
        assert!(extract_where_and_after("UPDATE t SET x = 1").is_none());
        assert!(extract_where_and_after("DELETE FROM t").is_none());
    }

    #[test]
    fn extract_where_ignores_inner_where_in_subquery() {
        // The WHERE inside the SET subquery is at paren depth > 0 and must
        // be skipped — otherwise we'd build the BEFORE snapshot from the
        // subquery's filter instead of the outer one.
        assert_eq!(
            extract_where_and_after("UPDATE t SET x = (SELECT y FROM s WHERE z = 1) WHERE id = 5"),
            Some("WHERE id = 5".into())
        );
        assert!(
            extract_where_and_after("UPDATE t SET x = (SELECT y FROM s WHERE z = 1)").is_none()
        );
    }

    #[test]
    fn extract_where_ignores_keyword_in_string_literal() {
        // 'WHERE' inside a single-quoted literal must not be picked up as
        // the outer keyword.
        assert_eq!(
            extract_where_and_after("UPDATE t SET x = 'WHERE' WHERE id = 1"),
            Some("WHERE id = 1".into())
        );
        // Doubled-quote escape '' inside the string must not prematurely
        // close it.
        assert_eq!(
            extract_where_and_after("UPDATE t SET x = 'a''b WHERE c' WHERE id = 1"),
            Some("WHERE id = 1".into())
        );
    }

    #[test]
    fn extract_where_ignores_keyword_in_backtick_identifier() {
        // A column literally named `where` must not be picked up as the
        // keyword. We then expect the real keyword that follows.
        assert_eq!(
            extract_where_and_after("UPDATE t SET `where` = 1 WHERE id = 2"),
            Some("WHERE id = 2".into())
        );
    }

    #[test]
    fn extract_where_preserves_trailing_clauses() {
        // ORDER BY / LIMIT after WHERE belong to the user's mutation and
        // should be reused verbatim by the BEFORE-snapshot SELECT.
        assert_eq!(
            extract_where_and_after("DELETE FROM t WHERE y = 2 ORDER BY id DESC LIMIT 10"),
            Some("WHERE y = 2 ORDER BY id DESC LIMIT 10".into())
        );
    }

    #[test]
    fn extract_where_strips_trailing_semicolon() {
        // A trailing `;` would break the wrapper SELECT it gets spliced
        // into, so the extractor drops it.
        assert_eq!(
            extract_where_and_after("UPDATE t SET x=1 WHERE id=1;"),
            Some("WHERE id=1".into())
        );
    }

    #[test]
    fn extract_where_ignores_identifier_prefixed_with_where() {
        // `whereabouts` starts with "where" but is not the keyword.
        assert!(extract_where_and_after("UPDATE t SET whereabouts = 'home'").is_none());
    }

    #[test]
    fn quotes_identifiers_with_backticks() {
        assert_eq!(quote_ident("name"), "`name`");
        assert_eq!(quote_ident("we`ird"), "`we``ird`");
    }

    #[test]
    fn builds_multi_row_insert() {
        assert_eq!(
            build_insert_sql("`t`", "`a`, `b`", 2, 3),
            "INSERT INTO `t` (`a`, `b`) VALUES (?,?),(?,?),(?,?)"
        );
        assert_eq!(
            build_insert_sql("`t`", "`a`", 1, 1),
            "INSERT INTO `t` (`a`) VALUES (?)"
        );
    }
}
