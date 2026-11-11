//! サーバ側の読み取り専用 (#2243) の統合テスト。
//!
//! 字句ガード (`is_read_only_sql_for`) は関数の中身を見ないので、書き込みを行うユーザー定義関数を
//! `SELECT f()` で呼ぶ文は通ってしまう。読み取り専用を強制する経路 (read_only セッション・
//! 自動更新・ブロードキャスト・EXPLAIN ANALYZE・書き出し・スケジューラ) はサーバ側でも
//! 読み取り専用 (PostgreSQL / MySQL は READ ONLY トランザクション、SQLite は `query_only`) に
//! して止める。ここでは:
//!
//! - 書き込む関数を SELECT しても、強制の中ではサーバのエラーで止まり、行が残ること
//!   (自動更新・ブロードキャスト・EXPLAIN ANALYZE・書き出しは `read_only_scope` を張る点が共通)
//! - 強制が終わったあとの同じプールの接続が書き込めること (設定の漏れ出し無し)
//! - 書き込みプレビュー (dry-run) が従来どおり動くこと
//!
//! PostgreSQL は `NOOBDB_TEST_POSTGRES_URL`、MySQL は `NOOBDB_TEST_MYSQL_URL` が無ければスキップ。
//! SQLite は外部サーバ不要で常時走る。

use super::common; // 共有ヘルパは groups/external.rs が 1 度だけ取り込む

use noobdb_lib::__test_api as t;

/// サーバ側の読み取り専用で拒否された旨のエラーか (ドライバごとに文言が違う)。
fn is_read_only_rejection(err: &t::AppError) -> bool {
    let m = err.to_string().to_ascii_lowercase();
    m.contains("read-only") || m.contains("read only") || m.contains("readonly")
}

async fn count(conn: &t::Connection, table: &str) -> i64 {
    let r = conn
        .execute(&format!("SELECT count(*) FROM {table}"), None)
        .await
        .expect("count");
    match &r.rows[0][0] {
        t::Value::Int(n) => *n,
        t::Value::String(s) => s.parse().expect("count as string"),
        other => panic!("unexpected count value: {other:?}"),
    }
}

/// 強制の中で `sql` を (ストリーミング経路で) 実行する。自動更新・ブロードキャスト・
/// EXPLAIN ANALYZE・書き出しが通る `execute_stream` 側。
async fn stream_enforced(conn: &t::Connection, sql: &str) -> Result<(), t::AppError> {
    t::read_only_scope(async {
        conn.execute_stream(sql, None, 100, 100, |_| Ok(()))
            .await
            .map(|_| ())
    })
    .await
}

async fn exec_enforced(conn: &t::Connection, sql: &str) -> Result<(), t::AppError> {
    t::read_only_scope(async { conn.execute(sql, None).await.map(|_| ()) }).await
}

/// 共通の検証本体。`func_call` は表 `table` を全消しするユーザー定義関数の呼び出し。
async fn assert_enforced_blocks_writing_function(
    conn: &t::Connection,
    opts: &t::DbConnectOptions,
    table: &str,
    func_call: &str,
    explain_analyze: Option<String>,
) {
    assert_eq!(count(conn, table).await, 2, "seed");

    // 通常の (強制なし) 実行では関数が書き込む = 字句ガードだけでは防げない前提の確認。
    assert!(
        t::is_read_only_sql_for(conn.driver_kind(), func_call),
        "字句ガードは `{func_call}` を通す (これがこのテストの前提)"
    );

    // 強制の中は、通常実行・ストリーミング実行のどちらもサーバが拒否し、行は残る。
    // 複数回回して、プールのどの接続でも効くこと・戻した後に漏れないことも見る。
    for _ in 0..6 {
        let e = exec_enforced(conn, func_call)
            .await
            .expect_err("execute must be rejected by the server");
        assert!(is_read_only_rejection(&e), "unexpected error: {e}");
        let e = stream_enforced(conn, func_call)
            .await
            .expect_err("stream must be rejected by the server");
        assert!(is_read_only_rejection(&e), "unexpected error: {e}");
    }
    if let Some(sql) = explain_analyze {
        let e = stream_enforced(conn, &sql)
            .await
            .expect_err("EXPLAIN ANALYZE must be rejected by the server");
        assert!(is_read_only_rejection(&e), "unexpected error: {e}");
    }
    assert_eq!(count(conn, table).await, 2, "行が消えていない");

    // 強制の中でも普通の読み取りは通る。
    exec_enforced(conn, &format!("SELECT count(*) FROM {table}"))
        .await
        .expect("read inside enforcement");
    stream_enforced(conn, &format!("SELECT * FROM {table}"))
        .await
        .expect("stream read inside enforcement");

    // read_only セッション (コマンド経路) でも同じ。字句ガードは通るがサーバが止める。
    let state = t::AppState::default();
    let session = t::make_session(
        "ro_srv",
        t::connect(opts).await.expect("connect ro session"),
        opts.clone(),
        true,
    );
    let sid = state.insert(session).await;
    let e = t::run_query_via_command(&state, &sid, func_call, None)
        .await
        .expect_err("read_only session must be rejected by the server");
    assert!(is_read_only_rejection(&e), "unexpected error: {e}");
    assert_eq!(count(conn, table).await, 2, "コマンド経路でも行が残る");

    // 強制の外 (プールへ戻った接続) は書き込める = READ ONLY が漏れ出していない。
    for _ in 0..6 {
        conn.execute(&format!("INSERT INTO {table} (id) VALUES (100)"), None)
            .await
            .expect("write after enforcement must work");
        conn.execute(&format!("DELETE FROM {table} WHERE id = 100"), None)
            .await
            .expect("cleanup row");
    }

    // 書き込みプレビュー (dry-run) は従来どおり動き、ロールバックされる。
    let preview = conn
        .preview_execute_with_limit(&format!("DELETE FROM {table}"), None, 10)
        .await
        .expect("dry-run preview must work");
    assert_eq!(preview.rows_affected, 2);
    assert_eq!(count(conn, table).await, 2, "dry-run はロールバックされる");

    // 最後に、強制なしなら関数が実際に書き込むこと (テストが空振りでないことの裏取り)。
    conn.execute(func_call, None)
        .await
        .expect("unenforced call");
    assert_eq!(count(conn, table).await, 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn postgres_read_only_is_enforced_server_side() {
    let Some(url) = common::require_env("NOOBDB_TEST_POSTGRES_URL") else {
        return;
    };
    let opts = t::parse_postgres_url(&url).expect("valid url");
    let conn = t::connect(&opts).await.expect("connect");
    let pid = std::process::id();
    let table = format!("public.noobdb_ro_srv_{pid}");
    let func = format!("public.noobdb_ro_purge_{pid}");
    let _ = conn
        .execute(&format!("DROP FUNCTION IF EXISTS {func}()"), None)
        .await;
    conn.execute(&format!("DROP TABLE IF EXISTS {table}"), None)
        .await
        .expect("drop");
    conn.execute(&format!("CREATE TABLE {table} (id INT PRIMARY KEY)"), None)
        .await
        .expect("create table");
    conn.execute(&format!("INSERT INTO {table} (id) VALUES (1), (2)"), None)
        .await
        .expect("seed");
    conn.execute(
        &format!(
            "CREATE FUNCTION {func}() RETURNS int LANGUAGE sql AS $$ DELETE FROM {table} RETURNING 1 $$"
        ),
        None,
    )
    .await
    .expect("create function");

    let call = format!("SELECT {func}()");
    assert_enforced_blocks_writing_function(
        &conn,
        &opts,
        &table,
        &call,
        Some(format!("EXPLAIN ANALYZE {call}")),
    )
    .await;

    let _ = conn
        .execute(&format!("DROP FUNCTION IF EXISTS {func}()"), None)
        .await;
    let _ = conn
        .execute(&format!("DROP TABLE IF EXISTS {table}"), None)
        .await;
    conn.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn mysql_read_only_is_enforced_server_side() {
    let Some(url) = common::require_env("NOOBDB_TEST_MYSQL_URL") else {
        return;
    };
    let opts = t::parse_mysql_url(&url).expect("valid url");
    let conn = t::connect(&opts).await.expect("connect");
    let pid = std::process::id();
    let table = format!("noobdb_ro_srv_{pid}");
    let func = format!("noobdb_ro_purge_{pid}");
    let _ = conn
        .execute(&format!("DROP FUNCTION IF EXISTS {func}"), None)
        .await;
    conn.execute(&format!("DROP TABLE IF EXISTS {table}"), None)
        .await
        .expect("drop");
    conn.execute(
        &format!("CREATE TABLE {table} (id INT PRIMARY KEY) ENGINE=InnoDB"),
        None,
    )
    .await
    .expect("create table");
    conn.execute(&format!("INSERT INTO {table} (id) VALUES (1), (2)"), None)
        .await
        .expect("seed");
    // CREATE FUNCTION はプリペアド文のプロトコルでは流せないので、テキストプロトコルで流す
    // `execute_maintenance` を使う。バイナリログが有効で権限が足りないと作れない (その環境では検証できない)。
    if let Err(e) = conn
        .execute_maintenance(
            &format!(
                "CREATE FUNCTION {func}() RETURNS INT MODIFIES SQL DATA BEGIN DELETE FROM {table}; RETURN 1; END"
            ),
            None,
        )
        .await
    {
        assert!(
            e.to_string().contains("log_bin_trust_function_creators"),
            "unexpected error creating function: {e}"
        );
        common::skip_capability(&format!("cannot create stored function: {e}"));
        let _ = conn.execute(&format!("DROP TABLE IF EXISTS {table}"), None).await;
        conn.close().await;
        return;
    }

    let call = format!("SELECT {func}()");
    assert_enforced_blocks_writing_function(&conn, &opts, &table, &call, None).await;

    let _ = conn
        .execute(&format!("DROP FUNCTION IF EXISTS {func}"), None)
        .await;
    let _ = conn
        .execute(&format!("DROP TABLE IF EXISTS {table}"), None)
        .await;
    conn.close().await;
}

/// SQLite: 強制の中の書き込みは `attempt to write a readonly database` で拒否され、
/// 強制の外 (プールへ戻った接続) は書き込める。書き込みプレビューも動く。
#[tokio::test(flavor = "multi_thread")]
async fn sqlite_read_only_is_enforced_server_side() {
    let mut path = std::env::temp_dir();
    path.push(format!("noobdb_ro_srv_{}.db", std::process::id()));
    let _ = std::fs::remove_file(&path);
    std::fs::File::create(&path).expect("create temp sqlite file");
    let opts = t::sqlite_options(path.to_str().expect("utf8 path"));
    let conn = t::connect(&opts).await.expect("connect");
    conn.execute("CREATE TABLE t (id INTEGER PRIMARY KEY)", None)
        .await
        .expect("create");
    conn.execute("INSERT INTO t (id) VALUES (1), (2)", None)
        .await
        .expect("seed");

    for _ in 0..6 {
        let e = exec_enforced(&conn, "INSERT INTO t (id) VALUES (3)")
            .await
            .expect_err("execute must be rejected");
        assert!(
            e.to_string()
                .contains("attempt to write a readonly database"),
            "unexpected error: {e}"
        );
        let e = stream_enforced(&conn, "DELETE FROM t")
            .await
            .expect_err("stream must be rejected");
        assert!(
            e.to_string()
                .contains("attempt to write a readonly database"),
            "unexpected error: {e}"
        );
    }
    assert_eq!(count(&conn, "t").await, 2);

    // 強制の中でも読み取りは通る。
    exec_enforced(&conn, "SELECT count(*) FROM t")
        .await
        .expect("read inside enforcement");
    stream_enforced(&conn, "SELECT * FROM t")
        .await
        .expect("stream read inside enforcement");

    // 強制の外は書き込める (query_only が漏れ出していない)。
    for _ in 0..6 {
        conn.execute("INSERT INTO t (id) VALUES (100)", None)
            .await
            .expect("write after enforcement must work");
        conn.execute("DELETE FROM t WHERE id = 100", None)
            .await
            .expect("cleanup row");
    }

    // 書き込みプレビュー (dry-run) は従来どおり動いてロールバックされる。
    let preview = conn
        .preview_execute_with_limit("DELETE FROM t", None, 10)
        .await
        .expect("dry-run preview must work");
    assert_eq!(preview.rows_affected, 2);
    assert_eq!(count(&conn, "t").await, 2);

    // read_only セッションの読み取りは通る。
    let state = t::AppState::default();
    let ro_conn = t::connect(&opts).await.expect("connect ro");
    let sid = state
        .insert(t::make_session("ro_sqlite", ro_conn, opts.clone(), true))
        .await;
    let r = t::run_query_via_command(&state, &sid, "SELECT id FROM t ORDER BY id", None)
        .await
        .expect("read_only select");
    assert_eq!(r.rows.len(), 2);

    conn.close().await;
    let _ = std::fs::remove_file(&path);
}
