use std::time::Instant;

use futures_util::StreamExt;
use sqlx::postgres::{
    PgConnectOptions, PgPool, PgPoolOptions, PgRow, PgSslMode, PgValueFormat, PgValueRef,
};
use sqlx::{Acquire, Row, TypeInfo, ValueRef};

use super::types::{
    Column, ForeignKey, IndexInfo, LiveQuery, PreviewResult, ProcessInfo, QueryResult,
    QueryStatsSupport, SchemaObject, ServerInfo, ServerVariable, StatementStat, StreamBatch,
    TableColumnInfo, TableRowEstimate, TableSchema, TableSizeInfo, Value,
};
use super::{columns_of, decode_string_or_bytes, init_sql_of, DbConnectOptions, SslMode};
use crate::error::{AppError, Result};

/// pg_stat_activity の `application_name` に載せる接続の表示名。
/// [`PostgresConn::live_queries`] が自アプリ由来の行を除外するキーでもある。
const NOOBDB_APPLICATION_NAME: &str = "noobDB";

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
            .password(&opts.password)
            // pg_stat_activity 上で noobDB 由来の接続を識別するための表示名。
            // ライブクエリ・インスペクタ (#746) が「自アプリの接続」をテールから
            // 除外する判定キーにも使う (この文字列を変えるときは
            // `live_queries` のフィルタも合わせて変えること)。
            .application_name(NOOBDB_APPLICATION_NAME);
        if let Some(db) = &opts.database {
            if !db.is_empty() {
                connect = connect.database(db);
            }
        }
        connect = apply_tls(connect, opts);
        let mut pool_opts = PgPoolOptions::new()
            .min_connections(0)
            .max_connections(5)
            .acquire_timeout(std::time::Duration::from_secs(15));
        if let Some(sql) = init_sql_of(opts) {
            // Run the session-init SQL on every physical connection the pool opens.
            pool_opts = pool_opts.after_connect(move |conn, _meta| {
                let sql = sql.clone();
                Box::pin(async move {
                    sqlx::Executor::execute(&mut *conn, sqlx::raw_sql(sqlx::AssertSqlSafe(sql)))
                        .await?;
                    Ok(())
                })
            });
        }
        let pool = pool_opts.connect_with(connect).await.map_err(|e| {
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
        let result = sqlx::query(stmt).execute(&mut *conn).await;
        if let Err(e) = result {
            // COMMIT/ROLLBACK 自体が失敗すると、この接続は BEGIN したままの
            // 不定状態になり得る。`guard` は既に None にしてあるので復旧の
            // 余地はなく、そのままプールに返すと次の利用者がトランザクション
            // 状態を引き継いでしまう。COMMIT 失敗時はベストエフォートで
            // ROLLBACK を試み (失敗しても無視)、最後にこの接続を `detach`
            // してプール管理から切り離してから破棄する — プールへは返さない。
            if commit {
                let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
            }
            drop(conn.detach());
            return Err(e.into());
        }
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
    /// Runs `statements` sequentially inside one transaction, all-or-nothing:
    /// on any error the transaction is dropped without committing.
    ///
    /// Unlike MySQL, PostgreSQL has **transactional DDL** — `CREATE` / `ALTER`
    /// / `DROP` do not implicitly commit, so a mixed DDL+DML batch is genuinely
    /// atomic: if a later statement fails, an earlier `CREATE TABLE` is rolled
    /// back too and leaves nothing behind. This contrast with MySQL (see
    /// `mysql.rs::execute_transaction`, #640) is pinned by the paired
    /// integration tests `postgres_ddl_dml_mixed_batch_rolls_back` /
    /// `mysql_ddl_dml_mixed_batch_is_not_atomic`.
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

    /// ライブクエリ・インスペクタ (#746) の前提可否プローブ。ライブテールは
    /// コア機能の `pg_stat_activity` だけで動くため常に可。digest 集計は
    /// `pg_stat_statements` 拡張が要る: 未導入なら理由コード
    /// `pg_stat_statements_missing` (フロントが `CREATE EXTENSION` /
    /// `shared_preload_libraries` の導入手順をヘルプ表示)、導入済みでも読めない
    /// (権限不足・PG12 以前の列名差) 場合は `stats_unreadable` で縮退する。
    pub async fn query_stats_support(&self) -> Result<QueryStatsSupport> {
        let statements_reason = match self.pg_stat_statements_schema().await? {
            None => Some("pg_stat_statements_missing".to_string()),
            Some(schema) => {
                // 実際に読めるかまでプローブする (PG13+ の列名で 1 行だけ)。
                let probe = format!(
                    "SELECT calls, total_exec_time, max_exec_time, rows \
                     FROM {schema}.pg_stat_statements LIMIT 1"
                );
                match sqlx::query(sqlx::AssertSqlSafe(probe))
                    .fetch_all(&self.pool)
                    .await
                {
                    Ok(_) => None,
                    Err(_) => Some("stats_unreadable".to_string()),
                }
            }
        };
        Ok(QueryStatsSupport {
            live_tail: true,
            statements: statements_reason.is_none(),
            live_tail_reason: None,
            statements_reason,
        })
    }

    /// `pg_stat_statements` 拡張が入っているスキーマ名 (クオート済み) を返す。
    /// 拡張は任意のスキーマに入れられ search_path に無いと裸名では引けない
    /// ため、毎回カタログから解決してスキーマ修飾で参照する。未導入は `None`。
    async fn pg_stat_statements_schema(&self) -> Result<Option<String>> {
        let row: Option<PgRow> = sqlx::query(
            "SELECT quote_ident(n.nspname)
               FROM pg_extension e
               JOIN pg_namespace n ON n.oid = e.extnamespace
              WHERE e.extname = 'pg_stat_statements'",
        )
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.and_then(|r| r.try_get::<String, _>(0).ok()))
    }

    /// ライブテール 1 サンプル: `pg_stat_activity` の実行中/直近クエリ。
    /// バックエンドごとに現在 (または最後) の 1 文が見えるので、ポーリングで
    /// 時系列テールを構成する (重複排除キーは `pid:query_start`)。
    ///
    /// 除外規則 (#746 自セッション/内部クエリ除外):
    /// - `pg_backend_pid()` — このサンプリング接続自身
    /// - `application_name = 'noobDB'` — 本アプリの他セッション/プール接続
    ///   (connect 時に必ず設定するため確実に効く)
    /// - `pg_stat_` / `pg_catalog` / `information_schema` 参照文 — インスペクタ
    ///   自身のポーリングや introspection
    ///
    /// 権限不足時にクエリ文が `<insufficient privilege>` になる行はそのまま
    /// 返し、フロントが「見えている範囲」の注記を出す (黙って落とさない)。
    pub async fn live_queries(&self) -> Result<Vec<LiveQuery>> {
        let rows: Vec<PgRow> = sqlx::query(
            r#"SELECT pid::text || ':' || COALESCE(EXTRACT(EPOCH FROM query_start)::text, '?'),
                      query,
                      usename,
                      CASE WHEN client_addr IS NULL THEN NULL
                           ELSE host(client_addr) || ':' || client_port END,
                      datname,
                      application_name,
                      (EXTRACT(EPOCH FROM (COALESCE(
                          CASE WHEN state = 'active' THEN NULL ELSE state_change END,
                          now()) - query_start)) * 1000.0)::float8,
                      state = 'active',
                      (EXTRACT(EPOCH FROM query_start) * 1000.0)::float8
               FROM pg_stat_activity
               WHERE backend_type = 'client backend'
                 AND pid <> pg_backend_pid()
                 AND application_name <> $1
                 AND query IS NOT NULL AND query <> ''
                 AND query_start IS NOT NULL
                 AND query NOT ILIKE '%pg_stat_%'
                 AND query NOT ILIKE '%pg_catalog%'
                 AND query NOT ILIKE '%information_schema%'
               ORDER BY query_start DESC
               LIMIT 300"#,
        )
        .bind(NOOBDB_APPLICATION_NAME)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|r| LiveQuery {
                key: r.try_get::<String, _>(0).unwrap_or_default(),
                query: r.try_get::<String, _>(1).unwrap_or_default(),
                user: r.try_get::<Option<String>, _>(2).ok().flatten(),
                host: r.try_get::<Option<String>, _>(3).ok().flatten(),
                database: r.try_get::<Option<String>, _>(4).ok().flatten(),
                application: r.try_get::<Option<String>, _>(5).ok().flatten(),
                duration_ms: r.try_get::<Option<f64>, _>(6).ok().flatten(),
                running: r.try_get::<bool, _>(7).unwrap_or(false),
                rows_examined: None,
                started_at_ms: r.try_get::<Option<f64>, _>(8).ok().flatten(),
            })
            .collect())
    }

    /// queryid (フィンガープリント) 単位の累積統計スナップショット
    /// (`pg_stat_statements`、PG13+ の列名)。「記録開始からの差分」はフロント
    /// 純ロジックが 2 スナップショットの引き算で求めるため常に累積値を返す。
    /// インスペクタ自身や introspection 由来の文は集計から除外する。
    pub async fn statement_stats(&self) -> Result<Vec<StatementStat>> {
        let Some(schema) = self.pg_stat_statements_schema().await? else {
            return Err(AppError::InvalidInput(
                "pg_stat_statements is not installed on this server".into(),
            ));
        };
        let sql = format!(
            r#"SELECT s.queryid::text,
                      s.query,
                      d.datname,
                      s.calls,
                      s.total_exec_time,
                      s.max_exec_time,
                      s.rows
               FROM {schema}.pg_stat_statements s
               LEFT JOIN pg_database d ON d.oid = s.dbid
               WHERE s.queryid IS NOT NULL
                 AND s.query NOT ILIKE '%pg_stat_%'
                 AND s.query NOT ILIKE '%pg_catalog%'
                 AND s.query NOT ILIKE '%information_schema%'
               ORDER BY s.total_exec_time DESC
               LIMIT 500"#
        );
        let rows: Vec<PgRow> = sqlx::query(sqlx::AssertSqlSafe(sql))
            .fetch_all(&self.pool)
            .await?;
        Ok(rows
            .into_iter()
            .map(|r| StatementStat {
                digest: r.try_get::<String, _>(0).unwrap_or_default(),
                fingerprint: r.try_get::<String, _>(1).unwrap_or_default(),
                database: r.try_get::<Option<String>, _>(2).ok().flatten(),
                calls: r.try_get::<i64, _>(3).unwrap_or_default(),
                total_time_ms: r.try_get::<f64, _>(4).unwrap_or_default(),
                max_time_ms: r.try_get::<f64, _>(5).unwrap_or_default(),
                rows: r.try_get::<i64, _>(6).ok(),
            })
            .collect())
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
        // `c.data_type` alone is the bare type name (`character varying` /
        // `numeric`) with no length/precision, so `varchar(50)` and
        // `varchar(255)` — or `numeric(10,2)` and `numeric(12,4)` — are
        // indistinguishable to callers (schema diff/sync in db/diff.rs and
        // db/sync.rs compare and DDL-generate off this string). Pulling
        // `character_maximum_length` / `numeric_precision` / `numeric_scale`
        // alongside lets `full_pg_data_type` rebuild the qualified form
        // (`character varying(50)`, `numeric(10,2)`) that `data_type` should
        // have carried in the first place (#K5). Types without a length
        // (integer, text, ...) are returned unchanged.
        let rows: Vec<PgRow> = sqlx::query(
            r#"SELECT
                c.column_name,
                c.data_type,
                c.is_nullable,
                CASE WHEN pk.column_name IS NOT NULL THEN 'PRI' ELSE '' END AS column_key,
                c.column_default,
                ''::text AS extra,
                fk.ref_table,
                fk.ref_column,
                c.character_maximum_length,
                c.numeric_precision,
                c.numeric_scale
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
            .map(|r| {
                let base_type = r.try_get::<String, _>(1).unwrap_or_default();
                let char_len = r.try_get::<Option<i32>, _>(8).ok().flatten();
                let numeric_precision = r.try_get::<Option<i32>, _>(9).ok().flatten();
                let numeric_scale = r.try_get::<Option<i32>, _>(10).ok().flatten();
                TableColumnInfo {
                    name: r.try_get::<String, _>(0).unwrap_or_default(),
                    data_type: full_pg_data_type(
                        &base_type,
                        char_len,
                        numeric_precision,
                        numeric_scale,
                    ),
                    nullable: r
                        .try_get::<String, _>(2)
                        .map(|s| s.eq_ignore_ascii_case("YES"))
                        .unwrap_or(false),
                    key: r.try_get::<String, _>(3).unwrap_or_default(),
                    default: r.try_get::<Option<String>, _>(4).ok().flatten(),
                    extra: r.try_get::<String, _>(5).unwrap_or_default(),
                    referenced_table: r.try_get::<Option<String>, _>(6).ok().flatten(),
                    referenced_column: r.try_get::<Option<String>, _>(7).ok().flatten(),
                }
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

    pub async fn table_sizes(&self, schema: &str) -> Result<Vec<TableSizeInfo>> {
        // pg_total_relation_size = table + all indexes + TOAST; pg_indexes_size
        // = just the indexes; pg_table_size = total minus indexes (heap + TOAST
        // + FSM/VM). These read catalog bookkeeping, not the heap, so no scan.
        // reltuples is the planner's cached estimate (-1 == never analyzed,
        // surfaced as None). relkind 'r'/'p' covers ordinary + partitioned
        // tables; views/indexes are excluded.
        let rows: Vec<PgRow> = sqlx::query(
            r#"SELECT c.relname,
                      c.reltuples::bigint,
                      pg_table_size(c.oid)::bigint,
                      pg_indexes_size(c.oid)::bigint,
                      pg_total_relation_size(c.oid)::bigint
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
                TableSizeInfo {
                    name: r.try_get::<String, _>(0).unwrap_or_default(),
                    row_estimate: (raw >= 0).then_some(raw),
                    data_bytes: r.try_get::<Option<i64>, _>(2).ok().flatten(),
                    index_bytes: r.try_get::<Option<i64>, _>(3).ok().flatten(),
                    total_bytes: r.try_get::<Option<i64>, _>(4).ok().flatten(),
                }
            })
            .collect())
    }

    pub async fn server_info(&self) -> Result<ServerInfo> {
        // current_setting('server_version') is the bare "16.2"; version() adds
        // the build banner. The short form reads better as the headline; the
        // full banner is still available as the `server_version` row below.
        let version: String = sqlx::query_scalar("SELECT current_setting('server_version')")
            .fetch_one(&self.pool)
            .await
            .unwrap_or_default();
        // pg_settings exposes every GUC as (name, setting). Read-only.
        // Secret-named settings are masked as defense-in-depth (#563).
        let rows: Vec<PgRow> = sqlx::query("SELECT name, setting FROM pg_settings ORDER BY name")
            .fetch_all(&self.pool)
            .await?;
        let variables = rows
            .into_iter()
            .map(|r| {
                let name = r.try_get::<String, _>(0).unwrap_or_default();
                let value = r
                    .try_get::<Option<String>, _>(1)
                    .ok()
                    .flatten()
                    .unwrap_or_default();
                let value = super::mask_sensitive_var(&name, value);
                ServerVariable { name, value }
            })
            .collect();
        Ok(ServerInfo { version, variables })
    }
}

/// Rebuilds a qualified type string (`character varying(50)`,
/// `numeric(10,2)`) from the bare `information_schema.columns.data_type`
/// plus the length/precision Postgres tracks in separate columns. Without
/// this, `varchar(50)` and `varchar(255)` (or `numeric(10,2)` and
/// `numeric(12,4)`) both report the same bare `data_type` and schema
/// diff/sync (db/diff.rs, db/sync.rs) can't tell them apart (#K5).
///
/// Types without a tracked length/precision (integer, text, ...) pass
/// through unchanged — `char_len` and `numeric_precision` are `NULL` in
/// `information_schema.columns` for those, so the `if let` guards simply
/// don't fire.
fn full_pg_data_type(
    base: &str,
    char_len: Option<i32>,
    numeric_precision: Option<i32>,
    numeric_scale: Option<i32>,
) -> String {
    let lower = base.to_ascii_lowercase();
    if let Some(len) = char_len {
        // Matches `character varying` / `character` / (the rarely reported)
        // `bpchar`/`varchar` spellings — all contain "char".
        if lower.contains("char") {
            return format!("{base}({len})");
        }
    }
    if let Some(precision) = numeric_precision {
        if lower == "numeric" || lower == "decimal" {
            return match numeric_scale {
                Some(scale) => format!("{base}({precision},{scale})"),
                None => format!("{base}({precision})"),
            };
        }
    }
    base.to_string()
}

/// Decides whether `sql` should run through the result-set path
/// (`fetch`/`fetch_all`) or the `execute` path that only reports
/// `rows_affected`.
///
/// Leading comments (`-- ...`, `/* ... */`) must be skipped before the
/// keyword check, or a perfectly normal `-- note\nSELECT ...` would miss the
/// prefix match and get misrouted to the execute path, silently returning an
/// empty result instead of the query's rows (#K1). `strip_sql_comments`
/// already understands PostgreSQL's dialect quirks (dollar-quoted strings,
/// nested block comments, no `#` line comments), so it doubles as the
/// leading-comment skipper here.
///
/// `WITH` (CTE) is not SELECT-only: a CTE can prefix an INSERT/UPDATE/DELETE
/// that mutates rows. Treating every `WITH` as a query hides those mutations
/// behind an empty "0 rows" grid (rows_affected always reported as 0), so we
/// inspect the statement that follows the CTE definitions via the
/// (dialect-agnostic) `with_cte_is_mutation` shared from `db::mysql` (#K2).
fn is_query_shape(sql: &str) -> bool {
    let cleaned = strip_sql_comments(sql);
    let trimmed = cleaned.trim_start().to_ascii_lowercase();
    if trimmed.starts_with("with") {
        return !super::mysql::with_cte_is_mutation(sql);
    }
    trimmed.starts_with("select")
        || trimmed.starts_with("show")
        || trimmed.starts_with("explain")
        || trimmed.starts_with("values")
        || trimmed.starts_with("table ")
}

/// Maps the driver-neutral [`SslMode`] to PostgreSQL's `PgSslMode`.
fn map_ssl_mode(mode: SslMode) -> PgSslMode {
    match mode {
        SslMode::Disable => PgSslMode::Disable,
        SslMode::Prefer => PgSslMode::Prefer,
        SslMode::Require => PgSslMode::Require,
        SslMode::VerifyCa => PgSslMode::VerifyCa,
        SslMode::VerifyFull => PgSslMode::VerifyFull,
    }
}

/// Applies the TLS settings from `opts` to the connect options. `ssl_mode` is
/// left untouched when `None` (sqlx defaults to `prefer`); empty certificate
/// paths are ignored so a blank field behaves like "unset".
fn apply_tls(mut connect: PgConnectOptions, opts: &DbConnectOptions) -> PgConnectOptions {
    if let Some(mode) = opts.ssl_mode {
        connect = connect.ssl_mode(map_ssl_mode(mode));
    }
    if let Some(ca) = non_empty(&opts.ssl_root_cert) {
        connect = connect.ssl_root_cert(ca);
    }
    if let Some(cert) = non_empty(&opts.ssl_client_cert) {
        connect = connect.ssl_client_cert(cert);
    }
    if let Some(key) = non_empty(&opts.ssl_client_key) {
        connect = connect.ssl_client_key(key);
    }
    connect
}

/// Returns the trimmed path only when it is non-empty, so a blank form field
/// (serialized as `Some("")`) is treated as unset.
fn non_empty(value: &Option<String>) -> Option<&str> {
    value.as_deref().map(str::trim).filter(|s| !s.is_empty())
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
        // rust_decimal::Decimal は有効桁数が約 28〜29 桁まで・NaN 非対応の
        // ため、範囲外の値 (`1e30::numeric` など) や `'NaN'::numeric` は
        // 上記の Decode が失敗する。何もしないと最終的に生バイナリ
        // (Value::Bytes の 16 進文字列) 表示に落ちてしまう (#K3)。
        // PostgreSQL の NUMERIC はワイヤ上つねにバイナリ形式 (基数 10000 の
        // 桁配列 + weight/scale) で送られてくるため、`String` の Decode
        // 実装 (UTF-8 テキストとして読む) では代用できない —
        // `decode_pg_numeric_fallback` でそのバイナリ表現を自前でデコード
        // し、人間可読な数値文字列を組み立てる。`raw` は関数冒頭で取得済み
        // (かつ非 NULL であることも確認済み) なので使い回す。
        if let Some(s) = decode_pg_numeric_fallback(&raw) {
            return Value::String(s);
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
    decode_string_or_bytes(row, i)
}

/// Decodes a NUMERIC cell's raw wire value into a human-readable decimal
/// string, without going through `rust_decimal::Decimal` (whose ~28-29
/// significant digit / no-NaN limitation is exactly what this fallback exists
/// to work around; see the `rust_decimal::Decimal` branch in [`decode_cell`]).
///
/// sqlx-postgres always negotiates the **binary** result format for typed
/// columns (see `PgValueFormat::Binary`), so NUMERIC arrives as Postgres's
/// wire representation: a big-endian `u16` digit count, `i16` weight, `u16`
/// sign, `i16` display scale, followed by that many `u16` base-10000 digits
/// (each `0..=9999`). This mirrors `numeric_out`'s formatting logic closely
/// enough to render any finite value (arbitrary precision) or `NaN`, without
/// requiring sqlx's private `PgNumeric` type or adding a new dependency.
///
/// Text-format values (`PgValueFormat::Text`) are already the exact decimal
/// text Postgres would print, so they're returned as-is.
///
/// Returns `None` if the payload is malformed (too short / truncated digit
/// array) rather than panicking — this is a best-effort fallback, and `None`
/// simply means the caller keeps falling through to the raw-bytes display.
fn decode_pg_numeric_fallback(raw: &PgValueRef<'_>) -> Option<String> {
    if raw.format() != PgValueFormat::Binary {
        return raw.as_str().ok().map(str::to_string);
    }
    numeric_binary_to_string(raw.as_bytes().ok()?)
}

/// Pure decode of Postgres's `NUMERIC` binary wire payload into a decimal
/// string. Split out from [`decode_pg_numeric_fallback`] so the digit-group
/// arithmetic can be unit-tested directly against hand-built byte arrays
/// without needing a live connection (`PgValueRef` can't be constructed
/// outside sqlx-postgres).
fn numeric_binary_to_string(bytes: &[u8]) -> Option<String> {
    if bytes.len() < 8 {
        return None;
    }
    let num_digits = u16::from_be_bytes([bytes[0], bytes[1]]) as usize;
    let weight = i16::from_be_bytes([bytes[2], bytes[3]]) as i32;
    let sign = u16::from_be_bytes([bytes[4], bytes[5]]);
    let scale = i16::from_be_bytes([bytes[6], bytes[7]]).max(0) as usize;
    const SIGN_NEGATIVE: u16 = 0x4000;
    const SIGN_NAN: u16 = 0xC000;
    if sign == SIGN_NAN {
        return Some("NaN".to_string());
    }
    if bytes.len() < 8 + num_digits * 2 {
        return None;
    }
    let digits: Vec<u16> = (0..num_digits)
        .map(|d| {
            let off = 8 + d * 2;
            u16::from_be_bytes([bytes[off], bytes[off + 1]])
        })
        .collect();

    let mut out = String::new();
    if sign == SIGN_NEGATIVE {
        out.push('-');
    }
    // `int_groups` base-10000 groups sit left of the decimal point (positions
    // `weight` down to `0`); missing low-order groups (num_digits ran out)
    // are zero. `int_groups <= 0` means the value's magnitude is < 1.
    let int_groups = weight + 1;
    if int_groups <= 0 {
        out.push('0');
    } else {
        for g in 0..int_groups {
            let d = digits.get(g as usize).copied().unwrap_or(0);
            if g == 0 {
                out.push_str(&d.to_string());
            } else {
                out.push_str(&format!("{d:04}"));
            }
        }
    }
    if scale > 0 {
        out.push('.');
        let frac_groups = scale.div_ceil(4);
        let mut frac = String::with_capacity(frac_groups * 4);
        for g in 0..frac_groups {
            let group_index = int_groups + g as i32;
            let d = if group_index >= 0 {
                digits.get(group_index as usize).copied().unwrap_or(0)
            } else {
                0
            };
            frac.push_str(&format!("{d:04}"));
        }
        frac.truncate(scale);
        out.push_str(&frac);
    }
    Some(out)
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
/// 実装は方言共通の `sync::quote_ident` に一本化している (`fn(&str) -> String`
/// のシグネチャは `pk_order_clause` 等へ関数ポインタとして渡すため維持)。
fn pg_quote_ident(name: &str) -> String {
    super::sync::quote_ident(super::DriverKind::Postgres, name)
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
    fn maps_ssl_mode_to_pg_equivalents() {
        assert!(matches!(map_ssl_mode(SslMode::Disable), PgSslMode::Disable));
        assert!(matches!(map_ssl_mode(SslMode::Prefer), PgSslMode::Prefer));
        assert!(matches!(map_ssl_mode(SslMode::Require), PgSslMode::Require));
        assert!(matches!(
            map_ssl_mode(SslMode::VerifyCa),
            PgSslMode::VerifyCa
        ));
        assert!(matches!(
            map_ssl_mode(SslMode::VerifyFull),
            PgSslMode::VerifyFull
        ));
    }

    #[test]
    fn apply_tls_treats_blank_cert_paths_as_unset() {
        // A blank form field arrives as `Some("")`; it must not be passed to
        // sqlx as a real path (which would fail to open). `non_empty` filters it.
        assert_eq!(non_empty(&Some("  ".to_string())), None);
        assert_eq!(
            non_empty(&Some("/tmp/ca.pem".to_string())),
            Some("/tmp/ca.pem")
        );
        assert_eq!(non_empty(&None), None);
    }

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

    #[test]
    fn query_shape_recognises_plain_selects() {
        assert!(is_query_shape("SELECT * FROM users"));
        assert!(is_query_shape("  show all"));
        assert!(is_query_shape("EXPLAIN SELECT 1"));
        assert!(is_query_shape("VALUES (1), (2)"));
        assert!(is_query_shape("TABLE users"));
    }

    #[test]
    fn query_shape_treats_plain_dml_as_execute() {
        assert!(!is_query_shape("INSERT INTO t VALUES (1)"));
        assert!(!is_query_shape("UPDATE t SET x = 1"));
        assert!(!is_query_shape("DELETE FROM t WHERE id = 1"));
    }

    #[test]
    fn query_shape_skips_leading_comments() {
        // #K1: a leading comment must not hide the real keyword and get the
        // statement misrouted to the execute path (which would silently
        // return an empty result instead of the SELECT's rows).
        assert!(is_query_shape("-- monthly report\nSELECT * FROM orders"));
        assert!(is_query_shape("/* hint */ SELECT 1"));
        assert!(is_query_shape("  /* a */ -- b\n  SHOW all"));
        // Postgres has no `#` line comment — it must NOT be skipped as one,
        // so a statement genuinely starting with `#` falls through to the
        // (correct) execute path rather than being misread as a comment.
        assert!(!is_query_shape("# not a comment\nSELECT 1"));
        // Leading comment before a CTE-prefixed mutation still routes to execute.
        assert!(!is_query_shape(
            "-- delete dups\nWITH c AS (SELECT 1) DELETE FROM t"
        ));
        assert!(!is_query_shape("/* c */ INSERT INTO t VALUES (1)"));
    }

    #[test]
    fn query_shape_keeps_with_select_as_query() {
        assert!(is_query_shape(
            "WITH cte AS (SELECT 1 AS n) SELECT * FROM cte"
        ));
    }

    #[test]
    fn query_shape_routes_with_dml_to_execute() {
        // #K2: CTE-prefixed DML must report rows_affected via the execute
        // path, not silently show an empty result grid.
        assert!(!is_query_shape(
            "WITH ranked AS (SELECT id FROM orders) DELETE FROM orders WHERE id IN (SELECT id FROM ranked)"
        ));
        assert!(!is_query_shape(
            "WITH src AS (SELECT 1 AS id) INSERT INTO t SELECT * FROM src"
        ));
        assert!(!is_query_shape(
            "WITH c AS (SELECT 1) UPDATE t SET x = 1 WHERE id IN (SELECT * FROM c)"
        ));
    }

    #[test]
    fn full_data_type_appends_varchar_length() {
        assert_eq!(
            full_pg_data_type("character varying", Some(50), None, None),
            "character varying(50)"
        );
        assert_eq!(
            full_pg_data_type("character", Some(10), None, None),
            "character(10)"
        );
    }

    #[test]
    fn full_data_type_appends_numeric_precision_scale() {
        assert_eq!(
            full_pg_data_type("numeric", None, Some(10), Some(2)),
            "numeric(10,2)"
        );
        // Precision without a scale (e.g. `numeric(10)`) still renders.
        assert_eq!(
            full_pg_data_type("numeric", None, Some(10), None),
            "numeric(10)"
        );
    }

    #[test]
    fn full_data_type_passes_through_lengthless_types() {
        // Unconstrained `numeric` / `varchar` (no length tracked in
        // information_schema) and ordinary types like `integer`/`text` must
        // be returned unchanged.
        assert_eq!(full_pg_data_type("integer", None, None, None), "integer");
        assert_eq!(full_pg_data_type("text", None, None, None), "text");
        assert_eq!(full_pg_data_type("numeric", None, None, None), "numeric");
        assert_eq!(
            full_pg_data_type("character varying", None, None, None),
            "character varying"
        );
    }

    /// Builds a Postgres `NUMERIC` binary wire payload from its logical
    /// fields, for feeding into `numeric_binary_to_string` in tests (the
    /// inverse of the decode this function under test performs).
    fn encode_numeric(sign: u16, weight: i16, scale: i16, digits: &[u16]) -> Vec<u8> {
        let mut buf = Vec::with_capacity(8 + digits.len() * 2);
        buf.extend_from_slice(&(digits.len() as u16).to_be_bytes());
        buf.extend_from_slice(&weight.to_be_bytes());
        buf.extend_from_slice(&sign.to_be_bytes());
        buf.extend_from_slice(&scale.to_be_bytes());
        for d in digits {
            buf.extend_from_slice(&d.to_be_bytes());
        }
        buf
    }

    #[test]
    fn numeric_fallback_decodes_nan() {
        // sign = 0xC000 (NaN); num_digits/weight/scale are irrelevant.
        let bytes = encode_numeric(0xC000, 0, 0, &[]);
        assert_eq!(numeric_binary_to_string(&bytes), Some("NaN".to_string()));
    }

    #[test]
    fn numeric_fallback_decodes_zero() {
        let bytes = encode_numeric(0x0000, 0, 0, &[]);
        assert_eq!(numeric_binary_to_string(&bytes), Some("0".to_string()));
    }

    #[test]
    fn numeric_fallback_decodes_plain_integer() {
        // 12345 = 1 * 10000 + 2345 → digits [1, 2345], weight 1.
        let bytes = encode_numeric(0x0000, 1, 0, &[1, 2345]);
        assert_eq!(numeric_binary_to_string(&bytes), Some("12345".to_string()));
    }

    #[test]
    fn numeric_fallback_decodes_fraction() {
        // 123.45 → integer group [123] at weight 0, fraction group [4500]
        // (0.45 * 10000).
        let bytes = encode_numeric(0x0000, 0, 2, &[123, 4500]);
        assert_eq!(numeric_binary_to_string(&bytes), Some("123.45".to_string()));
    }

    #[test]
    fn numeric_fallback_decodes_negative() {
        let bytes = encode_numeric(0x4000, 0, 2, &[123, 4500]);
        assert_eq!(
            numeric_binary_to_string(&bytes),
            Some("-123.45".to_string())
        );
    }

    #[test]
    fn numeric_fallback_decodes_small_fraction_with_leading_zero_group() {
        // 0.001 → weight -1 (first group represents the tenths-of-thousandths
        // slot), digit [10] (0.001 * 10000).
        let bytes = encode_numeric(0x0000, -1, 3, &[10]);
        assert_eq!(numeric_binary_to_string(&bytes), Some("0.001".to_string()));
    }

    #[test]
    fn numeric_fallback_handles_out_of_rust_decimal_range_value() {
        // A value with far more digits than rust_decimal::Decimal's ~28-29
        // significant digit ceiling — this is exactly the case that used to
        // fall through to a raw-bytes (Value::Bytes) display (#K3). Encodes
        // 12 base-10000 groups (~48 decimal digits) of nines, all in the
        // integer part.
        let digits = vec![9999u16; 12];
        let bytes = encode_numeric(0x0000, 11, 0, &digits);
        let expected = "9999".repeat(12);
        assert_eq!(numeric_binary_to_string(&bytes), Some(expected));
    }

    #[test]
    fn numeric_fallback_rejects_truncated_payload() {
        assert_eq!(numeric_binary_to_string(&[0, 0, 0]), None);
        // Declares 2 digits but only provides 1 — must not panic on the
        // out-of-bounds slice access, just report failure.
        let mut bytes = encode_numeric(0x0000, 1, 0, &[1, 2345]);
        bytes.truncate(bytes.len() - 2);
        assert_eq!(numeric_binary_to_string(&bytes), None);
    }
}
