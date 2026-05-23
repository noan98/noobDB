use std::path::Path;
use std::sync::Arc;

use russh::keys::agent::client::{AgentClient, AgentStream};
use russh::keys::{decode_secret_key, PrivateKey};

use super::handler::ClientHandler;
use super::SshConfig;
use crate::error::{AppError, Result};
use crate::profiles::SshAuthMethod;

type Session = russh::client::Handle<ClientHandler>;

/// Load a private key from a file path, optionally decrypting with a passphrase.
pub fn load_private_key(path: &Path, passphrase: Option<&str>) -> Result<Arc<PrivateKey>> {
    let content = std::fs::read_to_string(path)
        .map_err(|e| AppError::SshKey(format!("failed to read key file: {e}")))?;
    let key = decode_secret_key(&content, passphrase)
        .map_err(|e| AppError::SshKey(format!("failed to decode private key: {e}")))?;
    Ok(Arc::new(key))
}

/// Authenticate an already-connected SSH session using the method in `cfg`.
pub async fn authenticate(session: &mut Session, cfg: &SshConfig) -> Result<()> {
    match cfg.auth_method {
        SshAuthMethod::Key => authenticate_key(session, cfg).await,
        SshAuthMethod::Agent => authenticate_agent(session, cfg).await,
        SshAuthMethod::Password => authenticate_password(session, cfg).await,
    }
}

async fn authenticate_key(session: &mut Session, cfg: &SshConfig) -> Result<()> {
    let passphrase = if cfg.passphrase.is_empty() {
        None
    } else {
        Some(cfg.passphrase.as_str())
    };
    let key = load_private_key(&cfg.private_key_path, passphrase)?;

    let authed = session
        .authenticate_publickey(
            &cfg.user,
            russh::keys::PrivateKeyWithHashAlg::new(key, None),
        )
        .await
        .map_err(|e| AppError::Ssh(format!("ssh auth error: {e}")))?;
    if !authed.success() {
        return Err(AppError::Ssh("ssh authentication failed".into()));
    }
    Ok(())
}

async fn authenticate_password(session: &mut Session, cfg: &SshConfig) -> Result<()> {
    let authed = session
        .authenticate_password(&cfg.user, cfg.password.clone())
        .await
        .map_err(|e| AppError::Ssh(format!("ssh auth error: {e}")))?;
    if !authed.success() {
        return Err(AppError::Ssh("ssh password authentication failed".into()));
    }
    Ok(())
}

async fn authenticate_agent(session: &mut Session, cfg: &SshConfig) -> Result<()> {
    // The agent client is platform specific (Unix socket vs. Windows named
    // pipe), but the auth loop below is identical, so connect here and hand
    // the concrete stream type to the generic helper.
    #[cfg(unix)]
    {
        let agent = AgentClient::connect_env().await.map_err(|e| {
            AppError::Ssh(format!(
                "failed to connect to ssh-agent (check SSH_AUTH_SOCK and that an agent is running): {e}"
            ))
        })?;
        agent_auth_loop(session, cfg, agent).await
    }
    #[cfg(windows)]
    {
        // OpenSSH for Windows exposes its agent over a fixed named pipe.
        // Pageant uses a different transport and is intentionally unsupported.
        const OPENSSH_AGENT_PIPE: &str = r"\\.\pipe\openssh-ssh-agent";
        let agent = AgentClient::connect_named_pipe(OPENSSH_AGENT_PIPE)
            .await
            .map_err(|e| {
                AppError::Ssh(format!(
                    "failed to connect to the Windows OpenSSH ssh-agent named pipe ({OPENSSH_AGENT_PIPE}). \
                     Ensure the 'OpenSSH Authentication Agent' service is running (Pageant is not supported): {e}"
                ))
            })?;
        agent_auth_loop(session, cfg, agent).await
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (session, cfg);
        Err(AppError::Ssh(
            "ssh-agent authentication is not supported on this platform".into(),
        ))
    }
}

/// Try every identity the agent holds until one authenticates.
async fn agent_auth_loop<S>(
    session: &mut Session,
    cfg: &SshConfig,
    mut agent: AgentClient<S>,
) -> Result<()>
where
    S: AgentStream + Send + Unpin + 'static,
{
    let identities = agent
        .request_identities()
        .await
        .map_err(|e| AppError::Ssh(format!("failed to list ssh-agent identities: {e}")))?;
    if identities.is_empty() {
        return Err(AppError::Ssh(
            "ssh-agent holds no identities (add one with `ssh-add`)".into(),
        ));
    }

    for id in identities {
        let public_key = id.public_key().into_owned();
        let result = session
            .authenticate_publickey_with(&cfg.user, public_key, None, &mut agent)
            .await
            .map_err(|e| AppError::Ssh(format!("ssh-agent auth error: {e}")))?;
        if result.success() {
            return Ok(());
        }
    }

    Err(AppError::Ssh(
        "ssh-agent authentication failed for all identities".into(),
    ))
}
