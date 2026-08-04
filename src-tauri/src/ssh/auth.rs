use std::path::Path;
use std::sync::Arc;

use russh::keys::agent::client::{AgentClient, AgentStream};
use russh::keys::{decode_secret_key, PrivateKey};

use super::handler::ClientHandler;
use crate::error::{AppError, Result};
use crate::profiles::SshAuthMethod;

type Session = russh::client::Handle<ClientHandler>;

/// Load a private key from a file path, optionally decrypting with a passphrase.
pub fn load_private_key(path: &Path, passphrase: Option<&str>) -> Result<Arc<PrivateKey>> {
    let content = std::fs::read_to_string(path).map_err(|e| {
        tracing::error!(path = %path.display(), error = %e, "ssh: failed to read private key file");
        AppError::SshKey(format!("failed to read key file: {e}"))
    })?;
    let key = decode_secret_key(&content, passphrase).map_err(|e| {
        tracing::error!(path = %path.display(), error = %e, "ssh: failed to decode private key");
        AppError::SshKey(format!("failed to decode private key: {e}"))
    })?;
    Ok(Arc::new(key))
}

/// OpenSSH 8.8 以降は既定でレガシー `ssh-rsa` (SHA-1) 署名を拒否するため、RSA 鍵で
/// 認証する際はサーバの `server-sig-algs` 拡張 (ext-info) を問い合わせ、
/// `rsa-sha2-256`/`rsa-sha2-512` のうちサーバが受理する方を使う必要がある。
/// `russh::client::Handle::best_supported_rsa_hash` がこの問い合わせを行う。
/// 拡張未対応のサーバでは `Ok(None)` (= 判定不能、レガシーへフォールバック) を
/// 返し、問い合わせ自体が失敗した場合も同様にフォールバックする — これは本修正
/// 前の既定動作 (常に `None`) と同じなので、デグレードにはならない。RSA 以外の
/// 鍵種では `PrivateKeyWithHashAlg::new` が `hash_alg` を無視するため影響しない。
async fn best_supported_rsa_hash(session: &Session) -> Option<russh::keys::HashAlg> {
    session
        .best_supported_rsa_hash()
        .await
        .ok()
        .flatten()
        .flatten()
}

/// Authenticate an already-connected SSH session with the given credentials.
///
/// Split out from [`super::SshConfig`] into discrete fields (#708) so both a
/// direct hop and a bastion/jump hop (whose credentials live in the smaller
/// `SshJumpConfig`) can share this single implementation without either
/// borrowing from the other's type.
pub async fn authenticate(
    session: &mut Session,
    user: &str,
    auth_method: SshAuthMethod,
    private_key_path: &Path,
    passphrase: &str,
    password: &str,
) -> Result<()> {
    tracing::debug!(method = ?auth_method, user = %user, "ssh: authenticating");
    match auth_method {
        SshAuthMethod::Key => authenticate_key(session, user, private_key_path, passphrase).await,
        SshAuthMethod::Agent => authenticate_agent(session, user).await,
        SshAuthMethod::Password => authenticate_password(session, user, password).await,
    }
}

async fn authenticate_key(
    session: &mut Session,
    user: &str,
    private_key_path: &Path,
    passphrase: &str,
) -> Result<()> {
    let passphrase = if passphrase.is_empty() {
        None
    } else {
        Some(passphrase)
    };
    let key = load_private_key(private_key_path, passphrase)?;
    let hash_alg = best_supported_rsa_hash(session).await;

    let authed = session
        .authenticate_publickey(user, russh::keys::PrivateKeyWithHashAlg::new(key, hash_alg))
        .await
        .map_err(|e| {
            tracing::error!(user = %user, error = %e, "ssh: public-key auth error");
            AppError::Ssh(format!("ssh auth error: {e}"))
        })?;
    if !authed.success() {
        tracing::warn!(user = %user, "ssh: public-key authentication rejected");
        return Err(AppError::Ssh("ssh authentication failed".into()));
    }
    Ok(())
}

async fn authenticate_password(session: &mut Session, user: &str, password: &str) -> Result<()> {
    let authed = session
        .authenticate_password(user, password.to_string())
        .await
        .map_err(|e| {
            tracing::error!(user = %user, error = %e, "ssh: password auth error");
            AppError::Ssh(format!("ssh auth error: {e}"))
        })?;
    if !authed.success() {
        tracing::warn!(user = %user, "ssh: password authentication rejected");
        return Err(AppError::Ssh("ssh password authentication failed".into()));
    }
    Ok(())
}

async fn authenticate_agent(session: &mut Session, user: &str) -> Result<()> {
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
        agent_auth_loop(session, user, agent).await
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
        agent_auth_loop(session, user, agent).await
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (session, user);
        Err(AppError::Ssh(
            "ssh-agent authentication is not supported on this platform".into(),
        ))
    }
}

/// Try every identity the agent holds until one authenticates.
async fn agent_auth_loop<S>(
    session: &mut Session,
    user: &str,
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

    let hash_alg = best_supported_rsa_hash(session).await;
    for id in identities {
        let public_key = id.public_key().into_owned();
        let result = session
            .authenticate_publickey_with(user, public_key, hash_alg, &mut agent)
            .await
            .map_err(|e| {
                tracing::error!(user = %user, error = %e, "ssh: agent auth error");
                AppError::Ssh(format!("ssh-agent auth error: {e}"))
            })?;
        if result.success() {
            return Ok(());
        }
    }

    tracing::warn!(user = %user, "ssh: agent authentication rejected for all identities");
    Err(AppError::Ssh(
        "ssh-agent authentication failed for all identities".into(),
    ))
}
