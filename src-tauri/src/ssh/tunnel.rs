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

/// accept ループが一時的なエラー (EMFILE/ENFILE/ECONNABORTED 等) から回復を試みる
/// ときの初期待機時間と上限。
const INITIAL_ACCEPT_BACKOFF: Duration = Duration::from_millis(50);
const MAX_ACCEPT_BACKOFF: Duration = Duration::from_secs(1);

/// 連続 accept エラー時のバックオフを次の値へ進める純関数 (指数バックオフ、上限
/// あり)。ソケット I/O を含まないのでユニットテストできる。
fn next_accept_backoff(current: Duration) -> Duration {
    (current * 2).min(MAX_ACCEPT_BACKOFF)
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

/// Coarse phase of opening an SSH tunnel, reported to the caller so the UI can
/// tell "stuck connecting the TCP/SSH transport" apart from "stuck on
/// authentication" instead of showing one opaque spinner (#684).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SshPhase {
    /// Establishing the TCP connection and SSH transport handshake.
    Connecting,
    /// Authenticating with the configured method (key / agent / password).
    Authenticating,
}

impl SshTunnel {
    /// Open a tunnel, reporting nothing about intermediate phases.
    pub async fn open(cfg: &SshConfig) -> Result<Self> {
        Self::open_with_progress(cfg, |_| {}).await
    }

    /// Open a tunnel, invoking `on_phase` as it moves from connecting to
    /// authenticating so the caller can surface progress (#684). The callback is
    /// only ever called between await points (never held across one), so a plain
    /// `Fn` suffices.
    pub async fn open_with_progress(cfg: &SshConfig, on_phase: impl Fn(SshPhase)) -> Result<Self> {
        on_phase(SshPhase::Connecting);
        let config = russh::client::Config {
            inactivity_timeout: Some(Duration::from_secs(600)),
            keepalive_interval: Some(Duration::from_secs(30)),
            ..Default::default()
        };
        let config = Arc::new(config);

        let handler = ClientHandler::new(&cfg.host, cfg.port);
        // Read the mismatch slot after `connect` fails: a TOFU host-key mismatch
        // aborts inside `check_server_key` with a generic `UnknownKey`, so we
        // recover the recorded fingerprints here and surface a precise,
        // recoverable `SshHostKeyMismatch` instead (#682).
        let mismatch_slot = handler.mismatch_slot();
        let mut session =
            match russh::client::connect(config, (cfg.host.as_str(), cfg.port), handler).await {
                Ok(s) => s,
                Err(e) => {
                    if let Some(m) = mismatch_slot
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .take()
                    {
                        return Err(AppError::SshHostKeyMismatch {
                            host: cfg.host.clone(),
                            port: cfg.port,
                            expected: m.expected,
                            actual: m.actual,
                        });
                    }
                    return Err(AppError::Ssh(format!("ssh connect failed: {e}")));
                }
            };

        on_phase(SshPhase::Authenticating);
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
            // 連続 accept エラー時のバックオフ状態。EMFILE/ENFILE のような一時的な
            // 資源枯渇でタイトループに陥り CPU を焼き尽くさないための対策。
            let mut backoff = INITIAL_ACCEPT_BACKOFF;

            loop {
                let (mut socket, peer) = match listener.accept().await {
                    Ok(s) => {
                        // 成功したらバックオフをリセットする。
                        backoff = INITIAL_ACCEPT_BACKOFF;
                        s
                    }
                    Err(e) => {
                        // accept() の一時的エラー (EMFILE/ENFILE/ECONNABORTED 等) で
                        // ループを終了すると listener が drop され、ローカルポートが
                        // 閉じてしまう。SshTunnel と SSH セッション自体は生き続ける
                        // ため、以後 sqlx が新規物理接続を張ろうとした時点で
                        // connection refused になる (「接続は生きているのにクエリが
                        // 失敗する」という不可解な壊れ方)。ループは継続し、連続
                        // エラー時のみ短い待機を挟んでタイトループを避ける。
                        tracing::warn!("tunnel listener accept failed: {e}; retrying");
                        tokio::time::sleep(backoff).await;
                        backoff = next_accept_backoff(backoff);
                        continue;
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

#[cfg(test)]
mod tests {
    use super::*;

    // H1: accept ループの一時的エラーからの回復戦略 (指数バックオフ、上限あり)
    // が正しく計算されることを検証する。ソケットを実際に使わないので高速かつ
    // 決定的にテストできる。
    #[test]
    fn accept_backoff_doubles_until_capped() {
        let mut backoff = INITIAL_ACCEPT_BACKOFF;
        assert_eq!(backoff, Duration::from_millis(50));

        backoff = next_accept_backoff(backoff);
        assert_eq!(backoff, Duration::from_millis(100));

        backoff = next_accept_backoff(backoff);
        assert_eq!(backoff, Duration::from_millis(200));

        // 十分に繰り返すと上限 (MAX_ACCEPT_BACKOFF) で頭打ちになり、それ以上は
        // 増え続けない (タイトループ化も無限増大もしない)。
        for _ in 0..20 {
            backoff = next_accept_backoff(backoff);
        }
        assert_eq!(backoff, MAX_ACCEPT_BACKOFF);
        assert_eq!(next_accept_backoff(backoff), MAX_ACCEPT_BACKOFF);
    }
}
