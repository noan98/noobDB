//! サーバ側停止 (#2023) の SQLite 経路を実ドライバで検証する。外部サーバ不要。
//!
//! SQLite には statement_timeout / KILL QUERY が無いので、progress handler が期限・
//! 停止要求を見て実行中の文を中断する。MySQL / PostgreSQL の経路は環境変数ゲートの
//! 統合テストが必要なため、ここでは扱わない。

use std::time::{Duration, Instant};

use noobdb_lib::__test_api as t;

async fn sqlite_conn(tag: &str) -> (t::Connection, std::path::PathBuf) {
    let mut path = std::env::temp_dir();
    path.push(format!(
        "noobdb_server_stop_{tag}_{}.db",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&path);
    std::fs::File::create(&path).expect("create temp sqlite file");
    let conn = t::connect(&t::sqlite_options(path.to_str().expect("utf8 path")))
        .await
        .expect("connect");
    (conn, path)
}

/// 1 行も返さずに延々と計算する重い SELECT。
const HEAVY: &str =
    "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 2000000000) \
                     SELECT count(*) FROM c";

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn server_side_deadline_interrupts_a_long_select() {
    let (conn, path) = sqlite_conn("deadline").await;
    let ctx = t::ServerStopCtx::new(Some(1)); // 1 秒 + 猶予 2 秒
    let started = Instant::now();
    let res = t::server_stop_scope(ctx, async {
        conn.execute_stream(HEAVY, None, 10, 10, |_| Ok(())).await
    })
    .await;
    assert!(res.is_err(), "重い SELECT は中断されるはず");
    assert!(
        started.elapsed() < Duration::from_secs(20),
        "期限 (約 3 秒) のあと速やかに止まる: {:?}",
        started.elapsed()
    );
    // 中断後も同じプールで普通に使える。
    let ok = conn.execute("SELECT 1", None).await;
    assert!(ok.is_ok(), "{ok:?}");
    let _ = std::fs::remove_file(path);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stop_request_interrupts_without_a_timeout() {
    let (conn, path) = sqlite_conn("cancel").await;
    let ctx = t::ServerStopCtx::new(None);
    let stopper = ctx.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(300)).await;
        stopper.request_stop();
    });
    let started = Instant::now();
    let res = t::server_stop_scope(ctx, async {
        conn.execute_stream(HEAVY, None, 10, 10, |_| Ok(())).await
    })
    .await;
    assert!(res.is_err());
    assert!(started.elapsed() < Duration::from_secs(10));
    let _ = std::fs::remove_file(path);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn quick_select_is_unaffected_and_handler_is_removed_on_release() {
    let (conn, path) = sqlite_conn("quick").await;
    let ctx = t::ServerStopCtx::new(Some(1));
    let res = t::server_stop_scope(ctx, async {
        conn.execute_stream("SELECT 1", None, 10, 10, |_| Ok(()))
            .await
    })
    .await;
    assert!(res.is_ok(), "{res:?}");
    // 文脈を使わない後続の文は、プールに残った handler に巻き込まれない。
    tokio::time::sleep(Duration::from_millis(3200)).await;
    let later = conn
        .execute_stream(
            "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 3000000) SELECT count(*) FROM c",
            None,
            10,
            10,
            |_| Ok(()),
        )
        .await;
    assert!(later.is_ok(), "{later:?}");
    let _ = std::fs::remove_file(path);
}

/// キャンセル (future の drop + 停止要求) の直後、プールの全接続で別の文を実行しても
/// 残った progress handler に中断されない (`after_release` が外す)。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn handler_does_not_outlive_a_cancelled_statement() {
    let (conn, path) = sqlite_conn("after_cancel").await;
    let ctx = t::ServerStopCtx::new(None);
    let stopper = ctx.clone();
    let res = tokio::time::timeout(
        Duration::from_millis(300),
        t::server_stop_scope(ctx, async {
            conn.execute_stream(HEAVY, None, 10, 10, |_| Ok(())).await
        }),
    )
    .await;
    assert!(res.is_err(), "300ms では終わらない");
    stopper.request_stop();
    // プールの上限 (4) を超えて繰り返し、どの接続でも中断されないことを確かめる。
    for i in 0..8 {
        let r = conn
            .execute_stream(
                "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 2000000) SELECT count(*) FROM c",
                None,
                10,
                10,
                |_| Ok(()),
            )
            .await;
        assert!(r.is_ok(), "{i} 回目: {r:?}");
    }
    let _ = std::fs::remove_file(path);
}

/// ドライラン用の `explicit_only` ガードは drop (キャンセル) では停止を要求せず、
/// 通常のガードは drop で要求する。`fire()` の明示呼び出しは両方で効く。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn explicit_only_guard_does_not_stop_on_drop() {
    let (conn, path) = sqlite_conn("explicit_only").await;
    let opts = t::sqlite_options(path.to_str().expect("utf8 path"));
    let session = std::sync::Arc::new(t::make_session("s", conn, opts, false));

    let ctx = t::ServerStopCtx::new(None);
    drop(t::StopGuard::explicit_only(ctx.clone(), session.clone()));
    assert!(!ctx.sqlite_should_interrupt(Instant::now()));

    let ctx = t::ServerStopCtx::new(None);
    drop(t::StopGuard::new(ctx.clone(), session.clone()));
    assert!(ctx.sqlite_should_interrupt(Instant::now()));

    let ctx = t::ServerStopCtx::new(None);
    t::StopGuard::explicit_only(ctx.clone(), session.clone()).fire();
    assert!(ctx.sqlite_should_interrupt(Instant::now()));
    let _ = std::fs::remove_file(path);
}
