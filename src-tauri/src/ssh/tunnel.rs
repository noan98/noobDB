use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

use super::handler::ClientHandler;
use crate::error::{AppError, Result};
use crate::profiles::SshAuthMethod;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshConfig {
    pub host: String,
    pub port: u16,
    pub user: String,
    /// Selects which credential path `auth` uses below.
    #[serde(default)]
    pub auth_method: SshAuthMethod,
    /// Private key path. Used only when `auth_method == Key`.
    #[serde(default)]
    pub private_key_path: PathBuf,
    /// Passphrase for the private key. Empty string == no passphrase.
    #[serde(default)]
    pub passphrase: String,
    /// Password for `auth_method == Password`. Empty string == none.
    #[serde(default)]
    pub password: String,
    /// Final endpoint we want to reach through the tunnel.
    pub remote_host: String,
    pub remote_port: u16,
}

/// An active local-port-forward SSH tunnel.
/// Dropping this struct tears down the accept loop, all in-flight transfer
/// tasks, and the SSH session.
pub struct SshTunnel {
    pub local_port: u16,
    accept_task: Option<JoinHandle<()>>,
    /// Handles for per-connection `copy_bidirectional` tasks.  The accept loop
    /// prunes finished handles on every new connection; `Drop` aborts whatever
    /// remains so no orphan tasks outlive the tunnel.
    transfer_tasks: Arc<Mutex<Vec<JoinHandle<()>>>>,
    /// Holding the Arc keeps the SSH session alive. When dropped together
    /// with the task, russh closes the underlying connection.
    _session: Arc<russh::client::Handle<ClientHandler>>,
}

impl SshTunnel {
    pub async fn open(cfg: &SshConfig) -> Result<Self> {
        let config = russh::client::Config {
            inactivity_timeout: Some(Duration::from_secs(600)),
            keepalive_interval: Some(Duration::from_secs(30)),
            ..Default::default()
        };
        let config = Arc::new(config);

        let handler = ClientHandler::new(&cfg.host, cfg.port);
        let mut session = russh::client::connect(config, (cfg.host.as_str(), cfg.port), handler)
            .await
            .map_err(|e| AppError::Ssh(format!("ssh connect failed: {e}")))?;

        super::auth::authenticate(&mut session, cfg).await?;

        let session = Arc::new(session);

        // Bind a local listener on an OS-assigned port.
        let listener = TcpListener::bind(("127.0.0.1", 0u16)).await?;
        let local_port = listener.local_addr()?.port();
        tracing::info!(
            ssh_host = %cfg.host,
            local_port,
            remote = %format!("{}:{}", cfg.remote_host, cfg.remote_port),
            "ssh tunnel listening"
        );

        let remote_host = cfg.remote_host.clone();
        let remote_port = cfg.remote_port;
        let session_for_task = session.clone();
        let transfer_tasks: Arc<Mutex<Vec<JoinHandle<()>>>> = Arc::new(Mutex::new(Vec::new()));
        let tasks_for_accept = transfer_tasks.clone();

        let accept_task = tokio::spawn(async move {
            loop {
                let (mut socket, peer) = match listener.accept().await {
                    Ok(s) => s,
                    Err(e) => {
                        tracing::warn!("tunnel listener accept failed: {e}");
                        return;
                    }
                };

                let session = session_for_task.clone();
                let remote_host = remote_host.clone();
                let handle = tokio::spawn(async move {
                    let channel = match session
                        .channel_open_direct_tcpip(
                            remote_host.clone(),
                            remote_port as u32,
                            "127.0.0.1",
                            peer.port() as u32,
                        )
                        .await
                    {
                        Ok(c) => c,
                        Err(e) => {
                            tracing::warn!("direct-tcpip open failed: {e}");
                            let _ = socket.shutdown().await;
                            return;
                        }
                    };

                    let mut stream = channel.into_stream();
                    if let Err(e) = tokio::io::copy_bidirectional(&mut socket, &mut stream).await {
                        tracing::debug!("tunnel copy ended: {e}");
                    }
                    let _ = stream.shutdown().await;
                    let _ = socket.shutdown().await;
                });

                // Register the handle and prune already-finished ones to avoid
                // unbounded growth when the tunnel handles many short-lived connections.
                // unwrap_or_else recovers from a poisoned mutex so the handle is
                // always tracked even if a previous operation panicked.
                let mut tasks = tasks_for_accept.lock().unwrap_or_else(|e| e.into_inner());
                tasks.retain(|h| !h.is_finished());
                tasks.push(handle);
            }
        });

        Ok(Self {
            local_port,
            accept_task: Some(accept_task),
            transfer_tasks,
            _session: session,
        })
    }
}

impl Drop for SshTunnel {
    fn drop(&mut self) {
        if let Some(h) = self.accept_task.take() {
            h.abort();
        }
        // Abort all in-flight transfer tasks so no orphan tasks outlive the
        // tunnel and the SSH session/socket can be released promptly.
        // unwrap_or_else recovers from a poisoned mutex so abort never silently
        // skips tasks—essential for the orphan-prevention guarantee.
        let mut tasks = self
            .transfer_tasks
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        for h in tasks.drain(..) {
            h.abort();
        }
        tracing::info!(local_port = self.local_port, "ssh tunnel closed");
    }
}
