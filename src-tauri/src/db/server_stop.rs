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
//! セッション変数 (`statement_timeout` / `max_execution_time`) は、文の後に元の値へ戻して
//! からプールへ返す。戻せない・future が drop された (タイムアウト / キャンセル) 接続は
//! [`ReleaseGuard`] が `close_on_drop` で閉じ、プールへ戻さない。サーバで走り続ける文や
//! 設定の持ち越しが、プールを共有する別経路 (スクリプト・トランザクション・インポート等)
//! に及ばないようにするため。SQLite の progress handler は pool の `after_release` が外す。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::DriverKind;
use crate::state::Session;

/// クライアント側タイムアウトに足す、サーバ側タイムアウトの猶予 (秒)。
pub const SERVER_TIMEOUT_GRACE_SECS: u64 = 2;

/// 1 回のクエリ実行に紐づく「サーバ側停止」の文脈。
#[derive(Debug)]
pub struct ServerStopCtx {
    timeout_secs: Option<u64>,
    started: Instant,
    backend_id: Mutex<Option<i64>>,
    cancelled_at: Mutex<Option<Instant>>,
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

    /// SQLite の progress handler の判定。`true` なら実行中の文を中断する。
    /// 一度中断したあとは常に `false`。handler 自体はプールの `after_release` が
    /// 接続の返却時に必ず外すので、他経路の文を巻き込まない。
    pub fn sqlite_should_interrupt(&self, now: Instant) -> bool {
        if self.fired.load(Ordering::SeqCst) {
            return false;
        }
        let cancelled = self
            .cancelled_at
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_some();
        let expired = match self.server_timeout_ms() {
            Some(ms) => now.saturating_duration_since(self.started) >= Duration::from_millis(ms),
            None => false,
        };
        let fire = cancelled || expired;
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

/// 文脈つきで借りたプール接続のガード。[`ReleaseGuard::arm`] したあと [`ReleaseGuard::keep`]
/// されずに drop されたら (future の drop = タイムアウト / キャンセル、設定を戻せなかった場合)、
/// 接続をプールへ戻さず閉じる。`arm` しなければ素のプール接続と同じ。
pub struct ReleaseGuard<DB: sqlx::Database> {
    pub conn: sqlx::pool::PoolConnection<DB>,
    close_on_drop: bool,
}

impl<DB: sqlx::Database> ReleaseGuard<DB> {
    pub fn new(conn: sqlx::pool::PoolConnection<DB>) -> Self {
        Self {
            conn,
            close_on_drop: false,
        }
    }

    /// 以後、`keep` されずに drop されたら接続を閉じる。
    pub fn arm(&mut self) {
        self.close_on_drop = true;
    }

    /// 接続を正常にプールへ戻してよい。
    pub fn keep(&mut self) {
        self.close_on_drop = false;
    }
}

impl<DB: sqlx::Database> Drop for ReleaseGuard<DB> {
    fn drop(&mut self) {
        if self.close_on_drop {
            self.conn.close_on_drop();
        }
    }
}

/// サーバ側の停止要求にかける時間の上限。
const KILL_TIMEOUT: Duration = Duration::from_secs(5);

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
                match tokio::time::timeout(KILL_TIMEOUT, session.conn.kill_processes(&[id], true))
                    .await
                {
                    Ok(Ok(_)) => {}
                    Ok(Err(e)) => {
                        tracing::warn!(backend_id = id, error = %e, "server-side statement stop failed");
                    }
                    Err(_) => {
                        tracing::warn!(backend_id = id, "server-side statement stop timed out");
                    }
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
    fn sqlite_interrupts_on_cancel_once() {
        let c = ServerStopCtx::new(None);
        assert!(!c.sqlite_should_interrupt(Instant::now()));
        c.request_stop();
        assert!(c.sqlite_should_interrupt(Instant::now()));
        // 一度中断したあとは無効 (同じ handler が後続の文を巻き込まない)。
        assert!(!c.sqlite_should_interrupt(Instant::now()));
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
