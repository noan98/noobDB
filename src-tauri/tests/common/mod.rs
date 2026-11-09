//! 統合テスト共通のヘルパ (#1263)。`load_schema_tree` / `open_table(s)` /
//! `list_tables_all` / `table_row_estimate` のコマンド層の結果が、従来フロントが
//! 個別 IPC で組み立てていた内容 (`tables` / `columns` / `list_indexes` /
//! `table_row_estimates` …) と一致することを検証する。

#![allow(dead_code)]

use noobdb_lib::__test_api as t;

// ---------------------------------------------------------------------------
// 外部サービス前提テストの skip 制御 (#2101)
//
// 外部 DB / SSH / クライアントコマンドが無いとき、従来は `eprintln!("skip: ...")` して
// `return` する (= 成功扱い)。CI でこれが起きると DB の起動や環境変数の受け渡しが壊れても
// 必須チェックが緑のままになるため、`NOOBDB_TEST_REQUIRE_EXTERNAL=1` のときは skip せず
// panic する。ローカルで環境変数が無いときは従来どおり skip で通る。
//
// skip 分岐は必ずこのモジュールの関数を経由する (`src/__tests__/externalSkipParity.test.ts`
// が `eprintln!("skip` の直書きを CI で検出する)。
// ---------------------------------------------------------------------------

/// 外部サービスの存在を必須とするか (CI の external 実行ジョブが立てる)。
pub fn external_required() -> bool {
    matches!(
        std::env::var("NOOBDB_TEST_REQUIRE_EXTERNAL").as_deref(),
        Ok("1") | Ok("true")
    )
}

/// skip を `NOOBDB_TEST_SKIP_LOG` のファイルへ 1 行追記する (CI の Job Summary 用)。
/// nextest はテストごとにプロセスが別なので、プロセス内カウンタでは集計できない。
fn record_skip(reason: &str) {
    use std::io::Write;
    let Ok(path) = std::env::var("NOOBDB_TEST_SKIP_LOG") else {
        return;
    };
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = writeln!(f, "{reason}");
    }
}

/// 外部サービスが無い (= 本来は走るべきテストが走れない) ときの skip。
/// `NOOBDB_TEST_REQUIRE_EXTERNAL=1` なら panic、そうでなければ記録して戻る。
/// 呼び出し側は直後に `return` する。
pub fn skip_external(reason: &str) {
    if external_required() {
        // テスト失敗として CI に気付かせるのが目的の意図的な panic。
        panic!("{reason} (NOOBDB_TEST_REQUIRE_EXTERNAL=1 のため skip せず失敗扱い)");
    }
    eprintln!("skip: {reason}");
    record_skip(reason);
}

/// サーバ機能の有無など、CI でも環境次第で正当に成立しない条件による skip。
/// `NOOBDB_TEST_REQUIRE_EXTERNAL` の影響を受けず、常に記録して戻る。
pub fn skip_capability(reason: &str) {
    eprintln!("skip: {reason}");
    record_skip(reason);
}

/// 環境変数 `name` を返す。無ければ `skip_external` して `None`。
pub fn require_env(name: &str) -> Option<String> {
    match std::env::var(name) {
        Ok(v) => Some(v),
        Err(_) => {
            skip_external(&format!("{name} not set"));
            None
        }
    }
}

/// `tables` は `db` に実在する 4 件以上のテーブル (一括取得の経路も通すため)。
pub async fn assert_tree_and_open_match_individual_ipcs(
    state: &t::AppState,
    sid: &str,
    conn: &t::Connection,
    db: &str,
    tables: &[String],
) {
    assert!(tables.len() >= 4, "need >=4 tables to cover the bulk path");
    let ghost_key = format!("{db}::no_such_table_1263");
    let estimates = conn.table_row_estimates(db).await.expect("estimates");

    // 件数の少ない要求 (テーブルごと) と多い要求 (DB 単位の一括) の両方。
    for take in [1usize, tables.len()] {
        let mut keys: Vec<String> = tables[..take]
            .iter()
            .map(|x| format!("{db}::{x}"))
            .collect();
        keys.push(ghost_key.clone());
        let tree = t::load_schema_tree_via_command(
            state,
            sid,
            vec![
                db.to_string(),
                "no_such_db_1263".to_string(),
                db.to_string(),
            ],
            keys.clone(),
        )
        .await
        .expect("load_schema_tree");

        // 他のテストが別 DB を作る/消す可能性があるので、全体一致ではなく包含で見る。
        assert!(tree.databases.iter().any(|d| d == db));
        assert_eq!(tree.open.len(), 1, "unknown/duplicate dbs are dropped");
        let open = &tree.open[0];
        assert_eq!(open.database, db);
        assert_eq!(open.tables, Some(conn.tables(db).await.expect("tables")));
        assert_eq!(
            format!("{:?}", open.row_estimates),
            format!("{:?}", Some(estimates.clone()))
        );
        assert_eq!(
            format!("{:?}", open.objects),
            format!("{:?}", conn.schema_objects(db).await.expect("objects"))
        );
        assert_eq!(
            format!("{:?}", open.comments),
            format!(
                "{:?}",
                Some(conn.table_comments(db).await.expect("comments"))
            )
        );

        assert_eq!(tree.tables.len(), take, "ghost table is skipped");
        for (i, table) in tables[..take].iter().enumerate() {
            let got = &tree.tables[i];
            assert_eq!(got.key, format!("{db}::{table}"));
            assert_eq!(
                format!("{:?}", got.columns),
                format!("{:?}", conn.columns(db, table).await.expect("columns")),
                "columns of {table} (take={take})"
            );
            assert_eq!(
                format!("{:?}", got.indexes),
                format!("{:?}", conn.list_indexes(db, table).await.expect("indexes")),
                "indexes of {table} (take={take})"
            );
        }
    }

    // open_table: 列・行識別・SQL・行数推定
    let first = &tables[0];
    let opened = t::open_table_via_command(state, sid, db, first, 25, true)
        .await
        .expect("open_table");
    assert_eq!(
        format!("{:?}", opened.columns),
        format!("{:?}", conn.columns(db, first).await.expect("columns"))
    );
    let hidden = opened
        .row_identity
        .as_ref()
        .filter(|i| i.strategy == "rowid" || i.strategy == "ctid")
        .and_then(|i| i.hidden_column.clone());
    let base = t::table_select_sql(conn.driver_kind(), db, first, hidden.as_deref());
    assert_eq!(opened.base, base);
    assert_eq!(opened.sql, format!("{base} LIMIT 25"));
    let expected_est = estimates
        .iter()
        .find(|e| &e.name == first)
        .and_then(|e| e.estimate);
    assert_eq!(opened.row_estimate, expected_est);
    let without = t::open_table_via_command(state, sid, db, first, 25, false)
        .await
        .expect("open_table");
    assert_eq!(without.row_estimate, None);

    // table_row_estimate (1 件) は table_row_estimates から引いた値と一致する。
    for table in tables {
        let single = conn.table_row_estimate(db, table).await.expect("estimate");
        let expected = estimates
            .iter()
            .find(|e| &e.name == table)
            .and_then(|e| e.estimate);
        assert_eq!(single, expected, "row estimate of {table}");
    }
    assert_eq!(
        conn.table_row_estimate(db, "no_such_table_1263")
            .await
            .expect("estimate"),
        None
    );

    // open_tables: 要求順・テーブルごとの失敗の切り分け
    let req = vec![
        (db.to_string(), tables[1].clone()),
        (db.to_string(), "no_such_table_1263".to_string()),
        (db.to_string(), tables[0].clone()),
    ];
    let batch = t::open_tables_via_command(state, sid, req, 10)
        .await
        .expect("open_tables");
    assert_eq!(batch.len(), 3);
    assert_eq!(batch[0].table, tables[1]);
    assert!(batch[0].result.is_some() && batch[0].error.is_none());
    // 存在しないテーブルは `describe_table` と同じ扱い: ドライバによってエラー、
    // または空の列 (従来のフロントの挙動をそのまま保つ)。
    assert_eq!(batch[1].table, "no_such_table_1263");
    match (&batch[1].result, &batch[1].error) {
        (None, Some(_)) => {}
        (Some(r), None) => assert!(r.columns.is_empty()),
        other => panic!("unexpected result for a missing table: {other:?}"),
    }
    assert_eq!(batch[2].table, tables[0]);
    let r = batch[2].result.as_ref().expect("result");
    assert!(r.sql.ends_with(" LIMIT 10"));
    assert_eq!(r.row_estimate, None, "batch open skips the estimate");

    // list_tables_all: 対象 DB のテーブルが list_tables と同一。
    let all = conn.tables_all().await.expect("tables_all");
    let entry = all
        .iter()
        .find(|d| d.database == db)
        .expect("db is listed by tables_all");
    assert_eq!(entry.tables, conn.tables(db).await.expect("tables"));
    let names: Vec<&String> = all.iter().map(|d| &d.database).collect();
    let mut sorted = names.clone();
    sorted.sort();
    sorted.dedup();
    assert_eq!(names.len(), sorted.len(), "no duplicated database entries");
}

// ---------------------------------------------------------------------------
// サーバ側停止 (#2023) の MySQL / PostgreSQL 実検証 (#2102)
//
// タイムアウト / キャンセルでクライアント側の future を捨てても、サーバでは文が走り続ける。
// `StopGuard` が別接続から実行中の文だけを止められることを、`PROCESSLIST` /
// `pg_stat_activity` のポーリング (決定的。固定 sleep で待たない) で確かめる。
// ドライバ差は SQL 文字列だけなので、シナリオはここに 1 つだけ置き、各ドライバのテストから呼ぶ。
// ---------------------------------------------------------------------------

use std::sync::Arc;
use std::time::{Duration, Instant};

/// ドライバごとに異なる SQL。`marker` は文に埋め込むコメント用の一意な目印。
/// [`StopSql::lock_sql`] の結果。
pub struct LockSql {
    /// テーブルの作り直し (DROP → CREATE → INSERT)。
    pub setup: Vec<String>,
    /// 行 id=1 を掴んだまま眠る UPDATE (ドライラン用)。
    pub sleeping_update: String,
    /// 行 id=1 を待たずに掴む。ロック中ならエラーになる。
    pub lock_nowait: String,
    pub select_v: String,
    /// テーブル (と関連オブジェクト) の後始末。
    pub teardown: Vec<String>,
}

pub struct StopSql {
    /// 30 秒眠るだけの SELECT (目印つき)。
    pub sleep_30: fn(marker: &str) -> String,
    /// 実行中 (他接続から見える) の目印つきの文の数を返す SELECT。自分自身は数えない。
    /// `list_processes` を使わず専用の COUNT にしたのは、`pg_stat_activity` が待機中の接続にも
    /// 直前の文を残すため、`state = 'active'` で「今走っている文」だけを数える必要があるから。
    pub active_count: fn(marker: &str) -> String,
    /// 2 秒眠る SELECT。中断されずに終われば最初のセルが `0` (MySQL の SLEEP は中断されると 1)。
    pub sleep_2: &'static str,
    /// ロック用テーブル (行 id=1, v=0) に対する SQL を、テーブル名から組み立てる。
    /// テストごとに別テーブルを使う (同じテーブルの DROP が他テストの眠る UPDATE に待たされるため)。
    pub lock_sql: fn(table: &str) -> LockSql,
    /// `lock_nowait` がロック競合で失敗したときのエラーに含まれる文字列
    /// (MySQL 3572 / PostgreSQL 55P03)。別の理由 (構文エラーなど) の失敗と区別する。
    pub lock_conflict_marker: &'static str,
}

fn cell_as_i64(v: &t::Value) -> i64 {
    match v {
        t::Value::Int(i) => *i,
        t::Value::UInt(u) => i64::try_from(*u).unwrap_or(i64::MAX),
        t::Value::String(s) => s.parse().unwrap_or(-1),
        other => panic!("unexpected count cell: {other:?}"),
    }
}

async fn active_count(poller: &t::Connection, sql: &StopSql, marker: &str) -> i64 {
    let res = poller
        .execute(&(sql.active_count)(marker), None)
        .await
        .expect("poll process list");
    cell_as_i64(&res.rows[0][0])
}

/// 条件が満たされるまで 25ms 間隔でポーリングする。期限内に満たされなければ panic。
async fn poll_until<F, Fut>(what: &str, limit: Duration, mut check: F)
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    let started = Instant::now();
    loop {
        if check().await {
            return;
        }
        assert!(started.elapsed() < limit, "timed out waiting for: {what}");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

const POLL_LIMIT: Duration = Duration::from_secs(10);

/// 「サーバで走る文が消えた」ことを待つ上限。停止要求 (KILL) だけで間に合う短さにする。
/// MySQL の SLEEP は約 5 秒ごとにクライアント切断を検知して終わるため、これを長くすると
/// KILL が壊れていても (切断検知で消えて) 通ってしまう。
const STOP_WAIT_LIMIT: Duration = Duration::from_secs(3);

/// `cond` が満たされるまで待つ。そのあいだに `task` が終わったら、失敗なら原因 (panic) を先に
/// 表に出す。正常終了なら `true` を返す (`task_done` を立てる)。`cond` が先に満たされたら `false`。
async fn wait_watching_task<F: std::future::Future<Output = ()>>(
    cond: F,
    task: &mut tokio::task::JoinHandle<()>,
    task_done: &mut bool,
) -> bool {
    tokio::pin!(cond);
    loop {
        tokio::select! {
            _ = &mut cond => return false,
            r = &mut *task, if !*task_done => {
                *task_done = true;
                r.expect("the spawned run task failed");
                // 正常終了。条件の成立を引き続き待つ。
            }
        }
    }
}

fn assert_lock_conflict<T: std::fmt::Debug, E: std::fmt::Display + std::fmt::Debug>(
    res: &Result<T, E>,
    marker: &str,
) -> bool {
    match res {
        Ok(_) => false,
        Err(e) => {
            let text = format!("{e} / {e:?}");
            assert!(
                text.contains(marker),
                "the NOWAIT probe failed for a reason other than lock contention: {text}"
            );
            true
        }
    }
}

/// 本番 (`run_query_stream`) と同じ形でストリームを実行し、クライアント側タイムアウトに達したら
/// `StopGuard::fire` で止める。サーバ側タイムアウトは付けない (`None`) ので、文が消えたのは
/// 停止要求の効果だけ。タイムアウトしたことを確認して返す。
async fn run_streamed_sleep_until_timeout(
    session: &Arc<t::Session>,
    sleep_sql: &str,
    timeout: Duration,
) {
    let ctx = t::ServerStopCtx::new(None);
    let mut guard = t::StopGuard::new(ctx.clone(), session.clone());
    let timed_out = tokio::time::timeout(
        timeout,
        t::server_stop_scope(ctx, async {
            session
                .conn
                .execute_stream(sleep_sql, None, 10, 10, |_| Ok(()))
                .await
        }),
    )
    .await
    .is_err();
    assert!(timed_out, "sleep(30) must hit the client-side timeout");
    guard.fire();
    guard.disarm();
}

/// 1. タイムアウトしたらサーバ側の文が一定時間内に消える。
pub async fn assert_timeout_stops_statement_server_side(
    opts: &t::DbConnectOptions,
    sql: &StopSql,
    tag: &str,
) {
    let marker = format!("noobdb_2102_{tag}_timeout");
    let poller = t::connect(opts).await.expect("connect poller");
    let runner = t::connect(opts).await.expect("connect runner");
    let session = Arc::new(t::make_session("s2102", runner, opts.clone(), false));

    let sleep_sql = (sql.sleep_30)(&marker);
    let mut run = {
        let session = session.clone();
        tokio::spawn(async move {
            run_streamed_sleep_until_timeout(&session, &sleep_sql, Duration::from_secs(1)).await;
        })
    };
    let mut run_done = false;
    // 先に「実際にサーバで走っている」ことを確かめる (でなければ消えたことの検証にならない)。
    wait_watching_task(
        poll_until("the sleeping statement appears", POLL_LIMIT, || async {
            active_count(&poller, sql, &marker).await > 0
        }),
        &mut run,
        &mut run_done,
    )
    .await;
    assert!(
        !run_done,
        "the run task ended before the statement became visible"
    );
    wait_watching_task(
        poll_until(
            "the sleeping statement is stopped server-side",
            STOP_WAIT_LIMIT,
            || async { active_count(&poller, sql, &marker).await == 0 },
        ),
        &mut run,
        &mut run_done,
    )
    .await;
    if !run_done {
        run.await.expect("run task");
    }
    // 停止後もプールは使える。
    assert!(session.conn.execute("SELECT 1", None).await.is_ok());
}

/// 2. キャンセル直後に同じプールで実行した別の文が、遅れて届いた停止要求で止められない
///    (a32a680 の競合の回帰防止)。ストリーム経路と、ドライラン経路 (接続がトランザクションごと
///    プールへ戻って再利用される) の両方で、停止の直後に 2 秒の文を流して完走を確かめる。
pub async fn assert_late_stop_never_hits_next_statement(
    opts: &t::DbConnectOptions,
    sql: &StopSql,
    tag: &str,
) {
    let runner = t::connect(opts).await.expect("connect runner");
    let session = Arc::new(t::make_session("s2102b", runner, opts.clone(), false));
    let marker = format!("noobdb_2102_{tag}_reuse");
    let sleep_sql = (sql.sleep_30)(&marker);

    let assert_next_statement_survives = |round: &'static str| {
        let session = session.clone();
        async move {
            let started = Instant::now();
            let res = session
                .conn
                .execute(sql.sleep_2, None)
                .await
                .unwrap_or_else(|e| panic!("{round}: the next statement was stopped: {e}"));
            assert!(
                started.elapsed() >= Duration::from_millis(1900),
                "{round}: the next statement finished early ({:?})",
                started.elapsed()
            );
            assert_eq!(
                cell_as_i64(&res.rows[0][0]),
                0,
                "{round}: the next statement was interrupted"
            );
        }
    };

    // ストリーム経路: 停止要求は別タスクで送られる (fire は完了を待たない) まま、
    // 同じプールですぐ次の文を流す。
    for i in 0..2 {
        run_streamed_sleep_until_timeout(&session, &sleep_sql, Duration::from_millis(500)).await;
        assert_next_statement_survives(if i == 0 { "stream#0" } else { "stream#1" }).await;
    }

    // キャンセル経路 (タスクの abort): `StopGuard` の Drop が停止要求を送る。文がサーバで走って
    // いることを確かめてから abort し、直後に次の文を流す。
    {
        let poller = t::connect(opts).await.expect("connect poller");
        let ctx = t::ServerStopCtx::new(None);
        let task = {
            let session = session.clone();
            let sleep_sql = sleep_sql.clone();
            tokio::spawn(async move {
                let _guard = t::StopGuard::new(ctx.clone(), session.clone());
                let _ = t::server_stop_scope(ctx, async {
                    session
                        .conn
                        .execute_stream(&sleep_sql, None, 10, 10, |_| Ok(()))
                        .await
                })
                .await;
            })
        };
        poll_until("the cancelled statement appears", POLL_LIMIT, || async {
            active_count(&poller, sql, &marker).await > 0
        })
        .await;
        task.abort();
        let _ = task.await; // abort の完了 (= Drop 済み) を待つ
        assert_next_statement_survives("abort").await;
    }

    // ドライラン経路 (`spawn_preview_stream` と同じ手順): 文を poll しないまま停止要求の完了を
    // 待ち、future が終わって接続がプールへ戻ってから、タイムアウト後の `fire` を呼び、直後に
    // 再利用された接続で別の文を流す。この 2 回目の `fire` は冪等性の確認で、控えたバックエンド
    // ID は 1 度きりしか取り出せないため何も撃たないはず (本番もタイムアウト後に呼ぶ)。
    let lock = (sql.lock_sql)("noobdb_2102_lock_reuse");
    prepare_lock_table(&session, &lock).await;
    for _ in 0..2 {
        let mut guard = run_dry_run_with_probe(&session, &lock, None).await;
        guard.fire();
        guard.disarm();
        assert_next_statement_survives("dry-run").await;
    }
    teardown(&session, &lock).await;
}

async fn prepare_lock_table(session: &Arc<t::Session>, lock: &LockSql) {
    for stmt in &lock.setup {
        session
            .conn
            .execute(stmt, None)
            .await
            .unwrap_or_else(|e| panic!("{stmt}: {e}"));
    }
}

/// ドライランの UPDATE (行ロックを掴んで眠る) を `spawn_preview_stream` と同じ手順でタイムアウトさせる。
/// `lock_probe` が `Some` なら、停止前に行がロック中であることを、停止後に解放されたことを確かめる。
async fn run_dry_run_with_probe(
    session: &Arc<t::Session>,
    lock: &LockSql,
    probe: Option<(&t::Connection, &str)>,
) -> t::StopGuard {
    let ctx = t::ServerStopCtx::new(None);
    let exec = t::server_stop_scope(
        ctx.clone(),
        session
            .conn
            .preview_execute_with_limit(&lock.sleeping_update, None, 10),
    );
    tokio::pin!(exec);
    let guard = t::StopGuard::explicit_only(ctx, session.clone());
    tokio::select! {
        res = &mut exec => panic!("the sleeping dry-run must not finish by itself: {res:?}"),
        _ = tokio::time::sleep(Duration::from_secs(1)) => {
            if let Some((probe, marker)) = probe {
                // exec は poll していない (= 接続は future が持ったまま)。1 秒のあいだに
                // UPDATE は送信済みなので、行はロックされているはず。
                poll_until("the dry-run holds the row lock", POLL_LIMIT, || async {
                    assert_lock_conflict(&probe.execute(&lock.lock_nowait, None).await, marker)
                })
                .await;
            }
            let finished = guard.fire_and_drain(&mut exec).await;
            assert!(finished, "the dry-run future must end once its statement is stopped");
        }
    }
    guard
}

/// 3. ドライランがタイムアウトしたら、掴んでいた行ロックが解放される (別接続から待たずに取れる)。
pub async fn assert_dry_run_timeout_releases_row_lock(opts: &t::DbConnectOptions, sql: &StopSql) {
    let runner = t::connect(opts).await.expect("connect runner");
    let probe = t::connect(opts).await.expect("connect probe");
    let session = Arc::new(t::make_session("s2102c", runner, opts.clone(), false));
    let lock = (sql.lock_sql)("noobdb_2102_lock_release");
    prepare_lock_table(&session, &lock).await;

    // 実行前は誰もロックしていない。
    probe
        .execute(&lock.lock_nowait, None)
        .await
        .expect("row is free before the dry-run");

    let mut guard =
        run_dry_run_with_probe(&session, &lock, Some((&probe, sql.lock_conflict_marker))).await;
    guard.fire();
    guard.disarm();

    poll_until("the row lock is released", POLL_LIMIT, || async {
        probe.execute(&lock.lock_nowait, None).await.is_ok()
    })
    .await;
    // ドライランなので値は変わらない (ロールバックされた)。
    let v = probe.execute(&lock.select_v, None).await.expect("select v");
    assert_eq!(cell_as_i64(&v.rows[0][0]), 0);
    teardown(&session, &lock).await;
}

async fn teardown(session: &Arc<t::Session>, lock: &LockSql) {
    for stmt in &lock.teardown {
        session
            .conn
            .execute(stmt, None)
            .await
            .unwrap_or_else(|e| panic!("{stmt}: {e}"));
    }
}

// ---------------------------------------------------------------------------
// CREATE TABLE ウィザードのテーブルオプション (#2161) の共有ゴールデン
//
// `src/__tests__/fixtures/createTableOptionVectors.json` の `statements` は、フロントの
// `buildCreateTableStatements` の出力と一致することを Vitest が固定している。各ドライバの
// 統合テストが同じ文を実 DB へ流し、生成した DDL が通ることを確かめる。
// ---------------------------------------------------------------------------

#[derive(serde::Deserialize)]
pub struct CreateTableCase {
    pub name: String,
    pub driver: String,
    pub form: CreateTableForm,
    pub statements: Vec<String>,
}

#[derive(serde::Deserialize)]
pub struct CreateTableForm {
    pub table: String,
}

#[derive(serde::Deserialize)]
struct CreateTableVectors {
    cases: Vec<CreateTableCase>,
}

const CREATE_TABLE_VECTORS_JSON: &str =
    include_str!("../../../src/__tests__/fixtures/createTableOptionVectors.json");

/// 指定ドライバのケースだけを返す。
pub fn create_table_cases(driver: &str) -> Vec<CreateTableCase> {
    let vectors: CreateTableVectors =
        serde_json::from_str(CREATE_TABLE_VECTORS_JSON).expect("createTableOptionVectors.json");
    let cases: Vec<CreateTableCase> = vectors
        .cases
        .into_iter()
        .filter(|c| c.driver == driver)
        .collect();
    assert!(!cases.is_empty(), "no cases for driver {driver}");
    cases
}
