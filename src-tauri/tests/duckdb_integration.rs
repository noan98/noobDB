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
        .import_rows_skipping(
            None,
            "imp",
            &columns,
            &rows,
            500,
            &t::ImportConflict::insert_only(),
            |_| Ok(()),
        )
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
        .probe_failing_row(
            None,
            "imp",
            &columns,
            &rows,
            &t::ImportConflict::insert_only(),
        )
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
    // Verify through the *existing* read-only session (a plain SELECT, which
    // it allows) rather than opening a second, independent
    // `duckdb::Connection` to the same file: on Windows DuckDB's file
    // locking rejects a second handle onto a `.duckdb` file that's still
    // open elsewhere in the same process ("File is already open ... in
    // duckdb_integration-*.exe"), unlike Linux which tolerated it — see the
    // #899 CI review. Every other test in this file that needs to inspect
    // state after closing a session already does so via a *fresh* connection
    // opened *after* the prior one's `close()`, so this is the only place
    // that had two connections alive to the same file at once.
    let rows =
        t::run_query_via_command(&state, &sid, "SELECT id, label FROM ro_t ORDER BY id", None)
            .await
            .expect("select after rejected writes")
            .rows;
    assert_eq!(rows.len(), 1, "no write should have landed");
    assert!(matches!(&rows[0][1], t::Value::String(s) if s == "a"));

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

/// #1005: the read-only allow list used to be stuck at the MySQL/PostgreSQL/
/// SQLite-era six prefixes (`SELECT`/`SHOW`/`DESCRIBE`/`DESC`/`EXPLAIN`/
/// `WITH`) and rejected DuckDB's own read-only syntax outright. This exercises
/// the fix through the *real* IPC command path (session lookup + read-only
/// guard + actual DuckDB execution), not just the pure `is_read_only_sql_for`
/// function in isolation.
///
/// `VALUES`, `SUMMARIZE`, and query-form `PRAGMA` are also recognized as
/// query-shaped by `db::duckdb::is_query_shape` (the internal router that
/// decides whether to fetch rows or just run the statement), so these three
/// return real data end-to-end. `FROM`/`TABLE` used to be a documented,
/// deliberate exception: #1005 only widened the read-only *gate*, not
/// `is_query_shape` itself, so a read-only session stopped rejecting `FROM
/// t`/`TABLE t` outright but execution still fell through to DuckDB's
/// `execute()` path and came back with an empty result instead of the
/// underlying rows. #1054 closes that gap by teaching `is_query_shape` the
/// same two keywords, so both now return real data end-to-end as well.
#[tokio::test]
async fn duckdb_read_only_session_allows_new_read_only_syntax_via_ipc() {
    let path = seed_ro_fixture("newsyntax").await;
    let (state, sid) = ro_state(&path).await;

    // `VALUES`: is_query_shape recognizes it, so real data comes back.
    let values = t::run_query_via_command(&state, &sid, "VALUES (1), (2)", None)
        .await
        .expect("read-only session must allow a bare VALUES statement");
    assert_eq!(values.rows.len(), 2, "VALUES must return its two rows");

    // `SUMMARIZE`: likewise query-shaped — DuckDB's column-statistics report.
    let summarize = t::run_query_via_command(&state, &sid, "SUMMARIZE ro_t", None)
        .await
        .expect("read-only session must allow SUMMARIZE");
    assert_eq!(
        summarize.rows.len(),
        2,
        "SUMMARIZE ro_t must report one row per column of ro_t (id, label)"
    );

    // `PRAGMA` query form: no `=`, so the gate allows it, and is_query_shape
    // already routes every PRAGMA (query or setting form) through the query
    // path, so real data comes back too.
    let pragma = t::run_query_via_command(&state, &sid, "PRAGMA database_list", None)
        .await
        .expect("read-only session must allow query-form PRAGMA");
    assert!(
        !pragma.rows.is_empty(),
        "PRAGMA database_list must report at least the attached database"
    );

    // `PRAGMA` setting form: rejected by the read-only gate itself (`=` in
    // the masked body), before it ever reaches the driver.
    let err = t::run_query_via_command(&state, &sid, "PRAGMA memory_limit='1GB'", None)
        .await
        .expect_err("read-only session must reject setting-form PRAGMA");
    assert!(matches!(err, t::AppError::ReadOnly(_)));

    // `FROM`/`TABLE`: the read-only gate allows both (#1005), and as of
    // #1054 `is_query_shape` also recognizes them, so they now round-trip
    // through the query path and return `ro_t`'s real row instead of
    // silently coming back empty (the gap this test used to document).
    for sql in ["FROM ro_t", "TABLE ro_t"] {
        let res = t::run_query_via_command(&state, &sid, sql, None)
            .await
            .unwrap_or_else(|e| {
                panic!("read-only session must not reject {sql:?} as ReadOnly, got: {e:?}")
            });
        assert_eq!(
            res.rows.len(),
            1,
            "{sql:?} must return ro_t's one seeded row via the query path, not fall \
             through to execute() and come back empty"
        );
        assert!(
            matches!(&res.rows[0][1], t::Value::String(s) if s == "a"),
            "{sql:?} must return ro_t's actual seeded label, not just an empty grid"
        );
    }

    // A write disguised behind `RETURNING` is still rejected outright — the
    // leading keyword is `insert`, nowhere near the new allow-list entries.
    let err = t::run_query_via_command(
        &state,
        &sid,
        "INSERT INTO ro_t (id, label) VALUES (2, 'z') RETURNING *",
        None,
    )
    .await
    .expect_err("read-only session must still reject INSERT ... RETURNING");
    assert!(matches!(err, t::AppError::ReadOnly(_)));

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
        aws_iam: None,
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
    // `Connection::close(&self)` only clears a held transaction connection
    // (see its doc comment) — it does *not* drop the seed connection, so
    // `setup` still holds the file open until this binding is actually
    // dropped. Without this, the `t::connect` below would open a second,
    // independent handle onto the same `.duckdb` file while `setup`'s is
    // still alive, which fails on Windows ("File is already open ... in
    // duckdb_integration-*.exe") the same way the #899 CI review flagged for
    // `duckdb_read_only_session_rejects_writes_via_ipc`.
    drop(setup);

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

/// UPSERT import round-trip (#972): `update` mode inserts new keys and
/// overwrites existing ones (a key repeated inside one file resolves to its
/// last occurrence), and `skip` mode leaves existing rows untouched while
/// still inserting new keys. Exercises both the all-or-nothing path
/// (`import_rows`) and the resilient path (`import_rows_skipping`).
async fn assert_upsert_roundtrip(conn: &t::Connection, table: &str) {
    let columns = vec!["id".to_string(), "name".to_string()];
    let cell = |s: &str| Some(s.to_string());
    let select = format!("SELECT name FROM {table} ORDER BY id");
    let names = || async {
        let r = conn.execute(&select, None).await.expect("select names");
        r.rows
            .iter()
            .map(|row| match &row[0] {
                t::Value::String(s) => s.clone(),
                other => format!("{other:?}"),
            })
            .collect::<Vec<_>>()
    };

    let update = t::ImportConflict {
        mode: t::ConflictMode::Update,
        key_columns: vec!["id".to_string()],
    };
    let rows = vec![
        vec![cell("2"), cell("B")],
        vec![cell("3"), cell("c")],
        vec![cell("3"), cell("c2")],
    ];
    let n = conn
        .import_rows(None, table, &columns, &rows, 500, &update, |_| Ok(()))
        .await
        .expect("upsert (update) import");
    assert_eq!(n, 3);
    assert_eq!(names().await, vec!["a", "B", "c2"]);

    let skip = t::ImportConflict {
        mode: t::ConflictMode::Skip,
        key_columns: vec!["id".to_string()],
    };
    let rows = vec![vec![cell("1"), cell("zzz")], vec![cell("4"), cell("d")]];
    let outcome = conn
        .import_rows_skipping(None, table, &columns, &rows, 500, &skip, |_| Ok(()))
        .await
        .expect("upsert (skip) import");
    assert!(outcome.skipped.is_empty(), "{:?}", outcome.skipped);
    assert_eq!(names().await, vec!["a", "B", "c2", "d"]);

    // UPSERT without key columns is rejected before touching the table.
    let no_keys = t::ImportConflict {
        mode: t::ConflictMode::Update,
        key_columns: Vec::new(),
    };
    assert!(conn
        .import_rows(None, table, &columns, &rows, 500, &no_keys, |_| Ok(()))
        .await
        .is_err());
}

#[tokio::test]
async fn duckdb_upsert_import_roundtrip() {
    let path = temp_db_path("upsert");
    create_empty_db(&path);
    let opts = t::duckdb_options(path.to_str().expect("utf8 path"));
    let conn = t::connect(&opts).await.expect("connect");
    conn.execute(
        "CREATE TABLE imp_up (id INTEGER PRIMARY KEY, name VARCHAR NOT NULL)",
        None,
    )
    .await
    .expect("create");
    conn.execute("INSERT INTO imp_up VALUES (1, 'a'), (2, 'b')", None)
        .await
        .expect("seed");
    assert_upsert_roundtrip(&conn, "imp_up").await;
    conn.close().await;
    remove_db_files(&path);
}

/// #987: 外部バイナリ非依存のネイティブダンプ → 別ファイルへ再実行 → 同一データ。
/// 識別子クオート (`"` を含む名前)・NULL・BLOB・日付/時刻・TIMESTAMPTZ・
/// 64bit 超の整数 (BIGINT 最大値 / HUGEINT)・DECIMAL・入れ子型・生成列・
/// シーケンスの現在値・外部キー順・インデックス・ビューを 1 本で往復させる。
#[tokio::test]
async fn duckdb_native_dump_roundtrips_into_fresh_file() {
    let src_path = temp_db_path("dump_src");
    let dst_path = temp_db_path("dump_dst");
    create_empty_db(&src_path);
    create_empty_db(&dst_path);

    {
        let setup = duckdb::Connection::open(&src_path).expect("open src");
        // 子テーブル名を親より辞書順で前 (`a_child` < `z_parent`) にして、
        // 名前順ではなく FK 依存順で出力されることを確かめる。
        setup
            .execute_batch(
                r#"
                CREATE SEQUENCE child_seq START 100;
                CREATE TABLE "z_parent" (
                    id BIGINT PRIMARY KEY,
                    "we""ird name" VARCHAR,
                    big BIGINT,
                    huge HUGEINT,
                    dec DECIMAL(20,4),
                    d DATE,
                    ts TIMESTAMP,
                    tstz TIMESTAMPTZ,
                    tm TIME,
                    iv INTERVAL,
                    u UUID,
                    b BLOB,
                    f DOUBLE,
                    flag BOOLEAN,
                    l INTEGER[],
                    st STRUCT(a INTEGER, "b c" VARCHAR),
                    doubled BIGINT GENERATED ALWAYS AS (id * 2) VIRTUAL
                );
                CREATE TABLE "a_child" (
                    id INTEGER PRIMARY KEY DEFAULT nextval('child_seq'),
                    parent_id BIGINT REFERENCES "z_parent"(id),
                    note VARCHAR
                );
                INSERT INTO "z_parent" (id, "we""ird name", big, huge, dec, d, ts, tstz, tm, iv, u, b, f, flag, l, st) VALUES
                    (1, 'it''s; a "test"', 9223372036854775807, 170141183460469231731687303715884105727,
                     1234567890123456.7891, DATE '2024-02-29', TIMESTAMP '2024-01-02 03:04:05.123456',
                     TIMESTAMPTZ '2024-01-02 03:04:05+09', TIME '23:59:59.5', INTERVAL '1 year 2 days 3 seconds',
                     'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', '\x00\xFF\x10'::BLOB, 0.1, TRUE,
                     [1, NULL, 3], {'a': 1, 'b c': 'x''y'}),
                    (2, NULL, -9223372036854775808, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
                     ''::BLOB, 1e300, FALSE, [], NULL),
                    (3, 'line1' || chr(10) || 'line2 \ back', 0, -1, -0.5, DATE '1970-01-01', NULL, NULL, NULL, NULL,
                     NULL, NULL, NULL, NULL, NULL, NULL);
                INSERT INTO "a_child" (parent_id, note) VALUES (1, 'x'), (1, NULL), (3, '日本語');
                CREATE INDEX idx_child_parent ON "a_child"(parent_id);
                CREATE VIEW v_parent AS SELECT id, big FROM "z_parent" WHERE id > 1;
                "#,
            )
            .expect("seed source");
    }

    let src = t::connect(&t::duckdb_options(src_path.to_str().expect("utf8")))
        .await
        .expect("connect src");
    let dump = t::native_dump_sql(&src, "main", &t::NativeDumpOptions::default())
        .await
        .expect("native dump");

    // 親テーブルが子より先に作られる (FK 依存順)。DuckDB の DDL は識別子を
    // 必要なときだけクオートするので、どちらの綴りでも探す。
    let pos = |name: &str| {
        dump.find(&format!("CREATE TABLE {name}"))
            .or_else(|| dump.find(&format!("CREATE TABLE \"{name}\"")))
    };
    let (parent_at, child_at) = (pos("z_parent"), pos("a_child"));
    assert!(
        parent_at.is_some() && child_at.is_some() && parent_at < child_at,
        "parent must be created before child:\n{dump}"
    );
    // 生成列は INSERT の列に含めない。64bit 境界は引用符なしの正確な値。
    assert!(
        !dump.contains("\"doubled\")"),
        "generated column must not be inserted:\n{dump}"
    );
    assert!(dump.contains("9223372036854775807"), "{dump}");
    assert!(
        dump.contains("170141183460469231731687303715884105727"),
        "{dump}"
    );

    // 別ファイルへ復元 (DuckDB CLI と同じく execute_batch でスクリプトごと実行)。
    {
        let dst = duckdb::Connection::open(&dst_path).expect("open dst");
        if let Err(e) = dst.execute_batch(&dump) {
            panic!("restore failed: {e}\n--- dump ---\n{dump}");
        }
    }
    let dst = t::connect(&t::duckdb_options(dst_path.to_str().expect("utf8")))
        .await
        .expect("connect dst");

    for sql in [
        // INTERVAL 列は既存の DuckDB ドライバが列メタデータを組めない (duckdb crate の
        // `Interval(MonthDayNano)` 未実装) ので、生の比較からは外し、下の CAST 版で見る。
        "SELECT * EXCLUDE (iv) FROM \"z_parent\" ORDER BY id",
        "SELECT CAST(COLUMNS(*) AS VARCHAR) FROM \"z_parent\" ORDER BY id",
        "SELECT * FROM \"a_child\" ORDER BY id",
        "SELECT * FROM v_parent ORDER BY id",
    ] {
        let a = src.execute(sql, None).await.expect("src select");
        let b = dst.execute(sql, None).await.expect("dst select");
        assert!(!a.rows.is_empty(), "{sql} returned no rows");
        assert_eq!(a.rows, b.rows, "mismatch for {sql}\n--- dump ---\n{dump}");
    }

    // シーケンスは現在値の続きから (100, 101, 102 を使用済み → 次は 103)。
    let next = dst
        .execute("SELECT nextval('child_seq')", None)
        .await
        .expect("nextval");
    assert_eq!(next.rows, vec![vec![t::Value::Int(103)]]);

    // インデックスと外部キーも復元されている。
    let idx = dst
        .execute(
            "SELECT count(*) FROM duckdb_indexes() WHERE index_name = 'idx_child_parent'",
            None,
        )
        .await
        .expect("indexes");
    assert_eq!(idx.rows, vec![vec![t::Value::Int(1)]]);
    assert!(
        dst.execute("INSERT INTO \"a_child\" (parent_id) VALUES (999)", None)
            .await
            .is_err(),
        "foreign key must be restored"
    );

    // スキーマのみ / データのみのオプション。
    let schema_only = t::native_dump_sql(
        &src,
        "main",
        &t::NativeDumpOptions {
            no_data: true,
            ..Default::default()
        },
    )
    .await
    .expect("schema-only dump");
    assert!(!schema_only.contains("INSERT INTO"), "{schema_only}");
    assert!(schema_only.contains("CREATE TABLE"), "{schema_only}");
    let data_only = t::native_dump_sql(
        &src,
        "main",
        &t::NativeDumpOptions {
            no_create_info: true,
            extended_insert: false,
            ..Default::default()
        },
    )
    .await
    .expect("data-only dump");
    assert!(!data_only.contains("CREATE TABLE"), "{data_only}");
    assert!(!data_only.contains("DROP TABLE"), "{data_only}");
    // 1 行 1 文: 親 3 行 + 子 3 行。
    assert_eq!(data_only.matches("INSERT INTO").count(), 6, "{data_only}");

    // 読み取り専用セッションでもダンプできる (読み出しのみ)。
    drop(src);
    drop(dst);
    let ro_opts = t::duckdb_options(src_path.to_str().expect("utf8"));
    let ro = t::connect(&ro_opts).await.expect("reconnect");
    let session = t::make_session("dump-ro", ro, ro_opts, true);
    let again = t::native_dump_sql(&session.conn, "main", &t::NativeDumpOptions::default())
        .await
        .expect("dump on read-only session");
    assert_eq!(again, dump, "dump must be deterministic");
    drop(session);

    remove_db_files(&src_path);
    remove_db_files(&dst_path);
}

#[tokio::test]
async fn duckdb_table_and_column_comments_round_trip() {
    // #1002: COMMENT ON で付けたコメントが describe (columns) と table_comments に
    // 出る。コメントの無い列は None。
    let path = temp_db_path("comments");
    create_empty_db(&path);
    let opts = t::duckdb_options(path.to_str().expect("utf8 path"));
    let conn = t::connect(&opts).await.expect("connect");
    conn.execute(
        "CREATE TABLE items (id INTEGER PRIMARY KEY, qty INTEGER)",
        None,
    )
    .await
    .expect("create");
    conn.execute("COMMENT ON TABLE items IS '商品'", None)
        .await
        .expect("comment table");
    conn.execute("COMMENT ON COLUMN items.qty IS 'it''s qty'", None)
        .await
        .expect("comment column");

    let cols = conn.columns("main", "items").await.expect("columns");
    let qty = cols.iter().find(|c| c.name == "qty").expect("qty");
    assert_eq!(qty.comment.as_deref(), Some("it's qty"));
    let id = cols.iter().find(|c| c.name == "id").expect("id");
    assert_eq!(id.comment, None);

    let tables = conn.table_comments("main").await.expect("table comments");
    assert!(
        tables
            .iter()
            .any(|c| c.name == "items" && c.comment == "商品"),
        "{tables:?}"
    );

    conn.close().await;
    remove_db_files(&path);
}

#[tokio::test]
async fn duckdb_table_definition_returns_native_ddl() {
    // #1001: kind="table" は duckdb_tables().sql のネイティブ DDL に、ユーザ作成
    // インデックス (duckdb_indexes().sql) をベストエフォートで後置して返す。
    let path = temp_db_path("tblddl");
    create_empty_db(&path);
    let opts = t::duckdb_options(path.to_str().expect("utf8 path"));
    let conn = t::connect(&opts).await.expect("connect");
    conn.execute(
        "CREATE TABLE parent (id INTEGER PRIMARY KEY, name VARCHAR NOT NULL DEFAULT 'x')",
        None,
    )
    .await
    .expect("create parent");
    conn.execute(
        "CREATE TABLE child (id INTEGER PRIMARY KEY, pid INTEGER REFERENCES parent(id))",
        None,
    )
    .await
    .expect("create child");
    conn.execute("CREATE INDEX idx_child_pid ON child (pid)", None)
        .await
        .expect("create index");
    conn.execute("CREATE VIEW v_child AS SELECT id FROM child", None)
        .await
        .expect("create view");

    let ddl = conn
        .object_definition("main", "table", "parent", None)
        .await
        .expect("parent ddl");
    assert!(ddl.contains("CREATE TABLE"), "{ddl}");
    assert!(ddl.contains("PRIMARY KEY"), "{ddl}");
    assert!(ddl.contains("NOT NULL"), "{ddl}");
    assert!(ddl.trim_end().ends_with(';'), "{ddl}");

    let child = conn
        .object_definition("main", "table", "child", None)
        .await
        .expect("child ddl");
    assert!(child.contains("REFERENCES"), "{child}");
    assert!(child.contains("idx_child_pid"), "{child}");

    let view = conn
        .object_definition("main", "table", "v_child", None)
        .await
        .expect("view via table kind");
    assert!(view.to_uppercase().contains("CREATE VIEW"), "{view}");

    assert!(conn
        .object_definition("main", "table", "missing", None)
        .await
        .is_err());

    conn.close().await;
    remove_db_files(&path);
}

/// ファイルから新規テーブルを作成してインポート (#985) の DuckDB 版。DuckDB は
/// 型に厳格なので、真偽 / 日付 / 日時 / 64bit 整数の実型へのロードと、abort
/// モードで行が型変換に失敗したときに作成したテーブルが DROP されることを確かめる。
#[tokio::test]
async fn duckdb_import_into_new_table_roundtrip_and_cleanup() {
    let path = temp_db_path("new_table");
    create_empty_db(&path);
    let db_path = path.to_str().expect("utf8 path");
    let csv = std::env::temp_dir().join(format!("noobdb_duck_new_{}.csv", std::process::id()));
    std::fs::write(
        &csv,
        "id,flag,day,at,big\n\
         1,true,2024-02-29,2024-01-02 03:04:05.123456,9223372036854775807\n\
         2,false,2024-03-01,2024-01-02T10:00:00,-1\n",
    )
    .expect("write csv");
    let csv_path = csv.to_str().expect("utf8 path");

    let conn = t::connect(&t::duckdb_options(db_path))
        .await
        .expect("connect");
    let session = t::make_session("d-new", conn, t::duckdb_options(db_path), false);
    let options = serde_json::json!({
        "delimiter": ",",
        "quote": "\"",
        "hasHeader": true,
        "nullToken": "",
        "encoding": "utf-8",
    });
    let mapping = serde_json::json!([
        { "column": "id", "csvIndex": 0 },
        { "column": "flag", "csvIndex": 1 },
        { "column": "day", "csvIndex": 2 },
        { "column": "at", "csvIndex": 3 },
        { "column": "big", "csvIndex": 4 },
    ]);
    let create = serde_json::json!([
        { "name": "id", "type": "integer" },
        { "name": "flag", "type": "boolean" },
        { "name": "day", "type": "date" },
        { "name": "at", "type": "datetime" },
        { "name": "big", "type": "bigint" },
    ]);
    let inserted = t::import_file_via_command(
        &session,
        None,
        "select",
        csv_path,
        options.clone(),
        mapping.clone(),
        Some(create.clone()),
    )
    .await
    .expect("import setup")
    .expect("import rows");
    assert_eq!(inserted, 2);
    let res = session
        .conn
        .execute(
            // `at` は DuckDB の予約語 (インポート側は quote_ident でクォート済み)。
            "SELECT typeof(flag), typeof(day), typeof(\"at\"), typeof(big), \
             CAST(big AS VARCHAR), CAST(flag AS VARCHAR) FROM \"select\" ORDER BY id",
            None,
        )
        .await
        .expect("select");
    let text = |v: &t::Value| match v {
        t::Value::String(s) => s.clone(),
        other => format!("{other:?}"),
    };
    let rows: Vec<Vec<String>> = res
        .rows
        .iter()
        .map(|r| r.iter().map(text).collect())
        .collect();
    assert_eq!(
        rows[0],
        vec![
            "BOOLEAN",
            "DATE",
            "TIMESTAMP",
            "BIGINT",
            "9223372036854775807",
            "true"
        ]
    );
    assert_eq!(rows[1][5], "false");

    // abort モードで型変換に失敗 → 作成したテーブルは DROP される。
    std::fs::write(&csv, "id\n1\nnot-a-number\n").expect("write bad csv");
    let failed = t::import_file_via_command(
        &session,
        None,
        "bad_t",
        csv_path,
        options,
        serde_json::json!([{ "column": "id", "csvIndex": 0 }]),
        Some(serde_json::json!([{ "name": "id", "type": "integer" }])),
    )
    .await
    .expect("setup succeeds; the row error is reported");
    let message = failed.expect_err("the bad row must fail the abort-mode import");
    assert!(message.contains("record 2"), "{message}");
    assert!(message.contains("was dropped"), "{message}");
    let exists = session
        .conn
        .execute(
            "SELECT COUNT(*) FROM information_schema.tables WHERE table_name = 'bad_t'",
            None,
        )
        .await
        .expect("probe");
    assert!(
        matches!(&exists.rows[0][0], t::Value::Int(0)),
        "{:?}",
        exists.rows
    );

    session.conn.close().await;
    let _ = std::fs::remove_file(&csv);
    remove_db_files(&path);
}
