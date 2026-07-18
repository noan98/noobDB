use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
#[allow(dead_code)]
pub enum AppError {
    #[error("session not found: {0}")]
    SessionNotFound(String),

    #[error("profile not found: {0}")]
    ProfileNotFound(String),

    #[error("invalid input: {0}")]
    InvalidInput(String),

    #[error("read-only session: {0}")]
    ReadOnly(String),

    #[error("query timed out after {0}s")]
    Timeout(u64),

    /// The whole connection attempt exceeded its deadline. Carries the phase it
    /// was stuck in (tunnel connect / auth / DB connect) so the UI can say where
    /// it hung instead of just "timed out" (#684).
    #[error("connection timed out after {secs}s during {phase}")]
    ConnectTimeout { phase: String, secs: u64 },

    #[error("ssh error: {0}")]
    Ssh(String),

    #[error("ssh key error: {0}")]
    SshKey(String),

    /// The SSH server presented a host key that does not match the one stored in
    /// known_hosts (TOFU mismatch). Carries both fingerprints so the UI can show
    /// them side by side and offer an explicit "re-trust and reconnect" recovery
    /// flow after the user confirms the change is legitimate (#682).
    #[error(
        "ssh host key mismatch for {host}:{port}: stored fingerprint {expected}, \
         server presented {actual}. If you did not expect the server's key to change, \
         this could indicate a man-in-the-middle attack."
    )]
    SshHostKeyMismatch {
        host: String,
        port: u16,
        expected: String,
        actual: String,
    },

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("sqlx error: {0}")]
    Sqlx(#[from] sqlx::Error),

    #[error("serde error: {0}")]
    Serde(#[from] serde_json::Error),

    #[error("keyring error: {0}")]
    Keyring(String),

    #[error("config dir not found")]
    ConfigDir,

    #[error("{0}")]
    Other(String),
}

impl AppError {
    /// True when this error means the underlying database connection was lost —
    /// the server closed it (e.g. MySQL `wait_timeout`), the socket broke, or
    /// the network dropped — as opposed to a SQL or usage error. A session that
    /// produces such an error can no longer run queries, so the UI should drop
    /// it and offer a reconnect instead of leaving it stuck on "connected".
    pub fn is_connection_lost(&self) -> bool {
        matches!(self, AppError::Sqlx(e) if sqlx_is_connection_lost(e))
    }

    /// A stable, machine-readable discriminant for this error, serialized
    /// alongside the human `message` (see the `Serialize` impl). The frontend
    /// classifies errors by this `kind` first and only falls back to fuzzy
    /// string matching on `message` when `kind` is unknown (#683) — this frees
    /// error classification from tracking the exact wording of every driver and
    /// dependency crate. These strings are a compatibility surface: the frontend
    /// (`src/errorHints.ts`, `src/api/tauri.ts`) matches on them, so keep them
    /// in sync when adding a variant.
    ///
    /// `Sqlx` is split: a dropped/closed connection reports `connectionLost`
    /// (so the UI can offer reconnect) while any other sqlx failure — a SQL
    /// error, a constraint violation — reports the generic `db` kind, where the
    /// specific hint still comes from the message text.
    pub fn kind(&self) -> &'static str {
        match self {
            AppError::SessionNotFound(_) => "sessionNotFound",
            AppError::ProfileNotFound(_) => "profileNotFound",
            AppError::InvalidInput(_) => "invalidInput",
            AppError::ReadOnly(_) => "readOnly",
            AppError::Timeout(_) => "timeout",
            AppError::ConnectTimeout { .. } => "connectTimeout",
            AppError::Ssh(_) => "ssh",
            AppError::SshKey(_) => "sshKey",
            AppError::SshHostKeyMismatch { .. } => "sshHostKeyMismatch",
            AppError::Io(_) => "io",
            AppError::Sqlx(e) if sqlx_is_connection_lost(e) => "connectionLost",
            AppError::Sqlx(_) => "db",
            AppError::Serde(_) => "serde",
            AppError::Keyring(_) => "keyring",
            AppError::ConfigDir => "configDir",
            AppError::Other(_) => "other",
        }
    }
}

/// Classifies a `sqlx::Error` as a dropped/closed connection. All three drivers
/// in this app go through sqlx, so the transport-level variants (`Io`, `Tls`, a
/// closed pool, a crashed worker) and the server wording for a terminated
/// session ("gone away", "lost connection", ...) are recognised here in one
/// place. Errs toward `false`: a genuine SQL error must never be mistaken for a
/// dropped connection, or we would tear down a perfectly healthy session.
fn sqlx_is_connection_lost(e: &sqlx::Error) -> bool {
    match e {
        sqlx::Error::Io(_)
        | sqlx::Error::Tls(_)
        | sqlx::Error::PoolClosed
        | sqlx::Error::WorkerCrashed => true,
        sqlx::Error::Protocol(msg) => {
            let m = msg.to_ascii_lowercase();
            m.contains("connection") || m.contains("unexpected end") || m.contains("eof")
        }
        sqlx::Error::Database(db) => {
            let m = db.message().to_ascii_lowercase();
            m.contains("gone away")
                || m.contains("lost connection")
                || m.contains("broken pipe")
                || m.contains("connection was killed")
                || m.contains("server closed the connection")
                || m.contains("terminating connection")
        }
        _ => false,
    }
}

impl From<russh::Error> for AppError {
    fn from(e: russh::Error) -> Self {
        AppError::Ssh(e.to_string())
    }
}

impl From<keyring::Error> for AppError {
    fn from(e: keyring::Error) -> Self {
        AppError::Keyring(e.to_string())
    }
}

impl Serialize for AppError {
    /// Serializes to a structured `{ "kind": <stable discriminant>, "message":
    /// <Display string> }` object rather than a bare string (#683). Tauri
    /// forwards this as the rejected-promise value, so the frontend receives an
    /// object it can classify reliably by `kind`. `src/api/tauri.ts` normalizes
    /// it into a `BackendError` and keeps a backward-compatible path for the old
    /// bare-string form, so any error surface that predates this change still
    /// works.
    fn serialize<S: Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut st = s.serialize_struct("AppError", 2)?;
        st.serialize_field("kind", self.kind())?;
        st.serialize_field("message", &self.to_string())?;
        st.end()
    }
}

pub type Result<T> = std::result::Result<T, AppError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn io_errors_are_connection_lost() {
        let e: AppError = sqlx::Error::Io(std::io::Error::new(
            std::io::ErrorKind::BrokenPipe,
            "broken pipe",
        ))
        .into();
        assert!(e.is_connection_lost());
    }

    #[test]
    fn protocol_eof_is_connection_lost() {
        let e: AppError = sqlx::Error::Protocol("unexpected end of stream".into()).into();
        assert!(e.is_connection_lost());
    }

    #[test]
    fn closed_pool_and_crashed_worker_are_connection_lost() {
        assert!(AppError::Sqlx(sqlx::Error::PoolClosed).is_connection_lost());
        assert!(AppError::Sqlx(sqlx::Error::WorkerCrashed).is_connection_lost());
    }

    #[test]
    fn kind_maps_each_variant_to_stable_discriminant() {
        assert_eq!(
            AppError::SessionNotFound("x".into()).kind(),
            "sessionNotFound"
        );
        assert_eq!(
            AppError::ProfileNotFound("x".into()).kind(),
            "profileNotFound"
        );
        assert_eq!(AppError::InvalidInput("x".into()).kind(), "invalidInput");
        assert_eq!(AppError::ReadOnly("x".into()).kind(), "readOnly");
        assert_eq!(AppError::Timeout(30).kind(), "timeout");
        assert_eq!(AppError::Ssh("x".into()).kind(), "ssh");
        assert_eq!(AppError::SshKey("x".into()).kind(), "sshKey");
        assert_eq!(
            AppError::SshHostKeyMismatch {
                host: "h".into(),
                port: 22,
                expected: "SHA256:a".into(),
                actual: "SHA256:b".into(),
            }
            .kind(),
            "sshHostKeyMismatch"
        );
        assert_eq!(AppError::Keyring("x".into()).kind(), "keyring");
        assert_eq!(AppError::ConfigDir.kind(), "configDir");
        assert_eq!(AppError::Other("x".into()).kind(), "other");
    }

    #[test]
    fn kind_distinguishes_connection_lost_from_generic_db() {
        // A dropped connection reports `connectionLost`; a plain SQL error stays `db`.
        assert_eq!(
            AppError::Sqlx(sqlx::Error::Protocol("unexpected end of stream".into())).kind(),
            "connectionLost"
        );
        assert_eq!(AppError::Sqlx(sqlx::Error::RowNotFound).kind(), "db");
    }

    #[test]
    fn serialize_produces_kind_and_message_object() {
        let err = AppError::SshHostKeyMismatch {
            host: "ssh.example.com".into(),
            port: 22,
            expected: "SHA256:old".into(),
            actual: "SHA256:new".into(),
        };
        let json = serde_json::to_value(&err).unwrap();
        assert_eq!(json["kind"], "sshHostKeyMismatch");
        assert_eq!(json["message"], err.to_string());
        // The message keeps the fingerprints and the MITM warning for the UI.
        let msg = json["message"].as_str().unwrap();
        assert!(msg.contains("SHA256:old") && msg.contains("SHA256:new"));
        assert!(msg.contains("man-in-the-middle"));
    }

    #[test]
    fn sql_and_usage_errors_are_not_connection_lost() {
        // A query-level sqlx error (no rows) is a normal failure, not a dropped
        // connection — tearing the session down here would be wrong.
        assert!(!AppError::Sqlx(sqlx::Error::RowNotFound).is_connection_lost());
        assert!(!AppError::Sqlx(sqlx::Error::PoolTimedOut).is_connection_lost());
        assert!(!AppError::InvalidInput("bad".into()).is_connection_lost());
        assert!(!AppError::ReadOnly("ro".into()).is_connection_lost());
        assert!(!AppError::Timeout(30).is_connection_lost());
    }
}
