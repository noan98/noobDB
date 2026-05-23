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
    /// Optional group name used to organize connections in the sidebar.
    #[serde(default)]
    pub group: Option<String>,
    /// Optional accent color (e.g. `#dc2626`) shown on the profile row.
    #[serde(default)]
    pub color: Option<String>,
    /// When true and the corresponding setting is enabled, the UI shows a
    /// confirmation dialog before connecting.
    #[serde(default)]
    pub is_production: bool,
    /// When true, sessions opened from this profile reject any SQL that is
    /// not strictly read-only. Acts as a last-line safety net independent
    /// of DB-side privileges.
    #[serde(default)]
    pub read_only: bool,
    /// Database file path for file-backed drivers (SQLite). `None` for
    /// network-backed drivers (MySQL, PostgreSQL).
    #[serde(default)]
    pub file_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshProfile {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub private_key_path: PathBuf,
}
