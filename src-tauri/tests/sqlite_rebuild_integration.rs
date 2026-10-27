//! SQLite 構造エディタのテーブル再作成 (#1888) の統合テスト。
//!
//! `plan_table_rebuild` (編集内容 → 再作成 SQL) を実 SQLite に対して生成し、
//! `apply_sync_sql` の経路 (`apply_sync_sql_via_command`) で流して、列の型 / NOT NULL /
//! DEFAULT の変更と FK / CHECK の追加・削除でデータが保たれること、制約違反のときは
//! 1 トランザクションごとロールバックされて元の表が無傷で残ることを固定する。

use noobdb_lib::__test_api as t;
use t::{
    AppError, AppState, RebuildCheck, RebuildColumnEdit, RebuildForeignKey, RebuildForeignKeyRef,
    RebuildNewColumn, SqliteRebuildEdit, Value,
};

async fn temp_conn(tag: &str) -> (t::Connection, std::path::PathBuf) {
    let mut path = std::env::temp_dir();
    path.push(format!("noobdb_sqlrebuild_{tag}_{}.db", std::process::id()));
    let _ = std::fs::remove_file(&path);
    std::fs::File::create(&path).expect("create temp sqlite file");
    let conn = t::connect(&t::sqlite_options(path.to_str().unwrap()))
        .await
        .expect("connect sqlite");
    (conn, path)
}

async fn register(state: &AppState, id: &str, conn: t::Connection, read_only: bool) -> String {
    let opts = t::sqlite_options("unused-path-metadata-only");
    state
        .insert(t::make_session(id, conn, opts, read_only))
        .await
}

async fn exec(conn: &t::Connection, sql: &str) {
    conn.execute(sql, None)
        .await
        .unwrap_or_else(|e| panic!("{sql}: {e}"));
}

/// 1 列 1 行の結果を文字列にして返す (NULL は "NULL")。
async fn scalar(conn: &t::Connection, sql: &str) -> String {
    let r = conn.execute(sql, None).await.expect("query");
    match &r.rows[0][0] {
        Value::Null => "NULL".to_string(),
        Value::Int(n) => n.to_string(),
        Value::String(s) => s.clone(),
        other => format!("{other:?}"),
    }
}

fn col(name: &str, ty: &str, not_null: bool, default: Option<&str>) -> RebuildColumnEdit {
    RebuildColumnEdit {
        original: name.to_string(),
        name: name.to_string(),
        data_type: ty.to_string(),
        not_null,
        default: default.map(str::to_string),
        drop: false,
    }
}

/// 計画を作って `apply_sync_sql` の経路で流す。
async fn rebuild(
    state: &AppState,
    sid: &str,
    table: &str,
    edit: &SqliteRebuildEdit,
    extra: Vec<String>,
) -> Result<t::SqliteRebuildPlan, AppError> {
    let session = state.get(sid).await.expect("session");
    let plan = t::plan_table_rebuild(&session.conn, "main", table, edit).await?;
    let mut statements = vec![plan.sql.clone()];
    statements.extend(extra);
    t::apply_sync_sql_via_command(state, sid, Some("main"), statements).await?;
    Ok(plan)
}

async fn setup(tag: &str) -> (AppState, String, std::path::PathBuf) {
    let (conn, path) = temp_conn(tag).await;
    exec(
        &conn,
        "CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, qty TEXT DEFAULT '0', note TEXT)",
    )
    .await;
    exec(&conn, "CREATE INDEX idx_items_name ON items (name)").await;
    exec(
        &conn,
        "INSERT INTO items (name, qty, note) VALUES ('apple', '5', 'a'), ('pear', '12', NULL), ('fig', '7', 'c')",
    )
    .await;
    let state = AppState::default();
    let sid = register(&state, tag, conn, false).await;
    (state, sid, path)
}

#[tokio::test]
async fn type_not_null_and_default_changes_keep_the_data() {
    let (state, sid, path) = setup("types").await;
    let edit = SqliteRebuildEdit {
        columns: vec![
            col("id", "INTEGER", false, None),
            col("name", "TEXT", true, Some("'unknown'")),
            col("qty", "INTEGER", false, Some("0")),
            col("note", "TEXT", false, None),
        ],
        ..Default::default()
    };
    rebuild(&state, &sid, "items", &edit, vec![])
        .await
        .expect("rebuild");
    let conn = &state.get(&sid).await.unwrap().conn;

    assert_eq!(scalar(conn, "SELECT count(*) FROM items").await, "3");
    assert_eq!(
        scalar(conn, "SELECT sum(qty) FROM items").await,
        "24",
        "TEXT 列を INTEGER にすると値が数値へ変換される"
    );
    assert_eq!(
        scalar(conn, "SELECT typeof(qty) FROM items WHERE id = 2").await,
        "integer"
    );
    // 型・NOT NULL・DEFAULT が反映されている。
    let info = conn.columns("main", "items").await.unwrap();
    let find = |n: &str| info.iter().find(|c| c.name == n).unwrap().clone();
    assert_eq!(find("qty").data_type, "INTEGER");
    assert_eq!(find("qty").default.as_deref(), Some("0"));
    assert!(!find("name").nullable);
    assert_eq!(find("name").default.as_deref(), Some("'unknown'"));
    // 主キー / AUTOINCREMENT / インデックスが残る。
    let sql = scalar(conn, "SELECT sql FROM sqlite_master WHERE name = 'items'").await;
    assert!(sql.contains("AUTOINCREMENT"), "{sql}");
    assert_eq!(
        scalar(
            conn,
            "SELECT count(*) FROM sqlite_master WHERE name = 'idx_items_name'"
        )
        .await,
        "1"
    );
    exec(conn, "INSERT INTO items (qty) VALUES (1)").await;
    assert_eq!(
        scalar(conn, "SELECT name FROM items WHERE id = 4").await,
        "unknown"
    );
    let _ = std::fs::remove_file(&path);
}

#[tokio::test]
async fn not_null_over_existing_nulls_rolls_back_and_keeps_the_table() {
    let (state, sid, path) = setup("notnull").await;
    let edit = SqliteRebuildEdit {
        columns: vec![
            col("id", "INTEGER", false, None),
            col("name", "TEXT", false, None),
            col("qty", "TEXT", false, Some("'0'")),
            col("note", "TEXT", true, None), // note には NULL の行がある
        ],
        ..Default::default()
    };
    let res = rebuild(&state, &sid, "items", &edit, vec![]).await;
    assert!(res.is_err(), "NULL を含む列の NOT NULL 化は失敗するはず");
    let conn = &state.get(&sid).await.unwrap().conn;
    assert_eq!(scalar(conn, "SELECT count(*) FROM items").await, "3");
    assert_eq!(
        scalar(
            conn,
            "SELECT count(*) FROM sqlite_master WHERE name LIKE '__noobdb_rebuild_%'"
        )
        .await,
        "0",
        "一時テーブルが残らない"
    );
    assert_eq!(
        scalar(conn, "SELECT count(*) FROM items WHERE note IS NULL").await,
        "1"
    );
    // 接続の foreign_keys は元の値に戻っている。
    let _ = std::fs::remove_file(&path);
}

#[tokio::test]
async fn check_constraints_can_be_added_and_dropped() {
    let (state, sid, path) = setup("check").await;
    let all = |nn: bool| {
        vec![
            col("id", "INTEGER", false, None),
            col("name", "TEXT", nn, None),
            col("qty", "TEXT", false, Some("'0'")),
            col("note", "TEXT", false, None),
        ]
    };
    // 追加。
    let add = SqliteRebuildEdit {
        columns: all(false),
        added_checks: vec![RebuildCheck {
            name: Some("qty_nonneg".into()),
            expression: "CAST(qty AS INTEGER) >= 0".into(),
        }],
        ..Default::default()
    };
    rebuild(&state, &sid, "items", &add, vec![])
        .await
        .expect("add check");
    let conn = &state.get(&sid).await.unwrap().conn;
    assert_eq!(scalar(conn, "SELECT count(*) FROM items").await, "3");
    assert!(conn
        .execute("INSERT INTO items (name, qty) VALUES ('bad', '-1')", None)
        .await
        .is_err());
    let extras = conn.table_ddl_extras("main", "items").await.unwrap();
    assert_eq!(extras.checks.len(), 1);

    // 削除 (定義の空白・大小は問わない)。
    let drop = SqliteRebuildEdit {
        columns: all(false),
        dropped_checks: vec![extras.checks[0].1.clone()],
        ..Default::default()
    };
    rebuild(&state, &sid, "items", &drop, vec![])
        .await
        .expect("drop check");
    exec(
        conn,
        "INSERT INTO items (name, qty) VALUES ('ok-now', '-1')",
    )
    .await;
    assert!(conn
        .table_ddl_extras("main", "items")
        .await
        .unwrap()
        .checks
        .is_empty());
    let _ = std::fs::remove_file(&path);
}

#[tokio::test]
async fn check_violation_by_existing_rows_rolls_back() {
    let (state, sid, path) = setup("checkfail").await;
    let edit = SqliteRebuildEdit {
        columns: vec![
            col("id", "INTEGER", false, None),
            col("name", "TEXT", false, None),
            col("qty", "TEXT", false, Some("'0'")),
            col("note", "TEXT", false, None),
        ],
        added_checks: vec![RebuildCheck {
            name: None,
            expression: "length(name) > 5".into(), // 既存の 'fig' などが違反
        }],
        ..Default::default()
    };
    assert!(rebuild(&state, &sid, "items", &edit, vec![]).await.is_err());
    let conn = &state.get(&sid).await.unwrap().conn;
    assert_eq!(scalar(conn, "SELECT count(*) FROM items").await, "3");
    assert!(conn
        .table_ddl_extras("main", "items")
        .await
        .unwrap()
        .checks
        .is_empty());
    let _ = std::fs::remove_file(&path);
}

#[tokio::test]
async fn foreign_keys_can_be_added_and_dropped_and_violations_roll_back() {
    let (conn, path) = temp_conn("fk").await;
    exec(
        &conn,
        "CREATE TABLE owners (id INTEGER PRIMARY KEY, label TEXT)",
    )
    .await;
    exec(&conn, "INSERT INTO owners VALUES (1, 'a'), (2, 'b')").await;
    exec(
        &conn,
        "CREATE TABLE pets (id INTEGER PRIMARY KEY, owner_id INTEGER, name TEXT)",
    )
    .await;
    exec(&conn, "INSERT INTO pets VALUES (10, 1, 'x'), (11, 2, 'y')").await;
    let state = AppState::default();
    let sid = register(&state, "fk", conn, false).await;
    let cols = || {
        vec![
            col("id", "INTEGER", false, None),
            col("owner_id", "INTEGER", false, None),
            col("name", "TEXT", false, None),
        ]
    };
    let fk = || RebuildForeignKey {
        name: None,
        columns: vec!["owner_id".into()],
        ref_table: "owners".into(),
        ref_columns: vec!["id".into()],
        on_delete: Some("CASCADE".into()),
        on_update: None,
    };

    let add = SqliteRebuildEdit {
        columns: cols(),
        added_foreign_keys: vec![fk()],
        ..Default::default()
    };
    rebuild(&state, &sid, "pets", &add, vec![])
        .await
        .expect("add fk");
    let conn = &state.get(&sid).await.unwrap().conn;
    assert_eq!(scalar(conn, "SELECT count(*) FROM pets").await, "2");
    assert_eq!(
        scalar(conn, "SELECT count(*) FROM pragma_foreign_key_list('pets')").await,
        "1"
    );
    // 追加した FK が効く (ON DELETE CASCADE)。
    exec(conn, "PRAGMA foreign_keys = ON").await;
    exec(conn, "DELETE FROM owners WHERE id = 2").await;
    assert_eq!(scalar(conn, "SELECT count(*) FROM pets").await, "1");

    // 削除。
    let drop = SqliteRebuildEdit {
        columns: cols(),
        dropped_foreign_keys: vec![RebuildForeignKeyRef {
            columns: vec!["owner_id".into()],
            ref_table: "owners".into(),
        }],
        ..Default::default()
    };
    rebuild(&state, &sid, "pets", &drop, vec![])
        .await
        .expect("drop fk");
    assert_eq!(
        scalar(conn, "SELECT count(*) FROM pragma_foreign_key_list('pets')").await,
        "0"
    );

    // 既存行が FK に違反するときは失敗してロールバックする。
    exec(conn, "INSERT INTO pets VALUES (12, 99, 'orphan')").await;
    let res = rebuild(&state, &sid, "pets", &add, vec![]).await;
    assert!(res.is_err(), "孤児行があると FK の追加は失敗するはず");
    assert_eq!(scalar(conn, "SELECT count(*) FROM pets").await, "2");
    assert_eq!(
        scalar(conn, "SELECT count(*) FROM pragma_foreign_key_list('pets')").await,
        "0"
    );
    assert_eq!(
        scalar(
            conn,
            "SELECT count(*) FROM sqlite_master WHERE name LIKE '__noobdb_rebuild_%'"
        )
        .await,
        "0"
    );
    let _ = std::fs::remove_file(&path);
}

#[tokio::test]
async fn rebuilding_a_parent_keeps_child_rows_and_follows_a_column_rename() {
    let (conn, path) = temp_conn("parent").await;
    exec(
        &conn,
        "CREATE TABLE parent (id INTEGER PRIMARY KEY, code TEXT UNIQUE, v TEXT)",
    )
    .await;
    exec(
        &conn,
        "CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id) ON DELETE CASCADE)",
    )
    .await;
    exec(&conn, "CREATE INDEX idx_parent_v ON parent (v)").await;
    exec(
        &conn,
        "INSERT INTO parent VALUES (1, 'a', 'x'), (2, 'b', 'y')",
    )
    .await;
    exec(&conn, "INSERT INTO child VALUES (1, 1), (2, 1), (3, 2)").await;
    let state = AppState::default();
    let sid = register(&state, "parent", conn, false).await;

    // 型変更 + 参照されている主キー列の改名 + 索引つき列の改名 + 列の追加。
    let mut id = col("id", "INTEGER", false, None);
    id.name = "pid".into();
    let mut v = col("v", "TEXT", true, Some("'-'"));
    v.name = "value".into();
    let edit = SqliteRebuildEdit {
        columns: vec![id, col("code", "VARCHAR(10)", false, None), v],
        added_columns: vec![RebuildNewColumn {
            name: "extra".into(),
            data_type: "TEXT".into(),
            not_null: false,
            default: None,
        }],
        ..Default::default()
    };
    let plan = rebuild(&state, &sid, "parent", &edit, vec![])
        .await
        .expect("rebuild");
    assert!(plan.risks.iter().all(|r| r.target != "extra"));
    let conn = &state.get(&sid).await.unwrap().conn;
    assert_eq!(scalar(conn, "SELECT count(*) FROM parent").await, "2");
    assert_eq!(
        scalar(conn, "SELECT count(*) FROM child").await,
        "3",
        "子表の行は CASCADE で消えない"
    );
    assert_eq!(
        scalar(conn, "SELECT value FROM parent WHERE pid = 2").await,
        "y"
    );
    // UNIQUE と、改名した列の索引が残る。
    assert_eq!(
        scalar(
            conn,
            "SELECT count(*) FROM sqlite_master WHERE type = 'index' AND tbl_name = 'parent'"
        )
        .await,
        "2"
    );
    assert!(conn
        .execute(
            "INSERT INTO parent (pid, code, value) VALUES (3, 'a', 'z')",
            None
        )
        .await
        .is_err());
    // 子表の外部キーが改名後の列を指している。
    assert_eq!(
        scalar(conn, "SELECT \"to\" FROM pragma_foreign_key_list('child')").await,
        "pid"
    );
    exec(conn, "PRAGMA foreign_keys = ON").await;
    exec(conn, "DELETE FROM parent WHERE pid = 1").await;
    assert_eq!(scalar(conn, "SELECT count(*) FROM child").await, "1");
    let _ = std::fs::remove_file(&path);
}

#[tokio::test]
async fn dropping_a_column_and_creating_an_index_in_one_transaction() {
    let (state, sid, path) = setup("dropidx").await;
    let mut note = col("note", "TEXT", false, None);
    note.drop = true;
    let edit = SqliteRebuildEdit {
        columns: vec![
            col("id", "INTEGER", false, None),
            col("name", "TEXT", true, None),
            col("qty", "TEXT", false, Some("'0'")),
            note,
        ],
        ..Default::default()
    };
    let plan = rebuild(
        &state,
        &sid,
        "items",
        &edit,
        vec!["CREATE UNIQUE INDEX \"uq_items_name\" ON \"items\" (\"name\")".to_string()],
    )
    .await
    .expect("rebuild");
    assert!(plan.risks.iter().any(|r| r.target == "note"));
    let conn = &state.get(&sid).await.unwrap().conn;
    assert_eq!(
        scalar(conn, "SELECT count(*) FROM pragma_table_info('items')").await,
        "3"
    );
    assert_eq!(scalar(conn, "SELECT count(*) FROM items").await, "3");
    assert_eq!(
        scalar(
            conn,
            "SELECT count(*) FROM sqlite_master WHERE name = 'uq_items_name'"
        )
        .await,
        "1"
    );
    let _ = std::fs::remove_file(&path);
}

#[tokio::test]
async fn read_only_sessions_cannot_apply_the_rebuild_but_can_plan_it() {
    let (conn, path) = temp_conn("ro").await;
    exec(&conn, "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)").await;
    exec(&conn, "INSERT INTO t VALUES (1, 'a')").await;
    let state = AppState::default();
    let sid = register(&state, "ro", conn, true).await;
    let edit = SqliteRebuildEdit {
        columns: vec![
            col("id", "INTEGER", false, None),
            col("v", "TEXT", true, None),
        ],
        ..Default::default()
    };
    let res = rebuild(&state, &sid, "t", &edit, vec![]).await;
    assert!(matches!(res, Err(AppError::ReadOnly(_))), "{res:?}");
    let conn = &state.get(&sid).await.unwrap().conn;
    assert_eq!(
        scalar(
            conn,
            "SELECT count(*) FROM pragma_table_info('t') WHERE \"notnull\" = 1"
        )
        .await,
        "0"
    );
    let _ = std::fs::remove_file(&path);
}

#[tokio::test]
async fn rename_with_rebuild_keeps_triggers_and_views_and_rewrites_them() {
    let (conn, path) = temp_conn("renametrg").await;
    exec(
        &conn,
        "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, qty TEXT)",
    )
    .await;
    exec(&conn, "CREATE TABLE log (msg TEXT, name TEXT)").await;
    exec(&conn, "CREATE INDEX idx_t_name ON t (name)").await;
    exec(
        &conn,
        "CREATE TRIGGER trg_t AFTER INSERT ON t BEGIN INSERT INTO log (msg, name) VALUES ('added', NEW.name); END",
    )
    .await;
    exec(&conn, "CREATE VIEW v_t AS SELECT id, name FROM t").await;
    // 別の表の同名列だけを参照するビューは影響を受けない。
    exec(
        &conn,
        "CREATE VIEW v_log AS SELECT log.name FROM log, t WHERE 1 = 0",
    )
    .await;
    exec(&conn, "INSERT INTO t VALUES (1, 'a', '5')").await;
    let state = AppState::default();
    let sid = register(&state, "renametrg", conn, false).await;
    let mut name = col("name", "TEXT", true, None);
    name.name = "title".into();
    let edit = SqliteRebuildEdit {
        columns: vec![
            col("id", "INTEGER", false, None),
            name,
            col("qty", "INTEGER", false, None),
        ],
        ..Default::default()
    };
    rebuild(&state, &sid, "t", &edit, vec![])
        .await
        .expect("rebuild");
    let conn = &state.get(&sid).await.unwrap().conn;
    assert_eq!(scalar(conn, "SELECT title FROM t").await, "a");
    // トリガー・ビュー・索引が残り、新しい列名を指している。
    exec(conn, "INSERT INTO t (id, title, qty) VALUES (2, 'b', 1)").await;
    assert_eq!(
        scalar(conn, "SELECT count(*) FROM log WHERE name = 'b'").await,
        "1"
    );
    assert_eq!(
        scalar(conn, "SELECT title FROM v_t WHERE id = 2").await,
        "b"
    );
    assert_eq!(
        scalar(
            conn,
            "SELECT count(*) FROM sqlite_master WHERE name IN ('trg_t', 'v_t', 'v_log', 'idx_t_name')"
        )
        .await,
        "4"
    );
    assert!(scalar(
        conn,
        "SELECT sql FROM sqlite_master WHERE name = 'idx_t_name'"
    )
    .await
    .contains("title"));
    let _ = std::fs::remove_file(&path);
}

#[tokio::test]
async fn rename_and_drop_existing_constraints_in_one_rebuild() {
    let (conn, path) = temp_conn("renamedrop").await;
    exec(&conn, "CREATE TABLE owners (id INTEGER PRIMARY KEY)").await;
    exec(&conn, "INSERT INTO owners VALUES (1)").await;
    exec(
        &conn,
        "CREATE TABLE pets (id INTEGER PRIMARY KEY, owner_id INTEGER REFERENCES owners(id), name TEXT CHECK (length(name) > 0))",
    )
    .await;
    exec(&conn, "INSERT INTO pets VALUES (1, 1, 'x')").await;
    let state = AppState::default();
    let sid = register(&state, "renamedrop", conn, false).await;
    let checks = state
        .get(&sid)
        .await
        .unwrap()
        .conn
        .table_ddl_extras("main", "pets")
        .await
        .unwrap()
        .checks;
    let mut owner = col("owner_id", "INTEGER", false, None);
    owner.name = "owner".into();
    let mut name = col("name", "TEXT", false, None);
    name.name = "label".into();
    let edit = SqliteRebuildEdit {
        columns: vec![col("id", "INTEGER", false, None), owner, name],
        dropped_foreign_keys: vec![RebuildForeignKeyRef {
            columns: vec!["owner_id".into()],
            ref_table: "owners".into(),
        }],
        dropped_checks: vec![checks[0].1.clone()],
        ..Default::default()
    };
    rebuild(&state, &sid, "pets", &edit, vec![])
        .await
        .expect("rebuild");
    let conn = &state.get(&sid).await.unwrap().conn;
    assert_eq!(scalar(conn, "SELECT label FROM pets").await, "x");
    assert_eq!(
        scalar(conn, "SELECT count(*) FROM pragma_foreign_key_list('pets')").await,
        "0"
    );
    exec(
        conn,
        "INSERT INTO pets (id, owner, label) VALUES (2, 9, '')",
    )
    .await;
    let _ = std::fs::remove_file(&path);
}

#[tokio::test]
async fn rowid_of_tables_without_an_integer_primary_key_is_preserved() {
    let (conn, path) = temp_conn("rowid").await;
    exec(&conn, "CREATE TABLE t (code TEXT PRIMARY KEY, v TEXT)").await;
    exec(
        &conn,
        "INSERT INTO t (rowid, code, v) VALUES (10, 'a', '1'), (20, 'b', '2')",
    )
    .await;
    let state = AppState::default();
    let sid = register(&state, "rowid", conn, false).await;
    let edit = SqliteRebuildEdit {
        columns: vec![
            col("code", "TEXT", true, None),
            col("v", "INTEGER", false, None),
        ],
        ..Default::default()
    };
    rebuild(&state, &sid, "t", &edit, vec![])
        .await
        .expect("rebuild");
    let conn = &state.get(&sid).await.unwrap().conn;
    assert_eq!(
        scalar(conn, "SELECT rowid FROM t WHERE code = 'b'").await,
        "20"
    );
    let _ = std::fs::remove_file(&path);
}

#[tokio::test]
async fn a_trigger_on_another_table_that_uses_the_table_is_reported_before_running() {
    let (conn, path) = temp_conn("othertrg").await;
    exec(&conn, "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)").await;
    exec(&conn, "CREATE TABLE other (x INTEGER)").await;
    exec(
        &conn,
        "CREATE TRIGGER trg_other AFTER INSERT ON other BEGIN UPDATE t SET v = 'x'; END",
    )
    .await;
    let state = AppState::default();
    let sid = register(&state, "othertrg", conn, false).await;
    let edit = SqliteRebuildEdit {
        columns: vec![
            col("id", "INTEGER", false, None),
            col("v", "INTEGER", false, None),
        ],
        ..Default::default()
    };
    let err = rebuild(&state, &sid, "t", &edit, vec![]).await.unwrap_err();
    assert!(
        err.to_string()
            .contains("rebuild_error:other_table_trigger:trg_other"),
        "{err}"
    );
    let _ = std::fs::remove_file(&path);
}

/// 履歴に残る SQL を一意にするため、再作成 SQL の先頭に付けるコメント。
fn marked(tag: &str, sql: &str) -> String {
    format!("-- {tag}-{}\n{sql}", std::process::id())
}

async fn recorded_state(tag: &str, setup_sql: &[&str]) -> (AppState, String, std::path::PathBuf) {
    let (conn, path) = temp_conn(tag).await;
    for s in setup_sql {
        exec(&conn, s).await;
    }
    let opts = t::sqlite_options(path.to_str().unwrap());
    let state = AppState::default();
    let sid = state
        .insert(t::make_recording_session(tag, conn, opts))
        .await;
    (state, sid, path)
}

#[tokio::test]
async fn the_rebuild_command_records_history_on_success() {
    let tag = "histok";
    let (state, sid, path) =
        recorded_state(tag, &["CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)"]).await;
    let edit = SqliteRebuildEdit {
        columns: vec![
            col("id", "INTEGER", false, None),
            col("v", "TEXT", true, None),
        ],
        ..Default::default()
    };
    let session = state.get(&sid).await.unwrap();
    let plan = t::plan_table_rebuild(&session.conn, "main", "t", &edit)
        .await
        .unwrap();
    let sql = marked(tag, &plan.sql);
    t::apply_sqlite_table_rebuild_via_command(&state, &sid, Some("main"), vec![sql])
        .await
        .expect("apply");
    let hits = t::search_history_via_store(&format!("{tag}-{}", std::process::id())).await;
    assert!(hits.iter().any(|h| h.status == "ok"), "{hits:?}");
    let _ = std::fs::remove_file(&path);
}

#[tokio::test]
async fn the_rebuild_command_records_history_when_the_fk_check_rolls_back() {
    let tag = "histfk";
    let (state, sid, path) = recorded_state(
        tag,
        &[
            "CREATE TABLE owners (id INTEGER PRIMARY KEY)",
            "CREATE TABLE pets (id INTEGER PRIMARY KEY, owner INTEGER)",
            "INSERT INTO pets VALUES (1, 99)",
        ],
    )
    .await;
    let edit = SqliteRebuildEdit {
        columns: vec![
            col("id", "INTEGER", false, None),
            col("owner", "INTEGER", false, None),
        ],
        added_foreign_keys: vec![RebuildForeignKey {
            name: None,
            columns: vec!["owner".into()],
            ref_table: "owners".into(),
            ref_columns: vec!["id".into()],
            on_delete: None,
            on_update: None,
        }],
        ..Default::default()
    };
    let session = state.get(&sid).await.unwrap();
    let plan = t::plan_table_rebuild(&session.conn, "main", "pets", &edit)
        .await
        .unwrap();
    let sql = marked(tag, &plan.sql);
    let res =
        t::apply_sqlite_table_rebuild_via_command(&state, &sid, Some("main"), vec![sql]).await;
    assert!(res.is_err(), "{res:?}");
    assert_eq!(
        scalar(
            &session.conn,
            "SELECT count(*) FROM pragma_foreign_key_list('pets')"
        )
        .await,
        "0"
    );
    let hits = t::search_history_via_store(&format!("{tag}-{}", std::process::id())).await;
    assert!(hits.iter().any(|h| h.status == "error"), "{hits:?}");
    let _ = std::fs::remove_file(&path);
}

#[tokio::test]
async fn the_rebuild_command_rejects_read_only_and_empty_without_history() {
    let tag = "histro";
    let (conn, path) = temp_conn(tag).await;
    exec(&conn, "CREATE TABLE t (id INTEGER PRIMARY KEY)").await;
    let opts = t::sqlite_options(path.to_str().unwrap());
    let mut session = t::make_recording_session(tag, conn, opts);
    session.read_only = true;
    let state = AppState::default();
    let sid = state.insert(session).await;
    let sql = marked(tag, "DROP TABLE t");
    let res = t::apply_sqlite_table_rebuild_via_command(&state, &sid, None, vec![sql]).await;
    assert!(matches!(res, Err(AppError::ReadOnly(_))), "{res:?}");
    let hits = t::search_history_via_store(&format!("{tag}-{}", std::process::id())).await;
    assert!(hits.is_empty(), "{hits:?}");
    let _ = std::fs::remove_file(&path);

    let (state, sid, path) = recorded_state("histempty", &[]).await;
    let res = t::apply_sqlite_table_rebuild_via_command(&state, &sid, None, vec![]).await;
    assert!(matches!(res, Err(AppError::InvalidInput(_))), "{res:?}");
    let _ = std::fs::remove_file(&path);
}
