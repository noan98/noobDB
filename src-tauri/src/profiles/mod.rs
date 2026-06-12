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
    /// When true (and `is_production` is set), the UI requires explicit
    /// approval before running any statement that is not strictly read-only.
    /// `read_only` takes precedence: a read-only session rejects writes
    /// outright, so there is nothing left to approve.
    #[serde(default)]
    pub confirm_writes: bool,
    /// When true, sessions opened from this profile reject any SQL that is
    /// not strictly read-only. Acts as a last-line safety net independent
    /// of DB-side privileges.
    #[serde(default)]
    pub read_only: bool,
    /// When true, statements run on sessions opened from this profile are not
    /// recorded in the query history. Useful for connections whose SQL may
    /// embed passwords or other sensitive literals.
    #[serde(default)]
    pub skip_history: bool,
    /// Database file path for file-backed drivers (SQLite). `None` for
    /// network-backed drivers (MySQL, PostgreSQL).
    #[serde(default)]
    pub file_path: Option<String>,
}

/// How an SSH tunnel authenticates with the jump host.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum SshAuthMethod {
    /// Private key file plus optional passphrase.
    #[default]
    Key,
    /// Delegate signing to the running ssh-agent.
    Agent,
    /// Plain password authentication.
    Password,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshProfile {
    pub host: String,
    pub port: u16,
    pub user: String,
    /// Defaults to `Key` so profiles written before this field existed keep
    /// their original private-key behavior.
    #[serde(default)]
    pub auth_method: SshAuthMethod,
    /// Path to the private key. Empty/unused for `agent` and `password`.
    #[serde(default)]
    pub private_key_path: PathBuf,
}
