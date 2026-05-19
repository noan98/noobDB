use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

use crate::db::Connection;
use crate::ssh::SshTunnel;

pub type SessionId = String;

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
}

/// Short base32-ish slug (8 chars) suitable for keyring target names.
pub fn new_session_id() -> SessionId {
    use rand::Rng;
    const ALPHABET: &[u8] = b"abcdefghijkmnpqrstuvwxyz23456789";
    let mut rng = rand::thread_rng();
    (0..8)
        .map(|_| ALPHABET[rng.gen_range(0..ALPHABET.len())] as char)
        .collect()
}
