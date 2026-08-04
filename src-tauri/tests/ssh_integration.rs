//! SSH トンネル接続の統合テスト。
//!
//! `russh` による接続確立・認証 (パスワード / 鍵)・`direct-tcpip` フォワード・
//! トンネル越しのデータ往復を、実際の sshd に対してエンドツーエンドで検証する。
//!
//! `NOOBDB_TEST_SSH_URL` (`ssh://user:password@host:port`) が設定されていない場合は
//! スキップする (MySQL/PostgreSQL 統合テストと同じ環境変数ゲート方式)。鍵認証テストは
//! 追加で `NOOBDB_TEST_SSH_KEY` (秘密鍵パス) が必要で、未設定ならその 1 件のみ
//! スキップする。CI では `rust (test)` ジョブが sshd をセットアップして両者を渡す。
//!
//! 注: TOFU ホスト鍵検証 (初回信頼・不一致拒否・レガシー移行) の判定ロジックは
//! `ssh/handler.rs` の単体テストが known_hosts パスを制御して網羅済み。ここでは実
//! sshd に対する初回接続 (TOFU 記録) と再接続 (既知ホスト一致) が通ることを確認する。

use std::path::PathBuf;
use std::time::Duration;

use noobdb_lib::__test_api as t;
use t::{SshAuthMethod, SshConfig, SshJumpConfig, SshTunnel};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// `ssh://user:password@host:port` を最小限パースする (テスト専用)。
struct SshUrl {
    host: String,
    port: u16,
    user: String,
    password: String,
}

fn parse_ssh_url(url: &str) -> Option<SshUrl> {
    let rest = url.strip_prefix("ssh://")?;
    let (creds, hostpart) = rest.split_once('@')?;
    let (user, password) = match creds.split_once(':') {
        Some((u, p)) => (u.to_string(), p.to_string()),
        None => (creds.to_string(), String::new()),
    };
    let (host, port) = match hostpart.split_once(':') {
        Some((h, p)) => (h.to_string(), p.parse().ok()?),
        None => (hostpart.to_string(), 22u16),
    };
    Some(SshUrl {
        host,
        port,
        user,
        password,
    })
}

fn test_url() -> Option<SshUrl> {
    let url = std::env::var("NOOBDB_TEST_SSH_URL").ok()?;
    parse_ssh_url(&url)
}

/// 127.0.0.1 の OS 割り当てポートで「受信したバイトをそのまま返す」エコーサーバを
/// 起動し、待ち受けポートを返す。トンネルの転送先 (remote) に使う。
async fn spawn_echo_server() -> u16 {
    let listener = TcpListener::bind(("127.0.0.1", 0u16))
        .await
        .expect("bind echo");
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let Ok((mut sock, _)) = listener.accept().await else {
                break;
            };
            tokio::spawn(async move {
                let mut buf = [0u8; 1024];
                loop {
                    match sock.read(&mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            if sock.write_all(&buf[..n]).await.is_err() {
                                break;
                            }
                        }
                    }
                }
            });
        }
    });
    port
}

/// ローカル転送ポート経由でエコーサーバに `ping` を送り、返ってくることを確認する。
async fn assert_tunnel_forwards(local_port: u16) {
    let mut stream = TcpStream::connect(("127.0.0.1", local_port))
        .await
        .expect("connect to local forwarded port");
    stream
        .write_all(b"ping")
        .await
        .expect("write through tunnel");
    let mut buf = [0u8; 4];
    stream
        .read_exact(&mut buf)
        .await
        .expect("read echo through tunnel");
    assert_eq!(
        &buf, b"ping",
        "tunnel should forward bytes to the echo server"
    );
}

/// 与えた認証方法でエコーサーバへのトンネルを開く `SshConfig` を組み立てる。
fn config_for(
    url: &SshUrl,
    echo_port: u16,
    auth: SshAuthMethod,
    key: Option<PathBuf>,
) -> SshConfig {
    SshConfig {
        host: url.host.clone(),
        port: url.port,
        user: url.user.clone(),
        auth_method: auth,
        private_key_path: key.unwrap_or_default(),
        passphrase: String::new(),
        password: url.password.clone(),
        remote_host: "127.0.0.1".to_string(),
        remote_port: echo_port,
        jump: None,
    }
}

/// Same as [`config_for`], but chained through a bastion/jump hop (#708). The
/// local sshd under test plays *both* roles: the jump hop dials it directly
/// and forwards to its own real address, then the target hop dials *that*
/// forward (`127.0.0.1:<jump's local port>`) to open a second SSH session with
/// the same sshd — a real double SSH handshake, just against one server twice
/// (`scripts/ci-setup-sshd.sh` only stands up one; the app doesn't care that
/// both hops happen to be the same host).
fn chained_config_for(
    url: &SshUrl,
    echo_port: u16,
    auth: SshAuthMethod,
    key: Option<PathBuf>,
) -> SshConfig {
    let jump = SshJumpConfig {
        host: url.host.clone(),
        port: url.port,
        user: url.user.clone(),
        auth_method: auth,
        private_key_path: key.clone().unwrap_or_default(),
        passphrase: String::new(),
        password: url.password.clone(),
    };
    let mut cfg = config_for(url, echo_port, auth, key);
    cfg.jump = Some(Box::new(jump));
    cfg
}

#[tokio::test]
async fn ssh_password_auth_tunnel_forwards_when_env_set() {
    let Some(url) = test_url() else {
        eprintln!("skip: NOOBDB_TEST_SSH_URL not set");
        return;
    };
    let echo_port = spawn_echo_server().await;
    let cfg = config_for(&url, echo_port, SshAuthMethod::Password, None);

    let tunnel = SshTunnel::open(&cfg)
        .await
        .expect("password-auth tunnel should establish");
    assert!(tunnel.local_port > 0, "tunnel should open a local port");

    // direct-tcpip フォワードでエコーサーバまでバイトが往復する。
    assert_tunnel_forwards(tunnel.local_port).await;

    drop(tunnel);
}

#[tokio::test]
async fn ssh_key_auth_tunnel_forwards_when_env_set() {
    let Some(url) = test_url() else {
        eprintln!("skip: NOOBDB_TEST_SSH_URL not set");
        return;
    };
    let Ok(key_path) = std::env::var("NOOBDB_TEST_SSH_KEY") else {
        eprintln!("skip: NOOBDB_TEST_SSH_KEY not set");
        return;
    };
    let echo_port = spawn_echo_server().await;
    let cfg = config_for(
        &url,
        echo_port,
        SshAuthMethod::Key,
        Some(PathBuf::from(key_path)),
    );

    let tunnel = SshTunnel::open(&cfg)
        .await
        .expect("key-auth tunnel should establish");
    assert_tunnel_forwards(tunnel.local_port).await;
    drop(tunnel);
}

#[tokio::test]
async fn ssh_reconnect_succeeds_with_known_host_when_env_set() {
    // 初回接続で TOFU により host key が known_hosts に記録され、再接続では
    // 「既知ホスト一致」経路を通って成功する (handler.rs の TOFU を実 sshd で確認)。
    let Some(url) = test_url() else {
        eprintln!("skip: NOOBDB_TEST_SSH_URL not set");
        return;
    };
    let echo_port = spawn_echo_server().await;

    for attempt in 0..2 {
        let cfg = config_for(&url, echo_port, SshAuthMethod::Password, None);
        let tunnel = SshTunnel::open(&cfg)
            .await
            .unwrap_or_else(|e| panic!("attempt {attempt}: tunnel should establish: {e}"));
        assert_tunnel_forwards(tunnel.local_port).await;
        drop(tunnel);
        // セッションのクローズが落ち着くまで少し待つ。
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

// #708: 多段トンネル (踏み台 1 段 + 最終 SSH ホスト、計 2 ホップ) の実 sshd に対する
// ラウンドトリップ。同一 sshd を 2 段として使い (CLAUDE.md 記載の許容パターン)、
// 「1 段目のローカルポートを 2 段目の接続先にする」チェーンを実際に張って
// direct-tcpip でエコーサーバまでバイトが往復することを確認する。
#[tokio::test]
async fn ssh_two_hop_chain_forwards_when_env_set() {
    let Some(url) = test_url() else {
        eprintln!("skip: NOOBDB_TEST_SSH_URL not set");
        return;
    };
    let echo_port = spawn_echo_server().await;
    let cfg = chained_config_for(&url, echo_port, SshAuthMethod::Password, None);

    let tunnel = SshTunnel::open(&cfg)
        .await
        .expect("2-hop chained tunnel should establish");
    assert!(tunnel.local_port > 0, "tunnel should open a local port");
    assert_tunnel_forwards(tunnel.local_port).await;

    drop(tunnel);
    // Both hops' sessions should tear down cleanly; give the close a moment
    // to settle before the process exits so a hang/panic in Drop would show up
    // rather than being masked by the test process ending first.
    tokio::time::sleep(Duration::from_millis(50)).await;
}

// #708: 鍵認証でも 2 ホップ構成が張れることを確認する (パスワード認証のみに依存
// した実装になっていないか)。
#[tokio::test]
async fn ssh_two_hop_chain_with_key_auth_forwards_when_env_set() {
    let Some(url) = test_url() else {
        eprintln!("skip: NOOBDB_TEST_SSH_URL not set");
        return;
    };
    let Ok(key_path) = std::env::var("NOOBDB_TEST_SSH_KEY") else {
        eprintln!("skip: NOOBDB_TEST_SSH_KEY not set");
        return;
    };
    let echo_port = spawn_echo_server().await;
    let cfg = chained_config_for(
        &url,
        echo_port,
        SshAuthMethod::Key,
        Some(PathBuf::from(key_path)),
    );

    let tunnel = SshTunnel::open(&cfg)
        .await
        .expect("2-hop chained key-auth tunnel should establish");
    assert_tunnel_forwards(tunnel.local_port).await;
    drop(tunnel);
}

// #708: どちらの段が失敗したかがエラーメッセージから分かること。sshd 不要 —
// ジャンプホストとして誰も listen していないポートを指せば、実サーバなしで
// 「ジャンプ段で接続が落ちた」状況を決定的に再現できる。
#[tokio::test]
async fn chain_connect_failure_is_tagged_with_the_failing_hop() {
    // Bind then immediately drop so nothing is listening on this port —
    // dialing it fails fast (ECONNREFUSED) without needing a real sshd.
    let listener = TcpListener::bind(("127.0.0.1", 0u16))
        .await
        .expect("bind a throwaway port");
    let dead_port = listener.local_addr().unwrap().port();
    drop(listener);

    let jump = SshJumpConfig {
        host: "127.0.0.1".into(),
        port: dead_port,
        user: "nobody".into(),
        auth_method: SshAuthMethod::Password,
        private_key_path: PathBuf::new(),
        passphrase: String::new(),
        password: String::new(),
    };
    let cfg = SshConfig {
        host: "127.0.0.1".into(),
        // Deliberately unreachable too, but irrelevant: the jump hop must
        // fail first, before the target hop is even attempted.
        port: 1,
        user: "nobody".into(),
        auth_method: SshAuthMethod::Password,
        private_key_path: PathBuf::new(),
        passphrase: String::new(),
        password: String::new(),
        remote_host: "127.0.0.1".into(),
        remote_port: 1,
        jump: Some(Box::new(jump)),
    };

    // `SshTunnel` doesn't implement `Debug` (it holds live task handles / an SSH
    // session handle), so `Result::expect_err` (which requires `T: Debug` to
    // format the Ok value on panic) isn't available here; match instead.
    let err = match SshTunnel::open(&cfg).await {
        Ok(_) => panic!("dialing a dead jump host must fail"),
        Err(e) => e,
    };
    let msg = err.to_string();
    assert!(
        msg.contains("jump host"),
        "error should name the jump hop as the failure point: {msg}"
    );
    assert!(
        msg.contains(&dead_port.to_string()),
        "error should include the jump hop's own host:port identity: {msg}"
    );
}
