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
        ..Default::default()
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

// ---------------------------------------------------------------------------
// エディタのバッチ実行 (`run_sql_batch`, #1256)。`.sql` ランナーと同じコアを
// 文字列の Cursor で再利用し、文ごとの結果を返す。
// ---------------------------------------------------------------------------

async fn batch(
    session: &Arc<t::Session>,
    sql: &str,
    stop_on_error: bool,
    preview_rows: usize,
) -> (t::ScriptRun, Vec<t::BatchStatementResult>) {
    t::run_sql_batch_via_core(
        session.clone(),
        sql,
        None,
        stop_on_error,
        preview_rows,
        Arc::new(AtomicU64::new(0)),
    )
    .await
    .expect("batch setup")
}

#[tokio::test]
async fn batch_returns_one_result_per_statement() {
    let (_fx, session) = setup("batch_basic", false).await;
    let (run, results) = batch(
        &session,
        "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT);\n\
         INSERT INTO t VALUES (1, 'a;b'), (2, 'c');\n\
         SELECT id, v FROM t ORDER BY id;\n\
         SELECT id FROM t WHERE id > 100",
        true,
        200,
    )
    .await;
    assert!(matches!(run, t::ScriptRun::Done { .. }));
    assert_eq!(results.len(), 4);
    assert!(results.iter().all(|r| r.status == t::BatchStatus::Ok));
    // DDL / DML は columns なしで影響行数を返す。
    assert!(results[0].columns.is_none());
    assert_eq!(results[1].rows_affected, Some(2));
    // SELECT は列と行を返す (文字列内の `;` で分割されない)。
    assert_eq!(results[2].columns.as_ref().map(Vec::len), Some(2));
    let rows = results[2].rows.as_ref().expect("rows");
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0][1], t::Value::String("a;b".into()));
    // 0 行の SELECT でも準備済み文のメタデータから列見出しを返す (#1534)。影響行数ではなく
    // 「0 行の結果セット」として扱い、切り詰めは無く総行数は 0。
    assert_eq!(results[3].columns.as_ref().map(Vec::len), Some(1));
    assert_eq!(results[3].rows.as_ref().map(Vec::len), Some(0));
    assert_eq!(results[3].rows_affected, None);
    assert!(!results[3].truncated);
    assert_eq!(results[3].total_rows, Some(0));
    // 切り詰めの無い SELECT は総行数 = 返した行数。
    assert!(!results[2].truncated);
    assert_eq!(results[2].total_rows, Some(2));
    assert_eq!(count(&session, "t").await, 2);
}

#[tokio::test]
async fn batch_caps_select_rows_at_the_preview_limit() {
    let (_fx, session) = setup("batch_cap", false).await;
    let big =
        "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 100000) SELECT x FROM c";
    let (_run, results) = batch(&session, big, true, 7).await;
    assert_eq!(results.len(), 1);
    let rows = results[0].rows.as_ref().expect("rows");
    assert_eq!(rows.len(), 7, "取得は preview_rows 件で打ち切られる");
    assert_eq!(rows[0][0], t::Value::Int(1));
    assert_eq!(rows[6][0], t::Value::Int(7));
    // 続きの行があるので切り詰め済み。途中で打ち切ったため総行数は不明 (#1534)。
    assert!(results[0].truncated);
    assert_eq!(results[0].total_rows, None);
    // 打ち切り後も同じ接続 (プール) が使える。
    assert_eq!(
        session
            .conn
            .execute("SELECT 1", None)
            .await
            .expect("pool still usable")
            .rows
            .len(),
        1
    );
}

#[tokio::test]
async fn batch_preview_limit_is_not_reported_as_truncated_when_rows_fit_exactly() {
    let (_fx, session) = setup("batch_exact", false).await;
    let sql = "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 7) SELECT x FROM c";
    let (_run, results) = batch(&session, sql, true, 7).await;
    assert_eq!(results[0].rows.as_ref().map(Vec::len), Some(7));
    // ちょうど上限件数ぴったりは切り詰めではない。
    assert!(!results[0].truncated);
    assert_eq!(results[0].total_rows, Some(7));
    // 1 行多いと切り詰め。
    let (_run, results) = batch(&session, sql, true, 6).await;
    assert_eq!(results[0].rows.as_ref().map(Vec::len), Some(6));
    assert!(results[0].truncated);
}

#[tokio::test]
async fn batch_stops_on_error_and_skips_the_rest() {
    let (_fx, session) = setup("batch_stop", false).await;
    let (run, results) = batch(
        &session,
        "CREATE TABLE t (id INTEGER PRIMARY KEY);\n\
         INSERT INTO t VALUES (1);\n\
         INSERT INTO missing_table VALUES (1);\n\
         INSERT INTO t VALUES (2);\n\
         INSERT INTO t VALUES (3)",
        true,
        200,
    )
    .await;
    assert!(matches!(run, t::ScriptRun::Done { .. }));
    let statuses: Vec<_> = results.iter().map(|r| r.status).collect();
    assert_eq!(
        statuses,
        vec![
            t::BatchStatus::Ok,
            t::BatchStatus::Ok,
            t::BatchStatus::Error,
            t::BatchStatus::Skipped,
            t::BatchStatus::Skipped,
        ]
    );
    assert!(results[2]
        .error
        .as_deref()
        .is_some_and(|e| e.contains("missing_table")));
    // スキップされた文の SQL 本文も返す (結果カードに表示する)。
    assert_eq!(results[4].sql, "INSERT INTO t VALUES (3)");
    assert_eq!(count(&session, "t").await, 1);
}

#[tokio::test]
async fn batch_continues_past_errors_when_not_stopping() {
    let (_fx, session) = setup("batch_continue", false).await;
    let (_run, results) = batch(
        &session,
        "CREATE TABLE t (id INTEGER PRIMARY KEY);\n\
         INSERT INTO missing_table VALUES (1);\n\
         INSERT INTO t VALUES (2)",
        false,
        200,
    )
    .await;
    let statuses: Vec<_> = results.iter().map(|r| r.status).collect();
    assert_eq!(
        statuses,
        vec![
            t::BatchStatus::Ok,
            t::BatchStatus::Error,
            t::BatchStatus::Ok
        ]
    );
    assert_eq!(count(&session, "t").await, 1);
}

#[tokio::test]
async fn batch_enforces_read_only_per_statement() {
    let (_fx, session) = setup("batch_ro", true).await;
    let (_run, results) = batch(
        &session,
        "SELECT 1;\nCREATE TABLE t (id INTEGER);\nSELECT 2",
        false,
        200,
    )
    .await;
    assert_eq!(results[0].status, t::BatchStatus::Ok);
    assert_eq!(results[1].status, t::BatchStatus::Error);
    assert!(results[1]
        .error
        .as_deref()
        .is_some_and(|e| e.to_lowercase().contains("read-only")));
    assert_eq!(results[2].status, t::BatchStatus::Ok);
    // テーブルは作られていない。
    assert!(session.conn.execute("SELECT * FROM t", None).await.is_err());
}

#[tokio::test]
async fn batch_runs_inside_an_active_explicit_transaction() {
    let (_fx, session) = setup("batch_tx", false).await;
    session
        .conn
        .execute("CREATE TABLE t (id INTEGER PRIMARY KEY)", None)
        .await
        .expect("create");
    session
        .conn
        .begin_transaction(None)
        .await
        .expect("begin explicit tx");
    let (run, results) = batch(
        &session,
        "INSERT INTO t VALUES (1);\nINSERT INTO t VALUES (2);\nSELECT id FROM t ORDER BY id",
        true,
        200,
    )
    .await;
    assert!(matches!(run, t::ScriptRun::Done { .. }));
    assert!(results.iter().all(|r| r.status == t::BatchStatus::Ok));
    assert_eq!(results[2].rows.as_ref().map(Vec::len), Some(2));
    // 呼び出し側のトランザクションは開いたまま (ランナーは閉じない)。
    assert!(session.conn.transaction_active().await);
    session
        .conn
        .finish_transaction(false)
        .await
        .expect("rollback");
    assert_eq!(
        count(&session, "t").await,
        0,
        "同じ接続に乗っていたので ROLLBACK で消える"
    );
}

#[tokio::test]
async fn batch_script_transaction_control_is_translated_and_rolled_back_on_error() {
    let (_fx, session) = setup("batch_ctl", false).await;
    session
        .conn
        .execute("CREATE TABLE t (id INTEGER PRIMARY KEY)", None)
        .await
        .expect("create");
    // BEGIN ... COMMIT はランナーの明示トランザクションに読み替えられて確定する。
    let (_run, ok) = batch(
        &session,
        "BEGIN;\nINSERT INTO t VALUES (1);\nCOMMIT;\nSELECT COUNT(*) FROM t",
        true,
        200,
    )
    .await;
    assert!(ok.iter().all(|r| r.status == t::BatchStatus::Ok));
    assert_eq!(count(&session, "t").await, 1);
    assert!(!session.conn.transaction_active().await);

    // BEGIN の後でエラーになったら、ランナーが開いたトランザクションは ROLLBACK される。
    let (_run, failed) = batch(
        &session,
        "BEGIN;\nINSERT INTO t VALUES (2);\nINSERT INTO missing_table VALUES (1);\nINSERT INTO t VALUES (3)",
        true,
        200,
    )
    .await;
    assert_eq!(failed[2].status, t::BatchStatus::Error);
    assert_eq!(failed[3].status, t::BatchStatus::Skipped);
    assert_eq!(count(&session, "t").await, 1);
    assert!(!session.conn.transaction_active().await);
}

fn write_script_bytes(fx: &mut Fixture, name: &str, body: &[u8]) -> String {
    let p = unique(name, "sql");
    std::fs::write(&p, body).expect("write script");
    fx.scripts.push(p.clone());
    p.to_string_lossy().into_owned()
}

/// 失敗した文の通し番号 (`failure.index`) から再開できる (#1535)。それより前の文は
/// 実行されず、`skipped_before_start` に数えられる。
#[tokio::test]
async fn resume_from_the_failed_statement_runs_only_the_rest() {
    let (mut fx, session) = setup("resume", false).await;
    let path = write_script(
        &mut fx,
        "resume",
        "CREATE TABLE t (id INTEGER PRIMARY KEY);\nINSERT INTO t VALUES (1);\nINSERT INTO late VALUES (1);\nINSERT INTO t VALUES (2);",
    );
    let failed_at = match run(&session, &path, opts(false, false)).await {
        t::ScriptRun::Failed { failure, .. } => failure.expect("failure").index,
        other => panic!("expected Failed, got {other:?}"),
    };
    assert_eq!(failed_at, 3);
    assert_eq!(count(&session, "t").await, 1);

    // 原因 (テーブルの不足) を直してから、失敗した文から再開する。
    session
        .conn
        .execute("CREATE TABLE late (id INTEGER)", None)
        .await
        .expect("create late");
    let resume = t::ScriptOptions {
        start_at_statement: failed_at,
        ..opts(false, false)
    };
    match run(&session, &path, resume).await {
        t::ScriptRun::Done {
            executed,
            succeeded,
            skipped_before_start,
            ..
        } => {
            // CREATE TABLE と最初の INSERT は読み飛ばし (再実行すると重複で失敗する)。
            assert_eq!(skipped_before_start, 2);
            assert_eq!(executed, 2);
            assert_eq!(succeeded, 2);
        }
        other => panic!("expected Done, got {other:?}"),
    }
    assert_eq!(count(&session, "t").await, 2);
    assert_eq!(count(&session, "late").await, 1);
}

/// 開始位置の通し番号は BEGIN / COMMIT などのトランザクション制御文も数える
/// (`ScriptFailure.index` や事前確認の一覧と同じ数え方)。
#[tokio::test]
async fn start_position_counts_transaction_control_statements() {
    let (mut fx, session) = setup("resume_tx", false).await;
    let path = write_script(
        &mut fx,
        "resume_tx",
        "CREATE TABLE t (id INTEGER);\nBEGIN;\nINSERT INTO t VALUES (1);\nCOMMIT;\nINSERT INTO t VALUES (2);",
    );
    // 5 番目 (最後の INSERT) から: 先行 4 文 (制御文 2 つを含む) を読み飛ばす。
    let o = t::ScriptOptions {
        start_at_statement: 5,
        ..opts(false, false)
    };
    session
        .conn
        .execute("CREATE TABLE t (id INTEGER)", None)
        .await
        .expect("create");
    match run(&session, &path, o).await {
        t::ScriptRun::Done {
            executed,
            skipped_before_start,
            ..
        } => {
            assert_eq!(skipped_before_start, 4);
            assert_eq!(executed, 1);
        }
        other => panic!("expected Done, got {other:?}"),
    }
    assert_eq!(count(&session, "t").await, 1);
}

/// 事前確認の一覧で除外した文は実行されず、`skipped_excluded` に数えられる (#1535)。
#[tokio::test]
async fn excluded_statements_are_not_executed() {
    let (mut fx, session) = setup("exclude", false).await;
    let path = write_script(
        &mut fx,
        "exclude",
        "CREATE TABLE t (id INTEGER);\nINSERT INTO t VALUES (1);\nDELETE FROM t;\nINSERT INTO t VALUES (2);",
    );
    // 3 番目の DELETE (WHERE なし) を除外する。
    let o = t::ScriptOptions {
        skip_statements: vec![3],
        ..opts(false, false)
    };
    match run(&session, &path, o).await {
        t::ScriptRun::Done {
            executed,
            skipped_excluded,
            failed_count,
            ..
        } => {
            assert_eq!(skipped_excluded, 1);
            assert_eq!(executed, 3);
            assert_eq!(failed_count, 0);
        }
        other => panic!("expected Done, got {other:?}"),
    }
    assert_eq!(count(&session, "t").await, 2);
}

/// Shift_JIS / UTF-16 のスクリプトを自動判定して正しく実行できる (#1535)。
#[tokio::test]
async fn runs_scripts_in_other_encodings_with_auto_detection() {
    for (tag, enc) in [
        ("sjis", t::TextEncoding::ShiftJis),
        ("eucjp", t::TextEncoding::EucJp),
        ("utf16le", t::TextEncoding::Utf16Le),
        ("utf16be", t::TextEncoding::Utf16Be),
        ("utf8bom", t::TextEncoding::Utf8Bom),
    ] {
        let (mut fx, session) = setup(&format!("enc_{tag}"), false).await;
        let text = "CREATE TABLE items (id INTEGER, label TEXT);\nINSERT INTO items VALUES (1, '日本語のテキスト;山田');\n";
        let bytes = t::encode_text(text, enc).expect("encode");
        let path = write_script_bytes(&mut fx, &format!("enc_{tag}"), &bytes);
        match run(&session, &path, opts(false, false)).await {
            t::ScriptRun::Done { executed, .. } => assert_eq!(executed, 2, "{tag}"),
            other => panic!("{tag}: expected Done, got {other:?}"),
        }
        let r = session
            .conn
            .execute("SELECT label FROM items", None)
            .await
            .expect("select");
        match &r.rows[0][0] {
            t::Value::String(s) => assert_eq!(s, "日本語のテキスト;山田", "{tag}"),
            other => panic!("{tag}: unexpected value {other:?}"),
        }
    }
}

/// 文字コードを誤って指定した場合は、1 文も実行する前にエラーになる (化けたまま書かない)。
#[tokio::test]
async fn wrong_explicit_encoding_fails_before_executing_anything() {
    let (mut fx, session) = setup("enc_wrong", false).await;
    let bytes = t::encode_text(
        "CREATE TABLE t (id INTEGER);\nINSERT INTO t VALUES (1); -- 日本語\n",
        t::TextEncoding::ShiftJis,
    )
    .expect("encode");
    let path = write_script_bytes(&mut fx, "enc_wrong", &bytes);
    let o = t::ScriptOptions {
        encoding: Some(t::TextEncoding::Utf8),
        ..opts(false, false)
    };
    let err = t::run_sql_script_via_core(
        session.clone(),
        &path,
        None,
        o,
        Arc::new(AtomicU64::new(0)),
        |_| {},
    )
    .await
    .expect_err("invalid UTF-8 must be rejected up front");
    assert!(matches!(err, t::AppError::InvalidInput(_)));
    // テーブルも作られていない。
    assert!(session
        .conn
        .execute("SELECT COUNT(*) FROM t", None)
        .await
        .is_err());
}

/// トランザクションの途中で失敗したら、`in_transaction` と BEGIN 文の番号を報告する (#1535)。
/// ROLLBACK の成否に関係なく立つので、フロントは取り消された範囲を飛ばして再開させない。
#[tokio::test]
async fn failure_inside_a_script_transaction_reports_the_begin_statement() {
    let (mut fx, session) = setup("tx_fail", false).await;
    let path = write_script(
        &mut fx,
        "tx_fail",
        "CREATE TABLE t (id INTEGER PRIMARY KEY);\nBEGIN;\nINSERT INTO t VALUES (1);\nINSERT INTO nope VALUES (1);\nCOMMIT;",
    );
    match run(&session, &path, opts(false, false)).await {
        t::ScriptRun::Failed {
            failure,
            rolled_back,
            in_transaction,
            tx_begin_statement,
            ..
        } => {
            assert_eq!(failure.expect("failure").index, 4);
            assert!(rolled_back);
            assert!(in_transaction);
            assert_eq!(tx_begin_statement, Some(2));
        }
        other => panic!("expected Failed, got {other:?}"),
    }
    assert_eq!(count(&session, "t").await, 0);

    // BEGIN から再開 (取り消された範囲をやり直す) と、原因を直せば最後まで通る。
    session
        .conn
        .execute("CREATE TABLE nope (id INTEGER)", None)
        .await
        .expect("create nope");
    let resume = t::ScriptOptions {
        start_at_statement: 2,
        ..opts(false, false)
    };
    match run(&session, &path, resume).await {
        t::ScriptRun::Done { failed_count, .. } => assert_eq!(failed_count, 0),
        other => panic!("expected Done, got {other:?}"),
    }
    assert_eq!(count(&session, "t").await, 1);
}

/// トランザクションの外での失敗や、COMMIT 済みのあとの失敗は `in_transaction = false`。
#[tokio::test]
async fn failure_outside_a_transaction_is_not_flagged() {
    let (mut fx, session) = setup("tx_outside", false).await;
    let path = write_script(
        &mut fx,
        "tx_outside",
        "CREATE TABLE t (id INTEGER);\nBEGIN;\nINSERT INTO t VALUES (1);\nCOMMIT;\nINSERT INTO nope VALUES (1);",
    );
    match run(&session, &path, opts(false, false)).await {
        t::ScriptRun::Failed {
            failure,
            in_transaction,
            tx_begin_statement,
            ..
        } => {
            assert_eq!(failure.expect("failure").index, 5);
            assert!(!in_transaction);
            assert_eq!(tx_begin_statement, None);
        }
        other => panic!("expected Failed, got {other:?}"),
    }
    assert_eq!(count(&session, "t").await, 1);
}

/// 全体を包む実行の失敗は `in_transaction = true` だが BEGIN 文の番号は無い。
#[tokio::test]
async fn failure_in_a_wrapped_run_has_no_begin_statement() {
    let (mut fx, session) = setup("tx_wrap", false).await;
    let path = write_script(
        &mut fx,
        "tx_wrap",
        "CREATE TABLE t (id INTEGER);\nINSERT INTO nope VALUES (1);",
    );
    match run(&session, &path, opts(false, true)).await {
        t::ScriptRun::Failed {
            in_transaction,
            tx_begin_statement,
            ..
        } => {
            assert!(in_transaction);
            assert_eq!(tx_begin_statement, None);
        }
        other => panic!("expected Failed, got {other:?}"),
    }
}

/// BEGIN / COMMIT / ROLLBACK は個別除外に指定されても実行される (#1535)。片方だけ外すと
/// 取り消すはずの範囲が確定したり、トランザクションが閉じなかったりするため。
#[tokio::test]
async fn transaction_control_statements_cannot_be_excluded() {
    let (mut fx, session) = setup("tx_skip", false).await;
    let path = write_script(
        &mut fx,
        "tx_skip",
        "CREATE TABLE t (id INTEGER);\nBEGIN;\nINSERT INTO t VALUES (1);\nROLLBACK;\nINSERT INTO t VALUES (2);\nDELETE FROM t WHERE id = 99;",
    );
    // 2 (BEGIN) と 4 (ROLLBACK) を除外に指定しても無視され、6 番目の通常文だけが除外される。
    let o = t::ScriptOptions {
        skip_statements: vec![2, 4, 6],
        ..opts(false, false)
    };
    match run(&session, &path, o).await {
        t::ScriptRun::Done {
            skipped_excluded,
            failed_count,
            ..
        } => {
            assert_eq!(skipped_excluded, 1);
            assert_eq!(failed_count, 0);
        }
        other => panic!("expected Done, got {other:?}"),
    }
    // INSERT (1) は ROLLBACK で取り消され、INSERT (2) だけが残る。
    assert_eq!(count(&session, "t").await, 1);
    assert!(!session.conn.transaction_active().await);
}

fn stamp_of(path: &str) -> t::FileStamp {
    let meta = std::fs::metadata(path).expect("metadata");
    let mtime_ms = meta
        .modified()
        .expect("mtime")
        .duration_since(std::time::UNIX_EPOCH)
        .expect("epoch")
        .as_millis() as u64;
    t::FileStamp {
        size: meta.len(),
        mtime_ms,
    }
}

/// 事前確認のときのファイルと違えば、1 文も実行する前にエラーにする (#1535)。
#[tokio::test]
async fn changed_file_since_the_dry_run_is_rejected_before_running() {
    let (mut fx, session) = setup("stamp", false).await;
    let path = write_script(&mut fx, "stamp", "CREATE TABLE t (id INTEGER);");
    let good = stamp_of(&path);

    // 一致すれば実行できる。
    let ok = t::ScriptOptions {
        expected_file: Some(good),
        ..opts(false, false)
    };
    assert!(matches!(
        run(&session, &path, ok).await,
        t::ScriptRun::Done { .. }
    ));

    // ファイルが書き換わった (大きさが違う) 想定。
    let stale = t::ScriptOptions {
        expected_file: Some(t::FileStamp {
            size: good.size + 1,
            ..good
        }),
        ..opts(false, false)
    };
    let err = t::run_sql_script_via_core(
        session.clone(),
        &path,
        None,
        stale,
        Arc::new(AtomicU64::new(0)),
        |_| {},
    )
    .await
    .expect_err("a changed file must be rejected");
    assert!(err.to_string().contains("[script-file-changed]"));
}

/// 手動指定と BOM が食い違えばエラー、NUL を含む UTF-8 / ASCII の自動判定もエラー (#1535)。
#[tokio::test]
async fn bom_conflict_and_nul_bytes_are_rejected_before_running() {
    let (mut fx, session) = setup("enc_bom", false).await;
    let utf16 =
        t::encode_text("CREATE TABLE t (id INTEGER);", t::TextEncoding::Utf16Le).expect("encode");
    let path = write_script_bytes(&mut fx, "enc_bom", &utf16);
    let conflict = t::ScriptOptions {
        encoding: Some(t::TextEncoding::ShiftJis),
        ..opts(false, false)
    };
    let err = t::run_sql_script_via_core(
        session.clone(),
        &path,
        None,
        conflict,
        Arc::new(AtomicU64::new(0)),
        |_| {},
    )
    .await
    .expect_err("BOM and explicit encoding disagree");
    assert!(matches!(err, t::AppError::InvalidInput(_)));

    let nul_path = write_script_bytes(&mut fx, "enc_nul", b"CREATE TABLE t (id INTEGER);\0\n");
    let err = t::run_sql_script_via_core(
        session.clone(),
        &nul_path,
        None,
        opts(false, false),
        Arc::new(AtomicU64::new(0)),
        |_| {},
    )
    .await
    .expect_err("NUL bytes in a UTF-8 script");
    assert!(err.to_string().contains("NUL"));
    assert!(session
        .conn
        .execute("SELECT COUNT(*) FROM t", None)
        .await
        .is_err());
}

/// 手動で UTF-8 を選んだ UTF-8 BOM 付きファイルは、BOM を取り除いて実行できる。
#[tokio::test]
async fn explicit_utf8_with_a_utf8_bom_file_runs() {
    let (mut fx, session) = setup("enc_bom8", false).await;
    let bytes =
        t::encode_text("CREATE TABLE t (id INTEGER);", t::TextEncoding::Utf8Bom).expect("encode");
    let path = write_script_bytes(&mut fx, "enc_bom8", &bytes);
    let o = t::ScriptOptions {
        encoding: Some(t::TextEncoding::Utf8),
        ..opts(false, false)
    };
    assert!(matches!(
        run(&session, &path, o).await,
        t::ScriptRun::Done { executed: 1, .. }
    ));
}

/// 失敗した文が COMMIT のとき、BEGIN からのやり直しは勧めない (確定したか不明で二重適用に
/// なりうる)。`in_transaction` は true のまま (#1535)。
#[tokio::test]
async fn failed_commit_does_not_offer_restart_from_begin() {
    let (mut fx, session) = setup("tx_commit_fail", false).await;
    let path = write_script(
        &mut fx,
        "tx_commit_fail",
        "CREATE TABLE p (id INTEGER PRIMARY KEY);\nCREATE TABLE c (pid INTEGER REFERENCES p(id) DEFERRABLE INITIALLY DEFERRED);\nBEGIN;\nINSERT INTO c VALUES (99);\nCOMMIT;",
    );
    match run(&session, &path, opts(false, false)).await {
        t::ScriptRun::Failed {
            failure,
            in_transaction,
            tx_begin_statement,
            ..
        } => {
            assert_eq!(failure.expect("failure").index, 5, "the COMMIT fails");
            assert!(in_transaction);
            assert_eq!(tx_begin_statement, None);
        }
        other => panic!("expected Failed, got {other:?}"),
    }
}
