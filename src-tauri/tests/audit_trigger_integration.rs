//! 変更履歴 (監査) トリガー生成 (#2305) の統合テスト。
//!
//! SQLite (一時ファイル) は常時実走する。MySQL / PostgreSQL は `NOOBDB_TEST_MYSQL_URL` /
//! `NOOBDB_TEST_POSTGRES_URL` があるときだけ実行し、専用の DB / スキーマ (`nb2305_*`) に閉じる。
//! 生成した DDL を実際の実行経路 (`run_query_transaction`) で流し、INSERT / UPDATE / DELETE が
//! 監査表に op・old_row / new_row・時刻付きで記録され、除外列が記録されないこと、列追加後の
//! 再生成、DROP スクリプトで外れることを 3 ドライバで同じシナリオで確かめる。

use super::common; // 共有ヘルパは groups/*.rs が 1 度だけ取り込む
use std::path::PathBuf;

use noobdb_lib::__test_api as t;
use serde_json::{json, Value as Json};

fn options() -> t::AuditOptions {
    t::AuditOptions {
        insert: true,
        update: true,
        delete: true,
        exclude_columns: vec!["secret".into()],
        skip_unchanged_update: true,
        audit_table: String::new(),
        audit_schema: None,
    }
}

struct Side {
    id: String,
    database: Option<String>,
    driver: &'static str,
}

fn text(v: &t::Value) -> Option<String> {
    match v {
        t::Value::Null => None,
        t::Value::String(s) => Some(s.clone()),
        t::Value::Int(n) => Some(n.to_string()),
        t::Value::UInt(n) => Some(n.to_string()),
        other => Some(format!("{other:?}")),
    }
}

async fn exec(state: &t::AppState, side: &Side, sql: &str) -> t::QueryResult {
    let s = state.get(&side.id).await.expect("session");
    s.conn
        .execute(sql, side.database.as_deref())
        .await
        .unwrap_or_else(|e| panic!("{sql}: {e}"))
}

async fn run_ddl(state: &t::AppState, side: &Side, statements: Vec<String>) {
    t::run_query_transaction_via_command(state, &side.id, statements, side.database.as_deref())
        .await
        .unwrap_or_else(|e| panic!("ddl failed: {e}"));
}

async fn generate(
    state: &t::AppState,
    side: &Side,
    opts: &t::AuditOptions,
    regenerate: bool,
) -> t::AuditDdl {
    let s = state.get(&side.id).await.expect("session");
    t::generate_audit_ddl_core(
        &s.conn,
        side.database.as_deref().unwrap_or("main"),
        "users",
        opts,
        regenerate,
    )
    .await
    .expect("generate")
}

async fn status(state: &t::AppState, side: &Side) -> t::AuditStatus {
    let s = state.get(&side.id).await.expect("session");
    t::get_audit_status_core(&s.conn, side.database.as_deref().unwrap_or("main"), "users")
        .await
        .expect("status")
}

/// 監査表の全行を (op, pk, old_row, new_row, changed_at) にして返す。JSON は列の型に依らず文字列化して読む。
async fn audit_rows(
    state: &t::AppState,
    side: &Side,
) -> Vec<(String, Option<Json>, Option<Json>, Option<Json>, bool)> {
    let cast = |c: &str| match side.driver {
        "mysql" => format!("CAST({c} AS CHAR)"),
        "postgres" => format!("{c}::text"),
        _ => c.to_string(),
    };
    let sql = format!(
        "SELECT op, {}, {}, {}, changed_at IS NOT NULL FROM users_audit ORDER BY audit_id",
        cast("pk"),
        cast("old_row"),
        cast("new_row")
    );
    let r = exec(state, side, &sql).await;
    let json = |v: &t::Value| text(v).map(|s| serde_json::from_str::<Json>(&s).expect("json"));
    r.rows
        .iter()
        .map(|row| {
            let has_time = matches!(&row[4], t::Value::Bool(true))
                || text(&row[4]).is_some_and(|s| s == "1" || s == "true");
            (
                text(&row[0]).expect("op"),
                json(&row[1]),
                json(&row[2]),
                json(&row[3]),
                has_time,
            )
        })
        .collect()
}

async fn object_exists(state: &t::AppState, side: &Side, sql: &str) -> bool {
    let r = exec(state, side, sql).await;
    text(&r.rows[0][0]).is_some_and(|s| s != "0" && s != "f" && s != "false")
}

async fn scenario(state: &t::AppState, side: &Side) {
    exec(
        state,
        side,
        "CREATE TABLE users (id INT NOT NULL PRIMARY KEY, name VARCHAR(30), secret VARCHAR(30))",
    )
    .await;
    let opts = options();
    let ddl = generate(state, side, &opts, false).await;
    assert_eq!(ddl.recorded_columns, vec!["id", "name"]);
    run_ddl(state, side, ddl.create.clone()).await;
    let st = status(state, side).await;
    assert!(st.present);
    // PostgreSQL も含め、作成時のオプション (監査表名・除外列) を読み戻せる。
    let read = st.options.expect("options");
    assert_eq!(read.audit_table, "users_audit");
    assert_eq!(read.exclude_columns, vec!["secret"]);

    exec(state, side, "INSERT INTO users VALUES (1, 'alice', 's1')").await;
    exec(state, side, "UPDATE users SET name = 'alice2' WHERE id = 1").await;
    // 値の変わらない UPDATE と、除外列だけの UPDATE は記録しない。
    exec(state, side, "UPDATE users SET name = 'alice2' WHERE id = 1").await;
    exec(state, side, "UPDATE users SET secret = 'zzz' WHERE id = 1").await;
    exec(state, side, "DELETE FROM users WHERE id = 1").await;

    let rows = audit_rows(state, side).await;
    let ops: Vec<&str> = rows.iter().map(|r| r.0.as_str()).collect();
    assert_eq!(ops, vec!["INSERT", "UPDATE", "DELETE"], "{rows:?}");
    assert_eq!(rows[0].1, Some(json!({"id": 1})));
    assert_eq!(rows[0].2, None);
    assert_eq!(rows[0].3, Some(json!({"id": 1, "name": "alice"})));
    assert_eq!(rows[1].2, Some(json!({"id": 1, "name": "alice"})));
    assert_eq!(rows[1].3, Some(json!({"id": 1, "name": "alice2"})));
    assert_eq!(rows[2].2, Some(json!({"id": 1, "name": "alice2"})));
    assert_eq!(rows[2].3, None);
    assert!(rows.iter().all(|r| r.4), "changed_at が入っていない");
    // 除外列は old_row / new_row のどこにも無い。
    assert!(rows
        .iter()
        .all(|r| !format!("{:?}{:?}", r.2, r.3).contains("secret")));

    // 列追加: PostgreSQL は汎用関数なので再生成不要、他は「再生成が必要」になる。
    exec(
        state,
        side,
        "ALTER TABLE users ADD COLUMN email VARCHAR(30)",
    )
    .await;
    let st = status(state, side).await;
    if side.driver == "postgres" {
        assert!(!st.needs_regeneration);
    } else {
        assert!(st.needs_regeneration, "{st:?}");
        assert_eq!(st.added_columns, vec!["email"]);
        let regen = generate(state, side, &st.options.expect("options"), true).await;
        run_ddl(state, side, regen.create).await;
        assert!(!status(state, side).await.needs_regeneration);
    }
    exec(
        state,
        side,
        "INSERT INTO users VALUES (2, 'bob', 's2', 'bob@example.com')",
    )
    .await;
    let rows = audit_rows(state, side).await;
    let last = rows.last().expect("row");
    assert_eq!(
        last.3,
        Some(json!({"id": 2, "name": "bob", "email": "bob@example.com"}))
    );

    // DROP スクリプト: トリガーと監査表が外れ、以後は記録されない。
    let mut drop = ddl.drop_triggers.clone();
    drop.push(ddl.drop_table.clone());
    run_ddl(state, side, drop).await;
    assert!(!status(state, side).await.present);
    exec(
        state,
        side,
        "INSERT INTO users VALUES (3, 'carol', 's3', NULL)",
    )
    .await;
    let table_exists = match side.driver {
        "mysql" => "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users_audit'",
        "postgres" => "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'users_audit'",
        _ => "SELECT COUNT(*) FROM sqlite_master WHERE name = 'users_audit'",
    };
    assert!(!object_exists(state, side, table_exists).await);
}

fn temp_path(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!("noobdb_audit_{label}_{}.db", std::process::id()))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sqlite_audit_trigger_scenario() {
    let state = t::AppState::default();
    let path = temp_path("scenario");
    let _ = std::fs::remove_file(&path);
    std::fs::File::create(&path).expect("touch");
    let opts = t::sqlite_options(path.to_str().expect("utf8"));
    let conn = t::connect(&opts).await.expect("connect");
    state
        .insert(t::make_session("audit_sqlite", conn, opts, false))
        .await;
    let side = Side {
        id: "audit_sqlite".into(),
        database: None,
        driver: "sqlite",
    };
    scenario(&state, &side).await;
    let _ = std::fs::remove_file(&path);
}

/// 記録列が 64 列以上の表 (json_object の引数上限 127 を超える形、#2334) でも、
/// トリガーが作れて全列が old_row / new_row に記録される (NULL 値の列も落ちない)。
async fn wide_scenario(label: &str, ncols: usize, skip_unchanged: bool, exclude: bool) {
    let state = t::AppState::default();
    let path = temp_path(label);
    let _ = std::fs::remove_file(&path);
    std::fs::File::create(&path).expect("touch");
    let opts = t::sqlite_options(path.to_str().expect("utf8"));
    let conn = t::connect(&opts).await.expect("connect");
    state
        .insert(t::make_session("audit_wide", conn, opts, false))
        .await;
    let side = Side {
        id: "audit_wide".into(),
        database: None,
        driver: "sqlite",
    };
    let cols: Vec<String> = (0..ncols).map(|i| format!("c{i} INTEGER")).collect();
    exec(
        &state,
        &side,
        &format!(
            "CREATE TABLE users (id INTEGER PRIMARY KEY, {}, secret TEXT)",
            cols.join(", ")
        ),
    )
    .await;
    let mut o = options();
    o.skip_unchanged_update = skip_unchanged;
    if !exclude {
        o.exclude_columns.clear();
    }
    let ddl = generate(&state, &side, &o, false).await;
    run_ddl(&state, &side, ddl.create).await;

    let names: Vec<String> = (0..ncols).map(|i| format!("c{i}")).collect();
    let insert_vals: Vec<String> = (0..ncols)
        .map(|i| if i == 5 { "NULL".into() } else { i.to_string() })
        .collect();
    exec(
        &state,
        &side,
        &format!(
            "INSERT INTO users (id, {}, secret) VALUES (1, {}, 's')",
            names.join(", "),
            insert_vals.join(", ")
        ),
    )
    .await;
    exec(&state, &side, "UPDATE users SET c0 = 100 WHERE id = 1").await;
    exec(&state, &side, "DELETE FROM users WHERE id = 1").await;

    let rows = audit_rows(&state, &side).await;
    let ops: Vec<&str> = rows.iter().map(|r| r.0.as_str()).collect();
    assert_eq!(ops, vec!["INSERT", "UPDATE", "DELETE"], "{rows:?}");
    let expected_keys = 1 + ncols + usize::from(!exclude);
    let check = |v: &Option<Json>, c0: i64| {
        let obj = v.as_ref().expect("row").as_object().expect("object");
        assert_eq!(obj.len(), expected_keys, "全列が記録される");
        assert_eq!(obj["id"], json!(1));
        assert_eq!(obj["c0"], json!(c0));
        assert_eq!(obj["c5"], Json::Null, "NULL 値の列も残る");
        assert_eq!(obj[&format!("c{}", ncols - 1)], json!(ncols - 1));
        assert_eq!(obj.contains_key("secret"), !exclude);
    };
    check(&rows[0].3, 0);
    check(&rows[1].2, 0);
    check(&rows[1].3, 100);
    check(&rows[2].2, 100);
    assert_eq!(rows[0].1, Some(json!({"id": 1})));
    let _ = std::fs::remove_file(&path);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sqlite_audit_trigger_wide_table_70_columns() {
    wide_scenario("wide70", 69, true, true).await;
    wide_scenario("wide70b", 69, false, false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sqlite_audit_trigger_wide_table_200_columns() {
    wide_scenario("wide200", 200, true, true).await;
}

/// 末尾が `}` の JSON 文字列 (json_set / json() で作った値) が分割境界 (各組の最後) に来ても、
/// old_row / new_row が壊れない (#2334)。最後の列と 64 番目の列を TEXT にして確かめる。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sqlite_audit_trigger_wide_table_json_values() {
    let state = t::AppState::default();
    let path = temp_path("widejson");
    let _ = std::fs::remove_file(&path);
    std::fs::File::create(&path).expect("touch");
    let opts = t::sqlite_options(path.to_str().expect("utf8"));
    let conn = t::connect(&opts).await.expect("connect");
    state
        .insert(t::make_session("audit_wide_json", conn, opts, false))
        .await;
    let side = Side {
        id: "audit_wide_json".into(),
        database: None,
        driver: "sqlite",
    };
    // 記録列は id + c0..c67 + settings = 70 列。分割は 63 組ずつなので、
    // 1 つ目のチャンクの最後 (63 番目 = c61) と、最後の列 settings が各チャンクの末尾になる。
    let mut cols: Vec<String> = (0..68).map(|i| format!("c{i} INTEGER")).collect();
    cols[61] = "c61 TEXT".into();
    exec(
        &state,
        &side,
        &format!(
            "CREATE TABLE users (id INTEGER PRIMARY KEY, {}, settings TEXT)",
            cols.join(", ")
        ),
    )
    .await;
    let mut o = options();
    o.exclude_columns.clear();
    let ddl = generate(&state, &side, &o, false).await;
    run_ddl(&state, &side, ddl.create).await;

    exec(
        &state,
        &side,
        "INSERT INTO users (id, c61, settings) VALUES (1, json('{\"q\":{}}'), json('{\"lang\":\"en\"}'))",
    )
    .await;
    exec(
        &state,
        &side,
        "UPDATE users SET c61 = json_set(c61, '$.r', json('{}')), settings = json_set(settings, '$.lang', 'ja') WHERE id = 1",
    )
    .await;
    exec(&state, &side, "DELETE FROM users WHERE id = 1").await;

    let rows = audit_rows(&state, &side).await;
    let ops: Vec<&str> = rows.iter().map(|r| r.0.as_str()).collect();
    assert_eq!(ops, vec!["INSERT", "UPDATE", "DELETE"], "{rows:?}");
    let check = |v: &Option<Json>, c61: Json, settings: Json| {
        let obj = v
            .as_ref()
            .expect("JSON として読める")
            .as_object()
            .expect("object");
        assert_eq!(obj.len(), 70, "列数が保たれる");
        // NEW / OLD の値に JSON サブタイプが残るか (入れ子のオブジェクトか、JSON の文字列か) は
        // SQLite の版と経路で変わるので、文字列なら JSON として読み直して中身を比べる。
        let norm = |v: &Json| match v {
            Json::String(s) => serde_json::from_str::<Json>(s).expect("JSON の文字列"),
            other => other.clone(),
        };
        assert_eq!(norm(&obj["c61"]), c61);
        assert_eq!(norm(&obj["settings"]), settings);
    };
    let q = json!({"q": {}});
    let q2 = json!({"q": {}, "r": {}});
    check(&rows[0].3, q.clone(), json!({"lang": "en"}));
    check(&rows[1].2, q, json!({"lang": "en"}));
    check(&rows[1].3, q2.clone(), json!({"lang": "ja"}));
    check(&rows[2].2, q2, json!({"lang": "ja"}));
    assert_eq!(rows[0].1, Some(json!({"id": 1})));
    let _ = std::fs::remove_file(&path);
}

/// read_only 接続ではバックエンドが生成 DDL の実行を拒否する (DDL の生成自体は読み取りなので通る)。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sqlite_audit_ddl_is_rejected_on_read_only_session() {
    let state = t::AppState::default();
    let path = temp_path("ro");
    let _ = std::fs::remove_file(&path);
    std::fs::File::create(&path).expect("touch");
    let opts = t::sqlite_options(path.to_str().expect("utf8"));
    let conn = t::connect(&opts).await.expect("connect");
    conn.execute(
        "CREATE TABLE users (id INT PRIMARY KEY, name TEXT, secret TEXT)",
        None,
    )
    .await
    .expect("create");
    state
        .insert(t::make_session("audit_ro", conn, opts, true))
        .await;
    let side = Side {
        id: "audit_ro".into(),
        database: None,
        driver: "sqlite",
    };
    let ddl = generate(&state, &side, &options(), false).await;
    let err = t::run_query_transaction_via_command(&state, "audit_ro", ddl.create, None)
        .await
        .expect_err("read-only must reject");
    assert!(matches!(err, t::AppError::ReadOnly(_)), "{err}");
    let _ = std::fs::remove_file(&path);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mysql_audit_trigger_when_env_set() {
    let Some(url) = common::require_env("NOOBDB_TEST_MYSQL_URL") else {
        return;
    };
    let opts = t::parse_mysql_url(&url).expect("valid url");
    let state = t::AppState::default();
    let conn = t::connect(&opts).await.expect("connect");
    conn.execute("DROP DATABASE IF EXISTS nb2305_audit", None)
        .await
        .expect("drop");
    conn.execute("CREATE DATABASE nb2305_audit", None)
        .await
        .expect("create");
    state
        .insert(t::make_session("audit_mysql", conn, opts.clone(), false))
        .await;
    let side = Side {
        id: "audit_mysql".into(),
        database: Some("nb2305_audit".into()),
        driver: "mysql",
    };
    scenario(&state, &side).await;
    let admin = t::connect(&opts).await.expect("connect");
    let _ = admin
        .execute("DROP DATABASE IF EXISTS nb2305_audit", None)
        .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn postgres_audit_trigger_when_env_set() {
    let Some(url) = common::require_env("NOOBDB_TEST_POSTGRES_URL") else {
        return;
    };
    let opts = t::parse_postgres_url(&url).expect("valid url");
    let state = t::AppState::default();
    let conn = t::connect(&opts).await.expect("connect");
    conn.execute("DROP SCHEMA IF EXISTS nb2305_audit CASCADE", None)
        .await
        .expect("drop");
    conn.execute("CREATE SCHEMA nb2305_audit", None)
        .await
        .expect("create");
    state
        .insert(t::make_session("audit_pg", conn, opts.clone(), false))
        .await;
    let side = Side {
        id: "audit_pg".into(),
        database: Some("nb2305_audit".into()),
        driver: "postgres",
    };
    scenario(&state, &side).await;
    let admin = t::connect(&opts).await.expect("connect");
    let _ = admin
        .execute("DROP SCHEMA IF EXISTS nb2305_audit CASCADE", None)
        .await;
}
