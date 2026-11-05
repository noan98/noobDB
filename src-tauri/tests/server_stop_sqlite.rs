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
async fn quick_select_is_unaffected_and_leftover_handler_goes_inert() {
    let (conn, path) = sqlite_conn("quick").await;
    let ctx = t::ServerStopCtx::new(Some(1));
    let res = t::server_stop_scope(ctx.clone(), async {
        conn.execute_stream("SELECT 1", None, 10, 10, |_| Ok(()))
            .await
    })
    .await;
    assert!(res.is_ok(), "{res:?}");
    // 本番では StopGuard の drop が行う (実行の終了を handler へ伝える)。
    ctx.mark_ended();
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
