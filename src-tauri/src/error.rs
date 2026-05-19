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
