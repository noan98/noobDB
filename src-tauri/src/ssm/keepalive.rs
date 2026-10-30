//! SSM 経路向けの疑似キープアライブ (#1976)。
//!
//! Session Manager には「無操作 (Idle session timeout)」があり、既定 20 分 (組織設定で
//! 1〜60 分) 何も流れないとセッションごと切断される。SSH のような keepalive は
//! `aws ssm start-session` に無いが、アイドルタイマーはクライアント側の入力でリセットされ、
//! 複数の TCP 接続は 1 本の WebSocket データチャネルに多重化される。そのため、プールの
//! 1 接続で `SELECT 1` を定期的に流せば SSM セッション全体に通信が発生する。
//!
//! フロントの背景 ping は非表示ウィンドウ・アクティブ接続を対象外にするので、Rust 側の
//! tokio タスクで回す。タスクは `Weak<Session>` だけを持ち、Session の drop (切断・再接続・
//! アプリ終了) で停止用 oneshot の送信側が drop されると即座に終了する。ping していない間は
//! `Weak` だけを持つが、ping 中 (最大 20 秒) は upgrade した `Arc` が Session を保持するので、
//! 切断の完了がその分遅れることがある (既存の `ping_session` と同程度)。
//!
//! 失敗してもここでは再接続せずログだけ残す。切断の検知と自動再接続 (#712) は
//! フロントの既存の仕組み (フォーカス時の ping) に任せる。

use std::future::Future;
use std::sync::{Arc, Weak};
use std::time::Duration;

use tokio::sync::oneshot;

use crate::state::Session;

/// キープアライブ間隔 (4 分)。Idle session timeout の既定 (20 分) より十分短く、
/// 組織が 15 分や 5 分に絞っていても間に合う値にしてある。ただし Idle session timeout が
/// 4 分以下に設定された環境では防げない。
pub const SSM_KEEPALIVE_INTERVAL: Duration = Duration::from_secs(240);

/// 1 回の ping のタイムアウト (フロントの既存 ping と同じ 20 秒)。
const KEEPALIVE_PING_TIMEOUT: Duration = Duration::from_secs(20);

/// `interval` ごとに `ping` を呼ぶループ。最初の ping は `interval` 経過後で、接続直後は送らない。
///
/// - `stop` の送信側が drop される (または送信される) と即座に return する。
/// - `ping` が `None` (セッションがもう無い) を返したら return する。
/// - `ping` の結果が `false` でもログだけ出してループは続ける (連続失敗の 2 回目以降は debug、
///   成功でカウンタをリセット)。`session_id` はログ用。
pub(crate) async fn run_keepalive<F, Fut>(
    session_id: &str,
    interval: Duration,
    mut stop: oneshot::Receiver<()>,
    mut ping: F,
) where
    F: FnMut() -> Option<Fut>,
    Fut: Future<Output = bool>,
{
    let mut ticker = tokio::time::interval_at(tokio::time::Instant::now() + interval, interval);
    // ping が長引いても取り戻すためのバースト送信はしない。
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut failures: u32 = 0;
    loop {
        tokio::select! {
            _ = &mut stop => return,
            _ = ticker.tick() => {}
        }
        let Some(fut) = ping() else { return };
        if fut.await {
            failures = 0;
        } else {
            failures = failures.saturating_add(1);
            if failures == 1 {
                tracing::warn!(session_id, "SSM keepalive ping failed");
            } else {
                tracing::debug!(session_id, failures, "SSM keepalive ping still failing");
            }
        }
    }
}

/// `session` 用のキープアライブタスクを起動する。`stop` は `Session` が持つ送信側とペアの受信側。
/// `tauri::async_runtime::spawn` なので、Tokio ランタイム外 (setup 内など) から呼んでも安全。
pub fn spawn_for_session(session: &Arc<Session>, stop: oneshot::Receiver<()>) {
    let weak: Weak<Session> = Arc::downgrade(session);
    let session_id = session.id.clone();
    tauri::async_runtime::spawn(async move {
        run_keepalive(&session_id, SSM_KEEPALIVE_INTERVAL, stop, move || {
            let session = weak.upgrade()?;
            Some(async move {
                // upgrade した Arc は ping が終わったら即 drop する (タスクが Session を延命しない)。
                let res =
                    tokio::time::timeout(KEEPALIVE_PING_TIMEOUT, session.conn.health_check()).await;
                matches!(res, Ok(Ok(())))
            })
        })
        .await
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    const IV: Duration = Duration::from_secs(10);

    fn counter() -> Arc<AtomicUsize> {
        Arc::new(AtomicUsize::new(0))
    }

    #[tokio::test(start_paused = true)]
    async fn pings_once_per_interval_and_not_before() {
        let (tx, rx) = oneshot::channel();
        let n = counter();
        let n2 = n.clone();
        let h = tokio::spawn(run_keepalive("t", IV, rx, move || {
            n2.fetch_add(1, Ordering::SeqCst);
            Some(async { true })
        }));
        tokio::time::sleep(Duration::from_secs(9)).await;
        assert_eq!(n.load(Ordering::SeqCst), 0);
        tokio::time::sleep(Duration::from_secs(2)).await;
        assert_eq!(n.load(Ordering::SeqCst), 1);
        tokio::time::sleep(IV).await;
        assert_eq!(n.load(Ordering::SeqCst), 2);
        drop(tx);
        h.await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn stops_immediately_when_sender_dropped() {
        let (tx, rx) = oneshot::channel();
        let h = tokio::spawn(run_keepalive("t", IV, rx, || Some(async { true })));
        tokio::time::sleep(Duration::from_secs(1)).await;
        let before = tokio::time::Instant::now();
        drop(tx);
        h.await.unwrap();
        // 停止は即時 (仮想時間が進まない = interval を待っていない)。
        assert_eq!(tokio::time::Instant::now(), before);
    }

    #[test]
    fn channel_is_none_without_ssm_tunnel() {
        let (tx, rx) = crate::commands::connection::ssm_keepalive_channel(None);
        assert!(tx.is_none() && rx.is_none());
    }

    #[tokio::test(start_paused = true)]
    async fn stops_when_session_is_gone() {
        let (_tx, rx) = oneshot::channel();
        let h = tokio::spawn(run_keepalive("t", IV, rx, || {
            None::<std::future::Ready<bool>>
        }));
        h.await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn continues_after_failed_ping() {
        let (tx, rx) = oneshot::channel();
        let n = counter();
        let n2 = n.clone();
        let h = tokio::spawn(run_keepalive("t", IV, rx, move || {
            n2.fetch_add(1, Ordering::SeqCst);
            Some(async { false })
        }));
        tokio::time::sleep(Duration::from_secs(35)).await;
        assert_eq!(n.load(Ordering::SeqCst), 3);
        assert!(!h.is_finished());
        drop(tx);
        h.await.unwrap();
    }
}
