pub mod secrets;
pub mod store;

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionProfile {
    /// Short slug (8 chars). Stable across renames.
    pub id: String,
    /// Human-readable name.
    pub name: String,
    pub driver: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub database: Option<String>,
    pub ssh: Option<SshProfile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshProfile {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub private_key_path: PathBuf,
}
