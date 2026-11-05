//! サーバ側でのクエリ停止 (#2023)。
//!
//! クエリのタイムアウトもキャンセルも、クライアント側では Tokio の future を drop して
//! 接続をプールへ戻すだけで、サーバ側の実行は止まらない。ここでは次の 2 つを足す。
//!
//! 1. **サーバ側タイムアウトの自動付与** (バックストップ): `query_timeout_secs` に猶予
//!    ([`SERVER_TIMEOUT_GRACE_SECS`]) を足した値を、実行セッションへ設定する。
//!    PostgreSQL は `statement_timeout`、MySQL は `max_execution_time` (SELECT のみ有効。
//!    MariaDB は変数が無いので無視)、SQLite は progress handler。猶予があるので通常は
//!    クライアント側の `AppError::Timeout` が先に出て、サーバ側はアプリが落ちた・
//!    ネットワークが切れたときに効く。
//! 2. **キャンセル / タイムアウト時の明示停止**: 実行に使う接続のバックエンド ID
//!    (MySQL `CONNECTION_ID()` / PostgreSQL `pg_backend_pid()`) を控えておき、別接続から
//!    既存の `kill_processes(statement_only)` で実行中の文だけを止める。SQLite は
//!    progress handler が停止要求を見て中断する。
//!
//! ドライバの `execute_stream` のシグネチャを変えずに済むよう、文脈は `task_local` で
//! 渡す ([`scope`] の内側で動く future だけが見る)。文脈が無い呼び出し (メタデータ取得など)
//! の挙動は従来どおり。
//!
//! 既知の制約: `statement_timeout` / `max_execution_time` はセッション変数なので、
//! キャンセルで future が drop された接続にはプールへ戻った後も残る。次にこの文脈付きで
//! 実行されるときに上書きされ、設定値はアプリのタイムアウトと同じなので実害は小さい。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::DriverKind;
use crate::state::Session;

/// クライアント側タイムアウトに足す、サーバ側タイムアウトの猶予 (秒)。
pub const SERVER_TIMEOUT_GRACE_SECS: u64 = 2;
/// SQLite でキャンセル要求を有効とみなす時間。要求の時点で動いていた文を止めるための
/// ものなので短い (すでに終わった文のあとに実行される文を巻き込まないため)。
const CANCEL_WINDOW: Duration = Duration::from_secs(3);

/// 1 回のクエリ実行に紐づく「サーバ側停止」の文脈。
#[derive(Debug)]
pub struct ServerStopCtx {
    timeout_secs: Option<u64>,
    started: Instant,
    backend_id: Mutex<Option<i64>>,
    cancelled_at: Mutex<Option<Instant>>,
    ended: AtomicBool,
    fired: AtomicBool,
}

impl ServerStopCtx {
    /// `timeout_secs` が `Some(0)` / `None` のときはサーバ側タイムアウトを付けない。
    pub fn new(timeout_secs: Option<u64>) -> Arc<Self> {
        Arc::new(Self {
            timeout_secs: timeout_secs.filter(|s| *s > 0),
            started: Instant::now(),
            backend_id: Mutex::new(None),
            cancelled_at: Mutex::new(None),
            ended: AtomicBool::new(false),
            fired: AtomicBool::new(false),
        })
    }

    /// サーバ側へ設定するタイムアウト (ミリ秒)。クライアント側より猶予ぶん長い。
    pub fn server_timeout_ms(&self) -> Option<u64> {
        self.timeout_secs.map(|s| {
            s.saturating_add(SERVER_TIMEOUT_GRACE_SECS)
                .saturating_mul(1000)
        })
    }

    /// 実行に使う接続のバックエンド ID を控える。
    pub fn record_backend(&self, id: i64) {
        *self.backend_id.lock().unwrap_or_else(|e| e.into_inner()) = Some(id);
    }

    /// 控えたバックエンド ID を取り出す (二重送信しないよう 1 度きり)。
    pub fn take_backend(&self) -> Option<i64> {
        self.backend_id
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
    }

    /// 停止を要求する (SQLite の progress handler が見る)。
    pub fn request_stop(&self) {
        let mut g = self.cancelled_at.lock().unwrap_or_else(|e| e.into_inner());
        if g.is_none() {
            *g = Some(Instant::now());
        }
    }

    pub fn mark_ended(&self) {
        self.ended.store(true, Ordering::SeqCst);
    }

    /// SQLite の progress handler の判定。`true` なら実行中の文を中断する。
    /// 一度中断したあとは常に `false` (プールに残った handler が後続の文を巻き込まない)。
    pub fn sqlite_should_interrupt(&self, now: Instant) -> bool {
        if self.fired.load(Ordering::SeqCst) {
            return false;
        }
        let cancelled = *self.cancelled_at.lock().unwrap_or_else(|e| e.into_inner());
        let fire = if let Some(at) = cancelled {
            if now.saturating_duration_since(at) <= CANCEL_WINDOW {
                true
            } else {
                // 要求から時間が経った = その文は終わっている。以後は無効。
                self.fired.store(true, Ordering::SeqCst);
                false
            }
        } else if self.ended.load(Ordering::SeqCst) {
            // 文脈は正常に終わった。残っている handler は無効にする。
            self.fired.store(true, Ordering::SeqCst);
            false
        } else {
            match self.server_timeout_ms() {
                Some(ms) => {
                    now.saturating_duration_since(self.started) >= Duration::from_millis(ms)
                }
                None => false,
            }
        };
        if fire {
            self.fired.store(true, Ordering::SeqCst);
        }
        fire
    }
}

tokio::task_local! {
    static CTX: Arc<ServerStopCtx>;
}

/// `fut` を文脈つきで実行する。
pub async fn scope<F: std::future::Future>(ctx: Arc<ServerStopCtx>, fut: F) -> F::Output {
    CTX.scope(ctx, fut).await
}

/// 現在のタスクの文脈 (無ければ `None`)。ドライバの `execute_stream` が見る。
pub fn current() -> Option<Arc<ServerStopCtx>> {
    CTX.try_with(Arc::clone).ok()
}

/// 実行が「止める必要のある終わり方」をしたときにサーバ側の文を止めるガード。
/// 正常終了・DB エラーでは [`StopGuard::disarm`] する。タイムアウトでは [`StopGuard::fire`]、
/// キャンセル (タスクの abort) では drop で自動的に止める。
pub struct StopGuard {
    ctx: Arc<ServerStopCtx>,
    session: Arc<Session>,
    disarmed: bool,
}

impl StopGuard {
    pub fn new(ctx: Arc<ServerStopCtx>, session: Arc<Session>) -> Self {
        Self {
            ctx,
            session,
            disarmed: false,
        }
    }

    pub fn disarm(&mut self) {
        self.disarmed = true;
    }

    /// 今すぐサーバ側の文を止める (冪等)。
    pub fn fire(&self) {
        self.ctx.request_stop();
        if self.session.conn.driver_kind() == DriverKind::Sqlite {
            return;
        }
        if let Some(id) = self.ctx.take_backend() {
            let session = self.session.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = session.conn.kill_processes(&[id], true).await {
                    tracing::warn!(backend_id = id, error = %e, "server-side statement stop failed");
                }
            });
        }
    }
}

impl Drop for StopGuard {
    fn drop(&mut self) {
        if !self.disarmed {
            self.fire();
        }
        self.ctx.mark_ended();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_timeout_adds_grace_and_ignores_zero() {
        assert_eq!(
            ServerStopCtx::new(Some(30)).server_timeout_ms(),
            Some(32_000)
        );
        assert_eq!(ServerStopCtx::new(Some(0)).server_timeout_ms(), None);
        assert_eq!(ServerStopCtx::new(None).server_timeout_ms(), None);
    }

    #[test]
    fn backend_id_is_taken_once() {
        let c = ServerStopCtx::new(None);
        assert_eq!(c.take_backend(), None);
        c.record_backend(42);
        assert_eq!(c.take_backend(), Some(42));
        assert_eq!(c.take_backend(), None);
    }

    #[test]
    fn sqlite_interrupts_on_deadline_then_goes_inert() {
        let c = ServerStopCtx::new(Some(1));
        let t0 = c.started;
        assert!(!c.sqlite_should_interrupt(t0 + Duration::from_secs(2)));
        assert!(c.sqlite_should_interrupt(t0 + Duration::from_secs(3)));
        assert!(!c.sqlite_should_interrupt(t0 + Duration::from_secs(4)));
    }

    #[test]
    fn sqlite_interrupts_on_cancel_within_window_only() {
        let c = ServerStopCtx::new(None);
        c.request_stop();
        assert!(c.sqlite_should_interrupt(Instant::now()));
        let c = ServerStopCtx::new(None);
        c.request_stop();
        assert!(!c.sqlite_should_interrupt(Instant::now() + Duration::from_secs(10)));
        // 窓を過ぎたあとは以後も無効。
        assert!(!c.sqlite_should_interrupt(Instant::now()));
    }

    #[test]
    fn sqlite_handler_is_inert_after_normal_end() {
        let c = ServerStopCtx::new(Some(1));
        c.mark_ended();
        assert!(!c.sqlite_should_interrupt(c.started + Duration::from_secs(60)));
    }

    #[tokio::test]
    async fn scope_exposes_ctx_only_inside() {
        assert!(current().is_none());
        let c = ServerStopCtx::new(Some(5));
        scope(c, async {
            assert_eq!(current().and_then(|c| c.server_timeout_ms()), Some(7_000));
        })
        .await;
        assert!(current().is_none());
    }
}
