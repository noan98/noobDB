//! スキーマ/データ比較・同期のゴールデン統合テスト。
//!
//! `commands::diff` / `commands::sync` がオーケストレーションする比較・同期ロジック
//! (`compute_data_diff` / `generate_data_sync_sql` / `generate_sync_sql` /
//! `compare_schemas`) について、コマンド層のシナリオ — とりわけ**複合主キー**・
//! **NULL** のエッジケース — を固定する。誤った同期 SQL は破壊的になりうるため、
//! 生成される DML/DDL をスナップショット (期待文字列) で固定して回帰を検出する。
//!
//! SQLite を軸にしているので外部サーバ不要で常時実行される
//! (`tests/sqlite_integration.rs` と同方針)。

use noobdb_lib::__test_api as t;
use t::{DriverKind, RowStatus, Value};

fn s(v: &str) -> Value {
    Value::String(v.to_string())
}

/// 与えた行から `pk_idx` の DataDiff を作り、同期 SQL を生成して返すヘルパ。
fn data_sync_sqls(
    table: &str,
    columns: &[&str],
    pk: &[&str],
    pk_idx: &[usize],
    source: &[Vec<Value>],
    target: &[Vec<Value>],
    allow_delete: bool,
) -> Vec<String> {
    let columns: Vec<String> = columns.iter().map(|c| c.to_string()).collect();
    let rows = t::compute_data_diff(&columns, pk_idx, source, target);
    let diff = t::DataDiff {
        target_driver: DriverKind::Sqlite,
        table: table.to_string(),
        columns,
        primary_key: pk.iter().map(|c| c.to_string()).collect(),
        rows,
        truncated: false,
        source_count: source.len(),
        target_count: target.len(),
    };
    let plan = t::generate_data_sync_sql(&diff, allow_delete);
    plan.statements.into_iter().map(|st| st.sql).collect()
}

// ---------------------------------------------------------------------------
// 複合主キー — 行ペアリングと生成 SQL のスナップショット
// ---------------------------------------------------------------------------

#[test]
fn composite_pk_data_sync_sql_is_fixed() {
    // PK = (a, b)。val のみ非キー列。
    let columns = ["a", "b", "val"];
    let pk = ["a", "b"];
    let pk_idx = [0usize, 1usize];

    let row = |a: i64, b: i64, v: &str| vec![Value::Int(a), Value::Int(b), s(v)];

    // source: (1,1) 同一, (1,2) val 変化, (2,1) source-only
    let source = vec![row(1, 1, "x"), row(1, 2, "y"), row(2, 1, "z")];
    // target: (1,1) 同一, (1,2) 旧値, (3,3) target-only
    let target = vec![row(1, 1, "x"), row(1, 2, "OLD"), row(3, 3, "w")];

    let sqls = data_sync_sqls("t", &columns, &pk, &pk_idx, &source, &target, true);

    // 並び順は SyncKind::order() で insert → update → delete に固定される。
    assert_eq!(
        sqls,
        vec![
            r#"INSERT INTO "t" ("a", "b", "val") VALUES (2, 1, 'z')"#.to_string(),
            r#"UPDATE "t" SET "val" = 'y' WHERE "a" = 1 AND "b" = 2"#.to_string(),
            r#"DELETE FROM "t" WHERE "a" = 3 AND "b" = 3"#.to_string(),
        ]
    );
}

#[test]
fn composite_pk_pairs_rows_independently_of_order() {
    // 行順が両側で異なっても、複合キーで正しくペアリングされること。
    let columns = ["a", "b", "val"];
    let pk_idx = [0usize, 1usize];
    let row = |a: i64, b: i64, v: &str| vec![Value::Int(a), Value::Int(b), s(v)];
    let columns_s: Vec<String> = columns.iter().map(|c| c.to_string()).collect();

    let source = vec![row(2, 9, "p"), row(1, 1, "q")];
    let target = vec![row(1, 1, "q"), row(2, 9, "DIFF")];
    let rows = t::compute_data_diff(&columns_s, &pk_idx, &source, &target);

    // (1,1) 同一 → 差分なし。(2,9) のみ Different。
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].status, RowStatus::Different);
    assert_eq!(rows[0].key, vec![Value::Int(2), Value::Int(9)]);
    assert_eq!(rows[0].changed_columns, vec!["val".to_string()]);
}

// ---------------------------------------------------------------------------
// NULL — ペアリング・比較・述語生成
// ---------------------------------------------------------------------------

#[test]
fn null_equals_null_in_non_key_columns() {
    // 非キー列が両側 NULL の行は「同一」とみなされ差分に出ない。
    let columns: Vec<String> = vec!["id".into(), "note".into()];
    let pk_idx = [0usize];
    let source = vec![
        vec![Value::Int(1), Value::Null],
        vec![Value::Int(2), s("x")],
        vec![Value::Int(3), Value::Null],
    ];
    let target = vec![
        vec![Value::Int(1), Value::Null], // NULL == NULL → 同一
        vec![Value::Int(2), Value::Null], // "x" vs NULL → 差分
        vec![Value::Int(3), s("y")],      // NULL vs "y" → 差分
    ];
    let rows = t::compute_data_diff(&columns, &pk_idx, &source, &target);

    assert_eq!(
        rows.len(),
        2,
        "id=1 は NULL==NULL で同一、差分は id=2,3 の 2 件"
    );
    assert!(
        rows.iter()
            .all(|r| r.status == RowStatus::Different
                && r.changed_columns == vec!["note".to_string()])
    );
}

#[test]
fn null_source_value_updates_to_null() {
    // source 側が NULL の Different 行は SET col = NULL を生成する。
    let columns = ["id", "note"];
    let pk = ["id"];
    let pk_idx = [0usize];
    let source = vec![vec![Value::Int(3), Value::Null]];
    let target = vec![vec![Value::Int(3), s("y")]];
    let sqls = data_sync_sqls("t", &columns, &pk, &pk_idx, &source, &target, false);
    assert_eq!(
        sqls,
        vec![r#"UPDATE "t" SET "note" = NULL WHERE "id" = 3"#.to_string()]
    );
}

#[test]
fn null_in_composite_key_uses_is_null_predicate() {
    // 複合キーの一部が NULL のとき、DELETE 述語は `= NULL` ではなく `IS NULL`。
    let columns = ["a", "b", "val"];
    let pk = ["a", "b"];
    let pk_idx = [0usize, 1usize];
    // target-only 行 (a=1, b=NULL) を削除する。
    let source: Vec<Vec<Value>> = vec![];
    let target = vec![vec![Value::Int(1), Value::Null, s("x")]];
    let sqls = data_sync_sqls("t", &columns, &pk, &pk_idx, &source, &target, true);
    assert_eq!(
        sqls,
        vec![r#"DELETE FROM "t" WHERE "a" = 1 AND "b" IS NULL"#.to_string()]
    );
}

// ---------------------------------------------------------------------------
// 空テーブル / allow_delete ゲート
// ---------------------------------------------------------------------------

#[test]
fn both_empty_yields_no_statements() {
    let columns = ["id", "v"];
    let pk = ["id"];
    let pk_idx = [0usize];
    let sqls = data_sync_sqls("t", &columns, &pk, &pk_idx, &[], &[], true);
    assert!(sqls.is_empty());
}

#[test]
fn empty_source_deletes_all_only_when_allowed() {
    let columns = ["id", "v"];
    let pk = ["id"];
    let pk_idx = [0usize];
    let target = vec![vec![Value::Int(1), s("a")], vec![Value::Int(2), s("b")]];

    // allow_delete=false: target-only 行は削除されない (破壊的操作はオプトイン)。
    let none = data_sync_sqls("t", &columns, &pk, &pk_idx, &[], &target, false);
    assert!(none.is_empty(), "allow_delete=false では DELETE を出さない");

    // allow_delete=true: すべて DELETE。
    let deletes = data_sync_sqls("t", &columns, &pk, &pk_idx, &[], &target, true);
    assert_eq!(
        deletes,
        vec![
            r#"DELETE FROM "t" WHERE "id" = 1"#.to_string(),
            r#"DELETE FROM "t" WHERE "id" = 2"#.to_string(),
        ]
    );
}

#[test]
fn empty_target_inserts_all_rows() {
    let columns = ["id", "v"];
    let pk = ["id"];
    let pk_idx = [0usize];
    let source = vec![vec![Value::Int(1), s("a")], vec![Value::Int(2), s("b")]];
    let inserts = data_sync_sqls("t", &columns, &pk, &pk_idx, &source, &[], true);
    assert_eq!(
        inserts,
        vec![
            r#"INSERT INTO "t" ("id", "v") VALUES (1, 'a')"#.to_string(),
            r#"INSERT INTO "t" ("id", "v") VALUES (2, 'b')"#.to_string(),
        ]
    );
}

// ---------------------------------------------------------------------------
// エンドツーエンド: 実 SQLite で複合主キー + NULL を含むデータを収束させる
// ---------------------------------------------------------------------------

#[tokio::test]
async fn sqlite_composite_pk_with_nulls_converges_end_to_end() {
    let mk = |tag: &str| {
        let mut p = std::env::temp_dir();
        p.push(format!("noobdb_diffsync_{tag}_{}.db", std::process::id()));
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

    // 複合主キー (region, code) と NULL を取りうる label。
    for c in [&src, &tgt] {
        c.execute(
            "CREATE TABLE catalog (region TEXT, code INTEGER, label TEXT, PRIMARY KEY (region, code))",
            None,
        )
        .await
        .expect("create catalog");
    }
    src.execute(
        "INSERT INTO catalog (region, code, label) VALUES ('jp', 1, 'a'), ('jp', 2, NULL), ('us', 1, 'c')",
        None,
    )
    .await
    .expect("seed source");
    // target: ('jp',1) label 違い, ('jp',2) NULL==NULL で同一, ('us',1) 欠落, ('eu',9) 余分。
    tgt.execute(
        "INSERT INTO catalog (region, code, label) VALUES ('jp', 1, 'CHANGED'), ('jp', 2, NULL), ('eu', 9, 'z')",
        None,
    )
    .await
    .expect("seed target");

    let columns = vec![
        "region".to_string(),
        "code".to_string(),
        "label".to_string(),
    ];
    let pk_idx = [0usize, 1usize];
    let select = "SELECT region, code, label FROM catalog ORDER BY region, code";

    let src_rows = src.execute(select, None).await.expect("read source").rows;
    let tgt_rows = tgt.execute(select, None).await.expect("read target").rows;
    let row_diffs = t::compute_data_diff(&columns, &pk_idx, &src_rows, &tgt_rows);
    // update ('jp',1), insert ('us',1), delete ('eu',9) の 3 件。('jp',2) は同一。
    assert_eq!(row_diffs.len(), 3, "got: {row_diffs:?}");

    let diff = t::DataDiff {
        target_driver: DriverKind::Sqlite,
        table: "catalog".to_string(),
        columns: columns.clone(),
        primary_key: vec!["region".to_string(), "code".to_string()],
        rows: row_diffs,
        truncated: false,
        source_count: src_rows.len(),
        target_count: tgt_rows.len(),
    };
    let plan = t::generate_data_sync_sql(&diff, true);
    let sqls: Vec<String> = plan.statements.iter().map(|st| st.sql.clone()).collect();
    tgt.execute_transaction(&sqls, None)
        .await
        .expect("apply data sync plan");

    // 再 diff で収束を確認。
    let src_after = src.execute(select, None).await.expect("re-read src").rows;
    let tgt_after = tgt.execute(select, None).await.expect("re-read tgt").rows;
    let after = t::compute_data_diff(&columns, &pk_idx, &src_after, &tgt_after);
    assert!(after.is_empty(), "rows should converge, got: {after:?}");

    src.close().await;
    tgt.close().await;
    let _ = std::fs::remove_file(&src_path);
    let _ = std::fs::remove_file(&tgt_path);
}

// ---------------------------------------------------------------------------
// スキーマ比較: 列追加 / 型変更 / テーブル増減のゴールデン (構造アサーション)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn sqlite_schema_diff_add_drop_typechange() {
    let mk = |tag: &str| {
        let mut p = std::env::temp_dir();
        p.push(format!("noobdb_schemadiff_{tag}_{}.db", std::process::id()));
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

    // source: items(id, name TEXT, price INTEGER) + extra テーブル only_src。
    src.execute(
        "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, price INTEGER)",
        None,
    )
    .await
    .expect("create items source");
    src.execute("CREATE TABLE only_src (id INTEGER PRIMARY KEY)", None)
        .await
        .expect("create only_src");
    // target: items は price 列が欠落、name の型が異なる (TEXT→INTEGER)。
    tgt.execute(
        "CREATE TABLE items (id INTEGER PRIMARY KEY, name INTEGER)",
        None,
    )
    .await
    .expect("create items target");

    let diff = t::compare_schemas(&src, "main", &tgt, "main")
        .await
        .expect("compare");

    let items = diff
        .tables
        .iter()
        .find(|tbl| tbl.name == "items")
        .expect("items diff");
    assert_eq!(items.status, t::DiffStatus::Different);
    // price は source-only (target に無い)。
    let price = items
        .columns
        .iter()
        .find(|c| c.name == "price")
        .expect("price col");
    assert_eq!(price.status, t::DiffStatus::SourceOnly);
    // name は型違いで Different。
    let name = items
        .columns
        .iter()
        .find(|c| c.name == "name")
        .expect("name col");
    assert_eq!(name.status, t::DiffStatus::Different);
    assert!(name.changed_fields.iter().any(|f| f == "data_type"));

    // only_src は source-only テーブル。
    let only_src = diff
        .tables
        .iter()
        .find(|tbl| tbl.name == "only_src")
        .expect("only_src diff");
    assert_eq!(only_src.status, t::DiffStatus::SourceOnly);

    // 同期計画を生成: price の ADD COLUMN と only_src の CREATE TABLE を含む。
    let plan = t::generate_sync_sql(&diff, false);
    assert!(plan
        .statements
        .iter()
        .any(|st| st.kind == t::SyncKind::AddColumn && st.table == "items"));
    assert!(plan
        .statements
        .iter()
        .any(|st| st.kind == t::SyncKind::CreateTable && st.table == "only_src"));

    src.close().await;
    tgt.close().await;
    let _ = std::fs::remove_file(&src_path);
    let _ = std::fs::remove_file(&tgt_path);
}
