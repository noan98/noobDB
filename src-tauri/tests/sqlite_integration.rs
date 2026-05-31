//! Integration test for the SQLite driver.
//!
//! Unlike the MySQL / PostgreSQL paths, this test does not need an external
//! server — it creates a temporary SQLite file in `std::env::temp_dir()`
//! and exercises the full driver surface against it: connect, CRUD,
//! schema introspection, and preview rollback.

use std::path::{Path, PathBuf};

use noobdb_lib::__test_api as t;

fn temp_db_path() -> PathBuf {
    let mut p = std::env::temp_dir();
    // Mix in the test PID so parallel test runs don't stomp on each other.
    p.push(format!("noobdb_sqlite_smoke_{}.db", std::process::id()));
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
    conn.execute("DROP TABLE IF EXISTS noobdb_sqlite_smoke", None)
        .await
        .expect("drop");
    conn.execute(
        "CREATE TABLE noobdb_sqlite_smoke (id INTEGER PRIMARY KEY, label TEXT NOT NULL)",
        None,
    )
    .await
    .expect("create");
    conn.execute(
        "INSERT INTO noobdb_sqlite_smoke (id, label) VALUES (1, 'a'), (2, 'b'), (3, 'c')",
        None,
    )
    .await
    .expect("insert");

    // Schema browser surfaces.
    let dbs = conn.databases().await.expect("databases");
    assert_eq!(dbs, vec!["main".to_string()]);
    let tables = conn.tables("main").await.expect("tables");
    assert!(tables.iter().any(|t| t == "noobdb_sqlite_smoke"));
    let cols = conn
        .columns("main", "noobdb_sqlite_smoke")
        .await
        .expect("columns");
    assert_eq!(cols.len(), 2);
    let id_col = cols.iter().find(|c| c.name == "id").expect("id column");
    assert_eq!(id_col.key, "PRI", "PK detection must mark id as PRI");

    // Whole-schema overview drives editor autocomplete: it must surface the
    // table with its column names in declaration order, in a single call.
    let overview = conn.schema_overview("main").await.expect("schema overview");
    let smoke = overview
        .iter()
        .find(|t| t.name == "noobdb_sqlite_smoke")
        .expect("overview must list the smoke table");
    assert_eq!(smoke.columns, vec!["id".to_string(), "label".to_string()]);

    let after_insert = conn
        .execute(
            "SELECT id, label FROM noobdb_sqlite_smoke ORDER BY id",
            None,
        )
        .await
        .expect("select after insert");
    assert_eq!(after_insert.rows.len(), 3);

    let upd = conn
        .execute(
            "UPDATE noobdb_sqlite_smoke SET label = 'B' WHERE id = 2",
            None,
        )
        .await
        .expect("update");
    assert_eq!(upd.rows_affected, 1);

    let del = conn
        .execute("DELETE FROM noobdb_sqlite_smoke WHERE id = 3", None)
        .await
        .expect("delete");
    assert_eq!(del.rows_affected, 1);

    let final_rows = conn
        .execute(
            "SELECT id, label FROM noobdb_sqlite_smoke ORDER BY id",
            None,
        )
        .await
        .expect("final select");
    assert_eq!(final_rows.rows.len(), 2);
    assert!(matches!(&final_rows.rows[1][1], t::Value::String(s) if s == "B"));

    // Preview must roll back.
    let preview = conn
        .preview_execute_with_limit(
            "UPDATE noobdb_sqlite_smoke SET label = 'rollback' WHERE id = 1",
            None,
            10,
        )
        .await
        .expect("preview");
    assert_eq!(preview.rows_affected, 1);
    assert_eq!(preview.target_table.as_deref(), Some("noobdb_sqlite_smoke"));
    let after_preview = conn
        .execute("SELECT label FROM noobdb_sqlite_smoke WHERE id = 1", None)
        .await
        .expect("post-preview select");
    assert!(
        matches!(&after_preview.rows[0][0], t::Value::String(s) if s == "a"),
        "preview must roll back; row 1 should still hold its original label"
    );

    conn.execute("DROP TABLE noobdb_sqlite_smoke", None)
        .await
        .expect("cleanup");
    conn.close().await;

    let _ = std::fs::remove_file(&path);
}

#[tokio::test]
async fn sqlite_table_row_estimates_are_empty() {
    // SQLite keeps no cheap row-count statistic, so the driver reports no
    // estimates regardless of how many rows a table holds — the tree shows no
    // count badge rather than paying for a COUNT(*) scan.
    let mut path = std::env::temp_dir();
    path.push(format!("noobdb_sqlite_est_{}.db", std::process::id()));
    let _ = std::fs::remove_file(&path);
    std::fs::File::create(&path).expect("create temp sqlite file");

    let opts = t::sqlite_options(path.to_str().expect("utf8 path"));
    let conn = t::connect(&opts).await.expect("connect");

    conn.execute(
        "CREATE TABLE est_t (id INTEGER PRIMARY KEY, label TEXT NOT NULL)",
        None,
    )
    .await
    .expect("create");
    conn.execute(
        "INSERT INTO est_t (id, label) VALUES (1, 'a'), (2, 'b'), (3, 'c')",
        None,
    )
    .await
    .expect("seed");

    let estimates = conn
        .table_row_estimates("main")
        .await
        .expect("table_row_estimates must not error");
    assert!(
        estimates.is_empty(),
        "SQLite has no cheap estimate; expected an empty list, got: {estimates:?}"
    );

    conn.close().await;
    let _ = std::fs::remove_file(&path);
}

#[tokio::test]
async fn sqlite_foreign_keys_are_introspected_for_er_diagram() {
    // The ER diagram is fed by `foreign_keys`: it must surface every FK in the
    // database (across all tables) with the referencing and referenced sides,
    // including a composite key folded under one constraint name.
    let mut path = std::env::temp_dir();
    path.push(format!("noobdb_sqlite_fk_{}.db", std::process::id()));
    let _ = std::fs::remove_file(&path);
    std::fs::File::create(&path).expect("create temp sqlite file");

    let opts = t::sqlite_options(path.to_str().expect("utf8 path"));
    let conn = t::connect(&opts).await.expect("connect");

    conn.execute(
        "CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT NOT NULL)",
        None,
    )
    .await
    .expect("create authors");
    // Single-column FK referencing an explicit column.
    conn.execute(
        "CREATE TABLE books (
           id INTEGER PRIMARY KEY,
           author_id INTEGER REFERENCES authors(id),
           title TEXT NOT NULL
         )",
        None,
    )
    .await
    .expect("create books");
    // Composite FK so we can assert both columns are grouped under one id.
    conn.execute(
        "CREATE TABLE chapters (
           book_id INTEGER,
           author_id INTEGER,
           seq INTEGER,
           PRIMARY KEY (book_id, seq),
           FOREIGN KEY (book_id, author_id) REFERENCES books(id, author_id)
         )",
        None,
    )
    .await
    .expect("create chapters");

    let fks = conn.foreign_keys("main").await.expect("foreign_keys");

    let books_fk: Vec<_> = fks.iter().filter(|f| f.table == "books").collect();
    assert_eq!(books_fk.len(), 1, "books has exactly one FK column");
    assert_eq!(books_fk[0].column, "author_id");
    assert_eq!(books_fk[0].referenced_table, "authors");
    assert_eq!(books_fk[0].referenced_column.as_deref(), Some("id"));

    let chapters_fk: Vec<_> = fks.iter().filter(|f| f.table == "chapters").collect();
    assert_eq!(
        chapters_fk.len(),
        2,
        "the composite FK contributes one entry per column"
    );
    assert!(chapters_fk.iter().all(|f| f.referenced_table == "books"));
    let constraint = chapters_fk[0].constraint_name.clone();
    assert!(
        constraint.is_some() && chapters_fk.iter().all(|f| f.constraint_name == constraint),
        "both columns of the composite key share one constraint name"
    );

    conn.close().await;
    let _ = std::fs::remove_file(&path);
}

#[tokio::test]
async fn sqlite_execute_transaction_is_all_or_nothing() {
    let mut path = std::env::temp_dir();
    path.push(format!("noobdb_sqlite_tx_{}.db", std::process::id()));
    let _ = std::fs::remove_file(&path);
    std::fs::File::create(&path).expect("create temp sqlite file");

    let opts = t::sqlite_options(path.to_str().expect("utf8 path"));
    let conn = t::connect(&opts).await.expect("connect");

    conn.execute(
        "CREATE TABLE noobdb_tx (id INTEGER PRIMARY KEY, label TEXT NOT NULL)",
        None,
    )
    .await
    .expect("create");
    conn.execute(
        "INSERT INTO noobdb_tx (id, label) VALUES (1, 'a'), (2, 'b')",
        None,
    )
    .await
    .expect("seed");

    // Happy path: two UPDATEs commit together and the affected counts add up.
    let affected = conn
        .execute_transaction(
            &[
                "UPDATE noobdb_tx SET label = 'A' WHERE id = 1".to_string(),
                "UPDATE noobdb_tx SET label = 'B' WHERE id = 2".to_string(),
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
                "UPDATE noobdb_tx SET label = 'X' WHERE id = 1".to_string(),
                "UPDATE noobdb_tx SET nonexistent = 'Y' WHERE id = 2".to_string(),
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
        .execute("SELECT id, label FROM noobdb_tx ORDER BY id", None)
        .await
        .expect("select after rollback");
    assert!(
        matches!(&rows.rows[0][1], t::Value::String(s) if s == "A"),
        "row 1 must keep the committed 'A' — the failed batch's 'X' must have rolled back"
    );
    assert!(matches!(&rows.rows[1][1], t::Value::String(s) if s == "B"));

    conn.execute("DROP TABLE noobdb_tx", None)
        .await
        .expect("cleanup");
    conn.close().await;
    let _ = std::fs::remove_file(&path);
}

#[tokio::test]
async fn sqlite_schema_compare_classifies_real_introspection() {
    // Two separate SQLite files standing in for "source" and "target" schemas.
    // Exercises the real `tables` + `columns` introspection feeding the diff,
    // not just the pure compute function: a shared identical table, a
    // source-only table, a target-only table, and a shared table whose column
    // set and a column type differ.
    let mk = |tag: &str| {
        let mut p = std::env::temp_dir();
        p.push(format!(
            "noobdb_sqlite_diff_{tag}_{}.db",
            std::process::id()
        ));
        p
    };
    let src_path = mk("src");
    let tgt_path = mk("tgt");
    for p in [&src_path, &tgt_path] {
        let _ = std::fs::remove_file(p);
        std::fs::File::create(p).expect("create temp sqlite file");
    }

    let src = t::connect(&t::sqlite_options(src_path.to_str().unwrap()))
        .await
        .expect("connect source");
    let tgt = t::connect(&t::sqlite_options(tgt_path.to_str().unwrap()))
        .await
        .expect("connect target");

    // Identical on both sides.
    for c in [&src, &tgt] {
        c.execute(
            "CREATE TABLE shared (id INTEGER PRIMARY KEY, name TEXT)",
            None,
        )
        .await
        .expect("create shared");
    }
    // Source-only table.
    src.execute("CREATE TABLE only_src (id INTEGER PRIMARY KEY)", None)
        .await
        .expect("create only_src");
    // Target-only table.
    tgt.execute("CREATE TABLE only_tgt (id INTEGER PRIMARY KEY)", None)
        .await
        .expect("create only_tgt");
    // Same table name, differing definitions: an added column on the source
    // and a differing type for `amount`.
    src.execute(
        "CREATE TABLE diffed (id INTEGER PRIMARY KEY, amount INTEGER, extra TEXT)",
        None,
    )
    .await
    .expect("create diffed source");
    tgt.execute(
        "CREATE TABLE diffed (id INTEGER PRIMARY KEY, amount TEXT)",
        None,
    )
    .await
    .expect("create diffed target");

    let diff = t::compare_schemas(&src, "main", &tgt, "main")
        .await
        .expect("compare");

    let by_name = |name: &str| {
        diff.tables
            .iter()
            .find(|tbl| tbl.name == name)
            .unwrap_or_else(|| panic!("missing table {name}"))
    };

    assert_eq!(by_name("shared").status, t::DiffStatus::Same);
    assert!(by_name("shared").columns.is_empty());
    assert_eq!(by_name("only_src").status, t::DiffStatus::SourceOnly);
    assert_eq!(by_name("only_tgt").status, t::DiffStatus::TargetOnly);

    let diffed = by_name("diffed");
    assert_eq!(diffed.status, t::DiffStatus::Different);
    let amount = diffed
        .columns
        .iter()
        .find(|c| c.name == "amount")
        .expect("amount column diff");
    assert_eq!(amount.status, t::DiffStatus::Different);
    assert!(amount.changed_fields.iter().any(|f| f == "data_type"));
    let extra = diffed
        .columns
        .iter()
        .find(|c| c.name == "extra")
        .expect("extra column diff");
    assert_eq!(extra.status, t::DiffStatus::SourceOnly);

    src.close().await;
    tgt.close().await;
    let _ = std::fs::remove_file(&src_path);
    let _ = std::fs::remove_file(&tgt_path);
}

#[tokio::test]
async fn sqlite_sync_plan_applied_makes_target_match_source() {
    // End-to-end phase-2 path on real SQLite: diff two schemas, generate the
    // reconciling DDL, apply it to the target in one transaction, then re-diff
    // and assert the schemas have converged.
    let mk = |tag: &str| {
        let mut p = std::env::temp_dir();
        p.push(format!(
            "noobdb_sqlite_sync_{tag}_{}.db",
            std::process::id()
        ));
        p
    };
    let src_path = mk("src");
    let tgt_path = mk("tgt");
    for p in [&src_path, &tgt_path] {
        let _ = std::fs::remove_file(p);
        std::fs::File::create(p).expect("create temp sqlite file");
    }

    let src = t::connect(&t::sqlite_options(src_path.to_str().unwrap()))
        .await
        .expect("connect source");
    let tgt = t::connect(&t::sqlite_options(tgt_path.to_str().unwrap()))
        .await
        .expect("connect target");

    // Source: a richer `users` table plus an extra table the target lacks.
    src.execute(
        "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)",
        None,
    )
    .await
    .expect("create users source");
    src.execute("CREATE TABLE only_src (id INTEGER PRIMARY KEY)", None)
        .await
        .expect("create only_src");
    // Target: `users` missing the `name` column and no `only_src` table.
    tgt.execute("CREATE TABLE users (id INTEGER PRIMARY KEY)", None)
        .await
        .expect("create users target");

    let plan = {
        let diff = t::compare_schemas(&src, "main", &tgt, "main")
            .await
            .expect("compare");
        t::generate_sync_sql(&diff, false)
    };
    // Expect: ADD COLUMN name (users) and CREATE TABLE only_src — no warnings.
    assert!(plan.warnings.is_empty(), "warnings: {:?}", plan.warnings);
    assert!(plan
        .statements
        .iter()
        .any(|s| s.kind == t::SyncKind::CreateTable && s.table == "only_src"));
    assert!(plan
        .statements
        .iter()
        .any(|s| s.kind == t::SyncKind::AddColumn && s.table == "users"));

    let sqls: Vec<String> = plan.statements.iter().map(|s| s.sql.clone()).collect();
    tgt.execute_transaction(&sqls, None)
        .await
        .expect("apply sync plan");

    // Re-diff: every table should now be identical.
    let after = t::compare_schemas(&src, "main", &tgt, "main")
        .await
        .expect("re-compare");
    assert!(
        after
            .tables
            .iter()
            .all(|tbl| tbl.status == t::DiffStatus::Same),
        "schemas should have converged, got: {:?}",
        after
            .tables
            .iter()
            .map(|tbl| (&tbl.name, tbl.status))
            .collect::<Vec<_>>()
    );

    src.close().await;
    tgt.close().await;
    let _ = std::fs::remove_file(&src_path);
    let _ = std::fs::remove_file(&tgt_path);
}

#[tokio::test]
async fn sqlite_data_sync_plan_applied_makes_rows_converge() {
    // End-to-end phase-3 path on real SQLite: pair rows by PK, generate the
    // reconciling DML (insert / update / delete), apply it, then re-diff and
    // assert the rows have converged.
    let mk = |tag: &str| {
        let mut p = std::env::temp_dir();
        p.push(format!(
            "noobdb_sqlite_data_{tag}_{}.db",
            std::process::id()
        ));
        p
    };
    let src_path = mk("src");
    let tgt_path = mk("tgt");
    for p in [&src_path, &tgt_path] {
        let _ = std::fs::remove_file(p);
        std::fs::File::create(p).expect("create temp sqlite file");
    }

    let src = t::connect(&t::sqlite_options(src_path.to_str().unwrap()))
        .await
        .expect("connect source");
    let tgt = t::connect(&t::sqlite_options(tgt_path.to_str().unwrap()))
        .await
        .expect("connect target");

    for c in [&src, &tgt] {
        c.execute(
            "CREATE TABLE scores (id INTEGER PRIMARY KEY, name TEXT, score INTEGER)",
            None,
        )
        .await
        .expect("create scores");
    }
    src.execute(
        "INSERT INTO scores (id, name, score) VALUES (1, 'a', 10), (2, 'b', 20), (3, 'c', 30)",
        None,
    )
    .await
    .expect("seed source");
    // Target: id=1 score differs, id=3 missing, id=4 extra.
    tgt.execute(
        "INSERT INTO scores (id, name, score) VALUES (1, 'a', 99), (2, 'b', 20), (4, 'd', 40)",
        None,
    )
    .await
    .expect("seed target");

    let columns = vec!["id".to_string(), "name".to_string(), "score".to_string()];
    let pk_idx = [0usize];
    let select = "SELECT id, name, score FROM scores ORDER BY id";

    let src_rows = src.execute(select, None).await.expect("read source").rows;
    let tgt_rows = tgt.execute(select, None).await.expect("read target").rows;
    let row_diffs = t::compute_data_diff(&columns, &pk_idx, &src_rows, &tgt_rows);
    // insert id=3, update id=1, delete id=4.
    assert_eq!(row_diffs.len(), 3);

    let diff = t::DataDiff {
        target_driver: t::DriverKind::Sqlite,
        table: "scores".to_string(),
        columns: columns.clone(),
        primary_key: vec!["id".to_string()],
        rows: row_diffs,
        truncated: false,
        source_count: src_rows.len(),
        target_count: tgt_rows.len(),
    };

    let plan = t::generate_data_sync_sql(&diff, true);
    let sqls: Vec<String> = plan.statements.iter().map(|s| s.sql.clone()).collect();
    assert_eq!(sqls.len(), 3, "insert + update + delete");
    tgt.execute_transaction(&sqls, None)
        .await
        .expect("apply data sync plan");

    // Re-diff: no differences should remain.
    let src_after = src
        .execute(select, None)
        .await
        .expect("re-read source")
        .rows;
    let tgt_after = tgt
        .execute(select, None)
        .await
        .expect("re-read target")
        .rows;
    let after = t::compute_data_diff(&columns, &pk_idx, &src_after, &tgt_after);
    assert!(
        after.is_empty(),
        "rows should have converged, got: {after:?}"
    );

    src.close().await;
    tgt.close().await;
    let _ = std::fs::remove_file(&src_path);
    let _ = std::fs::remove_file(&tgt_path);
}

#[tokio::test]
async fn sqlite_missing_path_reports_invalid_input() {
    // file_path = None should surface a clean error instead of panicking
    // somewhere inside sqlx.
    let opts = noobdb_lib::__test_api::DbConnectOptions {
        host: String::new(),
        port: 0,
        user: String::new(),
        password: String::new(),
        database: None,
        driver: noobdb_lib::__test_api::DriverKind::Sqlite,
        file_path: None,
    };
    let err = noobdb_lib::__test_api::connect(&opts)
        .await
        .err()
        .expect("missing file_path must error");
    let msg = err.to_string();
    assert!(
        msg.contains("file_path") || msg.contains("invalid input"),
        "unexpected error: {msg}"
    );
}

// ---------------------------------------------------------------------------
// read-only セッション強制 (IPC レベル) — Issue #288
//
// `is_read_only_sql` の単体テストは `db/mod.rs` にあるが、ここでは実際の
// クエリコマンド経路 (`run_query` / `run_query_transaction` / `import_csv` の
// コア) を `AppState` + read-only な `Session` で駆動し、書き込み系が
// `AppError::ReadOnly` で**ドライバに届く前に**拒否されることを確認する。
// SQLite ベースなので環境変数不要で常時実行され、ガードのリグレッション検出器
// として機能する。
// ---------------------------------------------------------------------------

/// 一意な一時 SQLite ファイルを作り、書き込み可能な接続でテーブルを 1 件用意して
/// パスを返すヘルパ。read-only テストは同じファイルに別接続で繋ぎ直す。
async fn seed_ro_fixture(tag: &str) -> PathBuf {
    let mut path = std::env::temp_dir();
    path.push(format!("noobdb_sqlite_ro_{tag}_{}.db", std::process::id()));
    let _ = std::fs::remove_file(&path);
    std::fs::File::create(&path).expect("create temp sqlite file");

    let conn = t::connect(&t::sqlite_options(path.to_str().unwrap()))
        .await
        .expect("connect (seed)");
    conn.execute(
        "CREATE TABLE ro_t (id INTEGER PRIMARY KEY, label TEXT NOT NULL)",
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

/// read-only セッションをファイルに対して開き、`AppState` に登録して返す。
async fn ro_state(path: &Path) -> (t::AppState, String) {
    let opts = t::sqlite_options(path.to_str().unwrap());
    let conn = t::connect(&opts)
        .await
        .expect("connect (read-only session)");
    let session = t::make_session("ro_sess", conn, opts, /* read_only */ true);
    let state = t::AppState::default();
    let sid = state.insert(session).await;
    (state, sid)
}

#[tokio::test]
async fn read_only_session_rejects_writes_via_ipc() {
    let path = seed_ro_fixture("rejects").await;
    let (state, sid) = ro_state(&path).await;

    // INSERT / UPDATE / DELETE / DDL はすべて read-only ガードで拒否される。
    for sql in [
        "INSERT INTO ro_t (id, label) VALUES (2, 'b')",
        "UPDATE ro_t SET label = 'z' WHERE id = 1",
        "DELETE FROM ro_t WHERE id = 1",
        "DROP TABLE ro_t",
        "CREATE TABLE evil (id INTEGER)",
        "TRUNCATE TABLE ro_t",
    ] {
        let err = t::run_query_via_command(&state, &sid, sql, None)
            .await
            .expect_err(&format!("read-only session must reject: {sql}"));
        assert!(
            matches!(err, t::AppError::ReadOnly(_)),
            "expected ReadOnly for `{sql}`, got: {err:?}"
        );
    }

    // ガードはドライバに到達する前に弾くので、データは一切変化していないはず。
    let verify = t::connect(&t::sqlite_options(path.to_str().unwrap()))
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

    let _ = std::fs::remove_file(&path);
}

#[tokio::test]
async fn read_only_session_allows_select_via_ipc() {
    let path = seed_ro_fixture("select").await;
    let (state, sid) = ro_state(&path).await;

    // 許可リストの文 (SELECT / WITH ... SELECT など) は通る。
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

    let _ = std::fs::remove_file(&path);
}

#[tokio::test]
async fn read_only_session_rejects_transaction_writes() {
    let path = seed_ro_fixture("tx").await;
    let (state, sid) = ro_state(&path).await;

    // バッチ内の 1 文でも書き込みがあれば、トランザクション全体が拒否される。
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
    .expect_err("read-only session must reject a transaction containing a write");
    assert!(
        matches!(err, t::AppError::ReadOnly(_)),
        "expected ReadOnly, got: {err:?}"
    );

    let _ = std::fs::remove_file(&path);
}

#[tokio::test]
async fn read_only_session_rejects_csv_import() {
    let path = seed_ro_fixture("import").await;
    let opts = t::sqlite_options(path.to_str().unwrap());
    let conn = t::connect(&opts).await.expect("connect");
    let session = t::make_session("ro_imp", conn, opts, /* read_only */ true);

    // `import_csv` が CSV 行を読む前に適用する read-only ガードを直接確認する。
    let err =
        t::ensure_import_writable(&session).expect_err("read-only session must reject CSV import");
    assert!(
        matches!(err, t::AppError::ReadOnly(_)),
        "expected ReadOnly, got: {err:?}"
    );

    session.conn.close().await;
    let _ = std::fs::remove_file(&path);
}

#[tokio::test]
async fn writable_session_allows_writes_via_ipc() {
    // ガードが過剰に広くないことの確認: read-only でないセッションでは書き込みが
    // コマンド経路を通って実際に成功する。
    let path = seed_ro_fixture("writable").await;
    let opts = t::sqlite_options(path.to_str().unwrap());
    let conn = t::connect(&opts).await.expect("connect");
    let session = t::make_session("rw_sess", conn, opts, /* read_only */ false);
    let state = t::AppState::default();
    let sid = state.insert(session).await;

    let res = t::run_query_via_command(
        &state,
        &sid,
        "INSERT INTO ro_t (id, label) VALUES (2, 'b')",
        None,
    )
    .await
    .expect("writable session must allow INSERT");
    assert_eq!(res.rows_affected, 1);

    assert!(t::ensure_import_writable(&t::make_session(
        "rw_imp",
        t::connect(&t::sqlite_options(path.to_str().unwrap()))
            .await
            .expect("connect"),
        t::sqlite_options(path.to_str().unwrap()),
        false,
    ))
    .is_ok());

    let _ = std::fs::remove_file(&path);
}
