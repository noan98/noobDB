use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::RwLock;
use tokio::task::AbortHandle;

use crate::db::{Connection, DbConnectOptions};
use crate::ssh::{SshConfig, SshTunnel};

pub type SessionId = String;
pub type StreamId = String;

/// Which streaming command registered a given [`StreamHandle`]. `cancel_stream`
/// is a single generic IPC entry point shared by `run_query_stream` /
/// `preview_query_stream` / `export_query_stream` / `import_csv`, so it needs
/// this tag to know which `<kind>-stream:cancelled` event (if any) to emit
/// (#685).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StreamKind {
    Query,
    Preview,
    Export,
    Import,
    /// A database dump (mysqldump / pg_dump / SQLite). The `delivered_rows`
    /// counter carries bytes written so far, so a cancel can report progress
    /// and the partial file is cleaned up (#686).
    Dump,
}

/// A running streaming task tracked by [`AppState`]. Besides the `AbortHandle`
/// needed to cancel it, this carries a shared row counter so a cancellation
/// (or timeout) can report how many rows had already been delivered to the
/// frontend before the stream stopped (#685) — without this, a partial
/// result is indistinguishable from a complete one. The task increments
/// `delivered_rows` as it emits batches; `cancel_stream` reads the current
/// value at abort time.
pub struct StreamHandle {
    pub abort: AbortHandle,
    pub delivered_rows: Arc<AtomicU64>,
    pub kind: StreamKind,
}

pub struct Session {
    pub id: SessionId,
    pub profile_id: Option<String>,
    pub conn: Connection,
    /// The resolved options used to open `conn`. Kept so commands that must
    /// shell out to an external client (e.g. `mysqldump`) can reconstruct the
    /// endpoint and credentials. For tunneled sessions `host`/`port` already
    /// point to the local end of the tunnel, so external tools reach the DB
    /// through the same tunnel.
    pub connect_options: DbConnectOptions,
    /// When true, the query commands reject any non-read-only SQL before
    /// it reaches the driver. Set at connect time from the profile flag.
    pub read_only: bool,
    /// Emergency-write override for a read-only session (#emergency-mode).
    /// While set, `ensure_allowed_for_session` lets non-read-only SQL through
    /// on this session so an operator can run an urgent fix without
    /// reconnecting under a different profile. Toggled at runtime via the
    /// `set_emergency_mode` IPC (the UI gates enabling behind a
    /// type-the-connection-name confirmation) and intentionally *not*
    /// persisted: a fresh `Session` — including the in-place swap done by
    /// `reconnect` — always starts with the override off. Only the SQL query
    /// paths honor it; CSV import, sync apply and `kill_process` keep
    /// rejecting read-only sessions regardless.
    pub emergency_write: AtomicBool,
    /// When true, statements run on this session are NOT written to the
    /// query history. Set at connect time from the profile flag.
    pub skip_history: bool,
    /// Non-secret SSH parameters needed to rebuild the tunnel on reconnect
    /// (#712). `None` for direct (non-tunneled) and file-backed sessions. The
    /// passphrase / password are intentionally *not* kept here — they are
    /// re-resolved from the keyring at reconnect time so we don't add new
    /// plaintext retention beyond the DB password already held in
    /// `connect_options`.
    pub reconnect_ssh: Option<SshConfig>,
    /// Held to keep the tunnel alive for the lifetime of this session.
    /// Dropping the Session drops this and cleans the tunnel up.
    pub _tunnel: Option<SshTunnel>,
    /// Set only for a **local cross-connection query** session (#740): the
    /// path of its temp-file-backed SQLite database. Its presence is how
    /// commands recognize "this session is the local engine, not a driven
    /// connection" (`commands::local` checks it before allowing table
    /// registration), and `disconnect` uses it to delete the backing file —
    /// local sessions are volatile by default, so nothing survives past
    /// disconnect unless the user explicitly exported a copy first
    /// (`vacuum_into` / "ファイルに保存", which writes an independent file and
    /// does not change this session's own volatility).
    pub local_temp_file: Option<std::path::PathBuf>,
}

impl Session {
    /// True when the emergency-write override is currently on. Relaxed-enough
    /// ordering is fine — the flag is an independent boolean with no other
    /// memory it must synchronize with — but SeqCst keeps it trivially correct.
    pub fn emergency_write_active(&self) -> bool {
        self.emergency_write.load(Ordering::SeqCst)
    }

    pub fn set_emergency_write(&self, enabled: bool) {
        self.emergency_write.store(enabled, Ordering::SeqCst);
    }
}

#[derive(Default)]
pub struct AppState {
    pub sessions: RwLock<HashMap<SessionId, Arc<Session>>>,
    /// Active streaming tasks keyed by client-provided stream id. Aborting the
    /// handle cancels the task and stops further events. The value carries a
    /// per-registration token so a finishing task only clears its *own* entry
    /// (see `register_stream` / `forget_stream`) — mirrors `connects` below,
    /// which solved the identical "client-supplied id can be reused" problem
    /// first.
    pub streams: RwLock<HashMap<StreamId, (u64, StreamHandle)>>,
    /// Monotonic source of the per-registration tokens above.
    stream_seq: AtomicU64,
    /// In-flight connection attempts keyed by a client-provided attempt id.
    /// Aborting the handle cancels a connect that is hanging on an unreachable
    /// host / stuck tunnel, so the UI can offer a cancel button (#684). The
    /// value carries a per-registration token so a finishing task only clears
    /// its *own* entry (see `register_connect` / `forget_connect`).
    pub connects: RwLock<HashMap<String, (u64, AbortHandle)>>,
    /// Monotonic source of the per-registration tokens above.
    connect_seq: AtomicU64,
}

impl AppState {
    pub async fn insert(&self, session: Session) -> SessionId {
        let id = session.id.clone();
        self.sessions
            .write()
            .await
            .insert(id.clone(), Arc::new(session));
        tracing::debug!(session_id = %id, "session created");
        id
    }

    /// Swap the session registered under `session.id` for `session`, returning
    /// the previous entry (if any) so the caller can close its connection after
    /// the replacement is in place. Used by `reconnect` to substitute a freshly
    /// re-established connection while keeping the same `SessionId`, so the
    /// frontend's tabs and grid state (keyed by session id) survive untouched
    /// (#712).
    pub async fn replace(&self, session: Session) -> Option<Arc<Session>> {
        let id = session.id.clone();
        let prev = self
            .sessions
            .write()
            .await
            .insert(id.clone(), Arc::new(session));
        tracing::info!(session_id = %id, "session replaced (reconnect)");
        prev
    }

    pub async fn get(&self, id: &str) -> Option<Arc<Session>> {
        let session = self.sessions.read().await.get(id).cloned();
        if session.is_none() {
            tracing::debug!(session_id = %id, "session lookup missed (not found)");
        }
        session
    }

    pub async fn remove(&self, id: &str) -> Option<Arc<Session>> {
        let removed = self.sessions.write().await.remove(id);
        if removed.is_some() {
            tracing::debug!(session_id = %id, "session destroyed");
        }
        removed
    }

    /// Track a running streaming task so `cancel_stream` can abort it. Returns
    /// a per-registration token that must be passed back to `forget_stream`,
    /// so a task that reused a client-provided `stream_id` never clears the
    /// newer registration that superseded it (mirrors `register_connect`).
    ///
    /// `stream_id` is chosen by the frontend, not generated here, so unlike
    /// `SessionId` it *can* legitimately repeat (e.g. a tab reusing a stable
    /// id across runs). Without the token, a slow task's cleanup at the end of
    /// its run could `remove` an entry that a newer task — started under the
    /// same id after the old one finished but before its cleanup ran —
    /// already registered, leaving the newer task's `AbortHandle` unreachable
    /// (`cancel_stream` would then report `{cancelled:false}` forever even
    /// though the stream is still running, holding a DB connection / SSH
    /// tunnel open with no way to cancel it).
    pub async fn register_stream(&self, stream_id: StreamId, handle: StreamHandle) -> u64 {
        let token = self.stream_seq.fetch_add(1, Ordering::Relaxed);
        let mut map = self.streams.write().await;
        tracing::debug!(stream_id = %stream_id, token, "stream registered");
        if let Some((_, prev)) = map.insert(stream_id, (token, handle)) {
            // Cancel any previous task that reused this id — caller side
            // should not normally collide, but never let two run concurrently.
            tracing::warn!("stream id reused; aborting previous task");
            prev.abort.abort();
        }
        token
    }

    /// Remove the registration for `stream_id` only when it still carries
    /// `token`. If a newer stream reused the same id, its (larger) token won't
    /// match and its entry is preserved so `cancel_stream` can still reach it.
    pub async fn forget_stream(&self, stream_id: &str, token: u64) {
        let mut map = self.streams.write().await;
        if map.get(stream_id).is_some_and(|(cur, _)| *cur == token) {
            map.remove(stream_id);
        }
    }

    /// Track an in-flight connection attempt so `cancel_connect` can abort it.
    /// Returns a per-registration token that must be passed back to
    /// `forget_connect`, so a task that reused an `attempt_id` never clears the
    /// newer registration that superseded it.
    pub async fn register_connect(&self, attempt_id: String, handle: AbortHandle) -> u64 {
        let token = self.connect_seq.fetch_add(1, Ordering::Relaxed);
        if let Some((_, prev)) = self
            .connects
            .write()
            .await
            .insert(attempt_id, (token, handle))
        {
            // A reused attempt id shouldn't happen (the frontend mints a fresh
            // one per attempt), but never let two run under the same key.
            tracing::warn!("connect attempt id reused; aborting previous attempt");
            prev.abort();
        }
        token
    }

    /// Remove the registration for `attempt_id` only when it still carries
    /// `token`. If a newer attempt reused the same id, its (larger) token won't
    /// match and its abort handle is preserved so `cancel_connect` can still
    /// reach it.
    pub async fn forget_connect(&self, attempt_id: &str, token: u64) {
        let mut map = self.connects.write().await;
        if map.get(attempt_id).is_some_and(|(cur, _)| *cur == token) {
            map.remove(attempt_id);
        }
    }

    /// Abort the connection attempt registered for `attempt_id`. Returns `true`
    /// when one was found and aborted, `false` when it had already finished.
    pub async fn cancel_connect(&self, attempt_id: &str) -> bool {
        if let Some((_, h)) = self.connects.write().await.remove(attempt_id) {
            h.abort();
            tracing::debug!(attempt_id = %attempt_id, "connect attempt cancelled");
            true
        } else {
            false
        }
    }

    /// Aborts the task registered for `stream_id` and returns the number of
    /// rows it had delivered so far together with which command registered it,
    /// or `None` when no such stream is running (already finished, or never
    /// existed). The caller (the `cancel_stream` IPC command) uses the kind to
    /// emit the matching `<kind>-stream:cancelled` event.
    pub async fn cancel_stream(&self, stream_id: &str) -> Option<(u64, StreamKind)> {
        if let Some((_, h)) = self.streams.write().await.remove(stream_id) {
            h.abort.abort();
            let delivered_rows = h.delivered_rows.load(Ordering::SeqCst);
            tracing::debug!(stream_id = %stream_id, delivered_rows, "stream cancelled");
            Some((delivered_rows, h.kind))
        } else {
            tracing::debug!(stream_id = %stream_id, "cancel: no such stream");
            None
        }
    }
}

/// Base32-ish alphabet without easily-confused characters (`0`/`o`/`l`/`1`).
/// Safe as a keyring target prefix and in temp file names across platforms.
const SLUG_ALPHABET: &[u8] = b"abcdefghijkmnpqrstuvwxyz23456789";

/// Random slug of `len` characters drawn from [`SLUG_ALPHABET`].
pub fn random_slug(len: usize) -> String {
    use rand::RngExt;
    let mut rng = rand::rng();
    (0..len)
        .map(|_| SLUG_ALPHABET[rng.random_range(0..SLUG_ALPHABET.len())] as char)
        .collect()
}

/// Short base32-ish slug (8 chars) suitable for keyring target names.
pub fn new_session_id() -> SessionId {
    random_slug(8)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A `StreamHandle` needs a real `AbortHandle` to construct, so spawn a
    /// no-op task purely to obtain one. The task is never awaited by the test.
    fn dummy_handle(kind: StreamKind) -> StreamHandle {
        let jh = tokio::spawn(async {});
        StreamHandle {
            abort: jh.abort_handle(),
            delivered_rows: Arc::new(AtomicU64::new(0)),
            kind,
        }
    }

    /// I4 の再発防止テスト: 旧タスクの `forget_stream` が、同じ `stream_id` で
    /// 登録された新タスクのエントリを消してはいけない。トークンを介さない実装
    /// (旧: `forget_stream(id)` が無条件 `remove`) だと、旧タスクの後始末が新
    /// タスクの `AbortHandle` を消してしまい、以後の `cancel_stream` が
    /// `{cancelled:false}` を返し続ける (DB 接続 / SSH トンネルを握ったままの
    /// キャンセル不能なストリームが残る) — `register_connect`/`forget_connect`
    /// が既に対処済みだったのと同じ競合を `streams` 側にも再現して固定する。
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn forget_stream_never_clears_a_newer_registration_under_the_same_id() {
        let state = AppState::default();
        let stream_id = "reused-stream-id".to_string();

        // 旧タスクの登録。トークンは呼び出し側が握っておく (実際のコマンドでは
        // spawn したタスク自身がこれを最終的に forget_stream へ渡す)。
        let old_token = state
            .register_stream(stream_id.clone(), dummy_handle(StreamKind::Query))
            .await;

        // 同じ stream_id で新しいタスクが登録される (クライアントがこの id を
        // 再利用した想定)。register_stream は「同じ id の既存エントリ」を検知して
        // 旧タスクの AbortHandle を abort するが、ここで再現したいのは「旧タスクの
        // 後始末 (forget_stream) が、abort 済みであるにも関わらず別途少し遅れて
        // 呼ばれる」競合なので、まず新規登録が正しく上書きされ、別トークンを
        // 持つことだけ確認する。
        let new_token = state
            .register_stream(stream_id.clone(), dummy_handle(StreamKind::Query))
            .await;
        assert_ne!(
            old_token, new_token,
            "tokens must be unique per registration"
        );

        // 旧タスクが (自分がまだ生きていると誤解して) 遅れて forget_stream を
        // 呼んでも、トークンが一致しないので新タスクの登録は残ること。
        state.forget_stream(&stream_id, old_token).await;
        assert!(
            state.streams.read().await.contains_key(&stream_id),
            "an old task's forget_stream must not remove a newer registration"
        );

        // 新タスクが自分のトークンで forget すれば、今度こそ消えること。
        state.forget_stream(&stream_id, new_token).await;
        assert!(
            !state.streams.read().await.contains_key(&stream_id),
            "the current registration's own token must still remove its entry"
        );
    }
}
