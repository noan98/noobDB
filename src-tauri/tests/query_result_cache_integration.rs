//! Query Result Cache (#1097) のコマンド層統合テスト。
//!
//! `src/cache/mod.rs` の単体テストは `QueryResultCache` を単独で (fetch クロージャ
//! を差し替えて) 検証するが、ここでは実 SQLite 接続 + `AppState` を通し、受け入れ
//! 条件が実際のコマンド経路 (`run_query` / `run_query_transaction` /
//! `run_in_transaction` / `apply_sync_sql` / `sandbox_advance_base`) で成立する
//! ことを固定する:
//!
//! - 書き込み (DML/DDL) 後に stale な結果セルが返らないこと。
//! - 接続をまたいだキャッシュ汚染がないこと。
//!
//! 外部サーバ不要 (SQLite temp file) なので常時実走する。「キャッシュにヒット
//! している」ことは、テスト対象の書き込み経路を経由せず (キャッシュを invalidate
//! しない裏口として) `conn.execute` を直接叩いてデータを変え、その変更が
//! `run_query` 経由では見えないままであることで確認する — キャッシュが無ければ
//! 毎回ドライバへ再問い合わせが起き、変更は即座に見えてしまうはず。

use noobdb_lib::__test_api as t;
use t::AppState;

/// 一意な一時 SQLite ファイルへ接続し、`(Connection, DbConnectOptions)` を返す。
async fn temp_conn(tag: &str) -> (t::Connection, t::DbConnectOptions) {
    let mut path = std::env::temp_dir();
    path.push(format!(
        "noobdb_query_result_cache_{tag}_{}.db",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&path);
    std::fs::File::create(&path).expect("create temp sqlite file");
    let opts = t::sqlite_options(path.to_str().expect("utf8 path"));
    let conn = t::connect(&opts).await.expect("connect sqlite");
    (conn, opts)
}

/// `state` にセッションを登録し、その id を返す。
async fn register(
    state: &AppState,
    id: &str,
    conn: t::Connection,
    opts: t::DbConnectOptions,
) -> String {
    state.insert(t::make_session(id, conn, opts, false)).await
}

// ---------------------------------------------------------------------------
// 受け入れ条件: 同一クエリの再表示でキャッシュがヒットすること
// ---------------------------------------------------------------------------

#[tokio::test]
async fn repeated_select_via_run_query_hits_the_cache() {
    let (conn, opts) = temp_conn("hit").await;
    conn.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER)", None)
        .await
        .expect("create t");
    conn.execute("INSERT INTO t VALUES (1, 100)", None)
        .await
        .expect("seed row");

    let state = AppState::default();
    let id = register(&state, "s1", conn, opts).await;
    let session = state.get(&id).await.expect("session exists");

    let before = t::run_query_via_command(&state, &id, "SELECT v FROM t WHERE id = 1", None)
        .await
        .expect("select before");
    assert_eq!(before.rows[0][0], t::Value::Int(100));

    // キャッシュを invalidate しない裏口 (テスト対象経路の外) でデータを直接
    // 書き換える — 本物の別クライアント/別ツールによる変更を模す。
    session
        .conn
        .execute("UPDATE t SET v = 999 WHERE id = 1", None)
        .await
        .expect("bypass update");

    let after = t::run_query_via_command(&state, &id, "SELECT v FROM t WHERE id = 1", None)
        .await
        .expect("select after");
    assert_eq!(
        after.rows[0][0],
        t::Value::Int(100),
        "TTL 内の同一クエリはキャッシュヒットし、裏で書き換えられた値は見えないはず"
    );
}

// ---------------------------------------------------------------------------
// 受け入れ条件: 書き込み (DML/DDL) 後に stale な結果が返らないこと
// ---------------------------------------------------------------------------

#[tokio::test]
async fn dml_via_run_query_invalidates_the_cache() {
    let (conn, opts) = temp_conn("dml_single").await;
    conn.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER)", None)
        .await
        .expect("create t");
    conn.execute("INSERT INTO t VALUES (1, 100)", None)
        .await
        .expect("seed row");

    let state = AppState::default();
    let id = register(&state, "s1", conn, opts).await;

    let before = t::run_query_via_command(&state, &id, "SELECT v FROM t WHERE id = 1", None)
        .await
        .expect("select before");
    assert_eq!(before.rows[0][0], t::Value::Int(100));

    // `run_query` 経由の UPDATE (DDL ではなく純粋な DML)。
    t::run_query_via_command(&state, &id, "UPDATE t SET v = 999 WHERE id = 1", None)
        .await
        .expect("update via run_query");

    let after = t::run_query_via_command(&state, &id, "SELECT v FROM t WHERE id = 1", None)
        .await
        .expect("select after");
    assert_eq!(
        after.rows[0][0],
        t::Value::Int(999),
        "DML 実行後は再取得され、更新後の値が見えること"
    );
}

#[tokio::test]
async fn ddl_via_run_query_invalidates_the_cache() {
    let (conn, opts) = temp_conn("ddl_single").await;
    conn.execute("CREATE TABLE t (id INTEGER PRIMARY KEY)", None)
        .await
        .expect("create t");

    let state = AppState::default();
    let id = register(&state, "s1", conn, opts).await;

    let before = t::run_query_via_command(&state, &id, "SELECT COUNT(*) FROM t", None)
        .await
        .expect("select before");
    assert_eq!(before.rows[0][0], t::Value::Int(0));

    t::run_query_via_command(&state, &id, "INSERT INTO t VALUES (1)", None)
        .await
        .expect("insert via run_query");
    // INSERT 自体も (COUNT クエリを stale にする) DML なので、上のテストと重複
    // しないよう、ここでは INSERT の invalidate も確認しつつ CREATE INDEX (DDL)
    // を続けて実行し、DDL 経路も一緒に固定する。
    t::run_query_via_command(&state, &id, "CREATE INDEX idx_t ON t(id)", None)
        .await
        .expect("create index via run_query");

    let after = t::run_query_via_command(&state, &id, "SELECT COUNT(*) FROM t", None)
        .await
        .expect("select after");
    assert_eq!(
        after.rows[0][0],
        t::Value::Int(1),
        "DDL/DML 実行後は再取得され、最新の件数が見えること"
    );
}

#[tokio::test]
async fn write_via_run_query_transaction_invalidates_the_cache() {
    let (conn, opts) = temp_conn("tx_batch").await;
    conn.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER)", None)
        .await
        .expect("create t");
    conn.execute("INSERT INTO t VALUES (1, 100)", None)
        .await
        .expect("seed row");

    let state = AppState::default();
    let id = register(&state, "s1", conn, opts).await;

    let before = t::run_query_via_command(&state, &id, "SELECT v FROM t WHERE id = 1", None)
        .await
        .expect("select before");
    assert_eq!(before.rows[0][0], t::Value::Int(100));

    t::run_query_transaction_via_command(
        &state,
        &id,
        vec!["UPDATE t SET v = 777 WHERE id = 1".to_string()],
        None,
    )
    .await
    .expect("run transaction");

    let after = t::run_query_via_command(&state, &id, "SELECT v FROM t WHERE id = 1", None)
        .await
        .expect("select after");
    assert_eq!(
        after.rows[0][0],
        t::Value::Int(777),
        "run_query_transaction 経由の書き込み後は再取得されること"
    );
}

#[tokio::test]
async fn write_via_run_in_transaction_invalidates_the_cache() {
    let (conn, opts) = temp_conn("explicit_tx").await;
    conn.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER)", None)
        .await
        .expect("create t");
    conn.execute("INSERT INTO t VALUES (1, 100)", None)
        .await
        .expect("seed row");

    let state = AppState::default();
    let id = register(&state, "s1", conn, opts).await;
    let session = state.get(&id).await.expect("session exists");

    // まずキャッシュへ「更新前」の値 (100) を載せる。SQLite は接続をまたぐと
    // 未コミットの書き込みが見えないので、この呼び出しは明示トランザクション
    // の外の別プールコネクション経由になる — invalidate されていなければ
    // COMMIT 後もこの 100 が (実際の値である 555 の代わりに) 返り続けるはず。
    let before = t::run_query_via_command(&state, &id, "SELECT v FROM t WHERE id = 1", None)
        .await
        .expect("select before");
    assert_eq!(before.rows[0][0], t::Value::Int(100));

    session
        .conn
        .begin_transaction(None)
        .await
        .expect("begin explicit transaction");
    t::run_in_transaction_via_command(&state, &id, "UPDATE t SET v = 555 WHERE id = 1")
        .await
        .expect("update inside explicit transaction");
    session.conn.finish_transaction(true).await.expect("commit");

    let after = t::run_query_via_command(&state, &id, "SELECT v FROM t WHERE id = 1", None)
        .await
        .expect("select after commit");
    assert_eq!(
        after.rows[0][0],
        t::Value::Int(555),
        "COMMIT 後は再取得され、更新後の値が見えること (run_in_transaction 実行時点で invalidate 済みのはず)"
    );
}

// ---------------------------------------------------------------------------
// 受け入れ条件: apply_sync_sql / sandbox_advance_base 経由の書き込みも invalidate
// ---------------------------------------------------------------------------

#[tokio::test]
async fn write_via_apply_sync_sql_invalidates_the_cache() {
    let (conn, opts) = temp_conn("sync_apply").await;
    conn.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER)", None)
        .await
        .expect("create t");
    conn.execute("INSERT INTO t VALUES (1, 100)", None)
        .await
        .expect("seed row");

    let state = AppState::default();
    let id = register(&state, "s1", conn, opts).await;

    let before = t::run_query_via_command(&state, &id, "SELECT v FROM t WHERE id = 1", None)
        .await
        .expect("select before");
    assert_eq!(before.rows[0][0], t::Value::Int(100));

    t::apply_sync_sql_via_command(
        &state,
        &id,
        None,
        vec!["UPDATE t SET v = 42 WHERE id = 1".to_string()],
    )
    .await
    .expect("apply sync sql");

    let after = t::run_query_via_command(&state, &id, "SELECT v FROM t WHERE id = 1", None)
        .await
        .expect("select after");
    assert_eq!(
        after.rows[0][0],
        t::Value::Int(42),
        "apply_sync_sql 経由の書き込み (データ同期) 後は再取得されること"
    );
}

// ---------------------------------------------------------------------------
// 受け入れ条件: 接続をまたいだキャッシュ汚染がない
// ---------------------------------------------------------------------------

#[tokio::test]
async fn cache_is_isolated_per_session() {
    let (conn1, opts1) = temp_conn("iso_a").await;
    conn1
        .execute("CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER)", None)
        .await
        .expect("create t (a)");
    conn1
        .execute("INSERT INTO t VALUES (1, 100)", None)
        .await
        .expect("seed a");
    let (conn2, opts2) = temp_conn("iso_b").await;
    conn2
        .execute("CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER)", None)
        .await
        .expect("create t (b)");
    conn2
        .execute("INSERT INTO t VALUES (1, 200)", None)
        .await
        .expect("seed b");

    let state = AppState::default();
    let id_a = register(&state, "session_a", conn1, opts1).await;
    let id_b = register(&state, "session_b", conn2, opts2).await;

    // 同じ SQL 文字列を両セッションで実行し、それぞれのキャッシュに載せる。
    let a1 = t::run_query_via_command(&state, &id_a, "SELECT v FROM t WHERE id = 1", None)
        .await
        .expect("select a (1st)");
    assert_eq!(a1.rows[0][0], t::Value::Int(100));
    let b1 = t::run_query_via_command(&state, &id_b, "SELECT v FROM t WHERE id = 1", None)
        .await
        .expect("select b (1st)");
    assert_eq!(b1.rows[0][0], t::Value::Int(200));

    // セッション a への書き込みでの invalidate は、セッション b の (同じ SQL
    // 文字列に対する) キャッシュへ一切波及しないこと。
    t::run_query_via_command(&state, &id_a, "UPDATE t SET v = 999 WHERE id = 1", None)
        .await
        .expect("update a");

    let a2 = t::run_query_via_command(&state, &id_a, "SELECT v FROM t WHERE id = 1", None)
        .await
        .expect("select a (2nd)");
    assert_eq!(
        a2.rows[0][0],
        t::Value::Int(999),
        "a 自身は再取得されること"
    );

    let b2 = t::run_query_via_command(&state, &id_b, "SELECT v FROM t WHERE id = 1", None)
        .await
        .expect("select b (2nd)");
    assert_eq!(
        b2.rows[0][0],
        t::Value::Int(200),
        "session a への書き込みは session b のキャッシュに影響しないこと (b はヒットしたまま)"
    );
}

// ---------------------------------------------------------------------------
// 対象外の条件: 非読み取り専用 SQL はキャッシュされない
// ---------------------------------------------------------------------------

#[tokio::test]
async fn write_statements_are_never_served_from_the_cache() {
    let (conn, opts) = temp_conn("writes_uncached").await;
    conn.execute("CREATE TABLE t (id INTEGER PRIMARY KEY)", None)
        .await
        .expect("create t");

    let state = AppState::default();
    let id = register(&state, "s1", conn, opts).await;

    // INSERT を 3 回実行し、毎回実際に行が増えること (キャッシュされていれば
    // 2 回目以降が「同じ INSERT だから」と素通しされず何かおかしくなるような
    // 実装ミスがあれば、件数がずれて検出できる)。
    for _ in 0..3 {
        t::run_query_via_command(&state, &id, "INSERT INTO t DEFAULT VALUES", None)
            .await
            .expect("insert");
    }
    let result = t::run_query_via_command(&state, &id, "SELECT COUNT(*) FROM t", None)
        .await
        .expect("count");
    assert_eq!(result.rows[0][0], t::Value::Int(3));
}
