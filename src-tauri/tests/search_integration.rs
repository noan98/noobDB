//! 検索系 (#1261) のコマンド層統合テスト: グローバルオブジェクト検索 / Where-used / 値検索。
//!
//! SQLite (一時ファイル) のテストは常時実走する。MySQL / PostgreSQL は
//! `NOOBDB_TEST_MYSQL_URL` / `NOOBDB_TEST_POSTGRES_URL` があるときだけ実行し、他のテストと
//! 干渉しないよう専用のデータベース / スキーマ (`nb1261_search*`) に閉じる。

use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use noobdb_lib::__test_api as t;

async fn session_for(
    tag: &str,
    conn: t::Connection,
    opts: t::DbConnectOptions,
    read_only: bool,
) -> Arc<t::Session> {
    let state = t::AppState::default();
    let id = state
        .insert(t::make_session(tag, conn, opts, read_only))
        .await;
    state.get(&id).await.expect("session exists")
}

async fn sqlite_session(tag: &str, read_only: bool) -> (Arc<t::Session>, std::path::PathBuf) {
    let mut path = std::env::temp_dir();
    path.push(format!("noobdb_search_{tag}_{}.db", std::process::id()));
    let _ = std::fs::remove_file(&path);
    std::fs::File::create(&path).expect("create temp sqlite file");
    let opts = t::sqlite_options(path.to_str().expect("utf8 path"));
    let conn = t::connect(&opts).await.expect("connect sqlite");
    (session_for(tag, conn, opts, read_only).await, path)
}

fn snippet(id: &str, sql: &str, driver: Option<&str>) -> t::Snippet {
    t::Snippet {
        id: id.into(),
        name: id.into(),
        folder: None,
        tags: Vec::new(),
        sql: sql.into(),
        driver: driver.map(Into::into),
        scope: t::SnippetScope::Any,
    }
}

fn target(database: &str, table: &str, column: Option<&str>) -> t::WhereUsedTarget {
    t::WhereUsedTarget {
        database: database.into(),
        table: table.into(),
        column: column.map(Into::into),
    }
}

fn match_names(report: &t::WhereUsedReport) -> Vec<String> {
    let mut v: Vec<String> = report
        .matches
        .iter()
        .map(|m| format!("{}:{}", m.kind, m.name))
        .collect();
    v.sort();
    v
}

// ---------------------------------------------------------------------------
// オブジェクト検索
// ---------------------------------------------------------------------------

#[tokio::test]
async fn sqlite_object_search_ranks_and_caches_the_index() {
    let (session, path) = sqlite_session("objsearch", false).await;
    for ddl in [
        "CREATE TABLE users (id INTEGER PRIMARY KEY, user_name TEXT, email TEXT)",
        "CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER)",
    ] {
        session.conn.execute(ddl, None).await.expect("ddl");
    }

    let all = t::ObjectSearchScope::All;
    let hits = t::search_schema_objects_core(&session, &all, "users", 10)
        .await
        .expect("search");
    // 完全一致のテーブルが先頭。
    assert_eq!(hits[0].kind, "table");
    assert_eq!(hits[0].table, "users");
    assert_eq!(hits[0].database, "main");
    assert!(hits[0].column.is_none());
    // "user" ならテーブル users (前方一致 + テーブル優先) が先頭で、カラムの前方一致
    // (user_name / user_id) も拾う。
    let hits = t::search_schema_objects_core(&session, &all, "USER", 10)
        .await
        .expect("search");
    assert_eq!(hits[0].table, "users");
    assert!(hits[0].column.is_none());
    assert!(hits
        .iter()
        .any(|h| h.column.as_deref() == Some("user_name")));
    assert!(hits.iter().any(|h| h.column.as_deref() == Some("user_id")));

    // 空クエリは結果なし (索引の構築だけ)。
    assert!(t::search_schema_objects_core(&session, &all, "  ", 10)
        .await
        .expect("warmup")
        .is_empty());

    // 索引はキャッシュされる: 直接作ったテーブルは invalidate まで見えない。
    session
        .conn
        .execute("CREATE TABLE late_table (id INTEGER)", None)
        .await
        .expect("late table");
    let stale = t::search_schema_objects_core(&session, &all, "late_table", 10)
        .await
        .expect("search");
    assert!(
        stale.is_empty(),
        "cached index must not re-read the catalog"
    );
    session.schema_cache.invalidate_all().await;
    let fresh = t::search_schema_objects_core(&session, &all, "late_table", 10)
        .await
        .expect("search");
    assert_eq!(fresh.len(), 1);

    // current スコープは指定 DB だけ。
    let current = t::ObjectSearchScope::Current {
        database: "main".into(),
    };
    let hits = t::search_schema_objects_core(&session, &current, "orders", 10)
        .await
        .expect("search");
    assert_eq!(hits[0].table, "orders");

    // limit は打ち切る。
    let capped = t::search_schema_objects_core(&session, &all, "id", 2)
        .await
        .expect("search");
    assert_eq!(capped.len(), 2);

    let _ = std::fs::remove_file(path);
}

// ---------------------------------------------------------------------------
// Where-used
// ---------------------------------------------------------------------------

async fn sqlite_where_used_fixture(tag: &str) -> (Arc<t::Session>, std::path::PathBuf) {
    let (session, path) = sqlite_session(tag, true).await;
    // read_only セッションでも DDL を流すため、接続を直接使う。
    for ddl in [
        "CREATE TABLE orders (id INTEGER PRIMARY KEY, status TEXT, qty INTEGER)",
        "CREATE TABLE stock (q INTEGER)",
        "CREATE VIEW v_open AS SELECT id, status FROM orders WHERE status = 'open'",
        "CREATE VIEW v_none AS SELECT q FROM stock",
        "CREATE TRIGGER trg_orders AFTER INSERT ON orders BEGIN UPDATE stock SET q = q - NEW.qty; END",
    ] {
        session.conn.execute(ddl, None).await.expect("ddl");
    }
    (session, path)
}

#[tokio::test]
async fn sqlite_where_used_finds_views_triggers_and_snippets() {
    let (session, path) = sqlite_where_used_fixture("whereused").await;
    let snippets = vec![
        snippet("s_any", "select * from orders", None),
        snippet("s_sqlite", "select * from orders", Some("sqlite")),
        snippet("s_mysql", "select * from orders", Some("mysql")),
        snippet("s_unrelated", "select 1", None),
    ];
    let progress = Arc::new(Mutex::new(Vec::<(usize, usize)>::new()));
    let progress_for_cb = progress.clone();
    let report = t::find_where_used_report(
        session.clone(),
        "main",
        &target("main", "orders", None),
        &snippets,
        move |done, total| progress_for_cb.lock().expect("lock").push((done, total)),
    )
    .await
    .expect("scan");

    assert_eq!(
        match_names(&report),
        vec![
            "snippet:s_any",
            "snippet:s_sqlite",
            "trigger:trg_orders",
            "view:v_open"
        ]
    );
    assert_eq!(report.scanned_objects, 3, "v_open / v_none / trg_orders");
    assert_eq!(
        report.scanned_snippets, 3,
        "mysql 専用スニペットは走査しない"
    );
    assert!(report.failed.is_empty());
    assert!(report.empty_definitions.is_empty());
    assert!(!report.cancelled);
    // 進捗は 0 件から始まり、最後は total/total。
    let progress = progress.lock().expect("lock");
    assert_eq!(progress.first(), Some(&(0, 3)));
    assert_eq!(progress.last(), Some(&(3, 3)));
    // ヒット位置は定義本文の行単位で返る。
    let view = report
        .matches
        .iter()
        .find(|m| m.name == "v_open")
        .expect("v_open");
    let lines = &view.analysis.lines;
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0].line, 1);
    assert!(lines[0].text.contains("FROM orders"));

    let _ = std::fs::remove_file(path);
}

#[tokio::test]
async fn sqlite_where_used_excludes_the_target_view_itself_and_handles_columns() {
    let (session, path) = sqlite_where_used_fixture("whereused_view").await;
    // ビューを対象にしたときは、そのビュー自身の CREATE 文を除く。
    let report = t::find_where_used_report(
        session.clone(),
        "main",
        &target("main", "v_open", None),
        &[],
        |_, _| {},
    )
    .await
    .expect("scan");
    assert_eq!(report.scanned_objects, 2);
    assert!(report.matches.is_empty());

    // 列検索: orders.status を参照するのは v_open だけ (トリガーは qty のみ)。
    let report = t::find_where_used_report(
        session.clone(),
        "main",
        &target("main", "orders", Some("status")),
        &[],
        |_, _| {},
    )
    .await
    .expect("scan");
    assert_eq!(match_names(&report), vec!["view:v_open"]);
    assert_eq!(report.matches[0].analysis.hit_count, 2);

    // 大文字小文字違いの対象でも同じ結果。
    let report = t::find_where_used_report(
        session,
        "main",
        &target("MAIN", "ORDERS", Some("QTY")),
        &[],
        |_, _| {},
    )
    .await
    .expect("scan");
    assert_eq!(match_names(&report), vec!["trigger:trg_orders"]);

    let _ = std::fs::remove_file(path);
}

#[tokio::test]
async fn sqlite_bulk_definitions_equal_per_object_definitions() {
    let (session, path) = sqlite_where_used_fixture("bulkdefs").await;
    let objects = session.conn.schema_objects("main").await.expect("objects");
    assert_eq!(objects.len(), 3);
    let bulk = session
        .conn
        .object_definitions_bulk("main")
        .await
        .expect("bulk")
        .expect("sqlite supports bulk");
    for obj in &objects {
        let single = session
            .conn
            .object_definition("main", &obj.kind, &obj.name, obj.id.as_deref())
            .await
            .expect("single");
        assert_eq!(bulk.get(obj), Some(single.as_str()), "{}", obj.name);
    }
    let _ = std::fs::remove_file(path);
}

// ---------------------------------------------------------------------------
// 値検索
// ---------------------------------------------------------------------------

fn collect_messages() -> (
    Arc<Mutex<Vec<t::DataSearchMessage>>>,
    impl Fn(t::DataSearchMessage),
) {
    let store = Arc::new(Mutex::new(Vec::new()));
    let sink = store.clone();
    (store, move |m| sink.lock().expect("lock").push(m))
}

fn entries(messages: &[t::DataSearchMessage]) -> Vec<t::DataSearchEntry> {
    messages
        .iter()
        .filter_map(|m| match m {
            t::DataSearchMessage::Table { entry } => Some(entry.clone()),
            _ => None,
        })
        .collect()
}

fn request(tables: &[&str], term: &str, mode: t::MatchMode) -> t::DataSearchRequest {
    t::DataSearchRequest {
        database: "main".into(),
        term: term.into(),
        mode,
        tables: tables.iter().map(|s| s.to_string()).collect(),
        row_threshold: 500_000,
    }
}

async fn sqlite_data_fixture(tag: &str, read_only: bool) -> (Arc<t::Session>, std::path::PathBuf) {
    let (session, path) = sqlite_session(tag, read_only).await;
    for sql in [
        "CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT, note TEXT)",
        "INSERT INTO people (id, name, note) VALUES (1, 'a needle here', 'x'), (2, 'nothing', 'needle'), (3, 'NEEDLE upper', NULL)",
        "CREATE TABLE blobs (data BLOB)",
        "CREATE TABLE nums (n INTEGER)",
        "INSERT INTO nums (n) VALUES (42), (7), (42)",
        "CREATE TABLE plain (t TEXT)",
        "INSERT INTO plain (t) VALUES ('hay')",
    ] {
        // read_only セッションでも準備の DDL / DML は接続を直接使う。
        session.conn.execute(sql, None).await.expect("fixture");
    }
    (session, path)
}

#[tokio::test]
async fn sqlite_data_search_streams_results_in_table_order() {
    let (session, path) = sqlite_data_fixture("datasearch", false).await;
    let (store, emit) = collect_messages();
    let delivered = Arc::new(AtomicU64::new(0));
    t::data_search_core(
        session,
        request(
            &["people", "blobs", "nums", "plain", "missing"],
            "needle",
            t::MatchMode::Contains,
        ),
        delivered.clone(),
        emit,
    )
    .await;
    let messages = store.lock().expect("lock").clone();

    // 進捗 5 回 → 結果 5 件 (指定順) → 完了。
    let progress: Vec<&str> = messages
        .iter()
        .filter_map(|m| match m {
            t::DataSearchMessage::Progress { table, .. } => Some(table.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(
        progress,
        vec!["people", "blobs", "nums", "plain", "missing"]
    );
    assert!(matches!(
        messages.last(),
        Some(t::DataSearchMessage::Done {})
    ));
    assert_eq!(delivered.load(Ordering::SeqCst), 5);

    let entries = entries(&messages);
    assert_eq!(entries.len(), 5);
    match &entries[0] {
        t::DataSearchEntry::Hit {
            table,
            columns,
            hits,
        } => {
            assert_eq!(table, "people");
            assert_eq!(columns.len(), 3);
            // name: 'a needle here' と 'NEEDLE upper' (SQLite の LIKE は ASCII 大小無視) で 2 件、
            // note: 'needle' で 1 件。id は数値列で非数値語なので走査しない。
            let counts: Vec<(&str, f64)> =
                hits.iter().map(|h| (h.column.as_str(), h.count)).collect();
            assert_eq!(counts, vec![("name", 2.0), ("note", 1.0)]);
        }
        other => panic!("people must hit: {other:?}"),
    }
    // BLOB だけ / 数値列に非数値語 → 走査対象の列なし。
    for (i, name) in [(1usize, "blobs"), (2, "nums")] {
        assert!(
            matches!(&entries[i], t::DataSearchEntry::Skipped { table, reason, .. }
                if table == name && *reason == "no-searchable-columns"),
            "{name}: {:?}",
            entries[i]
        );
    }
    assert!(matches!(&entries[3], t::DataSearchEntry::NoHit { table } if table == "plain"));
    assert!(matches!(&entries[4], t::DataSearchEntry::Skipped { table, .. } if table == "missing"));

    let _ = std::fs::remove_file(path);
}

#[tokio::test]
async fn sqlite_data_search_numeric_term_and_read_only_session() {
    // 走査 SQL は SELECT だけなので read_only セッションでも動く。
    let (session, path) = sqlite_data_fixture("datasearch_ro", true).await;
    let (store, emit) = collect_messages();
    t::data_search_core(
        session,
        request(&["nums", "plain"], "42", t::MatchMode::Exact),
        Arc::new(AtomicU64::new(0)),
        emit,
    )
    .await;
    let entries = entries(&store.lock().expect("lock"));
    match &entries[0] {
        t::DataSearchEntry::Hit { table, hits, .. } => {
            assert_eq!(table, "nums");
            assert_eq!(hits.len(), 1);
            assert_eq!(hits[0].column, "n");
            assert_eq!(hits[0].count, 2.0);
        }
        other => panic!("nums must hit: {other:?}"),
    }
    assert!(matches!(&entries[1], t::DataSearchEntry::NoHit { table } if table == "plain"));
    let _ = std::fs::remove_file(path);
}

#[tokio::test]
async fn sqlite_data_search_uses_bulk_columns_for_many_tables() {
    let (session, path) = sqlite_data_fixture("datasearch_bulk", false).await;
    let mut names = vec!["people".to_string()];
    for i in 0..6 {
        let name = format!("extra_{i}");
        session
            .conn
            .execute(&format!("CREATE TABLE {name} (v TEXT)"), None)
            .await
            .expect("extra table");
        names.push(name);
    }
    let names_ref: Vec<&str> = names.iter().map(String::as_str).collect();
    let (store, emit) = collect_messages();
    t::data_search_core(
        session.clone(),
        request(&names_ref, "needle", t::MatchMode::Prefix),
        Arc::new(AtomicU64::new(0)),
        emit,
    )
    .await;
    let entries = entries(&store.lock().expect("lock"));
    assert_eq!(entries.len(), names.len());
    // 7 テーブル (>= 5) なので一括取得経路。結果の順序は指定順のまま。
    let order: Vec<String> = entries
        .iter()
        .map(|e| match e {
            t::DataSearchEntry::Hit { table, .. }
            | t::DataSearchEntry::NoHit { table }
            | t::DataSearchEntry::Skipped { table, .. } => table.clone(),
        })
        .collect();
    assert_eq!(order, names);
    // 前方一致: name は 'NEEDLE upper' だけ (LIKE は大小無視)、note は 'needle'。
    assert!(matches!(&entries[0], t::DataSearchEntry::Hit { hits, .. }
        if hits.iter().map(|h| (h.column.as_str(), h.count)).collect::<Vec<_>>()
            == vec![("name", 1.0), ("note", 1.0)]));
    // 一括取得がテーブル単位の columns キャッシュも埋めている。
    let cached = AtomicUsize::new(0);
    session
        .schema_cache
        .columns("main", "extra_0", || async {
            cached.fetch_add(1, Ordering::SeqCst);
            session.conn.columns("main", "extra_0").await
        })
        .await
        .expect("columns");
    assert_eq!(
        cached.load(Ordering::SeqCst),
        0,
        "served from the bulk fill"
    );
    let _ = std::fs::remove_file(path);
}

#[tokio::test]
async fn data_search_task_abort_stops_the_scan() {
    // キャンセルは `cancel_stream` がタスクを abort する形で効く。abort 後は
    // それ以降の結果が届かない (JoinSet が子タスクごと落ちる)。
    let (session, path) = sqlite_data_fixture("datasearch_abort", false).await;
    let (store, emit) = collect_messages();
    let handle = tokio::spawn(async move {
        t::data_search_core(
            session,
            request(&["people"], "needle", t::MatchMode::Contains),
            Arc::new(AtomicU64::new(0)),
            emit,
        )
        .await;
    });
    handle.abort();
    let _ = handle.await;
    let n = store.lock().expect("lock").len();
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert_eq!(
        store.lock().expect("lock").len(),
        n,
        "no messages after abort"
    );
    let _ = std::fs::remove_file(path);
}

// ---------------------------------------------------------------------------
// MySQL (環境変数ゲート)
// ---------------------------------------------------------------------------

const MYSQL_DB: &str = "nb1261_search_db";

#[tokio::test]
async fn mysql_search_commands_when_env_set() {
    let Ok(url) = std::env::var("NOOBDB_TEST_MYSQL_URL") else {
        eprintln!("skip: NOOBDB_TEST_MYSQL_URL not set");
        return;
    };
    let opts = t::parse_mysql_url(&url).expect("valid url");
    let conn = t::connect(&opts).await.expect("connect");
    for sql in [
        format!("DROP DATABASE IF EXISTS {MYSQL_DB}"),
        format!("CREATE DATABASE {MYSQL_DB}"),
        format!("CREATE TABLE {MYSQL_DB}.nb1261tok_orders (id INT PRIMARY KEY, status VARCHAR(20), qty INT)"),
        format!("INSERT INTO {MYSQL_DB}.nb1261tok_orders VALUES (1, 'needle in hay', 5), (2, 'plain', 5)"),
        format!("CREATE TABLE {MYSQL_DB}.nb1261_stock (q INT)"),
        format!("CREATE VIEW {MYSQL_DB}.nb1261_v AS SELECT id, status FROM {MYSQL_DB}.nb1261tok_orders"),
    ] {
        conn.execute(&sql, None).await.expect("ddl");
    }
    // ルーチン・トリガーはプリペアドプロトコルで拒否されうるのでテキストプロトコルで作る。
    for sql in [
        format!("CREATE FUNCTION {MYSQL_DB}.nb1261_f() RETURNS INT DETERMINISTIC RETURN (SELECT COUNT(*) FROM {MYSQL_DB}.nb1261tok_orders)"),
        format!("CREATE TRIGGER {MYSQL_DB}.nb1261_t AFTER INSERT ON {MYSQL_DB}.nb1261tok_orders FOR EACH ROW UPDATE {MYSQL_DB}.nb1261_stock SET q = q - NEW.qty"),
    ] {
        t::mysql_exec_text(&opts, &sql).await.expect("routine ddl");
    }
    let session = session_for("mysql_search", conn, opts, false).await;

    // オブジェクト検索 (全 DB / 現在の DB)。
    let hits = t::search_schema_objects_core(&session, &t::ObjectSearchScope::All, "nb1261tok", 50)
        .await
        .expect("search all");
    assert!(
        hits.iter()
            .any(|h| h.kind == "table" && h.database == MYSQL_DB && h.table == "nb1261tok_orders"),
        "{hits:?}"
    );
    let cur = t::ObjectSearchScope::Current {
        database: MYSQL_DB.into(),
    };
    let hits = t::search_schema_objects_core(&session, &cur, "status", 50)
        .await
        .expect("search current");
    assert!(hits
        .iter()
        .any(|h| h.column.as_deref() == Some("status") && h.table == "nb1261tok_orders"));

    // MySQL は定義の一括取得に対応しない (SHOW CREATE を個別に並列取得する)。
    assert!(session
        .conn
        .object_definitions_bulk(MYSQL_DB)
        .await
        .expect("bulk")
        .is_none());
    let report = t::find_where_used_report(
        session.clone(),
        MYSQL_DB,
        &target(MYSQL_DB, "nb1261tok_orders", None),
        &[],
        |_, _| {},
    )
    .await
    .expect("where used");
    assert_eq!(
        match_names(&report),
        vec!["function:nb1261_f", "trigger:nb1261_t", "view:nb1261_v"],
        "{:?}",
        report.failed
    );
    assert_eq!(report.scanned_objects, 3);
    assert!(report.failed.is_empty());
    // 列検索 (MySQL の SHOW CREATE VIEW は列を完全修飾する)。
    let report = t::find_where_used_report(
        session.clone(),
        MYSQL_DB,
        &target(MYSQL_DB, "nb1261tok_orders", Some("qty")),
        &[],
        |_, _| {},
    )
    .await
    .expect("where used (column)");
    assert_eq!(match_names(&report), vec!["trigger:nb1261_t"]);

    // 値検索。
    let (store, emit) = collect_messages();
    t::data_search_core(
        session.clone(),
        t::DataSearchRequest {
            database: MYSQL_DB.into(),
            term: "needle".into(),
            mode: t::MatchMode::Contains,
            tables: vec!["nb1261tok_orders".into(), "nb1261_stock".into()],
            row_threshold: 500_000,
        },
        Arc::new(AtomicU64::new(0)),
        emit,
    )
    .await;
    let entries = entries(&store.lock().expect("lock"));
    match &entries[0] {
        t::DataSearchEntry::Hit { hits, .. } => {
            assert_eq!(hits.len(), 1);
            assert_eq!(hits[0].column, "status");
            assert_eq!(hits[0].count, 1.0);
        }
        other => panic!("orders must hit: {other:?}"),
    }
    assert!(
        matches!(&entries[1], t::DataSearchEntry::Skipped { reason, .. }
        if *reason == "no-searchable-columns")
    );

    session
        .conn
        .execute(&format!("DROP DATABASE IF EXISTS {MYSQL_DB}"), None)
        .await
        .expect("cleanup");
}

// ---------------------------------------------------------------------------
// PostgreSQL (環境変数ゲート)
// ---------------------------------------------------------------------------

const PG_SCHEMA: &str = "nb1261_search";

#[tokio::test]
async fn postgres_search_commands_when_env_set() {
    let Ok(url) = std::env::var("NOOBDB_TEST_POSTGRES_URL") else {
        eprintln!("skip: NOOBDB_TEST_POSTGRES_URL not set");
        return;
    };
    let opts = t::parse_postgres_url(&url).expect("valid url");
    let conn = t::connect(&opts).await.expect("connect");
    for sql in [
        format!("DROP SCHEMA IF EXISTS {PG_SCHEMA} CASCADE"),
        format!("CREATE SCHEMA {PG_SCHEMA}"),
        format!("CREATE TABLE {PG_SCHEMA}.nb1261tok_orders (id int PRIMARY KEY, status text, qty int)"),
        format!("INSERT INTO {PG_SCHEMA}.nb1261tok_orders VALUES (1, 'needle in hay', 5), (2, 'plain', 5)"),
        format!("CREATE TABLE {PG_SCHEMA}.nb1261_stock (q int)"),
        format!("CREATE VIEW {PG_SCHEMA}.nb1261_v AS SELECT id, status FROM {PG_SCHEMA}.nb1261tok_orders"),
        format!("CREATE MATERIALIZED VIEW {PG_SCHEMA}.nb1261_mv AS SELECT id FROM {PG_SCHEMA}.nb1261tok_orders"),
        format!("CREATE FUNCTION {PG_SCHEMA}.nb1261_f() RETURNS int LANGUAGE sql AS $$ SELECT count(*)::int FROM {PG_SCHEMA}.nb1261tok_orders $$"),
        format!("CREATE FUNCTION {PG_SCHEMA}.nb1261_trg() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE {PG_SCHEMA}.nb1261_stock SET q = q - NEW.qty; RETURN NEW; END $$"),
        format!("CREATE TRIGGER nb1261_t AFTER INSERT ON {PG_SCHEMA}.nb1261tok_orders FOR EACH ROW EXECUTE FUNCTION {PG_SCHEMA}.nb1261_trg()"),
        // 集約関数は pg_get_functiondef が例外を投げる: 一括取得から外れ、個別取得の失敗として残る。
        format!("CREATE AGGREGATE {PG_SCHEMA}.nb1261_agg(int) (SFUNC = int4pl, STYPE = int)"),
    ] {
        conn.execute(&sql, None).await.expect("ddl");
    }
    let session = session_for("pg_search", conn, opts, false).await;

    // 一括取得した本文は、オブジェクトごとの取得と同一。
    let objects = session
        .conn
        .schema_objects(PG_SCHEMA)
        .await
        .expect("objects");
    let bulk = session
        .conn
        .object_definitions_bulk(PG_SCHEMA)
        .await
        .expect("bulk")
        .expect("postgres supports bulk");
    let mut compared = 0;
    for obj in &objects {
        let single = session
            .conn
            .object_definition(PG_SCHEMA, &obj.kind, &obj.name, obj.id.as_deref())
            .await;
        match single {
            Ok(def) => {
                assert_eq!(
                    bulk.get(obj),
                    Some(def.as_str()),
                    "{} {}",
                    obj.kind,
                    obj.name
                );
                compared += 1;
            }
            Err(_) => assert_eq!(bulk.get(obj), None, "{} {}", obj.kind, obj.name),
        }
    }
    assert!(compared >= 5, "compared {compared} of {}", objects.len());

    // オブジェクト検索 (PG の「データベース」はスキーマ)。
    let hits = t::search_schema_objects_core(&session, &t::ObjectSearchScope::All, "nb1261tok", 50)
        .await
        .expect("search all");
    assert!(
        hits.iter()
            .any(|h| h.kind == "table" && h.database == PG_SCHEMA && h.table == "nb1261tok_orders"),
        "{hits:?}"
    );

    let report = t::find_where_used_report(
        session.clone(),
        PG_SCHEMA,
        &target(PG_SCHEMA, "nb1261tok_orders", None),
        &[],
        |_, _| {},
    )
    .await
    .expect("where used");
    assert_eq!(
        match_names(&report),
        vec![
            "function:nb1261_f",
            "materialized_view:nb1261_mv",
            "trigger:nb1261_t",
            "view:nb1261_v"
        ]
    );
    // 集約関数は失敗として報告される (他のオブジェクトの走査は止まらない)。
    assert_eq!(report.failed.len(), 1, "{:?}", report.failed);
    assert_eq!(report.failed[0].name, "nb1261_agg");

    // 値検索: テキスト列 + 数値列。
    let (store, emit) = collect_messages();
    t::data_search_core(
        session.clone(),
        t::DataSearchRequest {
            database: PG_SCHEMA.into(),
            term: "5".into(),
            mode: t::MatchMode::Exact,
            tables: vec!["nb1261tok_orders".into()],
            row_threshold: 500_000,
        },
        Arc::new(AtomicU64::new(0)),
        emit,
    )
    .await;
    let entries = entries(&store.lock().expect("lock"));
    match &entries[0] {
        t::DataSearchEntry::Hit { hits, .. } => {
            let counts: Vec<(&str, f64)> =
                hits.iter().map(|h| (h.column.as_str(), h.count)).collect();
            assert_eq!(counts, vec![("qty", 2.0)]);
        }
        other => panic!("orders must hit on qty: {other:?}"),
    }

    session
        .conn
        .execute(&format!("DROP SCHEMA IF EXISTS {PG_SCHEMA} CASCADE"), None)
        .await
        .expect("cleanup");
}
