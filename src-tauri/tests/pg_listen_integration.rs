//! PostgreSQL の LISTEN / NOTIFY 監視 (#2019) の実 DB 統合テスト。
//! `NOOBDB_TEST_POSTGRES_URL` が無ければスキップ。`pg_notify` で送った通知が専用接続の
//! リスナで受信され、イベント (`PgListenMessage`) として配信されること、チャンネルの
//! 追加・削除、識別子として正しくクオートされること (インジェクションにならない)、
//! payload の切り詰め、タスクを止めたあとに通知が流れないことを固定する。

use super::common; // 共有ヘルパは groups/*.rs が 1 度だけ取り込む
use std::sync::atomic::AtomicU64;
use std::sync::Arc;
use std::time::Duration;

use noobdb_lib::__test_api as t;
use tokio::sync::mpsc;

const WAIT: Duration = Duration::from_secs(10);

struct Harness {
    events: mpsc::UnboundedReceiver<t::PgListenMessage>,
    control: mpsc::UnboundedSender<t::PgListenControl>,
    delivered: Arc<AtomicU64>,
    task: tokio::task::JoinHandle<()>,
}

fn spawn_listener(opts: t::DbConnectOptions, channels: Vec<String>) -> Harness {
    let (event_tx, events) = mpsc::unbounded_channel();
    let (control, control_rx) = mpsc::unbounded_channel();
    let delivered = Arc::new(AtomicU64::new(0));
    let task_delivered = delivered.clone();
    let task = tokio::spawn(async move {
        t::run_pg_listener(
            &opts,
            "test-session",
            channels,
            move |m| event_tx.send(m).is_ok(),
            control_rx,
            task_delivered,
        )
        .await;
    });
    Harness {
        events,
        control,
        delivered,
        task,
    }
}

async fn next_event(h: &mut Harness) -> t::PgListenMessage {
    tokio::time::timeout(WAIT, h.events.recv())
        .await
        .expect("timed out waiting for an event")
        .expect("event stream closed")
}

async fn expect_notification(h: &mut Harness) -> (String, String, bool, u32) {
    match next_event(h).await {
        t::PgListenMessage::Notification {
            channel,
            payload,
            payload_truncated,
            pid,
            ..
        } => (channel, payload, payload_truncated, pid),
        other => panic!("expected a notification, got {other:?}"),
    }
}

async fn control_ok(
    h: &Harness,
    make: impl FnOnce(tokio::sync::oneshot::Sender<Result<(), t::AppError>>) -> t::PgListenControl,
) {
    let (tx, rx) = tokio::sync::oneshot::channel();
    h.control.send(make(tx)).expect("listener alive");
    rx.await.expect("reply").expect("control ok");
}

#[tokio::test]
async fn pg_listen_delivers_notifications_and_follows_channel_changes() {
    let Some(url) = common::require_env("NOOBDB_TEST_POSTGRES_URL") else {
        return;
    };
    let opts = t::parse_postgres_url(&url).expect("valid url");
    let sender = t::connect(&opts).await.expect("connect");

    // 大文字・空白・引用符・SQL 断片を含む名前でも、ただのチャンネル名として扱われる。
    let hostile = "Ev\"il chan; DROP TABLE noobdb_never; --";
    let mut h = spawn_listener(
        opts.clone(),
        vec!["noobdb_listen_a".to_string(), hostile.to_string()],
    );
    match next_event(&mut h).await {
        t::PgListenMessage::Started { channels } => {
            assert_eq!(
                channels,
                vec!["noobdb_listen_a".to_string(), hostile.to_string()]
            );
        }
        other => panic!("expected started, got {other:?}"),
    }

    // pg_notify の送信 -> リスナ受信 -> イベント配信。
    sender
        .execute("SELECT pg_notify('noobdb_listen_a', '{\"id\":1}')", None)
        .await
        .expect("notify");
    let (channel, payload, truncated, pid) = expect_notification(&mut h).await;
    assert_eq!(channel, "noobdb_listen_a");
    assert_eq!(payload, "{\"id\":1}");
    assert!(!truncated);
    assert!(pid > 0);

    // 識別子として正しくクオートされている (大文字小文字・引用符が保たれる)。
    sender
        .execute(
            "SELECT pg_notify('Ev\"il chan; DROP TABLE noobdb_never; --', 'p')",
            None,
        )
        .await
        .expect("notify hostile");
    let (channel, payload, _, _) = expect_notification(&mut h).await;
    assert_eq!(channel, hostile);
    assert_eq!(payload, "p");

    // 長い payload は 2000 文字に切り詰めて、切り詰めたことを示す。
    sender
        .execute(
            "SELECT pg_notify('noobdb_listen_a', repeat('x', 5000))",
            None,
        )
        .await
        .expect("notify long");
    let (_, payload, truncated, _) = expect_notification(&mut h).await;
    assert_eq!(payload.chars().count(), 2000);
    assert!(truncated);

    // 稼働中にチャンネルを足すと、そのチャンネルの通知も届く。
    control_ok(&h, |reply| t::PgListenControl::Add {
        channel: "noobdb_listen_b".into(),
        reply,
    })
    .await;
    sender
        .execute("SELECT pg_notify('noobdb_listen_b', 'b1')", None)
        .await
        .expect("notify b");
    let (channel, payload, _, _) = expect_notification(&mut h).await;
    assert_eq!(
        (channel.as_str(), payload.as_str()),
        ("noobdb_listen_b", "b1")
    );

    // 外したチャンネルの通知は届かない。
    control_ok(&h, |reply| t::PgListenControl::Remove {
        channel: "noobdb_listen_a".into(),
        reply,
    })
    .await;
    sender
        .execute("SELECT pg_notify('noobdb_listen_a', 'gone')", None)
        .await
        .expect("notify removed");
    sender
        .execute("SELECT pg_notify('noobdb_listen_b', 'b2')", None)
        .await
        .expect("notify b2");
    let (channel, payload, _, _) = expect_notification(&mut h).await;
    assert_eq!(
        (channel.as_str(), payload.as_str()),
        ("noobdb_listen_b", "b2")
    );

    assert_eq!(h.delivered.load(std::sync::atomic::Ordering::SeqCst), 5);

    // 止めたあとは通知が流れず、イベントの受け口も閉じる (リスナが残らない)。
    h.task.abort();
    let _ = h.task.await;
    sender
        .execute("SELECT pg_notify('noobdb_listen_b', 'after')", None)
        .await
        .expect("notify after abort");
    assert!(
        tokio::time::timeout(Duration::from_millis(500), h.events.recv())
            .await
            .map(|m| m.is_none())
            .unwrap_or(false),
        "no event may arrive after the listener task is stopped"
    );
}

#[tokio::test]
async fn pg_listen_rejects_nothing_silently_when_the_server_is_unreachable() {
    // 接続できないときは黙らず `error` を 1 通送って終わる (環境変数は不要)。
    let mut opts = t::parse_postgres_url("postgres://u:p@127.0.0.1:1/db").expect("valid url");
    opts.password = "secret-should-not-leak".into();
    let mut h = spawn_listener(opts, vec!["x".to_string()]);
    // 接続の確立はプールの取得待ち (最大 5 秒) まで粘るので、通常の待ち時間より長く待つ。
    let first = tokio::time::timeout(Duration::from_secs(40), h.events.recv())
        .await
        .expect("timed out waiting for the error")
        .expect("event stream closed");
    match first {
        t::PgListenMessage::Error { error, .. } => {
            assert!(!error.contains("secret-should-not-leak"));
        }
        other => panic!("expected error, got {other:?}"),
    }
    let _ = h.task.await;
}

/// #2132: チャンネル名は `"..."` で囲んで購読する (大文字小文字を区別する)。引用符なしの
/// `NOTIFY Foo` は `foo` に畳まれるので、`Foo` の購読者には届かず `foo` の購読者に届く。
/// 引用符つきの `NOTIFY "Foo"` / `pg_notify('Foo', ..)` は `Foo` に届く。
#[tokio::test]
async fn pg_listen_channel_names_are_case_sensitive() {
    let Some(url) = common::require_env("NOOBDB_TEST_POSTGRES_URL") else {
        return;
    };
    let opts = t::parse_postgres_url(&url).expect("valid url");
    let sender = t::connect(&opts).await.expect("connect");

    let mut h = spawn_listener(
        opts.clone(),
        vec!["NoobdbFoo".to_string(), "noobdbfoo".to_string()],
    );
    match next_event(&mut h).await {
        t::PgListenMessage::Started { .. } => {}
        other => panic!("expected started, got {other:?}"),
    }

    // 引用符なしの NOTIFY は畳まれた名前 (小文字) の購読者にだけ届く。
    sender
        .execute("NOTIFY NoobdbFoo, 'unquoted'", None)
        .await
        .expect("notify unquoted");
    let (channel, payload, _, _) = expect_notification(&mut h).await;
    assert_eq!(
        (channel.as_str(), payload.as_str()),
        ("noobdbfoo", "unquoted")
    );

    // 引用符つきの NOTIFY と pg_notify は大文字小文字を保つ。
    sender
        .execute("NOTIFY \"NoobdbFoo\", 'quoted'", None)
        .await
        .expect("notify quoted");
    let (channel, payload, _, _) = expect_notification(&mut h).await;
    assert_eq!(
        (channel.as_str(), payload.as_str()),
        ("NoobdbFoo", "quoted")
    );
    sender
        .execute("SELECT pg_notify('NoobdbFoo', 'fn-upper')", None)
        .await
        .expect("pg_notify upper");
    let (channel, payload, _, _) = expect_notification(&mut h).await;
    assert_eq!(
        (channel.as_str(), payload.as_str()),
        ("NoobdbFoo", "fn-upper")
    );
    sender
        .execute("SELECT pg_notify('noobdbfoo', 'fn-lower')", None)
        .await
        .expect("pg_notify lower");
    let (channel, payload, _, _) = expect_notification(&mut h).await;
    assert_eq!(
        (channel.as_str(), payload.as_str()),
        ("noobdbfoo", "fn-lower")
    );
    h.task.abort();
    let _ = h.task.await;

    // 大文字だけを購読していると、引用符なしの NOTIFY は黙って届かない (UI が事前に注意する理由)。
    let mut only_upper = spawn_listener(opts, vec!["NoobdbFoo".to_string()]);
    match next_event(&mut only_upper).await {
        t::PgListenMessage::Started { .. } => {}
        other => panic!("expected started, got {other:?}"),
    }
    sender
        .execute("NOTIFY NoobdbFoo, 'lost'", None)
        .await
        .expect("notify unquoted lost");
    assert!(
        tokio::time::timeout(Duration::from_millis(800), only_upper.events.recv())
            .await
            .is_err(),
        "an unquoted NOTIFY must not reach a case-sensitive listener"
    );
    only_upper.task.abort();
    let _ = only_upper.task.await;
}
