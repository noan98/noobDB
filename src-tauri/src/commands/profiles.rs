use serde::Deserialize;

use crate::error::Result;
use crate::profiles::store::{self, new_profile_id};
use crate::profiles::{secrets, ConnectionProfile, SshProfile};

#[derive(Debug, Deserialize)]
pub struct SaveProfileRequest {
    /// If empty/None a new id is generated.
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    pub driver: String,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub port: u16,
    #[serde(default)]
    pub user: String,
    #[serde(default)]
    pub database: Option<String>,
    #[serde(default)]
    pub ssh: Option<SshProfile>,
    /// If Some, password is stored in the OS keyring; if None, no change.
    /// Empty string clears the stored password.
    #[serde(default)]
    pub db_password: Option<String>,
    /// Same semantics for the SSH passphrase.
    #[serde(default)]
    pub ssh_passphrase: Option<String>,
    /// Same semantics for the SSH password (password auth method).
    #[serde(default)]
    pub ssh_password: Option<String>,
    #[serde(default)]
    pub group: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub is_production: bool,
    #[serde(default)]
    pub read_only: bool,
    /// Required for file-backed drivers (SQLite); ignored otherwise.
    #[serde(default)]
    pub file_path: Option<String>,
}

#[tauri::command]
pub async fn list_profiles() -> Result<Vec<ConnectionProfile>> {
    store::load_all()
}

#[tauri::command]
pub async fn save_profile(req: SaveProfileRequest) -> Result<ConnectionProfile> {
    let id = req
        .id
        .filter(|s| !s.is_empty())
        .unwrap_or_else(new_profile_id);
    let profile = ConnectionProfile {
        id: id.clone(),
        name: req.name,
        driver: req.driver,
        host: req.host,
        port: req.port,
        user: req.user,
        database: req.database,
        ssh: req.ssh,
        group: req.group.filter(|s| !s.is_empty()),
        color: req.color.filter(|s| !s.is_empty()),
        is_production: req.is_production,
        read_only: req.read_only,
        file_path: req.file_path.filter(|s| !s.is_empty()),
    };
    store::upsert(profile.clone())?;

    if let Some(pw) = req.db_password {
        if pw.is_empty() {
            secrets::delete_db_password(&id)?;
        } else {
            secrets::set_db_password(&id, &pw)?;
        }
    }
    if let Some(pp) = req.ssh_passphrase {
        if pp.is_empty() {
            secrets::delete_ssh_passphrase(&id)?;
        } else {
            secrets::set_ssh_passphrase(&id, &pp)?;
        }
    }
    if let Some(pw) = req.ssh_password {
        if pw.is_empty() {
            secrets::delete_ssh_password(&id)?;
        } else {
            secrets::set_ssh_password(&id, &pw)?;
        }
    }
    Ok(profile)
}

#[tauri::command]
pub async fn delete_profile(id: String) -> Result<()> {
    secrets::delete_all(&id)?;
    store::delete(&id)?;
    Ok(())
}
