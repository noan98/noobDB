//! サブセット抽出 (#2241) の統合テスト。
//!
//! SQLite (一時ファイル) は常時実走する。MySQL / PostgreSQL は `NOOBDB_TEST_MYSQL_URL` /
//! `NOOBDB_TEST_POSTGRES_URL` があるときだけ実行し、専用のデータベース / スキーマ
//! (`nb2241_*`) に閉じる。どのドライバも同じシナリオ (`scenario_*`) を流す:
//! 親の方向を最後まで辿り、**出力をそのまま投入しても FK 違反が起きない** (転送先は外部キーを
//! 強制する) ことを確かめる。複合 FK・自己参照 FK・NULL の外部キーを含む。

use super::common; // 共有ヘルパは groups/*.rs が 1 度だけ取り込む
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicU64;
use std::sync::Arc;

use noobdb_lib::__test_api as t;

/// 3 ドライバで同じ文面が通る DDL。`employees` は自己参照、`orders` は複合 FK と
/// NULL 可の FK を持つ。
const DDL: [&str; 6] = [
    "CREATE TABLE customers (id INT NOT NULL PRIMARY KEY, name VARCHAR(30))",
    "CREATE TABLE regions (code INT NOT NULL, sub INT NOT NULL, label VARCHAR(30), PRIMARY KEY (code, sub))",
    "CREATE TABLE products (id INT NOT NULL PRIMARY KEY, label VARCHAR(30))",
    "CREATE TABLE employees (id INT NOT NULL PRIMARY KEY, boss_id INT, FOREIGN KEY (boss_id) REFERENCES employees(id))",
    "CREATE TABLE orders (id INT NOT NULL PRIMARY KEY, customer_id INT, region_code INT, region_sub INT, rep_id INT, \
     FOREIGN KEY (customer_id) REFERENCES customers(id), \
     FOREIGN KEY (region_code, region_sub) REFERENCES regions(code, sub), \
     FOREIGN KEY (rep_id) REFERENCES employees(id))",
    "CREATE TABLE order_items (id INT NOT NULL PRIMARY KEY, order_id INT NOT NULL, product_id INT NOT NULL, \
     FOREIGN KEY (order_id) REFERENCES orders(id), FOREIGN KEY (product_id) REFERENCES products(id))",
];

/// 親から順に入れる (ソース側。外部キーを強制する DB でも通る順)。
const SEED: [&str; 6] = [
    "INSERT INTO customers VALUES (1, 'alice'), (2, 'bob'), (3, 'carol')",
    "INSERT INTO regions VALUES (1, 1, 'r11'), (1, 2, 'r12'), (2, 1, 'r21')",
    "INSERT INTO products VALUES (7, 'p7'), (8, 'p8'), (9, 'p9')",
    "INSERT INTO employees VALUES (1, NULL), (2, 1), (3, 2), (4, 1)",
    "INSERT INTO orders VALUES (10, 1, 1, 1, 3), (11, 1, NULL, NULL, NULL), (12, 2, 1, 2, 4), (13, 3, 2, 1, NULL)",
    "INSERT INTO order_items VALUES (100, 10, 7), (101, 10, 8), (102, 11, 7), (103, 12, 9), (104, 13, 9)",
];

/// ドライバごとのテスト対象 (接続 + 表を置く DB / スキーマ)。
struct Side {
    id: String,
    database: Option<String>,
}

async fn exec(state: &t::AppState, side: &Side, sql: &str) -> t::QueryResult {
    let s = state.get(&side.id).await.expect("session");
    s.conn
        .execute(sql, side.database.as_deref())
        .await
        .unwrap_or_else(|e| panic!("{sql}: {e}"))
}

fn int(v: &t::Value) -> i64 {
    match v {
        t::Value::Int(n) => *n,
        t::Value::UInt(n) => *n as i64,
        t::Value::String(s) => s.parse().expect("numeric string"),
        other => panic!("expected int, got {other:?}"),
    }
}

async fn count(state: &t::AppState, side: &Side, table: &str) -> i64 {
    int(&exec(state, side, &format!("SELECT COUNT(*) FROM {table}"))
        .await
        .rows[0][0])
}

async fn ids(state: &t::AppState, side: &Side, table: &str, col: &str) -> Vec<i64> {
    exec(
        state,
        side,
        &format!("SELECT {col} FROM {table} ORDER BY {col}"),
    )
    .await
    .rows
    .iter()
    .map(|r| int(&r[0]))
    .collect()
}

async fn create_schema(state: &t::AppState, side: &Side) {
    for ddl in DDL {
        exec(state, side, ddl).await;
    }
}

async fn seed(state: &t::AppState, side: &Side) {
    for sql in SEED {
        exec(state, side, sql).await;
    }
}

fn request(src: &Side, table: &str, where_clause: Option<&str>) -> t::SubsetRequest {
    t::SubsetRequest {
        source_session_id: src.id.clone(),
        source_database: src.database.clone(),
        table: table.into(),
        where_clause: where_clause.map(str::to_string),
        root_row_limit: None,
        child_depth: None,
        child_row_limit: None,
    }
}

fn to_target(dst: &Side, existing: t::ExistingRows) -> t::SubsetOutput {
    t::SubsetOutput::Transfer {
        target_session_id: dst.id.clone(),
        target_database: dst.database.clone(),
        existing,
    }
}

async fn run(
    state: &t::AppState,
    req: t::SubsetRequest,
    out: t::SubsetOutput,
    masks: Vec<t::SubsetColumnMask>,
) -> Result<t::SubsetOutcome, t::AppError> {
    t::run_subset_inner(
        state,
        req,
        out,
        masks,
        Arc::new(AtomicU64::new(0)),
        |_, _| {},
    )
    .await
}

/// 親の方向: 明細 1 行から、注文 → 顧客・複合 FK の地域・自己参照の担当者の連鎖・商品が
/// 漏れなく入り、無関係な行は入らない。転送先は FK を強制するので、違反なら INSERT が失敗する。
async fn scenario_parents_and_no_fk_violation(state: &t::AppState, src: &Side, dst: &Side) {
    let out = run(
        state,
        request(src, "order_items", Some("id = 101")),
        to_target(dst, t::ExistingRows::Skip),
        vec![],
    )
    .await
    .expect("subset transfer");
    assert_eq!(count(state, dst, "order_items").await, 1);
    assert_eq!(ids(state, dst, "orders", "id").await, vec![10]);
    assert_eq!(ids(state, dst, "customers", "id").await, vec![1]);
    assert_eq!(ids(state, dst, "regions", "code").await, vec![1]);
    // 注文 10 の担当者 3 → 上司 2 → 上司 1 (4 は入らない)。
    assert_eq!(ids(state, dst, "employees", "id").await, vec![1, 2, 3]);
    assert_eq!(ids(state, dst, "products", "id").await, vec![8]);
    assert_eq!(out.rows, 1 + 1 + 1 + 1 + 3 + 1);
    assert!(out.warnings.is_empty(), "{:?}", out.warnings);

    // 同じ抽出をもう一度。既存の行は読み飛ばすので失敗せず、件数も増えない。
    run(
        state,
        request(src, "order_items", Some("id = 101")),
        to_target(dst, t::ExistingRows::Skip),
        vec![],
    )
    .await
    .expect("second run skips existing rows");
    assert_eq!(count(state, dst, "order_items").await, 1);
    assert_eq!(count(state, dst, "employees").await, 3);
    // 素の INSERT なら衝突で失敗する。
    assert!(run(
        state,
        request(src, "order_items", Some("id = 101")),
        to_target(dst, t::ExistingRows::Fail),
        vec![],
    )
    .await
    .is_err());
}

/// 子の方向: 段数と件数の上限、打ち切りの表示。子で足した行の親も入る。
async fn scenario_children_depth_and_limits(state: &t::AppState, src: &Side, dst: &Side) {
    // 顧客 1 から 1 段: 注文 10, 11 だけ。明細は入らない。
    let mut req = request(src, "customers", Some("id = 1"));
    req.child_depth = Some(1);
    let p = t::preview_subset_inner(state, req.clone())
        .await
        .expect("preview");
    let rows_of = |name: &str| {
        p.tables
            .iter()
            .find(|x| x.table == name)
            .map_or(0, |x| x.rows)
    };
    assert_eq!(rows_of("orders"), 2);
    assert_eq!(rows_of("order_items"), 0);
    // 注文 10 の担当者の連鎖と地域は整合性のために入る。
    assert_eq!(rows_of("employees"), 3);
    assert_eq!(rows_of("regions"), 1);

    // 2 段: 明細 100, 101, 102 まで。
    req.child_depth = Some(2);
    let p2 = t::preview_subset_inner(state, req.clone())
        .await
        .expect("preview");
    let n = |name: &str| {
        p2.tables
            .iter()
            .find(|x| x.table == name)
            .map_or(0, |x| x.rows)
    };
    assert_eq!(n("order_items"), 3);
    assert_eq!(n("products"), 2);
    // 顧客 2・3 や注文 12・13 のような無関係な行は入らない。
    assert_eq!(n("customers"), 1);
    assert_eq!(n("orders"), 2);
    assert!(p2.warnings.is_empty(), "{:?}", p2.warnings);

    // 件数の上限 1: 注文は 1 行で打ち切り、そのことを警告で返す。
    req.child_depth = Some(1);
    req.child_row_limit = Some(1);
    let p3 = t::preview_subset_inner(state, req.clone())
        .await
        .expect("preview");
    assert!(
        p3.warnings.contains(&t::SubsetWarning::ChildTruncated {
            table: "orders".into(),
            limit: 1
        }),
        "{:?}",
        p3.warnings
    );

    // 2 段を実際に転送しても FK 違反にならない。
    req.child_depth = Some(2);
    req.child_row_limit = None;
    run(state, req, to_target(dst, t::ExistingRows::Skip), vec![])
        .await
        .expect("transfer with children");
    assert_eq!(
        ids(state, dst, "order_items", "id").await,
        vec![100, 101, 102]
    );
    assert_eq!(ids(state, dst, "orders", "id").await, vec![10, 11]);
}

fn temp_path(label: &str, ext: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "noobdb_subset_{label}_{}.{ext}",
        std::process::id()
    ))
}

/// 出力した INSERT スクリプトを空の同じ構造の DB へ流し込んでも、FK 違反にならない。
async fn scenario_script(state: &t::AppState, src: &Side, dst: &Side, label: &str) {
    let path = temp_path(label, "sql");
    let out = run(
        state,
        request(src, "order_items", Some("id = 101")),
        t::SubsetOutput::Script {
            path: path.to_string_lossy().into_owned(),
            existing: t::ExistingRows::Fail,
        },
        vec![t::SubsetColumnMask {
            table: "customers".into(),
            column: "name".into(),
            rule: t::MaskRule::Fixed {
                value: "***".into(),
            },
        }],
    )
    .await
    .expect("subset script");
    assert_eq!(out.path.as_deref(), path.to_str());
    let text = std::fs::read_to_string(&path).expect("script written");
    let _ = std::fs::remove_file(&path);
    assert!(text.contains("'***'"), "{text}");
    assert!(
        !text.contains("alice"),
        "masked value must not leak: {text}"
    );
    // 親の表が先に出る。
    let pos = |name: &str| {
        text.find(&format!("INSERT INTO `{name}`"))
            .or_else(|| text.find(&format!("INSERT INTO \"{name}\"")))
            .unwrap_or_else(|| panic!("no INSERT for {name}: {text}"))
    };
    assert!(pos("customers") < pos("orders"));
    assert!(pos("orders") < pos("order_items"));
    // 流し込む。
    for stmt in text.split(";\n") {
        let body: String = stmt
            .lines()
            .filter(|l| !l.trim_start().starts_with("--"))
            .collect::<Vec<_>>()
            .join("\n");
        if body.trim().is_empty() {
            continue;
        }
        exec(state, dst, &body).await;
    }
    assert_eq!(count(state, dst, "order_items").await, 1);
    assert_eq!(ids(state, dst, "employees", "id").await, vec![1, 2, 3]);
}

// ---------------------------------------------------------------------------
// SQLite (常時実走)
// ---------------------------------------------------------------------------

async fn sqlite_side(state: &t::AppState, id: &str, read_only: bool) -> (Side, PathBuf) {
    let path = temp_path(id, "db");
    let _ = std::fs::remove_file(&path);
    std::fs::File::create(&path).expect("touch sqlite file");
    let opts = t::sqlite_options(path.to_str().expect("utf8 path"));
    let conn = t::connect(&opts).await.expect("connect sqlite");
    state
        .insert(t::make_session(id, conn, opts, read_only))
        .await;
    (
        Side {
            id: id.into(),
            database: None,
        },
        path,
    )
}

fn cleanup(path: &Path) {
    let _ = std::fs::remove_file(path);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sqlite_subset_parents_children_and_script() {
    let state = t::AppState::default();
    let (src, p1) = sqlite_side(&state, "ss_src", false).await;
    create_schema(&state, &src).await;
    seed(&state, &src).await;

    let (dst, p2) = sqlite_side(&state, "ss_dst", false).await;
    create_schema(&state, &dst).await;
    scenario_parents_and_no_fk_violation(&state, &src, &dst).await;

    let (dst2, p3) = sqlite_side(&state, "ss_dst2", false).await;
    create_schema(&state, &dst2).await;
    scenario_children_depth_and_limits(&state, &src, &dst2).await;

    let (dst3, p4) = sqlite_side(&state, "ss_dst3", false).await;
    create_schema(&state, &dst3).await;
    scenario_script(&state, &src, &dst3, "sqlite").await;

    for p in [p1, p2, p3, p4] {
        cleanup(&p);
    }
}

/// 書き込み先が read_only なら (緊急書き込みでも) 拒否し、何も書かない。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sqlite_subset_rejects_read_only_target_without_writing() {
    let state = t::AppState::default();
    let (src, p1) = sqlite_side(&state, "ro_src", false).await;
    create_schema(&state, &src).await;
    seed(&state, &src).await;
    let (dst, p2) = sqlite_side(&state, "ro_dst", true).await;
    create_schema(&state, &dst).await;
    let err = run(
        &state,
        request(&src, "orders", None),
        to_target(&dst, t::ExistingRows::Skip),
        vec![],
    )
    .await
    .err()
    .expect("read-only target must be rejected");
    assert!(matches!(err, t::AppError::ReadOnly(_)), "{err}");
    assert_eq!(count(&state, &dst, "customers").await, 0);
    for p in [p1, p2] {
        cleanup(&p);
    }
}

/// 起点の条件・マスク・出力先の不正は、何も書く前に拒否する。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sqlite_subset_rejects_unsafe_input() {
    let state = t::AppState::default();
    let (src, p1) = sqlite_side(&state, "bad_src", false).await;
    create_schema(&state, &src).await;
    seed(&state, &src).await;
    let (dst, p2) = sqlite_side(&state, "bad_dst", false).await;
    create_schema(&state, &dst).await;

    // 書き込みを含む条件 / 文の区切りは拒否 (起点の条件は読み取り専用に限る)。
    for bad in [
        "id = 1; DELETE FROM orders",
        "id IN (SELECT 1) -- x",
        "1=1) UNION SELECT 1 --",
    ] {
        let r = t::preview_subset_inner(&state, request(&src, "orders", Some(bad))).await;
        assert!(r.is_err(), "{bad} must be rejected");
    }
    assert_eq!(count(&state, &src, "orders").await, 4);

    // キー列はマスクできない (参照が壊れる)。
    let key_mask = vec![t::SubsetColumnMask {
        table: "customers".into(),
        column: "id".into(),
        rule: t::MaskRule::Null,
    }];
    let err = run(
        &state,
        request(&src, "orders", Some("id = 10")),
        to_target(&dst, t::ExistingRows::Skip),
        key_mask,
    )
    .await
    .err()
    .expect("masking a key column must fail");
    assert!(err.to_string().contains("key column"), "{err}");
    assert_eq!(count(&state, &dst, "customers").await, 0);

    // 転送先に表が無ければ、何も書かずに失敗する。
    let (empty, p3) = sqlite_side(&state, "bad_empty", false).await;
    let err = run(
        &state,
        request(&src, "orders", Some("id = 10")),
        to_target(&empty, t::ExistingRows::Skip),
        vec![],
    )
    .await
    .err()
    .expect("missing target tables must fail");
    assert!(err.to_string().contains("does not exist"), "{err}");

    // 条件に合う行が無ければ失敗 (空の転送を成功にしない)。
    assert!(run(
        &state,
        request(&src, "orders", Some("id = 999")),
        to_target(&dst, t::ExistingRows::Skip),
        vec![],
    )
    .await
    .is_err());
    for p in [p1, p2, p3] {
        cleanup(&p);
    }
}

/// サンドボックスの「関連表も含める」で、選んだ行が参照する親の行が必ず入り、
/// 参照されない親の行は入らない (主キー順の先頭 N 行ではなく、行単位で辿る)。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sqlite_sandbox_include_related_follows_parent_rows() {
    let state = Arc::new(t::AppState::default());
    let (src, p1) = sqlite_side(&state, "sbx_src", false).await;
    exec(
        &state,
        &src,
        "CREATE TABLE parent (id INTEGER PRIMARY KEY, name TEXT)",
    )
    .await;
    exec(
        &state,
        &src,
        "CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id))",
    )
    .await;
    // 親は 300 行。選ぶ子 (id=1) が参照する親は末尾の 299。行数上限が小さくても欠けない。
    exec(
        &state,
        &src,
        "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 300) \
         INSERT INTO parent SELECT i, 'p' || i FROM n",
    )
    .await;
    exec(&state, &src, "INSERT INTO child VALUES (1, 299), (2, 5)").await;

    let specs = vec![t::SandboxTableSpec {
        name: "child".into(),
        filter: Some("id = 1".into()),
    }];
    let res = t::create_sandbox_with_filters_via_command(
        &state,
        &src.id,
        None,
        "subset related rows test",
        specs,
        true,
        Some(10),
    )
    .await
    .expect("create sandbox");
    let sb_id = res.session_id.clone();
    let sess = state.get(&sb_id).await.expect("sandbox session");
    let q = |sql: &str| {
        let sess = sess.clone();
        let sql = sql.to_string();
        async move { sess.conn.execute(&sql, None).await.expect("query") }
    };
    let parents = q("SELECT id FROM parent ORDER BY id").await;
    // 参照されている 299 だけ。先頭 N 行 (1..10) や参照されない行は入らない。
    assert_eq!(parents.rows.len(), 1);
    assert_eq!(int(&parents.rows[0][0]), 299);
    let orphans = q(
        "SELECT COUNT(*) FROM child c LEFT JOIN parent p ON p.id = c.parent_id WHERE p.id IS NULL",
    )
    .await;
    assert_eq!(int(&orphans.rows[0][0]), 0);
    let children = q("SELECT COUNT(*) FROM child").await;
    assert_eq!(int(&children.rows[0][0]), 1);

    let _ = t::discard_sandbox_via_command(&state, &res.sandbox.id, Some(&sb_id)).await;
    cleanup(&p1);
}

/// 関連表として足した親の行が実 DB の先頭ページの外にあっても、編集して競合検査をしたときに
/// 偽の競合 (実 DB で削除) が出ない。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sqlite_sandbox_conflict_check_reads_related_rows_by_key() {
    let state = Arc::new(t::AppState::default());
    let (src, p1) = sqlite_side(&state, "sbx_conf_src", false).await;
    exec(
        &state,
        &src,
        "CREATE TABLE parent (id INTEGER PRIMARY KEY, name TEXT)",
    )
    .await;
    exec(
        &state,
        &src,
        "CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id))",
    )
    .await;
    exec(
        &state,
        &src,
        "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 300) \
         INSERT INTO parent SELECT i, 'p' || i FROM n",
    )
    .await;
    exec(&state, &src, "INSERT INTO child VALUES (1, 299)").await;
    let specs = vec![t::SandboxTableSpec {
        name: "child".into(),
        filter: Some("id = 1".into()),
    }];
    let res = t::create_sandbox_with_filters_via_command(
        &state,
        &src.id,
        None,
        "subset conflict test",
        specs,
        true,
        Some(10),
    )
    .await
    .expect("create sandbox");
    let sb_id = res.session_id.clone();
    let sess = state.get(&sb_id).await.expect("sandbox session");
    sess.conn
        .execute("UPDATE parent SET name = 'edited' WHERE id = 299", None)
        .await
        .expect("edit parent");
    // 1 行ずつしか読まない設定でも、実 DB はキーで読むので 299 が見つかる。
    let diff = t::sandbox_table_diff_via_command(
        &state,
        &res.sandbox.id,
        &sb_id,
        "parent",
        Some(&src.id),
        Some(1),
    )
    .await
    .expect("diff");
    assert!(diff.source_checked);
    assert_eq!(diff.desired.rows.len(), 1);
    assert!(
        diff.conflicts.is_empty(),
        "conflicts: {:?}",
        diff.conflicts.len()
    );

    let _ = t::discard_sandbox_via_command(&state, &res.sandbox.id, Some(&sb_id)).await;
    cleanup(&p1);
}

/// 主キーの無い選択表の同一行は、関連表を含めても 1 行にまとまらない。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sqlite_sandbox_keeps_duplicate_rows_of_keyless_table() {
    let state = Arc::new(t::AppState::default());
    let (src, p1) = sqlite_side(&state, "sbx_dup_src", false).await;
    exec(
        &state,
        &src,
        "CREATE TABLE parent (id INTEGER PRIMARY KEY, name TEXT)",
    )
    .await;
    exec(
        &state,
        &src,
        "CREATE TABLE log (parent_id INTEGER REFERENCES parent(id), msg TEXT)",
    )
    .await;
    exec(&state, &src, "INSERT INTO parent VALUES (1, 'a'), (2, 'b')").await;
    exec(
        &state,
        &src,
        "INSERT INTO log VALUES (1, 'x'), (1, 'x'), (2, 'y')",
    )
    .await;
    let specs = vec![t::SandboxTableSpec {
        name: "log".into(),
        filter: None,
    }];
    let res = t::create_sandbox_with_filters_via_command(
        &state,
        &src.id,
        None,
        "subset dup test",
        specs,
        true,
        Some(100),
    )
    .await
    .expect("create sandbox");
    let sb_id = res.session_id.clone();
    let sess = state.get(&sb_id).await.expect("sandbox session");
    let n = sess
        .conn
        .execute("SELECT COUNT(*) FROM log", None)
        .await
        .expect("count");
    assert_eq!(int(&n.rows[0][0]), 3);
    let p = sess
        .conn
        .execute("SELECT COUNT(*) FROM parent", None)
        .await
        .expect("count");
    assert_eq!(int(&p.rows[0][0]), 2);
    let _ = t::discard_sandbox_via_command(&state, &res.sandbox.id, Some(&sb_id)).await;
    cleanup(&p1);
}

// ---------------------------------------------------------------------------
// MySQL / PostgreSQL (環境変数ゲート)。同じサーバの別 DB / スキーマを転送元・先にする。
// ---------------------------------------------------------------------------

const MYSQL_SRC: &str = "nb2241_src";
const MYSQL_DST: &str = "nb2241_dst";
const MYSQL_DST2: &str = "nb2241_dst2";
const MYSQL_DST3: &str = "nb2241_dst3";

async fn server_sides(
    state: &t::AppState,
    opts: &t::DbConnectOptions,
    prefix: &str,
    names: [&str; 4],
    drop_sql: fn(&str) -> String,
    create_sql: fn(&str) -> String,
) -> Vec<Side> {
    let mut out = Vec::new();
    for (i, n) in names.iter().enumerate() {
        let conn = t::connect(opts).await.expect("connect");
        conn.execute(&drop_sql(n), None).await.expect("drop");
        conn.execute(&create_sql(n), None).await.expect("create");
        let id = format!("{prefix}_{i}");
        state
            .insert(t::make_session(&id, conn, opts.clone(), false))
            .await;
        out.push(Side {
            id,
            database: Some((*n).to_string()),
        });
    }
    out
}

async fn external_flow(state: &t::AppState, sides: &[Side]) {
    let src = &sides[0];
    create_schema(state, src).await;
    seed(state, src).await;
    for s in &sides[1..] {
        create_schema(state, s).await;
    }
    scenario_parents_and_no_fk_violation(state, src, &sides[1]).await;
    scenario_children_depth_and_limits(state, src, &sides[2]).await;
    scenario_script(state, src, &sides[3], "ext").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mysql_subset_when_env_set() {
    let Some(url) = common::require_env("NOOBDB_TEST_MYSQL_URL") else {
        return;
    };
    let opts = t::parse_mysql_url(&url).expect("valid url");
    let state = t::AppState::default();
    let sides = server_sides(
        &state,
        &opts,
        "my_subset",
        [MYSQL_SRC, MYSQL_DST, MYSQL_DST2, MYSQL_DST3],
        |n| format!("DROP DATABASE IF EXISTS {n}"),
        |n| format!("CREATE DATABASE {n}"),
    )
    .await;
    external_flow(&state, &sides).await;
    let admin = t::connect(&opts).await.expect("connect");
    for n in [MYSQL_SRC, MYSQL_DST, MYSQL_DST2, MYSQL_DST3] {
        let _ = admin
            .execute(&format!("DROP DATABASE IF EXISTS {n}"), None)
            .await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn postgres_subset_when_env_set() {
    let Some(url) = common::require_env("NOOBDB_TEST_POSTGRES_URL") else {
        return;
    };
    let opts = t::parse_postgres_url(&url).expect("valid url");
    let state = t::AppState::default();
    let names = ["nb2241_src", "nb2241_dst", "nb2241_dst2", "nb2241_dst3"];
    let sides = server_sides(
        &state,
        &opts,
        "pg_subset",
        names,
        |n| format!("DROP SCHEMA IF EXISTS {n} CASCADE"),
        |n| format!("CREATE SCHEMA {n}"),
    )
    .await;
    external_flow(&state, &sides).await;
    let admin = t::connect(&opts).await.expect("connect");
    for n in names {
        let _ = admin
            .execute(&format!("DROP SCHEMA IF EXISTS {n} CASCADE"), None)
            .await;
    }
}
