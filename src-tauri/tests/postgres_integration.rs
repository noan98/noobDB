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

/// list_indexes (#459) / schema_objects + object_definition (#483, oid 識別子) /
/// 明示トランザクション (#414) / health_check (#485) を PostgreSQL 上で実行する。
/// CI のサービスコンテナで実走し、新規ドライバメソッドの動作とカバレッジを担保する。
#[tokio::test]
async fn postgres_new_schema_apis_and_transaction_when_env_set() {
    let Ok(url) = std::env::var("NOOBDB_TEST_POSTGRES_URL") else {
        eprintln!("skip: NOOBDB_TEST_POSTGRES_URL not set");
        return;
    };
    let opts = t::parse_postgres_url(&url).expect("valid url");
    let conn = t::connect(&opts).await.expect("connect");
    let schema = "public";

    // Clean slate (ignore errors if absent).
    for stmt in [
        "DROP TRIGGER IF EXISTS noobdb_objtest_trg ON public.noobdb_objtest_idx",
        "DROP VIEW IF EXISTS public.noobdb_objtest_view",
        "DROP FUNCTION IF EXISTS public.noobdb_objtest_fn()",
        "DROP FUNCTION IF EXISTS public.noobdb_objtest_trgfn() CASCADE",
        "DROP TABLE IF EXISTS public.noobdb_objtest_idx",
    ] {
        let _ = conn.execute(stmt, None).await;
    }

    conn.execute(
        "CREATE TABLE public.noobdb_objtest_idx (id INT PRIMARY KEY, sku TEXT, cat TEXT)",
        None,
    )
    .await
    .expect("create table");
    conn.execute(
        "CREATE UNIQUE INDEX noobdb_uq_sku ON public.noobdb_objtest_idx (sku)",
        None,
    )
    .await
    .expect("unique index");
    conn.execute(
        "CREATE INDEX noobdb_ix_cat ON public.noobdb_objtest_idx (cat)",
        None,
    )
    .await
    .expect("plain index");

    let indexes = conn
        .list_indexes(schema, "noobdb_objtest_idx")
        .await
        .expect("list_indexes");
    assert!(
        indexes.iter().any(|i| i.primary),
        "primary-key index present: {indexes:?}"
    );
    let uq = indexes
        .iter()
        .find(|i| i.name == "noobdb_uq_sku")
        .expect("unique index listed");
    assert!(uq.unique && uq.columns == vec!["sku".to_string()]);

    // Objects: view, function, trigger (with its function).
    conn.execute(
        "CREATE VIEW public.noobdb_objtest_view AS SELECT id FROM public.noobdb_objtest_idx",
        None,
    )
    .await
    .expect("create view");
    conn.execute(
        "CREATE FUNCTION public.noobdb_objtest_fn() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$",
        None,
    )
    .await
    .expect("create function");
    conn.execute(
        "CREATE FUNCTION public.noobdb_objtest_trgfn() RETURNS trigger LANGUAGE plpgsql \
         AS $$ BEGIN RETURN NEW; END $$",
        None,
    )
    .await
    .expect("create trigger function");
    conn.execute(
        "CREATE TRIGGER noobdb_objtest_trg BEFORE INSERT ON public.noobdb_objtest_idx \
         FOR EACH ROW EXECUTE FUNCTION public.noobdb_objtest_trgfn()",
        None,
    )
    .await
    .expect("create trigger");

    let objects = conn.schema_objects(schema).await.expect("schema_objects");
    let func = objects
        .iter()
        .find(|o| o.kind == "function" && o.name == "noobdb_objtest_fn")
        .expect("function listed with id");
    assert!(func.id.is_some(), "PG function carries an oid identifier");
    let func_def = conn
        .object_definition(schema, "function", "noobdb_objtest_fn", func.id.as_deref())
        .await
        .expect("function definition by oid");
    assert!(func_def.contains("noobdb_objtest_fn"));

    let trg = objects
        .iter()
        .find(|o| o.kind == "trigger" && o.name == "noobdb_objtest_trg")
        .expect("trigger listed with id");
    let trg_def = conn
        .object_definition(schema, "trigger", "noobdb_objtest_trg", trg.id.as_deref())
        .await
        .expect("trigger definition by oid");
    assert!(trg_def.to_uppercase().contains("TRIGGER"));

    let view_def = conn
        .object_definition(schema, "view", "noobdb_objtest_view", None)
        .await
        .expect("view definition");
    assert!(view_def.to_lowercase().contains("select"));

    // Explicit transaction: rollback then commit.
    assert!(!conn.transaction_active().await);
    conn.begin_transaction(None).await.expect("begin");
    assert!(conn.transaction_active().await);
    conn.execute_in_transaction("INSERT INTO public.noobdb_objtest_idx (id, sku) VALUES (1, 'a')")
        .await
        .expect("insert in tx");
    conn.finish_transaction(false).await.expect("rollback");
    let after_rollback = conn
        .execute("SELECT COUNT(*) AS c FROM public.noobdb_objtest_idx", None)
        .await
        .expect("count");
    assert!(matches!(&after_rollback.rows[0][0], t::Value::Int(0)));

    conn.begin_transaction(None).await.expect("begin 2");
    conn.execute_in_transaction("INSERT INTO public.noobdb_objtest_idx (id, sku) VALUES (2, 'b')")
        .await
        .expect("insert in tx 2");
    conn.finish_transaction(true).await.expect("commit");
    let after_commit = conn
        .execute("SELECT COUNT(*) AS c FROM public.noobdb_objtest_idx", None)
        .await
        .expect("count");
    assert!(matches!(&after_commit.rows[0][0], t::Value::Int(1)));

    conn.health_check().await.expect("health check");

    // Cleanup.
    for stmt in [
        "DROP TRIGGER IF EXISTS noobdb_objtest_trg ON public.noobdb_objtest_idx",
        "DROP VIEW IF EXISTS public.noobdb_objtest_view",
        "DROP FUNCTION IF EXISTS public.noobdb_objtest_fn()",
        "DROP FUNCTION IF EXISTS public.noobdb_objtest_trgfn() CASCADE",
        "DROP TABLE IF EXISTS public.noobdb_objtest_idx",
    ] {
        let _ = conn.execute(stmt, None).await;
    }
    conn.close().await;
}
