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

    let info = conn.server_info().await.expect("server_info");
    assert!(!info.version.is_empty(), "version must be reported");
    assert!(
        info.variables.iter().any(|v| v.name == "server_version"),
        "pg_settings must include server_version"
    );

    conn.execute("DROP TABLE public.noobdb_pg_sizes", None)
        .await
        .expect("cleanup");
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

/// プロセス監視パネル (list_processes / kill_process) の PostgreSQL 経路。
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

    conn.kill_process(victim_pid).await.expect("kill");

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
        m.questions.is_some_and(|q| q >= 1),
        "xact_commit+rollback sum must be reported and >= 1, got {:?}",
        m.questions
    );
    // PostgreSQL には MySQL 相当の常設カウンタが無いので None に縮退する。
    assert!(m.slow_queries.is_none(), "slow_queries has no PG analog");
    assert!(m.lock_waits.is_none(), "lock_waits has no cheap PG analog");

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
            &row[i]
        );
    }

    assert!(
        matches!(&row[0], t::Value::String(s) if s == "11111111-2222-3333-4444-555555555555"),
        "uuid must decode to its canonical text form, got {:?}",
        &row[0]
    );
    // 配列は PostgreSQL の配列リテラル表記。区切り文字を含む要素は引用され、
    // 要素の NULL は `NULL` として表れる。
    assert!(
        matches!(&row[1], t::Value::String(s) if s == "{a,\"b,c\",NULL}"),
        "text[] must decode to an array literal, got {:?}",
        &row[1]
    );
    assert!(
        matches!(&row[2], t::Value::String(s) if s == "{1,2,3}"),
        "int4[] must decode to an array literal, got {:?}",
        &row[2]
    );
    assert!(
        matches!(&row[3], t::Value::String(s) if s == "192.168.1.5"),
        "inet must decode to its text form, got {:?}",
        &row[3]
    );
    assert!(
        matches!(&row[4], t::Value::String(s) if s == "12.34"),
        "money must decode to a plain decimal, got {:?}",
        &row[4]
    );
    assert!(
        matches!(&row[5], t::Value::String(s) if s == "1 year 2 mons 3 days 04:05:06.789"),
        "interval must decode to PostgreSQL-style text, got {:?}",
        &row[5]
    );
    assert!(
        matches!(&row[6], t::Value::String(s) if s == "happy"),
        "user-defined enum must decode to its label, got {:?}",
        &row[6]
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
        &row[7]
    );
    // 2^53 を超える bigint は丸めを避けるため十進文字列で届く。
    assert!(
        matches!(&row[8], t::Value::String(s) if s == "9007199254740993"),
        "bigint beyond 2^53 must be a decimal string, got {:?}",
        &row[8]
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
