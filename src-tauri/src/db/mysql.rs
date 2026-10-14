use std::time::Instant;

use futures_util::StreamExt;
use sqlx::mysql::{MySqlConnectOptions, MySqlPool, MySqlPoolOptions, MySqlRow, MySqlSslMode};
use sqlx::pool::PoolConnection;
use sqlx::{Column as _, Connection as _, Either, MySql, Row, TypeInfo, ValueRef};

use super::advisor::{UnusedIndexEntry, UnusedIndexStats};
use super::tx_options::TxOptions;
use super::types::{non_empty_comment, TableComment};
use super::types::{
    Column, DbUserInfo, ForeignKey, IndexInfo, KillProcessesResult, LiveQuery, PreviewResult,
    ProcessInfo, QueryResult, QueryStatsSupport, RoutineParameter, RoutineSignature, SchemaObject,
    ServerInfo, ServerMetrics, ServerVariable, StatementStat, StreamBatch, TableColumnInfo,
    TablePrivilegeRow, TableRowEstimate, TableRowIdentity, TableSchema, TableSizeInfo,
    UserPrivileges, Value,
};
use super::types::{ServerMessage, ServerMessageSeverity};
use super::upsert::{conflict_clause, ImportConflict};
use super::{
    build_insert_sql, columns_of, decode_string_or_bytes, init_sql_of, DbConnectOptions,
    DriverKind, SslMode,
};
use crate::error::{AppError, Result};

pub struct MySqlConn {
    pool: MySqlPool,
    /// 明示トランザクションで確保した専用接続。BEGIN〜COMMIT/ROLLBACK の間、
    /// すべての文をこの 1 本で実行して同一トランザクションに乗せる。
    tx: tokio::sync::Mutex<Option<sqlx::pool::PoolConnection<sqlx::MySql>>>,
    /// AWS IAM 認証 (#734) 時、プールの新規接続用トークンを定期的に作り直す
    /// タスク。ドロップで停止する。パスワード認証では `None`。
    _iam_refresh: Option<super::aws_iam::TokenRefreshGuard>,
    /// `information_schema.INNODB_LOCK_WAITS` が無いと分かったら立てる (#1417)。MySQL 8.0 で
    /// 削除済みなので、`performance_schema` が使えない 8.x で毎ポーリング失敗する照会を投げない。
    innodb_lock_waits_missing: std::sync::atomic::AtomicBool,
}

/// 接続オプション (プールが新しい物理接続を張るときに使う) を組み立てる。
/// `password` は保存済みパスワード、または AWS IAM 認証トークン。
fn connect_options(opts: &DbConnectOptions, password: &str) -> MySqlConnectOptions {
    let mut connect = MySqlConnectOptions::new()
        .host(&opts.host)
        .port(opts.port)
        .username(&opts.user)
        .password(password);
    if let Some(db) = &opts.database {
        if !db.is_empty() {
            connect = connect.database(db);
        }
    }
    if opts.aws_iam.is_some() {
        // RDS MySQL の IAM 認証ユーザ (AWSAuthenticationPlugin) はトークンを
        // mysql_clear_password で受け取る。平文送信になるため、TLS 必須
        // (`apply_tls` が require 以上へ強制) とセットでのみ有効化する。
        connect = connect.enable_cleartext_plugin(true);
    }
    apply_tls(connect, opts)
}

impl MySqlConn {
    pub async fn connect(opts: &DbConnectOptions) -> Result<Self> {
        let password = super::aws_iam::password_for(opts)?;
        let connect = connect_options(opts, &password);
        drop(password);
        let mut pool_opts = MySqlPoolOptions::new()
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
                "mysql: failed to create connection pool"
            );
            e
        })?;
        // IAM トークンは 15 分で失効する。確立済みの接続はそのまま使えるが、
        // プールが後から張る新規接続 (アイドル切断後・並列取得時) は新しい
        // トークンが要るため、接続オプションを定期的に差し替える。
        let iam_refresh = opts.aws_iam.clone().map(|iam| {
            let refresh_pool = pool.clone();
            let refresh_opts = opts.clone();
            super::aws_iam::spawn_token_refresh(iam, opts.user.clone(), move |token| {
                if refresh_pool.is_closed() {
                    return false;
                }
                refresh_pool.set_connect_options(connect_options(&refresh_opts, &token));
                true
            })
        });
        Ok(Self {
            pool,
            tx: tokio::sync::Mutex::new(None),
            _iam_refresh: iam_refresh,
            innodb_lock_waits_missing: std::sync::atomic::AtomicBool::new(false),
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

    // ── 明示トランザクション ──

    pub async fn tx_begin(&self, database: Option<&str>, opts: TxOptions) -> Result<()> {
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
        // 分離レベルは START TRANSACTION の前 (次の 1 トランザクションだけに効く, #1166)。
        // SQL は TxOptions が enum から組み立てた固定語彙のみ。
        if let Some(pre) = opts.mysql_pre_sql() {
            sqlx::Executor::execute(&mut *conn, sqlx::raw_sql(sqlx::AssertSqlSafe(pre))).await?;
        }
        sqlx::Executor::execute(
            &mut *conn,
            sqlx::raw_sql(sqlx::AssertSqlSafe(opts.mysql_begin_sql())),
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

    /// SAVEPOINT 等の制御文を保持接続のテキストプロトコルで実行する (#1418, 1295 回避)。
    /// `sql` は `db::savepoint` が検証済みの名前から組み立てたものだけを渡すこと。
    pub async fn tx_control(&self, sql: &str) -> Result<()> {
        let mut guard = self.tx.lock().await;
        let conn = guard
            .as_mut()
            .ok_or_else(|| AppError::InvalidInput("no active transaction".into()))?;
        sqlx::Executor::execute(
            &mut **conn,
            sqlx::raw_sql(sqlx::AssertSqlSafe(sql.to_string())),
        )
        .await?;
        Ok(())
    }

    pub async fn tx_finish(&self, commit: bool) -> Result<()> {
        let mut guard = self.tx.lock().await;
        let mut conn = guard
            .take()
            .ok_or_else(|| AppError::InvalidInput("no active transaction".into()))?;
        let stmt = if commit { "COMMIT" } else { "ROLLBACK" };
        let result =
            sqlx::Executor::execute(&mut *conn, sqlx::raw_sql(sqlx::AssertSqlSafe(stmt))).await;
        if let Err(e) = result {
            // COMMIT/ROLLBACK 自体が失敗すると、この接続は BEGIN したままの
            // 不定状態になり得る。`guard` は既に None にしてあるので復旧の
            // 余地はなく、そのままプールに返すと次の利用者がトランザクション
            // 状態を引き継いでしまう。COMMIT 失敗時はベストエフォートで
            // ROLLBACK を試み (失敗しても無視)、最後にこの接続を `detach`
            // してプール管理から切り離してから破棄する — プールへは返さない。
            if commit {
                let _ = sqlx::Executor::execute(
                    &mut *conn,
                    sqlx::raw_sql(sqlx::AssertSqlSafe("ROLLBACK")),
                )
                .await;
            }
            drop(conn.detach());
            return Err(e.into());
        }
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
                    server_messages: Vec::new(),
                });
            }
            return Ok(QueryResult::empty(rows_affected, elapsed_ms));
        }

        let is_query = is_query_shape(sql);
        if !is_query {
            let result = sqlx::query(sqlx::AssertSqlSafe(sql))
                .execute(&mut *conn)
                .await?;
            // 書き込み文の直後に警告を取る (#1165)。同じ接続・直後でないと
            // 診断領域が次の文で上書きされる。
            let messages = fetch_warnings(&mut conn).await;
            return Ok(QueryResult::empty(
                result.rows_affected(),
                started.elapsed().as_millis() as u64,
            )
            .with_server_messages(messages));
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
            // 0 行の結果でも列見出しを出せるよう、準備済み文から列を取る (#1534)。
            drop(stream);
            columns = super::prepared_columns!(conn, sql);
            on_batch(StreamBatch::Columns(columns.clone()))?;
        }

        Ok(QueryResult {
            columns,
            rows: Vec::new(),
            rows_affected: total as u64,
            elapsed_ms: started.elapsed().as_millis() as u64,
            server_messages: Vec::new(),
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
        let (preview, _, tx) = self.preview_inner(sql, database, row_limit, false).await?;
        tx.rollback().await?;
        Ok(preview)
    }

    /// 書き込みキャプチャ (#1536) 用: [`Self::preview_execute_with_limit`] と同じ骨格だが
    /// 最後に **COMMIT** し、文を 1 回だけ実行する。対象行の取得 (`FOR UPDATE` で行ロック)
    /// → 文の実行 → 同一トランザクション内での after 取得が 1 つのトランザクションに収まる
    /// ので、dry-run と本実行の間に他クライアントが割り込む窓も、自動採番のずれもない。
    /// スナップショットの取得失敗は握りつぶして空にする (文の実行・COMMIT は妨げない)。
    ///
    /// **COMMIT はここではしない**: 開いたままのトランザクションを返す。呼び出し側
    /// (`Connection::capture_execute` → `capture_commit`) が、ここまでをタイムアウト /
    /// キャンセル配下に置き (中断すれば drop でロールバック)、COMMIT だけを切り離して守る。
    pub async fn execute_snapshot_uncommitted(
        &self,
        sql: &str,
        database: Option<&str>,
        row_limit: usize,
    ) -> Result<(
        PreviewResult,
        QueryResult,
        sqlx::Transaction<'static, MySql>,
    )> {
        let (preview, result, tx) = self.preview_inner(sql, database, row_limit, true).await?;
        let result =
            result.unwrap_or_else(|| QueryResult::empty(preview.rows_affected, preview.elapsed_ms));
        Ok((preview, result, tx))
    }

    async fn preview_inner(
        &self,
        sql: &str,
        database: Option<&str>,
        row_limit: usize,
        commit: bool,
    ) -> Result<(
        PreviewResult,
        Option<QueryResult>,
        sqlx::Transaction<'static, MySql>,
    )> {
        let row_limit = row_limit.max(1);
        // 文種の判定は先頭コメントを除去したテキストで行う (`-- メモ\nUPDATE …` や
        // `/* fix */ DELETE …` を拒否しない)。
        let trimmed = super::strip_sql_comments(sql, super::SqlFlavor::MySql)
            .trim_start()
            .to_ascii_lowercase();
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
        if super::has_stacked_statements_for(super::DriverKind::Mysql, sql) {
            return Err(AppError::InvalidInput(
                "preview does not support multiple statements".into(),
            ));
        }

        let target = extract_target_table(sql);

        // MyISAM などの非トランザクショナル表では ROLLBACK しても変更が戻らず、
        // 「ドライラン」のつもりが実際に書き込んでしまう。プレビューは拒否する。
        if self
            .write_target_is_non_transactional(database, sql)
            .await?
        {
            return Err(AppError::InvalidInput(
                "preview is not available for non-transactional tables (e.g. MyISAM): the change would not be rolled back".into(),
            ));
        }

        // トランザクションは `'static` (接続を所有) にして、呼び出し側へ開いたまま返せる
        // ようにする (#1536)。`USE` / PK 検索もこのトランザクションの接続で行う。
        let mut tx = self.pool.begin().await?;
        apply_use_database_on(&mut tx, database).await?;

        // Best-effort PK lookup — falls back to an empty Vec so a missing
        // primary key, view target, or stripped privileges just degrades to
        // an unordered snapshot.
        let primary_key: Vec<String> = match target.as_deref() {
            Some(t) => fetch_primary_key_on(&mut tx, t).await.unwrap_or_default(),
            None => Vec::new(),
        };
        let is_insert_stmt = trimmed.starts_with("insert");
        // 書き込みキャプチャ (#1536) の INSERT は、新規行が末尾 (最大 PK 側) に付く
        // 自動採番表でも窓の外に出ないよう、PK 降順の末尾窓で前後を撮る。
        let order_clause = if commit && is_insert_stmt {
            super::pk_order_clause_desc(&primary_key, quote_ident)
        } else {
            super::pk_order_clause(&primary_key, quote_ident)
        };
        // 対象表/主キーが無ければ記録できない (呼び出し側が辞退する) ので、キャプチャ時は
        // スナップショットの読み取りを省いて文だけを実行する。
        let skip_snapshots = commit && (target.is_none() || primary_key.is_empty());

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
        //
        // 判定と切り出しはドライバ非依存の純ロジック (`db::preview`) を共有する
        // — PostgreSQL 側にも同じ取りこぼしがあったため。
        // PK 自体を書き換える UPDATE (`SET id = 100 WHERE id = 1`) は旧 PK で AFTER を
        // 取り直すと行が見つからず「削除された」ように見えるため、WHERE の再利用も
        // PK アンカーもやめ、BEFORE/AFTER を同じ固定窓で撮り直す。
        let pk_changed =
            super::preview::update_assigns_primary_key(sql, super::SqlFlavor::MySql, &primary_key);
        let where_clause = if pk_changed {
            None
        } else {
            super::preview::before_where_clause(sql, super::SqlFlavor::MySql, &primary_key)
        };

        let mut before_sql =
            target
                .as_ref()
                .filter(|_| !skip_snapshots)
                .map(|t| match &where_clause {
                    // The user's clause is appended verbatim — it already includes
                    // any ORDER BY / LIMIT they wrote. We don't add our own LIMIT
                    // here (their LIMIT would clash); the fetch below caps the
                    // collected rows at `row_limit + 1` instead.
                    Some(w) => super::preview::build_snapshot_sql(t, Some(w), "", None),
                    None => super::preview::build_snapshot_sql(
                        t,
                        None,
                        &order_clause,
                        Some(row_limit + 1),
                    ),
                });

        let started = Instant::now();
        let mut capture_decline: Option<String> = None;

        let before_raw: Vec<MySqlRow> = match before_sql.clone() {
            // 行ロックは「ユーザの WHERE を引き継いだ対象行の取得」のときだけ取る。WHERE を
            // 引き継げない形 (PK を書き換える UPDATE など) の固定窓にロックを掛けると、
            // 無関係な行のロックを待ち続けてしまう (#1536 レビュー)。
            Some(q) if commit && !is_insert_stmt && where_clause.is_some() => {
                // 行ロックを取って「見た行 = 実際に更新/削除される行」にする。ロックが
                // 取れない (権限・ビュー等) ときはロック無しで取り直す。
                let locked = format!("{q} FOR UPDATE");
                match fetch_capped(&mut tx, &locked, row_limit + 1).await {
                    Ok(rows) => rows,
                    // ロック待ちタイムアウト (1205): 素の UPDATE / DELETE でも同じロックを待って
                    // 失敗するので、張り直して待ち直さずそのままエラーにする (最悪 2 倍待たない)。
                    Err(e) if is_lock_wait_timeout(&e) => return Err(e),
                    // デッドロック (1213): InnoDB がトランザクションを巻き戻している。記録のために
                    // 争わず、張り直して書き込みだけを 1 回実行する (記録は辞退)。
                    Err(e) if is_deadlock(&e) => {
                        let _ = tx.rollback().await;
                        tx = self.pool.begin().await?;
                        apply_use_database_on(&mut tx, database).await?;
                        before_sql = None;
                        capture_decline = Some(
                            "対象行のロックを取れなかった (他の処理と競合) ため記録しません".into(),
                        );
                        Vec::new()
                    }
                    Err(_) => fetch_capped(&mut tx, &q, row_limit + 1)
                        .await
                        .unwrap_or_default(),
                }
            }
            Some(q) if commit => fetch_capped(&mut tx, &q, row_limit + 1)
                .await
                .unwrap_or_default(),
            Some(q) => fetch_capped(&mut tx, &q, row_limit + 1).await?,
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

        let mut insert_id: u64 = 0;
        let (rows_affected, committed_result) = if commit {
            let (r, id) = run_write_with_insert_id(&mut tx, sql).await?;
            insert_id = id;
            (r.rows_affected, Some(r))
        } else {
            let result = sqlx::query(sqlx::AssertSqlSafe(sql))
                .execute(&mut *tx)
                .await?;
            (result.rows_affected(), None)
        };

        // PK-anchored refetch keeps the same rows visible after UPDATE/DELETE,
        // but for INSERT we want the LIMIT scan so newly inserted rows actually
        // show up in AFTER (their PKs weren't in BEFORE to anchor on).
        let is_insert = trimmed.starts_with("insert");
        let use_pk_anchor =
            !is_insert && !pk_changed && target.is_some() && !captured_pks.is_empty();
        // 単一行の INSERT で AUTO_INCREMENT の主キーが採番されたときは、その値 (この文の OK
        // パケットの last_insert_id) で挿入行を直接引く。窓の差分では、窓の外へ出る行や
        // 同一文内の副作用で別の既存行を取り違えうる (#1536 レビュー)。
        let mut new_rows_exact = false;
        let insert_by_id_sql: Option<String> = if commit
            && is_insert_stmt
            && insert_id > 0
            && rows_affected == 1
            && primary_key.len() == 1
        {
            match target.as_deref() {
                Some(t) if pk_is_auto_increment(&mut tx, t, &primary_key[0]).await => {
                    new_rows_exact = true;
                    Some(format!(
                        "SELECT * FROM {} WHERE {} = {}",
                        t,
                        quote_ident(&primary_key[0]),
                        insert_id
                    ))
                }
                _ => None,
            }
        } else {
            None
        };
        let after_res: Result<Vec<MySqlRow>> = if let Some(q) = &insert_by_id_sql {
            sqlx::query(sqlx::AssertSqlSafe(q.as_str()))
                .fetch_all(&mut *tx)
                .await
                .map_err(AppError::from)
        } else if use_pk_anchor {
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
            .await
        } else {
            match &before_sql {
                Some(q) => sqlx::query(sqlx::AssertSqlSafe(q.as_str()))
                    .fetch_all(&mut *tx)
                    .await
                    .map_err(AppError::from),
                None => Ok(Vec::new()),
            }
        };
        // キャプチャ時は after の取得失敗で書き込みを失わない (空にして COMMIT する)。
        let after_raw: Vec<MySqlRow> = if commit {
            after_res.unwrap_or_default()
        } else {
            after_res?
        };

        let elapsed_ms = started.elapsed().as_millis() as u64;

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

        Ok((
            PreviewResult {
                target_table: target,
                columns,
                primary_key,
                before_rows,
                after_rows,
                rows_affected,
                elapsed_ms,
                truncated,
                new_rows_exact,
                capture_decline,
            },
            committed_result,
            tx,
        ))
    }

    /// Bulk INSERT via batched multi-row statements bound as parameters and
    /// wrapped in one transaction. Cells are bound as text (`NULL` for `None`)
    /// and MySQL coerces them to the destination column type, so a CSV column
    /// of `"42"` lands in an INT column without us having to know the schema.
    #[allow(clippy::too_many_arguments)]
    pub async fn import_rows<F>(
        &self,
        database: Option<&str>,
        table: &str,
        columns: &[String],
        rows: &[Vec<Option<String>>],
        batch_size: usize,
        conflict: &ImportConflict,
        on_progress: F,
    ) -> Result<u64>
    where
        F: FnMut(u64) -> Result<()>,
    {
        self.import_rows_with_hex(
            database,
            table,
            columns,
            rows,
            batch_size,
            conflict,
            &[],
            on_progress,
        )
        .await
    }

    /// [`Self::import_rows`] の、`hex_columns[i]` が真の列を hex テキストとして
    /// bind し `UNHEX(?)` でバイト列にする版 (#1530)。
    #[allow(clippy::too_many_arguments)]
    pub async fn import_rows_with_hex<F>(
        &self,
        database: Option<&str>,
        table: &str,
        columns: &[String],
        rows: &[Vec<Option<String>>],
        batch_size: usize,
        conflict: &ImportConflict,
        hex_columns: &[bool],
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
        let on_conflict = conflict_clause(DriverKind::Mysql, columns, conflict);
        // MySQL caps a statement at 65,535 placeholders; stay well under.
        let max_rows = (65000 / ncols).max(1);
        let batch = batch_size.clamp(1, max_rows);

        let mut conn = self.pool.acquire().await?;
        apply_use_database(&mut conn, database).await?;
        let mut tx = conn.begin().await?;
        let mut inserted: u64 = 0;
        for chunk in rows.chunks(batch) {
            let mut sql = super::build_insert_sql_with(
                &table_ident,
                &cols_sql,
                ncols,
                chunk.len(),
                hex_columns,
                "UNHEX",
            );
            sql.push_str(&on_conflict);
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

    /// Auto-commit insert of one chunk (no wrapping transaction). See
    /// [`Connection::try_insert_chunk`] (#687).
    pub(crate) async fn try_insert_chunk(
        &self,
        database: Option<&str>,
        table: &str,
        columns: &[String],
        rows: &[Vec<Option<String>>],
        conflict: &ImportConflict,
    ) -> Result<()> {
        if rows.is_empty() {
            return Ok(());
        }
        let ncols = columns.len();
        let cols_sql = columns
            .iter()
            .map(|c| quote_ident(c))
            .collect::<Vec<_>>()
            .join(", ");
        let table_ident = quote_ident(table);
        let mut sql = build_insert_sql(&table_ident, &cols_sql, ncols, rows.len());
        sql.push_str(&conflict_clause(DriverKind::Mysql, columns, conflict));
        let mut q = sqlx::query(sqlx::AssertSqlSafe(sql));
        for row in rows {
            for ci in 0..ncols {
                q = q.bind(row.get(ci).and_then(|c| c.as_deref()));
            }
        }
        let mut conn = self.pool.acquire().await?;
        apply_use_database(&mut conn, database).await?;
        q.execute(&mut *conn).await?;
        Ok(())
    }

    /// UPSERT の事前検証 (MySQL の `ON DUPLICATE KEY` は全一意キーで発火する)。
    /// テーブルの PRIMARY / UNIQUE インデックスを読み、選択キー列と照合する。
    /// 詳細は [`super::upsert::check_mysql_unique_keys`]。
    pub(crate) async fn check_upsert_keys(
        &self,
        database: Option<&str>,
        table: &str,
        imported: &[String],
        key_columns: &[String],
    ) -> Result<()> {
        // 空文字は「未指定」と同じ扱いにする (`COALESCE` が NULL のときだけ現在の DB を使う)。
        let database = database.filter(|d| !d.is_empty());
        let rows: Vec<(String, String)> = sqlx::query_as(
            "SELECT INDEX_NAME, COALESCE(COLUMN_NAME, '') FROM information_schema.STATISTICS \
             WHERE TABLE_SCHEMA = COALESCE(?, DATABASE()) AND TABLE_NAME = ? AND NON_UNIQUE = 0 \
             ORDER BY INDEX_NAME, SEQ_IN_INDEX",
        )
        .bind(database)
        .bind(table)
        .fetch_all(&self.pool)
        .await?;
        let mut uniques: Vec<super::upsert::UniqueKey> = Vec::new();
        for (name, col) in rows {
            // 関数インデックスの式キー (COLUMN_NAME が NULL) は実列と一致しないよう
            // 空文字の疑似列で表す。
            match uniques.last_mut() {
                Some(u) if u.name == name => u.columns.push(col),
                _ => uniques.push(super::upsert::UniqueKey {
                    name,
                    columns: vec![col],
                }),
            }
        }
        // 取り込まない列が省略時に衝突しないもの (判定は `omitted_column_is_safe`)。
        let col_rows: Vec<(String, String, String, Option<String>)> = sqlx::query_as(
            "SELECT COLUMN_NAME, EXTRA, IS_NULLABLE, COLUMN_DEFAULT \
             FROM information_schema.COLUMNS \
             WHERE TABLE_SCHEMA = COALESCE(?, DATABASE()) AND TABLE_NAME = ?",
        )
        .bind(database)
        .bind(table)
        .fetch_all(&self.pool)
        .await?;
        let omitted_safe: Vec<String> = col_rows
            .into_iter()
            .filter(|(_, extra, nullable, default)| {
                super::upsert::omitted_column_is_safe(extra, nullable == "YES", default.as_deref())
            })
            .map(|(name, ..)| name)
            .collect();
        super::upsert::check_mysql_unique_keys(&uniques, &omitted_safe, imported, key_columns)
    }

    /// Whether `table`'s storage engine supports transactional DML (rollback).
    /// InnoDB (the default) and NDB do; MyISAM / MEMORY / CSV / ARCHIVE etc. do
    /// not. The resilient-import probe/retry strategies rely on rollback, so they
    /// must not run against a non-transactional table (#687 review follow-up).
    /// Returns `true` for an unknown table (no row), since InnoDB is the
    /// overwhelming default. A **view** has a NULL engine, so its base tables
    /// (`VIEW_TABLE_USAGE`, falling back to parsing `VIEW_DEFINITION`; nested
    /// views included) are checked instead: a write through a view onto a MyISAM
    /// base table is not rolled back either (#1600). A query error — or a view
    /// whose base tables cannot be determined — is returned as `Err`; callers
    /// decide the safe side (`write_target_is_non_transactional` and
    /// `probe_failing_row` treat it as non-transactional).
    pub(crate) async fn table_is_transactional(
        &self,
        database: Option<&str>,
        table: &str,
    ) -> Result<bool> {
        let database = database.filter(|d| !d.is_empty());
        let row: Option<(String, String, Option<String>)> = sqlx::query_as(
            "SELECT TABLE_SCHEMA, TABLE_TYPE, ENGINE FROM information_schema.TABLES \
             WHERE TABLE_SCHEMA = COALESCE(?, DATABASE()) AND TABLE_NAME = ? LIMIT 1",
        )
        .bind(database)
        .bind(table)
        .fetch_optional(&self.pool)
        .await?;
        let Some((schema, table_type, engine)) = row else {
            return Ok(true);
        };
        if !table_type.eq_ignore_ascii_case("VIEW") {
            return Ok(engine_is_transactional(engine.as_deref()));
        }
        // ビュー: 基底表 (入れ子のビューは辿る) の ENGINE をすべて確認する。
        let mut pending: Vec<(String, String)> = vec![(schema, table.to_string())];
        let mut seen: std::collections::HashSet<(String, String)> =
            std::collections::HashSet::new();
        while let Some((view_schema, view_name)) = pending.pop() {
            if !seen.insert((view_schema.clone(), view_name.clone())) {
                continue;
            }
            // 循環や過度な入れ子で暴走しないよう、確認できなければ安全側 (Err)。
            if seen.len() > 32 {
                return Err(AppError::InvalidInput(
                    "view dependency chain is too deep to inspect".into(),
                ));
            }
            let bases = self.view_base_tables(&view_schema, &view_name).await?;
            for (base_schema, base_name, base_type, base_engine) in bases {
                if base_type.eq_ignore_ascii_case("VIEW") {
                    pending.push((base_schema, base_name));
                } else if !engine_is_transactional(base_engine.as_deref()) {
                    return Ok(false);
                }
            }
        }
        Ok(true)
    }

    /// ビュー `schema`.`view` が参照する基底表 `(スキーマ, 名前, TABLE_TYPE, ENGINE)`。
    /// まず `VIEW_TABLE_USAGE` (MySQL 8.0.13+) を使い、失敗した (MariaDB / 古い MySQL) か
    /// 0 件だった (権限不足の DEFINER ビューなど) ときは `VIEWS.VIEW_DEFINITION` の
    /// 解析で補う。それでも 1 件も特定できなければ `Err` — 基底表が MyISAM かどうか
    /// 確認できないまま「トランザクショナル」と見なさない (#1600)。
    async fn view_base_tables(&self, schema: &str, view: &str) -> Result<Vec<ViewBase>> {
        let usage: Result<Vec<ViewBase>> =
            sqlx::query_as::<_, (String, String, Option<String>, Option<String>)>(
                "SELECT u.TABLE_SCHEMA, u.TABLE_NAME, t.TABLE_TYPE, t.ENGINE \
                 FROM information_schema.VIEW_TABLE_USAGE u \
                 LEFT JOIN information_schema.TABLES t \
                   ON t.TABLE_SCHEMA = u.TABLE_SCHEMA AND t.TABLE_NAME = u.TABLE_NAME \
                 WHERE u.VIEW_SCHEMA = ? AND u.VIEW_NAME = ?",
            )
            .bind(schema)
            .bind(view)
            .fetch_all(&self.pool)
            .await
            .map_err(AppError::from)
            .map(|rows| {
                rows.into_iter()
                    // TABLES に見えない基底表 (権限不足) は種別が空 → 下で信用しない。
                    .map(|(s, n, t, e)| (s, n, t.unwrap_or_default(), e))
                    .collect()
            });
        // 照会に成功し 1 件以上返ったら、その結果だけで判断する。種別が空の行 (TABLES に
        // 見えない基底表) があれば確認できないので拒否。定義の解析へ回すのは、照会の
        // 失敗時と 0 件のときだけ (解析は見えない参照を無視するため、見えない MyISAM を
        // 見落とす)。
        if let Ok(rows) = usage {
            if let Some(rows) = classify_usage_rows(rows)? {
                return Ok(rows);
            }
        }
        let definition: Option<(Option<String>,)> = sqlx::query_as(
            "SELECT VIEW_DEFINITION FROM information_schema.VIEWS \
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? LIMIT 1",
        )
        .bind(schema)
        .bind(view)
        .fetch_optional(&self.pool)
        .await?;
        let refs = definition
            .and_then(|(d,)| d)
            .map(|d| view_definition_table_refs(&d))
            .unwrap_or_default();
        let mut bases = Vec::new();
        for (ref_schema, ref_name) in refs {
            let row: Option<(String, Option<String>)> = sqlx::query_as(
                "SELECT TABLE_TYPE, ENGINE FROM information_schema.TABLES \
                 WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? LIMIT 1",
            )
            .bind(&ref_schema)
            .bind(&ref_name)
            .fetch_optional(&self.pool)
            .await?;
            // 存在しない名前 (列参照 `a`.`id` など) は無視する。
            if let Some((table_type, engine)) = row {
                bases.push((ref_schema, ref_name, table_type, engine));
            }
        }
        if bases.is_empty() {
            return Err(AppError::ViewBaseUnresolved);
        }
        Ok(bases)
    }

    /// 書き込み文 `sql` の対象表が非トランザクショナル (MyISAM 等) か。
    /// ロールバックで戻らないため、ドライラン / フライトレコーダーの捕捉
    /// (どちらも「いったん実行して ROLLBACK」前提) を避ける判定に使う。
    /// 対象表を特定できない場合は `Ok(false)` (InnoDB 想定で従来動作)。照会に失敗した
    /// 場合は確認できないので `Ok(true)` (安全側)。ビューの基底表を特定できない場合は
    /// `Err(ViewBaseUnresolved)` を返し、プレビューは専用のエラーとして利用者へ伝える
    /// (書き込みの捕捉は `Err` でも辞退でよい)。
    pub(crate) async fn write_target_is_non_transactional(
        &self,
        database: Option<&str>,
        sql: &str,
    ) -> Result<bool> {
        let Some((target, _)) = extract_target_table_with_alias(sql) else {
            return Ok(false);
        };
        let (schema, table) = split_table_ref(&target);
        let db = schema.as_deref().or(database);
        // 照会そのものが失敗した (権限不足など) ときは、ロールバックできるか
        // 確認できないので非トランザクショナル扱いにして安全側に倒す。表が
        // 見つからない (行なし) 場合は `table_is_transactional` が true を返す。
        match self.table_is_transactional(db, &table).await {
            Ok(transactional) => Ok(!transactional),
            Err(e @ AppError::ViewBaseUnresolved) => Err(e),
            Err(_) => Ok(true),
        }
    }

    /// Row-by-row probe inside a rolled-back transaction to find the first
    /// rejected row. See [`Connection::probe_failing_row`] (#687).
    pub(crate) async fn probe_failing_row(
        &self,
        database: Option<&str>,
        table: &str,
        columns: &[String],
        rows: &[Vec<Option<String>>],
        conflict: &ImportConflict,
    ) -> Result<Option<(usize, String)>> {
        // A non-transactional engine (MyISAM etc.) can't roll back the probe
        // inserts, so probing would leave rows behind. Skip it and let the caller
        // report the failure without a pinpointed record (#687 review follow-up).
        if !self
            .table_is_transactional(database, table)
            .await
            // 照会に失敗したときは確認できないので非トランザクショナル扱い (probe を
            // 飛ばす安全側)。`write_target_is_non_transactional` と向きを揃える。
            .unwrap_or(false)
        {
            return Ok(None);
        }
        let ncols = columns.len();
        let cols_sql = columns
            .iter()
            .map(|c| quote_ident(c))
            .collect::<Vec<_>>()
            .join(", ");
        let table_ident = quote_ident(table);
        let mut sql = build_insert_sql(&table_ident, &cols_sql, ncols, 1);
        sql.push_str(&conflict_clause(DriverKind::Mysql, columns, conflict));
        let mut conn = self.pool.acquire().await?;
        apply_use_database(&mut conn, database).await?;
        let mut tx = conn.begin().await?;
        for (i, row) in rows.iter().enumerate() {
            let mut q = sqlx::query(sqlx::AssertSqlSafe(sql.as_str()));
            for ci in 0..ncols {
                q = q.bind(row.get(ci).and_then(|c| c.as_deref()));
            }
            if let Err(e) = q.execute(&mut *tx).await {
                // `tx` is dropped on return → the probe inserts are rolled back.
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
    ///
    /// **Caveat — DDL is NOT atomic on MySQL.** MySQL performs an *implicit
    /// commit* before and after every DDL statement (`CREATE` / `ALTER` /
    /// `DROP` / `TRUNCATE` / `RENAME`, etc.; see the MySQL manual, "Statements
    /// That Cause an Implicit Commit"). So in a mixed batch such as
    /// `["CREATE TABLE t ...", "INSERT INTO t ..."]`, the `CREATE` is committed
    /// the instant it runs. If a *later* statement fails, rolling this
    /// transaction back cannot undo the already-committed DDL — the table
    /// persists even though the batch "failed". The all-or-nothing contract
    /// above therefore holds only for pure-DML batches; DDL+DML batches are
    /// non-atomic and can leave partial schema/data behind. This is an
    /// **intrinsic MySQL limitation**, not something this method can fix
    /// without splitting or pre-validating batches (see #640). Callers that
    /// need atomicity for schema changes must not mix DDL and DML in one
    /// `execute_transaction` call; `commands::sync::apply_sync_sql` accounts
    /// for this with a best-effort sequential policy on MySQL. PostgreSQL's
    /// `execute_transaction` (transactional DDL) does not have this caveat.
    /// The behaviour is pinned by `mysql_integration::mysql_ddl_dml_mixed_batch_is_not_atomic`.
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

    /// Server connections/threads for the process monitor panel. Prefers
    /// `performance_schema.processlist` (8.0.22+, lock-free) and falls back to
    /// `information_schema.PROCESSLIST` (older MySQL / MariaDB, or servers
    /// running with `performance_schema = OFF`), which takes a thread-list
    /// mutex but is harmless at this panel's polling cadence.
    pub async fn list_processes(&self) -> Result<Vec<ProcessInfo>> {
        self.list_processes_opts(true).await
    }

    /// `with_locks = false` のときはロック待ち照会 (`blocked_by`) を省く。1 件のクエリ本文を
    /// 引くだけの経路 (`get_process_query`) など、待機チェーンが要らない呼び出し用 (#1417)。
    pub async fn list_processes_opts(&self, with_locks: bool) -> Result<Vec<ProcessInfo>> {
        let projection =
            "SELECT ID, USER, HOST, DB, COMMAND, STATE, TIME, INFO, ID = CONNECTION_ID() FROM";
        let primary = sqlx::query(sqlx::AssertSqlSafe(format!(
            "{projection} performance_schema.processlist ORDER BY ID"
        )))
        .fetch_all(&self.pool)
        .await;
        // Fall back when this source is unavailable. That is not only an
        // error (table missing on pre-8.0.22 / MariaDB) but also an EMPTY
        // success: with `performance_schema = OFF` the table still exists
        // and the query succeeds, yet nothing is collected. A truly empty
        // processlist is impossible — the connection running this very
        // query always appears — so empty unambiguously means "disabled".
        // The decision itself is split into `process_list_needs_fallback` so
        // it can be unit-tested without a live server (#587, #641).
        let used_fallback = process_list_needs_fallback(&primary);
        let rows: Vec<MySqlRow> = if used_fallback {
            sqlx::query(sqlx::AssertSqlSafe(format!(
                "{projection} information_schema.PROCESSLIST ORDER BY ID"
            )))
            .fetch_all(&self.pool)
            .await?
        } else {
            primary?
        };
        // 待機チェーン (#1417)。取得できなければ (権限不足・MySQL 5.7 / MariaDB・
        // performance_schema OFF) エラーにせず空へ縮退する。
        let blockers = if with_locks {
            // メタデータロック照会は、待ち状態の行があるときだけ投げる (ポーリング負荷の抑制)。
            let may_wait_mdl = rows.iter().any(|r| {
                r.try_get::<Option<String>, _>(5)
                    .ok()
                    .flatten()
                    .is_some_and(|st| state_suggests_lock_wait(&st))
            });
            blocked_by_map(self.list_lock_waits(!used_fallback, may_wait_mdl).await)
        } else {
            std::collections::HashMap::new()
        };
        Ok(rows
            .into_iter()
            .map(|r| ProcessInfo {
                // ID is BIGINT UNSIGNED; connection ids fit i64 in practice.
                id: r
                    .try_get::<u64, _>(0)
                    .map(|v| v as i64)
                    .or_else(|_| r.try_get::<i64, _>(0))
                    .unwrap_or_default(),
                user: r.try_get::<Option<String>, _>(1).ok().flatten(),
                host: r.try_get::<Option<String>, _>(2).ok().flatten(),
                database: r.try_get::<Option<String>, _>(3).ok().flatten(),
                command: r.try_get::<Option<String>, _>(4).ok().flatten(),
                state: r.try_get::<Option<String>, _>(5).ok().flatten(),
                time_secs: r
                    .try_get::<i64, _>(6)
                    .or_else(|_| r.try_get::<i32, _>(6).map(i64::from))
                    .ok(),
                query: r.try_get::<Option<String>, _>(7).ok().flatten(),
                // MySQL booleans arrive as integer 0/1.
                is_self: r
                    .try_get::<i64, _>(8)
                    .or_else(|_| r.try_get::<i32, _>(8).map(i64::from))
                    .map(|v| v != 0)
                    .unwrap_or(false),
                blocked_by: Vec::new(),
            })
            .map(|mut p| {
                p.blocked_by = blockers.get(&p.id).cloned().unwrap_or_default();
                p
            })
            .collect())
    }

    /// `(待たされている processlist id, ブロッカーの processlist id)` の組を集める (#1417)。
    /// - 行ロック待ち: MySQL 8 は `performance_schema.data_lock_waits`、取れなければ
    ///   (5.7 / MariaDB) `information_schema.INNODB_LOCK_WAITS` + `INNODB_TRX`。
    /// - メタデータロック待ち (`ALTER TABLE` が `Waiting for table metadata lock` など):
    ///   `performance_schema.metadata_locks` の PENDING を、他スレッドの GRANTED / 優先度の高い
    ///   PENDING と突き合わせ、ロック種別が衝突する組だけを残す ([`mdl_wait_pairs`])。
    ///   待ち状態の行が無いとき (`may_wait_mdl = false`) は照会しない。
    ///
    /// `performance_schema` が使えない (`perf_schema_ok = false`) ときは `performance_schema`
    /// 側の照会を省く。いずれの照会も失敗したら (権限不足など) 空へ縮退し、エラーにしない。
    async fn list_lock_waits(&self, perf_schema_ok: bool, may_wait_mdl: bool) -> Vec<(i64, i64)> {
        use std::sync::atomic::Ordering;
        const DATA_LOCK_WAITS: &str = "SELECT rt.PROCESSLIST_ID, bt.PROCESSLIST_ID \
             FROM performance_schema.data_lock_waits w \
             JOIN performance_schema.threads rt ON rt.THREAD_ID = w.REQUESTING_THREAD_ID \
             JOIN performance_schema.threads bt ON bt.THREAD_ID = w.BLOCKING_THREAD_ID \
             WHERE rt.PROCESSLIST_ID IS NOT NULL AND bt.PROCESSLIST_ID IS NOT NULL";
        const INNODB_LOCK_WAITS: &str = "SELECT rt.trx_mysql_thread_id, bt.trx_mysql_thread_id \
             FROM information_schema.INNODB_LOCK_WAITS w \
             JOIN information_schema.INNODB_TRX rt ON rt.trx_id = w.requesting_trx_id \
             JOIN information_schema.INNODB_TRX bt ON bt.trx_id = w.blocking_trx_id";
        const METADATA_LOCK_WAITS: &str = "SELECT rt.PROCESSLIST_ID, gt.PROCESSLIST_ID, \
                    p.LOCK_TYPE, g.LOCK_TYPE, p.OBJECT_TYPE, g.LOCK_STATUS \
             FROM performance_schema.metadata_locks p \
             JOIN performance_schema.metadata_locks g \
               ON g.OBJECT_TYPE = p.OBJECT_TYPE \
              AND g.OBJECT_SCHEMA <=> p.OBJECT_SCHEMA \
              AND g.OBJECT_NAME <=> p.OBJECT_NAME \
              AND g.LOCK_STATUS IN ('GRANTED', 'PENDING') \
              AND g.OWNER_THREAD_ID <> p.OWNER_THREAD_ID \
             JOIN performance_schema.threads rt ON rt.THREAD_ID = p.OWNER_THREAD_ID \
             JOIN performance_schema.threads gt ON gt.THREAD_ID = g.OWNER_THREAD_ID \
             WHERE p.LOCK_STATUS = 'PENDING' \
               AND rt.PROCESSLIST_ID IS NOT NULL AND gt.PROCESSLIST_ID IS NOT NULL";
        let mut pairs = Vec::new();
        let mut row_locks: Option<Vec<(i64, i64)>> = None;
        if perf_schema_ok {
            row_locks = self.query_id_pairs(DATA_LOCK_WAITS).await;
        }
        if row_locks.is_none() && !self.innodb_lock_waits_missing.load(Ordering::Relaxed) {
            match self.query_id_pairs_checked(INNODB_LOCK_WAITS).await {
                Ok(v) => row_locks = Some(v),
                // テーブルが存在しないときだけ恒久的に諦める。プール枯渇や
                // 権限不足などの一過性の失敗では次回以降も再試行する (#1519)。
                Err(e) if is_missing_table_error(&e) => {
                    self.innodb_lock_waits_missing
                        .store(true, Ordering::Relaxed);
                }
                Err(_) => {}
            }
        }
        pairs.extend(row_locks.unwrap_or_default());
        if perf_schema_ok && may_wait_mdl {
            if let Ok(rows) = sqlx::query(METADATA_LOCK_WAITS).fetch_all(&self.pool).await {
                let cands: Vec<MdlCandidate> = rows
                    .iter()
                    .filter_map(|r| {
                        let get = |i: usize| {
                            r.try_get::<u64, _>(i)
                                .map(|v| v as i64)
                                .or_else(|_| r.try_get::<i64, _>(i))
                                .ok()
                        };
                        Some(MdlCandidate {
                            waiter: get(0)?,
                            holder: get(1)?,
                            waiter_lock: r.try_get::<String, _>(2).ok()?,
                            holder_lock: r.try_get::<String, _>(3).ok()?,
                            object_type: r.try_get::<String, _>(4).ok()?,
                            holder_pending: r.try_get::<String, _>(5).ok()? == "PENDING",
                        })
                    })
                    .collect();
                pairs.extend(mdl_wait_pairs(&cands));
            }
        }
        pairs
    }

    /// 2 列 (id, id) を返す照会を実行する。失敗 (テーブル無し・権限不足) は `None`。
    async fn query_id_pairs(&self, sql: &'static str) -> Option<Vec<(i64, i64)>> {
        self.query_id_pairs_checked(sql).await.ok()
    }

    /// [`Self::query_id_pairs`] の失敗理由を保つ版。
    async fn query_id_pairs_checked(
        &self,
        sql: &'static str,
    ) -> std::result::Result<Vec<(i64, i64)>, sqlx::Error> {
        let rows = sqlx::query(sql).fetch_all(&self.pool).await?;
        Ok(rows
            .iter()
            .filter_map(|r| {
                let get = |i: usize| {
                    r.try_get::<u64, _>(i)
                        .map(|v| v as i64)
                        .or_else(|_| r.try_get::<i64, _>(i))
                        .ok()
                };
                Some((get(0)?, get(1)?))
            })
            .collect())
    }

    /// ライブクエリ・インスペクタ (#746) の前提可否プローブ。
    /// `performance_schema` が OFF なら両機能とも不可、ON なら
    /// `setup_consumers` を読んでライブテール (events_statements_current /
    /// _history) と digest 集計 (statements_digest) の consumer 有効状態を
    /// それぞれ判定する。読み取りのみで、consumer の有効化などサーバ設定の
    /// 変更は一切しない (手順はフロントが理由コードからヘルプ表示する)。
    pub async fn query_stats_support(&self) -> Result<QueryStatsSupport> {
        let ps_on: Option<String> = sqlx::query("SHOW GLOBAL VARIABLES LIKE 'performance_schema'")
            .fetch_optional(&self.pool)
            .await?
            .and_then(|r| r.try_get::<String, _>(1).ok());
        if !ps_on.map(|v| v.eq_ignore_ascii_case("ON")).unwrap_or(false) {
            return Ok(QueryStatsSupport {
                live_tail: false,
                statements: false,
                live_tail_reason: Some("performance_schema_off".into()),
                statements_reason: Some("performance_schema_off".into()),
            });
        }
        let consumers: Vec<MySqlRow> = match sqlx::query(
            "SELECT NAME, ENABLED FROM performance_schema.setup_consumers
             WHERE NAME IN ('events_statements_current',
                            'events_statements_history',
                            'statements_digest')",
        )
        .fetch_all(&self.pool)
        .await
        {
            Ok(rows) => rows,
            // performance_schema 自体は ON でもテーブルを読む権限が無い場合。
            // 見えている範囲を明示する方針 (#587) で理由コードを返して縮退する。
            Err(_) => {
                return Ok(QueryStatsSupport {
                    live_tail: false,
                    statements: false,
                    live_tail_reason: Some("stats_unreadable".into()),
                    statements_reason: Some("stats_unreadable".into()),
                });
            }
        };
        let enabled = |name: &str| {
            consumers.iter().any(|r| {
                r.try_get::<String, _>(0)
                    .map(|n| n == name)
                    .unwrap_or(false)
                    && r.try_get::<String, _>(1)
                        .map(|e| e.eq_ignore_ascii_case("YES"))
                        .unwrap_or(false)
            })
        };
        let live_tail =
            enabled("events_statements_current") || enabled("events_statements_history");
        let statements = enabled("statements_digest");
        Ok(QueryStatsSupport {
            live_tail,
            statements,
            live_tail_reason: (!live_tail).then(|| "statements_consumer_off".into()),
            statements_reason: (!statements).then(|| "statements_digest_off".into()),
        })
    }

    /// スキーマ健全性アドバイザ (#741) の未使用インデックス統計。
    /// `sys.schema_unused_indexes` は performance_schema 有効時のみ意味を持つ
    /// (無効時は理由コード付きで縮退)。このビューは PRIMARY KEY を既に除外して
    /// おり、UNIQUE の除外は純ロジック側が担う。読み取りのみ。
    pub async fn unused_indexes(&self, db: &str) -> Result<UnusedIndexStats> {
        let ps_on: Option<String> = sqlx::query("SHOW GLOBAL VARIABLES LIKE 'performance_schema'")
            .fetch_optional(&self.pool)
            .await?
            .and_then(|r| r.try_get::<String, _>(1).ok());
        if !ps_on.map(|v| v.eq_ignore_ascii_case("ON")).unwrap_or(false) {
            return Ok(UnusedIndexStats {
                supported: false,
                reason: Some("performance_schema_off".into()),
                entries: Vec::new(),
            });
        }
        // sys スキーマが無い/読めない (権限・非対応構成) 場合は縮退する。
        let rows: Vec<MySqlRow> = match sqlx::query(
            "SELECT object_name, index_name
             FROM sys.schema_unused_indexes
             WHERE object_schema = ?
             ORDER BY object_name, index_name",
        )
        .bind(db)
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
                let table = r.try_get::<Option<String>, _>(0).ok().flatten()?;
                let index = r.try_get::<Option<String>, _>(1).ok().flatten()?;
                Some(UnusedIndexEntry { table, index })
            })
            .collect();
        Ok(UnusedIndexStats {
            supported: true,
            reason: None,
            entries,
        })
    }

    /// ライブテール 1 サンプル: 実行中 (`events_statements_current`) と直近
    /// 完了 (`events_statements_history`、スレッドごと直近 N 件で既定有効) を
    /// 結合して返す。読み取り SELECT のみでテーブル I/O は発生しない。
    ///
    /// **バイナリプロトコル (サーバサイド prepared statement) 対応**: JDBC や
    /// sqlx などが使う prepared 実行は、events_statements_* 上では
    /// `statement/com/Execute` イベントになり **SQL_TEXT が NULL** で文面が
    /// 見えない (MySQL 8.0.46 の既定構成で実測)。ORM アプリの多くがこの経路の
    /// ため、`prepared_statements_instances` (文面 + 実行カウンタを保持) を
    /// 追加ソースとして合成する: `COUNT_EXECUTE` をキーに含めることで、実行の
    /// たびに新しいテールイベントとして観測される (ポーリング間の複数回実行は
    /// 1 イベントに畳まれるが、実行レートは digest 側の差分が捕捉する)。
    ///
    /// 除外規則 (#746 自セッション/内部クエリ除外):
    /// - `CONNECTION_ID()` — このサンプリング接続自身
    /// - `performance_schema` / `information_schema` 参照文 — インスペクタ自身の
    ///   ポーリングや noobDB のスキーマ introspection
    ///
    /// 同一プールの別物理接続はエンジンから区別できずベストエフォート。
    /// 同一イベントが current と history の両方に載ることがあるため、
    /// `THREAD_ID:EVENT_ID` キーで重複排除する (実行中の行を優先)。
    pub async fn live_queries(&self) -> Result<Vec<LiveQuery>> {
        let rows: Vec<MySqlRow> = sqlx::query(
            r#"SELECT CONCAT(e.THREAD_ID, ':', e.EVENT_ID),
                      e.SQL_TEXT,
                      t.PROCESSLIST_USER,
                      t.PROCESSLIST_HOST,
                      COALESCE(e.CURRENT_SCHEMA, t.PROCESSLIST_DB),
                      e.TIMER_WAIT / 1e9,
                      e.ROWS_EXAMINED,
                      (e.END_EVENT_ID IS NULL),
                      e.TIMER_START
               FROM (
                 SELECT THREAD_ID, EVENT_ID, END_EVENT_ID, SQL_TEXT, CURRENT_SCHEMA,
                        TIMER_WAIT, ROWS_EXAMINED, TIMER_START
                   FROM performance_schema.events_statements_current
                 UNION ALL
                 SELECT THREAD_ID, EVENT_ID, END_EVENT_ID, SQL_TEXT, CURRENT_SCHEMA,
                        TIMER_WAIT, ROWS_EXAMINED, TIMER_START
                   FROM performance_schema.events_statements_history
               ) e
               JOIN performance_schema.threads t ON t.THREAD_ID = e.THREAD_ID
               WHERE e.SQL_TEXT IS NOT NULL
                 AND t.PROCESSLIST_ID IS NOT NULL
                 AND t.PROCESSLIST_ID <> CONNECTION_ID()
                 AND e.SQL_TEXT NOT LIKE '%performance\_schema%'
                 AND e.SQL_TEXT NOT LIKE '%information\_schema%'
               ORDER BY e.TIMER_START DESC
               LIMIT 300"#,
        )
        .fetch_all(&self.pool)
        .await?;
        let mut out: Vec<LiveQuery> = Vec::with_capacity(rows.len());
        let mut seen = std::collections::HashSet::new();
        for r in rows {
            let key = r.try_get::<String, _>(0).unwrap_or_default();
            let running = decode_int_bool(&r, 7);
            if !seen.insert(key.clone()) {
                // 実行中 (current) の行を先に採用したいが、並びは TIMER_START
                // 降順で current/history の同一イベントは隣接する。running の
                // 行を優先するため、既出キーが running ならここで差し替える。
                if running {
                    if let Some(existing) = out.iter_mut().find(|q| q.key == key) {
                        existing.running = true;
                    }
                }
                continue;
            }
            out.push(LiveQuery {
                key,
                query: r.try_get::<String, _>(1).unwrap_or_default(),
                user: r.try_get::<Option<String>, _>(2).ok().flatten(),
                host: r.try_get::<Option<String>, _>(3).ok().flatten(),
                database: r.try_get::<Option<String>, _>(4).ok().flatten(),
                application: None,
                duration_ms: r.try_get::<Option<f64>, _>(5).ok().flatten(),
                rows_examined: r
                    .try_get::<u64, _>(6)
                    .map(|v| v as i64)
                    .or_else(|_| r.try_get::<i64, _>(6))
                    .ok(),
                running,
                started_at_ms: None,
                fingerprint: String::new(),
            });
        }
        // 追加ソース: サーバサイド prepared statement (バイナリプロトコル)。
        // events_statements_* では文面が NULL のため、インスタンス表から合成する。
        // AVG/件は「代表値」であり直近 1 回の実測ではない点に注意。
        let ps_rows: Vec<MySqlRow> = sqlx::query(
            r#"SELECT CONCAT('ps:', p.OWNER_THREAD_ID, ':', p.STATEMENT_ID, ':', p.COUNT_EXECUTE),
                      p.SQL_TEXT,
                      t.PROCESSLIST_USER,
                      t.PROCESSLIST_HOST,
                      t.PROCESSLIST_DB,
                      p.AVG_TIMER_EXECUTE / 1e9,
                      CAST(p.SUM_ROWS_EXAMINED / GREATEST(p.COUNT_EXECUTE, 1) AS SIGNED)
               FROM performance_schema.prepared_statements_instances p
               JOIN performance_schema.threads t ON t.THREAD_ID = p.OWNER_THREAD_ID
               WHERE p.COUNT_EXECUTE > 0
                 AND t.PROCESSLIST_ID IS NOT NULL
                 AND t.PROCESSLIST_ID <> CONNECTION_ID()
                 AND p.SQL_TEXT NOT LIKE '%performance\_schema%'
                 AND p.SQL_TEXT NOT LIKE '%information\_schema%'
               ORDER BY p.OWNER_THREAD_ID DESC
               LIMIT 100"#,
        )
        .fetch_all(&self.pool)
        .await?;
        for r in ps_rows {
            let key = r.try_get::<String, _>(0).unwrap_or_default();
            if !seen.insert(key.clone()) {
                continue;
            }
            out.push(LiveQuery {
                key,
                query: r.try_get::<String, _>(1).unwrap_or_default(),
                user: r.try_get::<Option<String>, _>(2).ok().flatten(),
                host: r.try_get::<Option<String>, _>(3).ok().flatten(),
                database: r.try_get::<Option<String>, _>(4).ok().flatten(),
                application: None,
                duration_ms: r.try_get::<Option<f64>, _>(5).ok().flatten(),
                rows_examined: r
                    .try_get::<i64, _>(6)
                    .or_else(|_| r.try_get::<u64, _>(6).map(|v| v as i64))
                    .ok(),
                running: false,
                started_at_ms: None,
                fingerprint: String::new(),
            });
        }
        Ok(out)
    }

    /// digest (フィンガープリント) 単位の累積統計スナップショット (#746)。
    /// 2 つのソースを結合する:
    ///
    /// 1. `events_statements_summary_by_digest` — テキストプロトコルの文。
    ///    正規化 (digest 化) はサーバ側で完了しているのでそのまま読む。
    /// 2. `prepared_statements_instances` を `SQL_TEXT` で GROUP BY した合成行 —
    ///    **サーバサイド prepared statement (バイナリプロトコル) は digest 集計に
    ///    現れない** (MySQL 8.0.46 の既定構成で実測。`statement/com/Execute` は
    ///    digest を持たない) ため。prepared の文面は元々 `?` プレースホルダ付きで
    ///    実質正規化済み。digest キーは `ps-` 接頭辞 + MD5(SQL_TEXT)。接続が
    ///    閉じるとインスタンス行ごと消えてカウンタが逆行しうるが、フロントの
    ///    差分ロジックがリセットとして吸収する。
    ///
    /// 「記録開始からの差分」はフロント純ロジックが 2 スナップショットを
    /// 引き算して求めるので、ここでは常に累積値を返す。インスペクタ自身や
    /// introspection 由来の文 (`performance_schema` / `information_schema` 参照)
    /// は集計から除外する。
    pub async fn statement_stats(&self) -> Result<Vec<StatementStat>> {
        let rows: Vec<MySqlRow> = sqlx::query(
            r#"SELECT DIGEST,
                      DIGEST_TEXT,
                      SCHEMA_NAME,
                      COUNT_STAR,
                      SUM_TIMER_WAIT / 1e9,
                      MAX_TIMER_WAIT / 1e9,
                      SUM_ROWS_EXAMINED
               FROM performance_schema.events_statements_summary_by_digest
               WHERE DIGEST IS NOT NULL
                 AND DIGEST_TEXT NOT LIKE '%performance\_schema%'
                 AND DIGEST_TEXT NOT LIKE '%information\_schema%'
               ORDER BY SUM_TIMER_WAIT DESC
               LIMIT 500"#,
        )
        .fetch_all(&self.pool)
        .await?;
        let ps_rows: Vec<MySqlRow> = sqlx::query(
            r#"SELECT CONCAT('ps-', MD5(p.SQL_TEXT)),
                      p.SQL_TEXT,
                      CAST(NULL AS CHAR),
                      CAST(SUM(p.COUNT_EXECUTE) AS UNSIGNED),
                      SUM(p.SUM_TIMER_EXECUTE) / 1e9,
                      MAX(p.MAX_TIMER_EXECUTE) / 1e9,
                      CAST(SUM(p.SUM_ROWS_EXAMINED) AS UNSIGNED)
               FROM performance_schema.prepared_statements_instances p
               JOIN performance_schema.threads t ON t.THREAD_ID = p.OWNER_THREAD_ID
               WHERE p.COUNT_EXECUTE > 0
                 AND (t.PROCESSLIST_ID IS NULL OR t.PROCESSLIST_ID <> CONNECTION_ID())
                 AND p.SQL_TEXT NOT LIKE '%performance\_schema%'
                 AND p.SQL_TEXT NOT LIKE '%information\_schema%'
               GROUP BY p.SQL_TEXT
               ORDER BY SUM(p.SUM_TIMER_EXECUTE) DESC
               LIMIT 500"#,
        )
        .fetch_all(&self.pool)
        .await?;
        let mut out: Vec<StatementStat> = rows
            .into_iter()
            .chain(ps_rows)
            .map(|r| StatementStat {
                digest: r.try_get::<String, _>(0).unwrap_or_default(),
                fingerprint: r.try_get::<String, _>(1).unwrap_or_default(),
                database: r.try_get::<Option<String>, _>(2).ok().flatten(),
                calls: r
                    .try_get::<u64, _>(3)
                    .map(|v| v as i64)
                    .or_else(|_| r.try_get::<i64, _>(3))
                    .unwrap_or_default(),
                total_time_ms: r.try_get::<f64, _>(4).unwrap_or_default(),
                max_time_ms: r.try_get::<f64, _>(5).unwrap_or_default(),
                rows: r
                    .try_get::<u64, _>(6)
                    .map(|v| v as i64)
                    .or_else(|_| r.try_get::<i64, _>(6))
                    .ok(),
            })
            .collect();
        out.sort_by(|a, b| {
            b.total_time_ms
                .partial_cmp(&a.total_time_ms)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        out.truncate(500);
        Ok(out)
    }

    /// `KILL <id>` を 1 本のプール接続上で順に実行する (#1259)。`statement_only` のときは
    /// `KILL QUERY <id>` で実行中の文だけを止め、接続とトランザクション状態は残す。
    /// KILL はプレースホルダを
    /// 取れないが `id` は数値なので SQL インジェクションにならない。失敗しても残りは続行し、
    /// 件数と最初のエラーを返す。アプリ自身の接続 (`CONNECTION_ID()`) を巻き込むと
    /// 以降の KILL が打てなくなるため、自分自身の id は最後に回す。
    pub async fn kill_processes(
        &self,
        ids: &[i64],
        statement_only: bool,
    ) -> Result<KillProcessesResult> {
        let verb = if statement_only { "KILL QUERY" } else { "KILL" };
        let mut conn = self.pool.acquire().await?;
        let own = sqlx::query_scalar::<_, u64>("SELECT CONNECTION_ID()")
            .fetch_one(&mut *conn)
            .await
            .ok()
            .and_then(|v| i64::try_from(v).ok());
        let mut ordered: Vec<i64> = ids.iter().copied().filter(|id| Some(*id) != own).collect();
        // 文のみ停止では自分自身の接続を対象から外す (この KILL QUERY を打つ接続自体のため無意味)。
        // スキップは成功・失敗どちらにも数えない。
        if !statement_only {
            ordered.extend(ids.iter().copied().filter(|id| Some(*id) == own));
        }
        let mut out = KillProcessesResult::default();
        for id in ordered {
            match sqlx::query(sqlx::AssertSqlSafe(format!("{verb} {id}")))
                .execute(&mut *conn)
                .await
            {
                Ok(_) => out.killed += 1,
                Err(e) => out.record_failure(1, AppError::from(e).to_string()),
            }
        }
        Ok(out)
    }

    /// Server accounts for the users & permissions panel (#732), read from
    /// `mysql.user`. Requires `SELECT` on the `mysql` database (typically an
    /// admin-only grant) — a session without it surfaces the resulting sqlx
    /// error as-is; `errorHints.ts` maps the "command denied" wording to a
    /// hint.
    pub async fn list_db_users(&self) -> Result<Vec<DbUserInfo>> {
        let rows: Vec<MySqlRow> =
            sqlx::query("SELECT User, Host, Super_priv FROM mysql.user ORDER BY User, Host")
                .fetch_all(&self.pool)
                .await?;
        Ok(rows
            .into_iter()
            .map(|r| {
                let is_super = r
                    .try_get::<String, _>(2)
                    .map(|v| v.eq_ignore_ascii_case("Y"))
                    .unwrap_or(false);
                DbUserInfo {
                    name: r.try_get(0).unwrap_or_default(),
                    host: r.try_get::<Option<String>, _>(1).ok().flatten(),
                    attributes: if is_super {
                        vec!["SUPER".to_string()]
                    } else {
                        Vec::new()
                    },
                    member_of: Vec::new(),
                    is_superuser: is_super,
                    // `mysql.user` also has an `account_locked` column this
                    // panel does not read; login is reported as always
                    // allowed (best-effort — matching the minimal scope of
                    // the rest of this driver's introspection).
                    can_login: true,
                }
            })
            .collect())
    }

    /// The privilege matrix for one MySQL account: database-wide grants from
    /// `mysql.user`'s `Y`/`N` columns (the "global" row) plus per-table
    /// grants from `mysql.tables_priv` (`Table_priv` is a comma-separated
    /// `SET` column). `host` defaults to `%` (MySQL's "any host" wildcard)
    /// when not given.
    ///
    /// `database` を渡すと、テーブル別の行を `Db = ?` の WHERE で絞る (#1259)。
    /// 全 DB 分を受けて JS の `startsWith` で落としていた無駄な転送をなくす。
    /// global 行は `database` に関係なく常に返す。
    pub async fn user_privileges(
        &self,
        user: &str,
        host: Option<&str>,
        database: Option<&str>,
    ) -> Result<UserPrivileges> {
        let host = host.unwrap_or("%");
        let global_row: Option<MySqlRow> = sqlx::query(
            "SELECT Select_priv, Insert_priv, Update_priv, Delete_priv, Create_priv, \
             Alter_priv, Drop_priv, Index_priv, References_priv \
             FROM mysql.user WHERE User = ? AND Host = ?",
        )
        .bind(user)
        .bind(host)
        .fetch_optional(&self.pool)
        .await?;
        let global = global_row.map(|r| {
            let yn = |i: usize| {
                r.try_get::<String, _>(i)
                    .map(|v| v.eq_ignore_ascii_case("Y"))
                    .unwrap_or(false)
            };
            TablePrivilegeRow {
                table: "*".to_string(),
                select: yn(0),
                insert: yn(1),
                update: yn(2),
                delete: yn(3),
                ddl: yn(4) || yn(5) || yn(6) || yn(7) || yn(8),
            }
        });

        let table_rows: Vec<MySqlRow> = sqlx::query(
            "SELECT Db, Table_name, Table_priv FROM mysql.tables_priv \
             WHERE User = ? AND Host = ? AND (? IS NULL OR Db = ?) ORDER BY Db, Table_name",
        )
        .bind(user)
        .bind(host)
        .bind(database)
        .bind(database)
        .fetch_all(&self.pool)
        .await?;
        let tables = table_rows
            .into_iter()
            .map(|r| {
                let db: String = r.try_get(0).unwrap_or_default();
                let table: String = r.try_get(1).unwrap_or_default();
                let priv_set: String = r.try_get(2).unwrap_or_default();
                let has = |name: &str| {
                    priv_set
                        .split(',')
                        .any(|p| p.trim().eq_ignore_ascii_case(name))
                };
                TablePrivilegeRow {
                    table: format!("{db}.{table}"),
                    select: has("Select"),
                    insert: has("Insert"),
                    update: has("Update"),
                    delete: has("Delete"),
                    ddl: has("Create")
                        || has("Alter")
                        || has("Drop")
                        || has("Index")
                        || has("References"),
                }
            })
            .collect();

        Ok(UserPrivileges { global, tables })
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
                   LIMIT 1) AS REFERENCED_COLUMN_NAME,
                 c.COLUMN_COMMENT
               FROM information_schema.COLUMNS c
               WHERE c.TABLE_SCHEMA = ? AND c.TABLE_NAME = ?
               ORDER BY c.ORDINAL_POSITION"#,
        )
        .bind(db)
        .bind(table)
        .fetch_all(&self.pool)
        .await?;

        Ok(rows.iter().map(|r| column_info_from_row(r, 0)).collect())
    }

    /// 生成列 (STORED / VIRTUAL / PERSISTENT GENERATED) の列名 (#1600)。
    /// `TableColumnInfo::is_generated` と同じ判定を `EXTRA` で行う。
    pub async fn generated_columns(
        &self,
        database: Option<&str>,
        table: &str,
    ) -> Result<Vec<String>> {
        let database = database.filter(|d| !d.is_empty());
        let rows: Vec<(String,)> = sqlx::query_as(
            "SELECT COLUMN_NAME FROM information_schema.COLUMNS \
             WHERE TABLE_SCHEMA = COALESCE(?, DATABASE()) AND TABLE_NAME = ? \
               AND (UPPER(EXTRA) LIKE '%STORED GENERATED%' \
                 OR UPPER(EXTRA) LIKE '%VIRTUAL GENERATED%' \
                 OR UPPER(EXTRA) LIKE '%PERSISTENT GENERATED%') \
             ORDER BY ORDINAL_POSITION",
        )
        .bind(database)
        .bind(table)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(|(n,)| n).collect())
    }

    /// `db` の全テーブルの列を 1 回の問い合わせで取得する (#1255)。SQL は
    /// [`MySqlConn::columns`] の `TABLE_NAME = ?` 条件を外し、先頭にテーブル名を
    /// 足しただけなので、列ごとの値・並び (`ORDINAL_POSITION`) は同じになる。
    pub async fn columns_for_database(&self, db: &str) -> Result<Vec<super::diff::TableColumns>> {
        let rows: Vec<MySqlRow> = sqlx::query(
            r#"SELECT
                 c.TABLE_NAME,
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
                   LIMIT 1) AS REFERENCED_COLUMN_NAME,
                 c.COLUMN_COMMENT
               FROM information_schema.COLUMNS c
               WHERE c.TABLE_SCHEMA = ?
               ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION"#,
        )
        .bind(db)
        .fetch_all(&self.pool)
        .await?;
        let pairs = rows
            .iter()
            .map(|r| {
                (
                    r.try_get::<String, _>(0).unwrap_or_default(),
                    column_info_from_row(r, 1),
                )
            })
            .collect();
        Ok(super::group_columns_full(pairs))
    }

    /// `db` の全テーブルのインデックスを 1 回の問い合わせで取得する (#1255)。
    /// [`MySqlConn::list_indexes`] と同じ `STATISTICS` を `TABLE_SCHEMA = ?` だけで
    /// 引き、テーブル → インデックス名 → `SEQ_IN_INDEX` の順に並べる。
    pub async fn indexes_for_database(&self, db: &str) -> Result<Vec<super::types::TableIndexes>> {
        let rows: Vec<MySqlRow> = sqlx::query(
            r#"SELECT TABLE_NAME, INDEX_NAME, COLUMN_NAME, NON_UNIQUE, INDEX_TYPE, SEQ_IN_INDEX
               FROM information_schema.STATISTICS
               WHERE TABLE_SCHEMA = ?
               ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX"#,
        )
        .bind(db)
        .fetch_all(&self.pool)
        .await?;
        let index_rows = rows
            .iter()
            .map(|r| {
                let name = r.try_get::<String, _>(1).unwrap_or_default();
                super::IndexRow {
                    table: r.try_get::<String, _>(0).unwrap_or_default(),
                    column: r.try_get::<Option<String>, _>(2).ok().flatten(),
                    unique: r.try_get::<i64, _>(3).unwrap_or(1) == 0,
                    primary: name == "PRIMARY",
                    method: r.try_get::<Option<String>, _>(4).ok().flatten(),
                    predicate: None,
                    name,
                    ..Default::default()
                }
            })
            .collect();
        Ok(super::group_index_rows(index_rows))
    }

    /// テーブル / ビューのコメント (#1002)。`TABLE_COMMENT` はビューに対して
    /// 固定文字列 `VIEW` を返すため、基底テーブルだけを対象にする。
    pub async fn table_comments(&self, db: &str) -> Result<Vec<TableComment>> {
        let rows: Vec<MySqlRow> = sqlx::query(
            "SELECT TABLE_NAME, TABLE_COMMENT FROM information_schema.TABLES \
             WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' AND TABLE_COMMENT <> '' \
             ORDER BY TABLE_NAME",
        )
        .bind(db)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .iter()
            .filter_map(|r| {
                // サーバ版によって information_schema の列が文字列 / バイナリの
                // どちらで届くか揺れるため、両方を試す。
                let text = |i: usize| {
                    r.try_get::<String, _>(i)
                        .ok()
                        .or_else(|| decode_text_col(r, i).ok())
                };
                let name = text(0)?;
                let comment = non_empty_comment(text(1))?;
                Some(TableComment { name, comment })
            })
            .collect())
    }

    /// Row identity strategy for inline editing (#849). MySQL has no cheap
    /// physical row identifier exposed to SQL (unlike SQLite's `rowid` or
    /// PostgreSQL's `ctid`), so the only fallback once a table has no PK is
    /// matching every column in the WHERE clause.
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
        // KEY_COLUMN_USAGE carries the referencing/referenced column pairs;
        // rows with a non-NULL REFERENCED_TABLE_NAME are exactly the FK columns.
        // Ordering by CONSTRAINT_NAME then ORDINAL_POSITION keeps the columns of
        // a composite key together and in declaration order.
        let rows: Vec<MySqlRow> = sqlx::query(
            r#"SELECT k.TABLE_NAME, k.COLUMN_NAME, k.REFERENCED_TABLE_NAME,
                      k.REFERENCED_COLUMN_NAME, k.CONSTRAINT_NAME,
                      rc.DELETE_RULE, rc.UPDATE_RULE
               FROM information_schema.KEY_COLUMN_USAGE k
               LEFT JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
                 ON rc.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA
                AND rc.CONSTRAINT_NAME = k.CONSTRAINT_NAME
                AND rc.TABLE_NAME = k.TABLE_NAME
               WHERE k.TABLE_SCHEMA = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL
               ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION"#,
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
                // 参照動作は REFERENTIAL_CONSTRAINTS から (文字列 / バイナリの揺れに備える)。
                on_delete: super::types::normalize_fk_action(
                    r.try_get::<String, _>(5)
                        .ok()
                        .or_else(|| decode_text_col(&r, 5).ok())
                        .as_deref(),
                ),
                on_update: super::types::normalize_fk_action(
                    r.try_get::<String, _>(6)
                        .ok()
                        .or_else(|| decode_text_col(&r, 6).ok())
                        .as_deref(),
                ),
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

    /// ルーチンのシグネチャ (#1003)。存在確認と関数の戻り値型は
    /// `information_schema.ROUTINES`、パラメータは `information_schema.PARAMETERS`
    /// (`ORDINAL_POSITION = 0` は関数の戻り値行なので除外) から読む。
    pub async fn routine_signature(
        &self,
        db: &str,
        kind: &str,
        name: &str,
    ) -> Result<RoutineSignature> {
        let routine_type = if kind == "procedure" {
            "PROCEDURE"
        } else {
            "FUNCTION"
        };
        let head: Option<MySqlRow> = sqlx::query(
            "SELECT COALESCE(DTD_IDENTIFIER, '') FROM information_schema.ROUTINES \
             WHERE ROUTINE_SCHEMA = ? AND ROUTINE_NAME = ? AND ROUTINE_TYPE = ?",
        )
        .bind(db)
        .bind(name)
        .bind(routine_type)
        .fetch_optional(&self.pool)
        .await?;
        let Some(head) = head else {
            return Err(AppError::InvalidInput(format!(
                "routine not found: {db}.{name}"
            )));
        };
        let return_type = if kind == "function" {
            Some(text_or_bytes(&head, 0)?).filter(|t| !t.is_empty())
        } else {
            None
        };
        let rows: Vec<MySqlRow> = sqlx::query(
            "SELECT COALESCE(PARAMETER_MODE, ''), COALESCE(PARAMETER_NAME, ''), \
                    COALESCE(DTD_IDENTIFIER, '') \
               FROM information_schema.PARAMETERS \
              WHERE SPECIFIC_SCHEMA = ? AND SPECIFIC_NAME = ? AND ROUTINE_TYPE = ? \
                AND ORDINAL_POSITION > 0 \
              ORDER BY ORDINAL_POSITION",
        )
        .bind(db)
        .bind(name)
        .bind(routine_type)
        .fetch_all(&self.pool)
        .await?;
        let mut parameters = Vec::with_capacity(rows.len());
        for r in &rows {
            let mode = text_or_bytes(r, 0)?.to_ascii_lowercase();
            parameters.push(RoutineParameter {
                name: text_or_bytes(r, 1)?,
                // 関数の引数は PARAMETER_MODE が NULL (= IN 扱い)。
                mode: if mode.is_empty() { "in".into() } else { mode },
                data_type: text_or_bytes(r, 2)?,
            });
        }
        Ok(RoutineSignature {
            kind: kind.into(),
            name: name.into(),
            parameters,
            returns_set: false,
            return_type,
        })
    }

    pub async fn object_definition(&self, db: &str, kind: &str, name: &str) -> Result<String> {
        if db.contains('`') || db.contains('\0') || name.contains('`') || name.contains('\0') {
            return Err(AppError::InvalidInput("invalid identifier".into()));
        }
        // SHOW CREATE ... can't bind identifiers; quote them manually after the
        // guard above. The result column holding the DDL differs by object kind.
        let qualified = format!("`{db}`.`{name}`");
        if kind == "table" {
            // #1001: `SHOW CREATE TABLE` はネイティブの完全な DDL (列・キー・
            // インデックス・外部キー・ENGINE/CHARSET/COMMENT) を返す。テーブル
            // 一覧にはビューも含まれ、ビューに対しては同じ文が `Create View`
            // 列で応答するため、両方の列名を試す。
            let row: MySqlRow = sqlx::query(sqlx::AssertSqlSafe(format!(
                "SHOW CREATE TABLE {qualified}"
            )))
            .fetch_one(&self.pool)
            .await?;
            let ddl = show_create_text(&row, &["Create Table", "Create View"])?;
            return Ok(super::table_ddl::join_native_statements([ddl]));
        }
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
        show_create_text(&row, &[col])
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
                    predicate: None,
                    first_expression_at: None,
                    ..Default::default()
                }
            });
            match column {
                Some(col) => entry.columns.push(col),
                // 関数インデックス (8.0.13+) のキーは COLUMN_NAME が NULL。
                None => {
                    entry.first_expression_at.get_or_insert(entry.columns.len());
                }
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

    /// 全スキーマの (スキーマ, テーブル, 列) を 1 回の問い合わせで返す (#1261)。
    /// [`MySqlConn::schema_overview`] の `TABLE_SCHEMA = ?` を外しただけの SQL で、
    /// グローバルオブジェクト検索の索引構築が DB 数ぶんの往復をしないために使う。
    pub async fn schema_columns_all(&self) -> Result<Vec<(String, String, String)>> {
        let rows: Vec<MySqlRow> = sqlx::query(
            r#"SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME
               FROM information_schema.COLUMNS
               ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION"#,
        )
        .fetch_all(&self.pool)
        .await?;
        rows.iter()
            .map(|r| {
                Ok((
                    decode_text_col(r, 0)?,
                    decode_text_col(r, 1)?,
                    decode_text_col(r, 2)?,
                ))
            })
            .collect()
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

    /// 1 テーブル分の行数推定 (#1263)。`table_row_estimates` と同じ値・同じ
    /// 判定 (BASE TABLE のみ) を `TABLE_NAME = ?` で 1 件に絞って取得する。
    /// テーブルが無い / ビュー / 統計なしは `None`。
    pub async fn table_row_estimate(&self, db: &str, table: &str) -> Result<Option<i64>> {
        let row: Option<MySqlRow> = sqlx::query(
            r#"SELECT TABLE_ROWS
               FROM information_schema.TABLES
               WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND TABLE_TYPE = 'BASE TABLE'"#,
        )
        .bind(db)
        .bind(table)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.and_then(|r| {
            r.try_get::<Option<u64>, _>(0)
                .ok()
                .flatten()
                .map(|v| v as i64)
        }))
    }

    /// 全データベースのテーブル (とビュー) を SQL 1 本で取得する (#1263)。
    /// `(データベース名, テーブル名)` の組を DB 名 → テーブル名順で返す。
    /// `tables` (`SHOW TABLES IN`) と同じく、ビューも含む。
    pub async fn tables_all(&self) -> Result<Vec<(String, String)>> {
        let rows: Vec<MySqlRow> = sqlx::query(
            r#"SELECT TABLE_SCHEMA, TABLE_NAME
               FROM information_schema.TABLES
               ORDER BY TABLE_SCHEMA, TABLE_NAME"#,
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .iter()
            .map(|r| {
                (
                    r.try_get::<String, _>(0).unwrap_or_default(),
                    r.try_get::<String, _>(1).unwrap_or_default(),
                )
            })
            .collect())
    }

    pub async fn table_sizes(&self, db: &str) -> Result<Vec<TableSizeInfo>> {
        // information_schema.TABLES carries the engine's own size accounting:
        // DATA_LENGTH / INDEX_LENGTH are BIGINT UNSIGNED byte counts maintained
        // by the storage engine (approximate for InnoDB), so no table scan is
        // needed. TABLE_ROWS is the same estimate `table_row_estimates` uses.
        // Restricting to BASE TABLE skips views (whose lengths are NULL).
        let rows: Vec<MySqlRow> = sqlx::query(
            r#"SELECT TABLE_NAME, TABLE_ROWS, DATA_LENGTH, INDEX_LENGTH
               FROM information_schema.TABLES
               WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
               ORDER BY TABLE_NAME"#,
        )
        .bind(db)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|r| {
                let data = r
                    .try_get::<Option<u64>, _>(2)
                    .ok()
                    .flatten()
                    .map(|v| v as i64);
                let index = r
                    .try_get::<Option<u64>, _>(3)
                    .ok()
                    .flatten()
                    .map(|v| v as i64);
                TableSizeInfo {
                    name: r.try_get::<String, _>(0).unwrap_or_default(),
                    row_estimate: r
                        .try_get::<Option<u64>, _>(1)
                        .ok()
                        .flatten()
                        .map(|v| v as i64),
                    data_bytes: data,
                    index_bytes: index,
                    total_bytes: super::sum_size_parts(data, index),
                }
            })
            .collect())
    }

    /// バージョン文字列だけを返す (`server_info` の先頭と同じクエリ)。
    pub async fn server_version(&self) -> Result<String> {
        Ok(sqlx::query_scalar::<_, String>("SELECT VERSION()")
            .fetch_one(&self.pool)
            .await?)
    }

    pub async fn server_info(&self) -> Result<ServerInfo> {
        let version: String = sqlx::query_scalar("SELECT VERSION()")
            .fetch_one(&self.pool)
            .await
            .unwrap_or_default();
        // SHOW VARIABLES returns every server variable as (Variable_name, Value);
        // the panel makes the full set searchable. Values can be NULL for a few
        // variables, which we render as an empty string. Secret-named variables
        // are masked as defense-in-depth (#563).
        let rows: Vec<MySqlRow> = sqlx::query("SHOW VARIABLES").fetch_all(&self.pool).await?;
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

    /// 接続ヘルス (`health_probe_all`, #1259) 専用の軽量な接続数取得。
    /// `server_metrics` は `SHOW GLOBAL STATUS` の全行を返すが、ヘルス表示に要るのは
    /// `Threads_connected` だけなので `LIKE` で 1 行に絞る。
    pub async fn connection_count(&self) -> Result<Option<i64>> {
        let row: Option<MySqlRow> = sqlx::query("SHOW GLOBAL STATUS LIKE 'Threads_connected'")
            .fetch_optional(&self.pool)
            .await?;
        Ok(row
            .and_then(|r| r.try_get::<Option<String>, _>(1).ok().flatten())
            .and_then(|v| v.trim().parse::<i64>().ok()))
    }

    /// 監視ダッシュボード (#731) 用の 1 サンプル。`SHOW GLOBAL STATUS` の
    /// メモリ上カウンタを 1 回で読み、必要な変数だけ拾う (テーブル I/O なし)。
    /// スループット (`Questions`) やロック待ち (`Innodb_row_lock_waits`) は累積
    /// カウンタで、レートへの変換はフロントが 2 サンプルの差分から行う。
    pub async fn server_metrics(&self) -> Result<ServerMetrics> {
        // Variable_name / Value の全行を大小無視のマップにする。値は文字列
        // (数値カウンタも文字列で返る) なので try_get::<String> で受ける。
        let rows: Vec<MySqlRow> = sqlx::query("SHOW GLOBAL STATUS")
            .fetch_all(&self.pool)
            .await?;
        let mut status: std::collections::HashMap<String, String> =
            std::collections::HashMap::with_capacity(rows.len());
        for r in rows {
            let name = r.try_get::<String, _>(0).unwrap_or_default();
            if name.is_empty() {
                continue;
            }
            if let Some(value) = r.try_get::<Option<String>, _>(1).ok().flatten() {
                status.insert(name.to_ascii_lowercase(), value);
            }
        }
        // カウンタ値の取り出し (欠損/非数値は None に縮退)。
        let g = |key: &str| status.get(key).and_then(|v| v.trim().parse::<i64>().ok());
        Ok(ServerMetrics {
            connections: g("threads_connected"),
            active: g("threads_running"),
            // MySQL に PostgreSQL 的な "idle in transaction" 状態のゲージは無い。
            idle_in_transaction: None,
            lock_waiting: g("innodb_row_lock_current_waits"),
            questions: g("questions"),
            slow_queries: g("slow_queries"),
            lock_waits: g("innodb_row_lock_waits"),
        })
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

/// `processlist.STATE` がロック待ち (`Waiting for table metadata lock` /
/// `Waiting for global read lock` など) を示すか (#1417)。メタデータロック照会の要否判定。
fn state_suggests_lock_wait(state: &str) -> bool {
    let s = state.trim().to_ascii_lowercase();
    s.starts_with("waiting for") && s.ends_with("lock")
}

/// `metadata_locks` の PENDING 行と、同じ対象に対する他スレッドの行 (GRANTED / PENDING) の組。
#[derive(Debug, Clone, PartialEq, Eq)]
struct MdlCandidate {
    waiter: i64,
    holder: i64,
    waiter_lock: String,
    holder_lock: String,
    object_type: String,
    holder_pending: bool,
}

/// MDL のオブジェクトロック種別 (MySQL `sql/mdl.cc` の S/SH/SR/SW/SWLP/SU/SRO/SNW/SNRW/X) の
/// 添字。performance_schema の `LOCK_TYPE` 名から引く。
fn mdl_object_lock_index(name: &str) -> Option<usize> {
    Some(match name {
        "SHARED" => 0,
        "SHARED_HIGH_PRIO" => 1,
        "SHARED_READ" => 2,
        "SHARED_WRITE" => 3,
        "SHARED_WRITE_LOW_PRIO" => 4,
        "SHARED_UPGRADABLE" => 5,
        "SHARED_READ_ONLY" => 6,
        "SHARED_NO_WRITE" => 7,
        "SHARED_NO_READ_WRITE" => 8,
        "EXCLUSIVE" => 9,
        _ => return None,
    })
}

/// 取得済み (GRANTED) のロックに対し、要求 (行) が互換でないか。`mdl.cc` の
/// granted 互換行列 (`+` = 互換) を `true` = 衝突で表す。添字は [`mdl_object_lock_index`]。
const MDL_OBJECT_CONFLICT: [[bool; 10]; 10] = {
    const O: bool = false; // 互換
    const X: bool = true; // 衝突
    [
        //  S  SH SR SW SWLP SU SRO SNW SNRW X
        [O, O, O, O, O, O, O, O, O, X], // S
        [O, O, O, O, O, O, O, O, O, X], // SH
        [O, O, O, O, O, O, O, O, X, X], // SR
        [O, O, O, O, O, O, X, X, X, X], // SW
        [O, O, O, O, O, O, X, X, X, X], // SWLP
        [O, O, O, O, O, X, O, X, X, X], // SU
        [O, O, O, X, X, O, O, O, X, X], // SRO
        [O, O, O, X, X, X, O, X, X, X], // SNW
        [O, O, X, X, X, X, X, X, X, X], // SNRW
        [X, X, X, X, X, X, X, X, X, X], // X
    ]
};

/// 待ち側の行列 (`m_waiting_incompatible[0]`)。行 = 要求 (PENDING の待ち手)、列 = 先に並んでいる
/// 他スレッドの PENDING で、`true` = その PENDING の後ろで待たされる。添字は
/// [`mdl_object_lock_index`] (S SH SR SW SWLP SU SRO SNW SNRW X)。`max_write_lock_count` が
/// 既定値 (非常に大きい) で、piglet / hog の切替が起きていない前提の既定行列。
/// 一次情報: MySQL 8.0 `sql/mdl.cc` の `MDL_lock::m_object_lock_strategy`
/// (コメントの表は古く、実際のビットマップはこちらの内容)。
const MDL_OBJECT_WAIT_CONFLICT: [[bool; 10]; 10] = {
    const O: bool = false;
    const X: bool = true;
    [
        //  S  SH SR SW SWLP SU SRO SNW SNRW X
        [O, O, O, O, O, O, O, O, O, X], // S
        [O, O, O, O, O, O, O, O, O, O], // SH
        [O, O, O, O, O, O, O, O, X, X], // SR
        [O, O, O, O, O, O, O, X, X, X], // SW
        [O, O, O, O, O, O, X, X, X, X], // SWLP
        [O, O, O, O, O, O, O, O, O, X], // SU
        [O, O, O, X, O, O, O, O, X, X], // SRO
        [O, O, O, O, O, O, O, O, O, X], // SNW
        [O, O, O, O, O, O, O, O, O, X], // SNRW
        [O, O, O, O, O, O, O, O, O, O], // X
    ]
};

/// `mdl.cc` の `get_strategy` でスコープロック扱いになる名前空間か。performance_schema の
/// `OBJECT_TYPE` 名 (GLOBAL / SCHEMA / COMMIT / TABLESPACE / BACKUP LOCK / RESOURCE GROUPS /
/// FOREIGN KEY / CHECK CONSTRAINT) で判定し、それ以外 (TABLE / FUNCTION / PROCEDURE / TRIGGER /
/// EVENT など) はオブジェクトロック扱い。
fn mdl_is_scoped(object_type: &str) -> bool {
    matches!(
        object_type,
        "GLOBAL"
            | "TABLESPACE"
            | "SCHEMA"
            | "COMMIT"
            | "BACKUP LOCK"
            | "RESOURCE GROUPS"
            | "FOREIGN KEY"
            | "CHECK CONSTRAINT"
    )
}

/// スコープロックの GRANTED 衝突 (`m_granted_incompatible`): IX は S / X と、S は IX / X と、
/// X は全てと衝突する。
fn mdl_scope_conflict(a: &str, b: &str) -> bool {
    matches!(
        (a, b),
        ("EXCLUSIVE", _)
            | (_, "EXCLUSIVE")
            | ("INTENTION_EXCLUSIVE", "SHARED")
            | ("SHARED", "INTENTION_EXCLUSIVE")
    )
}

/// スコープロックの待ち側 (`m_waiting_incompatible[0]`): IX 要求は PENDING の S / X に、
/// S 要求は PENDING の X に止められる。X 要求は止められない。
fn mdl_scope_wait_conflict(waiter: &str, pending: &str) -> bool {
    matches!(
        (waiter, pending),
        ("INTENTION_EXCLUSIVE", "SHARED" | "EXCLUSIVE") | ("SHARED", "EXCLUSIVE")
    )
}

/// `waiter_lock` を待っている要求が、`holder_lock` の保持者 (または先に並ぶ待ち) に
/// ブロックされるか (#1417)。GRANTED の保持者には granted 互換行列
/// (`m_granted_incompatible`)、他スレッドの PENDING には待ち側の行列
/// (`m_waiting_incompatible[0]`) を使う。
fn mdl_blocks(
    object_type: &str,
    waiter_lock: &str,
    holder_lock: &str,
    holder_pending: bool,
) -> bool {
    if mdl_is_scoped(object_type) {
        return if holder_pending {
            mdl_scope_wait_conflict(waiter_lock, holder_lock)
        } else {
            mdl_scope_conflict(waiter_lock, holder_lock)
        };
    }
    let (Some(w), Some(h)) = (
        mdl_object_lock_index(waiter_lock),
        mdl_object_lock_index(holder_lock),
    ) else {
        return false;
    };
    if holder_pending {
        MDL_OBJECT_WAIT_CONFLICT[w][h]
    } else {
        MDL_OBJECT_CONFLICT[w][h]
    }
}

/// [`MdlCandidate`] から、実際に待ちが発生している `(待つ側, ブロッカー)` の組だけを返す。
fn mdl_wait_pairs(cands: &[MdlCandidate]) -> Vec<(i64, i64)> {
    cands
        .iter()
        .filter(|c| {
            mdl_blocks(
                &c.object_type,
                &c.waiter_lock,
                &c.holder_lock,
                c.holder_pending,
            )
        })
        .map(|c| (c.waiter, c.holder))
        .collect()
}

/// `(待たされている id, ブロッカー id)` の組を、待たされている id ごとのブロッカー一覧へ
/// まとめる (#1417)。重複は除き、自己参照は捨てる。
fn blocked_by_map(pairs: Vec<(i64, i64)>) -> std::collections::HashMap<i64, Vec<i64>> {
    let mut map: std::collections::HashMap<i64, Vec<i64>> = std::collections::HashMap::new();
    for (waiter, blocker) in pairs {
        if waiter == blocker {
            continue;
        }
        let entry = map.entry(waiter).or_default();
        if !entry.contains(&blocker) {
            entry.push(blocker);
        }
    }
    map
}

/// Decides whether `list_processes` must fall back from
/// `performance_schema.processlist` to `information_schema.PROCESSLIST`
/// (#587). A query error (table missing on pre-8.0.22 / MariaDB) always
/// warrants the fallback; a *successful but empty* result does too, because
/// with `performance_schema = OFF` the table still exists and the query still
/// succeeds, yet collects nothing — and an empty processlist is impossible
/// since the connection running this very query always appears in it.
/// Split out as a pure, generic function so the branch selection is
/// unit-testable without a live server (#641).
fn process_list_needs_fallback<T>(primary: &std::result::Result<Vec<T>, sqlx::Error>) -> bool {
    match primary {
        Ok(rows) => rows.is_empty(),
        Err(_) => true,
    }
}

/// MySQL の真偽値式は整数 0/1 で届く (`list_processes` の is_self と同じ)。
/// tinyint/bigint のどちらで返っても拾えるようにフォールバックしてデコードする。
fn decode_int_bool(row: &MySqlRow, i: usize) -> bool {
    row.try_get::<i64, _>(i)
        .or_else(|_| row.try_get::<i32, _>(i).map(i64::from))
        .map(|v| v != 0)
        .unwrap_or(false)
}

/// Maps the driver-neutral [`SslMode`] to MySQL's `MySqlSslMode`. `VerifyFull`
/// maps to `VerifyIdentity` (the MySQL equivalent of full hostname verification).
fn map_ssl_mode(mode: SslMode) -> MySqlSslMode {
    match mode {
        SslMode::Disable => MySqlSslMode::Disabled,
        SslMode::Prefer => MySqlSslMode::Preferred,
        SslMode::Require => MySqlSslMode::Required,
        SslMode::VerifyCa => MySqlSslMode::VerifyCa,
        SslMode::VerifyFull => MySqlSslMode::VerifyIdentity,
    }
}

/// Applies the TLS settings from `opts` to the connect options. `ssl_mode` is
/// left untouched when `None` (sqlx defaults to `preferred`); empty certificate
/// paths are ignored so a blank field behaves like "unset".
fn apply_tls(mut connect: MySqlConnectOptions, opts: &DbConnectOptions) -> MySqlConnectOptions {
    // AWS IAM 認証 (#734) は TLS 必須。`build_options` でも強制しているが、
    // ドライバ層でも require 以上を保証する (多層防御)。
    let mode = match opts.aws_iam {
        Some(_) => Some(super::aws_iam::enforce_tls(opts.ssl_mode)),
        None => opts.ssl_mode,
    };
    if let Some(mode) = mode {
        connect = connect.ssl_mode(map_ssl_mode(mode));
    }
    if let Some(ca) = non_empty(&opts.ssl_root_cert) {
        connect = connect.ssl_ca(ca);
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

async fn apply_use_database(
    conn: &mut PoolConnection<MySql>,
    database: Option<&str>,
) -> Result<()> {
    apply_use_database_on(conn, database).await
}

async fn apply_use_database_on(
    conn: &mut sqlx::MySqlConnection,
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
    sqlx::Executor::execute(&mut *conn, sqlx::raw_sql(sqlx::AssertSqlSafe(sql))).await?;
    Ok(())
}

// MySQL 8 marks the `Database` column of `SHOW DATABASES` (and `Tables_in_*`
// from `SHOW TABLES`) with the BINARY flag, which makes sqlx's `String`
// decoder refuse the column. Read raw bytes and convert manually so the same
// code works across MySQL 8 and MariaDB.
/// information_schema の文字列列を読む。サーバ/照合順序によって VARCHAR でも
/// VARBINARY でも返りうるため、String で読めなければバイト列として UTF-8 解釈する。
/// `SHOW CREATE ...` の結果行から DDL 本文を読む。`names` の列を順に試し、文字列で
/// 読めなければ UTF-8 のバイト列として読み直す。どれも読めないときは空文字列に
/// せずエラーとして返す (空の定義と取得失敗を区別する、#1614)。
fn show_create_text(row: &MySqlRow, names: &[&str]) -> Result<String> {
    let mut last: Option<AppError> = None;
    for name in names {
        match row.try_get::<String, _>(*name) {
            Ok(s) => return Ok(s),
            Err(first) => match row.try_get::<Vec<u8>, _>(*name) {
                Ok(bytes) => match String::from_utf8(bytes) {
                    Ok(s) => return Ok(s),
                    Err(e) => {
                        last = Some(AppError::Other(format!(
                            "定義の文字コードを解釈できません: {e}"
                        )))
                    }
                },
                Err(_) => last = Some(AppError::from(first)),
            },
        }
    }
    Err(last.unwrap_or_else(|| AppError::Other("定義の列が見つかりません".into())))
}

fn text_or_bytes(row: &MySqlRow, i: usize) -> Result<String> {
    match row.try_get::<String, _>(i) {
        Ok(s) => Ok(s),
        Err(_) => decode_text_col(row, i),
    }
}

/// `columns` / `columns_for_database` 共通の列メタデータ行の読み取り。`off` は
/// 先頭の `COLUMN_NAME` の列位置 (全テーブル版は先頭にテーブル名が付くので 1)。
fn column_info_from_row(r: &MySqlRow, off: usize) -> TableColumnInfo {
    TableColumnInfo {
        name: r.try_get::<String, _>(off).unwrap_or_default(),
        data_type: r.try_get::<String, _>(off + 1).unwrap_or_default(),
        nullable: r
            .try_get::<String, _>(off + 2)
            .map(|s| s.eq_ignore_ascii_case("YES"))
            .unwrap_or(false),
        key: r.try_get::<String, _>(off + 3).unwrap_or_default(),
        default: r.try_get::<Option<String>, _>(off + 4).ok().flatten(),
        extra: r.try_get::<String, _>(off + 5).unwrap_or_default(),
        referenced_table: r.try_get::<Option<String>, _>(off + 6).ok().flatten(),
        referenced_column: r.try_get::<Option<String>, _>(off + 7).ok().flatten(),
        // #1002: コメント無しは空文字で返るので None にそろえる。
        comment: non_empty_comment(r.try_get::<Option<String>, _>(off + 8).ok().flatten()),
    }
}

fn decode_text_col(row: &MySqlRow, i: usize) -> Result<String> {
    let bytes: Vec<u8> = row.try_get(i)?;
    String::from_utf8(bytes).map_err(|e| AppError::Other(e.to_string()))
}

/// Run one statement on a specific connection and decode it. Shared by
/// `execute` (pool connection) and `tx_execute` (held transaction connection).
/// Handles CALL (which may or may not return a result set) like `execute`.
/// デッドロック (1213) か。書き込みキャプチャの行ロック取得が競合したときに、記録を辞退して
/// トランザクションを張り直す判定に使う (#1536)。
fn is_deadlock(e: &AppError) -> bool {
    let m = e.to_string();
    m.contains("Deadlock found") || m.contains("1213 (40001)")
}

/// ロック待ちタイムアウト (1205) か。
fn is_lock_wait_timeout(e: &AppError) -> bool {
    let m = e.to_string();
    m.contains("Lock wait timeout exceeded") || m.contains("1205 (HY000)")
}

/// 書き込み文を 1 回実行し、その OK パケットの `last_insert_id` (採番が無ければ 0) を併せて
/// 返す。`run_sql_on` と同じ結果 (警告つき) を返すが、行を返す形 (`RETURNING` 等) は
/// 通常経路に任せて id は 0 とする。書き込みキャプチャの INSERT 特定用 (#1536)。
async fn run_write_with_insert_id(
    conn: &mut sqlx::MySqlConnection,
    sql: &str,
) -> Result<(QueryResult, u64)> {
    if is_call_shape(sql) || is_query_shape(sql) {
        return Ok((run_sql_on(conn, sql).await?, 0));
    }
    let started = Instant::now();
    let result = sqlx::query(sqlx::AssertSqlSafe(sql))
        .execute(&mut *conn)
        .await?;
    let id = result.last_insert_id();
    let messages = fetch_warnings(conn).await;
    Ok((
        QueryResult::empty(result.rows_affected(), started.elapsed().as_millis() as u64)
            .with_server_messages(messages),
        id,
    ))
}

/// `column` が `target` の AUTO_INCREMENT 列か (`SHOW COLUMNS` の Extra)。`last_insert_id`
/// が主キー以外の採番列のものでないことの確認に使う。判定できなければ `false`。
async fn pk_is_auto_increment(
    conn: &mut sqlx::MySqlConnection,
    target: &str,
    column: &str,
) -> bool {
    let sql = format!(
        "SHOW COLUMNS FROM {} WHERE Field = '{}'",
        target,
        column.replace('\\', "\\\\").replace('\'', "''")
    );
    let Ok(rows) = sqlx::query(sqlx::AssertSqlSafe(sql))
        .fetch_all(&mut *conn)
        .await
    else {
        return false;
    };
    rows.first()
        .and_then(|r| r.try_get_unchecked::<Vec<u8>, _>("Extra").ok())
        .map(|b| String::from_utf8_lossy(&b).to_ascii_lowercase())
        .is_some_and(|extra| extra.contains("auto_increment"))
}

async fn run_sql_on(conn: &mut sqlx::MySqlConnection, sql: &str) -> Result<QueryResult> {
    let started = Instant::now();
    if is_call_shape(sql) {
        return collect_call(conn, sql, started).await;
    }
    if is_query_shape(sql) {
        let rows: Vec<MySqlRow> = sqlx::query(sqlx::AssertSqlSafe(sql))
            .fetch_all(&mut *conn)
            .await?;
        let columns = if rows.is_empty() {
            // 0 行でも列見出しを返す (#1534)。
            super::prepared_columns!(conn, sql)
        } else {
            columns_of(&rows)
        };
        let rows_out = rows.iter().map(row_to_values).collect();
        Ok(QueryResult {
            columns,
            rows: rows_out,
            rows_affected: 0,
            elapsed_ms: started.elapsed().as_millis() as u64,
            server_messages: Vec::new(),
        })
    } else {
        let result = sqlx::query(sqlx::AssertSqlSafe(sql))
            .execute(&mut *conn)
            .await?;
        // 書き込み文の直後に警告を取る (#1165)。
        let messages = fetch_warnings(conn).await;
        Ok(
            QueryResult::empty(result.rows_affected(), started.elapsed().as_millis() as u64)
                .with_server_messages(messages),
        )
    }
}

/// 直前の文が出した警告を取得する (#1165)。まず `SHOW COUNT(*) WARNINGS` (診断領域を
/// 消さない軽量な問い合わせ) で件数を見て、0 のときは何もしない。1 件以上あるときだけ
/// `SHOW WARNINGS` を発行する。sqlx の `MySqlQueryResult` は OK パケットの
/// `warning_count` を公開しないため、この 2 段構えで「警告がある文だけ」全文を取る。
///
/// 補助的な情報なので、取得に失敗しても文自体の成否には影響させず空を返す。
/// `SHOW` は読み取り専用文なので `read_only` ガードとも干渉しない (ユーザ文ではない)。
async fn fetch_warnings(conn: &mut sqlx::MySqlConnection) -> Vec<ServerMessage> {
    let count = match sqlx::raw_sql("SHOW COUNT(*) WARNINGS")
        .fetch_all(&mut *conn)
        .await
    {
        Ok(rows) => rows
            .first()
            .and_then(|r| r.try_get::<i64, _>(0).ok())
            // 件数を読めなかったときは、取りこぼすより SHOW WARNINGS に進む。
            .unwrap_or(1),
        Err(_) => return Vec::new(),
    };
    if count <= 0 {
        return Vec::new();
    }
    match sqlx::raw_sql("SHOW WARNINGS").fetch_all(&mut *conn).await {
        Ok(rows) => {
            let cap = super::server_messages::MAX_SERVER_MESSAGES;
            let mut out: Vec<ServerMessage> = rows
                .iter()
                .take(cap)
                .filter_map(|r| {
                    let level: String = r.try_get(0).ok()?;
                    let message: String = r.try_get(2).ok()?;
                    let code: Option<u32> = r.try_get(1).ok();
                    Some(warning_to_message(&level, code, &message))
                })
                .collect();
            if rows.len() > cap {
                out.push(super::server_messages::omitted_message(rows.len() - cap));
            }
            out
        }
        Err(_) => Vec::new(),
    }
}

/// `SHOW WARNINGS` の 1 行 (Level / Code / Message) を [`ServerMessage`] へ変換する。
/// Level は `Note` → info、`Warning` → warning、`Error` → error (未知の値は info)。
/// Code があれば `[1265] ...` の形で本文の先頭に付ける。
fn warning_to_message(level: &str, code: Option<u32>, message: &str) -> ServerMessage {
    let severity = match level.to_ascii_lowercase().as_str() {
        "error" => ServerMessageSeverity::Error,
        "warning" => ServerMessageSeverity::Warning,
        _ => ServerMessageSeverity::Info,
    };
    let text = match code {
        Some(c) => format!("[{c}] {message}"),
        None => message.to_string(),
    };
    ServerMessage { severity, text }
}

fn row_to_values(row: &MySqlRow) -> Vec<Value> {
    (0..row.columns().len())
        .map(|i| decode_cell(row, i))
        .collect()
}

/// 1 セルをデコードし、安全整数の外の `Int` / `UInt` を返していないことを
/// debug ビルドで検査する (#1422。[`Value::debug_assert_js_safe`])。
fn decode_cell(row: &MySqlRow, i: usize) -> Value {
    decode_cell_unchecked(row, i).debug_assert_js_safe()
}

fn decode_cell_unchecked(row: &MySqlRow, i: usize) -> Value {
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
            // BIGINT は 2^53 を超えうる。`Value` は `#[serde(untagged)]` なので
            // そのまま `Value::Int` にすると JSON の素の数値として送られ、
            // フロントの `JSON.parse` で丸められて**別の値**になる (表示だけで
            // なく、インラインセル編集が組み立てる `WHERE pk = …` まで狂う)。
            // 安全整数の外は十進文字列へ退避する。
            return v.map(Value::from_i64_lossless).unwrap_or(Value::Null);
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
            // BIGINT UNSIGNED も同様に安全整数を超えうる
            // (`Value::from_i64_lossless` の符号なし版へ)。
            return v.map(Value::from_u64_lossless).unwrap_or(Value::Null);
        }
    }
    if ti(type_name, &["FLOAT"]) {
        // 単精度。f64 で読むと f32 の丸め誤差ごと広がる (`3.14` → `3.140000104904175`) ので、
        // f32 で読んで最短表記経由で広げる (#1534)。
        if let Ok(v) = row.try_get::<Option<f32>, _>(i) {
            return v.map(Value::from_f32_shortest).unwrap_or(Value::Null);
        }
    }
    if ti(type_name, &["DOUBLE"]) {
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
        // rust_decimal::Decimal は有効桁数が約 28〜29 桁までで、MySQL の
        // DECIMAL(65, x) のような広い精度の値は範囲外になり得る。MySQL の
        // ワイヤプロトコルは DECIMAL/NEWDECIMAL を常にテキスト (10 進数の
        // 文字列そのもの) として送るため、`&str`/`String` の Decode
        // 実装は型チェックさえ通れば元のテキストをそのまま返す。ただし
        // `String::compatible` は NEWDECIMAL を文字列系カラム型として
        // 認識しないため通常の `try_get` は型不一致で弾かれる —
        // `try_get_unchecked` でその互換性チェックだけを迂回し、実体は
        // 引き続き sqlx の `&str` デコード (=生テキスト読み出し) を使う。
        // これにより範囲外の値も生バイナリ (Value::Bytes) に落ちず、
        // 人間可読な数値文字列として表示できる。
        if let Ok(v) = row.try_get_unchecked::<Option<String>, _>(i) {
            return v.map(Value::String).unwrap_or(Value::Null);
        }
    }
    if ti(type_name, &["DATE", "TIME", "DATETIME", "TIMESTAMP"]) {
        // Each chrono type is `compatible` with exactly one MySQL column type
        // (see sqlx-mysql `types::chrono`): DATETIME→NaiveDateTime,
        // TIMESTAMP→DateTime<Utc>, DATE→NaiveDate, TIME→NaiveTime. A mismatched
        // `try_get` errors on the compatibility check, so we must try the right
        // one for each — notably TIMESTAMP and TIME are NOT decodable as
        // NaiveDateTime.
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
        // `serde_json::Value` を経由した再シリアライズはオブジェクトのキーを
        // 並べ替える (`preserve_order` 無効の既定では `Map` が `BTreeMap` =
        // 辞書順)。PostgreSQL 側 (`db::postgres`) ではこれが実害になるため
        // サーバの返す JSON テキストをそのまま返すよう直したが、**MySQL は
        // 現状維持**とする: MySQL は JSON 型を保存時にバイナリ表現へ正規化
        // し、その際オブジェクトのキーを (長さ → バイト順で) 並べ替えるため、
        // 著者が書いた順序はサーバ到達時点で既に失われており、クライアント側で
        // 復元する術が無い。並べ替えの規則が MySQL の正規化順と厳密には
        // 一致しない点は許容する (JSON としての等価性は保たれる)。
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
    decode_string_or_bytes(row, i)
}

/// `VIEW_TABLE_USAGE` の結果の扱い。`Ok(None)` は 0 件 (定義の解析で補う)、`Err` は
/// 種別が空の行 (権限がなく TABLES に見えない基底表) を含む → 確認できないので拒否。
fn classify_usage_rows(rows: Vec<ViewBase>) -> Result<Option<Vec<ViewBase>>> {
    if rows.is_empty() {
        return Ok(None);
    }
    if rows.iter().any(|(_, _, t, _)| t.is_empty()) {
        return Err(AppError::ViewBaseUnresolved);
    }
    Ok(Some(rows))
}

/// ビューの基底表 1 件: `(スキーマ, 名前, TABLE_TYPE, ENGINE)`。
type ViewBase = (String, String, String, Option<String>);

/// `information_schema.VIEWS.VIEW_DEFINITION` (MySQL / MariaDB が正規化した定義) から
/// `` `スキーマ`.`名前` `` 形式の 2 部名をすべて拾う (重複は除く)。文字列リテラルの
/// 中は読み飛ばし、`` `` `` のエスケープは戻す。列参照 (`` `a`.`id` ``) も拾うが、
/// 呼び出し側が存在しない表を無視するので害はない。
fn view_definition_table_refs(definition: &str) -> Vec<(String, String)> {
    fn read_ident(chars: &[char], i: &mut usize) -> Option<String> {
        if chars.get(*i) != Some(&'`') {
            return None;
        }
        let mut j = *i + 1;
        let mut out = String::new();
        while j < chars.len() {
            if chars[j] == '`' {
                if chars.get(j + 1) == Some(&'`') {
                    out.push('`');
                    j += 2;
                    continue;
                }
                *i = j + 1;
                return Some(out);
            }
            out.push(chars[j]);
            j += 1;
        }
        None
    }
    let chars: Vec<char> = definition.chars().collect();
    let mut refs: Vec<(String, String)> = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        match chars[i] {
            '\'' => {
                // 文字列リテラルを読み飛ばす (`''` と `\x` のエスケープ込み)。
                i += 1;
                while i < chars.len() {
                    if chars[i] == '\\' {
                        i += 2;
                    } else if chars[i] == '\'' {
                        if chars.get(i + 1) == Some(&'\'') {
                            i += 2;
                        } else {
                            i += 1;
                            break;
                        }
                    } else {
                        i += 1;
                    }
                }
            }
            '`' => {
                let mut k = i;
                let Some(first) = read_ident(&chars, &mut k) else {
                    break;
                };
                if chars.get(k) == Some(&'.') {
                    let mut m = k + 1;
                    if let Some(second) = read_ident(&chars, &mut m) {
                        let pair = (first, second);
                        if !refs.contains(&pair) {
                            refs.push(pair);
                        }
                        i = m;
                        continue;
                    }
                }
                i = k;
            }
            _ => i += 1,
        }
    }
    refs
}

/// `information_schema.TABLES.ENGINE` がロールバック可能なエンジンか。
/// NULL / 不明 (表が見つからない等) は InnoDB 想定で `true`。
fn engine_is_transactional(engine: Option<&str>) -> bool {
    match engine {
        Some(e) => matches!(
            e.to_ascii_lowercase().as_str(),
            "innodb" | "ndb" | "ndbcluster"
        ),
        None => true,
    }
}

/// Best-effort extraction of the target table from a mutation statement.
/// Returns `None` for shapes we don't confidently recognise (multi-table
/// UPDATE/DELETE, embedded subqueries, etc.) — callers fall back to a
/// snapshot-less preview in that case. The returned string is taken verbatim
/// from the user's SQL so quoting/qualification is preserved.
pub(crate) fn extract_target_table(sql: &str) -> Option<String> {
    match extract_target_table_with_alias(sql) {
        // `DELETE FROM t AS a WHERE a.id = …` は WHERE が別名を参照しており、
        // `SELECT * FROM t WHERE a.id = …` の BEFORE スナップショットが成立しない。
        // UPDATE の別名 (直後が SET でない) と同様に「認識しない形」として扱う。
        Some((_, true)) => None,
        Some((table, false)) => Some(table),
        None => None,
    }
}

/// [`extract_target_table`] の本体。`(対象表, DELETE の表名の直後に別名がある)`
/// を返す。別名付きでも対象表自体は判るので、非トランザクショナル判定
/// ([`MySqlConn::write_target_is_non_transactional`]) ではこちらを使う。
fn extract_target_table_with_alias(sql: &str) -> Option<(String, bool)> {
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
            Some((table, false))
        }
        "delete" => {
            skip_modifiers(&mut iter, &["low_priority", "quick", "ignore"]);
            // Single-table DELETE form: `DELETE FROM tbl ...`. Multi-table
            // (`DELETE t1 FROM t1 JOIN t2 ...`) doesn't begin with FROM.
            let next = iter.next()?;
            if !next.eq_ignore_ascii_case("from") {
                return None;
            }
            let table = iter.next()?;
            let has_alias = iter.peek().is_some_and(|t| {
                !["where", "order", "limit", "partition"]
                    .iter()
                    .any(|k| t.eq_ignore_ascii_case(k))
            });
            Some((table, has_alias))
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
            Some((next, false))
        }
        _ => None,
    }
}

/// `extract_target_table` が返した対象表の表記 (`` `db`.`t` `` / `db.t` / `t`)
/// を `(スキーマ, 表名)` に分ける。バッククォートは外し、`` `` `` は `` ` `` に戻す。
fn split_table_ref(target: &str) -> (Option<String>, String) {
    let mut parts: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut in_tick = false;
    let mut chars = target.trim().chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '`' if in_tick && chars.peek() == Some(&'`') => {
                chars.next();
                cur.push('`');
            }
            '`' => in_tick = !in_tick,
            '.' if !in_tick => parts.push(std::mem::take(&mut cur)),
            _ => cur.push(c),
        }
    }
    parts.push(cur);
    let table = parts.pop().unwrap_or_default();
    (parts.pop().filter(|s| !s.is_empty()), table)
}

/// Backtick-quotes a single identifier, doubling any embedded backticks.
/// 実装は方言共通の `sync::quote_ident` に一本化している (`fn(&str) -> String`
/// のシグネチャは `pk_order_clause` 等へ関数ポインタとして渡すため維持)。
fn quote_ident(name: &str) -> String {
    super::sync::quote_ident(super::DriverKind::Mysql, name)
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
async fn fetch_primary_key_on(
    conn: &mut sqlx::MySqlConnection,
    target: &str,
) -> Result<Vec<String>> {
    // `target` is taken verbatim from the user's SQL (already quoted as
    // needed). `SHOW KEYS FROM ...` accepts both `tbl` and `` `db`.`tbl` ``.
    let sql = format!("SHOW KEYS FROM {} WHERE Key_name = 'PRIMARY'", target);
    let rows: Vec<MySqlRow> = sqlx::query(sqlx::AssertSqlSafe(sql))
        .fetch_all(&mut *conn)
        .await?;
    let mut entries: Vec<(u64, String)> = rows
        .iter()
        .filter_map(|r| {
            // SHOW KEYS reports Seq_in_index as INT UNSIGNED on MariaDB and
            // BIGINT UNSIGNED on MySQL 8 — sqlx's strict type check rejects
            // `i64` for either. Fall back through signed shapes too so future
            // server versions don't break this without warning.
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
    // Single-column PK → `WHERE pk IN (?, ?, ...)`. Composite PK →
    // `WHERE (a,b) IN ((?,?), (?,?), ...)`. MySQL supports the row-constructor
    // form natively, so we don't need to fall back to OR chains. 組み立ては
    // ドライバ非依存の `db::preview` と共有し、ここでは MySQL の位置
    // パラメータ (`?`) を値の数だけ並べて後段で bind する。
    //
    // プレースホルダ数は MySQL の上限 (65,535) を超えないよう、行数 × PK 列数が
    // 収まる単位でチャンク分割する (行上限の大きい設定 × 複合 PK でプレビュー全体が
    // 失敗しないように)。captured_pks は PK 順に並んでいるので、チャンクを順に
    // 連結すれば全体の ORDER BY も保たれる。
    let mut all_rows: Vec<MySqlRow> = Vec::new();
    for chunk in captured_pks.chunks(after_by_pk_chunk_rows(pk_cols.len())) {
        let fragments: Vec<Vec<String>> = chunk
            .iter()
            .map(|_| vec!["?".to_string(); pk_cols.len()])
            .collect();
        let Some(sql) = super::preview::build_after_by_pk_sql(
            target,
            pk_cols,
            &fragments,
            order_clause,
            quote_ident,
        ) else {
            return Ok(Vec::new());
        };
        let mut q = sqlx::query(sqlx::AssertSqlSafe(sql));
        for row_pks in chunk {
            for v in row_pks {
                q = bind_value(q, v);
            }
        }
        all_rows.extend(q.fetch_all(&mut **tx).await?);
    }
    Ok(all_rows)
}

/// 1 回の `IN` 句に載せる PK 行数。MySQL のプレースホルダ上限 65,535 に対して
/// 余裕を見て 60,000 個以内に収める (PK 列数 0 でも 1 行以上を返す)。
fn after_by_pk_chunk_rows(pk_col_count: usize) -> usize {
    const MAX_PLACEHOLDERS: usize = 60_000;
    (MAX_PLACEHOLDERS / pk_col_count.max(1)).max(1)
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
        // BINARY(16) の UUID 主キーなどは `decode_cell` で 16 進文字列
        // (`Value::Bytes`) になる。そのまま bind すると往復しないので、バイト列へ
        // 戻して bind する。16 進として不正な場合だけ NULL (AFTER から行が落ちる
        // だけで、誤った値を bind するよりまし)。
        Value::Bytes(hex) => match data_encoding::HEXLOWER_PERMISSIVE.decode(hex.as_bytes()) {
            Ok(bytes) => q.bind(bytes),
            Err(_) => q.bind(Option::<i64>::None),
        },
    }
}

/// Quote-aware comment stripping shared across drivers (`db::strip_sql_comments`).
fn strip_sql_comments(sql: &str) -> String {
    super::strip_sql_comments(sql, super::SqlFlavor::MySql)
}

/// 照会の失敗が「テーブルが存在しない」(ER_NO_SUCH_TABLE 1146 /
/// ER_UNKNOWN_TABLE 1109) かを判定する純関数 (#1519)。
fn is_missing_table_code(number: u16) -> bool {
    matches!(number, 1146 | 1109)
}

fn is_missing_table_error(err: &sqlx::Error) -> bool {
    err.as_database_error()
        .and_then(|d| d.try_downcast_ref::<sqlx::mysql::MySqlDatabaseError>())
        .is_some_and(|d| is_missing_table_code(d.number()))
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
/// `pub(crate)` (raised from private) so the cross-driver golden test
/// (`tests/query_shape_golden.rs`, #971) can drive it via `__test_api`
/// without changing its behaviour.
pub(crate) fn is_query_shape(sql: &str) -> bool {
    // Leading comments/whitespace must be skipped before the keyword check, or
    // a perfectly normal `/* hint */ SELECT ...` / `-- note\nWITH ...` would
    // miss the prefix match and get misrouted to the execute path.
    // `(SELECT 1) UNION (SELECT 2)` のように括弧で始まる問い合わせも結果経路へ (#1519)。
    let mut rest = skip_leading_comments_and_ws(sql);
    while let Some(r) = rest.strip_prefix('(') {
        rest = skip_leading_comments_and_ws(r);
    }
    let trimmed = rest.to_ascii_lowercase();
    if trimmed.starts_with("with") {
        return !with_cte_is_mutation(super::DriverKind::Mysql, sql);
    }
    trimmed.starts_with("select")
        || trimmed.starts_with("show")
        || trimmed.starts_with("describe")
        || trimmed.starts_with("desc ")
        || trimmed.starts_with("explain")
        // MySQL 8.0.19+ supports a bare `VALUES ROW(...), ROW(...)` statement
        // that returns a result set (#1052). Other drivers already treat a
        // leading VALUES as query-shaped (see postgres.rs/sqlite.rs); MySQL
        // lacked the branch, so the statement was routed to the execute path
        // and its rows were silently dropped.
        || trimmed.starts_with("values")
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
            server_messages: Vec::new(),
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
/// blanked out before the scan (see below) so a keyword inside a literal or
/// identifier isn't mistaken for the main statement. If no decisive keyword is
/// found (e.g. `WITH ... TABLE t`), the statement is treated as query-shaped.
///
/// キーワード列挙そのものは方言非依存 (MySQL/PostgreSQL 双方の DML キーワードを
/// 含む) なので、`db/postgres.rs` / `db/sqlite.rs` の `is_query_shape` からも
/// `super::mysql::with_cte_is_mutation` として共有する (`pub(crate)`)。
///
/// **`driver` を受け取る理由 (#1051)**: コメント/リテラルの読み飛ばしだけは
/// 方言依存で、`\` を文字列リテラルのエスケープ文字と見なすのは MySQL/MariaDB
/// だけである。以前はこの関数が自前の走査で `\` を無条件にエスケープ扱いして
/// いたため、`WITH t AS (SELECT '\' AS x) DELETE FROM y` を PostgreSQL /
/// SQLite でも「文字列が閉じない」と誤読し、CTE の閉じ括弧ごと
/// リテラルへ飲み込んで主文の `DELETE` に到達できず「データ変更ではない」= fetch
/// 経路と判定していた (実サーバは 2 個目の `'` で文字列を閉じ、`DELETE` を実行
/// する)。#852 が `is_read_only_sql_for` /
/// `has_stacked_statements_for` / `apply_auto_limit_for` /
/// `classify_write_kind_for` に対して行ったドライバ別マスクへの切り替えを、
/// ここへ横展開したもの。マスク処理は再実装せず
/// [`super::mask_for_driver`] へ委譲する。
///
/// ドライバを知らない呼び出し口が将来増えた場合は、#852 と同じ fail-closed
/// 方針で [`super::mask_for_analysis_conservative`] (= `\` を通常文字として
/// 読む、リテラルが早く閉じる側) を使ってここへ渡すこと。現在の呼び出し口は
/// 3 ドライバの `is_query_shape` だけで、いずれも自分の `DriverKind` を持つ。
///
/// 共有マスクへ委譲したことによる副次的な挙動差 (いずれも fail-closed 方向、
/// または実サーバの解釈に近づく方向):
///
/// * MySQL の `/*! … */` は**コメントではなく条件付き実行構文**なので、
///   [`super::mask_for_driver`] は中身を空白化せずキーワード走査へ残す。
///   実際に実行される `DELETE` などがここでも見えるようになる。
/// * PostgreSQL のドル引用文字列 (`$$…$$` / `$tag$…$tag$`) の中身が
///   リテラルとして正しく伏せられる (以前は素通しだった)。
pub(crate) fn with_cte_is_mutation(driver: super::DriverKind, sql: &str) -> bool {
    let orig: Vec<char> = sql.chars().collect();
    main_statement_is_mutation(&super::mask_for_driver(driver, &orig))
}

/// [`with_cte_is_mutation`] の本体。すでにコメント/リテラルがマスク済み
/// (= 空白へ置換済み、文字数と括弧は原文のまま) の文字列を走査し、括弧深さ 0 に
/// 最初に現れる文キーワードで判定する。マスクが引用/コメントの状態管理を
/// 済ませているため、ここは「深さの追跡」と「単語の切り出し」だけを行う。
fn main_statement_is_mutation(masked: &[char]) -> bool {
    let mut depth: i32 = 0;
    let mut word = String::new();

    for &c in masked {
        if c.is_alphanumeric() || c == '_' || c == '$' {
            word.push(c);
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

        match c {
            '(' => depth += 1,
            ')' => depth = depth.saturating_sub(1),
            _ => {}
        }
    }
    // 末尾に区切り文字なしで終わった単語は、元の実装と同じく判定に使わない
    // (`WITH … DELETE` のような文末が裸のキーワードで終わる形は SQL として
    // 成立しないため、挙動を変えずに据え置く)。
    false
}

#[cfg(test)]
mod tests {
    #[test]
    fn lock_conflict_errors_are_recognised() {
        let dead = AppError::Other(
            "error returned from database: 1213 (40001): Deadlock found when trying to get lock"
                .into(),
        );
        let wait = AppError::Other("error returned from database: 1205 (HY000): Lock wait timeout exceeded; try restarting transaction".into());
        let other =
            AppError::Other("error returned from database: 1054 (42S22): Unknown column".into());
        assert!(is_deadlock(&dead));
        assert!(!is_deadlock(&wait));
        assert!(is_lock_wait_timeout(&wait));
        assert!(!is_lock_wait_timeout(&dead));
        assert!(!is_deadlock(&other) && !is_lock_wait_timeout(&other));
    }

    use super::*;

    fn cand(w: &str, h: &str, pending: bool) -> MdlCandidate {
        MdlCandidate {
            waiter: 3,
            holder: 2,
            waiter_lock: w.into(),
            holder_lock: h.into(),
            object_type: "TABLE".into(),
            holder_pending: pending,
        }
    }

    #[test]
    fn mdl_compatible_granted_locks_are_not_blockers() {
        // SR 同士・SW が SR を待たない・SW が SW を待たない。
        assert!(mdl_wait_pairs(&[cand("SHARED_READ", "SHARED_READ", false)]).is_empty());
        assert!(mdl_wait_pairs(&[cand("SHARED_WRITE", "SHARED_READ", false)]).is_empty());
        assert!(mdl_wait_pairs(&[cand("SHARED_WRITE", "SHARED_WRITE", false)]).is_empty());
    }

    #[test]
    fn mdl_conflicting_granted_locks_are_blockers() {
        // LOCK TABLES READ (SRO) は書き込み (SW) を止めるが、読み取り (SR) の保持者は止めない。
        assert_eq!(
            mdl_wait_pairs(&[cand("SHARED_WRITE", "SHARED_READ_ONLY", false)]),
            vec![(3, 2)]
        );
        assert!(mdl_wait_pairs(&[cand("SHARED_WRITE", "SHARED_READ", false)]).is_empty());
        // ALTER (X) は SR の保持者に待たされる。
        assert_eq!(
            mdl_wait_pairs(&[cand("EXCLUSIVE", "SHARED_READ", false)]),
            vec![(3, 2)]
        );
        // SNRW (ALTER の途中) は SR を待たせるが S / SH とは共存する。
        assert_eq!(
            mdl_wait_pairs(&[cand("SHARED_NO_READ_WRITE", "SHARED_READ", false)]),
            vec![(3, 2)]
        );
        assert!(mdl_wait_pairs(&[cand("SHARED_NO_READ_WRITE", "SHARED", false)]).is_empty());
    }

    #[test]
    fn mdl_pending_requests_follow_the_waiting_matrix() {
        let blocked = |w: &str, h: &str| !mdl_wait_pairs(&[cand(w, h, true)]).is_empty();
        // ALTER の PENDING X の後ろで待つ SR / SW / SNW / SNRW / SU。SH は待たない。
        assert!(blocked("SHARED_READ", "EXCLUSIVE"));
        assert!(blocked("SHARED_WRITE", "EXCLUSIVE"));
        assert!(blocked("SHARED_NO_WRITE", "EXCLUSIVE"));
        assert!(blocked("SHARED_NO_READ_WRITE", "EXCLUSIVE"));
        assert!(blocked("SHARED_UPGRADABLE", "EXCLUSIVE"));
        assert!(!blocked("SHARED_HIGH_PRIO", "EXCLUSIVE"));
        // X 要求は PENDING に止められないので、X 同士が相互待ちにならない。
        assert!(!blocked("EXCLUSIVE", "EXCLUSIVE"));
        assert!(!blocked("EXCLUSIVE", "SHARED_READ"));
        // (1) PENDING SW は後続の SRO を、PENDING SRO は後続の SWLP を待たせる。
        assert!(blocked("SHARED_READ_ONLY", "SHARED_WRITE"));
        assert!(blocked("SHARED_WRITE_LOW_PRIO", "SHARED_READ_ONLY"));
        // (2) SU 要求は PENDING の SNW / SNRW には止められない (X だけ)。
        assert!(!blocked("SHARED_UPGRADABLE", "SHARED_NO_WRITE"));
        assert!(!blocked("SHARED_UPGRADABLE", "SHARED_NO_READ_WRITE"));
        // (3) PENDING X は SNW / SNRW 要求も待たせる。
        assert!(blocked("SHARED_NO_WRITE", "EXCLUSIVE"));
        assert!(blocked("SHARED_NO_READ_WRITE", "EXCLUSIVE"));
        // SR は PENDING SNRW に止められるが、PENDING SW には止められない。
        assert!(blocked("SHARED_READ", "SHARED_NO_READ_WRITE"));
        assert!(!blocked("SHARED_READ", "SHARED_WRITE"));
    }

    #[test]
    fn mdl_scope_locks_use_intention_matrix() {
        let scope = |w: &str, h: &str, pending: bool| {
            let mut c = cand(w, h, pending);
            c.object_type = "GLOBAL".into();
            !mdl_wait_pairs(&[c]).is_empty()
        };
        // GRANTED: IX 同士は互換、IX と S は衝突。
        assert!(!scope("INTENTION_EXCLUSIVE", "INTENTION_EXCLUSIVE", false));
        assert!(scope("INTENTION_EXCLUSIVE", "SHARED", false));
        // (4) FTWRL (GLOBAL S PENDING) の後ろの INSERT (GLOBAL IX) は FTWRL を待つ。
        assert!(scope("INTENTION_EXCLUSIVE", "SHARED", true));
        assert!(scope("INTENTION_EXCLUSIVE", "EXCLUSIVE", true));
        assert!(scope("SHARED", "EXCLUSIVE", true));
        assert!(!scope("SHARED", "INTENTION_EXCLUSIVE", true));
        assert!(!scope("EXCLUSIVE", "SHARED", true));
    }

    #[test]
    fn mdl_scope_namespaces_follow_get_strategy() {
        for t in ["GLOBAL", "SCHEMA", "COMMIT", "TABLESPACE", "BACKUP LOCK"] {
            assert!(mdl_is_scoped(t), "{t}");
        }
        for t in ["TABLE", "FUNCTION", "PROCEDURE", "TRIGGER", "EVENT"] {
            assert!(!mdl_is_scoped(t), "{t}");
        }
    }

    #[test]
    fn lock_wait_states_are_detected() {
        assert!(state_suggests_lock_wait("Waiting for table metadata lock"));
        assert!(state_suggests_lock_wait("Waiting for global read lock"));
        assert!(!state_suggests_lock_wait("executing"));
        assert!(!state_suggests_lock_wait("Waiting on empty queue"));
    }

    #[test]
    fn blocked_by_map_groups_dedups_and_drops_self_references() {
        let map = blocked_by_map(vec![(2, 1), (3, 1), (3, 2), (3, 1), (4, 4)]);
        assert_eq!(map.get(&2), Some(&vec![1]));
        assert_eq!(map.get(&3), Some(&vec![1, 2]));
        assert!(!map.contains_key(&4));
        assert!(blocked_by_map(Vec::new()).is_empty());
    }

    #[test]
    fn warning_rows_map_to_severity_and_prefix_code() {
        let w = warning_to_message(
            "Warning",
            Some(1265),
            "Data truncated for column 'a' at row 1",
        );
        assert_eq!(w.severity, ServerMessageSeverity::Warning);
        assert_eq!(w.text, "[1265] Data truncated for column 'a' at row 1");
        assert_eq!(
            warning_to_message("Note", None, "n").severity,
            ServerMessageSeverity::Info
        );
        assert_eq!(warning_to_message("Note", None, "n").text, "n");
        assert_eq!(
            warning_to_message("ERROR", Some(1), "e").severity,
            ServerMessageSeverity::Error
        );
        assert_eq!(
            warning_to_message("weird", None, "x").severity,
            ServerMessageSeverity::Info
        );
    }

    #[test]
    fn maps_ssl_mode_to_mysql_equivalents() {
        assert!(matches!(
            map_ssl_mode(SslMode::Disable),
            MySqlSslMode::Disabled
        ));
        assert!(matches!(
            map_ssl_mode(SslMode::Prefer),
            MySqlSslMode::Preferred
        ));
        assert!(matches!(
            map_ssl_mode(SslMode::Require),
            MySqlSslMode::Required
        ));
        assert!(matches!(
            map_ssl_mode(SslMode::VerifyCa),
            MySqlSslMode::VerifyCa
        ));
        // MySQL's full-identity verification is the equivalent of `verify_full`.
        assert!(matches!(
            map_ssl_mode(SslMode::VerifyFull),
            MySqlSslMode::VerifyIdentity
        ));
    }

    #[test]
    fn apply_tls_treats_blank_cert_paths_as_unset() {
        assert_eq!(non_empty(&Some(String::new())), None);
        assert_eq!(non_empty(&Some(" /k.pem ".to_string())), Some("/k.pem"));
        assert_eq!(non_empty(&None), None);
    }

    /// #587 / #641: the fallback from `performance_schema.processlist` to
    /// `information_schema.PROCESSLIST` must trigger both when the primary
    /// query errors (table missing on old MySQL / MariaDB) and when it
    /// succeeds but returns zero rows (`performance_schema = OFF`), since a
    /// genuinely empty processlist is impossible. It must NOT trigger when the
    /// primary query returns at least one row.
    #[test]
    fn process_list_fallback_triggers_on_error_and_on_empty_success() {
        let empty_ok: std::result::Result<Vec<i32>, sqlx::Error> = Ok(Vec::new());
        assert!(
            process_list_needs_fallback(&empty_ok),
            "an empty success must fall back (performance_schema = OFF case)"
        );

        let err: std::result::Result<Vec<i32>, sqlx::Error> = Err(sqlx::Error::RowNotFound);
        assert!(
            process_list_needs_fallback(&err),
            "a query error must fall back (table missing on old MySQL / MariaDB)"
        );

        let nonempty_ok: std::result::Result<Vec<i32>, sqlx::Error> = Ok(vec![1, 2]);
        assert!(
            !process_list_needs_fallback(&nonempty_ok),
            "a non-empty success must NOT fall back"
        );
    }

    #[test]
    fn missing_table_code_only_matches_no_such_table() {
        assert!(is_missing_table_code(1146));
        assert!(is_missing_table_code(1109));
        assert!(!is_missing_table_code(1142));
        assert!(!is_missing_table_code(1205));
    }

    #[test]
    fn query_shape_accepts_parenthesized_select() {
        assert!(is_query_shape("(SELECT 1) UNION (SELECT 2)"));
        assert!(is_query_shape("( /* c */ select 1 )"));
        assert!(!is_query_shape("(INSERT INTO t VALUES (1))"));
    }

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
    fn query_shape_recognises_bare_values_statement() {
        // MySQL 8.0.19+ supports a bare `VALUES ROW(...), ROW(...)` statement
        // that returns a result set (#1052). It must be routed to the fetch
        // path like the other drivers (postgres/sqlite).
        assert!(is_query_shape("VALUES ROW(1)"));
        assert!(is_query_shape("VALUES ROW(1, 'a'), ROW(2, 'b')"));
        assert!(is_query_shape("  values row(1)"));
        // `INSERT INTO t VALUES (1)` must NOT be misdetected as a leading
        // VALUES statement — only the statement's own first keyword counts.
        assert!(!is_query_shape("INSERT INTO t VALUES (1)"));
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
        // a comment that would swallow the trailing DELETE.
        assert!(!is_query_shape(
            "WITH c AS (SELECT '-- keep' AS note) DELETE FROM t WHERE id IN (SELECT 1)"
        ));
        // A genuine line comment between the CTE and the main keyword is
        // skipped so the DELETE is still detected.
        assert!(!is_query_shape(
            "WITH c AS (SELECT 1) -- pick\n DELETE FROM t WHERE id = 1"
        ));
    }

    /// #1051 の回帰テスト: `with_cte_is_mutation` の文字列リテラル解釈が接続先の
    /// 方言に追従すること。`\` をエスケープ文字と見なすのは MySQL/MariaDB だけで、
    /// 他方言では 2 個目の `'` で文字列が閉じて主文の `DELETE` が露出する。
    /// 以前は全ドライバで MySQL 流に読んでいたため、PostgreSQL 等でも「文字列が
    /// 閉じない」と誤読して CTE の閉じ括弧ごと飲み込み、データ変更を fetch 経路
    /// (空の 0 件グリッド) へ流していた。
    #[test]
    fn with_cte_backslash_literal_follows_driver_escaping() {
        use crate::db::DriverKind;

        let sql = r"WITH t AS (SELECT '\' AS x) DELETE FROM y";
        // MySQL: `\'` はエスケープされた引用符なので文字列が閉じず、主文の
        // DELETE へ到達しない (= 非データ変更)。実サーバの解釈と一致する。
        assert!(!with_cte_is_mutation(DriverKind::Mysql, sql));
        // それ以外の 2 方言では `\` はただの文字。文字列は閉じ、DELETE が露出する。
        for driver in [DriverKind::Postgres, DriverKind::Sqlite] {
            assert!(
                with_cte_is_mutation(driver, sql),
                "{driver:?} must see the DELETE that follows the closed literal"
            );
        }
        // MySQL 経路の `is_query_shape` 側から見た表現 (fetch 経路のまま)。
        assert!(is_query_shape(sql));
    }

    /// 上のケースと対になる確認: `\\` (エスケープされたバックスラッシュ 1 個) なら
    /// MySQL でも文字列は 2 個目の `'` で閉じるので、全方言でデータ変更と判定する。
    /// 「MySQL では常に検出できない」のではなく「マスク規則が違うだけ」であることを
    /// 固定する。
    #[test]
    fn with_cte_escaped_backslash_closes_literal_on_every_driver() {
        use crate::db::DriverKind;

        let sql = r"WITH t AS (SELECT 'a\\' AS x) DELETE FROM y";
        for driver in [DriverKind::Mysql, DriverKind::Postgres, DriverKind::Sqlite] {
            assert!(
                with_cte_is_mutation(driver, sql),
                "{driver:?} must treat the escaped backslash as closing the literal"
            );
        }
    }

    /// 共有マスク (`db::mask_for_driver`) への委譲で変わった/変わらない挙動
    /// (#1051)。
    #[test]
    fn with_cte_shares_the_analysis_mask_semantics() {
        use crate::db::DriverKind;

        // MySQL の `/*! … */` はコメントではなく条件付き実行構文なので、共有
        // マスクは中身をキーワード走査へ残す → 実際に実行される DELETE を
        // 見逃さない (以前は普通のブロックコメントとして読み飛ばしていた。
        // fail-closed 方向の変化)。
        assert!(with_cte_is_mutation(
            DriverKind::Mysql,
            "WITH c AS (SELECT 1) /*!50000 DELETE */ FROM t"
        ));
        // 通常のブロックコメント / 行コメントは従来どおり読み飛ばし、その先の
        // 主文キーワードに到達する。
        assert!(with_cte_is_mutation(
            DriverKind::Postgres,
            "WITH c AS (SELECT 1) /* pick */ -- go\n DELETE FROM t"
        ));
        // 文字列リテラルの中のキーワードは従来どおり無視。
        assert!(!with_cte_is_mutation(
            DriverKind::Postgres,
            "WITH c AS (SELECT 'delete me' AS note) SELECT * FROM c"
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

    /// #1600: 別名付き DELETE は WHERE が別名を参照するので認識しない
    /// (BEFORE スナップショットの再利用で未知の別名エラーになるため)。
    /// ただし非トランザクショナル判定用には対象表が引ける。
    #[test]
    fn delete_with_alias_is_not_recognised_but_target_is_resolvable() {
        for sql in [
            "DELETE FROM orders AS o WHERE o.status = 'x'",
            "DELETE FROM orders o WHERE o.status = 'x'",
        ] {
            assert_eq!(extract_target_table(sql), None, "{sql}");
            assert_eq!(
                extract_target_table_with_alias(sql),
                Some(("orders".into(), true)),
                "{sql}"
            );
        }
        assert_eq!(
            extract_target_table("DELETE FROM orders ORDER BY id LIMIT 3"),
            Some("orders".into())
        );
        assert_eq!(
            extract_target_table("DELETE FROM orders"),
            Some("orders".into())
        );
    }

    #[test]
    fn view_definition_refs_are_extracted() {
        let def = "select `a`.`id` AS `id`,'x`y`.`z' AS `lit` from (`shop`.`orders` `a` join `shop`.`we``ird` on((`a`.`id` = `we``ird`.`oid`)))";
        let refs = view_definition_table_refs(def);
        assert!(refs.contains(&("shop".into(), "orders".into())), "{refs:?}");
        assert!(refs.contains(&("shop".into(), "we`ird".into())), "{refs:?}");
        // 文字列リテラルの中は拾わない。
        assert!(!refs.contains(&("y".into(), "z".into())), "{refs:?}");
        // 重複は 1 回だけ。
        let dup = view_definition_table_refs("select 1 from `d`.`t` union select 1 from `d`.`t`");
        assert_eq!(dup, vec![("d".to_string(), "t".to_string())]);
        assert!(view_definition_table_refs("select 1").is_empty());
        // 閉じていないバッククォートでも panic しない。
        assert!(view_definition_table_refs("select `d`.`t").is_empty());
    }

    #[test]
    fn usage_rows_with_invisible_base_are_rejected() {
        let row = |t: &str, e: Option<&str>| {
            (
                "d".to_string(),
                "x".to_string(),
                t.to_string(),
                e.map(String::from),
            )
        };
        assert!(matches!(classify_usage_rows(vec![]), Ok(None)));
        // 見える InnoDB + 見えない (種別が空) 表 → 拒否。
        assert!(matches!(
            classify_usage_rows(vec![row("BASE TABLE", Some("InnoDB")), row("", None)]),
            Err(AppError::ViewBaseUnresolved)
        ));
        let ok = classify_usage_rows(vec![row("BASE TABLE", Some("InnoDB"))]);
        assert!(matches!(ok, Ok(Some(ref r)) if r.len() == 1));
    }

    #[test]
    fn engine_transactionality() {
        assert!(engine_is_transactional(Some("InnoDB")));
        assert!(engine_is_transactional(None));
        assert!(!engine_is_transactional(Some("MyISAM")));
        assert!(!engine_is_transactional(Some("MEMORY")));
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

    // NOTE: `extract_where_and_after` の単体テストは `db::preview` へ移設した
    // (PostgreSQL と共有する純ロジックになったため)。MySQL 方言の解釈が
    // 変わっていないことは、移設先で `SqlFlavor::MySql` を指定した同じ
    // ケース群が引き続き固定している。

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

    #[test]
    fn after_by_pk_chunks_stay_under_the_placeholder_limit() {
        for cols in 1..=16usize {
            let rows = after_by_pk_chunk_rows(cols);
            assert!(rows >= 1);
            assert!(rows * cols <= 65_535, "{cols} 列で {rows} 行は上限超過");
        }
        assert_eq!(after_by_pk_chunk_rows(0), 60_000);
        assert_eq!(after_by_pk_chunk_rows(3), 20_000);
    }

    #[test]
    fn split_table_ref_handles_quoting_and_schema() {
        assert_eq!(split_table_ref("t"), (None, "t".to_string()));
        assert_eq!(split_table_ref("`t`"), (None, "t".to_string()));
        assert_eq!(
            split_table_ref("`db`.`t`"),
            (Some("db".to_string()), "t".to_string())
        );
        assert_eq!(
            split_table_ref("db.t"),
            (Some("db".to_string()), "t".to_string())
        );
        assert_eq!(
            split_table_ref("`we``ird.name`"),
            (None, "we`ird.name".to_string())
        );
    }
}
