//! クエリタイムアウト/キャンセル後の接続プール・セッション回収の検証。
//!
//! ストリーミング実行 (`commands::query::run_query_stream`) は
//! `tokio::time::timeout` で実行をレースし (超過時 `AppError::Timeout`)、
//! `cancel_stream` は `AppState.streams` に登録した `AbortHandle` を abort して
//! 実行 future を drop することでプールへ接続を返す設計 (CLAUDE.md)。本テストは
//! その**回収契約** — タイムアウト/キャンセル後に同一プールで後続クエリが成功し、
//! 接続がリークしてプールが枯渇しないこと — を、実際のプリミティブ
//! (`tokio::time::timeout` の future-drop と `AppState::cancel_stream`) で検証する。
//!
//! ストリーミングコマンド本体は Tauri の `AppHandle` (イベント emit) を要するため
//! 統合テストから直接は駆動できないが、回収を左右するのはここで検証するプール
//! プリミティブであり、SQLite (max 4 接続) で外部サーバ不要・常時実行できる。

use std::sync::Arc;
use std::time::{Duration, Instant};

use noobdb_lib::__test_api as t;

/// タイムアウト/キャンセルの対象にする「十分に遅い」クエリ。再帰 CTE で 1,000 万
/// 行を数える。どんなマシンでも 50ms より確実に長く走り、かつ数秒で完了する
/// (worker スレッドが終われば接続はプールに戻る) 程度に有界。
const SLOW_SQL: &str = "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 10000000) SELECT count(*) FROM c";

/// 即座に返る軽いクエリ。回収後にプールから接続を取得して成功することを確認する。
const QUICK_SQL: &str = "SELECT 1";

/// 一意な一時 SQLite ファイルに接続し、Arc で共有可能な [`Connection`] を返す。
async fn slow_conn(tag: &str) -> (Arc<t::Connection>, std::path::PathBuf) {
    let mut path = std::env::temp_dir();
    path.push(format!("noobdb_timeout_{tag}_{}.db", std::process::id()));
    let _ = std::fs::remove_file(&path);
    std::fs::File::create(&path).expect("create temp sqlite file");
    let conn = t::connect(&t::sqlite_options(path.to_str().unwrap()))
        .await
        .expect("connect");
    (Arc::new(conn), path)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn query_timeout_then_same_pool_succeeds() {
    let (conn, path) = slow_conn("to").await;

    // spawn_query_stream と同じく tokio::time::timeout で実行をレースする。
    let res = tokio::time::timeout(Duration::from_millis(50), conn.execute(SLOW_SQL, None)).await;
    assert!(res.is_err(), "遅いクエリは 50ms で超過するはず (Elapsed)");
    // ↑ ここで timeout future が drop され、実行 future も drop される
    // (spawn_query_stream が AppError::Timeout を返す経路と同じ後始末)。

    // 同一プールで後続の軽いクエリが成功する (接続が回収されている)。
    let quick = conn
        .execute(QUICK_SQL, None)
        .await
        .expect("タイムアウト後も同一プールでクエリが成功するはず");
    assert_eq!(quick.rows.len(), 1);

    let _ = std::fs::remove_file(&path);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cancel_stream_then_same_pool_succeeds() {
    let (conn, path) = slow_conn("cancel").await;
    let state = t::AppState::default();

    // 遅いクエリを別タスクで実行し、その AbortHandle を AppState に登録する
    // (run_query_stream が register_stream するのと同じ形)。
    let c = conn.clone();
    let handle = tokio::spawn(async move {
        let _ = c.execute(SLOW_SQL, None).await;
    });
    let stream_id = "stream-cancel-1".to_string();
    state
        .register_stream(
            stream_id.clone(),
            t::StreamHandle {
                abort: handle.abort_handle(),
                delivered_rows: Arc::new(std::sync::atomic::AtomicU64::new(0)),
                kind: t::StreamKind::Query,
            },
        )
        .await;

    // クエリが走り始めるのを待ってから、実 cancel_stream 経路で abort する。
    tokio::time::sleep(Duration::from_millis(100)).await;
    let cancelled = state.cancel_stream(&stream_id).await;
    assert!(
        cancelled.is_some(),
        "登録済みストリームは cancel_stream で abort されるはず"
    );

    // abort によりタスク (=実行 future) が drop され、接続がプールへ返る。
    // 同一プールで後続クエリが成功する。
    let quick = conn
        .execute(QUICK_SQL, None)
        .await
        .expect("キャンセル後も同一プールでクエリが成功するはず");
    assert_eq!(quick.rows.len(), 1);

    let _ = std::fs::remove_file(&path);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn repeated_timeouts_do_not_exhaust_pool() {
    let (conn, path) = slow_conn("leak").await;

    // プール上限 (SQLite は max 4) を超える回数だけタイムアウトを発生させる。
    // 接続がリーク (drop 後もプールに返らない) すると、5 回目以降で利用可能接続が
    // 尽きて最終クエリが acquire_timeout (15s) まで待たされて失敗する。
    for i in 0..6 {
        let res =
            tokio::time::timeout(Duration::from_millis(50), conn.execute(SLOW_SQL, None)).await;
        assert!(res.is_err(), "iteration {i}: 50ms で超過するはず");
    }

    // SQLite の worker スレッドが残りのカウントを終えて接続をプールへ返すのを待つ。
    // マシンスペックでカウント時間が振れるため固定 sleep ではフレークしうる。期限
    // 付きの短周期リトライで「回収完了 = 後続クエリ成功」を待ち、期限内に回復しなけ
    // れば (= 接続リーク) panic する形にして決定的にする。
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        match tokio::time::timeout(Duration::from_millis(250), conn.execute(QUICK_SQL, None)).await {
            Ok(Ok(quick)) => {
                assert_eq!(quick.rows.len(), 1);
                break;
            }
            _ if Instant::now() < deadline => {
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            _ => panic!("複数回タイムアウト後の接続回収が期限内に完了しませんでした (プール枯渇/リークの疑い)"),
        }
    }

    let _ = std::fs::remove_file(&path);
}
