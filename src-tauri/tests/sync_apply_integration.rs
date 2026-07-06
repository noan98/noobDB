//! `commands::sync::apply_sync_sql` の IPC 層統合テスト (#639)。
//!
//! `diff_sync_golden.rs` は純粋生成 (`generate_sync_sql` /
//! `generate_data_sync_sql`) と `db::Connection` 直接適用を固定するが、**コマンド層
//! (`apply_sync_sql`) の破壊的書き込みガード** — 読み取り専用ターゲットの拒否、
//! `allow_destructive` / `allow_delete` 未指定時に該当文が適用されないこと、正常系で
//! 生成 SQL が `SyncPlan` の順序どおりターゲットへ反映されること — は未検証だった。
//!
//! ここでは `__test_api::apply_sync_sql_via_command` (Tauri State 不要で
//! `apply_sync_sql_inner` を駆動) を通し、実 SQLite ターゲットに対してこれらの
//! 不変条件を固定する。SQLite を軸にするため外部サーバ不要で常時実走する。
//! MySQL/PostgreSQL 固有の適用方針 (all-or-nothing vs best-effort 逐次) は #640 が
//! 別途担う。

use noobdb_lib::__test_api as t;
use t::{AppError, AppState, DataDiff, DriverKind, SyncKind, Value};

/// 一意な一時 SQLite ファイルへ接続する。
async fn temp_conn(tag: &str) -> (t::Connection, std::path::PathBuf) {
    let mut path = std::env::temp_dir();
    path.push(format!(
        "noobdb_syncapply_{tag}_{}_{}.db",
        std::process::id(),
        tag
    ));
    let _ = std::fs::remove_file(&path);
    std::fs::File::create(&path).expect("create temp sqlite file");
    let conn = t::connect(&t::sqlite_options(path.to_str().unwrap()))
        .await
        .expect("connect sqlite");
    (conn, path)
}

/// `state` に `read_only` フラグ付きでセッションを登録し、その id を返す。
async fn register(state: &AppState, id: &str, conn: t::Connection, read_only: bool) -> String {
    let opts = t::sqlite_options("unused-path-metadata-only");
    state
        .insert(t::make_session(id, conn, opts, read_only))
        .await
}

/// テーブルの行数を返す小ヘルパ。
async fn count(conn: &t::Connection, table: &str) -> i64 {
    let r = conn
        .execute(&format!("SELECT count(*) FROM {table}"), None)
        .await
        .expect("count query");
    match &r.rows[0][0] {
        Value::Int(n) => *n,
        other => panic!("expected int count, got {other:?}"),
    }
}

/// 指定テーブルが存在するか (sqlite_master 参照)。
async fn table_exists(conn: &t::Connection, table: &str) -> bool {
    let r = conn
        .execute(
            &format!("SELECT name FROM sqlite_master WHERE type='table' AND name='{table}'"),
            None,
        )
        .await
        .expect("sqlite_master query");
    !r.rows.is_empty()
}

// ---------------------------------------------------------------------------
// 読み取り専用ガード: ターゲットが read_only なら拒否し、何も変えない
// ---------------------------------------------------------------------------

#[tokio::test]
async fn read_only_target_rejects_apply_and_leaves_target_unchanged() {
    let (conn, path) = temp_conn("ro").await;
    conn.execute("CREATE TABLE t (id INTEGER PRIMARY KEY)", None)
        .await
        .expect("create t");
    conn.execute("INSERT INTO t (id) VALUES (1), (2)", None)
        .await
        .expect("seed t");

    let state = AppState::default();
    let sid = register(&state, "ro-sess", conn, /* read_only */ true).await;

    // 破壊的な文を投げても read_only で弾かれる。
    let res = t::apply_sync_sql_via_command(
        &state,
        &sid,
        None,
        vec!["DELETE FROM t".to_string(), "DROP TABLE t".to_string()],
    )
    .await;
    assert!(
        matches!(res, Err(AppError::ReadOnly(_))),
        "read_only ターゲットへの apply は ReadOnly で拒否されるはず: {res:?}"
    );

    // ターゲットは一切変化していない (テーブルも行も残る)。
    let session = state.get(&sid).await.expect("session still present");
    assert!(table_exists(&session.conn, "t").await, "t は残るはず");
    assert_eq!(count(&session.conn, "t").await, 2, "行は変化しないはず");

    let _ = std::fs::remove_file(&path);
}

// ---------------------------------------------------------------------------
// 空文リスト: InvalidInput で拒否
// ---------------------------------------------------------------------------

#[tokio::test]
async fn empty_statements_are_rejected() {
    let (conn, path) = temp_conn("empty").await;
    let state = AppState::default();
    let sid = register(&state, "empty-sess", conn, false).await;

    let res = t::apply_sync_sql_via_command(&state, &sid, None, vec![]).await;
    assert!(
        matches!(res, Err(AppError::InvalidInput(_))),
        "空の文リストは InvalidInput で拒否されるはず: {res:?}"
    );

    let _ = std::fs::remove_file(&path);
}

// ---------------------------------------------------------------------------
// 存在しないセッション: SessionNotFound
// ---------------------------------------------------------------------------

#[tokio::test]
async fn missing_session_is_rejected() {
    let state = AppState::default();
    let res =
        t::apply_sync_sql_via_command(&state, "does-not-exist", None, vec!["SELECT 1".to_string()])
            .await;
    assert!(
        matches!(res, Err(AppError::SessionNotFound(_))),
        "未登録セッションは SessionNotFound になるはず: {res:?}"
    );
}

// ---------------------------------------------------------------------------
// 正常系: 生成 SQL が SyncPlan の順序どおりターゲットへ反映される
// ---------------------------------------------------------------------------

#[tokio::test]
async fn normal_apply_reflects_generated_schema_sql_in_order() {
    // source: items(id, name, price) + only_src、target: items(id, name) のみ。
    let (src, src_path) = temp_conn("okapply_src").await;
    let (tgt, tgt_path) = temp_conn("okapply_tgt").await;

    src.execute(
        "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, price INTEGER)",
        None,
    )
    .await
    .expect("create items src");
    src.execute("CREATE TABLE only_src (id INTEGER PRIMARY KEY)", None)
        .await
        .expect("create only_src");
    tgt.execute(
        "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)",
        None,
    )
    .await
    .expect("create items tgt");

    let diff = t::compare_schemas(&src, "main", &tgt, "main")
        .await
        .expect("compare");
    let plan = t::generate_sync_sql(&diff, /* allow_destructive */ false);
    let sqls: Vec<String> = plan.statements.iter().map(|s| s.sql.clone()).collect();

    // 順序契約: CreateTable (order 0) が AddColumn (order 1) より前に来る。
    let create_pos = plan
        .statements
        .iter()
        .position(|s| s.kind == SyncKind::CreateTable);
    let add_pos = plan
        .statements
        .iter()
        .position(|s| s.kind == SyncKind::AddColumn);
    if let (Some(c), Some(a)) = (create_pos, add_pos) {
        assert!(c < a, "CREATE TABLE は ADD COLUMN より前に適用されるはず");
    }

    let state = AppState::default();
    let sid = register(&state, "ok-sess", tgt, false).await;
    let affected = t::apply_sync_sql_via_command(&state, &sid, None, sqls)
        .await
        .expect("apply should succeed");
    // DDL は rows_affected を持たない (0 でも可)。ここでは適用が成功したことだけ確認。
    let _ = affected;

    // ターゲットに変更が反映されている: only_src が作られ、items に price 列が増えた。
    let session = state.get(&sid).await.expect("session");
    assert!(
        table_exists(&session.conn, "only_src").await,
        "only_src がターゲットに作成されるはず"
    );
    // price 列があれば SELECT price が成功する。
    session
        .conn
        .execute("SELECT price FROM items", None)
        .await
        .expect("price 列が追加されているはず");

    // 再 diff で items / only_src が収束していること (Same)。
    let diff2 = t::compare_schemas(&src, "main", &session.conn, "main")
        .await
        .expect("re-compare");
    let items = diff2
        .tables
        .iter()
        .find(|tb| tb.name == "items")
        .expect("items diff");
    assert_eq!(
        items.status,
        t::DiffStatus::Same,
        "items が収束するはず: {items:?}"
    );

    let _ = std::fs::remove_file(&src_path);
    let _ = std::fs::remove_file(&tgt_path);
}

// ---------------------------------------------------------------------------
// allow_destructive: false のとき DROP TABLE が生成されず、適用しても残る
// ---------------------------------------------------------------------------

#[tokio::test]
async fn allow_destructive_gates_drop_table_through_command() {
    // source: keep のみ、target: extra のみ。
    //   allow_destructive=false → CREATE keep のみ (extra は DROP されない)。
    //   allow_destructive=true  → CREATE keep + DROP extra。
    let build = || async {
        let (src, src_path) = temp_conn("drop_src").await;
        src.execute("CREATE TABLE keep (id INTEGER PRIMARY KEY)", None)
            .await
            .expect("create keep");
        (src, src_path)
    };

    // --- allow_destructive = false ---
    {
        let (src, src_path) = build().await;
        let (tgt, tgt_path) = temp_conn("drop_tgt_false").await;
        tgt.execute("CREATE TABLE extra (id INTEGER PRIMARY KEY)", None)
            .await
            .expect("create extra");

        let diff = t::compare_schemas(&src, "main", &tgt, "main")
            .await
            .expect("compare");
        let plan = t::generate_sync_sql(&diff, false);
        assert!(
            !plan
                .statements
                .iter()
                .any(|s| s.kind == SyncKind::DropTable),
            "allow_destructive=false では DROP TABLE を生成しないはず"
        );
        let sqls: Vec<String> = plan.statements.iter().map(|s| s.sql.clone()).collect();

        let state = AppState::default();
        let sid = register(&state, "drop-false", tgt, false).await;
        t::apply_sync_sql_via_command(&state, &sid, None, sqls)
            .await
            .expect("apply (create keep)");

        let session = state.get(&sid).await.expect("session");
        assert!(
            table_exists(&session.conn, "extra").await,
            "allow_destructive=false では extra が残るはず"
        );
        assert!(
            table_exists(&session.conn, "keep").await,
            "keep は作成されるはず"
        );
        let _ = std::fs::remove_file(&src_path);
        let _ = std::fs::remove_file(&tgt_path);
    }

    // --- allow_destructive = true ---
    {
        let (src, src_path) = build().await;
        let (tgt, tgt_path) = temp_conn("drop_tgt_true").await;
        tgt.execute("CREATE TABLE extra (id INTEGER PRIMARY KEY)", None)
            .await
            .expect("create extra");

        let diff = t::compare_schemas(&src, "main", &tgt, "main")
            .await
            .expect("compare");
        let plan = t::generate_sync_sql(&diff, true);
        assert!(
            plan.statements
                .iter()
                .any(|s| s.kind == SyncKind::DropTable),
            "allow_destructive=true では DROP TABLE を生成するはず"
        );
        let sqls: Vec<String> = plan.statements.iter().map(|s| s.sql.clone()).collect();

        let state = AppState::default();
        let sid = register(&state, "drop-true", tgt, false).await;
        t::apply_sync_sql_via_command(&state, &sid, None, sqls)
            .await
            .expect("apply (create keep + drop extra)");

        let session = state.get(&sid).await.expect("session");
        assert!(
            !table_exists(&session.conn, "extra").await,
            "allow_destructive=true では extra が DROP されるはず"
        );
        assert!(
            table_exists(&session.conn, "keep").await,
            "keep は作成されるはず"
        );
        let _ = std::fs::remove_file(&src_path);
        let _ = std::fs::remove_file(&tgt_path);
    }
}

// ---------------------------------------------------------------------------
// allow_delete: false のとき DELETE が生成されず、適用しても行が残る
// ---------------------------------------------------------------------------

/// target-only 行 (id=3) を持つデータ diff を作り、`allow_delete` に応じた
/// 生成 SQL をコマンド経由で適用する。
async fn data_sync_apply(allow_delete: bool) -> (bool, std::path::PathBuf) {
    let (tgt, tgt_path) = temp_conn(if allow_delete {
        "del_true"
    } else {
        "del_false"
    })
    .await;
    tgt.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)", None)
        .await
        .expect("create t");
    tgt.execute(
        "INSERT INTO t (id, v) VALUES (1, 'a'), (2, 'b'), (3, 'c')",
        None,
    )
    .await
    .expect("seed t");

    // source は id=1,2 のみ (id=3 は target-only = 削除候補)。
    let columns = vec!["id".to_string(), "v".to_string()];
    let pk_idx = [0usize];
    let source = vec![
        vec![Value::Int(1), Value::String("a".into())],
        vec![Value::Int(2), Value::String("b".into())],
    ];
    let target = vec![
        vec![Value::Int(1), Value::String("a".into())],
        vec![Value::Int(2), Value::String("b".into())],
        vec![Value::Int(3), Value::String("c".into())],
    ];
    let rows = t::compute_data_diff(&columns, &pk_idx, &source, &target);
    let diff = DataDiff {
        target_driver: DriverKind::Sqlite,
        table: "t".to_string(),
        column_types: vec!["TEXT".to_string(); columns.len()],
        columns,
        primary_key: vec!["id".to_string()],
        rows,
        truncated: false,
        source_count: source.len(),
        target_count: target.len(),
    };
    let plan = t::generate_data_sync_sql(&diff, allow_delete);
    let sqls: Vec<String> = plan.statements.iter().map(|s| s.sql.clone()).collect();

    let state = AppState::default();
    let sid = register(&state, "del-sess", tgt, false).await;
    if !sqls.is_empty() {
        t::apply_sync_sql_via_command(&state, &sid, None, sqls)
            .await
            .expect("apply data sync");
    }
    let session = state.get(&sid).await.expect("session");
    let still_present = table_exists(&session.conn, "t").await && {
        let r = session
            .conn
            .execute("SELECT count(*) FROM t WHERE id = 3", None)
            .await
            .expect("check id=3");
        matches!(&r.rows[0][0], Value::Int(n) if *n == 1)
    };
    (still_present, tgt_path)
}

#[tokio::test]
async fn allow_delete_gates_delete_row_through_command() {
    // allow_delete=false: id=3 は削除されず残る。
    let (present_false, p1) = data_sync_apply(false).await;
    assert!(
        present_false,
        "allow_delete=false では target-only 行 (id=3) が残るはず"
    );
    let _ = std::fs::remove_file(&p1);

    // allow_delete=true: id=3 が DELETE される。
    let (present_true, p2) = data_sync_apply(true).await;
    assert!(
        !present_true,
        "allow_delete=true では target-only 行 (id=3) が削除されるはず"
    );
    let _ = std::fs::remove_file(&p2);
}
