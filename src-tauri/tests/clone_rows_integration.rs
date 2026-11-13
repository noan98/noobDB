//! 行を子レコードごと同じ DB 内に複製する (#2304) の統合テスト。
//!
//! SQLite (一時ファイル) は常時実走する。MySQL / PostgreSQL は `NOOBDB_TEST_MYSQL_URL` /
//! `NOOBDB_TEST_POSTGRES_URL` があるときだけ実行し、専用のデータベース / スキーマ
//! (`nb2304_*`) に閉じる。どのドライバも同じシナリオを流す: 親 → 子 → 孫 (複合キー・自己参照・
//! 多対多の中間表) の複製、外部への参照が元のまま残ること、方針が足りないときの事前エラー、
//! 失敗時の全ロールバック、`read_only` の拒否、Undo で新しい行が消えること。

use super::common; // 共有ヘルパは groups/*.rs が 1 度だけ取り込む
use std::path::PathBuf;

use noobdb_lib::__test_api as t;

struct Side {
    id: String,
    database: Option<String>,
}

/// ドライバごとの自動採番の主キーの書き方。
fn ddl(auto: &str) -> Vec<String> {
    vec![
        "CREATE TABLE products (id INT NOT NULL PRIMARY KEY, name VARCHAR(30))".into(),
        format!("CREATE TABLE tags (id {auto}, name VARCHAR(30))"),
        format!("CREATE TABLE orders (id {auto}, order_no VARCHAR(40) NOT NULL, note VARCHAR(40), UNIQUE (order_no))"),
        format!(
            "CREATE TABLE order_items (id {auto}, order_id INT NOT NULL, product_id INT NOT NULL, \
             parent_item_id INT, qty INT, \
             FOREIGN KEY (order_id) REFERENCES orders(id), \
             FOREIGN KEY (product_id) REFERENCES products(id), \
             FOREIGN KEY (parent_item_id) REFERENCES order_items(id))"
        ),
        "CREATE TABLE item_notes (item_id INT NOT NULL, seq INT NOT NULL, body VARCHAR(30) NOT NULL, \
         PRIMARY KEY (item_id, seq), FOREIGN KEY (item_id) REFERENCES order_items(id))"
            .into(),
        "CREATE TABLE order_tags (order_id INT NOT NULL, tag_id INT NOT NULL, \
         PRIMARY KEY (order_id, tag_id), \
         FOREIGN KEY (order_id) REFERENCES orders(id), FOREIGN KEY (tag_id) REFERENCES tags(id))"
            .into(),
    ]
}

/// 自動採番の表は id を指定せずに入れる (PostgreSQL の serial / identity を進めるため)。
const SEED: [&str; 9] = [
    "INSERT INTO products VALUES (7, 'p7'), (8, 'p8')",
    "INSERT INTO tags (name) VALUES ('t1'), ('t2')",
    "INSERT INTO orders (order_no, note) VALUES ('A-1', 'first')",
    "INSERT INTO orders (order_no, note) VALUES ('B-1', 'second')",
    "INSERT INTO order_items (order_id, product_id, parent_item_id, qty) VALUES (1, 7, NULL, 1)",
    "INSERT INTO order_items (order_id, product_id, parent_item_id, qty) VALUES (1, 8, 1, 2)",
    "INSERT INTO order_items (order_id, product_id, parent_item_id, qty) VALUES (2, 7, NULL, 3)",
    "INSERT INTO item_notes VALUES (1, 1, 'n11'), (1, 2, 'n12'), (3, 1, 'n31')",
    "INSERT INTO order_tags VALUES (1, 1), (1, 2), (2, 1)",
];

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

async fn ints(state: &t::AppState, side: &Side, sql: &str) -> Vec<i64> {
    exec(state, side, sql)
        .await
        .rows
        .iter()
        .map(|r| int(&r[0]))
        .collect()
}

async fn count(state: &t::AppState, side: &Side, table: &str) -> i64 {
    ints(state, side, &format!("SELECT COUNT(*) FROM {table}")).await[0]
}

async fn seed(state: &t::AppState, side: &Side, auto: &str) {
    for d in ddl(auto) {
        exec(state, side, &d).await;
    }
    for s in SEED {
        exec(state, side, s).await;
    }
}

fn request(side: &Side, table: &str, where_clause: &str, depth: u32) -> t::SubsetRequest {
    t::SubsetRequest {
        source_session_id: side.id.clone(),
        source_database: side.database.clone(),
        table: table.into(),
        where_clause: Some(where_clause.into()),
        root_row_limit: None,
        child_depth: Some(depth),
        child_row_limit: None,
    }
}

fn cap() -> Option<t::BulkCaptureConfig> {
    Some(t::BulkCaptureConfig::default())
}

fn expr(table: &str, column: &str, sql: &str) -> t::CloneColumnRule {
    t::CloneColumnRule {
        table: table.into(),
        column: column.into(),
        rule: t::KeyRule::Expression { sql: sql.into() },
    }
}

fn lit(table: &str, column: &str, value: Option<&str>) -> t::CloneColumnRule {
    t::CloneColumnRule {
        table: table.into(),
        column: column.into(),
        rule: t::KeyRule::Literal {
            value: value.map(str::to_string),
        },
    }
}

/// 敵対的な文字列を元の値にして、`{old}` を 2 回含む式 (バインド経路) で複製する。値が SQL として
/// 解釈されず連結済みの文字列のまま入ること、表が無事なことを確かめる。`concat_expr` は
/// ドライバごとの `{old}` + '-' + `{old}` の書き方。
async fn old_placeholder_scenario(state: &t::AppState, side: &Side, concat_expr: &str) {
    let hostile = "'); DROP TABLE o;--";
    exec(
        state,
        side,
        &format!(
            "UPDATE orders SET order_no = '{}' WHERE id = 2",
            hostile.replace('\'', "''")
        ),
    )
    .await;
    let before = count(state, side, "orders").await;
    let rules = vec![expr("orders", "order_no", concat_expr)];
    t::clone_rows_inner(state, request(side, "orders", "id = 2", 0), rules, cap())
        .await
        .expect("clone with {old} expression");
    assert_eq!(count(state, side, "orders").await, before + 1);
    let want = format!("{hostile}-{hostile}").replace('\'', "''");
    let hit = count(state, side, &format!("orders WHERE order_no = '{want}'")).await;
    assert_eq!(hit, 1, "連結済みの値がそのまま入る");
}

/// 全シナリオ。`random_expr` は式の方針 (`order_no` に入れる乱数文字列) のドライバごとの書き方。
async fn scenario(state: &t::AppState, side: &Side, random_expr: &str) {
    // --- プレビュー: 親 → 子 → 孫が挿入順に並び、UNIQUE の衝突を事前に検出する。
    let req = request(side, "orders", "id = 1", 3);
    let p = t::preview_clone_rows_inner(state, req.clone(), vec![])
        .await
        .expect("preview");
    let names: Vec<&str> = p.tables.iter().map(|x| x.table.as_str()).collect();
    let pos = |n: &str| {
        names
            .iter()
            .position(|x| *x == n)
            .unwrap_or_else(|| panic!("{n} in {names:?}"))
    };
    assert!(pos("orders") < pos("order_items"));
    assert!(pos("order_items") < pos("item_notes"));
    assert!(pos("orders") < pos("order_tags"));
    // 親 (products / tags) は複製に含まれない (外部への参照)。
    assert!(
        !names.contains(&"products") && !names.contains(&"tags"),
        "{names:?}"
    );
    let rows = |n: &str| p.tables[pos(n)].rows;
    assert_eq!(
        (
            rows("orders"),
            rows("order_items"),
            rows("item_notes"),
            rows("order_tags")
        ),
        (1, 2, 2, 2)
    );
    assert!(!p.ready);
    assert_eq!(
        p.tables[pos("orders")].conflicts.len(),
        1,
        "order_no は UNIQUE"
    );
    assert!(!p.tables[pos("orders")].needs_policy);

    // --- 方針が足りない (UNIQUE の衝突) 実行は、何も書かずにエラー。
    let err = t::clone_rows_inner(state, req.clone(), vec![], cap())
        .await
        .expect_err("must fail before writing");
    assert!(matches!(err, t::AppError::InvalidInput(_)), "{err}");
    assert_eq!(count(state, side, "orders").await, 2);

    // --- 失敗時は全部ロールバック: 3 表目 (item_notes) の NOT NULL 列に NULL を上書きして失敗させる。
    let bad = vec![
        expr("orders", "order_no", random_expr),
        lit("item_notes", "body", None),
    ];
    let err = t::clone_rows_inner(state, req.clone(), bad, cap())
        .await
        .expect_err("NOT NULL violation");
    assert!(!matches!(err, t::AppError::ReadOnly(_)), "{err}");
    for (table, n) in [
        ("orders", 2),
        ("order_items", 3),
        ("item_notes", 3),
        ("order_tags", 3),
    ] {
        assert_eq!(
            count(state, side, table).await,
            n,
            "{table} must be rolled back"
        );
    }

    // --- 成功: order_no は式、note は上書き値。
    let rules = vec![
        expr("orders", "order_no", random_expr),
        lit("orders", "note", Some("cloned")),
    ];
    let p = t::preview_clone_rows_inner(state, req.clone(), rules.clone())
        .await
        .expect("preview with rules");
    assert!(p.ready, "{p:?}");
    let out = t::clone_rows_inner(state, req.clone(), rules, cap())
        .await
        .expect("clone");
    assert_eq!(out.total_rows, 1 + 2 + 2 + 2);
    assert_eq!(out.root_table, "orders");
    assert_eq!(out.root_new_keys.len(), 1);
    let new_order = int(&out.root_new_keys[0][0]);
    assert!(new_order > 2, "新しい注文は採番される: {new_order}");

    // 注文: 元の行はそのまま、新しい行は上書き値・式。
    assert_eq!(count(state, side, "orders").await, 3);
    let note = exec(
        state,
        side,
        &format!("SELECT note FROM orders WHERE id = {new_order}"),
    )
    .await;
    assert_eq!(
        format!("{:?}", note.rows[0][0]),
        format!("{:?}", t::Value::String("cloned".into()))
    );
    // 明細: 新しい注文に 2 行。商品 (外部への参照) は元の値のまま。
    let items = ints(
        state,
        side,
        &format!("SELECT id FROM order_items WHERE order_id = {new_order} ORDER BY id"),
    )
    .await;
    assert_eq!(items.len(), 2);
    assert!(items.iter().all(|i| *i > 3));
    let products = ints(
        state,
        side,
        &format!("SELECT product_id FROM order_items WHERE order_id = {new_order} ORDER BY id"),
    )
    .await;
    assert_eq!(products, vec![7, 8]);
    // 自己参照: 2 つ目の明細の親は、複製した 1 つ目 (元の 1 ではない)。
    let parents = exec(
        state,
        side,
        &format!("SELECT parent_item_id FROM order_items WHERE order_id = {new_order} ORDER BY id"),
    )
    .await;
    assert!(matches!(parents.rows[0][0], t::Value::Null));
    assert_eq!(int(&parents.rows[1][0]), items[0]);
    // 孫 (複合キー): 複製した明細 1 に 2 行。
    let notes = ints(
        state,
        side,
        &format!(
            "SELECT seq FROM item_notes WHERE item_id = {} ORDER BY seq",
            items[0]
        ),
    )
    .await;
    assert_eq!(notes, vec![1, 2]);
    // 多対多の中間表: 新しい注文とタグ (外部) の組。
    let tags = ints(
        state,
        side,
        &format!("SELECT tag_id FROM order_tags WHERE order_id = {new_order} ORDER BY tag_id"),
    )
    .await;
    assert_eq!(tags, vec![1, 2]);
    // 元の行は変わらない。
    assert_eq!(count(state, side, "order_items").await, 5);
    assert_eq!(count(state, side, "item_notes").await, 5);
    assert_eq!(count(state, side, "order_tags").await, 5);
    assert_eq!(
        ints(
            state,
            side,
            "SELECT order_id FROM order_items WHERE id IN (1, 2) ORDER BY id"
        )
        .await,
        vec![1, 1]
    );

    // 旧キー → 新キーの対応表。
    let order_map = out
        .tables
        .iter()
        .find(|x| x.table == "orders")
        .expect("orders");
    assert_eq!(order_map.key_columns, vec!["id".to_string()]);
    assert_eq!(order_map.mappings.len(), 1);
    assert_eq!(int(&order_map.mappings[0].old_key[0]), 1);
    assert_eq!(int(&order_map.mappings[0].new_key[0]), new_order);
    assert!(order_map.mappings[0].root);
    let item_map = out
        .tables
        .iter()
        .find(|x| x.table == "order_items")
        .expect("items");
    assert_eq!(
        item_map
            .mappings
            .iter()
            .map(|m| int(&m.old_key[0]))
            .collect::<Vec<_>>(),
        vec![1, 2]
    );
    assert_eq!(
        item_map
            .mappings
            .iter()
            .map(|m| int(&m.new_key[0]))
            .collect::<Vec<_>>(),
        items
    );

    // --- Undo: バッチ 1 件で、新しい行がすべて消える (子から消すので FK 違反にならない)。
    assert_eq!(out.recorded, 4, "{out:?}");
    let batch = out.batch_id.clone().expect("batch id");
    let undone = t::apply_flight_batch_via_command(state, &side.id, &batch, false, false)
        .await
        .expect("undo");
    assert!(undone.applied, "{undone:?}");
    for (table, n) in [
        ("orders", 2),
        ("order_items", 3),
        ("item_notes", 3),
        ("order_tags", 3),
    ] {
        assert_eq!(count(state, side, table).await, n, "{table} after undo");
    }

    // --- 主キーが採番されない表 (products): 方針なしはエラー、上書き値 (70) を指定すれば複製できる。
    let req = request(side, "products", "id = 7", 3);
    let p = t::preview_clone_rows_inner(state, req.clone(), vec![])
        .await
        .expect("preview products");
    assert!(
        p.tables
            .iter()
            .find(|x| x.table == "products")
            .expect("products")
            .needs_policy
    );
    assert!(!p.ready);
    let err = t::clone_rows_inner(state, req.clone(), vec![], cap())
        .await
        .expect_err("no key policy");
    assert!(matches!(err, t::AppError::InvalidInput(_)), "{err}");
    assert_eq!(count(state, side, "products").await, 2);
    let out = t::clone_rows_inner(
        state,
        req.clone(),
        vec![lit("products", "id", Some("70"))],
        cap(),
    )
    .await
    .expect("clone product");
    assert_eq!(
        ints(state, side, "SELECT id FROM products ORDER BY id").await,
        vec![7, 8, 70]
    );
    // 商品 7 を指す明細 (1, 3) が複製され、新しい商品 70 を指す。注文 (外部への参照) は元のまま。
    assert_eq!(
        ints(
            state,
            side,
            "SELECT order_id FROM order_items WHERE product_id = 70 ORDER BY order_id"
        )
        .await,
        vec![1, 2]
    );
    // 明細 2 は明細 1 の子 (自己参照) なので一緒に複製される。
    assert_eq!(count(state, side, "order_items").await, 6);
    // 複製した明細 1 の子 (item_notes 2 行) も付いてくる。
    assert_eq!(count(state, side, "item_notes").await, 3 + 3);
    assert_eq!(out.root_new_keys.len(), 1);
    assert!(
        out.capture_enabled && out.declined_tables.is_empty(),
        "{out:?}"
    );

    // --- 記録の設定がオフ (capture なし): 複製はできるが Undo の記録は残さない。
    let out = t::clone_rows_inner(state, req, vec![lit("products", "id", Some("71"))], None)
        .await
        .expect("clone without capture");
    assert!(!out.capture_enabled);
    assert_eq!((out.recorded, out.declined), (0, 0));
    assert!(out.batch_id.is_none());
    assert_eq!(
        ints(state, side, "SELECT id FROM products ORDER BY id").await,
        vec![7, 8, 70, 71]
    );
    // 上限 (行数 1) を超える複製は、一部だけを記録せず全体を辞退する。
    let tiny = t::BulkCaptureConfig {
        row_cap: Some(1),
        retention_days: None,
    };
    let out = t::clone_rows_inner(
        state,
        request(side, "products", "id = 8", 3),
        vec![lit("products", "id", Some("80"))],
        Some(tiny),
    )
    .await
    .expect("clone over the capture cap");
    assert!(out.total_rows > 1);
    assert_eq!(out.recorded, 0);
    assert_eq!(out.declined_tables.len(), out.tables.len());
    assert!(out.batch_id.is_none());
}

/// `read_only` 接続はバックエンドが拒否し、何も書かない。
async fn scenario_read_only(state: &t::AppState, side: &Side) {
    let err = t::clone_rows_inner(state, request(side, "orders", "id = 1", 1), vec![], cap())
        .await
        .expect_err("read-only must be rejected");
    assert!(matches!(err, t::AppError::ReadOnly(_)), "{err}");
    assert_eq!(count(state, side, "orders").await, 2);
}

fn temp_path(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!("noobdb_clone_{label}_{}.db", std::process::id()))
}

async fn sqlite_session(state: &t::AppState, id: &str, read_only: bool) -> (Side, PathBuf) {
    let path = temp_path(id);
    let _ = std::fs::remove_file(&path);
    std::fs::File::create(&path).expect("touch sqlite file");
    let opts = t::sqlite_options(path.to_str().expect("utf8 path"));
    let conn = t::connect(&opts).await.expect("connect sqlite");
    let session = if read_only {
        t::make_session(id, conn, opts, true)
    } else {
        t::make_recording_session(id, conn, opts)
    };
    state.insert(session).await;
    (
        Side {
            id: id.into(),
            database: None,
        },
        path,
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sqlite_clone_rows_with_children() {
    let state = t::AppState::default();
    let (side, path) = sqlite_session(&state, "cr_sqlite", false).await;
    seed(&state, &side, "INTEGER PRIMARY KEY AUTOINCREMENT").await;
    scenario(&state, &side, "lower(hex(randomblob(8)))").await;
    old_placeholder_scenario(&state, &side, "{old} || '-' || {old}").await;
    let _ = std::fs::remove_file(&path);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sqlite_clone_rows_rejects_read_only() {
    let state = t::AppState::default();
    // 書き込み用の接続でスキーマを作り、同じファイルを read_only で開き直す。
    let (writer, path) = sqlite_session(&state, "cr_ro_w", false).await;
    seed(&state, &writer, "INTEGER PRIMARY KEY AUTOINCREMENT").await;
    let opts = t::sqlite_options(path.to_str().expect("utf8 path"));
    let conn = t::connect(&opts).await.expect("connect sqlite");
    state
        .insert(t::make_session("cr_ro", conn, opts, true))
        .await;
    let side = Side {
        id: "cr_ro".into(),
        database: None,
    };
    scenario_read_only(&state, &side).await;
    let _ = std::fs::remove_file(&path);
}

async fn server_session(
    state: &t::AppState,
    opts: &t::DbConnectOptions,
    id: &str,
    name: &str,
    drop_sql: &str,
    create_sql: &str,
) -> Side {
    let conn = t::connect(opts).await.expect("connect");
    conn.execute(drop_sql, None).await.expect("drop");
    conn.execute(create_sql, None).await.expect("create");
    state
        .insert(t::make_recording_session(id, conn, opts.clone()))
        .await;
    Side {
        id: id.into(),
        database: Some(name.to_string()),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mysql_clone_rows_when_env_set() {
    let Some(url) = common::require_env("NOOBDB_TEST_MYSQL_URL") else {
        return;
    };
    let opts = t::parse_mysql_url(&url).expect("valid url");
    let state = t::AppState::default();
    let name = "nb2304_clone";
    let side = server_session(
        &state,
        &opts,
        "cr_mysql",
        name,
        &format!("DROP DATABASE IF EXISTS {name}"),
        &format!("CREATE DATABASE {name}"),
    )
    .await;
    seed(&state, &side, "INT AUTO_INCREMENT PRIMARY KEY").await;
    scenario(&state, &side, "SUBSTR(UUID(), 1, 8)").await;
    old_placeholder_scenario(&state, &side, "CONCAT({old}, '-', {old})").await;
    let ro_conn = t::connect(&opts).await.expect("connect");
    state
        .insert(t::make_session("cr_mysql_ro", ro_conn, opts.clone(), true))
        .await;
    scenario_read_only(
        &state,
        &Side {
            id: "cr_mysql_ro".into(),
            database: Some(name.into()),
        },
    )
    .await;
    let admin = t::connect(&opts).await.expect("connect");
    let _ = admin
        .execute(&format!("DROP DATABASE IF EXISTS {name}"), None)
        .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn postgres_clone_rows_when_env_set() {
    let Some(url) = common::require_env("NOOBDB_TEST_POSTGRES_URL") else {
        return;
    };
    let opts = t::parse_postgres_url(&url).expect("valid url");
    let state = t::AppState::default();
    let name = "nb2304_clone";
    let side = server_session(
        &state,
        &opts,
        "cr_pg",
        name,
        &format!("DROP SCHEMA IF EXISTS {name} CASCADE"),
        &format!("CREATE SCHEMA {name}"),
    )
    .await;
    seed(
        &state,
        &side,
        "INT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY",
    )
    .await;
    scenario(&state, &side, "substr(md5(random()::text), 1, 8)").await;
    old_placeholder_scenario(&state, &side, "{old} || '-' || {old}").await;
    let ro_conn = t::connect(&opts).await.expect("connect");
    state
        .insert(t::make_session("cr_pg_ro", ro_conn, opts.clone(), true))
        .await;
    scenario_read_only(
        &state,
        &Side {
            id: "cr_pg_ro".into(),
            database: Some(name.into()),
        },
    )
    .await;
    let admin = t::connect(&opts).await.expect("connect");
    let _ = admin
        .execute(&format!("DROP SCHEMA IF EXISTS {name} CASCADE"), None)
        .await;
}
