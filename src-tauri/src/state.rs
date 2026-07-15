use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::RwLock;
use tokio::task::AbortHandle;

use crate::db::{Connection, DbConnectOptions};
use crate::ssh::SshTunnel;

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
    /// When true, statements run on this session are NOT written to the
    /// query history. Set at connect time from the profile flag.
    pub skip_history: bool,
    /// Held to keep the tunnel alive for the lifetime of this session.
    /// Dropping the Session drops this and cleans the tunnel up.
    pub _tunnel: Option<SshTunnel>,
}

#[derive(Default)]
pub struct AppState {
    pub sessions: RwLock<HashMap<SessionId, Arc<Session>>>,
    /// Active streaming tasks keyed by client-provided stream id.
    /// Aborting the handle cancels the task and stops further events.
    pub streams: RwLock<HashMap<StreamId, StreamHandle>>,
    /// In-flight connection attempts keyed by a client-provided attempt id.
    /// Aborting the handle cancels a connect that is hanging on an unreachable
    /// host / stuck tunnel, so the UI can offer a cancel button (#684).
    pub connects: RwLock<HashMap<String, AbortHandle>>,
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

    pub async fn register_stream(&self, stream_id: StreamId, handle: StreamHandle) {
        let mut map = self.streams.write().await;
        tracing::debug!(stream_id = %stream_id, "stream registered");
        if let Some(prev) = map.insert(stream_id, handle) {
            // Cancel any previous task that reused this id — caller side
            // should not normally collide, but never let two run concurrently.
            tracing::warn!("stream id reused; aborting previous task");
            prev.abort.abort();
        }
    }

    pub async fn forget_stream(&self, stream_id: &str) {
        self.streams.write().await.remove(stream_id);
    }

    /// Track an in-flight connection attempt so `cancel_connect` can abort it.
    pub async fn register_connect(&self, attempt_id: String, handle: AbortHandle) {
        if let Some(prev) = self.connects.write().await.insert(attempt_id, handle) {
            // A reused attempt id shouldn't happen (the frontend mints a fresh
            // one per attempt), but never let two run under the same key.
            tracing::warn!("connect attempt id reused; aborting previous attempt");
            prev.abort();
        }
    }

    pub async fn forget_connect(&self, attempt_id: &str) {
        self.connects.write().await.remove(attempt_id);
    }

    /// Abort the connection attempt registered for `attempt_id`. Returns `true`
    /// when one was found and aborted, `false` when it had already finished.
    pub async fn cancel_connect(&self, attempt_id: &str) -> bool {
        if let Some(h) = self.connects.write().await.remove(attempt_id) {
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
        if let Some(h) = self.streams.write().await.remove(stream_id) {
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
