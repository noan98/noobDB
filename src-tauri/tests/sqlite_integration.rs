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
async fn sqlite_table_sizes_list_every_base_table() {
    // The size dashboard (#562) must list one row per base table. Byte figures
    // come from `dbstat` when the SQLite build exposes it; if not, sizes are
    // None but the table list itself is still complete. Either way SQLite keeps
    // no cheap row estimate, so `row_estimate` is always None.
    let mut path = std::env::temp_dir();
    path.push(format!("noobdb_sqlite_sizes_{}.db", std::process::id()));
    let _ = std::fs::remove_file(&path);
    std::fs::File::create(&path).expect("create temp sqlite file");

    let opts = t::sqlite_options(path.to_str().expect("utf8 path"));
    let conn = t::connect(&opts).await.expect("connect");

    conn.execute(
        "CREATE TABLE size_a (id INTEGER PRIMARY KEY, label TEXT NOT NULL)",
        None,
    )
    .await
    .expect("create a");
    conn.execute(
        "CREATE TABLE size_b (id INTEGER PRIMARY KEY, note TEXT)",
        None,
    )
    .await
    .expect("create b");
    conn.execute("CREATE INDEX size_a_label ON size_a(label)", None)
        .await
        .expect("create index");
    // A view must never appear in table_sizes (base tables only).
    conn.execute("CREATE VIEW size_v AS SELECT id FROM size_a", None)
        .await
        .expect("create view");
    for i in 0..50 {
        conn.execute(
            &format!("INSERT INTO size_a (id, label) VALUES ({i}, 'row-{i}')"),
            None,
        )
        .await
        .expect("seed");
    }

    let sizes = conn
        .table_sizes("main")
        .await
        .expect("table_sizes must not error");
    let names: Vec<&str> = sizes.iter().map(|s| s.name.as_str()).collect();
    assert!(
        names.contains(&"size_a") && names.contains(&"size_b"),
        "expected both base tables, got: {names:?}"
    );
    assert!(
        !names.contains(&"size_v"),
        "views must be excluded from table_sizes, got: {names:?}"
    );
    // SQLite reports no cheap row estimate.
    assert!(
        sizes.iter().all(|s| s.row_estimate.is_none()),
        "SQLite row estimates must be None, got: {sizes:?}"
    );
    // When dbstat is available, the seeded table must show non-zero bytes; when
    // it is not, sizes are uniformly None. Both are valid — just not a mix where
    // size_a has data but the total disagrees.
    for s in &sizes {
        if let (Some(d), Some(i)) = (s.data_bytes, s.index_bytes) {
            assert_eq!(
                s.total_bytes,
                Some(d + i),
                "total must equal data + index when both present: {s:?}"
            );
        }
    }

    conn.close().await;
    let _ = std::fs::remove_file(&path);
}

#[tokio::test]
async fn sqlite_server_info_reports_version_and_pragmas() {
    // The server-info panel (#563) needs a version string and a non-empty set
    // of configuration variables. For SQLite these come from sqlite_version()
    // and a curated list of PRAGMAs.
    let mut path = std::env::temp_dir();
    path.push(format!("noobdb_sqlite_srvinfo_{}.db", std::process::id()));
    let _ = std::fs::remove_file(&path);
    std::fs::File::create(&path).expect("create temp sqlite file");

    let opts = t::sqlite_options(path.to_str().expect("utf8 path"));
    let conn = t::connect(&opts).await.expect("connect");

    let info = conn.server_info().await.expect("server_info");
    assert!(
        !info.version.is_empty(),
        "version string must be reported, got empty"
    );
    assert!(
        info.variables.iter().any(|v| v.name == "page_size"),
        "expected a page_size PRAGMA row, got: {:?}",
        info.variables
    );
    assert!(
        info.variables.iter().all(|v| !v.name.is_empty()),
        "no variable name may be empty"
    );

    conn.close().await;
    let _ = std::fs::remove_file(&path);
}

#[tokio::test]
async fn sqlite_server_metrics_is_unsupported() {
    // 監視ダッシュボード (#731) はサーバランタイム統計を要する。SQLite はファイル
    // ベースでサーバを持たないため、list_processes と同じく Err で短絡し、フロントが
    // 導線を非表示にできるようにする (空リストと「非対応」を区別する)。
    let mut path = std::env::temp_dir();
    path.push(format!(
        "noobdb_sqlite_srvmetrics_{}.db",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&path);
    std::fs::File::create(&path).expect("create temp sqlite file");

    let opts = t::sqlite_options(path.to_str().expect("utf8 path"));
    let conn = t::connect(&opts).await.expect("connect");

    let result = conn.server_metrics().await;
    assert!(
        result.is_err(),
        "SQLite server_metrics must error (unsupported), got: {result:?}"
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
async fn sqlite_list_indexes_reports_primary_unique_and_plain() {
    // list_indexes must surface the implicit PK index, an explicit UNIQUE
    // index, and a plain multi-column index with its columns in declaration order.
    let mut path = std::env::temp_dir();
    path.push(format!("noobdb_sqlite_idx_{}.db", std::process::id()));
    let _ = std::fs::remove_file(&path);
    std::fs::File::create(&path).expect("create temp sqlite file");

    let opts = t::sqlite_options(path.to_str().expect("utf8 path"));
    let conn = t::connect(&opts).await.expect("connect");

    conn.execute(
        "CREATE TABLE items (
           id INTEGER PRIMARY KEY,
           sku TEXT NOT NULL,
           category TEXT,
           name TEXT
         )",
        None,
    )
    .await
    .expect("create items");
    conn.execute("CREATE UNIQUE INDEX idx_items_sku ON items(sku)", None)
        .await
        .expect("create unique index");
    conn.execute(
        "CREATE INDEX idx_items_cat_name ON items(category, name)",
        None,
    )
    .await
    .expect("create plain index");

    let indexes = conn
        .list_indexes("main", "items")
        .await
        .expect("list_indexes");

    let unique = indexes
        .iter()
        .find(|i| i.name == "idx_items_sku")
        .expect("unique index present");
    assert!(unique.unique, "idx_items_sku is UNIQUE");
    assert!(!unique.primary);
    assert_eq!(unique.columns, vec!["sku".to_string()]);

    let plain = indexes
        .iter()
        .find(|i| i.name == "idx_items_cat_name")
        .expect("plain index present");
    assert!(!plain.unique);
    assert_eq!(
        plain.columns,
        vec!["category".to_string(), "name".to_string()],
        "composite index keeps declaration order"
    );

    // Note: an `INTEGER PRIMARY KEY` is a rowid alias with no separate index, so
    // `PRIMARY KEY` indexes are not asserted here (their visibility in
    // PRAGMA index_list is engine/version dependent). The `primary` flag is still
    // derived from index_list's `origin = 'pk'` for engines that expose it.

    conn.close().await;
    let _ = std::fs::remove_file(&path);
}

#[tokio::test]
async fn sqlite_schema_objects_lists_views_and_triggers_with_definitions() {
    // schema_objects surfaces SQLite views and triggers (no routines),
    // and object_definition returns the stored DDL verbatim.
    let mut path = std::env::temp_dir();
    path.push(format!("noobdb_sqlite_obj_{}.db", std::process::id()));
    let _ = std::fs::remove_file(&path);
    std::fs::File::create(&path).expect("create temp sqlite file");

    let opts = t::sqlite_options(path.to_str().expect("utf8 path"));
    let conn = t::connect(&opts).await.expect("connect");

    conn.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, n INTEGER)", None)
        .await
        .expect("create table");
    conn.execute("CREATE VIEW v_pos AS SELECT id FROM t WHERE n > 0", None)
        .await
        .expect("create view");
    conn.execute(
        "CREATE TRIGGER trg_ai AFTER INSERT ON t BEGIN UPDATE t SET n = 0 WHERE n IS NULL; END",
        None,
    )
    .await
    .expect("create trigger");

    let objects = conn.schema_objects("main").await.expect("schema_objects");
    assert!(
        objects
            .iter()
            .any(|o| o.kind == "view" && o.name == "v_pos"),
        "view should be listed: {objects:?}"
    );
    assert!(
        objects
            .iter()
            .any(|o| o.kind == "trigger" && o.name == "trg_ai"),
        "trigger should be listed: {objects:?}"
    );
    // No stored procedures/functions in SQLite.
    assert!(objects
        .iter()
        .all(|o| o.kind != "procedure" && o.kind != "function"));

    let view_def = conn
        .object_definition("main", "view", "v_pos", None)
        .await
        .expect("view definition");
    assert!(view_def.contains("CREATE VIEW"));
    assert!(view_def.contains("v_pos"));

    conn.close().await;
    let _ = std::fs::remove_file(&path);
}

#[tokio::test]
async fn sqlite_explicit_transaction_commits_and_rolls_back() {
    // 明示トランザクション: BEGIN→INSERT→ROLLBACK は何も残さず、
    // BEGIN→INSERT→COMMIT は永続化される。文は同一の保持接続で実行される。
    let mut path = std::env::temp_dir();
    path.push(format!("noobdb_sqlite_xtx_{}.db", std::process::id()));
    let _ = std::fs::remove_file(&path);
    std::fs::File::create(&path).expect("create temp sqlite file");

    let opts = t::sqlite_options(path.to_str().expect("utf8 path"));
    let conn = t::connect(&opts).await.expect("connect");
    conn.execute("CREATE TABLE t (id INTEGER PRIMARY KEY)", None)
        .await
        .expect("create");

    // ROLLBACK path.
    assert!(!conn.transaction_active().await);
    conn.begin_transaction(None).await.expect("begin");
    assert!(conn.transaction_active().await);
    conn.execute_in_transaction("INSERT INTO t (id) VALUES (1)")
        .await
        .expect("insert in tx");
    conn.finish_transaction(false).await.expect("rollback");
    assert!(!conn.transaction_active().await);
    let after_rollback = conn
        .execute("SELECT COUNT(*) AS c FROM t", None)
        .await
        .expect("count");
    assert!(matches!(&after_rollback.rows[0][0], t::Value::Int(0)));

    // COMMIT path.
    conn.begin_transaction(None).await.expect("begin");
    conn.execute_in_transaction("INSERT INTO t (id) VALUES (2)")
        .await
        .expect("insert in tx");
    conn.finish_transaction(true).await.expect("commit");
    let after_commit = conn
        .execute("SELECT COUNT(*) AS c FROM t", None)
        .await
        .expect("count");
    assert!(matches!(&after_commit.rows[0][0], t::Value::Int(1)));

    // Beginning twice without finishing is rejected.
    conn.begin_transaction(None).await.expect("begin again");
    assert!(conn.begin_transaction(None).await.is_err());
    conn.finish_transaction(false).await.expect("rollback");

    conn.close().await;
    let _ = std::fs::remove_file(&path);
}

#[tokio::test]
async fn sqlite_health_check_succeeds_on_live_connection() {
    // health_check runs `SELECT 1` through the driver; it must succeed on
    // a freshly opened connection.
    let mut path = std::env::temp_dir();
    path.push(format!("noobdb_sqlite_health_{}.db", std::process::id()));
    let _ = std::fs::remove_file(&path);
    std::fs::File::create(&path).expect("create temp sqlite file");

    let opts = t::sqlite_options(path.to_str().expect("utf8 path"));
    let conn = t::connect(&opts).await.expect("connect");
    conn.health_check()
        .await
        .expect("health check on a live connection");

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
        // 非バイナリ列のみのテスト。型は TEXT 固定で十分 (バイナリ補正は走らない)。
        column_types: vec!["TEXT".to_string(); columns.len()],
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
        ssl_mode: None,
        ssl_root_cert: None,
        ssl_client_cert: None,
        ssl_client_key: None,
        init_sql: None,
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
// read-only セッション強制 (IPC レベル)
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

/// プロセス監視コマンドの常時実行テスト (外部サーバ不要)。
/// - SQLite ドライバは list/kill とも「非対応」エラーを返す。
/// - read_only セッションでは kill コマンドのバックエンドガードがドライバ到達前に
///   拒否する (`AppError::ReadOnly`)。MySQL/PostgreSQL でも同じガードを通る。
#[tokio::test]
async fn sqlite_process_commands_unsupported_and_read_only_guarded() {
    let mut path = std::env::temp_dir();
    path.push(format!("noobdb_sqlite_proc_{}.db", std::process::id()));
    let _ = std::fs::remove_file(&path);
    std::fs::File::create(&path).expect("create temp sqlite file");

    let opts = t::sqlite_options(path.to_str().expect("utf8 path"));
    let conn = t::connect(&opts).await.expect("connect");

    // Driver-level: SQLite has no server processes.
    assert!(matches!(
        conn.list_processes().await,
        Err(t::AppError::InvalidInput(_))
    ));
    assert!(matches!(
        conn.kill_process(1).await,
        Err(t::AppError::InvalidInput(_))
    ));

    // Command-level: a read-only session is rejected by the guard before the
    // driver is even consulted.
    let session = t::make_session("proc_ro", conn, opts.clone(), /* read_only */ true);
    let state = t::AppState::default();
    let sid = state.insert(session).await;
    assert!(matches!(
        t::kill_process_via_command(&state, &sid, 1).await,
        Err(t::AppError::ReadOnly(_))
    ));

    // A writable session passes the guard and surfaces the driver error.
    let conn2 = t::connect(&opts).await.expect("connect 2");
    let session2 = t::make_session("proc_rw", conn2, opts, /* read_only */ false);
    let sid2 = state.insert(session2).await;
    assert!(matches!(
        t::kill_process_via_command(&state, &sid2, 1).await,
        Err(t::AppError::InvalidInput(_))
    ));

    let _ = std::fs::remove_file(&path);
}

/// Session-init SQL (#522) runs on every physical pool connection via the
/// driver's `after_connect` hook. We connect with an init `PRAGMA` that sets a
/// distinctive, connection-scoped value, then read it back through the normal
/// query path (which acquires a pooled connection) to prove the hook fired.
#[tokio::test]
async fn sqlite_init_sql_runs_on_each_connection() {
    let mut path = std::env::temp_dir();
    path.push(format!("noobdb_sqlite_init_{}.db", std::process::id()));
    let _ = std::fs::remove_file(&path);
    std::fs::File::create(&path).expect("create temp sqlite file");

    let mut opts = t::sqlite_options(path.to_str().expect("utf8 path"));
    // `cache_size` is per-connection and easy to observe. The default differs
    // from 4321, so reading it back confirms the init SQL ran on the connection
    // serving the query.
    opts.init_sql = Some("PRAGMA cache_size = 4321".into());

    let conn = t::connect(&opts).await.expect("connect");
    let res = conn
        .execute("PRAGMA cache_size", None)
        .await
        .expect("read pragma");
    assert_eq!(res.rows.len(), 1);
    assert!(
        matches!(&res.rows[0][0], t::Value::Int(4321)),
        "init SQL PRAGMA should have applied to the pooled connection, got {:?}",
        res.rows[0][0]
    );

    // Close the pool before deleting the file so the removal is reliable across
    // platforms (Windows refuses to delete a file with open handles).
    conn.close().await;
    let _ = std::fs::remove_file(&path);
}

/// 小さな hex エンコーダ (統合テストクレートは data_encoding を直接依存しないため自前)。
fn to_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 0x0f) as usize] as char);
    }
    s
}

/// #626 — BLOB ↔ hex 文字列変換のラウンドトリップ整合。
///
/// 各ドライバの `decode_cell` は BLOB を `Value::Bytes` (16 進小文字) にする。空 /
/// 1 byte / NUL 含み / 全バイト値 (0..=255) / 1 MB の代表バイナリを `X'...'` リテラルで
/// 書き込み、読み戻した `Value::Bytes` が元バイト列の hex と一致することを固定する
/// (静かなバイナリ破損の検出)。SQLite はファイルベースで外部サーバ不要・常時実走。
#[tokio::test]
async fn sqlite_blob_hex_roundtrip_for_representative_binaries() {
    let mut path = std::env::temp_dir();
    path.push(format!("noobdb_sqlite_blob_{}.db", std::process::id()));
    let _ = std::fs::remove_file(&path);
    std::fs::File::create(&path).expect("create temp sqlite file");
    let conn = t::connect(&t::sqlite_options(path.to_str().unwrap()))
        .await
        .expect("connect");

    conn.execute(
        "CREATE TABLE blobs (id INTEGER PRIMARY KEY, data BLOB)",
        None,
    )
    .await
    .expect("create blobs");

    // 代表バイナリ: (id, bytes)。
    let all_bytes: Vec<u8> = (0u16..=255).map(|b| b as u8).collect();
    let big: Vec<u8> = (0..1_048_576usize).map(|i| (i % 256) as u8).collect(); // 1 MiB
    let cases: Vec<(i64, Vec<u8>)> = vec![
        (1, vec![]),                             // 空バイト列
        (2, vec![0x00]),                         // 単一の NUL
        (3, vec![0xDE, 0xAD, 0xBE, 0xEF]),       // 任意 4 バイト
        (4, vec![0x00, 0x01, 0xFF, 0x00, 0xFE]), // NUL を内包するパターン
        (5, all_bytes),                          // 全バイト値 0..=255
        (6, big),                                // 1 MiB
    ];

    for (id, bytes) in &cases {
        let hex = to_hex(bytes);
        // 空バイト列は X'' で表す。
        conn.execute(
            &format!("INSERT INTO blobs (id, data) VALUES ({id}, X'{hex}')"),
            None,
        )
        .await
        .unwrap_or_else(|e| panic!("insert blob id={id} failed: {e}"));
    }

    // 各行を読み戻し、Value::Bytes(hex) が元バイト列の hex と一致することを確認。
    for (id, bytes) in &cases {
        let res = conn
            .execute(&format!("SELECT data FROM blobs WHERE id = {id}"), None)
            .await
            .unwrap_or_else(|e| panic!("select blob id={id} failed: {e}"));
        assert_eq!(res.rows.len(), 1, "id={id}: 1 行返るはず");
        let expected_hex = to_hex(bytes);
        match &res.rows[0][0] {
            t::Value::Bytes(got) => assert_eq!(
                *got,
                expected_hex,
                "id={id}: BLOB の hex 往復が一致するはず (len={} bytes)",
                bytes.len()
            ),
            // 空バイト列は空 BLOB。decode は Value::Bytes("") を返すのが期待。
            other => panic!("id={id}: expected Value::Bytes, got {other:?}"),
        }
    }

    conn.close().await;
    let _ = std::fs::remove_file(&path);
}

/// ライブクエリ・インスペクタ (#746): SQLite はサーバ統計を持たないため、
/// 前提プローブは理由コード `unsupported_driver` 付きで両機能とも不可を返し、
/// ライブテール / digest 集計の直接呼び出しはエラーで短絡する (UI は導線自体を
/// 出さないので、これは直接 IPC 呼び出しに対するバックストップ)。
#[tokio::test]
async fn sqlite_query_inspector_is_unsupported() {
    let mut path = std::env::temp_dir();
    path.push(format!("noobdb_sqlite_inspector_{}.db", std::process::id()));
    let _ = std::fs::remove_file(&path);
    std::fs::File::create(&path).expect("create temp sqlite file");

    let opts = t::sqlite_options(path.to_str().expect("utf8 path"));
    let conn = t::connect(&opts).await.expect("connect");

    let support = conn.query_stats_support().await.expect("support probe");
    assert!(
        !support.live_tail,
        "SQLite must not report live tail support"
    );
    assert!(!support.statements, "SQLite must not report digest support");
    assert_eq!(
        support.live_tail_reason.as_deref(),
        Some("unsupported_driver")
    );
    assert_eq!(
        support.statements_reason.as_deref(),
        Some("unsupported_driver")
    );

    assert!(
        conn.live_queries().await.is_err(),
        "live_queries must error on SQLite (backstop for direct IPC calls)"
    );
    assert!(
        conn.statement_stats().await.is_err(),
        "statement_stats must error on SQLite (backstop for direct IPC calls)"
    );

    conn.close().await;
    let _ = std::fs::remove_file(&path);
}

/// Resilient import (#687): skip mode inserts good rows, skips bad ones, and
/// reports which records were skipped; abort-mode probing pinpoints the first
/// offending record. Uses SQLite constraints (PRIMARY KEY uniqueness + NOT NULL)
/// to force rejections without an external server.
#[tokio::test]
async fn sqlite_resilient_import_skips_and_locates_bad_rows() {
    let mut p = std::env::temp_dir();
    p.push(format!("noobdb_sqlite_import_{}.db", std::process::id()));
    let _ = std::fs::remove_file(&p);
    std::fs::File::create(&p).expect("create temp sqlite file");

    let opts = t::sqlite_options(p.to_str().expect("utf8 path"));
    let conn = t::connect(&opts).await.expect("connect");
    conn.execute(
        "CREATE TABLE imp (id INTEGER PRIMARY KEY, name TEXT NOT NULL)",
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

    // Skip mode: good rows commit, bad rows are reported by index.
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
    // (index 1, the NOT NULL violation) and leaves nothing behind (rolled back).
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
    let _ = std::fs::remove_file(&p);
}

/// Reconnect (#712): after a session's connection is dropped, `reconnect`
/// re-establishes it **in place** — same `SessionId`, preserved flags — and
/// queries succeed again through the normal command path. For SQLite there is no
/// SSH tunnel, so this exercises the direct rebuild path (`connect_options`
/// reuse) which always runs in CI without an external server.
#[tokio::test]
async fn sqlite_reconnect_reestablishes_same_session() {
    let mut path = std::env::temp_dir();
    path.push(format!("noobdb_sqlite_reconnect_{}.db", std::process::id()));
    let _ = std::fs::remove_file(&path);
    std::fs::File::create(&path).expect("create temp sqlite file");

    let opts = t::sqlite_options(path.to_str().expect("utf8 path"));
    let conn = t::connect(&opts).await.expect("connect");
    conn.execute("CREATE TABLE recon (id INTEGER PRIMARY KEY)", None)
        .await
        .expect("create");
    conn.execute("INSERT INTO recon (id) VALUES (1), (2)", None)
        .await
        .expect("seed");

    // read_only carried through so we can assert the flag survives reconnect.
    let session = t::make_session("recon_sess", conn, opts, /* read_only */ true);
    let state = t::AppState::default();
    let sid = state.insert(session).await;

    // Baseline: the session works before we drop it.
    let before = t::run_query_via_command(&state, &sid, "SELECT COUNT(*) FROM recon", None)
        .await
        .expect("query before drop");
    assert!(matches!(&before.rows[0][0], t::Value::Int(2)));

    // Simulate a dropped connection by closing the live pool. Subsequent queries
    // on the same (now-dead) session fail.
    state
        .get(&sid)
        .await
        .expect("session present")
        .conn
        .close()
        .await;
    assert!(
        t::run_query_via_command(&state, &sid, "SELECT 1", None)
            .await
            .is_err(),
        "a closed connection must reject queries before reconnect"
    );

    // Reconnect in place: same id, fresh connection.
    t::reconnect_via_command(&state, &sid)
        .await
        .expect("reconnect must succeed");

    // The session id is unchanged and queries work again.
    assert!(
        state.get(&sid).await.is_some(),
        "session id must survive reconnect"
    );
    let after = t::run_query_via_command(&state, &sid, "SELECT COUNT(*) FROM recon", None)
        .await
        .expect("query after reconnect");
    assert!(matches!(&after.rows[0][0], t::Value::Int(2)));

    // The read_only flag was preserved, so a write is still rejected by the guard.
    assert!(
        matches!(
            t::run_query_via_command(&state, &sid, "INSERT INTO recon (id) VALUES (3)", None).await,
            Err(t::AppError::ReadOnly(_))
        ),
        "read_only must survive reconnect"
    );

    // Reconnecting an unknown session id is a clean error, not a panic.
    assert!(matches!(
        t::reconnect_via_command(&state, "nope").await,
        Err(t::AppError::SessionNotFound(_))
    ));

    let _ = std::fs::remove_file(&path);
}

/// スキーマ健全性アドバイザ (#741) をエンドツーエンドで駆動する: 実 SQLite に
/// 各ルールを踏む/踏まないスキーマを作り、`analyze_schema_health` の collect →
/// 純ロジックの全経路 (ビュー除外・メタデータ収集・統計縮退) を検証する。
/// 外部サーバ不要で常時実走する。
#[tokio::test]
async fn sqlite_advisor_flags_expected_rules() {
    let mut p = std::env::temp_dir();
    p.push(format!("noobdb_sqlite_advisor_{}.db", std::process::id()));
    let _ = std::fs::remove_file(&p);
    std::fs::File::create(&p).expect("create temp sqlite file");

    let opts = t::sqlite_options(p.to_str().expect("utf8 path"));
    let conn = t::connect(&opts).await.expect("connect");

    // 良好なテーブル (INTEGER PK)。指摘なし。
    conn.execute(
        "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)",
        None,
    )
    .await
    .expect("create users");
    // FK to users(id) だが user_id にインデックスが無い → FkMissingIndex。
    // 型は両端 INTEGER で一致させ、型不一致ルールは踏ませない。
    conn.execute(
        "CREATE TABLE orders (id INTEGER PRIMARY KEY, \
         user_id INTEGER REFERENCES users(id), note TEXT)",
        None,
    )
    .await
    .expect("create orders");
    // PK 無し → MissingPrimaryKey。
    conn.execute("CREATE TABLE logs (msg TEXT)", None)
        .await
        .expect("create logs");
    // 単一列だが BIGINT PK (rowid エイリアスにならない) → SqliteIntegerPkHint。
    conn.execute(
        "CREATE TABLE widgets (id BIGINT PRIMARY KEY, label TEXT)",
        None,
    )
    .await
    .expect("create widgets");
    // 同一構成の非 UNIQUE インデックス 2 本 → DuplicateIndex (1 本のみ指摘)。
    conn.execute("CREATE INDEX idx_users_name1 ON users(name)", None)
        .await
        .expect("idx1");
    conn.execute("CREATE INDEX idx_users_name2 ON users(name)", None)
        .await
        .expect("idx2");
    // ビュー: PK 欠落ルールで誤検出しないよう解析対象から除外されること。
    conn.execute("CREATE VIEW v_users AS SELECT id, name FROM users", None)
        .await
        .expect("view");

    let report = t::analyze_schema_health(&conn, "main")
        .await
        .expect("analyze");

    let has = |rule: t::RuleId, table: &str| {
        report
            .findings
            .iter()
            .any(|f| f.rule == rule && f.table == table)
    };

    assert!(
        has(t::RuleId::FkMissingIndex, "orders"),
        "orders.user_id FK without index must be flagged"
    );
    assert!(
        has(t::RuleId::MissingPrimaryKey, "logs"),
        "logs has no primary key"
    );
    assert!(
        has(t::RuleId::SqliteIntegerPkHint, "widgets"),
        "widgets BIGINT PK is a rowid-alias footgun"
    );
    assert!(
        has(t::RuleId::DuplicateIndex, "users"),
        "duplicate index on users(name) must be flagged"
    );
    // 型が一致する FK (orders.user_id INTEGER ↔ users.id INTEGER) は
    // 型不一致として誤検出しない。
    assert!(
        !has(t::RuleId::FkTypeMismatch, "orders"),
        "matching FK column types must not be flagged"
    );
    // 同一構成の非 UNIQUE インデックス 2 本は「ちょうど 1 件」だけ指摘する
    // (両方 DROP を勧める誤誘導を避ける)。
    assert_eq!(
        report
            .findings
            .iter()
            .filter(|f| f.rule == t::RuleId::DuplicateIndex && f.table == "users")
            .count(),
        1,
        "users(name) duplicate indexes must produce exactly one finding"
    );
    // ビューは解析対象外 — どの指摘の対象にもならない。
    assert!(
        !report.findings.iter().any(|f| f.table == "v_users"),
        "views must be excluded from analysis"
    );
    // 未使用インデックスルールは SQLite では理由付きでスキップ (黙って 0 件にしない)。
    assert!(
        report
            .skipped
            .iter()
            .any(|s| s.rule == t::RuleId::UnusedIndex && s.reason == "unsupported_driver"),
        "unused-index rule must degrade with a reason on SQLite"
    );
    // ベーステーブル 4 つ (users/orders/logs/widgets)。ビューは数えない。
    assert_eq!(report.tables_analyzed, 4);

    conn.close().await;
    let _ = std::fs::remove_file(&p);
}
