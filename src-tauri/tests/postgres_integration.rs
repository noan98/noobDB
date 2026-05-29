//! Integration test against a live PostgreSQL server.
//!
//! Skipped unless `NOOBDB_TEST_POSTGRES_URL` is set, e.g.:
//!     postgres://postgres:postgres@127.0.0.1:5432/testdb
//!
//! Exercises the `Connection::Postgres` path end-to-end: connect, run
//! queries, list schemas (surfaced as "databases"), introspect columns,
//! and round-trip CRUD against an isolated temporary table. Preview must
//! leave the live table untouched.

use noobdb_lib::__test_api as t;

#[tokio::test]
async fn postgres_roundtrip_when_env_set() {
    let Ok(url) = std::env::var("NOOBDB_TEST_POSTGRES_URL") else {
        eprintln!("skip: NOOBDB_TEST_POSTGRES_URL not set");
        return;
    };
    let opts = t::parse_postgres_url(&url).expect("valid url");
    let conn = t::connect(&opts).await.expect("connect");

    // Basic query exercising column / value decoding.
    let res = conn
        .execute("SELECT 1 AS n, 'hello'::text AS s", None)
        .await
        .expect("query");
    assert_eq!(res.columns.len(), 2);
    assert_eq!(res.rows.len(), 1);
    assert!(matches!(&res.rows[0][0], t::Value::Int(1)));
    assert!(matches!(&res.rows[0][1], t::Value::String(s) if s == "hello"));

    // The "databases" axis lists user schemas — `public` must be present
    // for any default Postgres install.
    let schemas = conn.databases().await.expect("list schemas");
    assert!(
        schemas.iter().any(|d| d == "public"),
        "expected 'public' schema in {:?}",
        schemas
    );

    // CRUD round-trip in an isolated temp table.
    conn.execute("DROP TABLE IF EXISTS public.noobdb_pg_smoke", None)
        .await
        .expect("drop");
    conn.execute(
        "CREATE TABLE public.noobdb_pg_smoke (id INT PRIMARY KEY, label TEXT NOT NULL)",
        None,
    )
    .await
    .expect("create");
    conn.execute(
        "INSERT INTO public.noobdb_pg_smoke (id, label) VALUES (1, 'a'), (2, 'b'), (3, 'c')",
        None,
    )
    .await
    .expect("insert");

    // The freshly-created table must appear in the schema browser.
    let tables = conn.tables("public").await.expect("list tables");
    assert!(
        tables.iter().any(|t| t == "noobdb_pg_smoke"),
        "expected noobdb_pg_smoke in {:?}",
        tables
    );
    let cols = conn
        .columns("public", "noobdb_pg_smoke")
        .await
        .expect("describe");
    assert_eq!(cols.len(), 2);
    let id_col = cols.iter().find(|c| c.name == "id").expect("id column");
    assert_eq!(id_col.key, "PRI", "PK detection must mark id as PRI");

    let after_insert = conn
        .execute(
            "SELECT id, label FROM public.noobdb_pg_smoke ORDER BY id",
            None,
        )
        .await
        .expect("select after insert");
    assert_eq!(after_insert.rows.len(), 3);

    let upd = conn
        .execute(
            "UPDATE public.noobdb_pg_smoke SET label = 'B' WHERE id = 2",
            None,
        )
        .await
        .expect("update");
    assert_eq!(upd.rows_affected, 1);

    let del = conn
        .execute("DELETE FROM public.noobdb_pg_smoke WHERE id = 3", None)
        .await
        .expect("delete");
    assert_eq!(del.rows_affected, 1);

    let final_rows = conn
        .execute(
            "SELECT id, label FROM public.noobdb_pg_smoke ORDER BY id",
            None,
        )
        .await
        .expect("final select");
    assert_eq!(final_rows.rows.len(), 2);
    assert!(matches!(&final_rows.rows[1][1], t::Value::String(s) if s == "B"));

    // Preview wraps the mutation in a transaction and rolls back. The live
    // table must be unchanged afterwards.
    let preview = conn
        .preview_execute_with_limit(
            "UPDATE public.noobdb_pg_smoke SET label = 'rollback' WHERE id = 1",
            None,
            10,
        )
        .await
        .expect("preview");
    assert_eq!(preview.rows_affected, 1);
    assert_eq!(
        preview.target_table.as_deref(),
        Some("public.noobdb_pg_smoke")
    );
    let after_preview = conn
        .execute(
            "SELECT label FROM public.noobdb_pg_smoke WHERE id = 1",
            None,
        )
        .await
        .expect("post-preview select");
    assert!(
        matches!(&after_preview.rows[0][0], t::Value::String(s) if s == "a"),
        "preview must roll back; row 1 should still hold its original label"
    );

    // Approximate row counts come from pg_class.reltuples, which the planner
    // only refreshes on ANALYZE / VACUUM. Force an ANALYZE so the estimate is
    // populated, then assert the smoke table reports its (now-exact) 2 rows.
    conn.execute("ANALYZE public.noobdb_pg_smoke", None)
        .await
        .expect("analyze");
    let estimates = conn
        .table_row_estimates("public")
        .await
        .expect("table_row_estimates");
    let smoke = estimates
        .iter()
        .find(|e| e.name == "noobdb_pg_smoke")
        .expect("smoke table must appear in estimates");
    assert_eq!(
        smoke.estimate,
        Some(2),
        "reltuples after ANALYZE should reflect the 2 surviving rows, got {:?}",
        smoke.estimate
    );

    conn.execute("DROP TABLE public.noobdb_pg_smoke", None)
        .await
        .expect("cleanup");
    conn.close().await;
}
