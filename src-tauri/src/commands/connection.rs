use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::{Connection, DbConnectOptions, DriverKind};
use crate::error::Result;
use crate::profiles::secrets;
use crate::ssh::{SshConfig, SshTunnel};
use crate::state::{new_session_id, AppState, Session, SessionId};

#[derive(Debug, Deserialize)]
pub struct ConnectRequest {
    /// Optional: if present, secrets will be looked up from keyring for this profile.
    pub profile_id: Option<String>,
    pub driver: DriverKind,
    pub host: String,
    pub port: u16,
    pub user: String,
    /// If empty and profile_id is set, the password is loaded from keyring.
    pub password: String,
    pub database: Option<String>,
    pub ssh: Option<SshRequest>,
}

#[derive(Debug, Deserialize)]
pub struct SshRequest {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub private_key_path: std::path::PathBuf,
    /// If empty and profile_id is set, the passphrase is loaded from keyring.
    #[serde(default)]
    pub passphrase: String,
}

#[derive(Debug, Serialize)]
pub struct ConnectResponse {
    pub session_id: SessionId,
}

#[derive(Debug, Serialize)]
pub struct SessionInfo {
    pub id: SessionId,
    pub profile_id: Option<String>,
}

#[tauri::command]
pub async fn test_connection(req: ConnectRequest) -> Result<String> {
    let (tunnel, opts) = build_options(&req).await?;
    let conn = Connection::connect(&opts).await?;
    let _ = conn.execute("SELECT 1", None).await?;
    conn.close().await;
    drop(tunnel);
    Ok("ok".into())
}

#[tauri::command]
pub async fn connect(req: ConnectRequest, state: State<'_, AppState>) -> Result<ConnectResponse> {
    let profile_id = req.profile_id.clone();
    let (tunnel, opts) = build_options(&req).await?;
    let conn = Connection::connect(&opts).await?;
    let session = Session {
        id: new_session_id(),
        profile_id,
        conn,
        _tunnel: tunnel,
    };
    let id = state.insert(session).await;
    Ok(ConnectResponse { session_id: id })
}

#[tauri::command]
pub async fn disconnect(session_id: String, state: State<'_, AppState>) -> Result<()> {
    if let Some(sess) = state.remove(&session_id).await {
        sess.conn.close().await;
        // Session (and its tunnel) drops with the last Arc reference.
    }
    Ok(())
}

#[tauri::command]
pub async fn list_sessions(state: State<'_, AppState>) -> Result<Vec<SessionInfo>> {
    let map = state.sessions.read().await;
    Ok(map
        .values()
        .map(|s| SessionInfo {
            id: s.id.clone(),
            profile_id: s.profile_id.clone(),
        })
        .collect())
}

/// Build DB options and (if requested) open an SSH tunnel.
/// Returns the optional tunnel guard that must outlive the DB connection.
async fn build_options(req: &ConnectRequest) -> Result<(Option<SshTunnel>, DbConnectOptions)> {
    let password = resolve_password(req)?;

    let (tunnel, host, port) = if let Some(ssh) = &req.ssh {
        let passphrase = resolve_passphrase(req, ssh)?;
        let cfg = SshConfig {
            host: ssh.host.clone(),
            port: ssh.port,
            user: ssh.user.clone(),
            private_key_path: ssh.private_key_path.clone(),
            passphrase,
            remote_host: req.host.clone(),
            remote_port: req.port,
        };
        let t = SshTunnel::open(&cfg).await?;
        let port = t.local_port;
        (Some(t), "127.0.0.1".to_string(), port)
    } else {
        (None, req.host.clone(), req.port)
    };

    let opts = DbConnectOptions {
        host,
        port,
        user: req.user.clone(),
        password,
        database: req.database.clone(),
        driver: req.driver,
    };
    Ok((tunnel, opts))
}

fn resolve_password(req: &ConnectRequest) -> Result<String> {
    if !req.password.is_empty() {
        return Ok(req.password.clone());
    }
    if let Some(id) = &req.profile_id {
        if let Some(p) = secrets::get_db_password(id)? {
            return Ok(p);
        }
    }
    Ok(String::new())
}

fn resolve_passphrase(req: &ConnectRequest, ssh: &SshRequest) -> Result<String> {
    if !ssh.passphrase.is_empty() {
        return Ok(ssh.passphrase.clone());
    }
    if let Some(id) = &req.profile_id {
        if let Some(p) = secrets::get_ssh_passphrase(id)? {
            return Ok(p);
        }
    }
    Ok(String::new())
}
