use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use tokio::task::AbortHandle;

use crate::db::{Connection, DbConnectOptions};
use crate::ssh::SshTunnel;

pub type SessionId = String;
pub type StreamId = String;

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
    pub streams: RwLock<HashMap<StreamId, AbortHandle>>,
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

    pub async fn register_stream(&self, stream_id: StreamId, handle: AbortHandle) {
        let mut map = self.streams.write().await;
        tracing::debug!(stream_id = %stream_id, "stream registered");
        if let Some(prev) = map.insert(stream_id, handle) {
            // Cancel any previous task that reused this id — caller side
            // should not normally collide, but never let two run concurrently.
            tracing::warn!("stream id reused; aborting previous task");
            prev.abort();
        }
    }

    pub async fn forget_stream(&self, stream_id: &str) {
        self.streams.write().await.remove(stream_id);
    }

    pub async fn cancel_stream(&self, stream_id: &str) -> bool {
        if let Some(h) = self.streams.write().await.remove(stream_id) {
            h.abort();
            tracing::debug!(stream_id = %stream_id, "stream cancelled");
            true
        } else {
            tracing::debug!(stream_id = %stream_id, "cancel: no such stream");
            false
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
