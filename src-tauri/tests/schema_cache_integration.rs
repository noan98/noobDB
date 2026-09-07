//! Schema Cache (#1097) のコマンド層統合テスト。
//!
//! `src/cache/mod.rs` の単体テストは `SchemaCache` を単独で (fetch クロージャを
//! 差し替えて) 検証するが、ここでは実 SQLite 接続 + `AppState` を通し、受け入れ
//! 条件が実際のコマンド経路 (`run_query` / `run_query_transaction` /
//! `refresh_schema_cache` / `reconnect`) で成立することを固定する:
//!
//! - Refresh/DDL 後に stale なスキーマが表示されないこと。
//! - 接続をまたいだキャッシュ汚染がないこと。
//! - 再接続後のキャッシュが正しく (空から) 始まること。
//!
//! 外部サーバ不要 (SQLite temp file) なので常時実走する。

use noobdb_lib::__test_api as t;
use t::AppState;

/// 一意な一時 SQLite ファイルへ接続し、`(Connection, DbConnectOptions, パス)` を返す。
/// `opts` はテスト内でそのまま `make_session` に渡す — `reconnect` はここに保持された
/// パスを使って接続を開き直すため、実際に使う DB ファイルと一致している必要がある
/// (`sync_apply_integration.rs` のように無関係なプレースホルダパスにはしない)。
async fn temp_conn(tag: &str) -> (t::Connection, t::DbConnectOptions, std::path::PathBuf) {
    let mut path = std::env::temp_dir();
    path.push(format!(
        "noobdb_schema_cache_{tag}_{}.db",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&path);
    std::fs::File::create(&path).expect("create temp sqlite file");
    let opts = t::sqlite_options(path.to_str().expect("utf8 path"));
    let conn = t::connect(&opts).await.expect("connect sqlite");
    (conn, opts, path)
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
// 受け入れ条件: 同一接続での重複introspectionが削減される
// ---------------------------------------------------------------------------

#[tokio::test]
async fn repeated_tables_call_reuses_the_cached_result() {
    let (conn, opts, _path) = temp_conn("hit").await;
    conn.execute("CREATE TABLE t (id INTEGER PRIMARY KEY)", None)
        .await
        .expect("create t");

    let state = AppState::default();
    let id = register(&state, "s1", conn, opts).await;
    let session = state.get(&id).await.expect("session exists");

    let calls = std::sync::atomic::AtomicUsize::new(0);
    for _ in 0..3 {
        let conn = &session.conn;
        let calls = &calls;
        let tables = session
            .schema_cache
            .tables("main", || async move {
                calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                conn.tables("main").await
            })
            .await
            .expect("tables");
        assert!(tables.iter().any(|t| t == "t"));
    }
    assert_eq!(
        calls.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "2 回目以降はキャッシュから返り、ドライバへ再問い合わせしないこと"
    );
}

// ---------------------------------------------------------------------------
// 受け入れ条件: Refresh/DDL後にstale schemaが表示されない
// ---------------------------------------------------------------------------

#[tokio::test]
async fn ddl_via_run_query_invalidates_the_cache() {
    let (conn, opts, _path) = temp_conn("ddl_single").await;

    let state = AppState::default();
    let id = register(&state, "s1", conn, opts).await;
    let session = state.get(&id).await.expect("session exists");

    // まだテーブルが無い状態で一度キャッシュへ載せる。
    let before = session
        .schema_cache
        .tables("main", || session.conn.tables("main"))
        .await
        .expect("tables before create");
    assert!(before.is_empty(), "作成前は空のはず: {before:?}");

    // `run_query` 経由で CREATE TABLE を実行 — `sql_may_change_schema` が検出し、
    // このセッションのスキーマキャッシュを invalidate するはず。
    t::run_query_via_command(&state, &id, "CREATE TABLE t (id INTEGER PRIMARY KEY)", None)
        .await
        .expect("create table via run_query");

    let after = session
        .schema_cache
        .tables("main", || session.conn.tables("main"))
        .await
        .expect("tables after create");
    assert!(
        after.iter().any(|t| t == "t"),
        "DDL 後は再取得され、新しいテーブルが見えること: {after:?}"
    );
}

#[tokio::test]
async fn ddl_via_run_query_transaction_invalidates_the_cache() {
    let (conn, opts, _path) = temp_conn("ddl_tx").await;
    conn.execute("CREATE TABLE old_table (id INTEGER PRIMARY KEY)", None)
        .await
        .expect("seed old_table");

    let state = AppState::default();
    let id = register(&state, "s1", conn, opts).await;
    let session = state.get(&id).await.expect("session exists");

    let before = session
        .schema_cache
        .tables("main", || session.conn.tables("main"))
        .await
        .expect("tables before");
    assert!(before.iter().any(|t| t == "old_table"));

    // 複数文のうち後段だけが DDL (ALTER TABLE の代わりに SQLite でもサポート
    // される RENAME TO を使う) — トランザクション全体が invalidate 対象になる
    // ことを確認する。
    t::run_query_transaction_via_command(
        &state,
        &id,
        vec![
            "INSERT INTO old_table (id) VALUES (1)".to_string(),
            "ALTER TABLE old_table RENAME TO new_table".to_string(),
        ],
        None,
    )
    .await
    .expect("run transaction");

    let after = session
        .schema_cache
        .tables("main", || session.conn.tables("main"))
        .await
        .expect("tables after");
    assert!(
        after.iter().any(|t| t == "new_table"),
        "トランザクション内の DDL 後は再取得されること: {after:?}"
    );
    assert!(
        !after.iter().any(|t| t == "old_table"),
        "リネーム後は旧名が残っていないこと: {after:?}"
    );
}

#[tokio::test]
async fn non_ddl_write_does_not_invalidate_the_cache() {
    let (conn, opts, _path) = temp_conn("dml_only").await;
    conn.execute("CREATE TABLE t (id INTEGER PRIMARY KEY)", None)
        .await
        .expect("create t");

    let state = AppState::default();
    let id = register(&state, "s1", conn, opts).await;
    let session = state.get(&id).await.expect("session exists");

    let calls = std::sync::atomic::AtomicUsize::new(0);
    let fetch_once = || async {
        calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        session.conn.tables("main").await
    };
    session
        .schema_cache
        .tables("main", fetch_once)
        .await
        .expect("prime cache");

    // 純粋な DML (INSERT) はスキーマを変えないので invalidate されないこと。
    t::run_query_via_command(&state, &id, "INSERT INTO t (id) VALUES (1)", None)
        .await
        .expect("insert");

    let fetch_again = || async {
        calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        session.conn.tables("main").await
    };
    session
        .schema_cache
        .tables("main", fetch_again)
        .await
        .expect("tables after insert");

    assert_eq!(
        calls.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "DML 実行はキャッシュを invalidate せず、ヒットしたままのはず"
    );
}

#[tokio::test]
async fn explicit_refresh_forces_refetch() {
    let (conn, opts, _path) = temp_conn("refresh").await;
    conn.execute("CREATE TABLE t (id INTEGER PRIMARY KEY)", None)
        .await
        .expect("create t");

    let state = AppState::default();
    let id = register(&state, "s1", conn, opts).await;
    let session = state.get(&id).await.expect("session exists");

    session
        .schema_cache
        .tables("main", || session.conn.tables("main"))
        .await
        .expect("prime cache");

    // 明示的 Refresh (Schema Browser の更新ボタン相当) を呼ぶ。
    t::refresh_schema_cache_via_command(&state, &id)
        .await
        .expect("refresh");

    // Refresh 後は fetch クロージャが必ず実行されること — 呼ばれなければ
    // "STALE" が返ってきてしまうテスト設計。
    let result = session
        .schema_cache
        .tables("main", || async { Ok(vec!["FRESH".to_string()]) })
        .await
        .expect("tables after refresh");
    assert_eq!(result, vec!["FRESH".to_string()]);
}

// ---------------------------------------------------------------------------
// 受け入れ条件: 接続をまたいだキャッシュ汚染がない
// ---------------------------------------------------------------------------

#[tokio::test]
async fn cache_is_isolated_per_session() {
    let (conn1, opts1, _path1) = temp_conn("iso_a").await;
    conn1
        .execute("CREATE TABLE a_only (id INTEGER PRIMARY KEY)", None)
        .await
        .expect("create a_only");
    let (conn2, opts2, _path2) = temp_conn("iso_b").await;
    conn2
        .execute("CREATE TABLE b_only (id INTEGER PRIMARY KEY)", None)
        .await
        .expect("create b_only");

    let state = AppState::default();
    let id_a = register(&state, "session_a", conn1, opts1).await;
    let id_b = register(&state, "session_b", conn2, opts2).await;
    let session_a = state.get(&id_a).await.expect("session a exists");
    let session_b = state.get(&id_b).await.expect("session b exists");

    let tables_a = session_a
        .schema_cache
        .tables("main", || session_a.conn.tables("main"))
        .await
        .expect("tables a");
    let tables_b = session_b
        .schema_cache
        .tables("main", || session_b.conn.tables("main"))
        .await
        .expect("tables b");

    assert!(tables_a.iter().any(|t| t == "a_only"));
    assert!(!tables_a.iter().any(|t| t == "b_only"));
    assert!(tables_b.iter().any(|t| t == "b_only"));
    assert!(!tables_b.iter().any(|t| t == "a_only"));

    // セッション a に対する DDL invalidate はセッション b のキャッシュに影響
    // しないこと。
    t::run_query_via_command(
        &state,
        &id_a,
        "CREATE TABLE another (id INTEGER PRIMARY KEY)",
        None,
    )
    .await
    .expect("create another on session a");

    let calls_b = std::sync::atomic::AtomicUsize::new(0);
    let tables_b_again = session_b
        .schema_cache
        .tables("main", || {
            calls_b.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            async { Ok(vec!["SHOULD_NOT_BE_USED".to_string()]) }
        })
        .await
        .expect("tables b again");
    assert_eq!(
        calls_b.load(std::sync::atomic::Ordering::SeqCst),
        0,
        "session a への DDL は session b のキャッシュを invalidate してはいけない"
    );
    assert_eq!(
        tables_b_again, tables_b,
        "session b のキャッシュはヒットしたままのはず"
    );
}

// ---------------------------------------------------------------------------
// 受け入れ条件: 接続再確立時のキャッシュ有効性 (reconnect は必ず空から始まる)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn reconnect_replaces_the_session_with_an_empty_cache() {
    let (conn, opts, _path) = temp_conn("reconnect").await;
    conn.execute("CREATE TABLE t (id INTEGER PRIMARY KEY)", None)
        .await
        .expect("create t");

    let state = AppState::default();
    let id = register(&state, "s1", conn, opts).await;

    {
        let session = state.get(&id).await.expect("session exists");
        session
            .schema_cache
            .tables("main", || async { Ok(vec!["GHOST".to_string()]) })
            .await
            .expect("prime with a deliberately wrong value");
    }

    t::reconnect_via_command(&state, &id)
        .await
        .expect("reconnect");

    // reconnect は Session ごと差し替えるので、古いキャッシュの "GHOST" は
    // 新しい Session には存在せず、fetch クロージャが必ず実行されること。
    let session = state
        .get(&id)
        .await
        .expect("session exists after reconnect");
    let calls = std::sync::atomic::AtomicUsize::new(0);
    let tables = session
        .schema_cache
        .tables("main", || {
            calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            session.conn.tables("main")
        })
        .await
        .expect("tables after reconnect");
    assert_eq!(
        calls.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "reconnect 後は必ず fetch が走ること (空のキャッシュから始まる)"
    );
    assert!(tables.iter().any(|t| t == "t"));
    assert!(!tables.iter().any(|t| t == "GHOST"));
}
