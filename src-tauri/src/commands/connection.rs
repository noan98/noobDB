use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::{Connection, DbConnectOptions, DriverKind};
use crate::error::{AppError, Result};
use crate::profiles::{secrets, SshAuthMethod};
use crate::ssh::{SshConfig, SshTunnel};
use crate::state::{new_session_id, AppState, Session, SessionId};

#[derive(Debug, Deserialize)]
pub struct ConnectRequest {
    /// Optional: if present, secrets will be looked up from keyring for this profile.
    pub profile_id: Option<String>,
    pub driver: DriverKind,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub port: u16,
    #[serde(default)]
    pub user: String,
    /// If empty and profile_id is set, the password is loaded from keyring.
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub database: Option<String>,
    #[serde(default)]
    pub ssh: Option<SshRequest>,
    /// Required for file-backed drivers (SQLite); ignored otherwise.
    #[serde(default)]
    pub file_path: Option<String>,
    /// When true the resulting session refuses to execute non-read-only SQL.
    #[serde(default)]
    pub read_only: bool,
    /// When true, statements run on the resulting session are not recorded
    /// in the query history.
    #[serde(default)]
    pub skip_history: bool,
}

#[derive(Debug, Deserialize)]
pub struct SshRequest {
    pub host: String,
    pub port: u16,
    pub user: String,
    #[serde(default)]
    pub auth_method: SshAuthMethod,
    #[serde(default)]
    pub private_key_path: std::path::PathBuf,
    /// If empty and profile_id is set, the passphrase is loaded from keyring.
    #[serde(default)]
    pub passphrase: String,
    /// Password for `auth_method == Password`. If empty and profile_id is set,
    /// it is loaded from the keyring.
    #[serde(default)]
    pub password: String,
}

#[derive(Debug, Serialize)]
pub struct ConnectResponse {
    pub session_id: SessionId,
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
        read_only: req.read_only,
        skip_history: req.skip_history,
        connect_options: opts,
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

/// Build DB options and (if requested) open an SSH tunnel.
/// Returns the optional tunnel guard that must outlive the DB connection.
async fn build_options(req: &ConnectRequest) -> Result<(Option<SshTunnel>, DbConnectOptions)> {
    // File-backed drivers don't have a host/port/user/password and can't
    // be tunneled, so short-circuit before touching credentials or SSH.
    if matches!(req.driver, DriverKind::Sqlite) {
        let file_path = req
            .file_path
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| AppError::InvalidInput("SQLite file path is required".into()))?;
        let opts = DbConnectOptions {
            host: String::new(),
            port: 0,
            user: String::new(),
            password: String::new(),
            database: None,
            driver: req.driver,
            file_path: Some(file_path.to_string()),
        };
        return Ok((None, opts));
    }

    let password = resolve_password(req)?;

    let (tunnel, host, port) = if let Some(ssh) = &req.ssh {
        let passphrase = resolve_passphrase(req, ssh)?;
        let ssh_password = resolve_ssh_password(req, ssh)?;
        let cfg = SshConfig {
            host: ssh.host.clone(),
            port: ssh.port,
            user: ssh.user.clone(),
            auth_method: ssh.auth_method,
            private_key_path: ssh.private_key_path.clone(),
            passphrase,
            password: ssh_password,
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
        file_path: None,
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

fn resolve_ssh_password(req: &ConnectRequest, ssh: &SshRequest) -> Result<String> {
    if !ssh.password.is_empty() {
        return Ok(ssh.password.clone());
    }
    if let Some(id) = &req.profile_id {
        if let Some(p) = secrets::get_ssh_password(id)? {
            return Ok(p);
        }
    }
    Ok(String::new())
}
