use std::path::{Path, PathBuf};
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
    /// Optional bastion/jump hop dialed *before* this one (#708 multi-hop
    /// tunnel, ProxyJump-equivalent). When set, this hop's own SSH session is
    /// established *through* the jump's local-port-forward instead of dialing
    /// `host` directly — see [`SshTunnel::open_with_progress`]. Capped at one
    /// jump hop (2 SSH hops total) for now.
    #[serde(default)]
    pub jump: Option<Box<SshJumpConfig>>,
}

/// The bastion/jump hop of a 2-hop SSH tunnel (#708): everything needed to
/// dial and authenticate it, minus a `remote_*` endpoint (implicitly the main
/// [`SshConfig`]'s own `host`/`port`, i.e. the jump forwards to the real
/// address of the SSH host it is jumping *to*) and minus its own `jump`
/// (chains are capped at one bastion hop).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshJumpConfig {
    pub host: String,
    pub port: u16,
    pub user: String,
    #[serde(default)]
    pub auth_method: SshAuthMethod,
    #[serde(default)]
    pub private_key_path: PathBuf,
    #[serde(default)]
    pub passphrase: String,
    #[serde(default)]
    pub password: String,
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

/// An active local-port-forward SSH tunnel, optionally chained through one
/// upstream bastion/jump hop (#708).
///
/// Dropping this struct tears down the accept loop, all in-flight transfer
/// tasks, and the SSH session — **in that order, then recurses into
/// `_upstream`** (declared last, so Rust drops it *after* every other field:
/// see the [Rust reference on struct-field drop
/// order](https://doc.rust-lang.org/reference/destructors.html), fields drop
/// in declaration order). For a chained tunnel this means the DB-facing
/// (last/target) hop always closes before the earlier (bastion) hop, matching
/// the existing "never drop the tunnel before the connection it carries"
/// invariant extended one level further up the chain.
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
    /// The bastion/jump hop this tunnel was dialed through, if any. Held so
    /// the whole chain's lifetime is tied to this struct and tears down in
    /// the right order (see the struct doc comment). `None` for a direct
    /// (single-hop, non-chained) tunnel.
    _upstream: Option<Box<SshTunnel>>,
}

/// Coarse phase of opening an SSH tunnel, reported to the caller so the UI can
/// tell "stuck connecting the TCP/SSH transport" apart from "stuck on
/// authentication" instead of showing one opaque spinner (#684). Reported once
/// per hop in a chained tunnel — the caller only sees connect/auth toggling
/// twice in a row for a jump + target chain, not which hop is which; per-hop
/// attribution instead happens on *failure* via the error message (see
/// [`tag_hop_error`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SshPhase {
    /// Establishing the TCP connection and SSH transport handshake.
    Connecting,
    /// Authenticating with the configured method (key / agent / password).
    Authenticating,
}

/// Which hop of a (possibly chained) tunnel an error originated from. Used
/// only to label the error message — it does not change `AppError`'s `kind`,
/// so the frontend's `kind`-based classification (#683) is unaffected; only
/// the human-readable `message` gains a `[jump host host:port]` /
/// `[ssh host host:port]` prefix so a multi-hop failure is attributable
/// (#708 acceptance criterion: "失敗段の区別可能なエラー").
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HopRole {
    Jump,
    Target,
}

impl HopRole {
    fn label(self) -> &'static str {
        match self {
            HopRole::Jump => "jump host",
            HopRole::Target => "ssh host",
        }
    }
}

/// Prefix an SSH-shaped error with which hop (and its `host:port` identity)
/// produced it. Other error variants (host-key mismatch, `Io`, ...) already
/// carry their own `host`/`port` context or don't originate from a specific
/// hop in a way worth labeling, so they pass through unchanged.
fn tag_hop_error(e: AppError, role: HopRole, host: &str, port: u16) -> AppError {
    let label = role.label();
    match e {
        AppError::Ssh(msg) => AppError::Ssh(format!("[{label} {host}:{port}] {msg}")),
        AppError::SshKey(msg) => AppError::SshKey(format!("[{label} {host}:{port}] {msg}")),
        other => other,
    }
}

/// The fixed set of parameters needed to open one hop's SSH session and its
/// local-port-forward, independent of whether it's the (only) direct hop, the
/// bastion, or the target of a chain. Built from either an [`SshConfig`] or an
/// [`SshJumpConfig`] by [`SshTunnel::open_with_progress`]. Every field is a
/// reference or otherwise `Copy`, so the whole spec is `Copy` — `open_one_hop`
/// moves one copy into its async block while keeping another around to tag any
/// resulting error with this hop's identity.
#[derive(Clone, Copy)]
struct HopSpec<'a> {
    host: &'a str,
    port: u16,
    user: &'a str,
    auth_method: SshAuthMethod,
    private_key_path: &'a Path,
    passphrase: &'a str,
    password: &'a str,
    /// What this hop's own tunnel forwards local connections to: the next
    /// hop's real address for a jump, or the final DB endpoint for the target.
    remote_host: &'a str,
    remote_port: u16,
}

impl SshTunnel {
    /// Open a tunnel, reporting nothing about intermediate phases.
    pub async fn open(cfg: &SshConfig) -> Result<Self> {
        Self::open_with_progress(cfg, |_| {}).await
    }

    /// Open a tunnel, invoking `on_phase` as each hop moves from connecting to
    /// authenticating so the caller can surface progress (#684). The callback is
    /// only ever called between await points (never held across one), so a plain
    /// `Fn` suffices.
    ///
    /// When `cfg.jump` is set, this first opens the bastion hop (dialing its
    /// real `host:port` directly), then opens `cfg`'s own SSH session *through*
    /// that bastion's freshly-bound local port instead of dialing `cfg.host`
    /// directly — chaining two ordinary local-port-forwards end to end rather
    /// than nesting `direct-tcpip` channels at the protocol level. Host-key
    /// verification for each hop still uses that hop's own real `host:port` as
    /// its known_hosts identity (never the intermediate `127.0.0.1:<port>` it
    /// was actually dialed on), so TOFU records/checks the right endpoint per
    /// hop (#708).
    pub async fn open_with_progress(cfg: &SshConfig, on_phase: impl Fn(SshPhase)) -> Result<Self> {
        let upstream = match &cfg.jump {
            Some(jump) => {
                let spec = HopSpec {
                    host: &jump.host,
                    port: jump.port,
                    user: &jump.user,
                    auth_method: jump.auth_method,
                    private_key_path: &jump.private_key_path,
                    passphrase: &jump.passphrase,
                    password: &jump.password,
                    // The bastion forwards local connections to the target
                    // hop's real address so we can dial *its* SSH session
                    // through that forward next.
                    remote_host: &cfg.host,
                    remote_port: cfg.port,
                };
                let dial = (jump.host.as_str(), jump.port);
                let t = Self::open_one_hop(spec, dial, HopRole::Jump, &on_phase, None).await?;
                Some(Box::new(t))
            }
            None => None,
        };

        // 踏み台がある場合はその**ローカル転送ポート**へダイヤルし、無い場合は
        // 最終ホップの実アドレスへ直接ダイヤルする。ホスト鍵の検証/記録には
        // ここではなく後段 `HopSpec` の実 `host`/`port` を使う (ダイヤル先と
        // 識別子を分離する多段トンネルの設計。CLAUDE.md 参照)。
        let (dial_host, dial_port) = match &upstream {
            Some(u) => ("127.0.0.1".to_string(), u.local_port),
            None => (cfg.host.clone(), cfg.port),
        };

        let spec = HopSpec {
            host: &cfg.host,
            port: cfg.port,
            user: &cfg.user,
            auth_method: cfg.auth_method,
            private_key_path: &cfg.private_key_path,
            passphrase: &cfg.passphrase,
            password: &cfg.password,
            remote_host: &cfg.remote_host,
            remote_port: cfg.remote_port,
        };
        Self::open_one_hop(
            spec,
            (dial_host.as_str(), dial_port),
            HopRole::Target,
            &on_phase,
            upstream,
        )
        .await
    }

    /// Open exactly one hop: connect (dialing `dial`, which is either this
    /// hop's own real address or an upstream hop's local forward), verify the
    /// host key under `spec.host`/`spec.port`, authenticate, then bind a local
    /// listener forwarding to `spec.remote_host`/`spec.remote_port`. Any error
    /// is tagged with `role` + this hop's identity before returning (#708).
    async fn open_one_hop(
        spec: HopSpec<'_>,
        dial: (&str, u16),
        role: HopRole,
        on_phase: &impl Fn(SshPhase),
        upstream: Option<Box<SshTunnel>>,
    ) -> Result<Self> {
        let go = async {
            on_phase(SshPhase::Connecting);
            let config = russh::client::Config {
                inactivity_timeout: Some(Duration::from_secs(600)),
                keepalive_interval: Some(Duration::from_secs(30)),
                ..Default::default()
            };
            let config = Arc::new(config);

            let handler = ClientHandler::new(spec.host, spec.port);
            // Read the mismatch slot after `connect` fails: a TOFU host-key
            // mismatch aborts inside `check_server_key` with a generic
            // `UnknownKey`, so we recover the recorded fingerprints here and
            // surface a precise, recoverable `SshHostKeyMismatch` instead (#682).
            let mismatch_slot = handler.mismatch_slot();
            let mut session = match russh::client::connect(config, dial, handler).await {
                Ok(s) => s,
                Err(e) => {
                    if let Some(m) = mismatch_slot
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .take()
                    {
                        return Err(AppError::SshHostKeyMismatch {
                            host: spec.host.to_string(),
                            port: spec.port,
                            expected: m.expected,
                            actual: m.actual,
                        });
                    }
                    return Err(AppError::Ssh(format!("ssh connect failed: {e}")));
                }
            };

            on_phase(SshPhase::Authenticating);
            super::auth::authenticate(
                &mut session,
                spec.user,
                spec.auth_method,
                spec.private_key_path,
                spec.passphrase,
                spec.password,
            )
            .await?;

            let session = Arc::new(session);

            // Bind a local listener on an OS-assigned port.
            let listener = TcpListener::bind(("127.0.0.1", 0u16)).await?;
            let local_port = listener.local_addr()?.port();
            tracing::info!(
                ssh_host = %spec.host,
                local_port,
                remote = %format!("{}:{}", spec.remote_host, spec.remote_port),
                "ssh tunnel listening"
            );

            let remote_host = spec.remote_host.to_string();
            let remote_port = spec.remote_port;
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
                        if let Err(e) =
                            tokio::io::copy_bidirectional(&mut socket, &mut stream).await
                        {
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
                _upstream: upstream,
            })
        };
        go.await
            .map_err(|e| tag_hop_error(e, role, spec.host, spec.port))
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
        // `_session` and (for a chained tunnel) `_upstream` drop automatically
        // right after this method returns, in declaration order — see the
        // struct doc comment for why that gives the right chain-teardown order.
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

    // #708: エラーメッセージにどの段 (bastion/jump か target か) の失敗かが
    // host:port 付きで現れること。`kind()` 自体は変えない (フロントの分類は
    // 引き続き `ssh` のまま) — メッセージだけが手がかりを増やす。
    #[test]
    fn tag_hop_error_labels_jump_and_target_distinctly() {
        let jump_tagged = tag_hop_error(
            AppError::Ssh("boom".into()),
            HopRole::Jump,
            "bastion.example.com",
            22,
        );
        assert_eq!(
            jump_tagged.to_string(),
            "ssh error: [jump host bastion.example.com:22] boom"
        );

        let target_tagged = tag_hop_error(
            AppError::SshKey("bad key".into()),
            HopRole::Target,
            "internal.example.com",
            2222,
        );
        assert_eq!(
            target_tagged.to_string(),
            "ssh key error: [ssh host internal.example.com:2222] bad key"
        );
    }

    // Non-SSH errors (e.g. a host-key mismatch, which already carries its own
    // host/port) pass through unchanged — they must not gain a redundant tag.
    #[test]
    fn tag_hop_error_leaves_other_variants_untouched() {
        let e = AppError::SshHostKeyMismatch {
            host: "h".into(),
            port: 22,
            expected: "SHA256:a".into(),
            actual: "SHA256:b".into(),
        };
        let msg_before = e.to_string();
        let tagged = tag_hop_error(e, HopRole::Jump, "h", 22);
        assert_eq!(tagged.to_string(), msg_before);
    }
}
