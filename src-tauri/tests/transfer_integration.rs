//! 接続間データ転送 (#986) の統合テスト。
//!
//! 外部サーバは不要: 別々の temp SQLite / DuckDB ファイルを「異種の接続」に見立て、
//! `commands::transfer` の IPC コア (`transfer_data_inner`) を Tauri なしで駆動する。
//! 常時実走 (環境変数ゲートなし)。
//!
//! 検証すること:
//! - SQLite → DuckDB → SQLite のラウンドトリップで BLOB / NULL / 日時 / 真偽値 / 実数が
//!   往復する (複数バッチにまたがる件数で、進捗コールバックも複数回呼ばれる)
//! - クエリ結果の転送 (重複列名・式列の型推定)
//! - 読み取り専用ターゲットの拒否 (テーブルは作られない)
//! - 衝突時のモード (create 失敗 / replace / append)、追記での BLOB 拒否
//! - キャンセル (タスク破棄) で作りかけのテーブルが DROP される
//! - 書き込み系 SQL をソースにできない

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;

use noobdb_lib::__test_api as t;

fn temp_path(label: &str, ext: &str) -> PathBuf {
    let mut p = std::env::temp_dir();
    p.push(format!(
        "noobdb_transfer_{label}_{}.{ext}",
        std::process::id()
    ));
    p
}

fn remove_files(path: &Path) {
    let _ = std::fs::remove_file(path);
    let mut wal = path.as_os_str().to_owned();
    wal.push(".wal");
    let _ = std::fs::remove_file(wal);
}

async fn sqlite_session(state: &t::AppState, id: &str, read_only: bool) -> PathBuf {
    let path = temp_path(id, "db");
    remove_files(&path);
    std::fs::File::create(&path).expect("touch sqlite file");
    let opts = t::sqlite_options(path.to_str().expect("utf8 path"));
    let conn = t::connect(&opts).await.expect("connect sqlite");
    state
        .insert(t::make_session(id, conn, opts, read_only))
        .await;
    path
}

async fn duckdb_session(state: &t::AppState, id: &str) -> PathBuf {
    let path = temp_path(id, "duckdb");
    remove_files(&path);
    drop(duckdb::Connection::open(&path).expect("create duckdb file"));
    let opts = t::duckdb_options(path.to_str().expect("utf8 path"));
    let conn = t::connect(&opts).await.expect("connect duckdb");
    state.insert(t::make_session(id, conn, opts, false)).await;
    path
}

async fn exec(state: &t::AppState, id: &str, sql: &str) -> t::QueryResult {
    let s = state.get(id).await.expect("session");
    s.conn.execute(sql, None).await.expect(sql)
}

fn table_request(src: &str, dst: &str, table: &str, target_table: &str) -> t::TransferRequest {
    t::TransferRequest {
        source_session_id: src.into(),
        target_session_id: dst.into(),
        source_database: None,
        source_table: Some(table.into()),
        source_sql: None,
        target_database: None,
        target_table: target_table.into(),
        mode: t::TransferMode::Create,
        batch_size: Some(1000),
    }
}

async fn run(
    state: &t::AppState,
    req: t::TransferRequest,
) -> Result<t::TransferOutcome, t::AppError> {
    t::transfer_data_inner(state, req, Arc::new(AtomicU64::new(0)), |_| {}).await
}

fn int(v: &t::Value) -> i64 {
    match v {
        t::Value::Int(n) => *n,
        t::Value::UInt(n) => *n as i64,
        other => panic!("expected int, got {other:?}"),
    }
}

fn text(v: &t::Value) -> String {
    match v {
        t::Value::String(s) => s.clone(),
        other => panic!("expected string, got {other:?}"),
    }
}

async fn seed_source(state: &t::AppState, id: &str) {
    exec(
        state,
        id,
        "CREATE TABLE items (id INTEGER, name TEXT, price REAL, data BLOB, \
         created DATETIME, day DATE, flag BOOLEAN)",
    )
    .await;
    // 2500 行 = batch 1000 で 3 バッチ。列ごとに周期の違う NULL を混ぜる。
    exec(
        state,
        id,
        "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2500) \
         INSERT INTO items SELECT i, \
           CASE WHEN i % 5 = 0 THEN NULL ELSE 'name ' || i || ' ''q''' END, \
           CASE WHEN i % 7 = 0 THEN NULL ELSE i * 1.5 END, \
           CASE WHEN i % 11 = 0 THEN NULL ELSE x'00ff10' END, \
           '2024-01-02 03:04:05', '2024-05-06', i % 2 \
         FROM n",
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn sqlite_to_duckdb_and_back_roundtrips_values() {
    let state = t::AppState::default();
    let src = sqlite_session(&state, "rt_src", false).await;
    let duck = duckdb_session(&state, "rt_duck").await;
    let back = sqlite_session(&state, "rt_back", false).await;
    seed_source(&state, "rt_src").await;

    // SQLite → DuckDB (進捗が複数回届く)
    let calls = Arc::new(AtomicUsize::new(0));
    let calls_cb = calls.clone();
    let counter = Arc::new(AtomicU64::new(0));
    let out = t::transfer_data_inner(
        &state,
        table_request("rt_src", "rt_duck", "items", "items_copy"),
        counter.clone(),
        move |_| {
            calls_cb.fetch_add(1, Ordering::SeqCst);
        },
    )
    .await
    .expect("sqlite -> duckdb");
    assert_eq!(out.rows, 2500);
    assert_eq!(counter.load(Ordering::SeqCst), 2500);
    assert!(calls.load(Ordering::SeqCst) >= 3, "progress per batch");
    let types: Vec<(String, String)> = out
        .columns
        .iter()
        .map(|c| (c.name.clone(), c.target_type.clone()))
        .collect();
    assert_eq!(
        types,
        vec![
            ("id".into(), "BIGINT".into()),
            ("name".into(), "VARCHAR".into()),
            ("price".into(), "DOUBLE".into()),
            ("data".into(), "BLOB".into()),
            ("created".into(), "TIMESTAMP".into()),
            ("day".into(), "DATE".into()),
            ("flag".into(), "BOOLEAN".into()),
        ]
    );

    let r = exec(
        &state,
        "rt_duck",
        "SELECT count(*), count(name), count(price), count(data) FROM items_copy",
    )
    .await;
    assert_eq!(
        r.rows[0].iter().map(int).collect::<Vec<_>>(),
        vec![2500, 2000, 2143, 2273]
    );
    let r = exec(
        &state,
        "rt_duck",
        "SELECT name, price, hex(data), CAST(created AS VARCHAR), CAST(day AS VARCHAR), flag \
         FROM items_copy WHERE id = 4",
    )
    .await;
    let row = &r.rows[0];
    assert_eq!(text(&row[0]), "name 4 'q'");
    assert!(matches!(row[1], t::Value::Float(f) if (f - 6.0).abs() < 1e-9));
    assert_eq!(text(&row[2]), "00FF10");
    assert_eq!(text(&row[3]), "2024-01-02 03:04:05");
    assert_eq!(text(&row[4]), "2024-05-06");
    assert!(matches!(row[5], t::Value::Bool(false)));
    // NULL が NULL のまま (空文字などに化けない)
    let r = exec(
        &state,
        "rt_duck",
        "SELECT name IS NULL, data IS NULL FROM items_copy WHERE id = 5",
    )
    .await;
    assert!(matches!(r.rows[0][0], t::Value::Bool(true)));
    assert!(matches!(r.rows[0][1], t::Value::Bool(false)));

    // DuckDB → SQLite (BLOB はバイト列として戻る)
    let out = run(
        &state,
        table_request("rt_duck", "rt_back", "items_copy", "items_back"),
    )
    .await
    .expect("duckdb -> sqlite");
    assert_eq!(out.rows, 2500);
    let r = exec(
        &state,
        "rt_back",
        "SELECT typeof(data), hex(data), name, typeof(price), flag, day, substr(created, 1, 19) \
         FROM items_back WHERE id = 4",
    )
    .await;
    let row = &r.rows[0];
    assert_eq!(text(&row[0]), "blob");
    assert_eq!(text(&row[1]), "00FF10");
    assert_eq!(text(&row[2]), "name 4 'q'");
    assert_eq!(text(&row[3]), "real");
    assert!(matches!(row[4], t::Value::Bool(false) | t::Value::Int(0)));
    assert_eq!(text(&row[5]), "2024-05-06");
    assert_eq!(text(&row[6]), "2024-01-02 03:04:05");
    let r = exec(
        &state,
        "rt_back",
        "SELECT count(*) FROM items_back WHERE data IS NULL",
    )
    .await;
    assert_eq!(int(&r.rows[0][0]), 227);

    for p in [src, duck, back] {
        remove_files(&p);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn transfers_query_results_with_duplicate_and_expression_columns() {
    let state = t::AppState::default();
    let src = sqlite_session(&state, "q_src", false).await;
    let dst = duckdb_session(&state, "q_dst").await;
    exec(&state, "q_src", "CREATE TABLE a (id INTEGER, v TEXT)").await;
    exec(&state, "q_src", "INSERT INTO a VALUES (1, 'x'), (2, 'y')").await;

    let mut req = table_request("q_src", "q_dst", "", "result");
    req.source_table = None;
    req.source_sql =
        Some("SELECT a.id, b.id, a.id * 0.5 AS half FROM a JOIN a b ON a.id = b.id".into());
    let out = run(&state, req).await.expect("query transfer");
    assert_eq!(out.rows, 2);
    let names: Vec<String> = out.columns.iter().map(|c| c.name.clone()).collect();
    assert_eq!(names, vec!["id", "id_2", "half"]);
    assert_eq!(out.columns[2].target_type, "DOUBLE");
    let r = exec(&state, "q_dst", "SELECT sum(half) FROM result").await;
    assert!(matches!(r.rows[0][0], t::Value::Float(f) if (f - 1.5).abs() < 1e-9));

    // 書き込み系 SQL はソースにできない
    let mut req = table_request("q_src", "q_dst", "", "nope");
    req.source_table = None;
    req.source_sql = Some("DELETE FROM a".into());
    assert!(run(&state, req).await.is_err());
    let r = exec(&state, "q_src", "SELECT count(*) FROM a").await;
    assert_eq!(int(&r.rows[0][0]), 2);

    remove_files(&src);
    remove_files(&dst);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rejects_read_only_target_without_creating_anything() {
    let state = t::AppState::default();
    let src = sqlite_session(&state, "ro_src", false).await;
    let dst = sqlite_session(&state, "ro_dst", true).await;
    exec(&state, "ro_src", "CREATE TABLE a (id INTEGER)").await;
    exec(&state, "ro_src", "INSERT INTO a VALUES (1)").await;

    let err = run(&state, table_request("ro_src", "ro_dst", "a", "a"))
        .await
        .expect_err("read-only target must be rejected");
    assert!(matches!(err, t::AppError::ReadOnly(_)), "{err:?}");
    // 緊急書き込みモードでも転送は通さない
    t::set_emergency_mode_via_command(&state, "ro_dst", true)
        .await
        .expect("emergency mode");
    assert!(run(&state, table_request("ro_src", "ro_dst", "a", "a"))
        .await
        .is_err());
    let r = exec(
        &state,
        "ro_dst",
        "SELECT count(*) FROM sqlite_master WHERE type = 'table'",
    )
    .await;
    assert_eq!(int(&r.rows[0][0]), 0);

    remove_files(&src);
    remove_files(&dst);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn conflict_modes_create_replace_append() {
    let state = t::AppState::default();
    let src = sqlite_session(&state, "m_src", false).await;
    let dst = sqlite_session(&state, "m_dst", false).await;
    exec(&state, "m_src", "CREATE TABLE a (id INTEGER, b BLOB)").await;
    exec(
        &state,
        "m_src",
        "INSERT INTO a VALUES (1, x'01'), (2, NULL)",
    )
    .await;
    exec(&state, "m_src", "CREATE TABLE e (id INTEGER, v TEXT)").await;

    run(&state, table_request("m_src", "m_dst", "a", "a"))
        .await
        .expect("first create");
    // 既存テーブルがあると create は失敗し、既存データは残る
    assert!(run(&state, table_request("m_src", "m_dst", "a", "a"))
        .await
        .is_err());
    let r = exec(&state, "m_dst", "SELECT count(*) FROM a").await;
    assert_eq!(int(&r.rows[0][0]), 2);

    // replace は作り直す
    exec(&state, "m_dst", "INSERT INTO a VALUES (99, NULL)").await;
    let mut req = table_request("m_src", "m_dst", "a", "a");
    req.mode = t::TransferMode::Replace;
    run(&state, req).await.expect("replace");
    let r = exec(&state, "m_dst", "SELECT count(*), max(id) FROM a").await;
    assert_eq!(int(&r.rows[0][0]), 2);
    assert_eq!(int(&r.rows[0][1]), 2);

    // BLOB 列を含む SQLite への追記は拒否 (hex の後処理が既存行を壊すため)
    let mut req = table_request("m_src", "m_dst", "a", "a");
    req.mode = t::TransferMode::Append;
    assert!(run(&state, req).await.is_err());

    // BLOB を含まない追記は行が増える
    let mut req = table_request("m_src", "m_dst", "", "a_ids");
    req.source_table = None;
    req.source_sql = Some("SELECT id FROM a".into());
    run(&state, req.clone()).await.expect("create a_ids");
    req.mode = t::TransferMode::Append;
    run(&state, req).await.expect("append");
    let r = exec(&state, "m_dst", "SELECT count(*) FROM a_ids").await;
    assert_eq!(int(&r.rows[0][0]), 4);

    // 0 行のテーブルでも列定義どおりの空テーブルを作る
    run(&state, table_request("m_src", "m_dst", "e", "e"))
        .await
        .expect("empty table");
    let r = exec(
        &state,
        "m_dst",
        "SELECT count(*) FROM pragma_table_info('e')",
    )
    .await;
    assert_eq!(int(&r.rows[0][0]), 2);

    // 同一セッション・同一テーブルへの作り直しは拒否
    let mut req = table_request("m_src", "m_src", "a", "a");
    req.mode = t::TransferMode::Replace;
    assert!(run(&state, req).await.is_err());
    let r = exec(&state, "m_src", "SELECT count(*) FROM a").await;
    assert_eq!(int(&r.rows[0][0]), 2);

    remove_files(&src);
    remove_files(&dst);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cancelling_drops_the_partially_created_table() {
    let state = Arc::new(t::AppState::default());
    let src = sqlite_session(&state, "c_src", false).await;
    let dst = duckdb_session(&state, "c_dst").await;
    exec(&state, "c_src", "CREATE TABLE big (id INTEGER, v TEXT)").await;
    exec(
        &state,
        "c_src",
        "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 200000) \
         INSERT INTO big SELECT i, 'value ' || i FROM n",
    )
    .await;

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<u64>();
    let st = state.clone();
    let mut req = table_request("c_src", "c_dst", "big", "big_copy");
    req.batch_size = Some(100);
    let task = tokio::spawn(async move {
        t::transfer_data_inner(&st, req, Arc::new(AtomicU64::new(0)), move |n| {
            let _ = tx.send(n);
        })
        .await
    });
    // 最初のバッチが書き込まれた (= テーブルが作られた) ところでキャンセル
    let first = rx.recv().await.expect("first progress");
    assert!(first > 0);
    task.abort();
    let _ = task.await;

    // DROP はバックグラウンドで走るので少し待つ
    let mut gone = false;
    for _ in 0..50 {
        let r = exec(
            &state,
            "c_dst",
            "SELECT count(*) FROM information_schema.tables WHERE table_name = 'big_copy'",
        )
        .await;
        if int(&r.rows[0][0]) == 0 {
            gone = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    assert!(
        gone,
        "cancelled transfer must drop its partially created table"
    );

    remove_files(&src);
    remove_files(&dst);
}
