use std::time::Instant;

use futures_util::StreamExt;
use sqlx::postgres::{PgColumn, PgConnectOptions, PgPool, PgPoolOptions, PgRow};
use sqlx::{Acquire, Column as _, Row, TypeInfo, ValueRef};

use super::types::{
    Column, ForeignKey, IndexInfo, PreviewResult, ProcessInfo, QueryResult, SchemaObject,
    StreamBatch, TableColumnInfo, TableRowEstimate, TableSchema, Value,
};
use super::DbConnectOptions;
use crate::error::{AppError, Result};

pub struct PostgresConn {
    pool: PgPool,
    /// 明示トランザクションで確保した専用接続。BEGIN〜COMMIT/ROLLBACK の間、
    /// すべての文をこの 1 本で実行して同一トランザクションに乗せる。
    tx: tokio::sync::Mutex<Option<sqlx::pool::PoolConnection<sqlx::Postgres>>>,
}

impl PostgresConn {
    pub async fn connect(opts: &DbConnectOptions) -> Result<Self> {
        let mut connect = PgConnectOptions::new()
            .host(&opts.host)
            .port(opts.port)
            .username(&opts.user)
            .password(&opts.password);
        if let Some(db) = &opts.database {
            if !db.is_empty() {
                connect = connect.database(db);
            }
        }
        let pool = PgPoolOptions::new()
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
                    "postgres: failed to create connection pool"
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
        apply_search_path(&mut conn, database).await?;
        run_sql_on(&mut conn, sql).await
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
        apply_search_path(&mut conn, database).await?;
        sqlx::query("BEGIN").execute(&mut *conn).await?;
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
        sqlx::query(stmt).execute(&mut *conn).await?;
        Ok(())
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
        let is_query = is_query_shape(sql);

        let mut conn = self.pool.acquire().await?;
        apply_search_path(&mut conn, database).await?;

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
        // Reject stacked statements outright so the preview can only ever run
        // the single mutation it shows a diff for (the rollback below assumes
        // exactly one statement executed).
        if super::has_stacked_statements(sql) {
            return Err(AppError::InvalidInput(
                "preview does not support multiple statements".into(),
            ));
        }

        let target = extract_target_table(sql);
        let primary_key = match target.as_deref() {
            Some(t) => fetch_primary_key(&self.pool, t).await.unwrap_or_default(),
            None => Vec::new(),
        };

        let mut conn = self.pool.acquire().await?;
        apply_search_path(&mut conn, database).await?;

        let before_sql = target.as_ref().map(|t| {
            let order = super::pk_order_clause(&primary_key, pg_quote_ident);
            format!("SELECT * FROM {}{} LIMIT {}", t, order, row_limit + 1)
        });

        let mut tx = conn.begin().await?;
        let started = Instant::now();

        let before_raw: Vec<PgRow> = match &before_sql {
            Some(q) => fetch_capped_pg(&mut tx, q, row_limit + 1).await?,
            None => Vec::new(),
        };

        let result = sqlx::query(sqlx::AssertSqlSafe(sql))
            .execute(&mut *tx)
            .await?;
        let rows_affected = result.rows_affected();

        let after_raw: Vec<PgRow> = match &before_sql {
            Some(q) => fetch_capped_pg(&mut tx, q, row_limit + 1).await?,
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

    /// Bulk INSERT wrapped in one transaction. Unlike MySQL/SQLite we splice
    /// values in as string literals rather than binding them: a bound text
    /// parameter against e.g. an `int4` column is rejected by Postgres' strict
    /// type checking, whereas an untyped string literal (`'42'`) is coerced to
    /// the column type. `standard_conforming_strings` is forced on so doubling
    /// single quotes is the only escaping needed.
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
            .map(|c| pg_quote_ident(c))
            .collect::<Vec<_>>()
            .join(", ");
        let table_ident = pg_quote_ident(table);
        let batch = batch_size.clamp(1, 1000);

        let mut conn = self.pool.acquire().await?;
        apply_search_path(&mut conn, database).await?;
        sqlx::Executor::execute(
            &mut *conn,
            sqlx::raw_sql("SET standard_conforming_strings = on"),
        )
        .await?;
        let mut tx = conn.begin().await?;
        let mut inserted: u64 = 0;
        for chunk in rows.chunks(batch) {
            let mut sql = format!("INSERT INTO {} ({}) VALUES ", table_ident, cols_sql);
            for (r, row) in chunk.iter().enumerate() {
                if r > 0 {
                    sql.push(',');
                }
                sql.push('(');
                for ci in 0..ncols {
                    if ci > 0 {
                        sql.push(',');
                    }
                    let cell = row.get(ci).and_then(|c| c.as_deref());
                    sql.push_str(&pg_literal(cell));
                }
                sql.push(')');
            }
            sqlx::query(sqlx::AssertSqlSafe(sql))
                .execute(&mut *tx)
                .await?;
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
        apply_search_path(&mut conn, database).await?;
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

    /// In the tree UI, the "database" level surfaces PostgreSQL schemas
    /// (a connection is fixed to one actual database, so listing schemas
    /// is the useful next-level browsing axis). System schemas are hidden.
    pub async fn databases(&self) -> Result<Vec<String>> {
        let rows: Vec<PgRow> = sqlx::query(
            "SELECT nspname FROM pg_namespace
             WHERE nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
               AND nspname NOT LIKE 'pg_temp_%'
               AND nspname NOT LIKE 'pg_toast_temp_%'
             ORDER BY nspname",
        )
        .fetch_all(&self.pool)
        .await?;
        rows.iter()
            .map(|r| r.try_get::<String, _>(0).map_err(Into::into))
            .collect()
    }

    /// Client backends from `pg_stat_activity` for the process monitor panel.
    /// Background workers (autovacuum, WAL writer, ...) are filtered out — the
    /// panel is about client connections, and terminating system backends is
    /// never what the user means. The app's own pooled connections do appear,
    /// exactly as they do in MySQL's processlist.
    pub async fn list_processes(&self) -> Result<Vec<ProcessInfo>> {
        let rows: Vec<PgRow> = sqlx::query(
            r#"SELECT pid,
                      usename,
                      CASE WHEN client_addr IS NULL THEN NULL
                           ELSE host(client_addr) || ':' || client_port END,
                      datname,
                      state,
                      wait_event,
                      EXTRACT(EPOCH FROM (now() - query_start))::bigint,
                      query,
                      pid = pg_backend_pid()
               FROM pg_stat_activity
               WHERE backend_type = 'client backend'
               ORDER BY pid"#,
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|r| ProcessInfo {
                id: i64::from(r.try_get::<i32, _>(0).unwrap_or_default()),
                user: r.try_get::<Option<String>, _>(1).ok().flatten(),
                host: r.try_get::<Option<String>, _>(2).ok().flatten(),
                database: r.try_get::<Option<String>, _>(3).ok().flatten(),
                command: r.try_get::<Option<String>, _>(4).ok().flatten(),
                state: r.try_get::<Option<String>, _>(5).ok().flatten(),
                time_secs: r.try_get::<Option<i64>, _>(6).ok().flatten(),
                query: r.try_get::<Option<String>, _>(7).ok().flatten(),
                is_self: r.try_get::<bool, _>(8).unwrap_or(false),
            })
            .collect())
    }

    /// `pg_terminate_backend(pid)` — terminates the whole backend (the
    /// connection), matching MySQL `KILL`. Returns Ok even when the pid is
    /// already gone (the function just returns false), which is the right
    /// behaviour for a monitor that may race the process's natural exit.
    pub async fn kill_process(&self, id: i64) -> Result<()> {
        let pid = i32::try_from(id)
            .map_err(|_| AppError::InvalidInput(format!("invalid backend pid: {id}")))?;
        sqlx::query("SELECT pg_terminate_backend($1)")
            .bind(pid)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn tables(&self, schema: &str) -> Result<Vec<String>> {
        let rows: Vec<PgRow> = sqlx::query(
            "SELECT tablename AS name FROM pg_tables WHERE schemaname = $1
             UNION ALL
             SELECT viewname AS name FROM pg_views WHERE schemaname = $1
             UNION ALL
             SELECT matviewname AS name FROM pg_matviews WHERE schemaname = $1
             ORDER BY name",
        )
        .bind(schema)
        .fetch_all(&self.pool)
        .await?;
        rows.iter()
            .map(|r| r.try_get::<String, _>(0).map_err(Into::into))
            .collect()
    }

    pub async fn columns(&self, schema: &str, table: &str) -> Result<Vec<TableColumnInfo>> {
        let rows: Vec<PgRow> = sqlx::query(
            r#"SELECT
                c.column_name,
                c.data_type,
                c.is_nullable,
                CASE WHEN pk.column_name IS NOT NULL THEN 'PRI' ELSE '' END AS column_key,
                c.column_default,
                ''::text AS extra,
                fk.ref_table,
                fk.ref_column
              FROM information_schema.columns c
              LEFT JOIN (
                SELECT kcu.column_name
                FROM information_schema.table_constraints tc
                JOIN information_schema.key_column_usage kcu
                  ON tc.constraint_name = kcu.constraint_name
                 AND tc.table_schema    = kcu.table_schema
                 AND tc.table_name      = kcu.table_name
                WHERE tc.constraint_type = 'PRIMARY KEY'
                  AND tc.table_schema = $1
                  AND tc.table_name   = $2
              ) pk ON pk.column_name = c.column_name
              LEFT JOIN (
                SELECT DISTINCT ON (kcu.column_name)
                  kcu.column_name,
                  ccu.table_name  AS ref_table,
                  ccu.column_name AS ref_column
                FROM information_schema.table_constraints tc
                JOIN information_schema.key_column_usage kcu
                  ON tc.constraint_name = kcu.constraint_name
                 AND tc.table_schema    = kcu.table_schema
                 AND tc.table_name      = kcu.table_name
                JOIN information_schema.constraint_column_usage ccu
                  ON ccu.constraint_name = tc.constraint_name
                 AND ccu.table_schema    = tc.table_schema
                WHERE tc.constraint_type = 'FOREIGN KEY'
                  AND tc.table_schema = $1
                  AND tc.table_name   = $2
                ORDER BY kcu.column_name
              ) fk ON fk.column_name = c.column_name
              WHERE c.table_schema = $1 AND c.table_name = $2
              ORDER BY c.ordinal_position"#,
        )
        .bind(schema)
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

    pub async fn foreign_keys(&self, schema: &str) -> Result<Vec<ForeignKey>> {
        // Join the FK constraints to their referencing columns (key_column_usage)
        // and referenced columns (constraint_column_usage). This mirrors the
        // per-table query in `columns`; like that one, the column pairing is
        // exact for single-column keys (the common case) and best-effort for
        // composite keys, which is sufficient for drawing table-to-table edges.
        let rows: Vec<PgRow> = sqlx::query(
            r#"SELECT
                 tc.table_name,
                 kcu.column_name,
                 ccu.table_name  AS ref_table,
                 ccu.column_name AS ref_column,
                 tc.constraint_name
               FROM information_schema.table_constraints tc
               JOIN information_schema.key_column_usage kcu
                 ON tc.constraint_name = kcu.constraint_name
                AND tc.table_schema    = kcu.table_schema
                AND tc.table_name      = kcu.table_name
               JOIN information_schema.constraint_column_usage ccu
                 ON ccu.constraint_name = tc.constraint_name
                AND ccu.table_schema    = tc.table_schema
               WHERE tc.constraint_type = 'FOREIGN KEY'
                 AND tc.table_schema = $1
               ORDER BY tc.table_name, tc.constraint_name, kcu.ordinal_position"#,
        )
        .bind(schema)
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

    pub async fn schema_objects(&self, schema: &str) -> Result<Vec<SchemaObject>> {
        // Views, materialized views, routines, and triggers, unioned in display
        // order. `schema` is the namespace (the tree's "database" for PG).
        // Routines and triggers carry their `oid` (as text) so `object_definition`
        // can fetch the exact object — same-name overloaded functions and
        // same-name triggers on different tables would otherwise collide.
        let rows: Vec<PgRow> = sqlx::query(
            r#"
            SELECT 'view'::text AS kind, viewname AS name, NULL::text AS id
              FROM pg_views WHERE schemaname = $1
            UNION ALL
            SELECT 'materialized_view', matviewname, NULL::text
              FROM pg_matviews WHERE schemaname = $1
            UNION ALL
            SELECT CASE WHEN p.prokind = 'p' THEN 'procedure' ELSE 'function' END,
                   p.proname, p.oid::text
              FROM pg_proc p
              JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = $1
            UNION ALL
            SELECT 'trigger', t.tgname, t.oid::text
              FROM pg_trigger t
              JOIN pg_class c ON c.oid = t.tgrelid
              JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = $1 AND NOT t.tgisinternal
            ORDER BY kind, name
            "#,
        )
        .bind(schema)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|r| SchemaObject {
                kind: r.try_get::<String, _>(0).unwrap_or_default(),
                name: r.try_get::<String, _>(1).unwrap_or_default(),
                id: r.try_get::<Option<String>, _>(2).ok().flatten(),
            })
            .collect())
    }

    pub async fn object_definition(
        &self,
        schema: &str,
        kind: &str,
        name: &str,
        id: Option<&str>,
    ) -> Result<String> {
        // Routines/triggers are looked up by their oid (`id`) so overloads and
        // same-name triggers resolve to the exact object. Views/matviews are
        // unique per schema, so name is sufficient.
        let def: Option<String> = match kind {
            "view" | "materialized_view" => {
                sqlx::query_scalar("SELECT pg_get_viewdef(format('%I.%I', $1, $2)::regclass, true)")
                    .bind(schema)
                    .bind(name)
                    .fetch_optional(&self.pool)
                    .await?
            }
            "function" | "procedure" => match id {
                Some(oid) => {
                    sqlx::query_scalar("SELECT pg_get_functiondef(($1)::oid)")
                        .bind(oid)
                        .fetch_optional(&self.pool)
                        .await?
                }
                None => {
                    sqlx::query_scalar(
                        "SELECT pg_get_functiondef(p.oid)
                           FROM pg_proc p
                           JOIN pg_namespace n ON n.oid = p.pronamespace
                          WHERE n.nspname = $1 AND p.proname = $2
                          LIMIT 1",
                    )
                    .bind(schema)
                    .bind(name)
                    .fetch_optional(&self.pool)
                    .await?
                }
            },
            "trigger" => match id {
                Some(oid) => {
                    sqlx::query_scalar("SELECT pg_get_triggerdef(($1)::oid)")
                        .bind(oid)
                        .fetch_optional(&self.pool)
                        .await?
                }
                None => {
                    sqlx::query_scalar(
                        "SELECT pg_get_triggerdef(t.oid)
                           FROM pg_trigger t
                           JOIN pg_class c ON c.oid = t.tgrelid
                           JOIN pg_namespace n ON n.oid = c.relnamespace
                          WHERE n.nspname = $1 AND t.tgname = $2 AND NOT t.tgisinternal
                          LIMIT 1",
                    )
                    .bind(schema)
                    .bind(name)
                    .fetch_optional(&self.pool)
                    .await?
                }
            },
            other => {
                return Err(AppError::InvalidInput(format!(
                    "unsupported object kind: {other}"
                )))
            }
        };
        def.ok_or_else(|| {
            AppError::InvalidInput(format!("no definition found for {kind} '{name}'"))
        })
    }

    pub async fn list_indexes(&self, schema: &str, table: &str) -> Result<Vec<IndexInfo>> {
        // Expand pg_index.indkey (the ordered column attnums) with ordinality so
        // composite indexes keep declaration order, then resolve each attnum to a
        // column name via pg_attribute. indisprimary marks the PK; indisunique
        // marks UNIQUE; pg_am.amname is the access method (btree/gin/...).
        let rows: Vec<PgRow> = sqlx::query(
            r#"SELECT
                 i.relname           AS index_name,
                 a.attname           AS column_name,
                 ix.indisunique      AS is_unique,
                 ix.indisprimary     AS is_primary,
                 am.amname           AS method,
                 k.ord               AS ord
               FROM pg_class t
               JOIN pg_namespace n ON n.oid = t.relnamespace
               JOIN pg_index ix    ON ix.indrelid = t.oid
               JOIN pg_class i     ON i.oid = ix.indexrelid
               JOIN pg_am am       ON am.oid = i.relam
               JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
               LEFT JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
               WHERE t.relname = $1 AND n.nspname = $2
               ORDER BY i.relname, k.ord"#,
        )
        .bind(table)
        .bind(schema)
        .fetch_all(&self.pool)
        .await?;
        let mut order: Vec<String> = Vec::new();
        let mut by_name: std::collections::HashMap<String, IndexInfo> =
            std::collections::HashMap::new();
        for r in &rows {
            let name = r.try_get::<String, _>("index_name").unwrap_or_default();
            if name.is_empty() {
                continue;
            }
            let column = r.try_get::<Option<String>, _>("column_name").ok().flatten();
            let unique = r.try_get::<bool, _>("is_unique").unwrap_or(false);
            let primary = r.try_get::<bool, _>("is_primary").unwrap_or(false);
            let method = r.try_get::<Option<String>, _>("method").ok().flatten();
            let entry = by_name.entry(name.clone()).or_insert_with(|| {
                order.push(name.clone());
                IndexInfo {
                    name: name.clone(),
                    columns: Vec::new(),
                    unique,
                    primary,
                    method,
                }
            });
            // attnum 0 (an expression index column) resolves to NULL; skip it.
            if let Some(col) = column {
                entry.columns.push(col);
            }
        }
        Ok(order
            .into_iter()
            .filter_map(|n| by_name.remove(&n))
            .collect())
    }

    pub async fn schema_overview(&self, schema: &str) -> Result<Vec<TableSchema>> {
        // information_schema.columns covers ordinary tables and views; that is
        // the common autocomplete surface. Materialised views (listed by
        // `tables`) live only in pg_catalog and are intentionally omitted here.
        let rows: Vec<PgRow> = sqlx::query(
            r#"SELECT table_name, column_name
               FROM information_schema.columns
               WHERE table_schema = $1
               ORDER BY table_name, ordinal_position"#,
        )
        .bind(schema)
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

    pub async fn table_row_estimates(&self, schema: &str) -> Result<Vec<TableRowEstimate>> {
        // pg_class.reltuples is the planner's cached row estimate, maintained by
        // ANALYZE / (auto)VACUUM — no table scan. relkind 'r'/'p' covers ordinary
        // and partitioned tables; views and indexes are excluded. reltuples is
        // -1 when the table has never been analyzed (PG 14+), which we surface as
        // `None` (unknown) rather than a misleading 0.
        let rows: Vec<PgRow> = sqlx::query(
            r#"SELECT c.relname, c.reltuples::bigint AS est
               FROM pg_class c
               JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname = $1 AND c.relkind IN ('r', 'p')
               ORDER BY c.relname"#,
        )
        .bind(schema)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|r| {
                let raw = r.try_get::<i64, _>(1).unwrap_or(-1);
                TableRowEstimate {
                    name: r.try_get::<String, _>(0).unwrap_or_default(),
                    estimate: (raw >= 0).then_some(raw),
                }
            })
            .collect())
    }
}

fn is_query_shape(sql: &str) -> bool {
    let trimmed = sql.trim_start().to_ascii_lowercase();
    trimmed.starts_with("select")
        || trimmed.starts_with("show")
        || trimmed.starts_with("explain")
        || trimmed.starts_with("with")
        || trimmed.starts_with("values")
        || trimmed.starts_with("table ")
}

async fn apply_search_path(
    conn: &mut sqlx::pool::PoolConnection<sqlx::Postgres>,
    schema: Option<&str>,
) -> Result<()> {
    let Some(s) = schema else { return Ok(()) };
    if s.is_empty() {
        return Ok(());
    }
    if s.contains('"') || s.contains('\\') || s.contains('\0') {
        return Err(AppError::InvalidInput("invalid schema name".into()));
    }
    // Quote the identifier to handle mixed-case / reserved-word schema names.
    let sql = format!("SET search_path TO \"{}\"", s);
    sqlx::Executor::execute(&mut **conn, sqlx::raw_sql(sqlx::AssertSqlSafe(sql))).await?;
    Ok(())
}

/// Run one statement on a specific connection and decode it. Shared by
/// `execute` (pool connection) and `tx_execute` (held transaction connection).
async fn run_sql_on(conn: &mut sqlx::PgConnection, sql: &str) -> Result<QueryResult> {
    let started = Instant::now();
    if is_query_shape(sql) {
        let rows: Vec<PgRow> = sqlx::query(sqlx::AssertSqlSafe(sql))
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

fn columns_of(rows: &[PgRow]) -> Vec<Column> {
    let Some(first) = rows.first() else {
        return Vec::new();
    };
    first
        .columns()
        .iter()
        .map(|c: &PgColumn| Column {
            name: c.name().to_string(),
            type_name: c.type_info().name().to_string(),
        })
        .collect()
}

fn row_to_values(row: &PgRow) -> Vec<Value> {
    (0..row.columns().len())
        .map(|i| decode_cell(row, i))
        .collect()
}

fn decode_cell(row: &PgRow, i: usize) -> Value {
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

    // Integer family. Postgres has signed-only int2/int4/int8 (no unsigned).
    if ti(type_name, &["INT2"]) {
        if let Ok(v) = row.try_get::<Option<i16>, _>(i) {
            return v.map(|n| Value::Int(n as i64)).unwrap_or(Value::Null);
        }
    }
    if ti(type_name, &["INT4"]) {
        if let Ok(v) = row.try_get::<Option<i32>, _>(i) {
            return v.map(|n| Value::Int(n as i64)).unwrap_or(Value::Null);
        }
    }
    if ti(type_name, &["INT8"]) {
        if let Ok(v) = row.try_get::<Option<i64>, _>(i) {
            return v.map(Value::Int).unwrap_or(Value::Null);
        }
    }
    if ti(type_name, &["FLOAT4"]) {
        if let Ok(v) = row.try_get::<Option<f32>, _>(i) {
            return v.map(|f| Value::Float(f as f64)).unwrap_or(Value::Null);
        }
    }
    if ti(type_name, &["FLOAT8"]) {
        if let Ok(v) = row.try_get::<Option<f64>, _>(i) {
            return v.map(Value::Float).unwrap_or(Value::Null);
        }
    }
    if ti(type_name, &["BOOL"]) {
        if let Ok(v) = row.try_get::<Option<bool>, _>(i) {
            return v.map(Value::Bool).unwrap_or(Value::Null);
        }
    }
    if ti(type_name, &["NUMERIC"]) {
        if let Ok(v) = row.try_get::<Option<rust_decimal::Decimal>, _>(i) {
            return v
                .map(|d| Value::String(d.to_string()))
                .unwrap_or(Value::Null);
        }
    }
    if ti(type_name, &["TIMESTAMPTZ"]) {
        if let Ok(v) = row.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>(i) {
            return v
                .map(|d| Value::String(d.to_rfc3339()))
                .unwrap_or(Value::Null);
        }
    }
    if ti(type_name, &["TIMESTAMP"]) {
        if let Ok(v) = row.try_get::<Option<chrono::NaiveDateTime>, _>(i) {
            return v
                .map(|d| Value::String(d.to_string()))
                .unwrap_or(Value::Null);
        }
    }
    if ti(type_name, &["DATE"]) {
        if let Ok(v) = row.try_get::<Option<chrono::NaiveDate>, _>(i) {
            return v
                .map(|d| Value::String(d.to_string()))
                .unwrap_or(Value::Null);
        }
    }
    if ti(type_name, &["TIME"]) {
        if let Ok(v) = row.try_get::<Option<chrono::NaiveTime>, _>(i) {
            return v
                .map(|d| Value::String(d.to_string()))
                .unwrap_or(Value::Null);
        }
    }
    if ti(type_name, &["JSON", "JSONB"]) {
        if let Ok(v) = row.try_get::<Option<serde_json::Value>, _>(i) {
            return v
                .map(|j| Value::String(j.to_string()))
                .unwrap_or(Value::Null);
        }
    }
    if ti(type_name, &["BYTEA"]) {
        if let Ok(v) = row.try_get::<Option<Vec<u8>>, _>(i) {
            return v
                .map(|b| Value::Bytes(data_encoding::HEXLOWER.encode(&b)))
                .unwrap_or(Value::Null);
        }
    }

    // Default: string (covers TEXT/VARCHAR/BPCHAR/NAME/UUID/INET/CITEXT/...)
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
/// Returns `None` for shapes we don't confidently recognise. The returned
/// string is taken verbatim so quoting/qualification is preserved.
fn extract_target_table(sql: &str) -> Option<String> {
    let tokens = tokenize_sql(sql);
    let mut iter = tokens.into_iter().peekable();
    let first = iter.next()?;
    match first.to_ascii_lowercase().as_str() {
        "update" => {
            // Postgres has UPDATE ONLY ... — skip the ONLY modifier.
            if iter.peek().is_some_and(|t| t.eq_ignore_ascii_case("only")) {
                iter.next();
            }
            let table = iter.next()?;
            // Single-table UPDATE: next token must be SET. (Postgres FROM
            // joins are allowed but we don't try to interpret them.)
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
            // DELETE FROM ONLY tbl ...
            let mut maybe = iter.next()?;
            if maybe.eq_ignore_ascii_case("only") {
                maybe = iter.next()?;
            }
            Some(maybe)
        }
        "insert" => {
            // INSERT INTO tbl ...
            let next = iter.next()?;
            if !next.eq_ignore_ascii_case("into") {
                return None;
            }
            iter.next()
        }
        _ => None,
    }
}

/// Tokenize SQL while keeping double-quoted identifiers (Postgres style)
/// intact. Comments are stripped first.
fn tokenize_sql(sql: &str) -> Vec<String> {
    let cleaned = strip_sql_comments(sql);
    let mut tokens: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut in_dquote = false;
    for c in cleaned.chars() {
        if in_dquote {
            cur.push(c);
            if c == '"' {
                in_dquote = false;
            }
        } else if c == '"' {
            cur.push(c);
            in_dquote = true;
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

/// Quote-aware comment stripping shared across drivers (`db::strip_sql_comments`).
fn strip_sql_comments(sql: &str) -> String {
    super::strip_sql_comments(sql, super::SqlFlavor::Postgres)
}

/// Looks up the target table's primary-key columns from information_schema.
/// `target` may be a bare name (`tbl`), a quoted name (`"tbl"`), or a
/// schema-qualified form (`schema.tbl` / `"schema"."tbl"`).
async fn fetch_primary_key(pool: &PgPool, target: &str) -> Result<Vec<String>> {
    let (schema, table) = split_schema_table(target);
    let rows: Vec<PgRow> = sqlx::query(
        r#"SELECT kcu.column_name, kcu.ordinal_position
           FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu
             ON tc.constraint_name = kcu.constraint_name
            AND tc.table_schema    = kcu.table_schema
            AND tc.table_name      = kcu.table_name
           WHERE tc.constraint_type = 'PRIMARY KEY'
             AND (tc.table_schema = $1 OR ($1 = '' AND tc.table_schema = ANY (current_schemas(false))))
             AND tc.table_name   = $2
           ORDER BY kcu.ordinal_position"#,
    )
    .bind(schema.as_deref().unwrap_or(""))
    .bind(&table)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .iter()
        .filter_map(|r| r.try_get::<String, _>(0).ok())
        .collect())
}

fn split_schema_table(target: &str) -> (Option<String>, String) {
    let trimmed = target.trim();
    let unquoted = |s: &str| -> String {
        let s = s.trim();
        if s.starts_with('"') && s.ends_with('"') && s.len() >= 2 {
            s[1..s.len() - 1].replace("\"\"", "\"")
        } else {
            s.to_string()
        }
    };
    if let Some((s, t)) = split_outside_quotes(trimmed, '.') {
        (Some(unquoted(&s)), unquoted(&t))
    } else {
        (None, unquoted(trimmed))
    }
}

fn split_outside_quotes(s: &str, sep: char) -> Option<(String, String)> {
    let mut in_dquote = false;
    for (i, c) in s.char_indices() {
        if c == '"' {
            in_dquote = !in_dquote;
        } else if c == sep && !in_dquote {
            return Some((s[..i].to_string(), s[i + c.len_utf8()..].to_string()));
        }
    }
    None
}

/// Double-quotes a single identifier, doubling any embedded double quotes.
fn pg_quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// Renders a cell as a Postgres string literal (`'...'`) or `NULL`. Relies on
/// `standard_conforming_strings = on` so only single quotes need doubling;
/// backslashes are literal.
fn pg_literal(cell: Option<&str>) -> String {
    match cell {
        None => "NULL".to_string(),
        Some(s) => format!("'{}'", s.replace('\'', "''")),
    }
}

async fn fetch_capped_pg(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    query: &str,
    cap: usize,
) -> Result<Vec<PgRow>> {
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
    fn parses_quoted_update() {
        assert_eq!(
            extract_target_table("update \"users\" set name = 'a'"),
            Some("\"users\"".into())
        );
    }

    #[test]
    fn parses_qualified_update() {
        assert_eq!(
            extract_target_table("update public.users set name = 'a'"),
            Some("public.users".into())
        );
        assert_eq!(
            extract_target_table("update \"public\".\"users\" set name = 'a'"),
            Some("\"public\".\"users\"".into())
        );
    }

    #[test]
    fn parses_delete() {
        assert_eq!(
            extract_target_table("DELETE FROM orders WHERE id > 10"),
            Some("orders".into())
        );
        assert_eq!(
            extract_target_table("DELETE FROM ONLY orders"),
            Some("orders".into())
        );
    }

    #[test]
    fn parses_insert() {
        assert_eq!(
            extract_target_table("INSERT INTO products (name) VALUES ('x')"),
            Some("products".into())
        );
    }

    #[test]
    fn rejects_non_mutation() {
        assert!(extract_target_table("SELECT * FROM users").is_none());
        assert!(extract_target_table("CREATE TABLE t (id INT)").is_none());
    }

    #[test]
    fn strips_comments_before_parsing() {
        let sql = "/* comment */ -- line\nUPDATE users SET x = 1";
        assert_eq!(extract_target_table(sql), Some("users".into()));
    }

    #[test]
    fn splits_schema_table() {
        assert_eq!(
            split_schema_table("public.users"),
            (Some("public".into()), "users".into())
        );
        assert_eq!(
            split_schema_table("\"public\".\"users\""),
            (Some("public".into()), "users".into())
        );
        assert_eq!(split_schema_table("users"), (None, "users".into()));
        assert_eq!(split_schema_table("\"users\""), (None, "users".into()));
    }

    #[test]
    fn quotes_identifiers_with_double_quotes() {
        assert_eq!(pg_quote_ident("name"), "\"name\"");
        assert_eq!(pg_quote_ident("we\"ird"), "\"we\"\"ird\"");
    }

    #[test]
    fn renders_literals_and_nulls() {
        assert_eq!(pg_literal(None), "NULL");
        assert_eq!(pg_literal(Some("abc")), "'abc'");
        assert_eq!(pg_literal(Some("O'Brien")), "'O''Brien'");
        // Backslash is literal under standard_conforming_strings.
        assert_eq!(pg_literal(Some("a\\b")), "'a\\b'");
    }
}
