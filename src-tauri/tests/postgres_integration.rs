//! Integration test against a live PostgreSQL server.
//!
//! Skipped unless `NOOBDB_TEST_POSTGRES_URL` is set, e.g.:
//!     postgres://postgres:postgres@127.0.0.1:5432/testdb
//!
//! Exercises the `Connection::Postgres` path end-to-end: connect, run
//! queries, list schemas (surfaced as "databases"), introspect columns,
//! and round-trip CRUD against an isolated temporary table. Preview must
//! leave the live table untouched.

use super::common; // 共有ヘルパは groups/external.rs が 1 度だけ取り込む

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

/// `table_sizes` must report a base table with byte figures from the
/// `pg_*_size` functions, and `total == data + index`-ish (pg_total_relation_size
/// also includes TOAST/FSM/VM, so we only assert total >= indexes and >= 0).
/// `server_info` must return a version and a non-empty pg_settings list.
#[tokio::test]
async fn postgres_table_sizes_and_server_info() {
    let Ok(url) = std::env::var("NOOBDB_TEST_POSTGRES_URL") else {
        eprintln!("skip: NOOBDB_TEST_POSTGRES_URL not set");
        return;
    };
    let opts = t::parse_postgres_url(&url).expect("valid url");
    let conn = t::connect(&opts).await.expect("connect");

    conn.execute("DROP TABLE IF EXISTS public.noobdb_pg_sizes", None)
        .await
        .expect("drop");
    conn.execute(
        "CREATE TABLE public.noobdb_pg_sizes (id INT PRIMARY KEY, label TEXT NOT NULL)",
        None,
    )
    .await
    .expect("create");
    conn.execute(
        "CREATE INDEX noobdb_pg_sizes_label ON public.noobdb_pg_sizes(label)",
        None,
    )
    .await
    .expect("index");
    conn.execute(
        "INSERT INTO public.noobdb_pg_sizes SELECT g, 'row-' || g FROM generate_series(1, 200) g",
        None,
    )
    .await
    .expect("seed");
    conn.execute("ANALYZE public.noobdb_pg_sizes", None)
        .await
        .expect("analyze");

    let sizes = conn.table_sizes("public").await.expect("table_sizes");
    let row = sizes
        .iter()
        .find(|s| s.name == "noobdb_pg_sizes")
        .expect("table must appear in sizes");
    assert!(
        row.row_estimate.unwrap_or(0) > 0,
        "reltuples after ANALYZE should be positive: {row:?}"
    );
    let total = row.total_bytes.expect("total bytes present");
    let index = row.index_bytes.expect("index bytes present");
    assert!(total >= index, "total must be >= index size: {row:?}");
    assert!(total > 0, "a seeded table must use storage: {row:?}");
    // 肥大・統計の古さの指標 (#1622): ANALYZE 済みなので analyze 時刻が入り、不要行数も報告される。
    assert!(
        row.dead_rows.is_some(),
        "n_dead_tup must be reported: {row:?}"
    );
    assert!(
        row.last_analyze_at.is_some_and(|ts| ts > 0),
        "last_analyze_at must reflect the manual ANALYZE: {row:?}"
    );

    let info = conn.server_info().await.expect("server_info");
    assert!(!info.version.is_empty(), "version must be reported");
    assert!(
        info.variables.iter().any(|v| v.name == "server_version"),
        "pg_settings must include server_version"
    );
    // 値の出どころ (#1622): pg_settings.source が入り、既定値のままの変数は `default`。
    assert!(
        info.variables
            .iter()
            .any(|v| v.source.as_deref() == Some("default")),
        "pg_settings.source must be reported"
    );

    conn.execute("DROP TABLE public.noobdb_pg_sizes", None)
        .await
        .expect("cleanup");
    conn.close().await;
}

/// #1609: row_identity を 1 本のカタログ問い合わせにしても、information_schema 基準の
/// 従来の結果と変わらない。マテビューは列が見えず "none"、列権限だけのユーザは
/// PK が見えず ctid、SELECT だけのユーザは書き込み不可で "none" 相当の結果になる。
#[tokio::test]
async fn postgres_row_identity_matview_and_column_privileges() {
    let Ok(url) = std::env::var("NOOBDB_TEST_POSTGRES_URL") else {
        eprintln!("skip: NOOBDB_TEST_POSTGRES_URL not set");
        return;
    };
    let opts = t::parse_postgres_url(&url).expect("valid url");
    let conn = t::connect(&opts).await.expect("connect");
    for sql in [
        "DROP MATERIALIZED VIEW IF EXISTS public.noobdb_pg_ri_mv",
        "DROP TABLE IF EXISTS public.noobdb_pg_ri_priv",
        "DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'noobdb_pg_ri_colonly') THEN DROP OWNED BY noobdb_pg_ri_colonly; END IF; END $$",
        "DROP ROLE IF EXISTS noobdb_pg_ri_colonly",
        "DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'noobdb_pg_ri_selonly') THEN DROP OWNED BY noobdb_pg_ri_selonly; END IF; END $$",
        "DROP ROLE IF EXISTS noobdb_pg_ri_selonly",
    ] {
        conn.execute(sql, None).await.expect(sql);
    }
    conn.execute(
        "CREATE TABLE public.noobdb_pg_ri_priv (id INT PRIMARY KEY, v TEXT)",
        None,
    )
    .await
    .expect("create table");
    conn.execute(
        "CREATE MATERIALIZED VIEW public.noobdb_pg_ri_mv AS SELECT id FROM public.noobdb_pg_ri_priv",
        None,
    )
    .await
    .expect("create matview");
    // マテビューは information_schema.columns に載らないので従来どおり "none"。
    let mv = conn
        .row_identity("public", "noobdb_pg_ri_mv")
        .await
        .expect("matview identity");
    assert_eq!(mv.strategy, "none");

    for sql in [
        "CREATE ROLE noobdb_pg_ri_colonly LOGIN PASSWORD 'pw'",
        "CREATE ROLE noobdb_pg_ri_selonly LOGIN PASSWORD 'pw'",
        "GRANT USAGE ON SCHEMA public TO noobdb_pg_ri_colonly, noobdb_pg_ri_selonly",
        "GRANT SELECT (v), UPDATE (v) ON public.noobdb_pg_ri_priv TO noobdb_pg_ri_colonly",
        "GRANT SELECT ON public.noobdb_pg_ri_priv TO noobdb_pg_ri_selonly",
    ] {
        conn.execute(sql, None).await.expect(sql);
    }
    for (role, expected_columns) in [
        ("noobdb_pg_ri_colonly", true),
        ("noobdb_pg_ri_selonly", true),
    ] {
        let mut o = opts.clone();
        o.user = role.into();
        o.password = "pw".into();
        let rc = t::connect(&o).await.expect("connect as limited role");
        let cols = rc
            .columns("public", "noobdb_pg_ri_priv")
            .await
            .expect("columns as limited role");
        assert!(
            !cols.iter().any(|c| c.key == "PRI"),
            "{role}: PK は見えない"
        );
        assert_eq!(!cols.is_empty(), expected_columns);
        // columns() が PRI を返さない以上、row_identity も primary_key にならない。
        let ident = rc
            .row_identity("public", "noobdb_pg_ri_priv")
            .await
            .expect("identity as limited role");
        assert_eq!(ident.strategy, "ctid", "{role}");
        rc.close().await;
    }
    for sql in [
        "DROP MATERIALIZED VIEW public.noobdb_pg_ri_mv",
        "DROP TABLE public.noobdb_pg_ri_priv",
        "DROP OWNED BY noobdb_pg_ri_colonly",
        "DROP ROLE noobdb_pg_ri_colonly",
        "DROP OWNED BY noobdb_pg_ri_selonly",
        "DROP ROLE noobdb_pg_ri_selonly",
    ] {
        conn.execute(sql, None).await.expect(sql);
    }
    conn.close().await;
}

/// #849: row identity fallback for inline editing. A table with a PK reports
/// `primary_key`; a PK-less ordinary heap table falls back to the physical
/// `ctid`; a view (no storage/`ctid` of its own) falls back further to
/// `all_columns`.
#[tokio::test]
async fn postgres_row_identity_pk_ctid_and_view_fallback() {
    let Ok(url) = std::env::var("NOOBDB_TEST_POSTGRES_URL") else {
        eprintln!("skip: NOOBDB_TEST_POSTGRES_URL not set");
        return;
    };
    let opts = t::parse_postgres_url(&url).expect("valid url");
    let conn = t::connect(&opts).await.expect("connect");

    conn.execute("DROP VIEW IF EXISTS public.noobdb_pg_rowident_view", None)
        .await
        .expect("drop view");
    conn.execute("DROP TABLE IF EXISTS public.noobdb_pg_rowident_pk", None)
        .await
        .expect("drop pk table");
    conn.execute("DROP TABLE IF EXISTS public.noobdb_pg_rowident_no_pk", None)
        .await
        .expect("drop no-pk table");
    conn.execute(
        "CREATE TABLE public.noobdb_pg_rowident_pk (id INT PRIMARY KEY, label TEXT)",
        None,
    )
    .await
    .expect("create pk table");
    conn.execute(
        "CREATE TABLE public.noobdb_pg_rowident_no_pk (label TEXT, note TEXT)",
        None,
    )
    .await
    .expect("create no-pk table");
    conn.execute(
        "CREATE VIEW public.noobdb_pg_rowident_view AS SELECT label FROM public.noobdb_pg_rowident_no_pk",
        None,
    )
    .await
    .expect("create view");

    let with_pk = conn
        .row_identity("public", "noobdb_pg_rowident_pk")
        .await
        .expect("row_identity pk table");
    assert_eq!(with_pk.strategy, "primary_key");
    assert_eq!(with_pk.hidden_column, None);

    let without_pk = conn
        .row_identity("public", "noobdb_pg_rowident_no_pk")
        .await
        .expect("row_identity no-pk table");
    assert_eq!(without_pk.strategy, "ctid");
    assert_eq!(without_pk.hidden_column, Some("ctid".to_string()));

    let view = conn
        .row_identity("public", "noobdb_pg_rowident_view")
        .await
        .expect("row_identity view");
    assert_eq!(view.strategy, "all_columns");
    assert_eq!(view.hidden_column, None);

    conn.execute("DROP VIEW public.noobdb_pg_rowident_view", None)
        .await
        .expect("cleanup view");
    conn.execute("DROP TABLE public.noobdb_pg_rowident_pk", None)
        .await
        .expect("cleanup pk table");
    conn.execute("DROP TABLE public.noobdb_pg_rowident_no_pk", None)
        .await
        .expect("cleanup no-pk table");
    conn.close().await;
}

/// list_indexes / schema_objects + object_definition (oid 識別子) /
/// 明示トランザクション / health_check を PostgreSQL 上で実行する。
/// CI のサービスコンテナで実走し、ドライバメソッドの動作とカバレッジを担保する。
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
    // スキーマ未指定 (空) は現在のスキーマとして読む (CreateIndexModal の重複検査, #1625)。
    let implicit = conn
        .list_indexes("", "noobdb_objtest_idx")
        .await
        .expect("list_indexes with empty schema");
    assert_eq!(implicit.len(), indexes.len(), "{implicit:?}");

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

    // SAVEPOINT (#1418): コマンド経路で一連が通ること + aborted 状態からの回復。
    {
        let state = t::AppState::default();
        let sp_opts = t::parse_postgres_url(&url).expect("valid url");
        let sp_conn = t::connect(&sp_opts).await.expect("connect sp");
        let id = state
            .insert(t::make_session("sp", sp_conn, sp_opts, false))
            .await;
        let sess = state.get(&id).await.expect("session");
        sess.conn.begin_transaction(None).await.expect("begin sp");
        sess.conn
            .execute_in_transaction(
                "INSERT INTO public.noobdb_objtest_idx (id, sku) VALUES (10, 'x')",
            )
            .await
            .expect("insert 10");
        t::savepoint_via_command(&state, &id, "sp_1", "create")
            .await
            .expect("sp_1");
        sess.conn
            .execute_in_transaction(
                "INSERT INTO public.noobdb_objtest_idx (id, sku) VALUES (11, 'y')",
            )
            .await
            .expect("insert 11");
        t::savepoint_via_command(&state, &id, "sp_2", "create")
            .await
            .expect("sp_2");
        // 失敗で aborted になり、以後の文は 25P02。
        assert!(sess
            .conn
            .execute_in_transaction(
                "INSERT INTO public.noobdb_objtest_idx (id, sku) VALUES (10, 'dup')"
            )
            .await
            .is_err());
        let aborted = sess
            .conn
            .execute_in_transaction("SELECT 1")
            .await
            .expect_err("aborted tx rejects statements");
        assert!(
            aborted
                .to_string()
                .contains("current transaction is aborted"),
            "{aborted}"
        );
        t::savepoint_via_command(&state, &id, "sp_1", "rollback_to")
            .await
            .expect("rollback to sp_1");
        sess.conn
            .execute_in_transaction("SELECT 1")
            .await
            .expect("recovered");
        assert!(t::savepoint_via_command(&state, &id, "sp_2", "release")
            .await
            .is_err());
        // sp_2 の失敗でトランザクションは再び aborted。ROLLBACK TO sp_1 で復旧して解放する。
        t::savepoint_via_command(&state, &id, "sp_1", "rollback_to")
            .await
            .expect("rollback again");
        t::savepoint_via_command(&state, &id, "sp_1", "release")
            .await
            .expect("release sp_1");
        sess.conn.finish_transaction(true).await.expect("commit sp");
        let n = conn
            .execute("SELECT COUNT(*) AS c FROM public.noobdb_objtest_idx", None)
            .await
            .expect("count");
        assert!(
            matches!(&n.rows[0][0], t::Value::Int(2)),
            "{:?}",
            n.rows[0][0]
        );

        // aborted のまま COMMIT するとエラー (黙ってロールバックしない)。
        sess.conn
            .begin_transaction(None)
            .await
            .expect("begin abort");
        sess.conn
            .execute_in_transaction(
                "INSERT INTO public.noobdb_objtest_idx (id, sku) VALUES (99, 'gone')",
            )
            .await
            .expect("insert 99");
        assert!(sess
            .conn
            .execute_in_transaction(
                "INSERT INTO public.noobdb_objtest_idx (id, sku) VALUES (2, 'dup')"
            )
            .await
            .is_err());
        assert!(sess.conn.finish_transaction(true).await.is_err());
        // データは残らず、その後プール接続で次のクエリが正常に流れる。
        let n2 = conn
            .execute("SELECT COUNT(*) AS c FROM public.noobdb_objtest_idx", None)
            .await
            .expect("count after aborted commit");
        assert!(
            matches!(&n2.rows[0][0], t::Value::Int(2)),
            "{:?}",
            n2.rows[0][0]
        );
        sess.conn
            .execute("SELECT 1", None)
            .await
            .expect("pool usable after aborted commit");
        assert!(!sess.conn.transaction_active().await);
    }

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

/// プロセス監視パネル (list_processes / kill_processes) の PostgreSQL 経路。
/// pg_stat_activity のクライアントバックエンドが一覧に現れること、別接続を
/// pg_terminate_backend で終了させると一覧から消えることを確認する。
#[tokio::test]
async fn postgres_process_list_and_kill() {
    let Ok(url) = std::env::var("NOOBDB_TEST_POSTGRES_URL") else {
        eprintln!("skip: NOOBDB_TEST_POSTGRES_URL not set");
        return;
    };
    let opts = t::parse_postgres_url(&url).expect("valid url");
    let conn = t::connect(&opts).await.expect("connect");

    // The listing query runs on one of our own pooled backends, so the result
    // can never be empty.
    let processes = conn.list_processes().await.expect("list_processes");
    assert!(
        !processes.is_empty(),
        "process list must at least contain this client's own backend"
    );
    assert!(
        processes.iter().all(|p| p.id > 0),
        "every backend must carry a positive pid: {processes:?}"
    );
    assert!(
        processes.iter().any(|p| p.is_self),
        "the listing backend itself must be flagged is_self: {processes:?}"
    );

    // Open a second, independent connection and learn its backend pid.
    let victim = t::connect(&opts).await.expect("second connect");
    let res = victim
        .execute("SELECT pg_backend_pid() AS pid", None)
        .await
        .expect("backend pid");
    let victim_pid = match &res.rows[0][0] {
        t::Value::Int(v) => *v,
        other => panic!("unexpected pg_backend_pid value: {other:?}"),
    };
    assert!(
        conn.list_processes()
            .await
            .expect("list before kill")
            .iter()
            .any(|p| p.id == victim_pid),
        "the second connection must be visible before the kill"
    );

    // 文のみ停止 (KILL QUERY / pg_cancel_backend) は実行中の文を中断するが、接続は残る (#1538)。
    // 対象接続で長い文を走らせ、文のみ停止で即座に中断エラーで返り、同じプールで続けて使えることを確かめる。
    let victim = std::sync::Arc::new(victim);
    let sleeper = {
        let v = std::sync::Arc::clone(&victim);
        tokio::spawn(async move {
            let started = std::time::Instant::now();
            let r = v
                .execute("SELECT /* noobdb_1538_pg_cancel */ pg_sleep(30)", None)
                .await;
            (r, started.elapsed())
        })
    };
    // プールが複数の接続を持つと、sleep は victim_pid と別の接続で走りうる。
    // 実際に sleep を実行しているプロセスを一覧から探して、その id を止める。
    let mut sleeping_id = None;
    for _ in 0..100 {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        sleeping_id = conn
            .list_processes()
            .await
            .expect("list while sleeping")
            .iter()
            .find(|p| {
                p.query.as_deref().is_some_and(|q| {
                    q.contains("noobdb_1538_pg_cancel")
                        && !q.contains("processlist")
                        && !q.contains("pg_stat_activity")
                })
            })
            .map(|p| p.id);
        if sleeping_id.is_some() {
            break;
        }
    }
    let sleeping_id = sleeping_id.expect("the sleeping statement must appear in the process list");
    let cancelled_running = conn
        .kill_processes(&[sleeping_id], true)
        .await
        .expect("cancel running statement");
    assert_eq!(cancelled_running.failed, 0, "{cancelled_running:?}");
    let (sleep_result, took) = tokio::time::timeout(std::time::Duration::from_secs(10), sleeper)
        .await
        .expect("the sleeping statement must end promptly after a statement-only stop")
        .expect("join");
    assert!(took < std::time::Duration::from_secs(10), "{took:?}");
    // MySQL の SLEEP は中断されるとエラーではなく 1 を返すことがあるため、どちらでも許容する。
    let _ = sleep_result;
    assert!(
        victim.execute("SELECT 1", None).await.is_ok(),
        "the connection pool must stay usable after a statement-only stop"
    );

    // 文のみ停止 (KILL QUERY / pg_cancel_backend) は成功するが接続は残る (#1538)。
    let cancelled = conn
        .kill_processes(&[victim_pid], true)
        .await
        .expect("cancel statement");
    assert_eq!(cancelled.killed, 1, "{cancelled:?}");
    assert_eq!(cancelled.failed, 0, "{cancelled:?}");
    assert!(
        conn.list_processes()
            .await
            .expect("list after cancel")
            .iter()
            .any(|p| p.id == victim_pid),
        "a statement-only stop must keep the connection"
    );

    let killed = conn
        .kill_processes(&[victim_pid], false)
        .await
        .expect("kill");
    assert_eq!(killed.killed, 1, "{killed:?}");
    assert_eq!(killed.failed, 0, "{killed:?}");
    // int4 に収まらない pid は実行前に失敗として数える (有効な pid はそのまま処理される)。
    let mixed = conn
        .kill_processes(&[i64::MAX, victim_pid], false)
        .await
        .expect("kill mixed");
    assert_eq!(mixed.killed, 1, "{mixed:?}");
    assert_eq!(mixed.failed, 1, "{mixed:?}");
    assert!(mixed.first_error.is_some());
    // id ごとの成否 (#1622): 不正な pid だけが失敗として個別に報告される。
    assert_eq!(mixed.outcomes.len(), 2, "{mixed:?}");
    let invalid = mixed
        .outcomes
        .iter()
        .find(|o| o.id == i64::MAX)
        .expect("invalid pid outcome");
    assert_eq!(invalid.status, t::KillOutcomeStatus::Failed, "{mixed:?}");
    assert!(invalid.error.is_some());
    assert!(
        mixed
            .outcomes
            .iter()
            .any(|o| o.id == victim_pid && o.status != t::KillOutcomeStatus::Failed),
        "{mixed:?}"
    );
    // 自接続を文のみ停止の対象に含めても、スキップとして id 単位で報告され件数を狂わせない。
    let own_id = conn
        .list_processes()
        .await
        .expect("list for self")
        .into_iter()
        .find(|p| p.is_self)
        .map(|p| p.id);
    if let Some(own_id) = own_id {
        let skipped = conn
            .kill_processes(&[own_id], true)
            .await
            .expect("cancel self");
        // プールが複数の接続を持つと、kill を実行する接続と一覧を取った接続が別になりうる。
        // 同じ接続ならスキップ、別の接続なら通常の文のみ停止になる。どちらでも 1 件が id 単位で
        // 1 回だけ数えられ、件数と outcomes が食い違わないことを確かめる。
        assert_eq!(skipped.outcomes.len(), 1, "{skipped:?}");
        let was_skipped = skipped.outcomes[0].status == t::KillOutcomeStatus::Skipped;
        assert_eq!(
            skipped.killed + skipped.failed,
            if was_skipped { 0 } else { 1 },
            "{skipped:?}"
        );
    }

    // Backend teardown is asynchronous; poll briefly.
    let mut gone = false;
    for _ in 0..20 {
        let now = conn.list_processes().await.expect("list after kill");
        if !now.iter().any(|p| p.id == victim_pid) {
            gone = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    assert!(
        gone,
        "terminated backend {victim_pid} still in the process list"
    );

    victim.close().await;
    conn.close().await;
}

/// #640 — PostgreSQL の**トランザクショナル DDL** により、DDL+DML 混在バッチで
/// 後続 DML が失敗すると先行の `CREATE TABLE` も**ロールバックされる**ことを確認する。
///
/// MySQL の対比テスト (`mysql_ddl_dml_mixed_batch_is_not_atomic`) では暗黙コミットで
/// CREATE が残るのに対し、PostgreSQL では何も残らない — このドライバ差を明示する。
#[tokio::test]
async fn postgres_ddl_dml_mixed_batch_rolls_back() {
    let Ok(url) = std::env::var("NOOBDB_TEST_POSTGRES_URL") else {
        eprintln!("skip: NOOBDB_TEST_POSTGRES_URL not set");
        return;
    };
    let opts = t::parse_postgres_url(&url).expect("valid url");
    let conn = t::connect(&opts).await.expect("connect");

    // クリーンな状態から開始。
    conn.execute("DROP TABLE IF EXISTS public.ddl_dml_mixed_pg", None)
        .await
        .expect("pre-drop");

    // CREATE TABLE → 型不一致 INSERT (id は INT) で確実に失敗させる。
    let batch = vec![
        "CREATE TABLE public.ddl_dml_mixed_pg (id INT PRIMARY KEY)".to_string(),
        "INSERT INTO public.ddl_dml_mixed_pg (id) VALUES ('not-an-int')".to_string(),
    ];
    let res = conn.execute_transaction(&batch, None).await;
    assert!(
        res.is_err(),
        "後続 INSERT の失敗で execute_transaction 全体はエラーを返すはず: {res:?}"
    );

    // PostgreSQL はトランザクショナル DDL なので CREATE TABLE もロールバックされ残らない。
    let exists = conn
        .execute(
            "SELECT COUNT(*) AS n FROM information_schema.tables \
             WHERE table_schema = 'public' AND table_name = 'ddl_dml_mixed_pg'",
            None,
        )
        .await
        .expect("check table existence");
    assert!(
        matches!(&exists.rows[0][0], t::Value::Int(0)),
        "PostgreSQL では混在バッチ失敗時に CREATE TABLE もロールバックされ、テーブルは残らないはず: {:?}",
        exists.rows[0][0]
    );

    // 念のため後始末 (残っていた場合に備えて)。
    conn.execute("DROP TABLE IF EXISTS public.ddl_dml_mixed_pg", None)
        .await
        .expect("cleanup");
    conn.close().await;
}

/// ライブクエリ・インスペクタ (#746): PostgreSQL のライブテールはコア機能の
/// pg_stat_activity だけで動くため常に可。digest 集計は pg_stat_statements 拡張の
/// 有無で決まる (CI の素の postgres コンテナには入っていない) ので、不可の場合は
/// 理由コードが導入手順つきヘルプへマップ可能なものであることを確認する。
/// また、noobDB 自身の接続は application_name で識別・除外されるため、
/// テールに自アプリ由来の行や内部カタログ参照文が混ざらないことを固定する。
#[tokio::test]
async fn postgres_query_inspector_support_and_tail() {
    let Ok(url) = std::env::var("NOOBDB_TEST_POSTGRES_URL") else {
        eprintln!("skip: NOOBDB_TEST_POSTGRES_URL not set");
        return;
    };
    let opts = t::parse_postgres_url(&url).expect("valid url");
    let conn = t::connect(&opts).await.expect("connect");

    let support = conn.query_stats_support().await.expect("support probe");
    assert!(
        support.live_tail,
        "pg_stat_activity is core; live tail must be supported"
    );
    assert!(support.live_tail_reason.is_none());
    if support.statements {
        // 拡張が入っている環境ではスナップショット取得まで通ることを確認。
        let stats = conn.statement_stats().await.expect("statement stats");
        assert!(stats.iter().all(|s| {
            !s.fingerprint.contains("pg_stat_") && !s.fingerprint.contains("pg_catalog")
        }));
    } else {
        // 未導入/不可読は理由コード付きで縮退する (#587: 黙って空にしない)。
        let reason = support.statements_reason.as_deref().expect("reason code");
        assert!(
            reason == "pg_stat_statements_missing" || reason == "stats_unreadable",
            "unexpected reason code: {reason}"
        );
        assert!(
            conn.statement_stats().await.is_err(),
            "statement_stats must error when unsupported"
        );
    }

    // noobDB の全接続は application_name = "noobDB" で接続するため、
    // 自アプリ由来の行はテールから除外される。内部カタログ参照文も同様。
    let observed = t::connect(&opts).await.expect("second connect");
    observed
        .execute("SELECT 746 AS noobdb_inspector_marker", None)
        .await
        .expect("marker query");
    let tail = conn.live_queries().await.expect("live queries");
    assert!(
        tail.iter()
            .all(|q| q.application.as_deref() != Some("noobDB")),
        "rows from this app's own connections must be excluded from the tail"
    );
    assert!(
        tail.iter()
            .all(|q| !q.query.contains("noobdb_inspector_marker")),
        "the app's own marker query must be excluded via application_name"
    );
    assert!(
        tail.iter()
            .all(|q| { !q.query.contains("pg_stat_") && !q.query.contains("pg_catalog") }),
        "internal catalog statements must be excluded from the live tail"
    );

    observed.close().await;
    conn.close().await;
}

/// 監視ダッシュボード (#731): `pg_stat_activity` の状態別集計と `pg_stat_database` の
/// トランザクション累計を 1 サンプル取得できること。接続中の自分が居るので接続数は
/// 1 以上、スループット (xact 累計) も正になる。MySQL 固有の slow_queries / lock_waits
/// は PostgreSQL では None に縮退する。
#[tokio::test]
async fn postgres_server_metrics_reports_connection_and_transaction_counters() {
    let Ok(url) = std::env::var("NOOBDB_TEST_POSTGRES_URL") else {
        eprintln!("skip: NOOBDB_TEST_POSTGRES_URL not set");
        return;
    };
    let opts = t::parse_postgres_url(&url).expect("valid url");
    let conn = t::connect(&opts).await.expect("connect");

    let m = conn.server_metrics().await.expect("server_metrics");
    assert!(
        m.connections.is_some_and(|c| c >= 1),
        "client backend count must be reported and >= 1, got {:?}",
        m.connections
    );
    assert!(
        m.active.is_some_and(|a| a >= 1),
        "at least one active backend (this query) expected, got {:?}",
        m.active
    );
    assert!(
        m.max_connections.is_some_and(|c| c >= 1),
        "max_connections must be reported (#1622), got {:?}",
        m.max_connections
    );
    assert!(
        m.questions.is_some_and(|q| q >= 1),
        "xact_commit+rollback sum must be reported and >= 1, got {:?}",
        m.questions
    );
    // PostgreSQL には MySQL 相当の常設カウンタが無いので None に縮退する。
    assert!(m.slow_queries.is_none(), "slow_queries has no PG analog");
    assert!(m.lock_waits.is_none(), "lock_waits has no cheap PG analog");

    conn.close().await;
}

/// 接続ヘルス (#1259) 用の軽量な接続数取得 (client backend の `count(*)`) が自分自身を
/// 含めて 1 以上を返すこと。
#[tokio::test]
async fn postgres_connection_count_is_reported() {
    let Ok(url) = std::env::var("NOOBDB_TEST_POSTGRES_URL") else {
        eprintln!("skip: NOOBDB_TEST_POSTGRES_URL not set");
        return;
    };
    let opts = t::parse_postgres_url(&url).expect("valid url");
    let conn = t::connect(&opts).await.expect("connect");
    let n = conn.connection_count().await.expect("connection_count");
    assert!(n.is_some_and(|c| c >= 1), "client backends >= 1, got {n:?}");
    conn.close().await;
}

/// `user_privileges` の `database` (= スキーマ) 絞り込み (#1259): 存在しないスキーマ
/// を指定するとテーブル別の行は空になり、指定した場合は全行がそのスキーマのものだけになる。
#[tokio::test]
async fn postgres_user_privileges_schema_filter_narrows_rows() {
    let Ok(url) = std::env::var("NOOBDB_TEST_POSTGRES_URL") else {
        eprintln!("skip: NOOBDB_TEST_POSTGRES_URL not set");
        return;
    };
    let opts = t::parse_postgres_url(&url).expect("valid url");
    let conn = t::connect(&opts).await.expect("connect");
    let none = conn
        .user_privileges(&opts.user, None, Some("noobdb_no_such_schema"))
        .await
        .expect("filtered");
    assert!(none.tables.is_empty());
    let public = conn
        .user_privileges(&opts.user, None, Some("public"))
        .await
        .expect("public");
    assert!(public.tables.iter().all(|r| r.table.starts_with("public.")));
    conn.close().await;
}

/// 型デコードの回帰テスト: sqlx の型互換チェックでは文字列として読めない型
/// (`uuid` / 配列 / `inet` / `money` / `interval` / ユーザ定義 ENUM) が、
/// **非 NULL なのに `Value::Null` として返る**という不具合の再発防止。
/// 併せて、同じ列の SQL NULL は当然 `Value::Null` になること (NULL と非 NULL を
/// 取り違えていないこと) も確認する。
#[tokio::test]
async fn postgres_exotic_types_decode_to_values_not_null() {
    let Ok(url) = std::env::var("NOOBDB_TEST_POSTGRES_URL") else {
        eprintln!("skip: NOOBDB_TEST_POSTGRES_URL not set");
        return;
    };
    let opts = t::parse_postgres_url(&url).expect("valid url");
    let conn = t::connect(&opts).await.expect("connect");

    conn.execute("DROP TABLE IF EXISTS public.noobdb_pg_types", None)
        .await
        .expect("drop table");
    conn.execute("DROP TYPE IF EXISTS noobdb_pg_mood", None)
        .await
        .expect("drop type");
    conn.execute("CREATE TYPE noobdb_pg_mood AS ENUM ('happy', 'sad')", None)
        .await
        .expect("create enum type");
    conn.execute(
        "CREATE TABLE public.noobdb_pg_types (
            id INT PRIMARY KEY,
            u UUID,
            tags TEXT[],
            nums INT4[],
            addr INET,
            price MONEY,
            span INTERVAL,
            mood noobdb_pg_mood,
            payload JSONB,
            big BIGINT
         )",
        None,
    )
    .await
    .expect("create table");
    conn.execute(
        "INSERT INTO public.noobdb_pg_types VALUES (
            1,
            '11111111-2222-3333-4444-555555555555'::uuid,
            ARRAY['a', 'b,c', NULL]::text[],
            ARRAY[1, 2, 3]::int4[],
            '192.168.1.5'::inet,
            12.34::money,
            INTERVAL '1 year 2 mons 3 days 04:05:06.789',
            'happy'::noobdb_pg_mood,
            '{\"b\": 1, \"a\": 2}'::jsonb,
            9007199254740993
         ), (
            2, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
         )",
        None,
    )
    .await
    .expect("insert");

    let res = conn
        .execute(
            "SELECT u, tags, nums, addr, price, span, mood, payload, big
             FROM public.noobdb_pg_types WHERE id = 1",
            None,
        )
        .await
        .expect("select typed row");
    assert_eq!(res.rows.len(), 1);
    let row = &res.rows[0];

    // どの列も NULL であってはならない (これが本丸の回帰点)。
    for (i, name) in [
        "uuid", "text[]", "int4[]", "inet", "money", "interval", "enum", "jsonb", "bigint",
    ]
    .iter()
    .enumerate()
    {
        assert!(
            !matches!(&row[i], t::Value::Null),
            "column {name} decoded to NULL despite holding a value: {:?}",
            row[i]
        );
    }

    assert!(
        matches!(&row[0], t::Value::String(s) if s == "11111111-2222-3333-4444-555555555555"),
        "uuid must decode to its canonical text form, got {:?}",
        row[0]
    );
    // 配列は PostgreSQL の配列リテラル表記。区切り文字を含む要素は引用され、
    // 要素の NULL は `NULL` として表れる。
    assert!(
        matches!(&row[1], t::Value::String(s) if s == "{a,\"b,c\",NULL}"),
        "text[] must decode to an array literal, got {:?}",
        row[1]
    );
    assert!(
        matches!(&row[2], t::Value::String(s) if s == "{1,2,3}"),
        "int4[] must decode to an array literal, got {:?}",
        row[2]
    );
    assert!(
        matches!(&row[3], t::Value::String(s) if s == "192.168.1.5"),
        "inet must decode to its text form, got {:?}",
        row[3]
    );
    assert!(
        matches!(&row[4], t::Value::String(s) if s == "12.34"),
        "money must decode to a plain decimal, got {:?}",
        row[4]
    );
    assert!(
        matches!(&row[5], t::Value::String(s) if s == "1 year 2 mons 3 days 04:05:06.789"),
        "interval must decode to PostgreSQL-style text, got {:?}",
        row[5]
    );
    assert!(
        matches!(&row[6], t::Value::String(s) if s == "happy"),
        "user-defined enum must decode to its label, got {:?}",
        row[6]
    );
    // JSONB のキー順はサーバが返したまま (再シリアライズで辞書順に
    // 並べ替えない)。PostgreSQL の jsonb 自身はキーを長さ→バイト順で
    // 正規化するので、`{"b": 1, "a": 2}` は `{"a": 2, "b": 1}` として
    // 保存される — 検証したいのは「サーバの出力と一致すること」。
    let server_text = conn
        .execute(
            "SELECT payload::text FROM public.noobdb_pg_types WHERE id = 1",
            None,
        )
        .await
        .expect("select jsonb as text");
    let expected_json = match &server_text.rows[0][0] {
        t::Value::String(s) => s.clone(),
        other => panic!("jsonb::text must come back as a string: {other:?}"),
    };
    assert!(
        matches!(&row[7], t::Value::String(s) if *s == expected_json),
        "jsonb must be returned verbatim ({expected_json}), got {:?}",
        row[7]
    );
    // 2^53 を超える bigint は丸めを避けるため十進文字列で届く。
    assert!(
        matches!(&row[8], t::Value::String(s) if s == "9007199254740993"),
        "bigint beyond 2^53 must be a decimal string, got {:?}",
        row[8]
    );

    // 同じ列の SQL NULL はきちんと Null になること。
    let nulls = conn
        .execute(
            "SELECT u, tags, nums, addr, price, span, mood, payload, big
             FROM public.noobdb_pg_types WHERE id = 2",
            None,
        )
        .await
        .expect("select null row");
    assert!(
        nulls.rows[0].iter().all(|v| matches!(v, t::Value::Null)),
        "every SQL NULL must decode to Value::Null: {:?}",
        nulls.rows[0]
    );

    // 安全整数の境界: 2^53 - 1 までは数値のまま。
    let boundary = conn
        .execute("SELECT 9007199254740991::bigint", None)
        .await
        .expect("boundary select");
    assert!(
        matches!(&boundary.rows[0][0], t::Value::Int(9_007_199_254_740_991)),
        "the largest safe integer must stay a JSON number, got {:?}",
        boundary.rows[0][0]
    );

    conn.execute("DROP TABLE public.noobdb_pg_types", None)
        .await
        .expect("cleanup table");
    conn.execute("DROP TYPE noobdb_pg_mood", None)
        .await
        .expect("cleanup type");
    conn.close().await;
}

/// ドライランプレビューが「PK 昇順の先頭 N 件」の窓の外を更新する UPDATE でも
/// before/after を捉えること。以前の PostgreSQL 実装は常に
/// `SELECT * FROM t ORDER BY pk LIMIT n+1` を撮っていたため、窓の外の行を
/// 更新すると before/after が同一になり「変更なし」に見えていた。
#[tokio::test]
async fn postgres_preview_captures_rows_outside_the_default_window() {
    let Ok(url) = std::env::var("NOOBDB_TEST_POSTGRES_URL") else {
        eprintln!("skip: NOOBDB_TEST_POSTGRES_URL not set");
        return;
    };
    let opts = t::parse_postgres_url(&url).expect("valid url");
    let conn = t::connect(&opts).await.expect("connect");

    conn.execute("DROP TABLE IF EXISTS public.noobdb_pg_preview", None)
        .await
        .expect("drop");
    conn.execute(
        "CREATE TABLE public.noobdb_pg_preview (id INT PRIMARY KEY, label TEXT NOT NULL)",
        None,
    )
    .await
    .expect("create");
    conn.execute(
        "INSERT INTO public.noobdb_pg_preview
         SELECT g, 'row-' || g FROM generate_series(1, 50) g",
        None,
    )
    .await
    .expect("seed");

    // row_limit = 3 → 従来の固定窓は id 1..3 しか映さない。id = 40 は窓の外。
    let preview = conn
        .preview_execute_with_limit(
            "UPDATE public.noobdb_pg_preview SET label = 'changed' WHERE id = 40",
            None,
            3,
        )
        .await
        .expect("preview");
    assert_eq!(preview.rows_affected, 1);
    assert_eq!(preview.primary_key, vec!["id".to_string()]);
    assert_eq!(
        preview.before_rows.len(),
        1,
        "BEFORE must be filtered by the user's WHERE, got {:?}",
        preview.before_rows
    );
    assert_eq!(
        preview.after_rows.len(),
        1,
        "AFTER must be refetched by the captured PK, got {:?}",
        preview.after_rows
    );
    let label_index = preview
        .columns
        .iter()
        .position(|c| c.name == "label")
        .expect("label column");
    assert!(
        matches!(&preview.before_rows[0][label_index], t::Value::String(s) if s == "row-40"),
        "BEFORE must show the pre-update value: {:?}",
        preview.before_rows[0]
    );
    assert!(
        matches!(&preview.after_rows[0][label_index], t::Value::String(s) if s == "changed"),
        "AFTER must show the updated value: {:?}",
        preview.after_rows[0]
    );

    // プレビューは必ずロールバックする。
    let live = conn
        .execute(
            "SELECT label FROM public.noobdb_pg_preview WHERE id = 40",
            None,
        )
        .await
        .expect("post-preview select");
    assert!(
        matches!(&live.rows[0][0], t::Value::String(s) if s == "row-40"),
        "preview must not persist: {:?}",
        live.rows[0]
    );

    // WHERE が更新対象の列そのものを絞るケース (実行後は WHERE に一致しなく
    // なる) でも、AFTER は BEFORE の PK でアンカーされているので行が消えない。
    let flip = conn
        .preview_execute_with_limit(
            "UPDATE public.noobdb_pg_preview SET label = 'flipped' WHERE label = 'row-45'",
            None,
            3,
        )
        .await
        .expect("preview flip");
    assert_eq!(flip.rows_affected, 1);
    assert_eq!(flip.before_rows.len(), 1);
    assert_eq!(
        flip.after_rows.len(),
        1,
        "PK-anchored AFTER must keep the row visible: {:?}",
        flip.after_rows
    );

    conn.execute("DROP TABLE public.noobdb_pg_preview", None)
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

    // 事前検証 (#1612): 主キーに一致するキーは通り、一意キーでない列は取り込み前に拒否される。
    let ok_key = t::ImportConflict {
        mode: t::ConflictMode::Update,
        key_columns: vec!["id".to_string()],
    };
    conn.check_upsert_keys(None, table, &columns, &ok_key)
        .await
        .expect("primary key matches");
    let bad_key = t::ImportConflict {
        mode: t::ConflictMode::Update,
        key_columns: vec!["name".to_string()],
    };
    let err = conn
        .check_upsert_keys(None, table, &columns, &bad_key)
        .await
        .expect_err("non-unique key must be rejected before importing");
    assert!(err.to_string().contains("PRIMARY or UNIQUE"), "{err}");
}

#[tokio::test]
async fn postgres_upsert_import_roundtrip() {
    let Ok(url) = std::env::var("NOOBDB_TEST_POSTGRES_URL") else {
        eprintln!("skip: NOOBDB_TEST_POSTGRES_URL not set");
        return;
    };
    let opts = t::parse_postgres_url(&url).expect("valid url");
    let conn = t::connect(&opts).await.expect("connect");
    conn.execute("DROP TABLE IF EXISTS noobdb_pg_upsert", None)
        .await
        .expect("drop");
    conn.execute(
        "CREATE TABLE noobdb_pg_upsert (id INT PRIMARY KEY, name TEXT NOT NULL)",
        None,
    )
    .await
    .expect("create");
    conn.execute(
        "INSERT INTO noobdb_pg_upsert VALUES (1, 'a'), (2, 'b')",
        None,
    )
    .await
    .expect("seed");
    assert_upsert_roundtrip(&conn, "noobdb_pg_upsert").await;
    conn.execute("DROP TABLE noobdb_pg_upsert", None)
        .await
        .expect("cleanup");
}

/// ルーチンのシグネチャ取得 (#1003) と、生成される呼び出し SQL の形 (`CALL` で
/// OUT/INOUT が 1 行返る / `SELECT * FROM fn(...)`) が既存のストリーミング実行経路で
/// 結果を返すことを確認する。
#[tokio::test]
async fn postgres_routine_signature_and_call_when_env_set() {
    let Ok(url) = std::env::var("NOOBDB_TEST_POSTGRES_URL") else {
        eprintln!("skip: NOOBDB_TEST_POSTGRES_URL not set");
        return;
    };
    let opts = t::parse_postgres_url(&url).expect("valid url");
    let conn = t::connect(&opts).await.expect("connect");
    for stmt in [
        "DROP FUNCTION IF EXISTS public.noobdb_rt_fn(integer, text)",
        "DROP PROCEDURE IF EXISTS public.noobdb_rt_proc(integer, integer, integer)",
    ] {
        let _ = conn.execute(stmt, None).await;
    }
    conn.execute(
        "CREATE FUNCTION public.noobdb_rt_fn(a integer, b text, OUT total integer, OUT label text) \
         LANGUAGE sql AS $$ SELECT a * 2, b || '!' $$",
        None,
    )
    .await
    .expect("create function");
    conn.execute(
        "CREATE PROCEDURE public.noobdb_rt_proc(IN a integer, INOUT b integer, OUT c integer) \
         LANGUAGE plpgsql AS $$ BEGIN b := b + a; c := a * 10; END $$",
        None,
    )
    .await
    .expect("create procedure (PG14+ OUT)");

    let sig = conn
        .routine_signature("public", "function", "noobdb_rt_fn", None)
        .await
        .expect("function signature");
    let modes: Vec<(&str, &str, &str)> = sig
        .parameters
        .iter()
        .map(|p| (p.name.as_str(), p.mode.as_str(), p.data_type.as_str()))
        .collect();
    assert_eq!(
        modes,
        vec![
            ("a", "in", "integer"),
            ("b", "in", "text"),
            ("total", "out", "integer"),
            ("label", "out", "text"),
        ]
    );

    let psig = conn
        .routine_signature("public", "procedure", "noobdb_rt_proc", None)
        .await
        .expect("procedure signature");
    let pmodes: Vec<&str> = psig.parameters.iter().map(|p| p.mode.as_str()).collect();
    assert_eq!(pmodes, vec!["in", "inout", "out"]);
    assert_eq!(psig.return_type, None);

    // CALL は fetch 経路に流れ、OUT / INOUT の値が 1 行で返る。
    let mut rows: Vec<Vec<t::Value>> = Vec::new();
    conn.execute_stream(
        r#"CALL "public"."noobdb_rt_proc"(CAST(2 AS integer), CAST(5 AS integer), CAST(NULL AS integer))"#,
        None,
        100,
        100,
        |b| {
            if let t::StreamBatch::Rows(r) = b {
                rows.extend(r);
            }
            Ok(())
        },
    )
    .await
    .expect("call procedure");
    assert_eq!(rows.len(), 1, "CALL returns the OUT/INOUT row: {rows:?}");

    let mut frows: Vec<Vec<t::Value>> = Vec::new();
    conn.execute_stream(
        r#"SELECT * FROM "public"."noobdb_rt_fn"(CAST(3 AS integer), CAST('x' AS text))"#,
        None,
        100,
        100,
        |b| {
            if let t::StreamBatch::Rows(r) = b {
                frows.extend(r);
            }
            Ok(())
        },
    )
    .await
    .expect("select function");
    assert_eq!(frows.len(), 1);

    for stmt in [
        "DROP FUNCTION IF EXISTS public.noobdb_rt_fn(integer, text)",
        "DROP PROCEDURE IF EXISTS public.noobdb_rt_proc(integer, integer, integer)",
    ] {
        let _ = conn.execute(stmt, None).await;
    }
    conn.close().await;
}

/// データ品質アサーション (#742): 6 種の初期ルールを read-only セッションで実行し、
/// 違反件数と pass/fail を実データで確かめる (SQLite 版と同じシナリオ)。
#[tokio::test]
async fn postgres_data_quality_assertions_on_read_only_session() {
    let Ok(url) = std::env::var("NOOBDB_TEST_POSTGRES_URL") else {
        eprintln!("skip: NOOBDB_TEST_POSTGRES_URL not set");
        return;
    };
    let opts = t::parse_postgres_url(&url).expect("valid url");
    let seed = t::connect(&opts).await.expect("connect (seed)");
    for sql in [
        "DROP TABLE IF EXISTS noobdb_aq_items",
        "DROP TABLE IF EXISTS noobdb_aq_orders",
        "CREATE TABLE noobdb_aq_orders (id INT PRIMARY KEY)",
        "CREATE TABLE noobdb_aq_items (id INT PRIMARY KEY, order_id INT, email VARCHAR(64), status VARCHAR(16), qty INT)",
        "INSERT INTO noobdb_aq_orders (id) VALUES (1), (2)",
        "INSERT INTO noobdb_aq_items VALUES (1, 1, 'a@x', 'active', 5), (2, 2, 'b@x', 'banned', 10), \
         (3, 9, NULL, 'weird', 500), (4, NULL, 'a@x', 'active', 1)",
    ] {
        seed.execute(sql, None).await.expect(sql);
    }

    let conn = t::connect(&opts).await.expect("connect (read-only)");
    let state = t::AppState::default();
    let sid = state
        .insert(t::make_session("aq_ro", conn, opts.clone(), true))
        .await;

    use t::AssertionRule as R;
    let mk = |id: &str, rule: R| t::Assertion {
        id: id.into(),
        name: id.into(),
        scope: t::SnippetScope::Any,
        schema: None,
        table: "noobdb_aq_items".into(),
        rule,
    };
    let cases = vec![
        (
            mk(
                "nn",
                R::NotNull {
                    column: "email".into(),
                },
            ),
            false,
            1,
        ),
        (
            mk(
                "uq",
                R::Unique {
                    columns: vec!["email".into()],
                },
            ),
            false,
            1,
        ),
        (
            mk(
                "av",
                R::AcceptedValues {
                    column: "status".into(),
                    values: vec!["active".into(), "banned".into()],
                },
            ),
            false,
            1,
        ),
        (
            mk(
                "rg",
                R::Range {
                    column: "qty".into(),
                    min: Some("1".into()),
                    max: Some("100".into()),
                },
            ),
            false,
            1,
        ),
        (
            mk(
                "rf",
                R::Referential {
                    columns: vec!["order_id".into()],
                    ref_schema: None,
                    ref_table: "noobdb_aq_orders".into(),
                    ref_columns: vec!["id".into()],
                },
            ),
            false,
            1,
        ),
        (
            mk(
                "rc",
                R::RowCount {
                    op: t::RowCountOp::Gt,
                    value: 0,
                    max: None,
                },
            ),
            true,
            4,
        ),
    ];
    for (a, passed, observed) in &cases {
        let out = t::run_assertion_via_command(&state, &sid, a, None, Some(30))
            .await
            .unwrap_or_else(|e| panic!("{}: {e}", a.id));
        assert_eq!(out.passed, *passed, "{}: {}", a.id, out.check_sql);
        assert_eq!(out.observed, *observed, "{}: {}", a.id, out.check_sql);
        t::run_query_via_command(&state, &sid, &out.violations_sql, None)
            .await
            .unwrap_or_else(|e| panic!("{} violations: {e}", a.id));
    }

    // accepted_values の候補 (#1621): DISTINCT を読み取り専用セッションで取得できる。
    // NULL は除かれ、列の型どおりの昇順に並ぶ。
    let status = t::suggest_accepted_values_via_command(
        &state,
        &sid,
        None,
        "noobdb_aq_items",
        "status",
        None,
    )
    .await
    .expect("distinct status");
    assert_eq!(status.values, ["active", "banned", "weird"]);
    assert!(!status.truncated);
    let email = t::suggest_accepted_values_via_command(
        &state,
        &sid,
        None,
        "noobdb_aq_items",
        "email",
        None,
    )
    .await
    .expect("distinct email");
    assert_eq!(email.values, ["a@x", "b@x"]);
    let qty =
        t::suggest_accepted_values_via_command(&state, &sid, None, "noobdb_aq_items", "qty", None)
            .await
            .expect("distinct qty");
    assert_eq!(qty.values, ["1", "5", "10", "500"]);

    for sql in [
        "DROP TABLE IF EXISTS noobdb_aq_items",
        "DROP TABLE IF EXISTS noobdb_aq_orders",
    ] {
        seed.execute(sql, None).await.expect(sql);
    }
}

/// #1259: 構造化セル編集 (`bulk_update_cells`)・テストデータ投入 (`insert_generated_rows`)・
/// 接続ヘルス (`health_probe_all`) を実 PostgreSQL で通す。IN チャンク / 複合 PK / NULL を含む PK の
/// UPDATE が方言どおりに解釈され、生成行の真偽・NULL・数値が列型へ強制変換されることを確認する。
#[tokio::test]
async fn postgres_bulk_write_and_health_probe_commands() {
    let Ok(url) = std::env::var("NOOBDB_TEST_POSTGRES_URL") else {
        eprintln!("skip: NOOBDB_TEST_POSTGRES_URL not set");
        return;
    };
    let opts = t::parse_postgres_url(&url).expect("valid url");
    let conn = t::connect(&opts).await.expect("connect");
    let db = "public".to_string();
    let items = format!("noobdb_bulk1259_items_{}", std::process::id());
    let pairs = format!("noobdb_bulk1259_pairs_{}", std::process::id());
    let gen = format!("noobdb_bulk1259_gen_{}", std::process::id());
    for tbl in [&items, &pairs, &gen] {
        let _ = conn
            .execute(&format!("DROP TABLE IF EXISTS {tbl}"), Some(&db))
            .await;
    }
    conn.execute(
        &format!("CREATE TABLE {items} (id BIGINT PRIMARY KEY, name VARCHAR(50), n INT)"),
        Some(&db),
    )
    .await
    .expect("create items");
    conn.execute(
        &format!("CREATE TABLE {pairs} (a INT NOT NULL, b VARCHAR(10) NOT NULL, n INT)"),
        Some(&db),
    )
    .await
    .expect("create pairs");
    conn.execute(
        &format!("CREATE TABLE {gen} (id INT PRIMARY KEY, label VARCHAR(40) NOT NULL, flag BOOLEAN, score DOUBLE PRECISION, note VARCHAR(20))"),
        Some(&db),
    )
    .await
    .expect("create gen");
    let values = (1..=1100)
        .map(|i| format!("({i}, 'old', {i})"))
        .collect::<Vec<_>>()
        .join(", ");
    conn.execute(&format!("INSERT INTO {items} VALUES {values}"), Some(&db))
        .await
        .expect("seed items");
    conn.execute(
        &format!("INSERT INTO {pairs} VALUES (1, 'x', 0), (1, 'y', 0), (2, 'z', 0)"),
        Some(&db),
    )
    .await
    .expect("seed pairs");

    let session = t::make_session("bulk_real", conn, opts.clone(), /* read_only */ false);
    let state = t::AppState::default();
    let sid = state.insert(session).await;
    let text = |c: &str, v: &str| t::BulkSetColumn {
        column: c.into(),
        value: t::BulkSetValue::Text { text: v.into() },
    };
    let num = |c: &str, v: &str| t::BulkSetColumn {
        column: c.into(),
        value: t::BulkSetValue::Number { text: v.into() },
    };

    // 単一 PK の IN チャンク (1100 件 = 500 + 500 + 100) + 別グループ。文字列は引用リテラル。
    let keys: Vec<Vec<t::Value>> = (1..=1100).map(|i| vec![t::Value::Int(i)]).collect();
    let res = t::bulk_update_cells_via_command(
        &state,
        &sid,
        Some(&db),
        &items,
        vec!["id".into()],
        vec![
            t::BulkUpdateGroup {
                set: vec![text("name", "it's a \\ test"), num("n", "-7")],
                keys: keys[..1099].to_vec(),
            },
            t::BulkUpdateGroup {
                set: vec![text("name", "last")],
                keys: keys[1099..].to_vec(),
            },
        ],
        vec![],
    )
    .await
    .expect("bulk update items");
    assert_eq!(res.rows_affected, 1100);
    let s = state.get(&sid).await.expect("session");
    let r = s
        .conn
        .execute(
            &format!(
                "SELECT count(*) FROM {items} WHERE name = 'last' OR (n = -7 AND name IS NOT NULL)"
            ),
            Some(&db),
        )
        .await
        .expect("verify");
    assert!(
        matches!(&r.rows[0][0], t::Value::Int(1100)),
        "{:?}",
        r.rows[0]
    );
    let r = s
        .conn
        .execute(&format!("SELECT name FROM {items} WHERE id = 1"), Some(&db))
        .await
        .expect("verify escaped text");
    assert!(
        matches!(&r.rows[0][0], t::Value::String(v) if v == "it's a \\ test"),
        "{:?}",
        r.rows[0]
    );

    // 複合 PK。
    let res = t::bulk_update_cells_via_command(
        &state,
        &sid,
        Some(&db),
        &pairs,
        vec!["a".into(), "b".into()],
        vec![t::BulkUpdateGroup {
            set: vec![num("n", "9")],
            keys: vec![
                vec![t::Value::Int(1), t::Value::String("y".into())],
                vec![t::Value::Int(2), t::Value::String("z".into())],
            ],
        }],
        vec![],
    )
    .await
    .expect("bulk update pairs");
    assert_eq!(res.rows_affected, 2);

    // 生成行の投入: 真偽 / NULL / 数値 / 文字列が列型へ強制変換され、途中失敗で全件ロールバック。
    let cols: Vec<String> = ["id", "label", "flag", "score", "note"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    let rows: Vec<Vec<serde_json::Value>> = (1..=250)
        .map(|i| {
            vec![
                serde_json::json!(i),
                serde_json::json!(format!("o'brien \\ {i}")),
                serde_json::json!(i % 2 == 0),
                serde_json::json!(i as f64 + 0.25),
                serde_json::Value::Null,
            ]
        })
        .collect();
    let ins = t::insert_generated_rows_via_command(&state, &sid, Some(&db), &gen, &cols, &rows)
        .await
        .expect("insert generated");
    assert_eq!(ins.inserted, 250);
    let r = s
        .conn
        .execute(
            &format!("SELECT count(*), count(note), min(label) FROM {gen}"),
            Some(&db),
        )
        .await
        .expect("verify generated");
    assert!(
        matches!(&r.rows[0][0], t::Value::Int(250)),
        "{:?}",
        r.rows[0]
    );
    assert!(matches!(&r.rows[0][1], t::Value::Int(0)), "{:?}", r.rows[0]);
    let mut dup = rows.clone();
    dup.push(rows[0].clone()); // 主キー重複で失敗する。
    assert!(
        t::insert_generated_rows_via_command(&state, &sid, Some(&db), &gen, &cols, &dup)
            .await
            .is_err()
    );
    let r = s
        .conn
        .execute(&format!("SELECT count(*) FROM {gen}"), Some(&db))
        .await
        .expect("count after failed insert");
    assert!(
        matches!(&r.rows[0][0], t::Value::Int(250)),
        "{:?}",
        r.rows[0]
    );

    // 接続ヘルス: 生きている接続は up + バージョン + 接続数、未知のセッションは down。
    let probe =
        t::health_probe_all_inner(&state, &[sid.clone(), "nope".to_string()], 5_000, false).await;
    assert_eq!(probe[0].status, t::HealthProbeStatus::Up);
    assert!(probe[0].latency_ms.is_some());
    assert!(probe[0].version.as_deref().is_some_and(|v| !v.is_empty()));
    assert!(
        probe[0].connections.is_some_and(|c| c >= 1),
        "{:?}",
        probe[0]
    );
    assert_eq!(probe[1].status, t::HealthProbeStatus::Down);

    for tbl in [&items, &pairs, &gen] {
        let _ = s
            .conn
            .execute(&format!("DROP TABLE IF EXISTS {tbl}"), Some(&db))
            .await;
    }
}

/// `columns_for_database` / `indexes_for_database` (#1255) は、テーブルごとの
/// `columns` / `list_indexes` を並べたものと同じ結果でなければならない。
async fn assert_bulk_matches_per_table(conn: &t::Connection, db: &str) {
    let bulk_columns = conn.columns_for_database(db).await.expect("columns bulk");
    let bulk_indexes = conn.indexes_for_database(db).await.expect("indexes bulk");
    let tables = conn.tables(db).await.expect("tables");
    assert!(!tables.is_empty());
    for table in &tables {
        let single = conn.columns(db, table).await.expect("columns");
        let bulk = bulk_columns
            .iter()
            .find(|t| &t.name == table)
            .map(|t| t.columns.clone())
            .unwrap_or_default();
        assert_eq!(
            format!("{single:?}"),
            format!("{bulk:?}"),
            "columns of {table} must match the per-table query"
        );
        let single = conn.list_indexes(db, table).await.expect("indexes");
        let bulk = bulk_indexes
            .iter()
            .find(|t| &t.name == table)
            .map(|t| t.indexes.clone())
            .unwrap_or_default();
        assert_eq!(
            format!("{single:?}"),
            format!("{bulk:?}"),
            "indexes of {table} must match the per-table query"
        );
    }
    // 一括取得にだけ現れるテーブルは無い。
    for t in &bulk_columns {
        assert!(tables.contains(&t.name), "unexpected table {}", t.name);
    }
    for t in &bulk_indexes {
        assert!(!t.indexes.is_empty(), "{} has no indexes", t.name);
    }
}

#[tokio::test]
async fn postgres_bulk_columns_and_indexes_match_per_table_queries() {
    let Ok(url) = std::env::var("NOOBDB_TEST_POSTGRES_URL") else {
        eprintln!("skip: NOOBDB_TEST_POSTGRES_URL not set");
        return;
    };
    let opts = t::parse_postgres_url(&url).expect("valid url");
    let conn = t::connect(&opts).await.expect("connect");

    // 同じ DB を他のテストが並列に DROP / CREATE するため、比較対象は専用スキーマに
    // 閉じる (public を丸ごと比べると、取得の合間にテーブルが消えて競合する)。
    let schema = format!("noobdb_bulk_{}", std::process::id());
    conn.execute(&format!("DROP SCHEMA IF EXISTS {schema} CASCADE"), None)
        .await
        .expect("drop schema");
    for ddl in [
        format!("CREATE SCHEMA {schema}"),
        format!("CREATE TABLE {schema}.bulk_parent (id integer PRIMARY KEY, name varchar(40))"),
        format!("COMMENT ON COLUMN {schema}.bulk_parent.name IS 'nm'"),
        format!(
            "CREATE TABLE {schema}.bulk_child (
                id integer PRIMARY KEY,
                pid integer NOT NULL DEFAULT 1 REFERENCES {schema}.bulk_parent (id),
                extra numeric(10,2),
                UNIQUE (extra)
            )"
        ),
        format!("CREATE INDEX bulk_child_multi ON {schema}.bulk_child (pid, extra)"),
        // 配列・enum・uuid・inet・money・interval・jsonb など多様な型も単一版と一致すること。
        format!("CREATE TYPE {schema}.bulk_mood AS ENUM ('sad', 'ok')"),
        format!(
            "CREATE TABLE {schema}.bulk_types (
                id integer PRIMARY KEY, u uuid, tags text[], nums integer[], addr inet,
                price money, span interval, mood {schema}.bulk_mood, payload jsonb, big bigint
            )"
        ),
    ] {
        conn.execute(&ddl, None).await.expect(&ddl);
    }

    assert_bulk_matches_per_table(&conn, &schema).await;

    conn.execute(&format!("DROP SCHEMA {schema} CASCADE"), None)
        .await
        .expect("cleanup schema");
    conn.close().await;
}

/// #1257: バッチ合流 (`StreamBatcher`) と逐次統計 (`StreamStats`) を実 PostgreSQL の
/// `execute_stream` に通す。NUMERIC は文字列で届くので数値判定 (`toNumber` 互換) の
/// 実地確認にもなる。テーブル名は `stream_batch_1257` 固定で、実行後に DROP する。
#[tokio::test]
async fn postgres_stream_coalescing_and_stats() {
    let Ok(url) = std::env::var("NOOBDB_TEST_POSTGRES_URL") else {
        eprintln!("skip: NOOBDB_TEST_POSTGRES_URL not set");
        return;
    };
    let opts = t::parse_postgres_url(&url).expect("valid url");
    let conn = t::connect(&opts).await.expect("connect");

    conn.execute("DROP TABLE IF EXISTS public.stream_batch_1257", None)
        .await
        .expect("drop");
    conn.execute(
        "CREATE TABLE public.stream_batch_1257 (id INT PRIMARY KEY, name TEXT, amount NUMERIC(10,1))",
        None,
    )
    .await
    .expect("create");
    conn.execute(
        "INSERT INTO public.stream_batch_1257 \
         SELECT g, 'n' || g, CASE WHEN g % 10 = 0 THEN NULL ELSE (g % 97) + 0.5 END \
         FROM generate_series(1, 900) g",
        None,
    )
    .await
    .expect("seed");

    let mut batcher = t::StreamBatcher::new(100);
    let mut stats = t::StreamStats::new();
    let mut sent: Vec<usize> = Vec::new();
    let res = conn
        .execute_stream(
            "SELECT * FROM public.stream_batch_1257 ORDER BY id",
            None,
            100,
            100,
            |batch| {
                if let t::StreamBatch::Rows(rows) = batch {
                    if let Some(out) = batcher.push(rows, std::time::Instant::now()) {
                        stats.observe(&out);
                        sent.push(out.len());
                    }
                }
                Ok(())
            },
        )
        .await
        .expect("stream");
    if let Some(rest) = batcher.finish() {
        stats.observe(&rest);
        sent.push(rest.len());
    }

    assert_eq!(res.rows_affected, 900);
    assert_eq!(sent.iter().sum::<usize>(), 900);
    assert_eq!(sent[0], 100, "初回バッチは即送信");
    assert!(sent.len() < 9, "9 回のドライババッチが合流される: {sent:?}");
    let snap = stats.snapshot();
    assert_eq!(snap.row_count, 900);
    assert_eq!(snap.null_counts[2], 90);
    assert_eq!(snap.num_min[0], Some(1.0));
    assert_eq!(snap.num_max[0], Some(900.0));
    assert_eq!(snap.num_min[2], Some(0.5));
    assert_eq!(snap.num_max[2], Some(96.5));
    assert_eq!(snap.num_min[1], None);
    assert_eq!(snap.duplicate_rows, Some(false));

    conn.execute("DROP TABLE public.stream_batch_1257", None)
        .await
        .expect("cleanup");
    conn.close().await;
}

/// BLOB セルの probe / 生バイト取得 (#1258)。実 DB で長さ関数と先頭 16 バイトの
/// 部分取得 SQL が動き、種別判定とサイズが正しいことを確認する。
#[tokio::test]
async fn postgres_cell_blob_probe_and_fetch() {
    let Ok(url) = std::env::var("NOOBDB_TEST_POSTGRES_URL") else {
        eprintln!("skip: NOOBDB_TEST_POSTGRES_URL not set");
        return;
    };
    let opts = t::parse_postgres_url(&url).expect("valid url");
    let conn = t::connect(&opts).await.expect("connect");
    let session = t::make_session("s-blob", conn, opts.clone(), false);
    let db: Option<&str> = Some("public");
    session
        .conn
        .execute("DROP TABLE IF EXISTS cell_blob_probe_t", db)
        .await
        .expect("drop");
    session
        .conn
        .execute(
            "CREATE TABLE cell_blob_probe_t (id INT PRIMARY KEY, data BYTEA)",
            db,
        )
        .await
        .expect("create");
    let png: Vec<u8> = [
        &[0x89u8, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a][..],
        &[0u8; 100][..],
    ]
    .concat();
    let hex: String = png.iter().map(|b| format!("{b:02x}")).collect();
    let big = "00".repeat(40_000);
    for sql in [
        format!("INSERT INTO cell_blob_probe_t VALUES (1, '\\x{hex}')"),
        "INSERT INTO cell_blob_probe_t VALUES (2, '\\x')".to_string(),
        "INSERT INTO cell_blob_probe_t VALUES (3, NULL)".to_string(),
        format!("INSERT INTO cell_blob_probe_t VALUES (5, '\\x{big}')"),
    ] {
        session.conn.execute(&sql, db).await.expect("insert");
    }
    let key = |id: i64| serde_json::json!([{ "column": "id", "value": id }]);

    let p = t::probe_cell_blob_via_session(&session, db, "cell_blob_probe_t", "data", key(1))
        .await
        .expect("png")
        .expect("not null");
    assert_eq!(p.size, png.len() as u64);
    assert_eq!(p.mime.as_deref(), Some("image/png"));
    assert!(p.image);
    let bytes = t::fetch_cell_blob_via_session(&session, db, "cell_blob_probe_t", "data", key(1))
        .await
        .expect("fetch")
        .expect("not null");
    assert_eq!(bytes, png);

    let p = t::probe_cell_blob_via_session(&session, db, "cell_blob_probe_t", "data", key(2))
        .await
        .expect("empty")
        .expect("empty is not null");
    assert_eq!((p.size, p.mime, p.image), (0, None, false));

    assert!(
        t::probe_cell_blob_via_session(&session, db, "cell_blob_probe_t", "data", key(3))
            .await
            .expect("null")
            .is_none()
    );
    assert!(
        t::fetch_cell_blob_via_session(&session, db, "cell_blob_probe_t", "data", key(3))
            .await
            .expect("null")
            .is_none()
    );

    let p = t::probe_cell_blob_via_session(&session, db, "cell_blob_probe_t", "data", key(5))
        .await
        .expect("big")
        .expect("not null");
    assert_eq!(p.size, 40_000);

    session
        .conn
        .execute("DROP TABLE cell_blob_probe_t", db)
        .await
        .expect("cleanup");
}

// ── スキーマドリフト / 実行計画ウォッチ (#1260) ──

/// #1260: スキーマドリフトのキャプチャ (`capture_payload`) は、テーブルごとの
/// `columns` / `list_indexes` を並べたものと同じ内容でなければならない。
async fn assert_drift_capture_matches_per_table(
    conn: &t::Connection,
    db: &str,
) -> t::DriftSnapshotPayload {
    let payload = t::capture_drift_payload(conn, db).await.expect("capture");
    let tables = conn.tables(db).await.expect("tables");
    assert!(!payload.tables.is_empty());
    for table in &payload.tables {
        assert!(
            tables.contains(&table.name),
            "unexpected table {}",
            table.name
        );
        let cols = conn.columns(db, &table.name).await.expect("columns");
        assert_eq!(
            format!("{:?}", table.columns),
            format!("{cols:?}"),
            "columns of {} must match the per-table query",
            table.name
        );
        let idx = conn.list_indexes(db, &table.name).await.expect("indexes");
        assert_eq!(
            format!("{:?}", table.indexes),
            format!("{idx:?}"),
            "indexes of {} must match the per-table query",
            table.name
        );
    }
    let names: Vec<&str> = payload.tables.iter().map(|x| x.name.as_str()).collect();
    let mut sorted = names.clone();
    sorted.sort_unstable();
    assert_eq!(names, sorted, "tables are normalized to name order");
    payload
}

/// #1260: 列とインデックスの追加がフィンガープリントとサマリに現れ、何も変えなければ
/// フィンガープリントが安定する。
fn assert_drift_summary_after_alter(
    before: &t::DriftSnapshotPayload,
    after: &t::DriftSnapshotPayload,
    table: &str,
) {
    assert_ne!(
        t::fingerprint_drift_payload(before).expect("fp"),
        t::fingerprint_drift_payload(after).expect("fp"),
        "an ALTER must change the fingerprint"
    );
    let summary = t::summarize_drift(before, after);
    let changed = summary
        .tables
        .iter()
        .find(|c| c.table == table)
        .expect("altered table is reported");
    assert_eq!(changed.columns_added, 1);
    assert_eq!(changed.indexes_added, 1);
    assert_eq!(
        summary.tables.len(),
        1,
        "only the altered table is reported"
    );
}

/// #1260: 実 DB の EXPLAIN がウォッチ用のペイロードに変換でき、フィンガープリントが
/// 安定し、インデックス追加による計画の変化が比較で検出される。
async fn plan_ops(conn: &t::Connection, driver: &str, sql: &str) -> Vec<t::PlanOp> {
    let snap = t::explain_snapshot(conn, sql)
        .await
        .expect("explain")
        .expect("plan rows");
    t::ops_from_payload(driver, snap.payload_kind, &snap.payload)
}

async fn assert_plan_watch_detects_index(
    conn: &t::Connection,
    driver: &str,
    sql: &str,
    create_index: &str,
    index_db: Option<&str>,
) {
    let before = plan_ops(conn, driver, sql).await;
    assert!(
        !before.is_empty(),
        "EXPLAIN must normalize to at least one op"
    );
    assert_eq!(
        t::plan_fingerprint(&before),
        t::plan_fingerprint(&plan_ops(conn, driver, sql).await),
        "the same plan must have a stable fingerprint"
    );
    conn.execute(create_index, index_db)
        .await
        .expect(create_index);
    let after = plan_ops(conn, driver, sql).await;
    let changes = t::compare_plans(&before, &after, t::DEFAULT_ROW_FACTOR);
    assert!(
        !changes.is_empty(),
        "adding an index must change the plan: {before:?} -> {after:?}"
    );
    assert_ne!(t::plan_fingerprint(&before), t::plan_fingerprint(&after));
}

#[tokio::test]
async fn postgres_schema_drift_capture_and_plan_watch() {
    let Ok(url) = std::env::var("NOOBDB_TEST_POSTGRES_URL") else {
        eprintln!("skip: NOOBDB_TEST_POSTGRES_URL not set");
        return;
    };
    let opts = t::parse_postgres_url(&url).expect("valid url");
    let conn = t::connect(&opts).await.expect("connect");

    // 同じ DB を他のテストが並列に DROP / CREATE するため、専用スキーマに閉じる。
    let schema = format!("noobdb_drift1260_{}", std::process::id());
    conn.execute(&format!("DROP SCHEMA IF EXISTS {schema} CASCADE"), None)
        .await
        .expect("drop schema");
    for ddl in [
        format!("CREATE SCHEMA {schema}"),
        format!("CREATE TABLE {schema}.drift_parent (id integer PRIMARY KEY, name varchar(40))"),
        format!(
            "CREATE TABLE {schema}.drift_child (
                id integer PRIMARY KEY,
                pid integer NOT NULL REFERENCES {schema}.drift_parent (id),
                k integer NOT NULL
            )"
        ),
        format!("CREATE INDEX drift_child_pid ON {schema}.drift_child (pid)"),
        format!("CREATE TABLE {schema}.drift_lonely (v text)"),
    ] {
        conn.execute(&ddl, None).await.expect(&ddl);
    }

    let before = assert_drift_capture_matches_per_table(&conn, &schema).await;
    let again = t::capture_drift_payload(&conn, &schema)
        .await
        .expect("capture");
    assert_eq!(
        t::fingerprint_drift_payload(&before).expect("fp"),
        t::fingerprint_drift_payload(&again).expect("fp"),
        "an unchanged schema must have a stable fingerprint"
    );
    for ddl in [
        format!("ALTER TABLE {schema}.drift_child ADD COLUMN extra varchar(20)"),
        format!("CREATE INDEX drift_child_extra ON {schema}.drift_child (extra)"),
    ] {
        conn.execute(&ddl, None).await.expect(&ddl);
    }
    let after = assert_drift_capture_matches_per_table(&conn, &schema).await;
    assert_drift_summary_after_alter(&before, &after, "drift_child");

    // 実行計画ウォッチ: 十分な行数を入れて ANALYZE してからインデックスを足す。
    for ddl in [
        format!("INSERT INTO {schema}.drift_parent VALUES (1, 'p')"),
        format!(
            "INSERT INTO {schema}.drift_child (id, pid, k) SELECT g, 1, g FROM generate_series(1, 20000) g"
        ),
        format!("ANALYZE {schema}.drift_child"),
    ] {
        conn.execute(&ddl, None).await.expect(&ddl);
    }
    assert_plan_watch_detects_index(
        &conn,
        "postgres",
        &format!("SELECT * FROM {schema}.drift_child WHERE k = 5"),
        &format!("CREATE INDEX drift_child_k ON {schema}.drift_child (k)"),
        None,
    )
    .await;

    conn.execute(&format!("DROP SCHEMA {schema} CASCADE"), None)
        .await
        .expect("cleanup schema");
    conn.close().await;
}

/// #1537: PostgreSQL ではプロファイルの `database` は実 DB 名で、ツリー/タブの「データベース」は
/// スキーマ名。DB 名のまま (または空で) 取得しても既定スキーマ (`current_schema()`) の
/// スナップショットになり、スキーマ名を明示したときはそのスキーマになる。
#[tokio::test]
async fn postgres_schema_drift_resolves_db_name_to_default_schema() {
    let Ok(url) = std::env::var("NOOBDB_TEST_POSTGRES_URL") else {
        eprintln!("skip: NOOBDB_TEST_POSTGRES_URL not set");
        return;
    };
    let opts = t::parse_postgres_url(&url).expect("valid url");
    let conn = t::connect(&opts).await.expect("connect");

    let res = conn
        .execute("SELECT current_database(), current_schema()", None)
        .await
        .expect("current");
    let text = |i: usize| match &res.rows[0][i] {
        t::Value::String(s) => s.clone(),
        other => panic!("unexpected {other:?}"),
    };
    let (db_name, default_schema) = (text(0), text(1));

    // 他のテストと干渉しないよう、既定スキーマには一意名のテーブルを 1 つだけ作る。
    let table = format!("noobdb_drift1537_{}", std::process::id());
    let qualified = format!("{default_schema}.{table}");
    conn.execute(&format!("DROP TABLE IF EXISTS {qualified}"), None)
        .await
        .expect("drop");
    conn.execute(
        &format!("CREATE TABLE {qualified} (id integer PRIMARY KEY, v text)"),
        None,
    )
    .await
    .expect("create");

    // DB 名・空文字・スキーマ名の明示は、どれも既定スキーマの同じ内容になる。
    for requested in [db_name.as_str(), "", default_schema.as_str()] {
        assert_eq!(
            t::resolve_drift_database(&conn, requested)
                .await
                .expect("resolve"),
            default_schema,
            "'{requested}' must resolve to the default schema"
        );
        let payload = t::capture_drift_payload(&conn, requested)
            .await
            .expect("capture");
        assert_eq!(payload.database, default_schema);
        let captured = payload
            .tables
            .iter()
            .find(|x| x.name == table)
            .unwrap_or_else(|| panic!("'{requested}' capture must contain {table}"));
        assert!(captured.columns.iter().any(|c| c.name == "v"));
    }
    // 別のスキーマの明示はそのスキーマ (DB 名には読み替えない)。
    assert_eq!(
        t::resolve_drift_database(&conn, "information_schema")
            .await
            .expect("resolve"),
        "information_schema"
    );

    conn.execute(&format!("DROP TABLE {qualified}"), None)
        .await
        .expect("cleanup");
    conn.close().await;
}

/// `load_schema_tree` / `open_table(s)` / `list_tables_all` / `table_row_estimate`
/// (#1263) が、個別 IPC の結果と一致する。他のテストと干渉しないよう専用の
/// スキーマ `noobdb_t1263` に閉じる。
#[tokio::test]
async fn postgres_tree_and_open_table_match_individual_ipcs() {
    let Ok(url) = std::env::var("NOOBDB_TEST_POSTGRES_URL") else {
        eprintln!("skip: NOOBDB_TEST_POSTGRES_URL not set");
        return;
    };
    let opts = t::parse_postgres_url(&url).expect("valid url");
    let conn = t::connect(&opts).await.expect("connect");
    conn.execute("DROP SCHEMA IF EXISTS noobdb_t1263 CASCADE", None)
        .await
        .expect("drop");
    conn.execute("CREATE SCHEMA noobdb_t1263", None)
        .await
        .expect("create");
    for sql in [
        "CREATE TABLE noobdb_t1263.tr_a (id INT PRIMARY KEY, name VARCHAR(40) NOT NULL)",
        "COMMENT ON TABLE noobdb_t1263.tr_a IS 'first'",
        "CREATE TABLE noobdb_t1263.tr_b (id INT PRIMARY KEY, a_id INT REFERENCES noobdb_t1263.tr_a(id), v VARCHAR(20))",
        "CREATE INDEX tr_b_v ON noobdb_t1263.tr_b (v)",
        "CREATE TABLE noobdb_t1263.tr_c (x INT UNIQUE, y TEXT)",
        "CREATE TABLE noobdb_t1263.tr_d (k VARCHAR(10) PRIMARY KEY, n INT)",
        "CREATE VIEW noobdb_t1263.tr_v AS SELECT id, name FROM noobdb_t1263.tr_a",
        "INSERT INTO noobdb_t1263.tr_a VALUES (1, 'x'), (2, 'y')",
        "ANALYZE noobdb_t1263.tr_a",
    ] {
        conn.execute(sql, None).await.expect(sql);
    }
    let session_conn = t::connect(&opts).await.expect("connect (session)");
    let session = t::make_session("tree_1263", session_conn, opts.clone(), false);
    let state = t::AppState::default();
    let sid = state.insert(session).await;

    let tables: Vec<String> = ["tr_a", "tr_b", "tr_c", "tr_d"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    common::assert_tree_and_open_match_individual_ipcs(
        &state,
        &sid,
        &conn,
        "noobdb_t1263",
        &tables,
    )
    .await;
    // PK 無しテーブルの SELECT は ctid を隠し列に含める (#849)。
    let no_pk = t::open_table_via_command(&state, &sid, "noobdb_t1263", "tr_c", 5, false)
        .await
        .expect("open_table");
    assert_eq!(no_pk.base, "SELECT *, ctid FROM \"noobdb_t1263\".\"tr_c\"");

    // ビューにも行数推定は無い (BASE TABLE のみ)。
    assert_eq!(
        conn.table_row_estimate("noobdb_t1263", "tr_v")
            .await
            .expect("estimate"),
        None
    );

    conn.execute("DROP SCHEMA IF EXISTS noobdb_t1263 CASCADE", None)
        .await
        .expect("cleanup");
    conn.close().await;
}

/// #1422: 安全整数 (2^53 - 1) の境界を跨ぐ BIGINT 主キーが、デコード → JSON →
/// インラインセル編集の `WHERE` まで丸められずに往復し、隣の値の行を巻き込まない
/// ことを実 Postgres で固定する。デコーダが `Value::Int` を直接組み立てて 2^53 + 1 を
/// 数値のまま返すと、JSON で 2^53 に丸まり、`WHERE id = 9007199254740992` で別の行
/// (`b`) を書き換えてしまう。
#[tokio::test]
async fn postgres_bigint_pk_roundtrips_losslessly_into_cell_edit_where() {
    let Ok(url) = std::env::var("NOOBDB_TEST_POSTGRES_URL") else {
        eprintln!("skip: NOOBDB_TEST_POSTGRES_URL not set");
        return;
    };
    let opts = t::parse_postgres_url(&url).expect("valid url");
    let conn = t::connect(&opts).await.expect("connect");
    // PostgreSQL の `database` 引数はスキーマとして扱われる。
    let db = "public".to_string();
    let tbl = format!("noobdb_bigpk1422_{}", std::process::id());
    conn.execute(&format!("DROP TABLE IF EXISTS {tbl}"), Some(&db))
        .await
        .expect("drop");
    conn.execute(
        &format!("CREATE TABLE {tbl} (id BIGINT PRIMARY KEY, name VARCHAR(10))"),
        Some(&db),
    )
    .await
    .expect("create");
    conn.execute(
        &format!(
            "INSERT INTO {tbl} VALUES (9007199254740993, 'a'), (9007199254740992, 'b'), \
             (9007199254740991, 'c'), (-9007199254740993, 'd'), (-9007199254740992, 'e')"
        ),
        Some(&db),
    )
    .await
    .expect("insert");

    let res = conn
        .execute(
            &format!("SELECT id, name FROM {tbl} ORDER BY name"),
            Some(&db),
        )
        .await
        .expect("select");
    let ids: Vec<t::Value> = res.rows.iter().map(|r| r[0].clone()).collect();
    for v in &ids {
        assert!(v.is_js_safe(), "decoded id must be JSON-safe, got {v:?}");
    }
    // JSON を跨いでも十進表現が保たれる (フロントが受け取る形)。
    let json: serde_json::Value =
        serde_json::from_str(&serde_json::to_string(&ids).expect("ser")).expect("de");
    assert_eq!(
        json,
        serde_json::json!([
            "9007199254740993",
            "9007199254740992",
            9007199254740991_i64,
            "-9007199254740993",
            "-9007199254740992"
        ])
    );

    let session = t::make_session("bigpk1422", conn, opts.clone(), /* read_only */ false);
    let state = t::AppState::default();
    let sid = state.insert(session).await;
    // デコードされた値をそのままキーに使う (インラインセル編集と同じ経路)。
    let res = t::bulk_update_cells_via_command(
        &state,
        &sid,
        Some(&db),
        &tbl,
        vec!["id".into()],
        vec![t::BulkUpdateGroup {
            set: vec![t::BulkSetColumn {
                column: "name".into(),
                value: t::BulkSetValue::Text { text: "x".into() },
            }],
            keys: vec![vec![ids[0].clone()], vec![ids[3].clone()]],
        }],
        vec![],
    )
    .await
    .expect("bulk update");
    assert_eq!(res.rows_affected, 2);
    let s = state.get(&sid).await.expect("session");
    let r = s
        .conn
        .execute(&format!("SELECT name FROM {tbl} ORDER BY id"), Some(&db))
        .await
        .expect("verify");
    let names: Vec<String> = r
        .rows
        .iter()
        .map(|row| match &row[0] {
            t::Value::String(v) => v.clone(),
            other => format!("{other:?}"),
        })
        .collect();
    // ORDER BY id: -2^53-1, -2^53, 2^53-1, 2^53, 2^53+1。隣の b / e は書き換わらない。
    assert_eq!(names, vec!["x", "e", "c", "b", "x"]);
    s.conn
        .execute(&format!("DROP TABLE IF EXISTS {tbl}"), Some(&db))
        .await
        .expect("cleanup");
}

/// #1417 — 待機チェーン: 接続 A が行をロックしたまま、接続 B が同じ行を UPDATE して待つ。
/// `list_processes` で B の `blocked_by` に A の pid が入り、A を kill すると待機が解消する。
#[tokio::test]
async fn postgres_blocking_chain_is_listed_and_resolved_by_kill() {
    let Ok(url) = std::env::var("NOOBDB_TEST_POSTGRES_URL") else {
        eprintln!("skip: NOOBDB_TEST_POSTGRES_URL not set");
        return;
    };
    let opts = t::parse_postgres_url(&url).expect("valid url");
    let admin = t::connect(&opts).await.expect("connect admin");
    admin
        .execute("DROP TABLE IF EXISTS noobdb_it_blocking", None)
        .await
        .expect("drop");
    admin
        .execute(
            "CREATE TABLE noobdb_it_blocking (id int PRIMARY KEY, v int)",
            None,
        )
        .await
        .expect("create");
    admin
        .execute("INSERT INTO noobdb_it_blocking VALUES (1, 0)", None)
        .await
        .expect("insert");

    // A: 明示トランザクションで行ロックを保持する。
    let a = t::connect(&opts).await.expect("connect A");
    a.begin_transaction(None).await.expect("begin A");
    let res = a
        .execute_in_transaction("SELECT pg_backend_pid() AS pid")
        .await
        .expect("pid A");
    let a_pid = match &res.rows[0][0] {
        t::Value::Int(v) => *v,
        other => panic!("unexpected pid: {other:?}"),
    };
    a.execute_in_transaction("UPDATE noobdb_it_blocking SET v = 1 WHERE id = 1")
        .await
        .expect("A update");

    // B: 同じ行を UPDATE して待たされる (別タスク)。
    let b = std::sync::Arc::new(t::connect(&opts).await.expect("connect B"));
    let b_task = {
        let b = b.clone();
        tokio::spawn(async move {
            tokio::time::timeout(
                std::time::Duration::from_secs(30),
                b.execute("UPDATE noobdb_it_blocking SET v = 2 WHERE id = 1", None),
            )
            .await
        })
    };

    let mut waiter: Option<i64> = None;
    for _ in 0..50 {
        let list = admin.list_processes().await.expect("list");
        if let Some(p) = list.iter().find(|p| p.blocked_by.contains(&a_pid)) {
            waiter = Some(p.id);
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    let waiter = waiter.expect("B must be reported as blocked by A");
    assert_ne!(waiter, a_pid);

    // 根のブロッカー A を kill すると B の UPDATE が進む。
    let killed = admin.kill_processes(&[a_pid], false).await.expect("kill A");
    assert_eq!(killed.killed, 1, "{killed:?}");
    let outcome = b_task.await.expect("join B");
    assert!(
        matches!(outcome, Ok(Ok(_))),
        "B must complete once the blocker is killed: {outcome:?}"
    );

    admin
        .execute("DROP TABLE IF EXISTS noobdb_it_blocking", None)
        .await
        .expect("cleanup");
    admin.close().await;
}

/// #1519: 複合 FK は列ごとに正しく 1 対 1 対応し、別テーブルの同名 FK が混ざらない。
#[tokio::test]
async fn postgres_foreign_keys_pair_composite_columns_and_ignore_same_named_fk() {
    let Ok(url) = std::env::var("NOOBDB_TEST_POSTGRES_URL") else {
        eprintln!("skip: NOOBDB_TEST_POSTGRES_URL not set");
        return;
    };
    let opts = t::parse_postgres_url(&url).expect("valid url");
    let conn = t::connect(&opts).await.expect("connect");

    for sql in [
        "DROP TABLE IF EXISTS public.fk1519_child_a",
        "DROP TABLE IF EXISTS public.fk1519_child_b",
        "DROP TABLE IF EXISTS public.fk1519_child_c",
        "DROP TABLE IF EXISTS public.fk1519_parent_a",
        "DROP TABLE IF EXISTS public.fk1519_parent_b",
        "CREATE TABLE public.fk1519_parent_a (id INT, sku INT, PRIMARY KEY (id, sku))",
        "CREATE TABLE public.fk1519_parent_b (id INT PRIMARY KEY)",
        "CREATE TABLE public.fk1519_child_a (order_id INT, product_id INT, \
           CONSTRAINT fk_composite FOREIGN KEY (order_id, product_id) \
             REFERENCES public.fk1519_parent_a (id, sku))",
        "CREATE TABLE public.fk1519_child_b (pid INT, \
           CONSTRAINT fk_parent FOREIGN KEY (pid) REFERENCES public.fk1519_parent_b (id))",
        "CREATE TABLE public.fk1519_child_c (a INT, b INT, \
           CONSTRAINT fk_parent FOREIGN KEY (a, b) REFERENCES public.fk1519_parent_a (id, sku))",
    ] {
        conn.execute(sql, None).await.expect(sql);
    }

    let fks = conn.foreign_keys("public").await.expect("foreign_keys");
    let composite: Vec<_> = fks.iter().filter(|f| f.table == "fk1519_child_a").collect();
    assert_eq!(composite.len(), 2, "複合 FK は 2 行だけ: {composite:?}");
    for (col, refcol) in [("order_id", "id"), ("product_id", "sku")] {
        let row = composite
            .iter()
            .find(|f| f.column == col)
            .expect("composite column");
        assert_eq!(row.referenced_table, "fk1519_parent_a");
        assert_eq!(row.referenced_column.as_deref(), Some(refcol));
    }
    let b: Vec<_> = fks.iter().filter(|f| f.table == "fk1519_child_b").collect();
    assert_eq!(b.len(), 1, "{b:?}");
    assert_eq!(b[0].constraint_name.as_deref(), Some("fk_parent"));
    assert_eq!(
        b[0].referenced_table, "fk1519_parent_b",
        "同名 FK fk_parent の参照先が別テーブルと混ざらない"
    );

    for sql in [
        "DROP TABLE IF EXISTS public.fk1519_child_a",
        "DROP TABLE IF EXISTS public.fk1519_child_b",
        "DROP TABLE IF EXISTS public.fk1519_child_c",
        "DROP TABLE IF EXISTS public.fk1519_parent_a",
        "DROP TABLE IF EXISTS public.fk1519_parent_b",
    ] {
        conn.execute(sql, None).await.expect("cleanup");
    }
    conn.close().await;
}

/// #1786: 別スキーマの子テーブルからの単一列 FK だけが逆参照の補完に含まれる。
/// 同一スキーマの FK・複合 FK は含まれず、`foreign_keys` (ER 図用) も変わらない。
#[tokio::test]
async fn postgres_cross_schema_incoming_foreign_keys_are_listed() {
    let Ok(url) = std::env::var("NOOBDB_TEST_POSTGRES_URL") else {
        eprintln!("skip: NOOBDB_TEST_POSTGRES_URL not set");
        return;
    };
    let opts = t::parse_postgres_url(&url).expect("valid url");
    let conn = t::connect(&opts).await.expect("connect");

    for sql in [
        "DROP SCHEMA IF EXISTS fk1786_sales CASCADE",
        "DROP TABLE IF EXISTS public.fk1786_parent CASCADE",
        "CREATE TABLE public.fk1786_parent (id INT, sku INT, PRIMARY KEY (id), UNIQUE (id, sku))",
        "CREATE TABLE public.fk1786_same (pid INT REFERENCES public.fk1786_parent (id))",
        "CREATE SCHEMA fk1786_sales",
        "CREATE TABLE fk1786_sales.child (pid INT, \
           CONSTRAINT fk_cross FOREIGN KEY (pid) REFERENCES public.fk1786_parent (id) ON DELETE CASCADE)",
        "CREATE TABLE fk1786_sales.child_comp (pid INT, psku INT, \
           CONSTRAINT fk_comp FOREIGN KEY (pid, psku) REFERENCES public.fk1786_parent (id, sku))",
    ] {
        conn.execute(sql, None).await.expect(sql);
    }

    let got = conn
        .cross_schema_incoming_foreign_keys("public", "fk1786_parent")
        .await
        .expect("cross_schema_incoming_foreign_keys");
    assert_eq!(got.len(), 1, "別スキーマの単一列 FK だけ: {got:?}");
    assert_eq!(got[0].schema.as_deref(), Some("fk1786_sales"));
    assert_eq!(got[0].table, "child");
    assert_eq!(got[0].column, "pid");
    assert_eq!(got[0].referenced_column, "id");
    assert_eq!(got[0].on_delete.as_deref(), Some("CASCADE"));

    // 既存の foreign_keys (ER 図 / DDL 用) は同一スキーマ限定のまま。
    let fks = conn.foreign_keys("public").await.expect("foreign_keys");
    assert!(fks.iter().all(|f| f.table != "child"), "{fks:?}");
    assert!(fks.iter().any(|f| f.table == "fk1786_same"));
    // MySQL / SQLite 相当: 参照されていないテーブルは空。
    assert!(conn
        .cross_schema_incoming_foreign_keys("public", "fk1786_same")
        .await
        .expect("empty")
        .is_empty());

    for sql in [
        "DROP SCHEMA IF EXISTS fk1786_sales CASCADE",
        "DROP TABLE IF EXISTS public.fk1786_same",
        "DROP TABLE IF EXISTS public.fk1786_parent CASCADE",
    ] {
        conn.execute(sql, None).await.expect("cleanup");
    }
    conn.close().await;
}

/// 生成列 (`GENERATED ALWAYS AS (...) STORED`) の `columns()` は `extra` に
/// `STORED GENERATED` を返す。通常列は空 (#1521)。
#[tokio::test]
async fn postgres_columns_report_generated_columns_in_extra() {
    let Ok(url) = std::env::var("NOOBDB_TEST_POSTGRES_URL") else {
        eprintln!("skip: NOOBDB_TEST_POSTGRES_URL not set");
        return;
    };
    let opts = t::parse_postgres_url(&url).expect("valid url");
    let conn = t::connect(&opts).await.expect("connect");
    conn.execute("DROP TABLE IF EXISTS public.noobdb_pg_gen", None)
        .await
        .expect("drop");
    conn.execute(
        "CREATE TABLE public.noobdb_pg_gen (id INT PRIMARY KEY, a INT, b INT GENERATED ALWAYS AS (a * 2) STORED)",
        None,
    )
    .await
    .expect("create");
    let cols = conn
        .columns("public", "noobdb_pg_gen")
        .await
        .expect("columns");
    let extra = |n: &str| {
        cols.iter()
            .find(|c| c.name == n)
            .expect("column")
            .extra
            .clone()
    };
    assert_eq!(extra("b"), "STORED GENERATED");
    assert_eq!(extra("a"), "");
    conn.execute("DROP TABLE public.noobdb_pg_gen", None)
        .await
        .expect("cleanup");
    conn.close().await;
}

/// 全列の概要 (#1539)。json / jsonb / bytea を含む表でも 1 本の SELECT で取れ、
/// 型の都合で MIN/MAX を外した列に理由コードが付くこと。
#[tokio::test]
async fn postgres_table_overview_single_scan() {
    let Ok(url) = std::env::var("NOOBDB_TEST_POSTGRES_URL") else {
        eprintln!("skip: NOOBDB_TEST_POSTGRES_URL not set");
        return;
    };
    let opts = t::parse_postgres_url(&url).expect("valid url");
    let conn = t::connect(&opts).await.expect("connect");
    conn.execute("DROP TABLE IF EXISTS public.noobdb_pg_overview", None)
        .await
        .expect("drop");
    conn.execute(
        "CREATE TABLE public.noobdb_pg_overview (id INT PRIMARY KEY, score DOUBLE PRECISION, \
         tag TEXT, j JSON, jb JSONB, b BYTEA)",
        None,
    )
    .await
    .expect("create");
    conn.execute(
        "INSERT INTO public.noobdb_pg_overview VALUES \
         (1, 1.5, 'a', '{\"k\":1}', '{\"k\":1}', '\\x01'), (2, 2.5, 'a', NULL, NULL, NULL), \
         (3, NULL, NULL, NULL, NULL, NULL)",
        None,
    )
    .await
    .expect("insert");
    let o = conn
        .table_profile("public", "noobdb_pg_overview", true, false)
        .await
        .expect("overview");
    assert_eq!(o.scans, 1);
    assert_eq!(o.total_count, t::Value::UInt(3));
    assert_eq!(o.columns.len(), 6);
    let by = |n: &str| o.columns.iter().find(|c| c.column == n).expect("column");
    assert_eq!(by("score").null_count, t::Value::UInt(1));
    assert_eq!(by("tag").distinct_count, Some(t::Value::UInt(1)));
    assert_eq!(by("j").non_null_count, t::Value::UInt(1));
    assert!(
        !by("j").notes.is_empty(),
        "json は MIN/MAX を外した理由が付く"
    );
    assert!(
        !o.distinct_approximate,
        "正確モードでは近似マークを付けない"
    );
    // 統計 (ANALYZE) がまだ無い表で近似を求めると、DISTINCT は省略され理由が付く。
    let nostats = conn
        .table_profile("public", "noobdb_pg_overview", true, true)
        .await
        .expect("approximate overview without stats");
    assert!(!nostats.distinct_approximate);
    assert!(nostats
        .notes
        .iter()
        .any(|n| n == "overview_approx_no_stats"));
    // #1609: 近似モードは COUNT(DISTINCT) を外し、ANALYZE 済みの pg_stats から埋める。
    conn.execute("ANALYZE public.noobdb_pg_overview", None)
        .await
        .expect("analyze");
    let approx = conn
        .table_profile("public", "noobdb_pg_overview", true, true)
        .await
        .expect("approximate overview");
    assert_eq!(approx.total_count, t::Value::UInt(3));
    assert!(approx.distinct_approximate);
    let aby = |n: &str| {
        approx
            .columns
            .iter()
            .find(|c| c.column == n)
            .expect("column")
    };
    // n_distinct 由来の推定値でも、非 NULL 件数 (tag は 2) を超えない。
    let tag_distinct = match &aby("tag").distinct_count {
        Some(t::Value::UInt(n)) => *n,
        other => panic!("tag の近似 DISTINCT が数値でない: {other:?}"),
    };
    assert!((1..=2).contains(&tag_distinct));
    // json は DISTINCT を取れない型なので、近似でも外れて理由が付く。
    assert_eq!(aby("j").distinct_count, None);
    assert!(!aby("j").notes.is_empty());
    // MIN/MAX は近似モードでも集計 SELECT が返す。
    assert_ne!(aby("score").min_value, t::Value::Null);
    conn.execute("DROP TABLE IF EXISTS public.noobdb_pg_overview", None)
        .await
        .expect("cleanup");
}

/// #1539: SQLite → Postgres の upsert 転送。既存行の更新・新規行の追加・skip を実 DB で確かめる。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn postgres_transfer_upsert_updates_and_skips() {
    use std::sync::atomic::AtomicU64;
    use std::sync::Arc;
    let Ok(url) = std::env::var("NOOBDB_TEST_POSTGRES_URL") else {
        eprintln!("skip: NOOBDB_TEST_POSTGRES_URL not set");
        return;
    };
    let opts = t::parse_postgres_url(&url).expect("valid url");
    let conn = t::connect(&opts).await.expect("connect");
    conn.execute("DROP TABLE IF EXISTS noobdb_upsert_pg", None)
        .await
        .expect("drop");
    conn.execute(
        "CREATE TABLE public.noobdb_upsert_pg (id INT PRIMARY KEY, name VARCHAR(20), qty INT)",
        None,
    )
    .await
    .expect("create");
    conn.execute(
        "INSERT INTO noobdb_upsert_pg VALUES (1, 'old', 10), (9, 'keep', 1)",
        None,
    )
    .await
    .expect("seed target");

    let state = t::AppState::default();
    let mut src_path = std::env::temp_dir();
    src_path.push(format!(
        "noobdb_upsert_postgres_src_{}.db",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&src_path);
    std::fs::File::create(&src_path).expect("touch");
    let src_opts = t::sqlite_options(src_path.to_str().expect("utf8"));
    let src_conn = t::connect(&src_opts).await.expect("sqlite");
    src_conn
        .execute(
            "CREATE TABLE noobdb_upsert_pg (id INTEGER PRIMARY KEY, name TEXT, qty INTEGER)",
            None,
        )
        .await
        .expect("src create");
    src_conn
        .execute(
            "INSERT INTO noobdb_upsert_pg VALUES (1, 'new', 11), (2, 'two', 5)",
            None,
        )
        .await
        .expect("src seed");
    state
        .insert(t::make_session("src", src_conn, src_opts, false))
        .await;
    state
        .insert(t::make_session("dst", conn, opts, false))
        .await;

    let req = |mode: Option<t::ConflictMode>| t::TransferRequest {
        source_session_id: "src".into(),
        target_session_id: "dst".into(),
        source_database: None,
        source_table: Some("noobdb_upsert_pg".into()),
        source_sql: None,
        target_database: Some("public".into()),
        target_table: "noobdb_upsert_pg".into(),
        mode: t::TransferMode::Upsert,
        batch_size: Some(100),
        conflict_mode: mode,
        key_columns: None,
        columns: Vec::new(),
        where_clause: None,
        limit_rows: None,
        verify_counts: None,
    };
    let run = |r: t::TransferRequest| {
        let state = &state;
        async move { t::transfer_data_inner(state, r, Arc::new(AtomicU64::new(0)), |_| {}).await }
    };
    let dst = state.get("dst").await.expect("dst");

    run(req(None)).await.expect("upsert update");
    let r = dst
        .conn
        .execute(
            "SELECT id, name, qty FROM noobdb_upsert_pg ORDER BY id",
            None,
        )
        .await
        .expect("select");
    assert_eq!(r.rows.len(), 3, "{:?}", r.rows);
    assert_eq!(
        format!("{:?}", r.rows[0][1]),
        format!("{:?}", t::Value::String("new".into()))
    );

    dst.conn
        .execute(
            "UPDATE noobdb_upsert_pg SET name = 'local' WHERE id = 1",
            None,
        )
        .await
        .expect("local edit");
    run(req(Some(t::ConflictMode::Skip)))
        .await
        .expect("upsert skip");
    let r = dst
        .conn
        .execute("SELECT name FROM noobdb_upsert_pg WHERE id = 1", None)
        .await
        .expect("select");
    assert_eq!(
        format!("{:?}", r.rows[0][0]),
        format!("{:?}", t::Value::String("local".into()))
    );

    dst.conn
        .execute("DROP TABLE IF EXISTS noobdb_upsert_pg", None)
        .await
        .expect("cleanup");
    let _ = std::fs::remove_file(&src_path);
}

/// 複数行の BLOB をフォルダへ書き出す (#1539)。Postgres の実 DB で probe → 取得 → ファイル書き出しが
/// 主キー由来の名前・種別由来の拡張子で行われ、NULL が飛ばされること。
#[tokio::test]
async fn postgres_save_cells_to_folder() {
    let Ok(url) = std::env::var("NOOBDB_TEST_POSTGRES_URL") else {
        eprintln!("skip: NOOBDB_TEST_POSTGRES_URL not set");
        return;
    };
    let opts = t::parse_postgres_url(&url).expect("valid url");
    let conn = t::connect(&opts).await.expect("connect");
    let session = t::make_session("s-blob-folder", conn, opts.clone(), false);
    let db: Option<&str> = Some("public");
    session
        .conn
        .execute("DROP TABLE IF EXISTS cell_blob_folder_t", db)
        .await
        .expect("drop");
    session
        .conn
        .execute(
            "CREATE TABLE cell_blob_folder_t (id INT PRIMARY KEY, data BYTEA)",
            db,
        )
        .await
        .expect("create");
    for sql in [
        "INSERT INTO cell_blob_folder_t VALUES (1, '\\x89504e470d0a1a0a0000')",
        "INSERT INTO cell_blob_folder_t VALUES (2, '\\x0102')",
        "INSERT INTO cell_blob_folder_t VALUES (3, NULL)",
    ] {
        session.conn.execute(sql, db).await.expect("insert");
    }
    let mut dir = std::env::temp_dir();
    dir.push(format!(
        "noobdb_blob_folder_postgres_{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("mkdir");
    let keys = serde_json::json!([
        [{ "column": "id", "value": 1 }],
        [{ "column": "id", "value": 2 }],
        [{ "column": "id", "value": 3 }],
    ]);
    let r = t::save_cells_to_folder_via_session(
        &session,
        db,
        "cell_blob_folder_t",
        "data",
        keys,
        dir.to_str().expect("utf8"),
    )
    .await
    .expect("save to folder");
    assert_eq!((r.saved, r.skipped_null, r.failed), (2, 1, 0), "{r:?}");
    assert_eq!(
        std::fs::read(dir.join("1.png")).expect("png"),
        vec![0x89u8, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]
    );
    assert_eq!(std::fs::read(dir.join("2.bin")).expect("bin"), vec![1u8, 2]);
    let _ = std::fs::remove_dir_all(&dir);
    session
        .conn
        .execute("DROP TABLE IF EXISTS cell_blob_folder_t", db)
        .await
        .expect("cleanup");
}

/// INCLUDE 列・DESC・NULLS NOT DISTINCT が再構成 DDL に残る (#1602)。
/// `list_indexes` の SELECT が追加列を返していることの確認を兼ねる。
#[tokio::test]
async fn postgres_reconstructed_ddl_keeps_include_and_sort_order() {
    let Ok(url) = std::env::var("NOOBDB_TEST_POSTGRES_URL") else {
        eprintln!("skip: NOOBDB_TEST_POSTGRES_URL not set");
        return;
    };
    let opts = t::parse_postgres_url(&url).expect("valid url");
    let conn = t::connect(&opts).await.expect("connect");
    conn.execute("DROP TABLE IF EXISTS ddl1602", None)
        .await
        .expect("drop");
    conn.execute("CREATE TABLE ddl1602 (a int, b int)", None)
        .await
        .expect("create");
    conn.execute(
        "CREATE UNIQUE INDEX ddl1602_u ON ddl1602 (a DESC) INCLUDE (b)",
        None,
    )
    .await
    .expect("index");
    let ddl = conn
        .object_definition("public", "table", "ddl1602", None)
        .await
        .expect("ddl");
    conn.execute("DROP TABLE IF EXISTS ddl1602", None)
        .await
        .ok();
    assert!(
        ddl.contains("(\"a\" DESC) INCLUDE (\"b\")"),
        "unexpected DDL: {ddl}"
    );
}

/// CHECK 制約と生成列の式が再構成 DDL に含まれ、そのまま別名のテーブルを作れる (#1625)。
#[tokio::test]
async fn postgres_reconstructed_ddl_keeps_check_and_generated_columns() {
    let Ok(url) = std::env::var("NOOBDB_TEST_POSTGRES_URL") else {
        eprintln!("skip: NOOBDB_TEST_POSTGRES_URL not set");
        return;
    };
    let opts = t::parse_postgres_url(&url).expect("valid url");
    let conn = t::connect(&opts).await.expect("connect");
    conn.execute("DROP TABLE IF EXISTS ddl1625, ddl1625_copy", None)
        .await
        .expect("drop");
    conn.execute(
        "CREATE TABLE ddl1625 (price int NOT NULL, qty int, total int GENERATED ALWAYS AS (price * qty) STORED, \
         CONSTRAINT ddl1625_price_pos CHECK (price > 0))",
        None,
    )
    .await
    .expect("create");
    let ddl = conn
        .object_definition("public", "table", "ddl1625", None)
        .await
        .expect("ddl");
    assert!(
        ddl.contains("CONSTRAINT \"ddl1625_price_pos\" CHECK (price > 0)"),
        "unexpected DDL: {ddl}"
    );
    assert!(
        ddl.contains("\"total\" integer GENERATED ALWAYS AS ((price * qty)) STORED"),
        "unexpected DDL: {ddl}"
    );
    assert!(!ddl.contains("DEFAULT (price"), "{ddl}");
    // 再構成した DDL をそのまま流して、制約と生成列が効くことを確かめる。
    let copy_ddl = ddl
        .replace("\"ddl1625\"", "\"ddl1625_copy\"")
        .replace("ddl1625_price_pos", "ddl1625_copy_price_pos");
    for stmt in copy_ddl.split(";\n").filter(|s| s.contains("CREATE TABLE")) {
        conn.execute(stmt, None).await.expect("recreate");
    }
    conn.execute("INSERT INTO ddl1625_copy (price, qty) VALUES (3, 4)", None)
        .await
        .expect("insert");
    let r = conn
        .execute("SELECT total FROM ddl1625_copy", None)
        .await
        .expect("select");
    assert!(matches!(&r.rows[0][0], t::Value::Int(12)), "{r:?}");
    assert!(conn
        .execute("INSERT INTO ddl1625_copy (price, qty) VALUES (0, 1)", None)
        .await
        .is_err());
    conn.execute("DROP TABLE IF EXISTS ddl1625, ddl1625_copy", None)
        .await
        .ok();
}

/// 取り込みの事前検証 (dry run、#1623): 拒否される行を数えるが、何も永続化しない。
async fn assert_dry_run_counts_failures_without_persisting(conn: &t::Connection, table: &str) {
    let columns = vec!["id".to_string(), "name".to_string()];
    let cell = |s: Option<&str>| s.map(str::to_string);
    let rows = vec![
        vec![cell(Some("2")), cell(Some("b"))],
        vec![cell(Some("1")), cell(Some("dup"))],
        vec![cell(Some("3")), cell(None)],
        vec![cell(Some("4")), cell(Some("d"))],
    ];
    let out = conn
        .dry_run_failures(
            None,
            table,
            &columns,
            &rows,
            &t::ImportConflict::insert_only(),
            1,
        )
        .await
        .expect("dry run");
    assert_eq!(out.failed, 2, "{out:?}");
    // 先頭 1 件だけ保持し、総数は数え続ける。
    assert_eq!(out.failures.len(), 1);
    assert_eq!(out.failures[0].index, 1);
    assert!(!out.failures[0].reason.is_empty());
    let count = conn
        .execute(&format!("SELECT COUNT(*) FROM {table}"), None)
        .await
        .expect("count");
    assert!(
        matches!(&count.rows[0][0], t::Value::Int(1)),
        "dry run must not persist anything: {:?}",
        count.rows[0][0]
    );
}

#[tokio::test]
async fn postgres_import_dry_run_does_not_persist() {
    let Ok(url) = std::env::var("NOOBDB_TEST_POSTGRES_URL") else {
        eprintln!("skip: NOOBDB_TEST_POSTGRES_URL not set");
        return;
    };
    let opts = t::parse_postgres_url(&url).expect("valid url");
    let conn = t::connect(&opts).await.expect("connect");
    conn.execute("DROP TABLE IF EXISTS noobdb_pg_dry", None)
        .await
        .expect("drop");
    conn.execute(
        "CREATE TABLE noobdb_pg_dry (id INT PRIMARY KEY, name TEXT NOT NULL)",
        None,
    )
    .await
    .expect("create");
    conn.execute("INSERT INTO noobdb_pg_dry VALUES (1, 'a')", None)
        .await
        .expect("seed");
    assert_dry_run_counts_failures_without_persisting(&conn, "noobdb_pg_dry").await;
    conn.execute("DROP TABLE noobdb_pg_dry", None)
        .await
        .expect("cleanup");
}

/// スキーマ健全性アドバイザの未使用インデックス (#741 / #1621): 一度も使われていないインデックスの
/// 指摘に、削除で空く容量 (`pg_relation_size`) が載る。
#[tokio::test]
async fn postgres_advisor_unused_index_reports_reclaimable_size() {
    let Ok(url) = std::env::var("NOOBDB_TEST_POSTGRES_URL") else {
        eprintln!("skip: NOOBDB_TEST_POSTGRES_URL not set");
        return;
    };
    let opts = t::parse_postgres_url(&url).expect("valid url");
    let conn = t::connect(&opts).await.expect("connect");
    for sql in [
        "DROP TABLE IF EXISTS noobdb_adv_idx",
        "CREATE TABLE noobdb_adv_idx (id INT PRIMARY KEY, note TEXT)",
        "INSERT INTO noobdb_adv_idx SELECT g, repeat('x', 50) FROM generate_series(1, 2000) g",
        "CREATE INDEX noobdb_adv_idx_note ON noobdb_adv_idx (note)",
    ] {
        conn.execute(sql, None).await.expect(sql);
    }
    // 統計はコミット後に反映される。
    let report = t::analyze_schema_health(&conn, "public")
        .await
        .expect("analyze");
    let found = report
        .findings
        .iter()
        .find(|f| f.rule == t::RuleId::UnusedIndex && f.table == "noobdb_adv_idx");
    let skipped = report
        .skipped
        .iter()
        .any(|s| s.rule == t::RuleId::UnusedIndex);
    conn.execute("DROP TABLE IF EXISTS noobdb_adv_idx", None)
        .await
        .expect("drop");
    assert!(
        !skipped,
        "unused index stats must be readable on PostgreSQL"
    );
    let f = found.expect("unused index finding");
    assert!(
        f.size_bytes.is_some_and(|n| n > 0),
        "size_bytes must be filled from pg_relation_size: {:?}",
        f.size_bytes
    );
}

#[tokio::test]
async fn postgres_column_profile_sampled_is_subset_of_table() {
    let Ok(url) = std::env::var("NOOBDB_TEST_POSTGRES_URL") else {
        eprintln!("skip: NOOBDB_TEST_POSTGRES_URL not set");
        return;
    };
    let opts = t::parse_postgres_url(&url).expect("valid url");
    let conn = t::connect(&opts).await.expect("connect");
    conn.execute("DROP TABLE IF EXISTS public.prof_sample_t", None)
        .await
        .expect("drop");
    conn.execute(
        "CREATE TABLE public.prof_sample_t AS \
         SELECT g AS id, g % 7 AS v FROM generate_series(1, 20000) g",
        None,
    )
    .await
    .expect("create");
    let p = conn
        .column_profile("public", "prof_sample_t", "v", false, 5, Some(10.0))
        .await
        .expect("sampled profile");
    assert_eq!(p.sample_percent, Some(10.0));
    assert!(p.notes.contains(&"sampled".to_string()));
    match p.total_count {
        t::Value::UInt(n) => assert!(n < 20000, "sample must be a strict subset: {n}"),
        ref other => panic!("unexpected count: {other:?}"),
    }
    conn.execute("DROP TABLE IF EXISTS public.prof_sample_t", None)
        .await
        .expect("cleanup");
}

/// 構文エラーの本文に、サーバが返すエラー位置 (元の文の 1 始まりの文字オフセット) が
/// ` (position n)` として載る (#1627)。出力タブの「エラー位置へ移動」がこれを使う。
#[tokio::test]
async fn postgres_syntax_error_message_carries_the_error_position() {
    let Ok(url) = std::env::var("NOOBDB_TEST_POSTGRES_URL") else {
        eprintln!("skip: NOOBDB_TEST_POSTGRES_URL not set");
        return;
    };
    let opts = t::parse_postgres_url(&url).expect("valid url");
    let conn = t::connect(&opts).await.expect("connect");

    // `SELECT 1 FORM` の FORM は別名として読まれ、次の `t` が誤り = 先頭から数えて 15 文字目
    // ("SELECT 1\n" が 9 文字、"FORM " が 5 文字)。サーバのソース行番号 (`at line N`) は載せない。
    let err = conn
        .execute("SELECT 1\nFORM t", None)
        .await
        .expect_err("syntax error");
    let msg = err.to_string();
    assert!(msg.ends_with("(position 15)"), "message was: {msg}");
    assert!(!msg.contains("at line"), "message was: {msg}");

    // 位置を持たないエラー (存在しない関数ではなく、実行時エラー) は文言を変えない。
    let err = conn
        .execute("SELECT 1/0", None)
        .await
        .expect_err("division by zero");
    assert!(!err.to_string().contains("(position"), "{err}");
}
