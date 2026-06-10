use std::time::Instant;

use futures_util::StreamExt;
use sqlx::mysql::{MySqlColumn, MySqlConnectOptions, MySqlPool, MySqlPoolOptions, MySqlRow};
use sqlx::pool::PoolConnection;
use sqlx::{Column as _, Connection as _, Either, MySql, Row, TypeInfo, ValueRef};

use super::types::{
    Column, ForeignKey, IndexInfo, PreviewResult, QueryResult, SchemaObject, StreamBatch,
    TableColumnInfo, TableRowEstimate, TableSchema, Value,
};
use super::DbConnectOptions;
use crate::error::{AppError, Result};

pub struct MySqlConn {
    pool: MySqlPool,
    /// 明示トランザクション (#414) で確保した専用接続。BEGIN〜COMMIT/ROLLBACK の間、
    /// すべての文をこの 1 本で実行して同一トランザクションに乗せる。
    tx: tokio::sync::Mutex<Option<sqlx::pool::PoolConnection<sqlx::MySql>>>,
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
            .await
            .map_err(|e| {
                tracing::error!(
                    host = %opts.host,
                    port = opts.port,
                    user = %opts.user,
                    error = %e,
                    "mysql: failed to create connection pool"
                );
                e
            })?;
        Ok(Self {
            pool,
            tx: tokio::sync::Mutex::new(None),
        })
    }

    pub async fn close(&self) {
        self.pool.close().await;
    }

    pub async fn execute(&self, sql: &str, database: Option<&str>) -> Result<QueryResult> {
        let mut conn = self.pool.acquire().await?;
        apply_use_database(&mut conn, database).await?;
        run_sql_on(&mut conn, sql).await
    }

    // ── 明示トランザクション (#414) ──

    pub async fn tx_begin(&self, database: Option<&str>) -> Result<()> {
        let mut guard = self.tx.lock().await;
        if guard.is_some() {
            return Err(AppError::InvalidInput(
                "a transaction is already active".into(),
            ));
        }
        let mut conn = self.pool.acquire().await?;
        apply_use_database(&mut conn, database).await?;
        // Transaction-control statements go through the text protocol (raw_sql),
        // like `USE`, so they can't trip MySQL's prepared-statement error 1295.
        sqlx::Executor::execute(
            &mut *conn,
            sqlx::raw_sql(sqlx::AssertSqlSafe("START TRANSACTION")),
        )
        .await?;
        *guard = Some(conn);
        Ok(())
    }

    pub async fn tx_execute(&self, sql: &str) -> Result<QueryResult> {
        let mut guard = self.tx.lock().await;
        let conn = guard
            .as_mut()
            .ok_or_else(|| AppError::InvalidInput("no active transaction".into()))?;
        run_sql_on(conn, sql).await
    }

    pub async fn tx_finish(&self, commit: bool) -> Result<()> {
        let mut guard = self.tx.lock().await;
        let mut conn = guard
            .take()
            .ok_or_else(|| AppError::InvalidInput("no active transaction".into()))?;
        let stmt = if commit { "COMMIT" } else { "ROLLBACK" };
        sqlx::Executor::execute(&mut *conn, sqlx::raw_sql(sqlx::AssertSqlSafe(stmt))).await?;
        Ok(())
    }

    pub async fn tx_active(&self) -> bool {
        self.tx.lock().await.is_some()
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

        let mut conn = self.pool.acquire().await?;
        apply_use_database(&mut conn, database).await?;

        let initial = initial_batch.max(1);
        let chunk = chunk_size.max(1);

        // CALL: like `execute`, detect the result set at runtime. Stream the
        // first result set's rows so the grid fills incrementally; if the
        // procedure only ran DML, report the summed affected-row count instead.
        // `fetch_many` yields `Either::Right(row)` for result-set rows and
        // `Either::Left(_)` for the OK/status packets between (and after)
        // statements; later result sets are drained and ignored.
        if is_call_shape(sql) {
            let mut stream = sqlx::raw_sql(sqlx::AssertSqlSafe(sql)).fetch_many(&mut *conn);
            let mut columns: Vec<Column> = Vec::new();
            let mut columns_emitted = false;
            let mut buffer: Vec<Vec<Value>> = Vec::new();
            let mut total: usize = 0;
            let mut target = initial;
            let mut saw_result_set = false;
            let mut first_set_done = false;
            let mut rows_affected: u64 = 0;
            while let Some(item) = stream.next().await {
                match item? {
                    Either::Right(row) => {
                        if first_set_done {
                            continue;
                        }
                        saw_result_set = true;
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
                    Either::Left(result) => {
                        if saw_result_set {
                            first_set_done = true;
                        } else if !first_set_done {
                            rows_affected = rows_affected.saturating_add(result.rows_affected());
                        }
                    }
                }
            }
            drop(stream);
            let elapsed_ms = started.elapsed().as_millis() as u64;
            if saw_result_set {
                if !buffer.is_empty() {
                    total += buffer.len();
                    on_batch(StreamBatch::Rows(std::mem::take(&mut buffer)))?;
                }
                return Ok(QueryResult {
                    columns,
                    rows: Vec::new(),
                    rows_affected: total as u64,
                    elapsed_ms,
                });
            }
            return Ok(QueryResult::empty(rows_affected, elapsed_ms));
        }

        let is_query = is_query_shape(sql);
        if !is_query {
            let result = sqlx::query(sqlx::AssertSqlSafe(sql))
                .execute(&mut *conn)
                .await?;
            return Ok(QueryResult::empty(
                result.rows_affected(),
                started.elapsed().as_millis() as u64,
            ));
        }

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
        // Reject stacked statements outright: on MySQL a DDL stacked behind the
        // DML (`UPDATE …; DROP TABLE …`) would implicitly commit and escape the
        // rollback that keeps the preview side-effect-free.
        if super::has_stacked_statements(sql) {
            return Err(AppError::InvalidInput(
                "preview does not support multiple statements".into(),
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
            // use_pk_anchor は target.is_some() を条件に含むため、ここでは
            // target が Some であることが構造上保証されている。
            #[allow(clippy::unwrap_used)]
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
                    // Bind the cell text by reference: a large import would
                    // otherwise clone every value just to hand it to the driver.
                    // `Option<&str>` binds identically to `Option<String>` (text,
                    // `NULL` for `None`), so the wire output is unchanged.
                    q = q.bind(row.get(ci).and_then(|c| c.as_deref()));
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

    pub async fn foreign_keys(&self, db: &str) -> Result<Vec<ForeignKey>> {
        // KEY_COLUMN_USAGE carries the referencing/referenced column pairs;
        // rows with a non-NULL REFERENCED_TABLE_NAME are exactly the FK columns.
        // Ordering by CONSTRAINT_NAME then ORDINAL_POSITION keeps the columns of
        // a composite key together and in declaration order.
        let rows: Vec<MySqlRow> = sqlx::query(
            r#"SELECT TABLE_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME,
                      REFERENCED_COLUMN_NAME, CONSTRAINT_NAME
               FROM information_schema.KEY_COLUMN_USAGE
               WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL
               ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION"#,
        )
        .bind(db)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|r| ForeignKey {
                table: r.try_get::<String, _>(0).unwrap_or_default(),
                column: r.try_get::<String, _>(1).unwrap_or_default(),
                referenced_table: r.try_get::<String, _>(2).unwrap_or_default(),
                referenced_column: r.try_get::<Option<String>, _>(3).ok().flatten(),
                constraint_name: r.try_get::<Option<String>, _>(4).ok().flatten(),
            })
            .collect())
    }

    pub async fn schema_objects(&self, db: &str) -> Result<Vec<SchemaObject>> {
        let mut out: Vec<SchemaObject> = Vec::new();
        // Views.
        let views: Vec<MySqlRow> = sqlx::query(
            "SELECT TABLE_NAME FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME",
        )
        .bind(db)
        .fetch_all(&self.pool)
        .await?;
        for r in &views {
            out.push(SchemaObject {
                kind: "view".into(),
                name: r.try_get::<String, _>(0).unwrap_or_default(),
                id: None,
            });
        }
        // Routines (procedures / functions).
        let routines: Vec<MySqlRow> = sqlx::query(
            "SELECT ROUTINE_NAME, ROUTINE_TYPE FROM information_schema.ROUTINES \
             WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_TYPE, ROUTINE_NAME",
        )
        .bind(db)
        .fetch_all(&self.pool)
        .await?;
        for r in &routines {
            let rtype = r.try_get::<String, _>(1).unwrap_or_default();
            let kind = if rtype.eq_ignore_ascii_case("PROCEDURE") {
                "procedure"
            } else {
                "function"
            };
            out.push(SchemaObject {
                kind: kind.into(),
                name: r.try_get::<String, _>(0).unwrap_or_default(),
                id: None,
            });
        }
        // Triggers.
        let triggers: Vec<MySqlRow> = sqlx::query(
            "SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? ORDER BY TRIGGER_NAME",
        )
        .bind(db)
        .fetch_all(&self.pool)
        .await?;
        for r in &triggers {
            out.push(SchemaObject {
                kind: "trigger".into(),
                name: r.try_get::<String, _>(0).unwrap_or_default(),
                id: None,
            });
        }
        Ok(out)
    }

    pub async fn object_definition(&self, db: &str, kind: &str, name: &str) -> Result<String> {
        if db.contains('`') || db.contains('\0') || name.contains('`') || name.contains('\0') {
            return Err(AppError::InvalidInput("invalid identifier".into()));
        }
        // SHOW CREATE ... can't bind identifiers; quote them manually after the
        // guard above. The result column holding the DDL differs by object kind.
        let qualified = format!("`{db}`.`{name}`");
        let (stmt, col) = match kind {
            "view" => (format!("SHOW CREATE VIEW {qualified}"), "Create View"),
            "procedure" => (
                format!("SHOW CREATE PROCEDURE {qualified}"),
                "Create Procedure",
            ),
            "function" => (
                format!("SHOW CREATE FUNCTION {qualified}"),
                "Create Function",
            ),
            "trigger" => (
                format!("SHOW CREATE TRIGGER {qualified}"),
                "SQL Original Statement",
            ),
            other => {
                return Err(AppError::InvalidInput(format!(
                    "unsupported object kind: {other}"
                )))
            }
        };
        let row: MySqlRow = sqlx::query(sqlx::AssertSqlSafe(stmt))
            .fetch_one(&self.pool)
            .await?;
        Ok(row.try_get::<String, _>(col).unwrap_or_default())
    }

    pub async fn list_indexes(&self, db: &str, table: &str) -> Result<Vec<IndexInfo>> {
        // information_schema.STATISTICS has one row per (index, column). Order by
        // SEQ_IN_INDEX so composite indexes keep declaration order. NON_UNIQUE=0
        // means UNIQUE; the special index name "PRIMARY" is the primary key.
        let rows: Vec<MySqlRow> = sqlx::query(
            r#"SELECT INDEX_NAME, COLUMN_NAME, NON_UNIQUE, INDEX_TYPE, SEQ_IN_INDEX
               FROM information_schema.STATISTICS
               WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
               ORDER BY INDEX_NAME, SEQ_IN_INDEX"#,
        )
        .bind(db)
        .bind(table)
        .fetch_all(&self.pool)
        .await?;
        // Preserve first-seen index order while grouping columns.
        let mut order: Vec<String> = Vec::new();
        let mut by_name: std::collections::HashMap<String, IndexInfo> =
            std::collections::HashMap::new();
        for r in &rows {
            let name = r.try_get::<String, _>(0).unwrap_or_default();
            if name.is_empty() {
                continue;
            }
            let column = r.try_get::<Option<String>, _>(1).ok().flatten();
            let non_unique = r.try_get::<i64, _>(2).unwrap_or(1);
            let method = r.try_get::<Option<String>, _>(3).ok().flatten();
            let entry = by_name.entry(name.clone()).or_insert_with(|| {
                order.push(name.clone());
                IndexInfo {
                    name: name.clone(),
                    columns: Vec::new(),
                    unique: non_unique == 0,
                    primary: name == "PRIMARY",
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

    pub async fn table_row_estimates(&self, db: &str) -> Result<Vec<TableRowEstimate>> {
        // information_schema.TABLES.TABLE_ROWS is the engine's own row estimate
        // (exact for MyISAM, approximate for InnoDB) and needs no table scan.
        // Restricting to BASE TABLE skips views, whose TABLE_ROWS is NULL.
        // TABLE_ROWS is BIGINT UNSIGNED, so decode as u64 before narrowing.
        let rows: Vec<MySqlRow> = sqlx::query(
            r#"SELECT TABLE_NAME, TABLE_ROWS
               FROM information_schema.TABLES
               WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
               ORDER BY TABLE_NAME"#,
        )
        .bind(db)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|r| TableRowEstimate {
                name: r.try_get::<String, _>(0).unwrap_or_default(),
                estimate: r
                    .try_get::<Option<u64>, _>(1)
                    .ok()
                    .flatten()
                    .map(|v| v as i64),
            })
            .collect())
    }
}

/// Test-only: runs `sql` through MySQL's text protocol (via `raw_sql`) on a
/// throwaway connection. Integration tests need this for statements MySQL
/// rejects under the prepared-statement protocol (error 1295) — e.g.
/// CREATE/DROP PROCEDURE — the same limitation `apply_use_database` documents
/// for `USE`.
#[doc(hidden)]
pub async fn exec_text_protocol(opts: &DbConnectOptions, sql: &str) -> Result<()> {
    let conn = MySqlConn::connect(opts).await?;
    let mut c = conn.pool.acquire().await?;
    sqlx::Executor::execute(&mut *c, sqlx::raw_sql(sqlx::AssertSqlSafe(sql.to_string()))).await?;
    drop(c);
    conn.close().await;
    Ok(())
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

/// Run one statement on a specific connection and decode it (#414). Shared by
/// `execute` (pool connection) and `tx_execute` (held transaction connection).
/// Handles CALL (which may or may not return a result set) like `execute`.
async fn run_sql_on(conn: &mut sqlx::MySqlConnection, sql: &str) -> Result<QueryResult> {
    let started = Instant::now();
    if is_call_shape(sql) {
        return collect_call(conn, sql, started).await;
    }
    if is_query_shape(sql) {
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
    // Borrow the declared type name in place; `type_name_matches` compares it
    // case-insensitively so we avoid allocating an uppercased copy per cell.
    let type_info = raw.type_info();
    let type_name = type_info.name();
    use super::type_name_matches as ti;

    // Try common scalar decodings first based on declared type, then fall back to string.
    if ti(
        type_name,
        &["TINYINT", "SMALLINT", "MEDIUMINT", "INT", "BIGINT", "YEAR"],
    ) {
        if let Ok(v) = row.try_get::<Option<i64>, _>(i) {
            return v.map(Value::Int).unwrap_or(Value::Null);
        }
    }
    if ti(
        type_name,
        &[
            "TINYINT UNSIGNED",
            "SMALLINT UNSIGNED",
            "MEDIUMINT UNSIGNED",
            "INT UNSIGNED",
            "BIGINT UNSIGNED",
        ],
    ) {
        if let Ok(v) = row.try_get::<Option<u64>, _>(i) {
            return v.map(Value::UInt).unwrap_or(Value::Null);
        }
    }
    if ti(type_name, &["FLOAT", "DOUBLE"]) {
        if let Ok(v) = row.try_get::<Option<f64>, _>(i) {
            return v.map(Value::Float).unwrap_or(Value::Null);
        }
    }
    if ti(type_name, &["BOOLEAN"]) {
        if let Ok(v) = row.try_get::<Option<bool>, _>(i) {
            return v.map(Value::Bool).unwrap_or(Value::Null);
        }
    }
    if ti(type_name, &["DECIMAL", "NEWDECIMAL"]) {
        if let Ok(v) = row.try_get::<Option<rust_decimal::Decimal>, _>(i) {
            return v
                .map(|d| Value::String(d.to_string()))
                .unwrap_or(Value::Null);
        }
    }
    if ti(type_name, &["DATE", "TIME", "DATETIME", "TIMESTAMP"]) {
        // Each chrono type is `compatible` with exactly one MySQL column type
        // (see sqlx-mysql `types::chrono`): DATETIME→NaiveDateTime,
        // TIMESTAMP→DateTime<Utc>, DATE→NaiveDate, TIME→NaiveTime. A mismatched
        // `try_get` errors on the compatibility check, so we must try the right
        // one for each — notably TIMESTAMP and TIME are NOT decodable as
        // NaiveDateTime and silently fell through to NULL before this.
        if let Ok(v) = row.try_get::<Option<chrono::NaiveDateTime>, _>(i) {
            return v
                .map(|d| Value::String(d.to_string()))
                .unwrap_or(Value::Null);
        }
        // TIMESTAMP: decode as UTC then render the wall-clock value without the
        // timezone suffix so it lines up with DATETIME formatting.
        if let Ok(v) = row.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>(i) {
            return v
                .map(|d| Value::String(d.naive_utc().to_string()))
                .unwrap_or(Value::Null);
        }
        if let Ok(v) = row.try_get::<Option<chrono::NaiveDate>, _>(i) {
            return v
                .map(|d| Value::String(d.to_string()))
                .unwrap_or(Value::Null);
        }
        if let Ok(v) = row.try_get::<Option<chrono::NaiveTime>, _>(i) {
            return v
                .map(|d| Value::String(d.to_string()))
                .unwrap_or(Value::Null);
        }
    }
    if ti(type_name, &["JSON"]) {
        if let Ok(v) = row.try_get::<Option<serde_json::Value>, _>(i) {
            return v
                .map(|j| Value::String(j.to_string()))
                .unwrap_or(Value::Null);
        }
    }
    if ti(
        type_name,
        &[
            "BLOB",
            "TINYBLOB",
            "MEDIUMBLOB",
            "LONGBLOB",
            "BINARY",
            "VARBINARY",
        ],
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

/// Quote-aware comment stripping shared across drivers (`db::strip_sql_comments`).
fn strip_sql_comments(sql: &str) -> String {
    super::strip_sql_comments(sql, super::SqlFlavor::MySql)
}

/// Decides whether `sql` should run through the result-set path
/// (`fetch`/`fetch_all`) or the `execute` path that only reports
/// `rows_affected`. The leading keyword is the main signal, with one shape
/// that needs more than a prefix check:
///
/// - `WITH` (CTE) is not SELECT-only: a CTE can prefix an INSERT/UPDATE/DELETE
///   that mutates rows. Treating every `WITH` as a query hides those mutations
///   behind an empty "0 rows" grid, so we inspect the statement that follows
///   the CTE definitions (see `with_cte_is_mutation`).
///
/// `CALL` is intentionally absent: a stored procedure decides at runtime
/// whether it returns a result set, so it gets its own path keyed off
/// [`is_call_shape`] and `fetch_many` rather than being forced down either
/// branch here.
fn is_query_shape(sql: &str) -> bool {
    // Leading comments/whitespace must be skipped before the keyword check, or
    // a perfectly normal `/* hint */ SELECT ...` / `-- note\nWITH ...` would
    // miss the prefix match and get misrouted to the execute path.
    let trimmed = skip_leading_comments_and_ws(sql).to_ascii_lowercase();
    if trimmed.starts_with("with") {
        return !with_cte_is_mutation(sql);
    }
    trimmed.starts_with("select")
        || trimmed.starts_with("show")
        || trimmed.starts_with("describe")
        || trimmed.starts_with("desc ")
        || trimmed.starts_with("explain")
}

/// True when `sql`'s first keyword is `CALL` (a stored-procedure invocation),
/// ignoring leading whitespace and comments. CALL is routed separately from
/// [`is_query_shape`] because the procedure decides at runtime whether it
/// returns a result set: the caller drives it through `fetch_many` so a
/// result-returning proc fills the grid while a DML-only proc still reports
/// `rows_affected` (see `collect_call`).
fn is_call_shape(sql: &str) -> bool {
    skip_leading_comments_and_ws(sql)
        .to_ascii_lowercase()
        .starts_with("call")
}

/// Runs a `CALL` and decides at runtime whether it produced a result set.
/// `fetch_many` yields `Either::Right(row)` for result-set rows and
/// `Either::Left(_)` for the OK/status packets MySQL sends between (and after)
/// the procedure's statements. If any rows arrive we surface the first result
/// set as a grid (later sets are drained and ignored — multi-result-set
/// support is out of scope); otherwise we sum the affected-row counts so a
/// DML-only procedure reports `rows_affected` instead of a silent zero.
async fn collect_call(
    conn: &mut sqlx::MySqlConnection,
    sql: &str,
    started: Instant,
) -> Result<QueryResult> {
    let mut stream = sqlx::raw_sql(sqlx::AssertSqlSafe(sql)).fetch_many(&mut *conn);
    let mut rows: Vec<MySqlRow> = Vec::new();
    let mut saw_result_set = false;
    let mut first_set_done = false;
    let mut rows_affected: u64 = 0;
    while let Some(item) = stream.next().await {
        match item? {
            Either::Right(row) => {
                if !first_set_done {
                    saw_result_set = true;
                    rows.push(row);
                }
            }
            Either::Left(result) => {
                if saw_result_set {
                    first_set_done = true;
                } else if !first_set_done {
                    rows_affected = rows_affected.saturating_add(result.rows_affected());
                }
            }
        }
    }
    drop(stream);
    let elapsed_ms = started.elapsed().as_millis() as u64;
    if saw_result_set {
        let columns = columns_of(&rows);
        let rows_out = rows.iter().map(row_to_values).collect();
        Ok(QueryResult {
            columns,
            rows: rows_out,
            rows_affected: 0,
            elapsed_ms,
        })
    } else {
        Ok(QueryResult::empty(rows_affected, elapsed_ms))
    }
}

/// Returns the slice of `sql` starting at the first byte that is not leading
/// whitespace or a leading SQL comment (`-- ...`, `# ...`, `/* ... */`),
/// skipping any run of them. Leading comments precede any string literal, so a
/// quote-unaware scan is safe here. Comment bodies may contain multi-byte
/// UTF-8, but the scan only ever stops on the ASCII bytes `\n` and `*/`, which
/// never occur inside a UTF-8 continuation byte, so the returned index always
/// lands on a char boundary.
fn skip_leading_comments_and_ws(sql: &str) -> &str {
    let bytes = sql.as_bytes();
    let n = bytes.len();
    let mut i = 0;
    loop {
        while i < n && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= n {
            break;
        }
        if bytes[i] == b'-' && i + 1 < n && bytes[i + 1] == b'-' {
            i += 2;
            while i < n && bytes[i] != b'\n' {
                i += 1;
            }
        } else if bytes[i] == b'#' {
            i += 1;
            while i < n && bytes[i] != b'\n' {
                i += 1;
            }
        } else if bytes[i] == b'/' && i + 1 < n && bytes[i + 1] == b'*' {
            i += 2;
            while i + 1 < n && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                i += 1;
            }
            i = (i + 2).min(n);
        } else {
            break;
        }
    }
    &sql[i.min(n)..]
}

/// For a statement beginning with `WITH`, returns true when the *main*
/// statement that follows the CTE definitions mutates rows
/// (INSERT/UPDATE/DELETE/REPLACE/MERGE), so it must take the `execute` path.
///
/// CTE bodies and column lists are always parenthesised, so the main
/// statement's leading keyword is the first statement keyword we encounter at
/// parenthesis depth 0 — any SELECT inside a CTE body sits at depth > 0 and is
/// skipped. Comments and quoted text (`'...'`, `"..."`, `` `...` ``) are
/// ignored so a keyword inside a literal or identifier isn't mistaken for the
/// main statement. If no decisive keyword is found (e.g. `WITH ... TABLE t`),
/// the statement is treated as query-shaped, preserving the historical
/// default.
fn with_cte_is_mutation(sql: &str) -> bool {
    let mut depth: i32 = 0;
    let mut in_single = false;
    let mut in_double = false;
    let mut in_backtick = false;
    let mut word = String::new();

    let mut chars = sql.chars().peekable();
    loop {
        let next = chars.next();
        if in_single {
            match next {
                Some('\\') => {
                    chars.next();
                }
                Some('\'') => {
                    if chars.peek() == Some(&'\'') {
                        chars.next();
                    } else {
                        in_single = false;
                    }
                }
                Some(_) => {}
                None => break,
            }
            continue;
        }
        if in_double {
            match next {
                Some('\\') => {
                    chars.next();
                }
                Some('"') => {
                    if chars.peek() == Some(&'"') {
                        chars.next();
                    } else {
                        in_double = false;
                    }
                }
                Some(_) => {}
                None => break,
            }
            continue;
        }
        if in_backtick {
            match next {
                Some('`') => in_backtick = false,
                Some(_) => {}
                None => break,
            }
            continue;
        }

        let is_word_char = matches!(next, Some(c) if c.is_alphanumeric() || c == '_' || c == '$');
        if is_word_char {
            // is_word_char が真のときは matches! マクロにより next が Some であることが保証されている。
            #[allow(clippy::unwrap_used)]
            word.push(next.unwrap());
            continue;
        }

        // A non-word character ends the current word, which lived at the
        // current paren depth (the structural char below hasn't been applied
        // yet). Only depth-0 words are candidates for the main keyword.
        if !word.is_empty() {
            if depth == 0 {
                match word.to_ascii_lowercase().as_str() {
                    "select" => return false,
                    "insert" | "update" | "delete" | "replace" | "merge" => return true,
                    _ => {}
                }
            }
            word.clear();
        }

        match next {
            Some('\'') => in_single = true,
            Some('"') => in_double = true,
            Some('`') => in_backtick = true,
            // Comments are handled inline (rather than pre-stripping) so the
            // quote state above protects comment markers that appear inside
            // string/identifier literals, e.g. `SELECT '-- keep'`.
            Some('-') if chars.peek() == Some(&'-') => {
                chars.next();
                for c in chars.by_ref() {
                    if c == '\n' {
                        break;
                    }
                }
            }
            Some('#') => {
                for c in chars.by_ref() {
                    if c == '\n' {
                        break;
                    }
                }
            }
            Some('/') if chars.peek() == Some(&'*') => {
                chars.next();
                let mut prev = '\0';
                for c in chars.by_ref() {
                    if prev == '*' && c == '/' {
                        break;
                    }
                    prev = c;
                }
            }
            Some('(') => depth += 1,
            Some(')') => {
                if depth > 0 {
                    depth -= 1;
                }
            }
            Some(_) => {}
            None => break,
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_shape_recognises_plain_selects() {
        assert!(is_query_shape("SELECT * FROM users"));
        assert!(is_query_shape("  show tables"));
        assert!(is_query_shape("DESCRIBE users"));
        assert!(is_query_shape("desc users"));
        assert!(is_query_shape("EXPLAIN SELECT 1"));
    }

    #[test]
    fn call_shape_detects_stored_procedure_calls() {
        // CALL gets its own runtime-detection path (fetch_many), so it must be
        // recognised by `is_call_shape` and must NOT be claimed by the plain
        // result-set path in `is_query_shape`.
        assert!(is_call_shape("CALL sp_report(2024)"));
        assert!(is_call_shape("  call myproc()"));
        assert!(is_call_shape("/* go */ -- run\n CALL p()"));
        assert!(!is_call_shape("SELECT 1"));
        assert!(!is_call_shape("INSERT INTO t VALUES (1)"));
        assert!(!is_query_shape("CALL sp_report(2024)"));
    }

    #[test]
    fn query_shape_treats_plain_dml_as_execute() {
        assert!(!is_query_shape("INSERT INTO t VALUES (1)"));
        assert!(!is_query_shape("UPDATE t SET x = 1"));
        assert!(!is_query_shape("DELETE FROM t WHERE id = 1"));
    }

    #[test]
    fn query_shape_keeps_with_select_as_query() {
        assert!(is_query_shape(
            "WITH cte AS (SELECT 1 AS n) SELECT * FROM cte"
        ));
        assert!(is_query_shape(
            "with recursive nums as (select 1 union select n + 1 from nums where n < 5) select * from nums"
        ));
    }

    #[test]
    fn query_shape_routes_with_dml_to_execute() {
        // CTE-prefixed DML must report rows_affected, not silently show an
        // empty result grid.
        assert!(!is_query_shape(
            "WITH ranked AS (SELECT id, ROW_NUMBER() OVER (ORDER BY id) AS rn FROM orders) \
             DELETE FROM orders WHERE id IN (SELECT id FROM ranked WHERE rn > 1)"
        ));
        assert!(!is_query_shape(
            "WITH src AS (SELECT 1 AS id) INSERT INTO t SELECT * FROM src"
        ));
        assert!(!is_query_shape(
            "WITH c AS (SELECT 1) UPDATE t SET x = 1 WHERE id IN (SELECT * FROM c)"
        ));
    }

    #[test]
    fn with_cte_keyword_in_literal_is_ignored() {
        // 'delete' here lives inside a string literal in the CTE body and must
        // not be read as the main statement.
        assert!(is_query_shape(
            "WITH c AS (SELECT 'delete me' AS note) SELECT * FROM c"
        ));
    }

    #[test]
    fn query_shape_skips_leading_comments() {
        // Leading block/line/hash comments must not hide the real keyword.
        assert!(is_query_shape("/* hint */ SELECT 1"));
        assert!(is_query_shape("-- note\nSELECT 1"));
        assert!(is_query_shape("# note\nSELECT 1"));
        assert!(is_query_shape("  /* a */ -- b\n  SHOW TABLES"));
        // Leading comment before a CTE-prefixed mutation still routes to execute.
        assert!(!is_query_shape(
            "-- delete dups\nWITH c AS (SELECT 1) DELETE FROM t"
        ));
        assert!(!is_query_shape("/* c */ INSERT INTO t VALUES (1)"));
    }

    #[test]
    fn with_cte_comment_marker_in_literal_is_preserved() {
        // The `--` lives inside a string literal, so it must not be treated as
        // a comment that would swallow the trailing DELETE. Regression: a
        // quote-unaware comment strip truncated the statement and misrouted
        // the mutation to the fetch path.
        assert!(!is_query_shape(
            "WITH c AS (SELECT '-- keep' AS note) DELETE FROM t WHERE id IN (SELECT 1)"
        ));
        // A genuine line comment between the CTE and the main keyword is
        // skipped so the DELETE is still detected.
        assert!(!is_query_shape(
            "WITH c AS (SELECT 1) -- pick\n DELETE FROM t WHERE id = 1"
        ));
    }

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
