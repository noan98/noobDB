//! 重複レコードのマージ (#2303) の統合テスト。
//!
//! SQLite (一時ファイル) は常時実走。MySQL / PostgreSQL は `NOOBDB_TEST_MYSQL_URL` /
//! `NOOBDB_TEST_POSTGRES_URL` があるときだけ、専用の DB / スキーマ (`nb2303_*`) で同じシナリオを流す。
//! 親 1 表 + 子 3 表 (単純 FK + ON DELETE CASCADE・複合 PK を持つ中間表・複合 FK) + 自己参照 FK で、
//! 衝突の検出・3 つの扱い・途中失敗でのロールバック・フライトレコーダーからの Undo を確かめる。

use super::common; // 共有ヘルパは groups/*.rs が 1 度だけ取り込む
use std::path::PathBuf;

use noobdb_lib::__test_api as t;

const DDL: [&str; 6] = [
    "CREATE TABLE customers (id INT NOT NULL PRIMARY KEY, name VARCHAR(30) NOT NULL, email VARCHAR(40), \
     phone VARCHAR(30), score INT, referrer_id INT, UNIQUE (email), UNIQUE (id, name), \
     CHECK (NOT (phone IS NOT NULL AND score = 5)), FOREIGN KEY (referrer_id) REFERENCES customers(id))",
    "CREATE TABLE orders (id INT NOT NULL PRIMARY KEY, customer_id INT, \
     FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE)",
    "CREATE TABLE coupon_uses (customer_id INT NOT NULL, coupon_id INT NOT NULL, \
     PRIMARY KEY (customer_id, coupon_id), FOREIGN KEY (customer_id) REFERENCES customers(id))",
    "CREATE TABLE tickets (id INT NOT NULL PRIMARY KEY, c_id INT, c_name VARCHAR(30), \
     FOREIGN KEY (c_id, c_name) REFERENCES customers(id, name))",
    "CREATE TABLE skip_cascade (customer_id INT NOT NULL, coupon_id INT NOT NULL, \
     PRIMARY KEY (customer_id, coupon_id), \
     FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE)",
    "CREATE TABLE skip_null (id INT NOT NULL PRIMARY KEY, customer_id INT, tag INT, \
     UNIQUE (customer_id, tag), \
     FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL)",
];

const SEED: [&str; 5] = [
    "INSERT INTO customers VALUES (1, 'alice', 'a@x', NULL, 5, NULL)",
    "INSERT INTO customers VALUES (2, 'alice2', 'b@x', '555', 1, NULL)",
    "INSERT INTO customers VALUES (3, 'bob', 'c@x', NULL, 2, 2)",
    "INSERT INTO orders VALUES (10, 1), (11, 2), (12, 2)",
    "INSERT INTO coupon_uses VALUES (1, 100), (2, 100), (2, 200)",
];

struct Side {
    id: String,
    database: Option<String>,
}

fn int(v: &t::Value) -> i64 {
    match v {
        t::Value::Int(n) => *n,
        t::Value::UInt(n) => *n as i64,
        t::Value::String(s) => s.parse().expect("numeric string"),
        other => panic!("expected int, got {other:?}"),
    }
}

async fn exec(state: &t::AppState, side: &Side, sql: &str) -> t::QueryResult {
    let s = state.get(&side.id).await.expect("session");
    s.conn
        .execute(sql, side.database.as_deref())
        .await
        .unwrap_or_else(|e| panic!("{sql}: {e}"))
}

async fn ints(state: &t::AppState, side: &Side, sql: &str) -> Vec<i64> {
    exec(state, side, sql)
        .await
        .rows
        .iter()
        .map(|r| int(&r[0]))
        .collect()
}

async fn setup(state: &t::AppState, side: &Side) {
    // 同じスキーマを flow と read_only_flow で使い回すので、先に作り直す。
    for table in [
        "grand",
        "skip_null",
        "skip_cascade",
        "tickets",
        "coupon_uses",
        "orders",
        "customers",
    ] {
        exec(state, side, &format!("DROP TABLE IF EXISTS {table}")).await;
    }
    for ddl in DDL {
        exec(state, side, ddl).await;
    }
    for s in SEED {
        exec(state, side, s).await;
    }
    exec(state, side, "INSERT INTO tickets VALUES (1, 2, 'alice2')").await;
}

fn request(policy: t::ConflictPolicy, picks: Option<Vec<t::RowMergePick>>) -> t::RowMergeRequest {
    t::RowMergeRequest {
        key_columns: vec!["id".into()],
        survivor: vec![t::Value::Int(1)],
        losers: vec![vec![t::Value::Int(2)]],
        picks,
        conflict_policy: policy,
        expected: None,
    }
}

async fn preview(state: &t::AppState, side: &Side, req: &t::RowMergeRequest) -> t::RowMergePreview {
    t::preview_row_merge_inner(
        state,
        &side.id,
        side.database.as_deref().unwrap_or(""),
        "customers",
        req,
        None,
    )
    .await
    .expect("preview")
}

async fn apply(
    state: &t::AppState,
    side: &Side,
    req: &t::RowMergeRequest,
    capture: bool,
) -> Result<t::RowMergeOutcome, t::AppError> {
    t::apply_row_merge_inner(
        state,
        &side.id,
        side.database.as_deref().unwrap_or(""),
        "customers",
        req,
        t::RowMergeOptions {
            capture: capture.then_some(t::BulkCaptureConfig {
                row_cap: None,
                retention_days: None,
            }),
        },
    )
    .await
}

/// 元のデータと同じか。
async fn assert_original(state: &t::AppState, side: &Side) {
    assert_eq!(
        ints(state, side, "SELECT id FROM customers ORDER BY id").await,
        vec![1, 2, 3]
    );
    assert_eq!(
        ints(state, side, "SELECT customer_id FROM orders ORDER BY id").await,
        vec![1, 2, 2]
    );
    assert_eq!(
        ints(
            state,
            side,
            "SELECT customer_id * 1000 + coupon_id FROM coupon_uses ORDER BY 1"
        )
        .await,
        vec![1100, 2100, 2200]
    );
    assert_eq!(ints(state, side, "SELECT c_id FROM tickets").await, vec![2]);
    assert_eq!(
        ints(
            state,
            side,
            "SELECT referrer_id FROM customers WHERE id = 3"
        )
        .await,
        vec![2]
    );
    let phone = exec(state, side, "SELECT phone FROM customers WHERE id = 1").await;
    assert!(
        matches!(phone.rows[0][0], t::Value::Null),
        "{:?}",
        phone.rows
    );
}

async fn flow(state: &t::AppState, side: &Side) {
    setup(state, side).await;

    // ── プレビュー: 子 4 本 (自己参照を含む)・衝突・提案値 ──
    let p = preview(state, side, &request(t::ConflictPolicy::Abort, None)).await;
    let child = |name: &str| {
        p.children
            .iter()
            .find(|c| c.table == name)
            .unwrap_or_else(|| panic!("no child {name}: {:?}", p.children))
    };
    assert_eq!(child("orders").rows, 2);
    assert_eq!(child("tickets").columns, vec!["c_id", "c_name"]);
    assert_eq!(child("coupon_uses").rows, 2);
    assert!(child("customers").self_reference);
    assert_eq!(child("customers").rows, 1);
    assert!(
        p.blockers.iter().any(
            |b| matches!(b, t::MergeBlocker::UniqueConflict { table, .. } if table == "coupon_uses")
        ),
        "{:?}",
        p.blockers
    );
    assert_eq!(p.conflicts.len(), 1);
    let phone_idx = p
        .columns
        .iter()
        .position(|c| c.name == "phone")
        .expect("phone");
    assert_eq!(p.picks[phone_idx], 1, "NULL は他の行で補う");
    assert!(
        p.columns
            .iter()
            .find(|c| c.name == "name")
            .expect("name")
            .locked
    );

    // ── 中止 (既定): 何も書かない ──
    let out = apply(state, side, &request(t::ConflictPolicy::Abort, None), false)
        .await
        .expect("apply");
    assert!(matches!(out, t::RowMergeOutcome::Blocked { .. }), "{out:?}");
    assert_original(state, side).await;

    // ── 飛ばす: ON DELETE が NO ACTION の子は、飛ばした行が DELETE を妨げるので止める ──
    let p = preview(state, side, &request(t::ConflictPolicy::SkipRepoint, None)).await;
    assert!(
        p.blockers
            .iter()
            .any(|b| matches!(b, t::MergeBlocker::SkipUnsafe { table } if table == "coupon_uses")),
        "{:?}",
        p.blockers
    );

    // ── 途中失敗で全部ロールバック: 提案値 (phone を重複行から補う) だと CHECK 違反 (付け替え・DELETE の後) ──
    let bad = request(t::ConflictPolicy::DeleteColliding, None);
    let failed = apply(state, side, &bad, false).await;
    assert!(failed.is_err(), "{failed:?}");
    assert_original(state, side).await;

    // ── 重なる子行を削除 + 記録 → 期待どおりの最終状態 ──
    // score だけを重複行から採る (phone は残す行の NULL のまま)。
    // email (UNIQUE) も重複行から採る: Undo が「重複行の復元」より先に残す行の email を戻さないと UNIQUE 違反になる。
    let pick = |column: &str| t::RowMergePick {
        column: column.into(),
        from_row: 1,
    };
    let req = request(
        t::ConflictPolicy::DeleteColliding,
        Some(vec![pick("score"), pick("email")]),
    );
    let out = apply(state, side, &req, true).await.expect("apply");
    let t::RowMergeOutcome::Applied {
        repointed_rows,
        deleted_rows,
        capture,
    } = out
    else {
        panic!("expected applied: {out:?}");
    };
    assert_eq!(deleted_rows, 1);
    assert!(repointed_rows >= 4, "{repointed_rows}");
    assert_eq!(
        ints(state, side, "SELECT id FROM customers ORDER BY id").await,
        vec![1, 3]
    );
    assert_eq!(
        ints(state, side, "SELECT customer_id FROM orders ORDER BY id").await,
        vec![1, 1, 1]
    );
    assert_eq!(
        ints(
            state,
            side,
            "SELECT customer_id * 1000 + coupon_id FROM coupon_uses ORDER BY 1"
        )
        .await,
        vec![1100, 1200]
    );
    assert_eq!(ints(state, side, "SELECT c_id FROM tickets").await, vec![1]);
    assert_eq!(
        ints(
            state,
            side,
            "SELECT referrer_id FROM customers WHERE id = 3"
        )
        .await,
        vec![1]
    );
    assert_eq!(
        ints(state, side, "SELECT score FROM customers WHERE id = 1").await,
        vec![1]
    );
    assert_eq!(
        ints(
            state,
            side,
            "SELECT COUNT(*) FROM customers WHERE id = 1 AND email = 'b@x'"
        )
        .await,
        vec![1]
    );

    // ── Undo: 元の行と参照に戻る ──
    assert!(capture.recorded >= 4, "{capture:?}");
    let batch = capture.batch_id.expect("batch id");
    let undone = t::apply_flight_batch_via_command(state, &side.id, &batch, false, false)
        .await
        .expect("undo");
    assert!(undone.applied, "{:?}", undone.conflicts);
    assert_original(state, side).await;
    assert_eq!(
        ints(state, side, "SELECT score FROM customers WHERE id = 1").await,
        vec![5]
    );
    assert_eq!(
        ints(
            state,
            side,
            "SELECT COUNT(*) FROM customers WHERE id = 1 AND email = 'a@x'"
        )
        .await,
        vec![1]
    );

    skip_flow(state, side).await;
}

/// 「付け替えを飛ばす」: ON DELETE CASCADE / SET NULL の子では、飛ばした行が連鎖で消える / NULL になり、
/// Undo で元に戻る。孫の表が連鎖で参照しているときは止める。
async fn skip_flow(state: &t::AppState, side: &Side) {
    setup(state, side).await;
    // coupon_uses (ON DELETE が NO ACTION) の衝突は、この場面では要らない。
    exec(
        state,
        side,
        "DELETE FROM coupon_uses WHERE customer_id = 2 AND coupon_id = 100",
    )
    .await;
    exec(
        state,
        side,
        "INSERT INTO skip_cascade VALUES (1, 100), (2, 100), (2, 200)",
    )
    .await;
    exec(
        state,
        side,
        "INSERT INTO skip_null VALUES (1, 1, 7), (2, 2, 7), (3, 2, 8)",
    )
    .await;
    let req = request(t::ConflictPolicy::SkipRepoint, Some(vec![]));
    let p = preview(state, side, &req).await;
    assert!(p.blockers.is_empty(), "{:?}", p.blockers);
    let out = apply(state, side, &req, true).await.expect("apply skip");
    let t::RowMergeOutcome::Applied { capture, .. } = out else {
        panic!("expected applied: {out:?}");
    };
    assert_eq!(
        ints(
            state,
            side,
            "SELECT customer_id * 1000 + coupon_id FROM skip_cascade ORDER BY 1"
        )
        .await,
        vec![1100, 1200]
    );
    assert_eq!(
        ints(
            state,
            side,
            "SELECT COUNT(*) FROM skip_null WHERE customer_id IS NULL"
        )
        .await,
        vec![1]
    );
    assert_eq!(
        ints(
            state,
            side,
            "SELECT customer_id FROM skip_null WHERE id = 3"
        )
        .await,
        vec![1]
    );
    let batch = capture.batch_id.expect("batch id");
    let undone = t::apply_flight_batch_via_command(state, &side.id, &batch, false, false)
        .await
        .expect("undo");
    assert!(undone.applied, "{:?}", undone.conflicts);
    assert_eq!(
        ints(
            state,
            side,
            "SELECT customer_id * 1000 + coupon_id FROM skip_cascade ORDER BY 1"
        )
        .await,
        vec![1100, 2100, 2200]
    );
    assert_eq!(
        ints(state, side, "SELECT customer_id FROM skip_null ORDER BY id").await,
        vec![1, 2, 2]
    );
    assert_eq!(
        ints(state, side, "SELECT id FROM customers ORDER BY id").await,
        vec![1, 2, 3]
    );

    // 孫: 衝突で削除する子行 (skip_cascade) を、さらに別の表が連鎖で参照していれば止める。
    exec(
        state,
        side,
        "CREATE TABLE grand (id INT NOT NULL PRIMARY KEY, c_id INT, k_id INT, \
         FOREIGN KEY (c_id, k_id) REFERENCES skip_cascade(customer_id, coupon_id) ON DELETE CASCADE)",
    )
    .await;
    let p = preview(
        state,
        side,
        &request(t::ConflictPolicy::DeleteColliding, Some(vec![])),
    )
    .await;
    assert!(
        p.blockers.iter().any(|b| matches!(
            b,
            t::MergeBlocker::DeletedChildReferenced { table, referencing }
                if table == "skip_cascade" && referencing == "grand"
        )),
        "{:?}",
        p.blockers
    );
    exec(state, side, "DROP TABLE grand").await;
}

/// プレビューの後でデータが変わったら、何も書かずに `changed` を返す。
async fn stale_flow(state: &t::AppState, side: &Side) {
    setup(state, side).await;
    let req = request(t::ConflictPolicy::DeleteColliding, Some(vec![]));
    let p = preview(state, side, &req).await;
    let mut stale = req.clone();
    stale.expected = Some(t::RowMergeExpected {
        statements: p.statements.clone(),
        child_rows: p
            .children
            .iter()
            .map(|c| c.rows + c.skipped + c.deleted)
            .collect(),
    });
    // プレビューの後に子行が増える。
    exec(state, side, "INSERT INTO orders VALUES (13, 2)").await;
    let out = apply(state, side, &stale, false).await.expect("apply");
    assert!(matches!(out, t::RowMergeOutcome::Changed { .. }), "{out:?}");
    assert_eq!(
        ints(state, side, "SELECT id FROM customers ORDER BY id").await,
        vec![1, 2, 3]
    );
    // 変わっていなければ通る (プレビューを取り直した計画)。
    let p2 = preview(state, side, &req).await;
    let mut fresh = req.clone();
    fresh.expected = Some(t::RowMergeExpected {
        statements: p2.statements.clone(),
        child_rows: p2
            .children
            .iter()
            .map(|c| c.rows + c.skipped + c.deleted)
            .collect(),
    });
    let out = apply(state, side, &fresh, false).await.expect("apply");
    assert!(matches!(out, t::RowMergeOutcome::Applied { .. }), "{out:?}");
}

/// read_only 接続は、実行をバックエンドが拒否する (プレビューは読み取りだけなので通る)。
async fn read_only_flow(state: &t::AppState, rw: &Side, ro: &Side) {
    setup(state, rw).await;
    let req = request(t::ConflictPolicy::DeleteColliding, None);
    let p = preview(state, ro, &req).await;
    assert!(!p.statements.is_empty());
    let err = apply(state, ro, &req, false)
        .await
        .expect_err("read-only must be rejected");
    assert!(matches!(err, t::AppError::ReadOnly(_)), "{err}");
    assert_original(state, rw).await;
}

fn temp_path(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!("noobdb_rowmerge_{label}_{}.db", std::process::id()))
}

async fn sqlite_side(state: &t::AppState, id: &str, read_only: bool, path: &PathBuf) -> Side {
    if !path.exists() {
        std::fs::File::create(path).expect("touch sqlite file");
    }
    let opts = t::sqlite_options(path.to_str().expect("utf8 path"));
    let conn = t::connect(&opts).await.expect("connect sqlite");
    let session = if read_only {
        t::make_session(id, conn, opts, true)
    } else {
        t::make_recording_session(id, conn, opts)
    };
    state.insert(session).await;
    Side {
        id: id.into(),
        database: None,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sqlite_row_merge_flow() {
    let state = t::AppState::default();
    let path = temp_path("flow");
    let _ = std::fs::remove_file(&path);
    let side = sqlite_side(&state, "rm_flow", false, &path).await;
    flow(&state, &side).await;
    stale_flow(&state, &side).await;
    let _ = std::fs::remove_file(&path);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sqlite_row_merge_rejects_read_only() {
    let state = t::AppState::default();
    let path = temp_path("ro");
    let _ = std::fs::remove_file(&path);
    let rw = sqlite_side(&state, "rm_rw", false, &path).await;
    let ro = sqlite_side(&state, "rm_ro", true, &path).await;
    read_only_flow(&state, &rw, &ro).await;
    let _ = std::fs::remove_file(&path);
}

async fn server_side(
    state: &t::AppState,
    opts: &t::DbConnectOptions,
    id: &str,
    name: &str,
    read_only: bool,
    drop_sql: &str,
    create_sql: &str,
) -> Side {
    let conn = t::connect(opts).await.expect("connect");
    if !drop_sql.is_empty() {
        conn.execute(drop_sql, None).await.expect("drop");
        conn.execute(create_sql, None).await.expect("create");
    }
    let session = if read_only {
        t::make_session(id, conn, opts.clone(), true)
    } else {
        t::make_recording_session(id, conn, opts.clone())
    };
    state.insert(session).await;
    Side {
        id: id.into(),
        database: Some(name.into()),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mysql_row_merge_when_env_set() {
    let Some(url) = common::require_env("NOOBDB_TEST_MYSQL_URL") else {
        return;
    };
    let opts = t::parse_mysql_url(&url).expect("valid url");
    let state = t::AppState::default();
    let name = "nb2303_rm";
    let side = server_side(
        &state,
        &opts,
        "rm_my",
        name,
        false,
        &format!("DROP DATABASE IF EXISTS {name}"),
        &format!("CREATE DATABASE {name}"),
    )
    .await;
    flow(&state, &side).await;
    let ro = server_side(&state, &opts, "rm_my_ro", name, true, "", "").await;
    read_only_flow(&state, &side, &ro).await;
    let admin = t::connect(&opts).await.expect("connect");
    let _ = admin
        .execute(&format!("DROP DATABASE IF EXISTS {name}"), None)
        .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn postgres_row_merge_when_env_set() {
    let Some(url) = common::require_env("NOOBDB_TEST_POSTGRES_URL") else {
        return;
    };
    let opts = t::parse_postgres_url(&url).expect("valid url");
    let state = t::AppState::default();
    let name = "nb2303_rm";
    let side = server_side(
        &state,
        &opts,
        "rm_pg",
        name,
        false,
        &format!("DROP SCHEMA IF EXISTS {name} CASCADE"),
        &format!("CREATE SCHEMA {name}"),
    )
    .await;
    flow(&state, &side).await;
    let ro = server_side(&state, &opts, "rm_pg_ro", name, true, "", "").await;
    read_only_flow(&state, &side, &ro).await;
    cross_schema_flow(&state, &side).await;
    let admin = t::connect(&opts).await.expect("connect");
    let _ = admin
        .execute(&format!("DROP SCHEMA IF EXISTS {name} CASCADE"), None)
        .await;
    let _ = admin
        .execute("DROP SCHEMA IF EXISTS nb2303_rm2 CASCADE", None)
        .await;
}

/// PostgreSQL: 別スキーマの子 (単一列) は付け替え対象 (Undo は不可)、複合 FK は止める。
async fn cross_schema_flow(state: &t::AppState, side: &Side) {
    exec(state, side, "DROP SCHEMA IF EXISTS nb2303_rm2 CASCADE").await;
    setup(state, side).await;
    exec(state, side, "CREATE SCHEMA nb2303_rm2").await;
    exec(
        state,
        side,
        "CREATE TABLE nb2303_rm2.xo (id INT PRIMARY KEY, cid INT, \
         FOREIGN KEY (cid) REFERENCES nb2303_rm.customers(id) ON DELETE CASCADE)",
    )
    .await;
    exec(state, side, "INSERT INTO nb2303_rm2.xo VALUES (1, 2)").await;
    let req = request(t::ConflictPolicy::DeleteColliding, Some(vec![]));
    let p = preview(state, side, &req).await;
    let c = p
        .children
        .iter()
        .find(|c| c.table == "xo")
        .unwrap_or_else(|| panic!("{:?}", p.children));
    assert_eq!(c.schema.as_deref(), Some("nb2303_rm2"));
    assert_eq!(c.rows, 1);
    assert!(
        matches!(
            p.undo_decline,
            Some(t::UndoDecline::CrossSchemaChild { .. })
        ),
        "{:?}",
        p.undo_decline
    );
    exec(
        state,
        side,
        "CREATE TABLE nb2303_rm2.xc (id INT PRIMARY KEY, a INT, b VARCHAR(30), \
         FOREIGN KEY (a, b) REFERENCES nb2303_rm.customers(id, name))",
    )
    .await;
    let p = preview(state, side, &req).await;
    assert!(
        p.blockers.iter().any(|b| matches!(
            b,
            t::MergeBlocker::UnresolvedForeignKey { table, .. } if table == "nb2303_rm2.xc"
        )),
        "{:?}",
        p.blockers
    );
    exec(state, side, "DROP SCHEMA nb2303_rm2 CASCADE").await;
}
