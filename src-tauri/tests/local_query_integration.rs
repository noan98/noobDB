//! Integration tests for local cross-connection query (#740).
//!
//! No external server is needed: two independent temp SQLite files stand in
//! for "two different connections" (mirroring how the frontend would fetch
//! rows from e.g. a MySQL session and a PostgreSQL session), and the local
//! engine itself is another temp-file-backed SQLite database opened through
//! the same `commands::local` IPC core the frontend drives. This exercises
//! the full path: register two result sets from different sources, JOIN them
//! locally, list/drop provenance metadata, enforce the row cap, round-trip
//! BLOB/NULL, and persist to a standalone file.

use std::path::PathBuf;

use noobdb_lib::__test_api as t;

fn temp_db_path(label: &str) -> PathBuf {
    let mut p = std::env::temp_dir();
    p.push(format!(
        "noobdb_local_query_{label}_{}.db",
        std::process::id()
    ));
    p
}

async fn open_temp_sqlite(label: &str) -> (PathBuf, t::Connection) {
    let path = temp_db_path(label);
    let _ = std::fs::remove_file(&path);
    std::fs::File::create(&path).expect("touch temp sqlite file");
    let opts = t::sqlite_options(path.to_str().expect("utf8 path"));
    let conn = t::connect(&opts).await.expect("connect source db");
    (path, conn)
}

/// Runs `sql` and returns `(columns, rows)` in the wire format the frontend
/// would receive from `run_query` / a completed `run_query_stream` — i.e.
/// exactly what `register_local_table` consumes.
async fn fetch_wire(conn: &t::Connection, sql: &str) -> (Vec<t::Column>, Vec<Vec<t::Value>>) {
    let res = conn.execute(sql, None).await.expect("query source db");
    (res.columns, res.rows)
}

/// Opens a fresh local session through the same core the `create_local_session`
/// IPC command calls, backed by a fresh `AppState`.
async fn new_local(state: &t::AppState) -> String {
    t::create_local_session_inner(state)
        .await
        .expect("create local session")
}

#[tokio::test]
async fn registers_and_joins_across_two_sources() {
    let state = t::AppState::default();

    // Two independent "connections".
    let (path_a, conn_a) = open_temp_sqlite("a").await;
    conn_a
        .execute(
            "CREATE TABLE orders (id INTEGER, customer_id INTEGER, total REAL)",
            None,
        )
        .await
        .expect("create orders");
    conn_a
        .execute(
            "INSERT INTO orders VALUES (1, 100, 9.5), (2, 200, 4.0)",
            None,
        )
        .await
        .expect("insert orders");

    let (path_b, conn_b) = open_temp_sqlite("b").await;
    conn_b
        .execute("CREATE TABLE customers (id INTEGER, name TEXT)", None)
        .await
        .expect("create customers");
    conn_b
        .execute(
            "INSERT INTO customers VALUES (100, 'Alice'), (200, 'Bob')",
            None,
        )
        .await
        .expect("insert customers");

    let (orders_cols, orders_rows) = fetch_wire(&conn_a, "SELECT * FROM orders").await;
    let (customers_cols, customers_rows) = fetch_wire(&conn_b, "SELECT * FROM customers").await;

    let local_id = new_local(&state).await;

    t::register_local_table_inner(
        &state,
        t::RegisterLocalTableRequest {
            session_id: local_id.clone(),
            table_name: "orders".into(),
            columns: orders_cols,
            rows: orders_rows,
            source_profile: Some("Source A (mysql-ish)".into()),
            source_sql: "SELECT * FROM orders".into(),
            source_driver: Some("mysql".into()),
        },
    )
    .await
    .expect("register orders locally");

    t::register_local_table_inner(
        &state,
        t::RegisterLocalTableRequest {
            session_id: local_id.clone(),
            table_name: "customers".into(),
            columns: customers_cols,
            rows: customers_rows,
            source_profile: Some("Source B (postgres-ish)".into()),
            source_sql: "SELECT * FROM customers".into(),
            source_driver: Some("postgres".into()),
        },
    )
    .await
    .expect("register customers locally");

    let local_session = state.get(&local_id).await.expect("local session exists");

    // The acceptance-critical bit: JOIN across two originally-unrelated
    // connections' data, entirely inside the local engine.
    let joined = local_session
        .conn
        .execute(
            "SELECT o.id, c.name, o.total FROM orders o \
             JOIN customers c ON c.id = o.customer_id ORDER BY o.id",
            None,
        )
        .await
        .expect("cross-source join");
    assert_eq!(joined.rows.len(), 2);
    assert!(matches!(&joined.rows[0][1], t::Value::String(s) if s == "Alice"));
    assert!(matches!(&joined.rows[1][1], t::Value::String(s) if s == "Bob"));

    // Provenance metadata round-trips through list_local_tables, newest first.
    let listed = t::list_local_tables_inner(&state, &local_id)
        .await
        .expect("list local tables");
    assert_eq!(listed.len(), 2);
    assert_eq!(listed[0].name, "customers"); // registered second -> newest first
    assert_eq!(listed[0].row_count, 2);
    assert_eq!(listed[0].source_driver.as_deref(), Some("postgres"));
    assert_eq!(listed[1].name, "orders");
    assert_eq!(
        listed[1].source_profile.as_deref(),
        Some("Source A (mysql-ish)")
    );

    // Drop one and confirm both the table and its metadata are gone.
    t::drop_local_table_inner(&state, &local_id, "orders")
        .await
        .expect("drop orders");
    let after_drop = t::list_local_tables_inner(&state, &local_id)
        .await
        .expect("list after drop");
    assert_eq!(after_drop.len(), 1);
    assert_eq!(after_drop[0].name, "customers");
    let err = local_session
        .conn
        .execute("SELECT * FROM orders", None)
        .await
        .expect_err("dropped table must no longer exist");
    assert!(format!("{err}").to_lowercase().contains("no such table"));

    conn_a.close().await;
    conn_b.close().await;
    let _ = std::fs::remove_file(&path_a);
    let _ = std::fs::remove_file(&path_b);
}

#[tokio::test]
async fn round_trips_blob_and_null_values() {
    let state = t::AppState::default();
    let local_id = new_local(&state).await;

    let columns = vec![
        t::Column {
            name: "id".into(),
            type_name: "INTEGER".into(),
        },
        t::Column {
            name: "blob_col".into(),
            type_name: "BLOB".into(),
        },
        t::Column {
            name: "maybe_null".into(),
            type_name: "TEXT".into(),
        },
        t::Column {
            name: "when_col".into(),
            type_name: "TEXT".into(),
        },
    ];
    let rows = vec![
        vec![
            t::Value::Int(1),
            t::Value::Bytes("deadbeef".into()),
            t::Value::Null,
            t::Value::String("2024-01-02 03:04:05".into()),
        ],
        vec![
            t::Value::Int(2),
            t::Value::Null,
            t::Value::String("present".into()),
            t::Value::String("2024-06-07 08:09:10".into()),
        ],
    ];

    t::register_local_table_inner(
        &state,
        t::RegisterLocalTableRequest {
            session_id: local_id.clone(),
            table_name: "typed".into(),
            columns,
            rows,
            source_profile: None,
            source_sql: "SELECT 1".into(),
            source_driver: None,
        },
    )
    .await
    .expect("register typed table");

    let local_session = state.get(&local_id).await.expect("local session exists");
    // `blob_col` is selected both raw (to see exactly what storage class/value
    // decode_cell reports) and through `hex(...)` (to additionally prove row 1's
    // value round-tripped as a *real* BLOB, not the literal hex text — `hex()`
    // only accepts blob/numeric input meaningfully).
    let res = local_session
        .conn
        .execute(
            "SELECT id, blob_col, hex(blob_col), maybe_null, when_col FROM typed ORDER BY id",
            None,
        )
        .await
        .expect("select typed rows back");
    assert_eq!(res.rows.len(), 2);

    // Row 1 (id=1): BLOB round-trips as the exact same bytes, and the NULL
    // cell (`maybe_null`) reads back NULL.
    assert!(matches!(&res.rows[0][1], t::Value::Bytes(s) if s == "deadbeef"));
    assert!(matches!(&res.rows[0][2], t::Value::String(s) if s.eq_ignore_ascii_case("DEADBEEF")));
    assert!(matches!(&res.rows[0][3], t::Value::Null));
    assert!(matches!(&res.rows[0][4], t::Value::String(s) if s == "2024-01-02 03:04:05"));

    // Row 2 (id=2): the BLOB column itself was NULL for this row, non-BLOB
    // text round-trips exactly, datetime-as-string is preserved verbatim.
    assert!(matches!(&res.rows[1][1], t::Value::Null));
    assert!(matches!(&res.rows[1][3], t::Value::String(s) if s == "present"));
    assert!(matches!(&res.rows[1][4], t::Value::String(s) if s == "2024-06-07 08:09:10"));
}

#[tokio::test]
async fn rejects_registration_over_the_row_cap() {
    let state = t::AppState::default();
    let local_id = new_local(&state).await;

    let columns = vec![t::Column {
        name: "n".into(),
        type_name: "INTEGER".into(),
    }];
    let rows: Vec<Vec<t::Value>> = (0..(t::MAX_LOCAL_TABLE_ROWS + 1))
        .map(|i| vec![t::Value::Int(i as i64)])
        .collect();

    let err = t::register_local_table_inner(
        &state,
        t::RegisterLocalTableRequest {
            session_id: local_id,
            table_name: "too_big".into(),
            columns,
            rows,
            source_profile: None,
            source_sql: "SELECT n FROM generate_series".into(),
            source_driver: None,
        },
    )
    .await
    .expect_err("must reject registration over the row cap");
    assert_eq!(err.kind(), "invalidInput");
}

#[tokio::test]
async fn rejects_registration_and_listing_on_a_non_local_session() {
    let state = t::AppState::default();
    let (path, conn) = open_temp_sqlite("guard").await;
    let opts = t::sqlite_options(path.to_str().expect("utf8 path"));
    let session = t::make_session("normalsess", conn, opts, false);
    state.insert(session).await;

    let err = t::register_local_table_inner(
        &state,
        t::RegisterLocalTableRequest {
            session_id: "normalsess".into(),
            table_name: "x".into(),
            columns: vec![t::Column {
                name: "n".into(),
                type_name: "INTEGER".into(),
            }],
            rows: vec![vec![t::Value::Int(1)]],
            source_profile: None,
            source_sql: "SELECT 1".into(),
            source_driver: None,
        },
    )
    .await
    .expect_err("a normal (non-local) session must not accept local-table registration");
    assert_eq!(err.kind(), "invalidInput");

    let err = t::list_local_tables_inner(&state, "normalsess")
        .await
        .expect_err("a normal session must not serve local-table listing either");
    assert_eq!(err.kind(), "invalidInput");

    let _ = std::fs::remove_file(&path);
}

#[tokio::test]
async fn saves_a_standalone_snapshot_file() {
    let state = t::AppState::default();
    let local_id = new_local(&state).await;

    t::register_local_table_inner(
        &state,
        t::RegisterLocalTableRequest {
            session_id: local_id.clone(),
            table_name: "snap".into(),
            columns: vec![t::Column {
                name: "n".into(),
                type_name: "INTEGER".into(),
            }],
            rows: vec![vec![t::Value::Int(42)]],
            source_profile: None,
            source_sql: "SELECT 42".into(),
            source_driver: None,
        },
    )
    .await
    .expect("register snap table");

    let mut save_path = std::env::temp_dir();
    save_path.push(format!(
        "noobdb_local_query_saved_{}.sqlite",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&save_path);

    t::save_local_database_inner(&state, &local_id, save_path.to_str().expect("utf8 path"))
        .await
        .expect("save local database to file");
    assert!(
        save_path.exists(),
        "VACUUM INTO must produce the target file"
    );

    // Reopen the saved copy independently and confirm the data is really there
    // — this is what "永続化" means: an independent, self-contained file.
    let saved_opts = t::sqlite_options(save_path.to_str().expect("utf8 path"));
    let saved_conn = t::connect(&saved_opts)
        .await
        .expect("reopen saved snapshot");
    let res = saved_conn
        .execute("SELECT n FROM snap", None)
        .await
        .expect("query saved snapshot");
    assert_eq!(res.rows.len(), 1);
    assert!(matches!(&res.rows[0][0], t::Value::Int(42)));
    saved_conn.close().await;

    let _ = std::fs::remove_file(&save_path);
}
