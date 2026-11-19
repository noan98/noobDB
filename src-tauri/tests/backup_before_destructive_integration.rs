//! 破壊的操作の前の退避コピー (#2448) の統合テスト。
//!
//! フロントの `backupBeforeDestructive.ts` が組み立てた退避文・復元 SQL を共有ベクタ
//! (`src/__tests__/fixtures/backupVectors.json`、`backupGolden.test.ts` が生成・固定) として受け取り、
//! 実 DB で「元の行を控える → 退避 → (親行の削除) → 本操作 (DROP / TRUNCATE) → 復元 → 元の行と一致」を確かめる。
//! 生成列・自動採番 / identity / serial・クオートが要る名前・FK (親行の削除で CASCADE しても退避は消えない) を含む。
//! SQLite (一時ファイル) は常時実走し、MySQL / PostgreSQL は `NOOBDB_TEST_MYSQL_URL` /
//! `NOOBDB_TEST_POSTGRES_URL` があるときだけ、専用のデータベース / スキーマ (`nb2448_backup`) に閉じて実行する。

use super::common; // 共有ヘルパは groups/*.rs が 1 度だけ取り込む
use std::path::PathBuf;

use noobdb_lib::__test_api as t;
use serde::Deserialize;

const VECTORS_JSON: &str = include_str!("../../src/__tests__/fixtures/backupVectors.json");

#[derive(Deserialize)]
struct Vectors {
    database: String,
    cases: Vec<Case>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    name: String,
    driver: String,
    database: Option<String>,
    kind: String,
    setup: Vec<String>,
    check_sql: String,
    backup_statements: Vec<String>,
    after_backup: Vec<String>,
    before_restore: Vec<String>,
    main_sql: String,
    restore_sql: String,
}

fn vectors() -> Vectors {
    serde_json::from_str(VECTORS_JSON).expect("backupVectors.json")
}

async fn run(
    state: &t::AppState,
    id: &str,
    database: Option<&str>,
    sql: &str,
) -> Result<t::QueryResult, t::AppError> {
    let s = state.get(id).await.expect("session");
    s.conn.execute(sql, database).await
}

/// 確認用の SELECT の結果を文字列化して比べる (同じ接続・同じ型で往復するので Debug 表現で足りる)。
async fn rows(state: &t::AppState, id: &str, database: Option<&str>, sql: &str) -> String {
    let r = run(state, id, database, sql)
        .await
        .unwrap_or_else(|e| panic!("{sql}: {e}"));
    format!("{:?}", r.rows)
}

async fn scenario(state: &t::AppState, id: &str, c: &Case) {
    let db = c.database.as_deref();
    for s in &c.setup {
        run(state, id, db, s)
            .await
            .unwrap_or_else(|e| panic!("[{}] setup {s}: {e}", c.name));
    }
    let before = rows(state, id, db, &c.check_sql).await;
    assert!(
        before.contains("Int") || before.contains("String"),
        "[{}] 空では検証にならない: {before}",
        c.name
    );

    // 1) 退避 (成功しなければ本操作へ進まない)。
    for s in &c.backup_statements {
        run(state, id, db, s)
            .await
            .unwrap_or_else(|e| panic!("[{}] backup {s}: {e}", c.name));
    }
    // 2) 親行の削除。元の表の子行は CASCADE で消えるが、退避の表には FK が無いので残る。
    for s in &c.after_backup {
        run(state, id, db, s)
            .await
            .unwrap_or_else(|e| panic!("[{}] afterBackup {s}: {e}", c.name));
    }
    // 3) 本操作。
    run(state, id, db, &c.main_sql)
        .await
        .unwrap_or_else(|e| panic!("[{}] main {}: {e}", c.name, c.main_sql));
    if c.kind == "drop" {
        assert!(
            run(state, id, db, &c.check_sql).await.is_err(),
            "[{}] DROP 後は元の表が無い",
            c.name
        );
    } else {
        assert_ne!(
            rows(state, id, db, &c.check_sql).await,
            before,
            "[{}] 本操作で行が消える",
            c.name
        );
    }
    // 4) 復元 SQL で元に戻る (復元先の表の FK を満たすため、先に親行を戻す)。
    for s in &c.before_restore {
        run(state, id, db, s)
            .await
            .unwrap_or_else(|e| panic!("[{}] beforeRestore {s}: {e}", c.name));
    }
    run(state, id, db, &c.restore_sql)
        .await
        .unwrap_or_else(|e| panic!("[{}] restore {}: {e}", c.name, c.restore_sql));
    let after = rows(state, id, db, &c.check_sql).await;
    assert_eq!(before, after, "[{}] 復元後は元の行と一致する", c.name);
}

fn temp_path(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!("noobdb_backup_{label}_{}.db", std::process::id()))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sqlite_backup_then_destroy_then_restore() {
    let state = t::AppState::default();
    let path = temp_path("sqlite");
    let _ = std::fs::remove_file(&path);
    std::fs::File::create(&path).expect("touch sqlite file");
    let opts = t::sqlite_options(path.to_str().expect("utf8 path"));
    let conn = t::connect(&opts).await.expect("connect sqlite");
    state
        .insert(t::make_recording_session("bk_sqlite", conn, opts))
        .await;
    let v = vectors();
    let mut n = 0;
    for c in v.cases.iter().filter(|c| c.driver == "sqlite") {
        scenario(&state, "bk_sqlite", c).await;
        n += 1;
    }
    assert!(n >= 2, "drop / truncate の両方を流す");
    let _ = std::fs::remove_file(&path);
}

async fn server_scenarios(
    opts: &t::DbConnectOptions,
    id: &str,
    driver: &str,
    drop_sql: &str,
    create_sql: &str,
) {
    let v = vectors();
    let conn = t::connect(opts).await.expect("connect");
    conn.execute(drop_sql, None).await.expect("drop");
    conn.execute(create_sql, None).await.expect("create");
    let state = t::AppState::default();
    state
        .insert(t::make_recording_session(id, conn, opts.clone()))
        .await;
    let mut n = 0;
    for c in v.cases.iter().filter(|c| c.driver == driver) {
        scenario(&state, id, c).await;
        n += 1;
    }
    assert!(n >= 2, "drop / truncate の両方を流す");
    let admin = t::connect(opts).await.expect("connect");
    let _ = admin.execute(drop_sql, None).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mysql_backup_then_destroy_then_restore_when_env_set() {
    let Some(url) = common::require_env("NOOBDB_TEST_MYSQL_URL") else {
        return;
    };
    let opts = t::parse_mysql_url(&url).expect("valid url");
    let name = vectors().database;
    server_scenarios(
        &opts,
        "bk_mysql",
        "mysql",
        &format!("DROP DATABASE IF EXISTS {name}"),
        &format!("CREATE DATABASE {name}"),
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn postgres_backup_then_destroy_then_restore_when_env_set() {
    let Some(url) = common::require_env("NOOBDB_TEST_POSTGRES_URL") else {
        return;
    };
    let opts = t::parse_postgres_url(&url).expect("valid url");
    let name = vectors().database;
    server_scenarios(
        &opts,
        "bk_pg",
        "postgres",
        &format!("DROP SCHEMA IF EXISTS {name} CASCADE"),
        &format!("CREATE SCHEMA {name}"),
    )
    .await;
}
