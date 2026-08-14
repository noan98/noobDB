use std::time::Instant;

use futures_util::StreamExt;
use sqlx::postgres::{
    PgConnectOptions, PgPool, PgPoolOptions, PgRow, PgSslMode, PgValueFormat, PgValueRef,
};
use sqlx::{Acquire, Column as _, Row, TypeInfo, ValueRef};

use super::advisor::{UnusedIndexEntry, UnusedIndexStats};
use super::types::{
    Column, DbUserInfo, ForeignKey, IndexInfo, LiveQuery, PreviewResult, ProcessInfo, QueryResult,
    QueryStatsSupport, SchemaObject, ServerInfo, ServerMetrics, ServerVariable, StatementStat,
    StreamBatch, TableColumnInfo, TablePrivilegeRow, TableRowEstimate, TableRowIdentity,
    TableSchema, TableSizeInfo, UserPrivileges, Value,
};
use super::{columns_of, init_sql_of, DbConnectOptions, SslMode};
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

    /// ドライランプレビュー: 文をトランザクション内で実行し、対象テーブルの
    /// before/after スナップショットを添えて必ずロールバックする。
    ///
    /// 対象テーブルに主キーがあるときは、MySQL 側と同じ戦略を取る
    /// (共有ロジックは `db::preview`):
    ///
    /// * BEFORE はユーザの `WHERE` 句で絞る。これが無いと BEFORE は「PK 昇順の
    ///   先頭 N 件」でしかなく、更新対象がその窓の外にあると before/after が
    ///   同一になり、実際には書き換わっているのに差分が「変更なし」に見える。
    /// * AFTER は BEFORE で捕まえた PK で取り直す。`… SET flag=0 WHERE flag=1`
    ///   のように WHERE が実行後に一致しなくなるケースでも、両ペインが行単位で
    ///   揃う。
    ///
    /// INSERT は新規行が BEFORE に居ないため PK アンカーを使わず、従来どおり
    /// 固定窓を撮り直す。
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
        if super::has_stacked_statements_for(super::DriverKind::Postgres, sql) {
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

        let order_clause = super::pk_order_clause(&primary_key, pg_quote_ident);
        // ユーザの WHERE を BEFORE へ反映する (PK が判っている UPDATE/DELETE の
        // ときだけ。`UPDATE … FROM other` のように単独 SELECT として成立しない
        // 形は共有ロジック側が弾いて従来の固定窓へ縮退する)。
        let where_clause =
            super::preview::before_where_clause(sql, super::SqlFlavor::Postgres, &primary_key);
        // PostgreSQL の UPDATE/DELETE は ORDER BY / LIMIT を取れないので、
        // 切り出した句と自前の ORDER BY / LIMIT が衝突することはない — MySQL と
        // 違ってフィルタ時も上限を SQL 側で掛けられる。
        let before_sql = target.as_ref().map(|t| {
            super::preview::build_snapshot_sql(
                t,
                where_clause.as_deref(),
                &order_clause,
                Some(row_limit + 1),
            )
        });

        let mut tx = conn.begin().await?;
        let started = Instant::now();

        let before_raw: Vec<PgRow> = match &before_sql {
            Some(q) => fetch_capped_pg(&mut tx, q, row_limit + 1).await?,
            None => Vec::new(),
        };

        // BEFORE の行レイアウト上での PK 列の位置。AFTER を PK で取り直すのに
        // 使う (フロントの before/after ペアリングにも同じ PK が渡る)。
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
        // 全ての PK 列を特定できたときだけ PK アンカーを使う。
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

        // INSERT は新しい行が BEFORE の PK に含まれないので、アンカーせず
        // 固定窓を撮り直す (そうしないと挿入行が AFTER に出てこない)。
        let is_insert = trimmed.starts_with("insert");
        let after_by_pk = if is_insert {
            None
        } else {
            target.as_ref().and_then(|t| {
                super::preview::build_after_by_pk_sql(
                    t,
                    &primary_key,
                    &captured_pks
                        .iter()
                        .map(|row| row.iter().map(pk_literal).collect())
                        .collect::<Vec<Vec<String>>>(),
                    &order_clause,
                    pg_quote_ident,
                )
            })
        };
        // PK アンカーが組めなければ BEFORE と同じクエリを撮り直す (従来動作)。
        let after_raw: Vec<PgRow> = match after_by_pk.as_ref().or(before_sql.as_ref()) {
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

    /// Auto-commit insert of one chunk (no wrapping transaction). See
    /// [`Connection::try_insert_chunk`] (#687).
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
        let sql = build_pg_insert(table, columns, rows);
        let mut conn = self.pool.acquire().await?;
        apply_search_path(&mut conn, database).await?;
        sqlx::Executor::execute(
            &mut *conn,
            sqlx::raw_sql("SET standard_conforming_strings = on"),
        )
        .await?;
        sqlx::query(sqlx::AssertSqlSafe(sql))
            .execute(&mut *conn)
            .await?;
        Ok(())
    }

    /// Row-by-row probe inside a rolled-back transaction to find the first
    /// rejected row. See [`Connection::probe_failing_row`] (#687).
    pub(crate) async fn probe_failing_row(
        &self,
        database: Option<&str>,
        table: &str,
        columns: &[String],
        rows: &[Vec<Option<String>>],
    ) -> Result<Option<(usize, String)>> {
        let mut conn = self.pool.acquire().await?;
        apply_search_path(&mut conn, database).await?;
        sqlx::Executor::execute(
            &mut *conn,
            sqlx::raw_sql("SET standard_conforming_strings = on"),
        )
        .await?;
        let mut tx = conn.begin().await?;
        for (i, row) in rows.iter().enumerate() {
            let sql = build_pg_insert(table, columns, std::slice::from_ref(row));
            if let Err(e) = sqlx::query(sqlx::AssertSqlSafe(sql))
                .execute(&mut *tx)
                .await
            {
                return Ok(Some((i, e.to_string())));
            }
        }
        Ok(None)
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

    /// Roles for the users & permissions panel (#732), read from `pg_roles`
    /// (+ `pg_auth_members` for role membership). PostgreSQL roles have no
    /// host component — they are cluster-wide.
    pub async fn list_db_users(&self) -> Result<Vec<DbUserInfo>> {
        let rows: Vec<PgRow> = sqlx::query(
            "SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolcanlogin, \
             rolreplication, rolbypassrls \
             FROM pg_catalog.pg_roles ORDER BY rolname",
        )
        .fetch_all(&self.pool)
        .await?;
        let mut users = Vec::with_capacity(rows.len());
        for r in rows {
            let name: String = r.try_get(0).unwrap_or_default();
            let is_super: bool = r.try_get(1).unwrap_or(false);
            let createdb: bool = r.try_get(2).unwrap_or(false);
            let createrole: bool = r.try_get(3).unwrap_or(false);
            let can_login: bool = r.try_get(4).unwrap_or(false);
            let replication: bool = r.try_get(5).unwrap_or(false);
            let bypassrls: bool = r.try_get(6).unwrap_or(false);
            let mut attributes = Vec::new();
            if is_super {
                attributes.push("SUPERUSER".to_string());
            }
            if createdb {
                attributes.push("CREATEDB".to_string());
            }
            if createrole {
                attributes.push("CREATEROLE".to_string());
            }
            if can_login {
                attributes.push("LOGIN".to_string());
            }
            if replication {
                attributes.push("REPLICATION".to_string());
            }
            if bypassrls {
                attributes.push("BYPASSRLS".to_string());
            }
            // Membership is a second round trip per role; the roster is
            // server accounts (not app data), so this N+1 pattern stays
            // cheap in practice.
            let member_of: Vec<String> = sqlx::query_scalar(
                "SELECT r2.rolname FROM pg_auth_members m \
                 JOIN pg_roles r1 ON m.member = r1.oid \
                 JOIN pg_roles r2 ON m.roleid = r2.oid \
                 WHERE r1.rolname = $1 ORDER BY r2.rolname",
            )
            .bind(&name)
            .fetch_all(&self.pool)
            .await
            .unwrap_or_default();
            users.push(DbUserInfo {
                name,
                host: None,
                attributes,
                member_of,
                is_superuser: is_super,
                can_login,
            });
        }
        Ok(users)
    }

    /// The privilege matrix for one PostgreSQL role, read from
    /// `information_schema.role_table_grants` (`grantee` matches the role;
    /// the standard view already resolves membership-derived grants, not
    /// just directly-owned ones). PostgreSQL has no database-wide "global"
    /// grant equivalent to MySQL's `mysql.user` columns — `CREATE`/`ALTER`/
    /// `DROP TABLE` are governed by schema ownership/`CREATE` privilege, not
    /// per-table `GRANT` — so `global` is always `None` here.
    pub async fn user_privileges(&self, user: &str, _host: Option<&str>) -> Result<UserPrivileges> {
        let rows: Vec<PgRow> = sqlx::query(
            "SELECT table_schema, table_name, privilege_type \
             FROM information_schema.role_table_grants \
             WHERE grantee = $1 ORDER BY table_schema, table_name",
        )
        .bind(user)
        .fetch_all(&self.pool)
        .await?;
        let mut map: std::collections::BTreeMap<String, TablePrivilegeRow> =
            std::collections::BTreeMap::new();
        for r in rows {
            let schema: String = r.try_get(0).unwrap_or_default();
            let table: String = r.try_get(1).unwrap_or_default();
            let priv_type: String = r.try_get(2).unwrap_or_default();
            let key = format!("{schema}.{table}");
            let entry = map.entry(key.clone()).or_insert_with(|| TablePrivilegeRow {
                table: key,
                select: false,
                insert: false,
                update: false,
                delete: false,
                ddl: false,
            });
            match priv_type.as_str() {
                "SELECT" => entry.select = true,
                "INSERT" => entry.insert = true,
                "UPDATE" => entry.update = true,
                "DELETE" => entry.delete = true,
                "TRUNCATE" | "REFERENCES" | "TRIGGER" => entry.ddl = true,
                _ => {}
            }
        }
        Ok(UserPrivileges {
            global: None,
            tables: map.into_values().collect(),
        })
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

    /// スキーマ健全性アドバイザ (#741) の未使用インデックス統計。
    /// `pg_stat_user_indexes.idx_scan = 0` = 統計リセット以降スキャンされて
    /// いないインデックス。統計コレクタは既定で有効なので通常は常に読める
    /// (読めなければ理由コード付きで縮退)。PRIMARY/UNIQUE の除外は純ロジック側が
    /// 担うためここではそのまま返す。読み取りのみ。
    pub async fn unused_indexes(&self, schema: &str) -> Result<UnusedIndexStats> {
        let rows: Vec<PgRow> = match sqlx::query(
            r#"SELECT relname, indexrelname
               FROM pg_stat_user_indexes
               WHERE schemaname = $1 AND idx_scan = 0
               ORDER BY relname, indexrelname"#,
        )
        .bind(schema)
        .fetch_all(&self.pool)
        .await
        {
            Ok(rows) => rows,
            Err(_) => {
                return Ok(UnusedIndexStats {
                    supported: false,
                    reason: Some("stats_unreadable".into()),
                    entries: Vec::new(),
                });
            }
        };
        let entries = rows
            .iter()
            .filter_map(|r| {
                let table = r.try_get::<String, _>("relname").ok()?;
                let index = r.try_get::<String, _>("indexrelname").ok()?;
                Some(UnusedIndexEntry { table, index })
            })
            .collect();
        Ok(UnusedIndexStats {
            supported: true,
            reason: None,
            entries,
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
                 AND query NOT ILIKE '%pg\_stat\_%'
                 AND query NOT ILIKE '%pg\_catalog%'
                 AND query NOT ILIKE '%information\_schema%'
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
                 AND s.query NOT ILIKE '%pg\_stat\_%'
                 AND s.query NOT ILIKE '%pg\_catalog%'
                 AND s.query NOT ILIKE '%information\_schema%'
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

    /// Row identity strategy for inline editing (#849). Once a table has no
    /// resolvable primary key, PostgreSQL ordinary heap tables (`pg_class.
    /// relkind = 'r'`) still carry a physical `ctid` that can pin a single
    /// row within one Preview/Apply round trip. Views, foreign tables, and
    /// partitioned parents (`p` — no storage of their own; `ctid` lives on
    /// the child partitions) don't, so those fall back to `all_columns`.
    pub async fn row_identity(&self, schema: &str, table: &str) -> Result<TableRowIdentity> {
        let cols = self.columns(schema, table).await?;
        if let Some(identity) = super::row_identity_pk_or_none(&cols) {
            return Ok(identity);
        }
        // `pg_class.relkind` は text ではなく内部型 `"char"` (1 バイト、OID 18) で、
        // sqlx はこれを String へデコードできない。`::text` へ明示的にキャストして
        // おかないと `try_get::<String, _>` が必ず失敗し、下の `unwrap_or_default()`
        // が空文字を返して通常のヒープテーブルまで `all_columns` に落ちてしまう。
        let row: Option<PgRow> = sqlx::query(
            r#"SELECT c.relkind::text AS relkind
               FROM pg_catalog.pg_class c
               JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname = $1 AND c.relname = $2"#,
        )
        .bind(schema)
        .bind(table)
        .fetch_optional(&self.pool)
        .await?;
        if let Some(r) = row {
            let relkind = r.try_get::<String, _>("relkind").unwrap_or_default();
            if relkind == "r" {
                return Ok(TableRowIdentity {
                    strategy: "ctid".into(),
                    hidden_column: Some("ctid".into()),
                });
            }
        }
        Ok(TableRowIdentity {
            strategy: "all_columns".into(),
            hidden_column: None,
        })
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

    /// 監視ダッシュボード (#731) 用の 1 サンプル。`pg_stat_activity` の状態別集計
    /// (接続数 / active / idle in transaction / ロック待ち) と `pg_stat_database` の
    /// トランザクション累計を読む。いずれもメモリ上のビューで安価。非スーパーユーザ
    /// でも state / wait_event は全バックエンド分見える (query 本文だけが権限で
    /// マスクされる) ため件数集計は degrade しない。集計クエリ自体が失敗した場合は
    /// 該当フィールドのみ `None` に縮退させ、全体は失敗させない。
    pub async fn server_metrics(&self) -> Result<ServerMetrics> {
        // 接続状態の集計は 1 行で受ける。FILTER 集計なので追加の GROUP BY は不要。
        // ロック待ちは client backend に限らず全バックエンドの wait_event_type='Lock'。
        let activity = sqlx::query(
            r#"SELECT
                 count(*) FILTER (WHERE backend_type = 'client backend')::bigint AS connections,
                 count(*) FILTER (WHERE backend_type = 'client backend' AND state = 'active')::bigint AS active,
                 count(*) FILTER (WHERE backend_type = 'client backend' AND state LIKE 'idle in transaction%')::bigint AS idle_in_tx,
                 count(*) FILTER (WHERE wait_event_type = 'Lock')::bigint AS lock_waiting
               FROM pg_stat_activity"#,
        )
        .fetch_one(&self.pool)
        .await;
        let (connections, active, idle_in_transaction, lock_waiting) = match activity {
            Ok(r) => (
                r.try_get::<i64, _>(0).ok(),
                r.try_get::<i64, _>(1).ok(),
                r.try_get::<i64, _>(2).ok(),
                r.try_get::<i64, _>(3).ok(),
            ),
            // 権限やバージョン差で読めないときは接続系メトリクスのみ縮退する。
            Err(_) => (None, None, None, None),
        };
        // スループット: 全 DB のトランザクション数 (commit + rollback) の累積和。
        // MySQL の Questions とは意味が異なる (トランザクション vs ステートメント)
        // ため、フロントは TPS としてラベル表示する。
        let questions = sqlx::query_scalar::<_, Option<i64>>(
            "SELECT sum(xact_commit + xact_rollback)::bigint FROM pg_stat_database",
        )
        .fetch_one(&self.pool)
        .await
        .ok()
        .flatten();
        Ok(ServerMetrics {
            connections,
            active,
            idle_in_transaction,
            lock_waiting,
            questions,
            // PostgreSQL には MySQL の Slow_queries / Innodb_row_lock_waits に相当する
            // 安価な常設カウンタが無い (待ち数は lock_waiting ゲージで見る)。
            slow_queries: None,
            lock_waits: None,
        })
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
    // sqlx-postgres は prepared statement 経路ではバイナリ形式を要求するが、
    // simple query (`raw_sql`) 経路ではテキスト形式で届く。ワイヤ表現を自前で
    // 読む分岐はバイナリのときだけ有効。
    let binary_format = raw.format() == PgValueFormat::Binary;

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
            // int8 は 2^53 を超えうる。`Value` は `#[serde(untagged)]` なので
            // そのまま `Value::Int` にすると JSON の素の数値として送られ、
            // フロントの `JSON.parse` で丸められて**別の値**になる (表示だけで
            // なく、インラインセル編集が組み立てる `WHERE pk = …` まで狂う)。
            // 安全整数の外は十進文字列へ退避する。
            return v.map(Value::from_i64_lossless).unwrap_or(Value::Null);
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
        // サーバが返した JSON テキストを**そのまま**返す。`serde_json::Value`
        // へパースして `to_string()` で組み直すと、`preserve_order` 無効の
        // 既定では `Map` が `BTreeMap` になりオブジェクトのキーが辞書順へ
        // 並べ替えられてしまう (`{"b":1,"a":2}` → `{"a":2,"b":1}`)。
        // `preserve_order` の有効化はエクスポートのゴールデン (JSON のキーは
        // UTF-8 バイト順、という前提) を壊すので、こちら側で再シリアライズを
        // やめる方向で直す。
        //
        // ワイヤ表現: `json` は素の UTF-8 テキスト、`jsonb` はバイナリ形式の
        // とき先頭 1 バイトのバージョン (現行 `0x01`) の後ろが UTF-8 テキスト。
        // 妥当な UTF-8 として読めない / 未知バージョンのときだけ従来の
        // パース経路へフォールバックする。
        if let Ok(bytes) = raw.as_bytes() {
            let strip_version = binary_format && ti(type_name, &["JSONB"]);
            if let Some(text) = json_wire_text(bytes, strip_version) {
                return Value::String(text);
            }
        }
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

    // --- ここから下は「sqlx の型互換チェックでは文字列として読めない型」を
    // 明示的に処理する分岐。最終フォールバックの
    // `try_get_unchecked::<Option<String>>` はバイナリ表現がたまたま妥当な
    // UTF-8 だとゴミ文字列を返しうるので、ワイヤ表現が判っている型は先に
    // 自前で整形してしまう。整形に失敗した (長さが想定と違う等) ときは panic
    // せず素通しし、下の一般フォールバックに任せる。
    //
    // バイナリ形式のときだけ自前デコードを試す — テキスト形式 (simple query
    // 経路) で届いた値はサーバが既に人間可読な表現にしているので、そのまま
    // 一般フォールバックが文字列として読むのが正しい。
    if binary_format {
        if ti(type_name, &["UUID"]) {
            if let Ok(b) = raw.as_bytes() {
                if let Some(s) = format_uuid(b) {
                    return Value::String(s);
                }
            }
        }
        if ti(type_name, &["INET", "CIDR"]) {
            if let Ok(b) = raw.as_bytes() {
                if let Some(s) = format_inet(b) {
                    return Value::String(s);
                }
            }
        }
        if ti(type_name, &["MACADDR", "MACADDR8"]) {
            if let Ok(b) = raw.as_bytes() {
                if let Some(s) = format_macaddr(b) {
                    return Value::String(s);
                }
            }
        }
        if ti(type_name, &["MONEY"]) {
            if let Ok(b) = raw.as_bytes() {
                if let Some(s) = format_money(b) {
                    return Value::String(s);
                }
            }
        }
        if ti(type_name, &["INTERVAL"]) {
            if let Ok(b) = raw.as_bytes() {
                if let Some(s) = format_interval(b) {
                    return Value::String(s);
                }
            }
        }
        if ti(type_name, &["BIT", "VARBIT"]) {
            if let Ok(b) = raw.as_bytes() {
                if let Some(s) = format_bit_string(b) {
                    return Value::String(s);
                }
            }
        }
        // カタログ列でよく出る 32bit 識別子 (符号なし 4 バイト)。sqlx は
        // `u32` を Postgres 型へマップしないため自前で読む。
        if ti(type_name, &["OID", "XID", "CID"]) {
            if let Ok(b) = raw.as_bytes() {
                if let Ok(arr) = <[u8; 4]>::try_from(b) {
                    return Value::Int(u32::from_be_bytes(arr) as i64);
                }
            }
        }
        // `tid` = 物理行位置。インラインセル編集の ctid フォールバック (#849)
        // が `SELECT ctid, …` で持ち帰る値そのものなので、`(block,offset)` の
        // テキスト表現に整形して往復できるようにする (従来はここが Null に
        // なっており、ctid を WHERE に組み立て直せなかった)。
        if ti(type_name, &["TID"]) {
            if let Ok(b) = raw.as_bytes() {
                if let Some(s) = format_tid(b) {
                    return Value::String(s);
                }
            }
        }
    }
    // 配列型 (`text[]` / `int4[]` …) は sqlx の `Vec<Option<T>>` デコードに
    // 任せられる (テキスト/バイナリ両形式に対応済み) ので形式を問わず試す。
    if is_array_type_name(type_name) {
        if let Some(s) = decode_array(row, i) {
            return Value::String(s);
        }
    }

    // 最終フォールバック。**非 NULL の値が `Value::Null` へ落ちる経路を作らない**
    // ことが眼目 (`db::decode_string_or_bytes` は型互換チェック付きの
    // `try_get` を使うため、TEXT 系と BYTEA 以外はすべて失敗して Null になって
    // いた — ENUM / ドメイン型 / citext / xml などの実データが黙って消え、
    // Diff/Sync が「両側 Null = 差分なし」と誤判定していた)。
    decode_unchecked_text_or_bytes(row, i)
}

/// 型互換チェックを飛ばして「まずテキスト、駄目なら生バイト」で読む最終
/// フォールバック。`try_get_unchecked` は sqlx の `compatible` 判定を通さない
/// ので、テキストで届く ENUM / ドメイン型 / citext / xml などがそのまま読める。
///
/// `Value::Null` を返すのは**本当に SQL NULL のときだけ**。呼び出し元
/// ([`decode_cell`]) が先に `raw.is_null()` を確認しているため、実際には
/// ここで `Null` になることはない (防御的に残してある)。
fn decode_unchecked_text_or_bytes(row: &PgRow, i: usize) -> Value {
    match row.try_get_unchecked::<Option<String>, _>(i) {
        Ok(Some(s)) => Value::String(s),
        Ok(None) => Value::Null,
        Err(_) => match row.try_get_unchecked::<Option<Vec<u8>>, _>(i) {
            Ok(Some(b)) => Value::Bytes(data_encoding::HEXLOWER.encode(&b)),
            _ => Value::Null,
        },
    }
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

/// `json` / `jsonb` のワイヤ表現を、サーバが返したままの JSON テキストとして
/// 取り出す。`strip_version` はバイナリ形式の `jsonb` のとき true で、先頭
/// 1 バイトのバージョン (現行は `0x01`) を落とす。未知バージョン・非 UTF-8 は
/// `None` (呼び出し側は従来のパース経路へ)。
fn json_wire_text(bytes: &[u8], strip_version: bool) -> Option<String> {
    let body = if strip_version {
        match bytes.split_first() {
            Some((1, rest)) => rest,
            _ => return None,
        }
    } else {
        bytes
    };
    std::str::from_utf8(body).ok().map(str::to_string)
}

/// `uuid` のバイナリ表現 (16 バイト) を `8-4-4-4-12` のハイフン付き小文字
/// 16 進へ整形する。長さが違えば `None`。
fn format_uuid(bytes: &[u8]) -> Option<String> {
    if bytes.len() != 16 {
        return None;
    }
    let hex = data_encoding::HEXLOWER.encode(bytes);
    let mut out = String::with_capacity(36);
    for (idx, c) in hex.chars().enumerate() {
        if matches!(idx, 8 | 12 | 16 | 20) {
            out.push('-');
        }
        out.push(c);
    }
    Some(out)
}

/// `inet` / `cidr` のバイナリ表現をテキストへ整形する。
///
/// レイアウトは `family, bits, is_cidr, addr_len, アドレス本体` の 4 バイト
/// ヘッダ + 本体。family は PostgreSQL 内部の値で IPv4 = 2 (`PGSQL_AF_INET`)、
/// IPv6 = 3 (`PGSQL_AF_INET6`)。アドレスの文字列化は標準ライブラリの
/// [`std::net::Ipv4Addr`] / [`std::net::Ipv6Addr`] に任せる (IPv6 の `::`
/// 短縮も PostgreSQL の出力と同じ規則なので、新しい依存を足す必要は無い)。
///
/// マスク長は `cidr` では常に、`inet` ではホストマスク (32 / 128) 以外のときに
/// 付ける — `inet_out` / `cidr_out` と同じ振る舞い。
fn format_inet(bytes: &[u8]) -> Option<String> {
    let family = *bytes.first()?;
    let bits = *bytes.get(1)?;
    let is_cidr = *bytes.get(2)?;
    let addr_len = *bytes.get(3)? as usize;
    let addr = bytes.get(4..4 + addr_len)?;
    let (text, max_bits) = match (family, addr_len) {
        (2, 4) => {
            let octets: [u8; 4] = addr.try_into().ok()?;
            (std::net::Ipv4Addr::from(octets).to_string(), 32u8)
        }
        (3, 16) => {
            let octets: [u8; 16] = addr.try_into().ok()?;
            (std::net::Ipv6Addr::from(octets).to_string(), 128u8)
        }
        _ => return None,
    };
    if is_cidr != 0 || bits != max_bits {
        Some(format!("{}/{}", text, bits))
    } else {
        Some(text)
    }
}

/// `macaddr` (6 バイト) / `macaddr8` (8 バイト) をコロン区切りの小文字
/// 16 進へ整形する。
fn format_macaddr(bytes: &[u8]) -> Option<String> {
    if !matches!(bytes.len(), 6 | 8) {
        return None;
    }
    Some(
        bytes
            .iter()
            .map(|b| format!("{:02x}", b))
            .collect::<Vec<_>>()
            .join(":"),
    )
}

/// `money` のバイナリ表現 (8 バイト big-endian の i64、100 分の 1 単位) を
/// 小数 2 桁の十進文字列へ。通貨記号や桁区切りは**付けない** — 表示・コピー・
/// エクスポートで扱いやすい素の数値にするため (小数桁数はサーバの
/// `lc_monetary` に依存するが、実運用のほぼすべてで 2 桁)。
fn format_money(bytes: &[u8]) -> Option<String> {
    let arr: [u8; 8] = bytes.try_into().ok()?;
    let v = i64::from_be_bytes(arr);
    let abs = v.unsigned_abs();
    let text = format!("{}.{:02}", abs / 100, abs % 100);
    Some(if v < 0 { format!("-{}", text) } else { text })
}

/// `interval` のバイナリ表現 (micros: i64, days: i32, months: i32 の順、
/// いずれも big-endian) を PostgreSQL 既定の `IntervalStyle = postgres` 風の
/// テキストへ整形する (例: `1 year 2 mons 3 days 04:05:06.789`)。
///
/// 月は年/月に分解し、時刻部分はマイクロ秒まで保持したうえで末尾の 0 を
/// 落とす。全要素が 0 のときは `00:00:00`。
fn format_interval(bytes: &[u8]) -> Option<String> {
    if bytes.len() != 16 {
        return None;
    }
    let micros = i64::from_be_bytes(bytes.get(0..8)?.try_into().ok()?);
    let days = i32::from_be_bytes(bytes.get(8..12)?.try_into().ok()?);
    let months = i32::from_be_bytes(bytes.get(12..16)?.try_into().ok()?);

    // `i32::abs` は i32::MIN でオーバーフロー panic するため unsigned_abs を使う。
    fn plural(n: i32) -> &'static str {
        if n.unsigned_abs() == 1 {
            ""
        } else {
            "s"
        }
    }

    let mut parts: Vec<String> = Vec::new();
    let years = months / 12;
    let mons = months % 12;
    if years != 0 {
        parts.push(format!("{} year{}", years, plural(years)));
    }
    if mons != 0 {
        parts.push(format!("{} mon{}", mons, plural(mons)));
    }
    if days != 0 {
        parts.push(format!("{} day{}", days, plural(days)));
    }
    if micros != 0 || parts.is_empty() {
        let abs = micros.unsigned_abs();
        let total_secs = abs / 1_000_000;
        let frac = abs % 1_000_000;
        let mut time = format!(
            "{}{:02}:{:02}:{:02}",
            if micros < 0 { "-" } else { "" },
            total_secs / 3600,
            (total_secs % 3600) / 60,
            total_secs % 60
        );
        if frac != 0 {
            let mut digits = format!("{:06}", frac);
            while digits.ends_with('0') {
                digits.pop();
            }
            time.push('.');
            time.push_str(&digits);
        }
        parts.push(time);
    }
    Some(parts.join(" "))
}

/// `bit` / `varbit` のバイナリ表現 (i32 のビット長 + MSB 詰めのビット列) を
/// `'10110000'` 形式の 0/1 文字列へ。長さが宣言と合わなければ `None`。
fn format_bit_string(bytes: &[u8]) -> Option<String> {
    let bit_len = i32::from_be_bytes(bytes.get(0..4)?.try_into().ok()?);
    if bit_len < 0 {
        return None;
    }
    let bit_len = bit_len as usize;
    let body = bytes.get(4..4 + bit_len.div_ceil(8))?;
    let mut out = String::with_capacity(bit_len);
    for idx in 0..bit_len {
        let byte = *body.get(idx / 8)?;
        out.push(if (byte >> (7 - (idx % 8))) & 1 == 1 {
            '1'
        } else {
            '0'
        });
    }
    Some(out)
}

/// `tid` (物理行位置) の 6 バイト表現を `(block,offset)` へ整形する。
/// ブロック番号は 16bit 2 語 (上位/下位) に分かれている。
fn format_tid(bytes: &[u8]) -> Option<String> {
    if bytes.len() != 6 {
        return None;
    }
    let hi = u16::from_be_bytes(bytes.get(0..2)?.try_into().ok()?) as u32;
    let lo = u16::from_be_bytes(bytes.get(2..4)?.try_into().ok()?) as u32;
    let offset = u16::from_be_bytes(bytes.get(4..6)?.try_into().ok()?);
    Some(format!("({},{})", (hi << 16) | lo, offset))
}

/// 型名が配列型かどうか。`PgTypeInfo::name()` は既知の配列型を `TEXT[]` の
/// 形で返すが、未知の (ユーザ定義型の) 配列は pg_type の内部名である
/// `_mytype` の形で出ることがあるため両方を見る。
fn is_array_type_name(type_name: &str) -> bool {
    type_name.ends_with("[]") || type_name.starts_with('_')
}

/// 配列セルを PostgreSQL の配列リテラル表記 (`{a,b,NULL}`) へ整形する。
///
/// 要素型は事前に判らないので、sqlx が配列としてデコードできる形を順に試して
/// 最初に成功したものを使う。`Option<T>` の要素で受けるので、要素の NULL と
/// 文字列 `"NULL"` を取り違えない。どれも駄目なら `None` を返し、呼び出し側の
/// 一般フォールバック (生テキスト / 16 進) に委ねる。
fn decode_array(row: &PgRow, i: usize) -> Option<String> {
    if let Ok(Some(v)) = row.try_get::<Option<Vec<Option<String>>>, _>(i) {
        return Some(format_array_literal(&v));
    }
    if let Ok(Some(v)) = row.try_get::<Option<Vec<Option<i16>>>, _>(i) {
        return Some(format_array_literal(&stringify_elements(v)));
    }
    if let Ok(Some(v)) = row.try_get::<Option<Vec<Option<i32>>>, _>(i) {
        return Some(format_array_literal(&stringify_elements(v)));
    }
    if let Ok(Some(v)) = row.try_get::<Option<Vec<Option<i64>>>, _>(i) {
        return Some(format_array_literal(&stringify_elements(v)));
    }
    if let Ok(Some(v)) = row.try_get::<Option<Vec<Option<f32>>>, _>(i) {
        return Some(format_array_literal(&stringify_elements(v)));
    }
    if let Ok(Some(v)) = row.try_get::<Option<Vec<Option<f64>>>, _>(i) {
        return Some(format_array_literal(&stringify_elements(v)));
    }
    if let Ok(Some(v)) = row.try_get::<Option<Vec<Option<bool>>>, _>(i) {
        // PostgreSQL の bool 出力に合わせて t/f (`{t,f}`)。
        let cells: Vec<Option<String>> = v
            .into_iter()
            .map(|e| e.map(|b| if b { "t".to_string() } else { "f".to_string() }))
            .collect();
        return Some(format_array_literal(&cells));
    }
    // 最後に型互換チェック抜きの文字列配列を試す。ユーザ定義 ENUM の配列
    // (`_mood`) やドメイン型の配列は要素がテキストで届くのでこれで読める。
    // 要素が本当にバイナリ (uuid[] など) なら UTF-8 として不正になりデコードが
    // 失敗するので、その場合は `None` のまま一般フォールバックへ落ちる。
    if let Ok(Some(v)) = row.try_get_unchecked::<Option<Vec<Option<String>>>, _>(i) {
        return Some(format_array_literal(&v));
    }
    None
}

fn stringify_elements<T: ToString>(values: Vec<Option<T>>) -> Vec<Option<String>> {
    values
        .into_iter()
        .map(|e| e.map(|v| v.to_string()))
        .collect()
}

/// 要素の文字列表現から PostgreSQL の配列リテラル (`{a,"b,c",NULL}`) を組む。
/// 区切り/括弧/引用符/バックスラッシュ/空白を含む要素、空文字列、`NULL` と
/// 読めてしまう要素は `"` で囲み、内部の `"` と `\` をバックスラッシュで
/// エスケープする。
fn format_array_literal(elements: &[Option<String>]) -> String {
    let mut out = String::from("{");
    for (idx, element) in elements.iter().enumerate() {
        if idx > 0 {
            out.push(',');
        }
        match element {
            None => out.push_str("NULL"),
            Some(s) if array_element_needs_quotes(s) => {
                out.push('"');
                for c in s.chars() {
                    if c == '"' || c == '\\' {
                        out.push('\\');
                    }
                    out.push(c);
                }
                out.push('"');
            }
            Some(s) => out.push_str(s),
        }
    }
    out.push('}');
    out
}

fn array_element_needs_quotes(s: &str) -> bool {
    s.is_empty()
        || s.eq_ignore_ascii_case("NULL")
        || s.chars()
            .any(|c| matches!(c, ',' | '{' | '}' | '"' | '\\') || c.is_whitespace())
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

/// プレビューの AFTER を PK で取り直すときに、捕まえた主キー値を SQL へ
/// 埋め込む形にする。
///
/// **バインドパラメータ (`$1`) ではなく型なしリテラルを使う**のは、PostgreSQL
/// の型解決がクライアント指定のパラメータ型に厳格なため。sqlx は Rust の型から
/// パラメータの型 OID を決めるので、`uuid` / `inet` / `date` 列に対して
/// `String` を bind すると `operator does not exist: uuid = text` で**文の実行
/// 自体が失敗**し、プレビュー全体が落ちる。一方、引用符付きの型なしリテラルは
/// 比較相手の列型へ暗黙に解決されるため、列型を知らないこの経路でも安全に
/// 比較できる (`import_rows` が値をリテラルで流し込んでいるのと同じ理由)。
///
/// BLOB (`Value::Bytes`) は 16 進テキストのままでは往復しないので `NULL` に
/// する — MySQL 側の `bind_value` と同じ方針で、AFTER から当該行が落ちるだけに
/// 留め、型不一致でエラーにはしない。
fn pk_literal(v: &Value) -> String {
    match v {
        Value::Null | Value::Bytes(_) => "NULL".to_string(),
        Value::Bool(b) => pg_literal(Some(if *b { "true" } else { "false" })),
        Value::Int(i) => pg_literal(Some(i.to_string().as_str())),
        Value::UInt(u) => pg_literal(Some(u.to_string().as_str())),
        Value::Float(f) => pg_literal(Some(f.to_string().as_str())),
        Value::String(s) => pg_literal(Some(s.as_str())),
    }
}

/// Build a multi-row `INSERT ... VALUES (...), (...)` with inline literals,
/// mirroring the construction in `import_rows`. Shared by the resilient
/// try/probe paths (#687). Requires `standard_conforming_strings = on`.
fn build_pg_insert(table: &str, columns: &[String], rows: &[Vec<Option<String>>]) -> String {
    let ncols = columns.len();
    let cols_sql = columns
        .iter()
        .map(|c| pg_quote_ident(c))
        .collect::<Vec<_>>()
        .join(", ");
    let table_ident = pg_quote_ident(table);
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
            sql.push_str(&pg_literal(row.get(ci).and_then(|c| c.as_deref())));
        }
        sql.push(')');
    }
    sql
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

    // --- ワイヤ表現を自前で読む整形関数群 ---------------------------------
    // いずれも「非 NULL の値が Value::Null へ落ちる」のを止めるために追加した
    // 分岐 (sqlx の型互換チェックでは文字列として読めない型)。境界 (空・最大長・
    // 不正長) で panic せず None を返すことも併せて固定する。

    #[test]
    fn formats_uuid_from_16_bytes() {
        let bytes: Vec<u8> = (0u8..16).collect();
        assert_eq!(
            format_uuid(&bytes).as_deref(),
            Some("00010203-0405-0607-0809-0a0b0c0d0e0f")
        );
        // 長さ違いは panic せず None (呼び出し側が一般フォールバックへ落ちる)。
        assert_eq!(format_uuid(&[]), None);
        assert_eq!(format_uuid(&[0u8; 15]), None);
        assert_eq!(format_uuid(&[0u8; 17]), None);
    }

    #[test]
    fn formats_inet_and_cidr() {
        // inet 192.168.1.5/32 (ホストマスク) → マスク表記なし。
        let host = [2u8, 32, 0, 4, 192, 168, 1, 5];
        assert_eq!(format_inet(&host).as_deref(), Some("192.168.1.5"));
        // inet 10.0.0.0/8 → マスクあり。
        let net = [2u8, 8, 0, 4, 10, 0, 0, 0];
        assert_eq!(format_inet(&net).as_deref(), Some("10.0.0.0/8"));
        // cidr はホストマスクでもマスクを出す。
        let cidr = [2u8, 32, 1, 4, 192, 168, 1, 5];
        assert_eq!(format_inet(&cidr).as_deref(), Some("192.168.1.5/32"));
        // IPv6 (::1/128) は標準ライブラリの短縮表記に従う。
        let mut v6 = vec![3u8, 128, 0, 16];
        v6.extend_from_slice(&[0u8; 15]);
        v6.push(1);
        assert_eq!(format_inet(&v6).as_deref(), Some("::1"));
        // 切り詰められた/未知 family のペイロードは None。
        assert_eq!(format_inet(&[2, 32, 0, 4, 192]), None);
        assert_eq!(format_inet(&[9, 32, 0, 4, 1, 2, 3, 4]), None);
        assert_eq!(format_inet(&[]), None);
    }

    #[test]
    fn formats_macaddr_variants() {
        assert_eq!(
            format_macaddr(&[0x08, 0x00, 0x2b, 0x01, 0x02, 0x03]).as_deref(),
            Some("08:00:2b:01:02:03")
        );
        assert_eq!(
            format_macaddr(&[0x08, 0x00, 0x2b, 0x01, 0x02, 0x03, 0x04, 0x05]).as_deref(),
            Some("08:00:2b:01:02:03:04:05")
        );
        assert_eq!(format_macaddr(&[1, 2, 3]), None);
        assert_eq!(format_macaddr(&[]), None);
    }

    #[test]
    fn formats_money_with_two_decimals() {
        assert_eq!(
            format_money(&1234i64.to_be_bytes()).as_deref(),
            Some("12.34")
        );
        assert_eq!(format_money(&0i64.to_be_bytes()).as_deref(), Some("0.00"));
        assert_eq!(
            format_money(&(-5i64).to_be_bytes()).as_deref(),
            Some("-0.05")
        );
        // i64::MIN でも unsigned_abs のおかげでオーバーフロー panic しない。
        assert!(format_money(&i64::MIN.to_be_bytes()).is_some());
        assert_eq!(format_money(&[0, 0, 0]), None);
    }

    /// interval のバイナリ表現 (micros, days, months) を組み立てるテスト用ヘルパ。
    fn encode_interval(micros: i64, days: i32, months: i32) -> Vec<u8> {
        let mut buf = Vec::with_capacity(16);
        buf.extend_from_slice(&micros.to_be_bytes());
        buf.extend_from_slice(&days.to_be_bytes());
        buf.extend_from_slice(&months.to_be_bytes());
        buf
    }

    #[test]
    fn formats_interval_like_postgres() {
        // 1 year 2 mons 3 days 04:05:06.789
        let micros = ((4 * 3600 + 5 * 60 + 6) * 1_000_000) + 789_000;
        assert_eq!(
            format_interval(&encode_interval(micros, 3, 14)).as_deref(),
            Some("1 year 2 mons 3 days 04:05:06.789")
        );
        // 単数形/複数形。
        assert_eq!(
            format_interval(&encode_interval(0, 1, 1)).as_deref(),
            Some("1 mon 1 day")
        );
        // 全要素ゼロは 00:00:00。
        assert_eq!(
            format_interval(&encode_interval(0, 0, 0)).as_deref(),
            Some("00:00:00")
        );
        // 負の時刻部分。
        assert_eq!(
            format_interval(&encode_interval(-90_000_000, 0, 0)).as_deref(),
            Some("-00:01:30")
        );
        assert_eq!(format_interval(&[0u8; 15]), None);
    }

    #[test]
    fn formats_bit_strings() {
        // 8 ビット '10110000' → 1 バイト 0b1011_0000。
        let mut bytes = 8i32.to_be_bytes().to_vec();
        bytes.push(0b1011_0000);
        assert_eq!(format_bit_string(&bytes).as_deref(), Some("10110000"));
        // ビット長がバイト境界に揃わないケース (3 ビット)。
        let mut odd = 3i32.to_be_bytes().to_vec();
        odd.push(0b1010_0000);
        assert_eq!(format_bit_string(&odd).as_deref(), Some("101"));
        // 空のビット列。
        assert_eq!(format_bit_string(&0i32.to_be_bytes()).as_deref(), Some(""));
        // 宣言されたビット数に対して本体が足りない / 負の長さは None。
        assert_eq!(format_bit_string(&16i32.to_be_bytes()), None);
        assert_eq!(format_bit_string(&(-1i32).to_be_bytes()), None);
        assert_eq!(format_bit_string(&[0, 1]), None);
    }

    #[test]
    fn formats_tid_as_block_offset() {
        // block 1, offset 2
        let bytes = [0x00, 0x00, 0x00, 0x01, 0x00, 0x02];
        assert_eq!(format_tid(&bytes).as_deref(), Some("(1,2)"));
        // 上位語が効くブロック番号 (0x00010000 = 65536)。
        let big = [0x00, 0x01, 0x00, 0x00, 0x00, 0x05];
        assert_eq!(format_tid(&big).as_deref(), Some("(65536,5)"));
        assert_eq!(format_tid(&[0, 0, 0]), None);
    }

    #[test]
    fn formats_array_literals_with_quoting_and_nulls() {
        let cells = vec![
            Some("a".to_string()),
            None,
            Some("b,c".to_string()),
            Some(String::new()),
            Some("NULL".to_string()),
            Some("say \"hi\"".to_string()),
            Some("back\\slash".to_string()),
            Some("two words".to_string()),
        ];
        assert_eq!(
            format_array_literal(&cells),
            "{a,NULL,\"b,c\",\"\",\"NULL\",\"say \\\"hi\\\"\",\"back\\\\slash\",\"two words\"}"
        );
        assert_eq!(format_array_literal(&[]), "{}");
        // 要素の NULL と文字列 "NULL" が区別できていること。
        assert_eq!(
            format_array_literal(&[None, Some("NULL".to_string())]),
            "{NULL,\"NULL\"}"
        );
    }

    #[test]
    fn detects_array_type_names() {
        assert!(is_array_type_name("TEXT[]"));
        assert!(is_array_type_name("INT4[]"));
        assert!(is_array_type_name("_mood"));
        assert!(!is_array_type_name("TEXT"));
        assert!(!is_array_type_name("INT4"));
        // INTERVAL と INT を取り違えないこと自体は `type_name_matches` が
        // 完全一致 (大小無視) である前提に乗っている。
        assert!(!super::super::type_name_matches("INTERVAL", &["INT"]));
        assert!(super::super::type_name_matches("interval", &["INTERVAL"]));
    }

    #[test]
    fn json_wire_text_strips_jsonb_version_byte() {
        // jsonb (バイナリ): 先頭 1 バイトのバージョンを落とし、キー順は
        // サーバが返したまま保つ。
        let mut jsonb = vec![1u8];
        jsonb.extend_from_slice(br#"{"b": 1, "a": 2}"#);
        assert_eq!(
            json_wire_text(&jsonb, true).as_deref(),
            Some(r#"{"b": 1, "a": 2}"#)
        );
        // json (テキスト): そのまま。
        assert_eq!(
            json_wire_text(br#"{"b":1,"a":2}"#, false).as_deref(),
            Some(r#"{"b":1,"a":2}"#)
        );
        // 未知バージョン / 非 UTF-8 は None (従来のパース経路へ)。
        assert_eq!(json_wire_text(&[9, b'{', b'}'], true), None);
        assert_eq!(json_wire_text(&[1, 0xff, 0xfe], true), None);
        assert_eq!(json_wire_text(&[], true), None);
    }

    #[test]
    fn pk_literals_are_untyped_and_safe() {
        assert_eq!(pk_literal(&Value::Int(42)), "'42'");
        assert_eq!(pk_literal(&Value::UInt(7)), "'7'");
        assert_eq!(pk_literal(&Value::Bool(true)), "'true'");
        assert_eq!(
            pk_literal(&Value::String("a'b".to_string())),
            "'a''b'",
            "PK 値に単一引用符が含まれても壊れない"
        );
        // NULL と BLOB は NULL 扱い (該当行が AFTER から落ちるだけ)。
        assert_eq!(pk_literal(&Value::Null), "NULL");
        assert_eq!(pk_literal(&Value::Bytes("00ff".to_string())), "NULL");
    }
}
