//! Integration test for the SQLite driver.
//!
//! Unlike the MySQL / PostgreSQL paths, this test does not need an external
//! server — it creates a temporary SQLite file in `std::env::temp_dir()`
//! and exercises the full driver surface against it: connect, CRUD,
//! schema introspection, and preview rollback.

use std::path::PathBuf;

use tablex_lib::__test_api as t;

fn temp_db_path() -> PathBuf {
    let mut p = std::env::temp_dir();
    // Mix in the test PID so parallel test runs don't stomp on each other.
    p.push(format!("tablex_sqlite_smoke_{}.db", std::process::id()));
    p
}

#[tokio::test]
async fn sqlite_roundtrip_against_tempfile() {
    let path = temp_db_path();
    // Drop any leftover file from a previous crashed run, then make sure
    // sqlx can open it — `create_if_missing(false)` requires the file to
    // exist on disk so we touch it before connecting.
    let _ = std::fs::remove_file(&path);
    std::fs::File::create(&path).expect("create temp sqlite file");

    let opts = t::sqlite_options(path.to_str().expect("utf8 path"));
    let conn = t::connect(&opts).await.expect("connect");

    // SELECT round-trip first to confirm the driver decodes literals.
    let res = conn
        .execute("SELECT 1 AS n, 'hello' AS s", None)
        .await
        .expect("query");
    assert_eq!(res.columns.len(), 2);
    assert_eq!(res.rows.len(), 1);
    assert!(matches!(&res.rows[0][0], t::Value::Int(1)));
    assert!(matches!(&res.rows[0][1], t::Value::String(s) if s == "hello"));

    // CRUD round-trip in a real persisted table.
    conn.execute("DROP TABLE IF EXISTS tablex_sqlite_smoke", None)
        .await
        .expect("drop");
    conn.execute(
        "CREATE TABLE tablex_sqlite_smoke (id INTEGER PRIMARY KEY, label TEXT NOT NULL)",
        None,
    )
    .await
    .expect("create");
    conn.execute(
        "INSERT INTO tablex_sqlite_smoke (id, label) VALUES (1, 'a'), (2, 'b'), (3, 'c')",
        None,
    )
    .await
    .expect("insert");

    // Schema browser surfaces.
    let dbs = conn.databases().await.expect("databases");
    assert_eq!(dbs, vec!["main".to_string()]);
    let tables = conn.tables("main").await.expect("tables");
    assert!(tables.iter().any(|t| t == "tablex_sqlite_smoke"));
    let cols = conn
        .columns("main", "tablex_sqlite_smoke")
        .await
        .expect("columns");
    assert_eq!(cols.len(), 2);
    let id_col = cols.iter().find(|c| c.name == "id").expect("id column");
    assert_eq!(id_col.key, "PRI", "PK detection must mark id as PRI");

    let after_insert = conn
        .execute(
            "SELECT id, label FROM tablex_sqlite_smoke ORDER BY id",
            None,
        )
        .await
        .expect("select after insert");
    assert_eq!(after_insert.rows.len(), 3);

    let upd = conn
        .execute(
            "UPDATE tablex_sqlite_smoke SET label = 'B' WHERE id = 2",
            None,
        )
        .await
        .expect("update");
    assert_eq!(upd.rows_affected, 1);

    let del = conn
        .execute("DELETE FROM tablex_sqlite_smoke WHERE id = 3", None)
        .await
        .expect("delete");
    assert_eq!(del.rows_affected, 1);

    let final_rows = conn
        .execute(
            "SELECT id, label FROM tablex_sqlite_smoke ORDER BY id",
            None,
        )
        .await
        .expect("final select");
    assert_eq!(final_rows.rows.len(), 2);
    assert!(matches!(&final_rows.rows[1][1], t::Value::String(s) if s == "B"));

    // Preview must roll back.
    let preview = conn
        .preview_execute_with_limit(
            "UPDATE tablex_sqlite_smoke SET label = 'rollback' WHERE id = 1",
            None,
            10,
        )
        .await
        .expect("preview");
    assert_eq!(preview.rows_affected, 1);
    assert_eq!(preview.target_table.as_deref(), Some("tablex_sqlite_smoke"));
    let after_preview = conn
        .execute("SELECT label FROM tablex_sqlite_smoke WHERE id = 1", None)
        .await
        .expect("post-preview select");
    assert!(
        matches!(&after_preview.rows[0][0], t::Value::String(s) if s == "a"),
        "preview must roll back; row 1 should still hold its original label"
    );

    conn.execute("DROP TABLE tablex_sqlite_smoke", None)
        .await
        .expect("cleanup");
    conn.close().await;

    let _ = std::fs::remove_file(&path);
}

#[tokio::test]
async fn sqlite_execute_transaction_is_all_or_nothing() {
    let mut path = std::env::temp_dir();
    path.push(format!("tablex_sqlite_tx_{}.db", std::process::id()));
    let _ = std::fs::remove_file(&path);
    std::fs::File::create(&path).expect("create temp sqlite file");

    let opts = t::sqlite_options(path.to_str().expect("utf8 path"));
    let conn = t::connect(&opts).await.expect("connect");

    conn.execute(
        "CREATE TABLE tablex_tx (id INTEGER PRIMARY KEY, label TEXT NOT NULL)",
        None,
    )
    .await
    .expect("create");
    conn.execute(
        "INSERT INTO tablex_tx (id, label) VALUES (1, 'a'), (2, 'b')",
        None,
    )
    .await
    .expect("seed");

    // Happy path: two UPDATEs commit together and the affected counts add up.
    let affected = conn
        .execute_transaction(
            &[
                "UPDATE tablex_tx SET label = 'A' WHERE id = 1".to_string(),
                "UPDATE tablex_tx SET label = 'B' WHERE id = 2".to_string(),
            ],
            None,
        )
        .await
        .expect("transaction commits");
    assert_eq!(affected, 2, "both UPDATEs should report one affected row");

    // Failure path: the first UPDATE succeeds but the second references a
    // missing column, so the whole batch must roll back — row 1 keeps its
    // pre-transaction value rather than the half-applied 'X'.
    let err = conn
        .execute_transaction(
            &[
                "UPDATE tablex_tx SET label = 'X' WHERE id = 1".to_string(),
                "UPDATE tablex_tx SET nonexistent = 'Y' WHERE id = 2".to_string(),
            ],
            None,
        )
        .await
        .expect_err("transaction must fail on the bad statement");
    assert!(
        !err.to_string().is_empty(),
        "error should describe the failed statement"
    );

    let rows = conn
        .execute("SELECT id, label FROM tablex_tx ORDER BY id", None)
        .await
        .expect("select after rollback");
    assert!(
        matches!(&rows.rows[0][1], t::Value::String(s) if s == "A"),
        "row 1 must keep the committed 'A' — the failed batch's 'X' must have rolled back"
    );
    assert!(matches!(&rows.rows[1][1], t::Value::String(s) if s == "B"));

    conn.execute("DROP TABLE tablex_tx", None)
        .await
        .expect("cleanup");
    conn.close().await;
    let _ = std::fs::remove_file(&path);
}

#[tokio::test]
async fn sqlite_missing_path_reports_invalid_input() {
    // file_path = None should surface a clean error instead of panicking
    // somewhere inside sqlx.
    let opts = tablex_lib::__test_api::DbConnectOptions {
        host: String::new(),
        port: 0,
        user: String::new(),
        password: String::new(),
        database: None,
        driver: tablex_lib::__test_api::DriverKind::Sqlite,
        file_path: None,
    };
    let err = tablex_lib::__test_api::connect(&opts)
        .await
        .err()
        .expect("missing file_path must error");
    let msg = err.to_string();
    assert!(
        msg.contains("file_path") || msg.contains("invalid input"),
        "unexpected error: {msg}"
    );
}
