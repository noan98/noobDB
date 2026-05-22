use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use tokio::task::AbortHandle;

use crate::db::Connection;
use crate::ssh::SshTunnel;

pub type SessionId = String;
pub type StreamId = String;

pub struct Session {
    pub id: SessionId,
    pub profile_id: Option<String>,
    pub conn: Connection,
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
        id
    }

    pub async fn get(&self, id: &str) -> Option<Arc<Session>> {
        self.sessions.read().await.get(id).cloned()
    }

    pub async fn remove(&self, id: &str) -> Option<Arc<Session>> {
        self.sessions.write().await.remove(id)
    }

    pub async fn register_stream(&self, stream_id: StreamId, handle: AbortHandle) {
        let mut map = self.streams.write().await;
        if let Some(prev) = map.insert(stream_id, handle) {
            // Cancel any previous task that reused this id — caller side
            // should not normally collide, but never let two run concurrently.
            prev.abort();
        }
    }

    pub async fn forget_stream(&self, stream_id: &str) {
        self.streams.write().await.remove(stream_id);
    }

    pub async fn cancel_stream(&self, stream_id: &str) -> bool {
        if let Some(h) = self.streams.write().await.remove(stream_id) {
            h.abort();
            true
        } else {
            false
        }
    }
}

/// Short base32-ish slug (8 chars) suitable for keyring target names.
pub fn new_session_id() -> SessionId {
    use rand::RngExt;
    const ALPHABET: &[u8] = b"abcdefghijkmnpqrstuvwxyz23456789";
    let mut rng = rand::rng();
    (0..8)
        .map(|_| ALPHABET[rng.random_range(0..ALPHABET.len())] as char)
        .collect()
}
