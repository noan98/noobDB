//! 実行計画のインデックス試算 (#2326) の統合テスト。
//!
//! SQLite (一時ファイル) は常時実走する。MySQL / PostgreSQL は `NOOBDB_TEST_MYSQL_URL` /
//! `NOOBDB_TEST_POSTGRES_URL` があるときだけ実行し、専用のデータベース / スキーマ (`nb2326_*`) に
//! 閉じる。確かめること: (1) 無効化 / 追加した計画が元の計画と変わる、(2) **試算の後、スキーマに
//! 何も残らない** (インデックスの一覧が試算前と同じ)、(3) `read_only` では DDL を使う経路を
//! バックエンドが拒否する、(4) ロックを取る経路は確認なしでは実行しない。

use super::common;
use std::path::PathBuf;

use noobdb_lib::__test_api as t;

struct Side {
    id: String,
    database: Option<String>,
}

fn plan_text(r: &t::QueryResult) -> String {
    format!("{:?}", r.rows)
}

async fn exec(state: &t::AppState, side: &Side, sql: &str) {
    let s = state.get(&side.id).await.expect("session");
    s.conn
        .execute(sql, side.database.as_deref())
        .await
        .unwrap_or_else(|e| panic!("{sql}: {e}"));
}

async fn index_names(state: &t::AppState, side: &Side) -> Vec<String> {
    let s = state.get(&side.id).await.expect("session");
    let mut names: Vec<String> = s
        .conn
        .list_indexes(side.database.as_deref().unwrap_or(""), "t")
        .await
        .expect("list indexes")
        .into_iter()
        .map(|i| i.name)
        .collect();
    names.sort();
    names
}

const SQL_A: &str = "SELECT * FROM t WHERE a = 7";
const SQL_B: &str = "SELECT * FROM t WHERE b = 7";

fn request(
    side: &Side,
    sql: &str,
    action: t::IndexWhatIfAction,
    index: Option<&str>,
    columns: &[&str],
    confirm: bool,
) -> t::IndexWhatIfRequest {
    t::IndexWhatIfRequest {
        database: side.database.clone(),
        table: "t".into(),
        sql: sql.into(),
        action,
        index: index.map(str::to_string),
        columns: columns.iter().map(|c| c.to_string()).collect(),
        confirm_locking: confirm,
        lock_timeout_secs: None,
    }
}

async fn seed(state: &t::AppState, side: &Side, int_ty: &str) {
    exec(
        state,
        side,
        &format!("CREATE TABLE t (id {int_ty} PRIMARY KEY, a INT, b INT, pad VARCHAR(50))"),
    )
    .await;
    exec(state, side, "CREATE INDEX idx_a ON t (a)").await;
    // 十分な行数 (a は 100 通り) を入れて、インデックスが選ばれる計画にする。
    let rows: Vec<String> = (1..=1500)
        .map(|i| format!("({i}, {}, {}, 'x')", i % 100, i % 50))
        .collect();
    for chunk in rows.chunks(300) {
        exec(
            state,
            side,
            &format!("INSERT INTO t (id, a, b, pad) VALUES {}", chunk.join(",")),
        )
        .await;
    }
}

async fn sqlite_side(state: &t::AppState, id: &str, read_only: bool) -> (Side, PathBuf) {
    let path = std::env::temp_dir().join(format!("noobdb_whatif_{id}_{}.db", std::process::id()));
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sqlite_whatif_disable_and_add_leave_no_trace() {
    let state = t::AppState::default();
    let (side, path) = sqlite_side(&state, "wi_sqlite", false).await;
    seed(&state, &side, "INTEGER").await;
    exec(&state, &side, "ANALYZE").await;
    let names_before = index_names(&state, &side).await;
    assert!(names_before.iter().any(|n| n == "idx_a"));

    let support = t::get_index_whatif_support_inner(&state, &side.id)
        .await
        .expect("support");
    assert!(support.disable.locks_table && support.add.builds_index);

    // ロックを取る経路は確認なしでは実行しない。
    let no_confirm = request(
        &side,
        SQL_A,
        t::IndexWhatIfAction::Disable,
        Some("idx_a"),
        &[],
        false,
    );
    let err = t::run_index_whatif_inner(&state, &side.id, no_confirm)
        .await
        .expect_err("needs confirmation");
    assert!(matches!(err, t::AppError::InvalidInput(_)), "{err}");

    let disable = request(
        &side,
        SQL_A,
        t::IndexWhatIfAction::Disable,
        Some("idx_a"),
        &[],
        true,
    );
    let out = t::run_index_whatif_inner(&state, &side.id, disable)
        .await
        .expect("disable");
    assert!(
        plan_text(&out.before).contains("idx_a"),
        "{}",
        plan_text(&out.before)
    );
    assert!(
        !plan_text(&out.after).contains("idx_a"),
        "{}",
        plan_text(&out.after)
    );
    assert_eq!(index_names(&state, &side).await, names_before);

    let add = request(&side, SQL_B, t::IndexWhatIfAction::Add, None, &["b"], true);
    let out = t::run_index_whatif_inner(&state, &side.id, add)
        .await
        .expect("add");
    assert!(!plan_text(&out.before).contains("noobdb_whatif_idx"));
    assert!(
        plan_text(&out.after).contains("noobdb_whatif_idx"),
        "{}",
        plan_text(&out.after)
    );
    assert_eq!(index_names(&state, &side).await, names_before);

    // 主キーは無効化できない。存在しないインデックス・EXPLAIN 付き・書き込み SQL も拒否。
    for bad in [
        request(
            &side,
            SQL_A,
            t::IndexWhatIfAction::Disable,
            Some("nope"),
            &[],
            true,
        ),
        request(
            &side,
            "EXPLAIN SELECT 1",
            t::IndexWhatIfAction::Add,
            None,
            &["b"],
            true,
        ),
        request(
            &side,
            "DELETE FROM t",
            t::IndexWhatIfAction::Add,
            None,
            &["b"],
            true,
        ),
    ] {
        assert!(t::run_index_whatif_inner(&state, &side.id, bad)
            .await
            .is_err());
    }
    assert_eq!(count_rows(&state, &side).await, 1500);
    let _ = std::fs::remove_file(&path);
}

async fn count_rows(state: &t::AppState, side: &Side) -> i64 {
    let s = state.get(&side.id).await.expect("session");
    let r = s
        .conn
        .execute("SELECT COUNT(*) FROM t", side.database.as_deref())
        .await
        .expect("count");
    match &r.rows[0][0] {
        t::Value::Int(n) => *n,
        t::Value::UInt(n) => *n as i64,
        t::Value::String(s) => s.parse().expect("num"),
        other => panic!("unexpected {other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sqlite_whatif_rejects_read_only() {
    let state = t::AppState::default();
    let (writer, path) = sqlite_side(&state, "wi_sqlite_w", false).await;
    seed(&state, &writer, "INTEGER").await;
    let opts = t::sqlite_options(path.to_str().expect("utf8 path"));
    let conn = t::connect(&opts).await.expect("connect sqlite");
    state
        .insert(t::make_session("wi_sqlite_ro", conn, opts, true))
        .await;
    let side = Side {
        id: "wi_sqlite_ro".into(),
        database: None,
    };
    let support = t::get_index_whatif_support_inner(&state, &side.id)
        .await
        .expect("support");
    assert_eq!(
        support.disable.unavailable,
        Some(t::IndexWhatIfUnavailable::ReadOnly)
    );
    for r in [
        request(
            &side,
            SQL_A,
            t::IndexWhatIfAction::Disable,
            Some("idx_a"),
            &[],
            true,
        ),
        request(&side, SQL_B, t::IndexWhatIfAction::Add, None, &["b"], true),
    ] {
        let err = t::run_index_whatif_inner(&state, &side.id, r)
            .await
            .expect_err("read-only");
        assert!(matches!(err, t::AppError::ReadOnly(_)), "{err}");
    }
    let _ = std::fs::remove_file(&path);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mysql_whatif_when_env_set() {
    let Some(url) = common::require_env("NOOBDB_TEST_MYSQL_URL") else {
        return;
    };
    let opts = t::parse_mysql_url(&url).expect("valid url");
    let name = "nb2326_whatif";
    let admin = t::connect(&opts).await.expect("connect");
    admin
        .execute(&format!("DROP DATABASE IF EXISTS {name}"), None)
        .await
        .expect("drop");
    admin
        .execute(&format!("CREATE DATABASE {name}"), None)
        .await
        .expect("create");
    let state = t::AppState::default();
    for (id, ro) in [("wi_mysql", false), ("wi_mysql_ro", true)] {
        let conn = t::connect(&opts).await.expect("connect");
        state
            .insert(t::make_session(id, conn, opts.clone(), ro))
            .await;
    }
    let side = Side {
        id: "wi_mysql".into(),
        database: Some(name.into()),
    };
    seed(&state, &side, "INT").await;
    exec(&state, &side, "ANALYZE TABLE t").await;
    let names_before = index_names(&state, &side).await;

    // read_only でも IGNORE INDEX は DB に何も書かないので使える。
    for id in ["wi_mysql", "wi_mysql_ro"] {
        let s = Side {
            id: id.into(),
            database: Some(name.into()),
        };
        let r = request(
            &s,
            "SELECT * FROM t x WHERE a = 7",
            t::IndexWhatIfAction::Disable,
            Some("idx_a"),
            &[],
            false,
        );
        let out = t::run_index_whatif_inner(&state, id, r)
            .await
            .expect("disable");
        assert!(
            plan_text(&out.before).contains("idx_a"),
            "{}",
            plan_text(&out.before)
        );
        assert!(
            !plan_text(&out.after).contains("idx_a"),
            "{}",
            plan_text(&out.after)
        );
    }
    assert_eq!(index_names(&state, &side).await, names_before);

    let add = request(&side, SQL_B, t::IndexWhatIfAction::Add, None, &["b"], true);
    let err = t::run_index_whatif_inner(&state, &side.id, add)
        .await
        .expect_err("add unsupported");
    assert!(matches!(err, t::AppError::InvalidInput(_)), "{err}");
    let _ = admin
        .execute(&format!("DROP DATABASE IF EXISTS {name}"), None)
        .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn postgres_whatif_when_env_set() {
    let Some(url) = common::require_env("NOOBDB_TEST_POSTGRES_URL") else {
        return;
    };
    let opts = t::parse_postgres_url(&url).expect("valid url");
    let name = "nb2326_whatif";
    let admin = t::connect(&opts).await.expect("connect");
    admin
        .execute(&format!("DROP SCHEMA IF EXISTS {name} CASCADE"), None)
        .await
        .expect("drop");
    admin
        .execute(&format!("CREATE SCHEMA {name}"), None)
        .await
        .expect("create");
    let state = t::AppState::default();
    for (id, ro) in [("wi_pg", false), ("wi_pg_ro", true)] {
        let conn = t::connect(&opts).await.expect("connect");
        state
            .insert(t::make_session(id, conn, opts.clone(), ro))
            .await;
    }
    let side = Side {
        id: "wi_pg".into(),
        database: Some(name.into()),
    };
    seed(&state, &side, "INT").await;
    exec(&state, &side, "ANALYZE t").await;
    let names_before = index_names(&state, &side).await;
    let support = t::get_index_whatif_support_inner(&state, &side.id)
        .await
        .expect("support");
    let ro = Side {
        id: "wi_pg_ro".into(),
        database: Some(name.into()),
    };

    let disable = |s: &Side, confirm: bool| {
        request(
            s,
            SQL_A,
            t::IndexWhatIfAction::Disable,
            Some("idx_a"),
            &[],
            confirm,
        )
    };
    if support.hypopg_version.is_none() {
        // hypopg なし: 無効化は DDL 経路 (確認が要り、read_only は拒否)、追加は非対応。
        let err = t::run_index_whatif_inner(&state, &side.id, disable(&side, false))
            .await
            .expect_err("needs confirmation");
        assert!(matches!(err, t::AppError::InvalidInput(_)), "{err}");
        let err = t::run_index_whatif_inner(&state, &ro.id, disable(&ro, true))
            .await
            .expect_err("read-only");
        assert!(matches!(err, t::AppError::ReadOnly(_)), "{err}");
        let add = request(&side, SQL_B, t::IndexWhatIfAction::Add, None, &["b"], true);
        let err = t::run_index_whatif_inner(&state, &side.id, add)
            .await
            .expect_err("needs hypopg");
        assert!(matches!(err, t::AppError::InvalidInput(_)), "{err}");
    }
    let out = t::run_index_whatif_inner(&state, &side.id, disable(&side, true))
        .await
        .expect("disable");
    assert!(
        plan_text(&out.before).contains("idx_a"),
        "{}",
        plan_text(&out.before)
    );
    assert!(
        !plan_text(&out.after).contains("idx_a"),
        "{}",
        plan_text(&out.after)
    );
    assert_eq!(index_names(&state, &side).await, names_before);
    // ロールバック後は、別のセッションからも元の計画で使える (ロック・DDL が残らない)。
    exec(&state, &side, "SELECT 1").await;
    let again = t::run_index_whatif_inner(&state, &side.id, disable(&side, true))
        .await
        .expect("again");
    assert!(plan_text(&again.before).contains("idx_a"));

    if support.hypopg_version.is_some() {
        let add = request(&side, SQL_B, t::IndexWhatIfAction::Add, None, &["b"], false);
        let out = t::run_index_whatif_inner(
            &state,
            &ro.id,
            request(&ro, SQL_B, t::IndexWhatIfAction::Add, None, &["b"], false),
        )
        .await
        .expect("hypopg add works on read-only");
        assert!(
            plan_text(&out.after).contains("btree_t_b"),
            "{}",
            plan_text(&out.after)
        );
        let _ = add;
        assert_eq!(index_names(&state, &side).await, names_before);
    }
    let _ = admin
        .execute(&format!("DROP SCHEMA IF EXISTS {name} CASCADE"), None)
        .await;
}
