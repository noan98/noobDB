//! `.sql` スクリプトランナー (`run_sql_script`, #973) の統合テスト。
//!
//! SQLite の一時ファイルに対して**常時実走**する (外部サーバ不要)。Tauri ランタイムを
//! 立てずに、コマンドと同じコア (`commands::script::run_script_core` — ファイル読み +
//! ストリーミング文分割 + 文ごとの read-only ガード + 実行 + トランザクション制御) を
//! `__test_api::run_sql_script_via_core` 経由で駆動し、次を検証する:
//!
//! * 複数文スクリプトの逐次実行 (文字列/コメント内の `;`、スクリプト内の
//!   `BEGIN TRANSACTION` / `COMMIT` の読み替え)
//! * エラーで停止 (既定) / continue-on-error / wrap-in-transaction のロールバック
//! * 読み取り専用セッションでの文ごとの書き込み拒否
//! * キャンセル (タスク abort): autocommit 分は残り、トランザクションは
//!   ドロップガードが ROLLBACK する

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use noobdb_lib::__test_api as t;

struct Fixture {
    db: PathBuf,
    scripts: Vec<PathBuf>,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.db);
        for s in &self.scripts {
            let _ = std::fs::remove_file(s);
        }
    }
}

fn unique(tag: &str, ext: &str) -> PathBuf {
    let mut p = std::env::temp_dir();
    p.push(format!("noobdb_script_{tag}_{}.{ext}", std::process::id()));
    p
}

async fn setup(tag: &str, read_only: bool) -> (Fixture, Arc<t::Session>) {
    let db = unique(tag, "db");
    let _ = std::fs::remove_file(&db);
    std::fs::File::create(&db).expect("create temp sqlite file");
    let opts = t::sqlite_options(db.to_str().expect("utf8 path"));
    let conn = t::connect(&opts).await.expect("connect");
    let session = Arc::new(t::make_session(tag, conn, opts, read_only));
    (
        Fixture {
            db,
            scripts: Vec::new(),
        },
        session,
    )
}

fn write_script(fx: &mut Fixture, name: &str, body: &str) -> String {
    let p = unique(name, "sql");
    std::fs::write(&p, body).expect("write script");
    fx.scripts.push(p.clone());
    p.to_string_lossy().into_owned()
}

async fn count(session: &t::Session, table: &str) -> i64 {
    let r = session
        .conn
        .execute(&format!("SELECT COUNT(*) FROM {table}"), None)
        .await
        .expect("count");
    match &r.rows[0][0] {
        t::Value::Int(n) => *n,
        other => panic!("unexpected count value: {other:?}"),
    }
}

fn opts(continue_on_error: bool, wrap_in_transaction: bool) -> t::ScriptOptions {
    t::ScriptOptions {
        continue_on_error,
        wrap_in_transaction,
    }
}

async fn run(session: &Arc<t::Session>, path: &str, o: t::ScriptOptions) -> t::ScriptRun {
    t::run_sql_script_via_core(
        session.clone(),
        path,
        None,
        o,
        Arc::new(AtomicU64::new(0)),
        |_| {},
    )
    .await
    .expect("script setup")
}

/// SQLite で数百 ms かかる読み取り専用クエリ (キャンセルを実行中に当てるため)。
const SLOW: &str =
    "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 2000000) SELECT COUNT(*) FROM c";

#[tokio::test]
async fn runs_multi_statement_script_sequentially() {
    let (mut fx, session) = setup("seq", false).await;
    // noobDB の SQLite ダンプと同じく BEGIN TRANSACTION ... COMMIT で包まれた形。
    let script = "-- header comment; not a statement\n\
PRAGMA foreign_keys=OFF;\n\
BEGIN TRANSACTION;\n\
CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT);\n\
INSERT INTO items VALUES (1, 'a;b');\n\
/* block; comment */\n\
INSERT INTO items VALUES (2, 'it''s');\n\
INSERT INTO items VALUES (3, '日本語')\n\
;\n\
COMMIT;\n\
SELECT COUNT(*) FROM items";
    let path = write_script(&mut fx, "seq", script);
    let progress_calls = Arc::new(AtomicU64::new(0));
    let pc = progress_calls.clone();
    let result = t::run_sql_script_via_core(
        session.clone(),
        &path,
        None,
        opts(false, false),
        Arc::new(AtomicU64::new(0)),
        move |p| {
            assert!(p.bytes_read <= p.total_bytes);
            pc.fetch_add(1, Ordering::SeqCst);
        },
    )
    .await
    .expect("run");
    match result {
        t::ScriptRun::Done {
            executed,
            succeeded,
            failed_count,
            skipped_control,
            rows_affected,
            ..
        } => {
            // PRAGMA + CREATE + 3 INSERT + SELECT (BEGIN/COMMIT は制御文として読み替え)。
            assert_eq!(executed, 6);
            assert_eq!(succeeded, 6);
            assert_eq!(failed_count, 0);
            assert_eq!(skipped_control, 0);
            assert!(rows_affected >= 3);
        }
        other => panic!("expected Done, got {other:?}"),
    }
    assert!(progress_calls.load(Ordering::SeqCst) >= 1);
    assert_eq!(count(&session, "items").await, 3);
    assert!(
        !session.conn.transaction_active().await,
        "script BEGIN/COMMIT must not leave a transaction open"
    );
}

#[tokio::test]
async fn stops_on_first_error_by_default() {
    let (mut fx, session) = setup("stop", false).await;
    let path = write_script(
        &mut fx,
        "stop",
        "CREATE TABLE t (id INTEGER PRIMARY KEY);\nINSERT INTO t VALUES (1);\n\nINSERT INTO nope VALUES (1);\nINSERT INTO t VALUES (2);",
    );
    match run(&session, &path, opts(false, false)).await {
        t::ScriptRun::Failed {
            failure,
            executed,
            rolled_back,
            ..
        } => {
            let f = failure.expect("failing statement is reported");
            assert_eq!(f.line, 4);
            assert_eq!(f.index, 3);
            assert!(f.sql.contains("nope"));
            assert_eq!(executed, 3);
            assert!(!rolled_back);
        }
        other => panic!("expected Failed, got {other:?}"),
    }
    // autocommit なので失敗前の INSERT は残り、失敗後の文は実行されない。
    assert_eq!(count(&session, "t").await, 1);
}

#[tokio::test]
async fn continue_on_error_skips_failures_and_lists_them() {
    let (mut fx, session) = setup("cont", false).await;
    let path = write_script(
        &mut fx,
        "cont",
        "CREATE TABLE t (id INTEGER PRIMARY KEY);\nINSERT INTO t VALUES (1);\nINSERT INTO t VALUES (1);\nINSERT INTO nope VALUES (1);\nINSERT INTO t VALUES (2);",
    );
    match run(&session, &path, opts(true, false)).await {
        t::ScriptRun::Done {
            executed,
            succeeded,
            failed_count,
            failures,
            ..
        } => {
            assert_eq!(executed, 5);
            assert_eq!(succeeded, 3);
            assert_eq!(failed_count, 2);
            let lines: Vec<u64> = failures.iter().map(|f| f.line).collect();
            assert_eq!(lines, vec![3, 4]);
        }
        other => panic!("expected Done, got {other:?}"),
    }
    assert_eq!(count(&session, "t").await, 2);
}

#[tokio::test]
async fn wrap_in_transaction_rolls_back_everything_on_error() {
    let (mut fx, session) = setup("wrap", false).await;
    session
        .conn
        .execute("CREATE TABLE t (id INTEGER PRIMARY KEY)", None)
        .await
        .expect("create");
    let path = write_script(
        &mut fx,
        "wrap",
        "BEGIN;\nINSERT INTO t VALUES (1);\nINSERT INTO t VALUES (2);\nINSERT INTO nope VALUES (1);\nCOMMIT;",
    );
    match run(&session, &path, opts(false, true)).await {
        t::ScriptRun::Failed {
            rolled_back,
            failure,
            ..
        } => {
            assert!(rolled_back);
            assert_eq!(failure.expect("failure").line, 4);
        }
        other => panic!("expected Failed, got {other:?}"),
    }
    assert_eq!(count(&session, "t").await, 0);
    assert!(!session.conn.transaction_active().await);

    // 成功時はスクリプト内の BEGIN/COMMIT を読み飛ばしてまとめてコミットする。
    let ok = write_script(
        &mut fx,
        "wrap_ok",
        "BEGIN;\nINSERT INTO t VALUES (1);\nINSERT INTO t VALUES (2);\nCOMMIT;",
    );
    match run(&session, &ok, opts(false, true)).await {
        t::ScriptRun::Done {
            skipped_control, ..
        } => assert_eq!(skipped_control, 2),
        other => panic!("expected Done, got {other:?}"),
    }
    assert_eq!(count(&session, "t").await, 2);
    assert!(!session.conn.transaction_active().await);
}

#[tokio::test]
async fn combined_options_are_rejected() {
    let (mut fx, session) = setup("combo", false).await;
    let path = write_script(&mut fx, "combo", "SELECT 1");
    let err = t::run_sql_script_via_core(
        session.clone(),
        &path,
        None,
        opts(true, true),
        Arc::new(AtomicU64::new(0)),
        |_| {},
    )
    .await
    .expect_err("continueOnError + wrapInTransaction must be rejected");
    assert!(matches!(err, t::AppError::InvalidInput(_)));
}

#[tokio::test]
async fn read_only_session_rejects_each_write_statement() {
    let (mut fx, session) = setup("ro", false).await;
    session
        .conn
        .execute("CREATE TABLE t (id INTEGER PRIMARY KEY)", None)
        .await
        .expect("create");
    // 同じファイルを読み取り専用セッションで開き直す。
    let opts_ro = t::sqlite_options(fx.db.to_str().expect("utf8"));
    let conn_ro = t::connect(&opts_ro).await.expect("connect ro");
    let ro = Arc::new(t::make_session("ro2", conn_ro, opts_ro, true));
    let path = write_script(
        &mut fx,
        "ro",
        "SELECT 1;\nINSERT INTO t VALUES (1);\nSELECT 2;\nSELECT 1; DELETE FROM t",
    );
    // 既定 (停止) モード: 2 文目の INSERT で止まる。
    match run(&ro, &path, opts(false, false)).await {
        t::ScriptRun::Failed { failure, .. } => {
            let f = failure.expect("failure");
            assert_eq!(f.line, 2);
            assert!(f.error.contains("read-only"), "{}", f.error);
        }
        other => panic!("expected Failed, got {other:?}"),
    }
    // continue-on-error でも書き込み文はすべて拒否され、SELECT だけが通る。
    match run(&ro, &path, opts(true, false)).await {
        t::ScriptRun::Done {
            succeeded,
            failed_count,
            ..
        } => {
            assert_eq!(succeeded, 3);
            assert_eq!(failed_count, 2);
        }
        other => panic!("expected Done, got {other:?}"),
    }
    // wrap-in-transaction でも同じガードが効く。
    assert!(matches!(
        run(&ro, &path, opts(false, true)).await,
        t::ScriptRun::Failed { .. }
    ));
    assert_eq!(count(&session, "t").await, 0);
}

async fn wait_until<F: Fn() -> bool>(cond: F, what: &str) {
    for _ in 0..3000 {
        if cond() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("timed out waiting for {what}");
}

#[tokio::test]
async fn cancel_keeps_committed_statements_in_autocommit_mode() {
    let (mut fx, session) = setup("cancel", false).await;
    let mut script = String::from(
        "CREATE TABLE t (id INTEGER PRIMARY KEY);\nINSERT INTO t VALUES (1);\nINSERT INTO t VALUES (2);\n",
    );
    for _ in 0..20 {
        script.push_str(SLOW);
        script.push_str(";\n");
    }
    script.push_str("INSERT INTO t VALUES (3);\n");
    let path = write_script(&mut fx, "cancel", &script);

    let committed = Arc::new(AtomicU64::new(0));
    let c2 = committed.clone();
    let s2 = session.clone();
    let handle = tokio::spawn(async move {
        t::run_sql_script_via_core(s2, &path, None, opts(false, false), c2, |_| {}).await
    });
    let c3 = committed.clone();
    wait_until(
        move || c3.load(Ordering::SeqCst) >= 3,
        "the first statements",
    )
    .await;
    handle.abort();
    assert!(handle.await.is_err(), "task must be cancelled");

    // 中断前に確定した CREATE + 2 INSERT は残り、末尾の INSERT は実行されない。
    assert_eq!(count(&session, "t").await, 2);
    assert!(committed.load(Ordering::SeqCst) >= 3);
    assert!(!session.conn.transaction_active().await);
}

#[tokio::test]
async fn cancel_rolls_back_the_wrapping_transaction() {
    let (mut fx, session) = setup("cancel_tx", false).await;
    session
        .conn
        .execute("CREATE TABLE t (id INTEGER PRIMARY KEY)", None)
        .await
        .expect("create");
    let mut script = String::from("INSERT INTO t VALUES (1);\nINSERT INTO t VALUES (2);\n");
    for _ in 0..20 {
        script.push_str(SLOW);
        script.push_str(";\n");
    }
    let path = write_script(&mut fx, "cancel_tx", &script);

    let executed = Arc::new(AtomicU64::new(0));
    let e2 = executed.clone();
    let s2 = session.clone();
    let handle = tokio::spawn(async move {
        t::run_sql_script_via_core(
            s2,
            &path,
            None,
            opts(false, true),
            Arc::new(AtomicU64::new(0)),
            move |p| e2.store(p.executed, Ordering::SeqCst),
        )
        .await
    });
    let e3 = executed.clone();
    wait_until(
        move || e3.load(Ordering::SeqCst) >= 3,
        "progress inside the transaction",
    )
    .await;
    assert!(session.conn.transaction_active().await);
    handle.abort();
    assert!(handle.await.is_err(), "task must be cancelled");

    // ドロップガードが spawn した ROLLBACK を待つ。
    for _ in 0..3000 {
        if !session.conn.transaction_active().await {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(!session.conn.transaction_active().await);
    assert_eq!(count(&session, "t").await, 0);
}
