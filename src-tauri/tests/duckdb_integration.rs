//! Integration test for the DuckDB driver (#709).
//!
//! Like `tests/sqlite_integration.rs`, this needs no external server — it
//! creates a temporary `.duckdb` file in `std::env::temp_dir()` and exercises
//! the driver surface against it: connect/disconnect, streaming SELECT +
//! cancellation, auto-LIMIT, schema-tree introspection, read-only rejection,
//! cell-edit-style transactions, and CSV-style import. Unlike SQLite's driver
//! (which tolerates `create_if_missing`), `DuckDbConn::connect` requires the
//! file to already exist (mirroring the SQLite driver's own
//! `create_if_missing(false)`), so each test pre-creates a valid empty
//! database file with the `duckdb` crate directly before connecting through
//! `noobdb_lib`.

use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use noobdb_lib::__test_api as t;

fn temp_db_path(tag: &str) -> PathBuf {
    let mut p = std::env::temp_dir();
    // Mix in the test PID so parallel test runs don't stomp on each other.
    p.push(format!("noobdb_duckdb_{tag}_{}.duckdb", std::process::id()));
    p
}

/// Removes `path` and its DuckDB `.wal` write-ahead-log sidecar. The `.wal`
/// file is created while a transaction is active and normally cleaned up on
/// checkpoint/close, but a killed process or a test that panics before
/// `conn.close()` can leave one behind — and a leftover `.wal` sitting next
/// to a *fresh*, same-named `.duckdb` file from a later test run would make
/// DuckDB replay stale WAL entries against unrelated data. Every test that
/// tears down its own temp database should use this instead of a bare
/// `std::fs::remove_file` on just the `.duckdb` file.
fn remove_db_files(path: &std::path::Path) {
    let _ = std::fs::remove_file(path);
    let mut wal = path.as_os_str().to_owned();
    wal.push(".wal");
    let _ = std::fs::remove_file(wal);
}

/// Creates a valid (empty) DuckDB database file at `path`, removing any
/// leftover file (and `.wal` sidecar) from a previous crashed run first.
/// Unlike SQLite, DuckDB does not treat an empty/0-byte file as "not yet
/// initialized" — it needs a real file header, so this opens (and
/// immediately closes) a connection with the `duckdb` crate directly rather
/// than just touching an empty file.
fn create_empty_db(path: &std::path::Path) {
    remove_db_files(path);
    let conn = duckdb::Connection::open(path).expect("create duckdb file");
    drop(conn);
}

#[tokio::test]
async fn duckdb_roundtrip_against_tempfile() {
    let path = temp_db_path("smoke");
    create_empty_db(&path);

    let opts = t::duckdb_options(path.to_str().expect("utf8 path"));
    let conn = t::connect(&opts).await.expect("connect");

    // SELECT round-trip first to confirm the driver decodes literals.
    let res = conn
        .execute("SELECT 1 AS n, 'hello' AS s, TRUE AS b", None)
        .await
        .expect("query");
    assert_eq!(res.columns.len(), 3);
    assert_eq!(res.rows.len(), 1);
    assert!(matches!(&res.rows[0][0], t::Value::Int(1)));
    assert!(matches!(&res.rows[0][1], t::Value::String(s) if s == "hello"));
    assert!(matches!(&res.rows[0][2], t::Value::Bool(true)));

    // CRUD round-trip in a real persisted table.
    conn.execute(
        "CREATE TABLE noobdb_duckdb_smoke (id INTEGER PRIMARY KEY, label VARCHAR NOT NULL)",
        None,
    )
    .await
    .expect("create");
    conn.execute(
        "INSERT INTO noobdb_duckdb_smoke (id, label) VALUES (1, 'a'), (2, 'b'), (3, 'c')",
        None,
    )
    .await
    .expect("insert");

    // Schema browser surfaces (#709 acceptance: スキーマツリー表示).
    let dbs = conn.databases().await.expect("databases");
    assert!(dbs.iter().any(|d| d == "main"), "dbs: {dbs:?}");
    let tables = conn.tables("main").await.expect("tables");
    assert!(tables.iter().any(|t| t == "noobdb_duckdb_smoke"));
    let cols = conn
        .columns("main", "noobdb_duckdb_smoke")
        .await
        .expect("columns");
    assert_eq!(cols.len(), 2);
    let id_col = cols.iter().find(|c| c.name == "id").expect("id column");
    assert_eq!(id_col.key, "PRI", "PK detection must mark id as PRI");

    let overview = conn.schema_overview("main").await.expect("schema overview");
    let smoke = overview
        .iter()
        .find(|t| t.name == "noobdb_duckdb_smoke")
        .expect("overview must list the smoke table");
    assert_eq!(smoke.columns, vec!["id".to_string(), "label".to_string()]);

    let upd = conn
        .execute(
            "UPDATE noobdb_duckdb_smoke SET label = 'B' WHERE id = 2",
            None,
        )
        .await
        .expect("update");
    assert_eq!(upd.rows_affected, 1);

    let del = conn
        .execute("DELETE FROM noobdb_duckdb_smoke WHERE id = 3", None)
        .await
        .expect("delete");
    assert_eq!(del.rows_affected, 1);

    let final_rows = conn
        .execute(
            "SELECT id, label FROM noobdb_duckdb_smoke ORDER BY id",
            None,
        )
        .await
        .expect("final select");
    assert_eq!(final_rows.rows.len(), 2);
    assert!(matches!(&final_rows.rows[1][1], t::Value::String(s) if s == "B"));

    // Preview (dry-run) must roll back.
    let preview = conn
        .preview_execute_with_limit(
            "UPDATE noobdb_duckdb_smoke SET label = 'rollback' WHERE id = 1",
            None,
            10,
        )
        .await
        .expect("preview");
    assert_eq!(preview.rows_affected, 1);
    assert_eq!(preview.target_table.as_deref(), Some("noobdb_duckdb_smoke"));
    let after_preview = conn
        .execute("SELECT label FROM noobdb_duckdb_smoke WHERE id = 1", None)
        .await
        .expect("post-preview select");
    assert!(
        matches!(&after_preview.rows[0][0], t::Value::String(s) if s == "a"),
        "preview must roll back; row 1 should still hold its original label"
    );

    conn.close().await;
    remove_db_files(&path);
}

/// #687-style resilient import: skip-mode commits good rows and reports bad
/// ones by index; abort-mode probes (without persisting anything) to locate
/// the first bad record. Exercises `import_rows_skipping` /
/// `probe_failing_row`, which build inline-literal `INSERT` text (see
/// `db/duckdb.rs` module docs) rather than binding typed parameters.
#[tokio::test]
async fn duckdb_resilient_import_skips_and_locates_bad_rows() {
    let path = temp_db_path("import");
    create_empty_db(&path);

    let opts = t::duckdb_options(path.to_str().expect("utf8 path"));
    let conn = t::connect(&opts).await.expect("connect");
    conn.execute(
        "CREATE TABLE imp (id INTEGER PRIMARY KEY, name VARCHAR NOT NULL)",
        None,
    )
    .await
    .expect("create");

    let columns = vec!["id".to_string(), "name".to_string()];
    // Record 0: ok. Record 1: NOT NULL violation. Record 2: duplicate PK (1).
    // Record 3: ok.
    let cell = |s: Option<&str>| s.map(|v| v.to_string());
    let rows: Vec<Vec<Option<String>>> = vec![
        vec![cell(Some("1")), cell(Some("alice"))],
        vec![cell(Some("2")), cell(None)],
        vec![cell(Some("1")), cell(Some("dup"))],
        vec![cell(Some("3")), cell(Some("carol"))],
    ];

    let outcome = conn
        .import_rows_skipping(None, "imp", &columns, &rows, 500, |_| Ok(()))
        .await
        .expect("skip import");
    assert_eq!(outcome.inserted, 2, "records 0 and 3 should insert");
    let skipped_indices: Vec<usize> = outcome.skipped.iter().map(|s| s.index).collect();
    assert_eq!(
        skipped_indices,
        vec![1, 2],
        "records 1 and 2 should be skipped"
    );
    assert!(outcome.skipped.iter().all(|s| !s.reason.is_empty()));

    let count = conn
        .execute("SELECT COUNT(*) FROM imp", None)
        .await
        .expect("count");
    assert!(matches!(&count.rows[0][0], t::Value::Int(2)));

    // Abort-mode probe on a fresh table: pinpoints the first failing record
    // and leaves nothing behind (rolled back).
    conn.execute("DELETE FROM imp", None).await.expect("clear");
    let located = conn
        .probe_failing_row(None, "imp", &columns, &rows)
        .await
        .expect("probe");
    assert_eq!(located.map(|(i, _)| i), Some(1));
    let count2 = conn
        .execute("SELECT COUNT(*) FROM imp", None)
        .await
        .expect("count2");
    assert!(
        matches!(&count2.rows[0][0], t::Value::Int(0)),
        "probe must not persist any rows"
    );

    conn.close().await;
    remove_db_files(&path);
}

/// Explicit-transaction path (backs inline cell-edit Apply): begin → several
/// statements on the same held connection → commit; and a second transaction
/// that rolls back, leaving no trace.
#[tokio::test]
async fn duckdb_explicit_transaction_commits_and_rolls_back() {
    let path = temp_db_path("tx");
    create_empty_db(&path);

    let opts = t::duckdb_options(path.to_str().expect("utf8 path"));
    let conn = t::connect(&opts).await.expect("connect");
    conn.execute(
        "CREATE TABLE tx_t (id INTEGER PRIMARY KEY, label VARCHAR)",
        None,
    )
    .await
    .expect("create");

    assert!(!conn.transaction_active().await);
    conn.begin_transaction(None).await.expect("begin");
    assert!(conn.transaction_active().await);
    conn.execute_in_transaction("INSERT INTO tx_t VALUES (1, 'a')")
        .await
        .expect("insert 1");
    conn.execute_in_transaction("INSERT INTO tx_t VALUES (2, 'b')")
        .await
        .expect("insert 2");
    conn.finish_transaction(true).await.expect("commit");
    assert!(!conn.transaction_active().await);

    let after_commit = conn
        .execute("SELECT COUNT(*) FROM tx_t", None)
        .await
        .expect("count after commit");
    assert!(matches!(&after_commit.rows[0][0], t::Value::Int(2)));

    conn.begin_transaction(None).await.expect("begin 2");
    conn.execute_in_transaction("INSERT INTO tx_t VALUES (3, 'c')")
        .await
        .expect("insert 3");
    conn.finish_transaction(false).await.expect("rollback");

    let after_rollback = conn
        .execute("SELECT COUNT(*) FROM tx_t", None)
        .await
        .expect("count after rollback");
    assert!(
        matches!(&after_rollback.rows[0][0], t::Value::Int(2)),
        "rolled-back insert must not persist"
    );

    conn.close().await;
    remove_db_files(&path);
}

/// Streaming SELECT execution delivers columns once, then rows in the
/// requested batch sizes (rather than one giant batch), matching how
/// `run_query_stream` feeds the UI grid incrementally.
#[tokio::test]
async fn duckdb_execute_stream_delivers_batched_rows() {
    let path = temp_db_path("stream");
    create_empty_db(&path);

    let opts = t::duckdb_options(path.to_str().expect("utf8 path"));
    let conn = t::connect(&opts).await.expect("connect");

    let columns_seen = Arc::new(AtomicUsize::new(0));
    let rows_seen = Arc::new(AtomicUsize::new(0));
    let batches_seen = Arc::new(AtomicUsize::new(0));
    let (columns_seen2, rows_seen2, batches_seen2) = (
        columns_seen.clone(),
        rows_seen.clone(),
        batches_seen.clone(),
    );

    let result = conn
        .execute_stream(
            // DuckDB's `range()` table function generates rows without
            // needing a persisted table — perfect for a synthetic streaming
            // source.
            "SELECT * FROM range(250) AS t(n)",
            None,
            /* initial_batch */ 10,
            /* chunk_size */ 25,
            move |batch| {
                match batch {
                    t::StreamBatch::Columns(cols) => {
                        columns_seen2.store(cols.len(), Ordering::SeqCst);
                    }
                    t::StreamBatch::Rows(rows) => {
                        rows_seen2.fetch_add(rows.len(), Ordering::SeqCst);
                        batches_seen2.fetch_add(1, Ordering::SeqCst);
                    }
                }
                Ok(())
            },
        )
        .await
        .expect("stream");

    assert_eq!(columns_seen.load(Ordering::SeqCst), 1);
    assert_eq!(rows_seen.load(Ordering::SeqCst), 250);
    assert_eq!(result.rows_affected, 250);
    assert!(
        batches_seen.load(Ordering::SeqCst) >= 2,
        "250 rows with an initial batch of 10 and a chunk size of 25 must arrive in \
         more than one batch, got {}",
        batches_seen.load(Ordering::SeqCst)
    );

    conn.close().await;
    remove_db_files(&path);
}

/// Cancellation: aborting the Tokio task driving `execute_stream` — exactly
/// how `cancel_stream` cancels a running query in production (see
/// `commands/query.rs`) — must actually stop a long-running DuckDB query
/// promptly instead of leaving it to run to completion in the background.
/// This exercises the `InterruptHandle` RAII guard in `db/duckdb.rs`.
#[tokio::test]
async fn duckdb_execute_stream_is_cancellable() {
    let path = temp_db_path("cancel");
    create_empty_db(&path);

    let opts = t::duckdb_options(path.to_str().expect("utf8 path"));
    let conn = Arc::new(t::connect(&opts).await.expect("connect"));
    let conn2 = conn.clone();

    let handle = tokio::spawn(async move {
        conn2
            .execute_stream(
                // A large cross join keeps DuckDB busy long enough to abort
                // mid-flight rather than finishing before the abort lands.
                "SELECT * FROM range(20000) a, range(20000) b",
                None,
                100,
                1000,
                |_batch| Ok(()),
            )
            .await
    });

    // Give the query a moment to actually start executing before cancelling.
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    handle.abort();

    let outcome = tokio::time::timeout(std::time::Duration::from_secs(10), handle).await;
    match outcome {
        Ok(join_result) => {
            // Either the task reports cancellation (aborted before it ever
            // polled again) or it observed the interrupt and returned an
            // error from DuckDB — both are an acceptable "stopped" outcome.
            // What must never happen is the timeout above firing, which
            // would mean cancellation left the query running unbounded.
            match join_result {
                Err(join_err) => assert!(join_err.is_cancelled(), "unexpected panic: {join_err}"),
                Ok(inner) => assert!(
                    inner.is_err(),
                    "an aborted-then-observed stream should surface as an error, not a success"
                ),
            }
        }
        Err(_) => panic!("cancelling execute_stream did not stop the query within 10s"),
    }

    conn.close().await;
    remove_db_files(&path);
}

/// Auto-LIMIT (`db::apply_auto_limit`, shared across all drivers) actually
/// caps the rows a plain `SELECT` returns once spliced onto DuckDB SQL and
/// run for real, exercising the full path rather than just the pure
/// string-rewrite function in isolation.
#[tokio::test]
async fn duckdb_auto_limit_caps_a_plain_select() {
    let path = temp_db_path("autolimit");
    create_empty_db(&path);

    let opts = t::duckdb_options(path.to_str().expect("utf8 path"));
    let conn = t::connect(&opts).await.expect("connect");

    let sql = "SELECT * FROM range(1000) AS t(n)";
    assert!(
        t::is_read_only_sql(sql),
        "a plain SELECT must be read-only-eligible"
    );
    let limited = t::apply_auto_limit(sql, 25).expect("auto limit must apply");

    let res = conn.execute(&limited, None).await.expect("limited query");
    assert_eq!(res.rows.len(), 25);

    conn.close().await;
    remove_db_files(&path);
}

// ---------------------------------------------------------------------------
// read-only セッション強制 (IPC レベル) — mirrors
// `sqlite_integration.rs`'s `read_only_session_rejects_writes_via_ipc` /
// `read_only_session_allows_select_via_ipc`.
// ---------------------------------------------------------------------------

async fn seed_ro_fixture(tag: &str) -> PathBuf {
    let path = temp_db_path(&format!("ro_{tag}"));
    create_empty_db(&path);

    let conn = t::connect(&t::duckdb_options(path.to_str().unwrap()))
        .await
        .expect("connect (seed)");
    conn.execute(
        "CREATE TABLE ro_t (id INTEGER PRIMARY KEY, label VARCHAR NOT NULL)",
        None,
    )
    .await
    .expect("create");
    conn.execute("INSERT INTO ro_t (id, label) VALUES (1, 'a')", None)
        .await
        .expect("seed");
    conn.close().await;
    path
}

async fn ro_state(path: &std::path::Path) -> (t::AppState, String) {
    let opts = t::duckdb_options(path.to_str().unwrap());
    let conn = t::connect(&opts)
        .await
        .expect("connect (read-only session)");
    let session = t::make_session("ro_sess", conn, opts, /* read_only */ true);
    let state = t::AppState::default();
    let sid = state.insert(session).await;
    (state, sid)
}

#[tokio::test]
async fn duckdb_read_only_session_rejects_writes_via_ipc() {
    let path = seed_ro_fixture("rejects").await;
    let (state, sid) = ro_state(&path).await;

    for sql in [
        "INSERT INTO ro_t (id, label) VALUES (2, 'b')",
        "UPDATE ro_t SET label = 'z' WHERE id = 1",
        "DELETE FROM ro_t WHERE id = 1",
        "DROP TABLE ro_t",
        "CREATE TABLE evil (id INTEGER)",
    ] {
        let err = t::run_query_via_command(&state, &sid, sql, None)
            .await
            .expect_err(&format!("read-only session must reject: {sql}"));
        assert!(
            matches!(err, t::AppError::ReadOnly(_)),
            "expected ReadOnly for `{sql}`, got: {err:?}"
        );
    }

    // The guard rejects before reaching the driver, so nothing changed.
    let verify = t::connect(&t::duckdb_options(path.to_str().unwrap()))
        .await
        .expect("connect (verify)");
    let rows = verify
        .execute("SELECT id, label FROM ro_t ORDER BY id", None)
        .await
        .expect("select after rejected writes")
        .rows;
    assert_eq!(rows.len(), 1, "no write should have landed");
    assert!(matches!(&rows[0][1], t::Value::String(s) if s == "a"));
    verify.close().await;

    remove_db_files(&path);
}

#[tokio::test]
async fn duckdb_read_only_session_allows_select_via_ipc() {
    let path = seed_ro_fixture("select").await;
    let (state, sid) = ro_state(&path).await;

    let res = t::run_query_via_command(&state, &sid, "SELECT id, label FROM ro_t", None)
        .await
        .expect("read-only session must allow SELECT");
    assert_eq!(res.rows.len(), 1);
    assert!(matches!(&res.rows[0][1], t::Value::String(s) if s == "a"));

    let cte = t::run_query_via_command(
        &state,
        &sid,
        "WITH x AS (SELECT id FROM ro_t) SELECT count(*) FROM x",
        None,
    )
    .await
    .expect("read-only session must allow WITH ... SELECT");
    assert_eq!(cte.rows.len(), 1);

    remove_db_files(&path);
}

#[tokio::test]
async fn duckdb_read_only_session_rejects_transaction_writes() {
    let path = seed_ro_fixture("tx").await;
    let (state, sid) = ro_state(&path).await;

    let err = t::run_query_transaction_via_command(
        &state,
        &sid,
        vec![
            "SELECT 1".to_string(),
            "UPDATE ro_t SET label = 'z' WHERE id = 1".to_string(),
        ],
        None,
    )
    .await
    .expect_err("a batch containing one write must be rejected wholesale");
    assert!(matches!(err, t::AppError::ReadOnly(_)));

    remove_db_files(&path);
}

#[tokio::test]
async fn duckdb_read_only_session_rejects_csv_import() {
    let path = seed_ro_fixture("import").await;
    let (state, sid) = ro_state(&path).await;
    let session = state.get(&sid).await.expect("session");
    let err = t::ensure_import_writable(&session).expect_err("read-only must reject import");
    assert!(matches!(err, t::AppError::ReadOnly(_)));

    remove_db_files(&path);
}

/// A writable session (the common case) can freely mix reads and writes
/// through the same IPC path the read-only tests exercise above.
#[tokio::test]
async fn duckdb_writable_session_allows_writes_via_ipc() {
    let path = temp_db_path("writable");
    create_empty_db(&path);

    let opts = t::duckdb_options(path.to_str().unwrap());
    let conn = t::connect(&opts).await.expect("connect");
    let session = t::make_session("rw_sess", conn, opts, /* read_only */ false);
    let state = t::AppState::default();
    let sid = state.insert(session).await;

    t::run_query_via_command(
        &state,
        &sid,
        "CREATE TABLE rw_t (id INTEGER PRIMARY KEY, label VARCHAR)",
        None,
    )
    .await
    .expect("create must succeed on a writable session");
    t::run_query_via_command(&state, &sid, "INSERT INTO rw_t VALUES (1, 'a')", None)
        .await
        .expect("insert must succeed");
    let res = t::run_query_via_command(&state, &sid, "SELECT COUNT(*) FROM rw_t", None)
        .await
        .expect("select must succeed");
    assert!(matches!(&res.rows[0][0], t::Value::Int(1)));

    remove_db_files(&path);
}

/// DuckDB has no server processes to list/kill — mirrors
/// `sqlite_process_commands_unsupported_and_read_only_guarded`.
#[tokio::test]
async fn duckdb_process_commands_are_unsupported() {
    let path = temp_db_path("proc");
    create_empty_db(&path);

    let opts = t::duckdb_options(path.to_str().unwrap());
    let conn = t::connect(&opts).await.expect("connect");
    let err = conn
        .list_processes()
        .await
        .expect_err("DuckDB has no server processes to list");
    assert!(matches!(err, t::AppError::InvalidInput(_)));

    conn.close().await;
    remove_db_files(&path);
}

/// Foreign-key introspection (used to draw ER-diagram edges) via the
/// SQL-standard `information_schema` join in `db/duckdb.rs`.
#[tokio::test]
async fn duckdb_foreign_keys_are_introspected() {
    let path = temp_db_path("fk");
    create_empty_db(&path);

    let opts = t::duckdb_options(path.to_str().unwrap());
    let conn = t::connect(&opts).await.expect("connect");
    conn.execute("CREATE TABLE parent (id INTEGER PRIMARY KEY)", None)
        .await
        .expect("create parent");
    conn.execute(
        "CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id))",
        None,
    )
    .await
    .expect("create child");

    let fks = conn.foreign_keys("main").await.expect("foreign_keys");
    let fk = fks
        .iter()
        .find(|f| f.table == "child" && f.column == "parent_id")
        .expect("child.parent_id foreign key must be reported");
    assert_eq!(fk.referenced_table, "parent");
    assert_eq!(fk.referenced_column.as_deref(), Some("id"));

    conn.close().await;
    remove_db_files(&path);
}

/// Missing file_path (and a nonexistent path) must surface a clean
/// `InvalidInput` instead of panicking inside the `duckdb` crate.
#[tokio::test]
async fn duckdb_missing_or_nonexistent_path_reports_invalid_input() {
    let opts = t::DbConnectOptions {
        host: String::new(),
        port: 0,
        user: String::new(),
        password: String::new(),
        database: None,
        driver: t::DriverKind::DuckDb,
        file_path: None,
        ssl_mode: None,
        ssl_root_cert: None,
        ssl_client_cert: None,
        ssl_client_key: None,
        init_sql: None,
    };
    let err = t::connect(&opts)
        .await
        .err()
        .expect("missing file_path must error");
    assert!(matches!(err, t::AppError::InvalidInput(_)));

    let mut nonexistent = std::env::temp_dir();
    nonexistent.push(format!(
        "noobdb_duckdb_does_not_exist_{}.duckdb",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&nonexistent);
    let opts2 = t::duckdb_options(nonexistent.to_str().unwrap());
    let err2 = t::connect(&opts2)
        .await
        .err()
        .expect("nonexistent path must error rather than silently creating a file");
    assert!(matches!(err2, t::AppError::InvalidInput(_)));
    assert!(
        !nonexistent.exists(),
        "connecting to a missing file must not create one"
    );
}

/// Session-init SQL (#522) runs on every physical connection. DuckDB's
/// driver clones a fresh connection per call (see `db/duckdb.rs` module
/// docs), so this specifically checks the init SQL lands on more than one of
/// those clones, not just the first.
#[tokio::test]
async fn duckdb_init_sql_runs_on_each_connection() {
    let path = temp_db_path("initsql");
    create_empty_db(&path);

    // `threads` reads back as a bare integer (unlike `memory_limit`, which
    // DuckDB reformats with a binary-unit suffix — e.g. `SET memory_limit =
    // '256MB'` reads back as `"244.1 MiB"`, decimal-to-binary rounded — so
    // it makes a more robust equality check here).
    let mut opts = t::duckdb_options(path.to_str().unwrap());
    opts.init_sql = Some("SET threads = 3;".to_string());
    let conn = t::connect(&opts).await.expect("connect with init_sql");

    for _ in 0..3 {
        let res = conn
            .execute("SELECT current_setting('threads')", None)
            .await
            .expect("read back threads");
        match &res.rows[0][0] {
            t::Value::Int(3) => {}
            other => panic!("expected threads=3 to reflect init_sql, got: {other:?}"),
        }
    }

    conn.close().await;
    remove_db_files(&path);
}

/// Same contract as `duckdb_init_sql_runs_on_each_connection`, but with a
/// setting whose effect is *behaviorally* observable rather than just
/// readable via `current_setting` — `SET search_path` changes how an
/// unqualified table name resolves. This is the regression test for a
/// CodeRabbit review finding on #899: `DuckDbConn::clone_conn` originally
/// only cloned the connection and never re-applied init SQL to it, so only
/// the one-off seed connection from `connect` ever saw `search_path` — every
/// per-call clone (which is what every `execute()` actually runs on) would
/// silently fall back to DuckDB's default search path and fail to resolve
/// `t` unqualified.
#[tokio::test]
async fn duckdb_init_sql_search_path_resolves_on_each_cloned_connection() {
    let path = temp_db_path("initsql_searchpath");
    create_empty_db(&path);

    // Set up a non-default schema with a table, using a connection with no
    // init SQL so the fixture itself doesn't depend on the behavior under
    // test.
    let setup_opts = t::duckdb_options(path.to_str().unwrap());
    let setup = t::connect(&setup_opts).await.expect("setup connect");
    setup
        .execute("CREATE SCHEMA s", None)
        .await
        .expect("create schema");
    setup
        .execute("CREATE TABLE s.t (id INTEGER)", None)
        .await
        .expect("create table");
    setup
        .execute("INSERT INTO s.t VALUES (7)", None)
        .await
        .expect("insert row");
    setup.close().await;

    let mut opts = t::duckdb_options(path.to_str().unwrap());
    opts.init_sql = Some("SET search_path = 's';".to_string());
    let conn = t::connect(&opts).await.expect("connect with init_sql");

    // Unqualified `t` only resolves if `search_path` took effect on the
    // connection actually running the query — repeat across several calls so
    // more than one physical clone (see `db/duckdb.rs::clone_conn`) is
    // exercised, not just the seed connection from `connect`.
    for _ in 0..3 {
        let res = conn
            .execute("SELECT id FROM t", None)
            .await
            .expect("unqualified `t` should resolve via search_path on every clone");
        assert_eq!(res.rows, vec![vec![t::Value::Int(7)]]);
    }

    conn.close().await;
    remove_db_files(&path);
}
