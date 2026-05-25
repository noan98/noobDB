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

    #[error("ssh error: {0}")]
    Ssh(String),

    #[error("ssh key error: {0}")]
    SshKey(String),

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
    fn serialize<S: Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(self.to_string().as_ref())
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
