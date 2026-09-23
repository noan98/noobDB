//! Integration test against a live Microsoft SQL Server (#729).
//!
//! Skipped unless `NOOBDB_TEST_MSSQL_URL` is set, e.g.:
//!     mssql://sa:YourStrong!Passw0rd@127.0.0.1:1433/testdb
//!
//! Exercises the `Connection::Mssql` path end-to-end: connect, run queries,
//! list databases, introspect columns/indexes (`dbo` schema — see the
//! `db/mssql.rs` module doc comment for why), round-trip CRUD against an
//! isolated temporary table, `TOP` execution, an explicit transaction, and
//! the dry-run preview (which must leave the live table untouched). Mirrors
//! `mysql_integration.rs` / `postgres_integration.rs`.
//!
//! Not run in CI (no MSSQL service container is configured yet, per the
//! issue's initial scope) — run locally against a `mssql-server` Docker
//! image with the env var set.

use noobdb_lib::__test_api as t;

#[tokio::test]
async fn mssql_roundtrip_when_env_set() {
    let Ok(url) = std::env::var("NOOBDB_TEST_MSSQL_URL") else {
        eprintln!("skip: NOOBDB_TEST_MSSQL_URL not set");
        return;
    };
    let opts = t::parse_mssql_url(&url).expect("valid url");
    let db = opts
        .database
        .clone()
        .unwrap_or_else(|| "master".to_string());
    let conn = t::connect(&opts).await.expect("connect");

    // Basic query exercising column / value decoding.
    let res = conn
        .execute("SELECT 1 AS n, 'hello' AS s", None)
        .await
        .expect("query");
    assert_eq!(res.columns.len(), 2);
    assert_eq!(res.rows.len(), 1);
    assert!(matches!(&res.rows[0][0], t::Value::Int(1)));
    assert!(matches!(&res.rows[0][1], t::Value::String(s) if s == "hello"));

    // The connect-time database must show up in the database list.
    let dbs = conn.databases().await.expect("list databases");
    assert!(
        dbs.iter().any(|d| d.eq_ignore_ascii_case(&db)),
        "expected {db:?} in {dbs:?}"
    );

    // CRUD round-trip in an isolated temp table (`dbo` schema, per the
    // driver's introspection scope).
    conn.execute(
        "IF OBJECT_ID('dbo.noobdb_mssql_smoke', 'U') IS NOT NULL \
         DROP TABLE dbo.noobdb_mssql_smoke",
        Some(&db),
    )
    .await
    .expect("drop if exists");
    conn.execute(
        "CREATE TABLE dbo.noobdb_mssql_smoke (id INT PRIMARY KEY, label NVARCHAR(50) NOT NULL)",
        Some(&db),
    )
    .await
    .expect("create");
    conn.execute(
        "INSERT INTO dbo.noobdb_mssql_smoke (id, label) VALUES (1, N'a'), (2, N'b'), (3, N'c')",
        Some(&db),
    )
    .await
    .expect("insert");

    // The freshly-created table must appear in the schema browser.
    let tables = conn.tables(&db).await.expect("list tables");
    assert!(
        tables.iter().any(|tbl| tbl == "noobdb_mssql_smoke"),
        "expected noobdb_mssql_smoke in {tables:?}"
    );
    let cols = conn
        .columns(&db, "noobdb_mssql_smoke")
        .await
        .expect("describe");
    assert_eq!(cols.len(), 2);
    let id_col = cols.iter().find(|c| c.name == "id").expect("id column");
    assert_eq!(id_col.key, "PRI", "PK detection must mark id as PRI");

    let after_insert = conn
        .execute(
            "SELECT id, label FROM dbo.noobdb_mssql_smoke ORDER BY id",
            Some(&db),
        )
        .await
        .expect("select after insert");
    assert_eq!(after_insert.rows.len(), 3);

    let upd = conn
        .execute(
            "UPDATE dbo.noobdb_mssql_smoke SET label = N'B' WHERE id = 2",
            Some(&db),
        )
        .await
        .expect("update");
    assert_eq!(upd.rows_affected, 1);

    let del = conn
        .execute("DELETE FROM dbo.noobdb_mssql_smoke WHERE id = 3", Some(&db))
        .await
        .expect("delete");
    assert_eq!(del.rows_affected, 1);

    let final_rows = conn
        .execute(
            "SELECT id, label FROM dbo.noobdb_mssql_smoke ORDER BY id",
            Some(&db),
        )
        .await
        .expect("final select");
    assert_eq!(final_rows.rows.len(), 2);
    assert!(matches!(&final_rows.rows[1][1], t::Value::String(s) if s == "B"));

    // `TOP` (the driver-specific auto-limit rewrite target) must actually run.
    let topped = conn
        .execute(
            "SELECT TOP (1) id FROM dbo.noobdb_mssql_smoke ORDER BY id",
            Some(&db),
        )
        .await
        .expect("top");
    assert_eq!(topped.rows.len(), 1);

    // Preview wraps the mutation in a transaction and rolls back. The live
    // table must be unchanged afterwards.
    let preview = conn
        .preview_execute_with_limit(
            "UPDATE dbo.noobdb_mssql_smoke SET label = N'rollback' WHERE id = 1",
            Some(&db),
            10,
        )
        .await
        .expect("preview");
    assert_eq!(preview.rows_affected, 1);
    assert_eq!(
        preview.target_table.as_deref(),
        Some("dbo.noobdb_mssql_smoke")
    );
    let after_preview = conn
        .execute(
            "SELECT label FROM dbo.noobdb_mssql_smoke WHERE id = 1",
            Some(&db),
        )
        .await
        .expect("after preview");
    assert!(
        matches!(&after_preview.rows[0][0], t::Value::String(s) if s == "a"),
        "preview must roll back and leave the live table untouched"
    );

    // Explicit transaction round-trip (begin/execute-in-tx/commit).
    assert!(!conn.transaction_active().await);
    conn.begin_transaction(Some(&db)).await.expect("begin tx");
    assert!(conn.transaction_active().await);
    conn.execute_in_transaction("UPDATE dbo.noobdb_mssql_smoke SET label = N'tx' WHERE id = 1")
        .await
        .expect("tx update");
    conn.finish_transaction(true).await.expect("commit");
    assert!(!conn.transaction_active().await);
    let after_tx = conn
        .execute(
            "SELECT label FROM dbo.noobdb_mssql_smoke WHERE id = 1",
            Some(&db),
        )
        .await
        .expect("after tx");
    assert!(matches!(&after_tx.rows[0][0], t::Value::String(s) if s == "tx"));

    // Row-estimate / index introspection (`sys.partitions` / `sys.indexes`).
    let estimates = conn.table_row_estimates(&db).await.expect("row estimates");
    assert!(estimates.iter().any(|e| e.name == "noobdb_mssql_smoke"));

    let indexes = conn
        .list_indexes(&db, "noobdb_mssql_smoke")
        .await
        .expect("indexes");
    assert!(
        indexes.iter().any(|i| i.primary),
        "expected the PK to show up as an index: {indexes:?}"
    );

    // Process list must include this session's own connection.
    let procs = conn.list_processes().await.expect("processes");
    assert!(procs.iter().any(|p| p.is_self));

    // Cleanup.
    conn.execute("DROP TABLE dbo.noobdb_mssql_smoke", Some(&db))
        .await
        .expect("cleanup");
    conn.close().await;
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
async fn mssql_upsert_import_roundtrip() {
    let Ok(url) = std::env::var("NOOBDB_TEST_MSSQL_URL") else {
        eprintln!("skip: NOOBDB_TEST_MSSQL_URL not set");
        return;
    };
    let opts = t::parse_mssql_url(&url).expect("valid url");
    let conn = t::connect(&opts).await.expect("connect");
    conn.execute("DROP TABLE IF EXISTS noobdb_ms_upsert", None)
        .await
        .expect("drop");
    conn.execute(
        "CREATE TABLE noobdb_ms_upsert (id INT PRIMARY KEY, name NVARCHAR(50) NOT NULL)",
        None,
    )
    .await
    .expect("create");
    conn.execute(
        "INSERT INTO noobdb_ms_upsert VALUES (1, N'a'), (2, N'b')",
        None,
    )
    .await
    .expect("seed");
    assert_upsert_roundtrip(&conn, "noobdb_ms_upsert").await;
    conn.execute("DROP TABLE noobdb_ms_upsert", None)
        .await
        .expect("cleanup");
}
