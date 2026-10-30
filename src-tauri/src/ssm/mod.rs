//! AWS Systems Manager (SSM) Session Manager のポートフォワード経由の接続経路 (#1683)。
//!
//! SSH トンネルと並ぶ「踏み台経由」の接続方式。踏み台 EC2 インスタンスへ
//! `aws ssm start-session --document-name AWS-StartPortForwardingSessionToRemoteHost`
//! を子プロセスとして起動し、`127.0.0.1:<空きポート>` を RDS 等のエンドポイントへ中継する。
//! 認証 (IAM / SSO / aws-vault の `credential_process` など) は AWS CLI 側が解決するので、
//! noobDB は秘密情報を一切扱わない (保存するのは踏み台のインスタンス ID・リージョン・
//! AWS プロファイル名のみ)。
//!
//! 外部プロセスは Rust の `tokio::process` から起動するため Tauri capabilities の追加は不要。
//! 引数はシェルを介さず 1 つずつ渡し、さらに `target` / `host` / `region` / `profile` は
//! 形式を検証する (インジェクション防止)。

use std::net::Ipv4Addr;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::net::TcpListener;
use tokio::process::{Child, Command};
use tokio::task::JoinHandle;

pub mod keepalive;

use crate::db::aws_iam;
use crate::error::{AppError, Result};

/// 起動する AWS CLI の実行ファイル名。Windows でも `Command::new("aws")` で
/// `aws.exe` が PATH から見つかる。
const AWS_PROGRAM: &str = "aws";
/// 接続先を中継する SSM ドキュメント名。
const SSM_DOCUMENT: &str = "AWS-StartPortForwardingSessionToRemoteHost";
/// 待ち受け開始のポーリング間隔。
const POLL_INTERVAL: Duration = Duration::from_millis(200);
/// エラー文言に載せる AWS CLI 出力の最大文字数 (資格情報の流出・巨大なメッセージの防止)。
const MAX_OUTPUT_CHARS: usize = 500;
/// 保持する出力の最大バイト数 (古い側を捨てる)。
const MAX_BUFFER_BYTES: usize = 4096;
/// Windows でコンソール窓を出さないためのフラグ (`CREATE_NO_WINDOW`)。
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// プロファイル / 接続要求に載る SSM ポートフォワード設定 (すべて非秘密)。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SsmConfig {
    /// 踏み台の EC2 インスタンス ID (`i-0123456789abcdef0` / マネージドノードの `mi-...`)。
    #[serde(default)]
    pub target: String,
    /// AWS リージョン。空なら DB エンドポイント名 (`*.<region>.rds.amazonaws.com`) →
    /// `AWS_REGION` / `AWS_DEFAULT_REGION` の順に推定する。
    #[serde(default)]
    pub region: String,
    /// AWS CLI の `--profile` に渡すプロファイル名。空/`None` なら AWS の既定の解決順。
    /// aws-vault の `credential_process` もここで AWS CLI が解決する。
    #[serde(default)]
    pub profile: Option<String>,
}

/// 検証・リージョン解決済みの、トンネルを張り直せるだけの情報 (非秘密)。
/// セッションに保持し、再接続で同じ経路を張り直すのに使う。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SsmTunnelSpec {
    pub target: String,
    /// 推定できなかったときは `None` (`--region` を付けず AWS CLI のプロファイル設定に任せる)。
    pub region: Option<String>,
    pub profile: Option<String>,
    /// 中継先 (本来の RDS エンドポイント名)。
    pub remote_host: String,
    pub remote_port: u16,
}

// ── 純ロジック: 検証・引数組み立て ─────────────────────────────────────

/// インスタンス ID の形式 (`i-` / `mi-` + 8〜17 桁の小文字 16 進) を検証する。
pub fn validate_target(target: &str) -> Result<()> {
    let hex = target
        .strip_prefix("mi-")
        .or_else(|| target.strip_prefix("i-"));
    let ok = hex.is_some_and(|h| {
        (8..=17).contains(&h.len()) && h.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f'))
    });
    if ok {
        Ok(())
    } else {
        Err(AppError::InvalidInput(format!(
            "invalid SSM target instance ID (expected i-... or mi-... followed by hex digits): {target}"
        )))
    }
}

/// 中継先ホストがホスト名 (または IPv4) として妥当な文字だけか検証する。
/// `--parameters` はカンマ区切りの `key=value` なので `,` `=` 空白なども弾く。
pub fn validate_host(host: &str) -> Result<()> {
    let ok = !host.is_empty()
        && host.len() <= 253
        && !host.starts_with(['-', '.'])
        && host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'));
    if ok {
        Ok(())
    } else {
        Err(AppError::InvalidInput(format!(
            "invalid host for SSM port forwarding: {host}"
        )))
    }
}

/// リージョン名の形式 (小文字英数字とハイフン) を検証する。
fn validate_region(region: &str) -> Result<()> {
    let ok = !region.is_empty()
        && region.len() <= 32
        && !region.starts_with('-')
        && region
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if ok {
        Ok(())
    } else {
        Err(AppError::InvalidInput(format!(
            "invalid AWS region: {region}"
        )))
    }
}

/// AWS プロファイル名が、フラグと誤解されたり制御文字を含んだりしないか検証する。
fn validate_profile(profile: &str) -> Result<()> {
    let ok = !profile.is_empty()
        && profile.len() <= 128
        && !profile.starts_with('-')
        && !profile.chars().any(char::is_control);
    if ok {
        Ok(())
    } else {
        Err(AppError::InvalidInput(format!(
            "invalid AWS profile name: {profile}"
        )))
    }
}

/// 設定値の形式だけを検証する (リージョンの推定はしない)。プロファイル保存時の
/// 早期チェック用。空の `target` も不正。
pub fn validate_config(cfg: &SsmConfig) -> Result<()> {
    validate_target(cfg.target.trim())?;
    let region = cfg.region.trim();
    if !region.is_empty() {
        validate_region(region)?;
    }
    if let Some(p) = cfg
        .profile
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty())
    {
        validate_profile(p)?;
    }
    Ok(())
}

/// SSH と SSM は同時に指定できない (どちらか一方の経路で DB へ到達する)。
pub fn ensure_exclusive(has_ssh: bool, has_ssm: bool) -> Result<()> {
    if has_ssh && has_ssm {
        return Err(AppError::InvalidInput(
            "SSH tunnel and AWS SSM port forwarding cannot be used together".into(),
        ));
    }
    Ok(())
}

/// 設定と本来の DB エンドポイントから [`SsmTunnelSpec`] を作る。**ホストを 127.0.0.1 へ
/// 差し替える前**の `host` / `port` を渡すこと。
pub fn build_spec(
    cfg: &SsmConfig,
    host: &str,
    port: u16,
    env: &dyn Fn(&str) -> Option<String>,
) -> Result<SsmTunnelSpec> {
    let target = cfg.target.trim();
    validate_target(target)?;
    let host = host.trim();
    validate_host(host)?;
    if port == 0 {
        return Err(AppError::InvalidInput(
            "a port is required for SSM port forwarding".into(),
        ));
    }
    // 設定値 → エンドポイント名 → 環境変数の順で解決する。決まらなければエラーにせず
    // `--region` を付けずに起動し、AWS CLI 側 (プロファイルの region) に任せる。
    let region = match aws_iam::resolve_region(&cfg.region, host, env) {
        Ok(r) => {
            validate_region(&r)?;
            Some(r)
        }
        Err(_) => None,
    };
    let profile = cfg
        .profile
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(str::to_string);
    if let Some(p) = &profile {
        validate_profile(p)?;
    }
    Ok(SsmTunnelSpec {
        target: target.to_string(),
        region,
        profile,
        remote_host: host.to_string(),
        remote_port: port,
    })
}

/// `aws` に渡す引数列 (シェルを介さず 1 要素ずつ渡す)。
pub fn build_args(spec: &SsmTunnelSpec, local_port: u16) -> Vec<String> {
    let mut args = vec![
        "ssm".to_string(),
        "start-session".to_string(),
        "--target".to_string(),
        spec.target.clone(),
        "--document-name".to_string(),
        SSM_DOCUMENT.to_string(),
        "--parameters".to_string(),
        format!(
            "host={},portNumber={},localPortNumber={}",
            spec.remote_host, spec.remote_port, local_port
        ),
    ];
    if let Some(region) = &spec.region {
        args.push("--region".to_string());
        args.push(region.clone());
    }
    if let Some(p) = &spec.profile {
        args.push("--profile".to_string());
        args.push(p.clone());
    }
    args
}

/// 待ち受け前に AWS CLI が終了したときの、利用者向けエラー文を作る。
/// 出力は長さを切る (資格情報は通常含まれないが念のため)。
pub fn describe_failure(output: &str, exit_code: Option<i32>) -> String {
    let lower = output.to_ascii_lowercase();
    if lower.contains("sessionmanagerplugin is not found")
        || lower.contains("session-manager-plugin")
            && (lower.contains("not found") || lower.contains("not installed"))
    {
        return "the AWS Session Manager plugin (session-manager-plugin) is not installed; \
                install it and make sure it is on PATH"
            .to_string();
    }
    let trimmed = output.trim();
    let code = exit_code.map_or_else(|| "unknown".to_string(), |c| c.to_string());
    if trimmed.is_empty() {
        return format!("aws ssm start-session exited with status {code}");
    }
    format!(
        "aws ssm start-session failed (status {code}): {}",
        tail_chars(trimmed, MAX_OUTPUT_CHARS)
    )
}

/// 末尾側 `max` 文字だけを残す (エラーは出力の最後に出ることが多い)。
fn tail_chars(s: &str, max: usize) -> String {
    let count = s.chars().count();
    if count <= max {
        return s.to_string();
    }
    let tail: String = s.chars().skip(count - max).collect();
    format!("...{tail}")
}

// ── トンネル本体 ────────────────────────────────────────────────────

/// 子プロセスの出力の共有バッファ。
#[derive(Default)]
struct Output {
    text: String,
    /// stdout に待ち受け開始の行が出た。
    ready: bool,
}

/// stdout の 1 行が「ローカルの待ち受け開始」を示すか。session-manager-plugin は
/// `Port <local_port> opened for sessionId ...` と `Waiting for connections...` を出す。
/// TCP 接続での疎通確認は使わない (別プロセスが同じポートを奪っていた場合に DB の
/// 認証情報を渡してしまう恐れと、RDS 側に余計な接続を作る副作用があるため)。
pub fn is_ready_line(line: &str, local_port: u16) -> bool {
    line.contains("Waiting for connections") || line.contains(&format!("Port {local_port} opened"))
}

fn push_output(shared: &Mutex<Output>, line: &str, ready_port: Option<u16>) {
    let mut o = shared.lock().unwrap_or_else(|e| e.into_inner());
    if ready_port.is_some_and(|port| is_ready_line(line, port)) {
        o.ready = true;
    }
    o.text.push_str(line);
    o.text.push('\n');
    if o.text.len() > MAX_BUFFER_BYTES {
        let mut cut = o.text.len() - MAX_BUFFER_BYTES;
        while !o.text.is_char_boundary(cut) {
            cut += 1;
        }
        o.text.drain(..cut);
    }
}

/// 出力を読み続けるタスクを起動する。読み捨てないとパイプが詰まり子プロセスが止まるため、
/// 接続後も Drop まで走らせる。
/// `ready_port` は stdout 側だけ `Some` にする (待ち受け開始の判定は stdout のみ)。
fn spawn_reader<R>(reader: R, shared: Arc<Mutex<Output>>, ready_port: Option<u16>) -> JoinHandle<()>
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut lines = BufReader::new(reader).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            push_output(&shared, &line, ready_port);
        }
    })
}

/// 生きている間 SSM ポートフォワードを保つガード。Drop で子プロセスを終了させる。
pub struct SsmTunnel {
    /// DB 接続先として使うローカルポート (`127.0.0.1:<local_port>`)。
    pub local_port: u16,
    spec: SsmTunnelSpec,
    child: Mutex<Child>,
    readers: Vec<JoinHandle<()>>,
    /// 子のプロセスグループ ID (unix)。Drop で孫 (session-manager-plugin) ごと止める。
    #[cfg(unix)]
    pgid: Option<u32>,
    /// Windows: 子を入れたジョブ。ハンドルを閉じる (Drop・アプリ終了・クラッシュ) と
    /// OS がプロセスツリーごと終了させる。作れなかったときは `kill_on_drop` だけが頼り。
    #[cfg(windows)]
    _job: Option<job::KillOnCloseJob>,
}

impl SsmTunnel {
    /// `aws` を PATH から探してトンネルを張る。待ち受けが始まるまで戻らない
    /// (全体の期限は呼び出し側の接続タイムアウトに従う)。
    pub async fn open(spec: &SsmTunnelSpec) -> Result<Self> {
        Self::open_with_program(AWS_PROGRAM, spec).await
    }

    /// 実行ファイルを差し替えられる `open` (テスト用)。
    pub async fn open_with_program(program: &str, spec: &SsmTunnelSpec) -> Result<Self> {
        let local_port = pick_free_port().await?;
        let mut cmd = Command::new(program);
        cmd.args(build_args(spec, local_port))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);
        // 専用のプロセスグループで起動し、Drop でグループごと止められるようにする。
        #[cfg(unix)]
        cmd.process_group(0);
        let mut child = cmd.spawn().map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                AppError::Other(
                    "AWS CLI was not found; install the AWS CLI (aws) and make sure it is on PATH"
                        .into(),
                )
            } else {
                AppError::Other(format!("failed to start the AWS CLI: {e}"))
            }
        })?;

        #[cfg(unix)]
        let pgid = child.id();
        #[cfg(windows)]
        let job = child
            .raw_handle()
            .and_then(|h| match job::KillOnCloseJob::assign(h) {
                Ok(j) => Some(j),
                Err(e) => {
                    tracing::warn!(error = %e, "failed to put the AWS CLI into a job object");
                    None
                }
            });

        let shared = Arc::new(Mutex::new(Output::default()));
        let mut readers = Vec::new();
        if let Some(out) = child.stdout.take() {
            readers.push(spawn_reader(out, shared.clone(), Some(local_port)));
        }
        if let Some(err) = child.stderr.take() {
            readers.push(spawn_reader(err, shared.clone(), None));
        }
        // 失敗時は `child` / `readers` を落とせば子プロセスは kill_on_drop で終わる。
        let guard = Self {
            local_port,
            spec: spec.clone(),
            child: Mutex::new(child),
            readers,
            #[cfg(unix)]
            pgid,
            #[cfg(windows)]
            _job: job,
        };
        guard.wait_until_listening(&shared).await?;
        Ok(guard)
    }

    /// ローカルの待ち受け開始まで 200ms 間隔でポーリングする。stdout の
    /// `Port <local_port> opened` / `Waiting for connections` で開始とみなし、
    /// その前に子プロセスが終了したら出力を読んでエラーにする。
    async fn wait_until_listening(&self, shared: &Arc<Mutex<Output>>) -> Result<()> {
        loop {
            if let Some(status) = self.try_exit_status() {
                // 出力を読むタスクが残りを取り込む猶予を与える。
                tokio::time::sleep(Duration::from_millis(100)).await;
                let text = shared
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .text
                    .clone();
                return Err(AppError::Other(describe_failure(&text, status)));
            }
            let ready = shared.lock().unwrap_or_else(|e| e.into_inner()).ready;
            if ready {
                return Ok(());
            }
            tokio::time::sleep(POLL_INTERVAL).await;
        }
    }

    /// 子が終了していれば `Some(終了コード)` (シグナル終了などコード無しは `Some(None)`)。
    fn try_exit_status(&self) -> Option<Option<i32>> {
        let mut child = self.child.lock().unwrap_or_else(|e| e.into_inner());
        match child.try_wait() {
            Ok(Some(status)) => Some(status.code()),
            Ok(None) => None,
            // 状態を取得できないときは終了扱いにして、待ち続けないようにする。
            Err(_) => Some(None),
        }
    }

    /// 非秘密の接続情報 (再接続で同じ経路を張り直すのに使う)。
    pub fn spec(&self) -> &SsmTunnelSpec {
        &self.spec
    }

    /// 子プロセスがまだ終了していないか (ネットワークには触れない)。
    pub fn is_alive(&self) -> bool {
        self.try_exit_status().is_none()
    }
}

impl Drop for SsmTunnel {
    fn drop(&mut self) {
        for r in &self.readers {
            r.abort();
        }
        // 子がまだ動いている間だけプロセスグループへ SIGTERM を送る。終了・回収済みの
        // pgid は別プロセスに再利用されうるので、その場合は何もしない。
        #[cfg(unix)]
        if let Some(pgid) = self.pgid {
            if self.try_exit_status().is_none() {
                terminate_group(pgid);
            }
        }
        // kill_on_drop(true) でも落ちるが、Drop の時点で確実に終了要求を出しておく。
        let _ = self
            .child
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .start_kill();
    }
}

/// プロセスグループ全体へ SIGTERM を送る。`libc` クレートを増やさないため
/// `killpg(3)` を直接 `extern "C"` 宣言する (`commands/local.rs` と同じ流儀)。
#[cfg(unix)]
fn terminate_group(pgid: u32) {
    extern "C" {
        fn killpg(pgrp: i32, sig: i32) -> i32;
    }
    const SIGTERM: i32 = 15;
    let Ok(pgid) = i32::try_from(pgid) else {
        return;
    };
    // pgid <= 1 は自プロセスのグループ等を巻き込みうるので送らない。
    if pgid <= 1 {
        return;
    }
    // SAFETY: `killpg` は整数 2 つを取る syscall ラッパーで、メモリを触らない。pgid は
    // 自分が `process_group(0)` で作ったグループの ID (子が生存中のみ呼ぶ)。失敗は無視してよい。
    let _ = unsafe { killpg(pgid, SIGTERM) };
}

/// Windows の Job Object (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`)。
#[cfg(windows)]
mod job {
    use std::io;
    use std::mem::{size_of, zeroed};
    use std::os::windows::io::{FromRawHandle, OwnedHandle, RawHandle};

    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    /// 閉じる (Drop) と、ジョブ内の全プロセスを OS が終了させるハンドル。
    /// 中身は読まず、Drop でハンドルが閉じられること自体が目的。
    pub struct KillOnCloseJob(#[allow(dead_code)] OwnedHandle);

    impl KillOnCloseJob {
        /// 新しいジョブを作り、`process` (子プロセスのハンドル) を入れる。
        pub fn assign(process: RawHandle) -> io::Result<Self> {
            // SAFETY: 属性・名前とも null (既定のセキュリティ記述子・無名ジョブ)。
            let raw: HANDLE = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if raw.is_null() {
                return Err(io::Error::last_os_error());
            }
            // SAFETY: `raw` は直前に作った有効なハンドルで、所有権をここで `OwnedHandle` に移す
            // (以降の失敗経路でも Drop で必ず閉じられる)。
            let owned = unsafe { OwnedHandle::from_raw_handle(raw as RawHandle) };

            // SAFETY: 全ビット 0 は JOBOBJECT_EXTENDED_LIMIT_INFORMATION (POD) の有効な値。
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            // SAFETY: `raw` は有効なジョブハンドル。`info` は宣言した情報クラスに対応する型で、
            // 渡すサイズもその型のサイズ。呼び出しの間 `info` は生きている。
            let ok = unsafe {
                SetInformationJobObject(
                    raw,
                    JobObjectExtendedLimitInformation,
                    std::ptr::addr_of!(info).cast(),
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            };
            if ok == 0 {
                return Err(io::Error::last_os_error());
            }
            // SAFETY: `process` は呼び出し元 (tokio の `Child`) が保持する有効なプロセスハンドル。
            let ok = unsafe { AssignProcessToJobObject(raw, process as HANDLE) };
            if ok == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(Self(owned))
        }
    }
}

/// 空きローカルポートを 1 つ選ぶ (bind して番号を得てから閉じる)。
async fn pick_free_port() -> Result<u16> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok(port)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn no_env(_: &str) -> Option<String> {
        None
    }

    fn cfg(target: &str, region: &str, profile: Option<&str>) -> SsmConfig {
        SsmConfig {
            target: target.into(),
            region: region.into(),
            profile: profile.map(str::to_string),
        }
    }

    const HOST: &str = "mydb.abc123.ap-northeast-1.rds.amazonaws.com";

    #[test]
    fn target_accepts_instance_and_managed_node_ids() {
        assert!(validate_target("i-0123456789abcdef0").is_ok());
        assert!(validate_target("i-0123abcd").is_ok());
        assert!(validate_target("mi-0123456789abcdef0").is_ok());
    }

    #[test]
    fn target_rejects_malformed_ids() {
        for bad in [
            "",
            "i-",
            "i-xyz",
            "I-0123456789abcdef0",
            "i-0123456789abcdef0 --foo",
            "i-0123456789abcdef0;ls",
            "--target",
            "ec2-0123456789",
            "i-0123abc",
            "i-0123456789abcdef01",
        ] {
            assert!(validate_target(bad).is_err(), "{bad:?} should be rejected");
        }
    }

    #[test]
    fn host_rejects_injection_characters() {
        assert!(validate_host(HOST).is_ok());
        assert!(validate_host("10.0.0.5").is_ok());
        assert!(validate_host("db_1.internal").is_ok());
        for bad in [
            "",
            "-host",
            ".host",
            "a,portNumber=1",
            "a=b",
            "a b",
            "a;b",
            "a$(x)",
            "a/b",
        ] {
            assert!(validate_host(bad).is_err(), "{bad:?} should be rejected");
        }
    }

    #[test]
    fn spec_infers_region_from_the_endpoint_then_env() {
        let spec = build_spec(&cfg("i-0123456789abcdef0", "", None), HOST, 3306, &no_env).unwrap();
        assert_eq!(spec.region.as_deref(), Some("ap-northeast-1"));
        assert_eq!(spec.remote_host, HOST);
        assert_eq!(spec.remote_port, 3306);

        let env = |k: &str| (k == "AWS_REGION").then(|| "eu-west-1".to_string());
        let spec = build_spec(
            &cfg("i-0123456789abcdef0", "", None),
            "db.internal",
            5432,
            &env,
        )
        .unwrap();
        assert_eq!(spec.region.as_deref(), Some("eu-west-1"));
    }

    #[test]
    fn spec_prefers_the_configured_region_and_trims() {
        let spec = build_spec(
            &cfg(" i-0123456789abcdef0 ", " us-west-2 ", Some(" work ")),
            HOST,
            3306,
            &no_env,
        )
        .unwrap();
        assert_eq!(spec.target, "i-0123456789abcdef0");
        assert_eq!(spec.region.as_deref(), Some("us-west-2"));
        assert_eq!(spec.profile.as_deref(), Some("work"));
    }

    #[test]
    fn spec_leaves_region_unset_when_unknown_and_rejects_invalid_inputs() {
        let c = cfg("i-0123456789abcdef0", "", None);
        // 推定できなければエラーにせず None (AWS CLI のプロファイル設定に任せる)。
        let spec = build_spec(&c, "db.internal", 3306, &no_env).unwrap();
        assert_eq!(spec.region, None);
        assert!(!build_args(&spec, 1).iter().any(|a| a == "--region"));
        assert!(build_spec(&c, HOST, 0, &no_env).is_err());
        assert!(build_spec(&cfg("bogus", "", None), HOST, 3306, &no_env).is_err());
        assert!(build_spec(
            &cfg("i-0123456789abcdef0", "US WEST", None),
            HOST,
            3306,
            &no_env
        )
        .is_err());
        assert!(build_spec(
            &cfg("i-0123456789abcdef0", "", Some("--debug")),
            HOST,
            3306,
            &no_env
        )
        .is_err());
        // 空白だけのプロファイルは未指定として扱う。
        let spec = build_spec(
            &cfg("i-0123456789abcdef0", "", Some("  ")),
            HOST,
            3306,
            &no_env,
        )
        .unwrap();
        assert_eq!(spec.profile, None);
    }

    #[test]
    fn args_are_built_as_separate_elements() {
        let spec = build_spec(
            &cfg("i-0123456789abcdef0", "", Some("work")),
            HOST,
            3306,
            &no_env,
        )
        .unwrap();
        let args = build_args(&spec, 54321);
        assert_eq!(
            args,
            vec![
                "ssm",
                "start-session",
                "--target",
                "i-0123456789abcdef0",
                "--document-name",
                "AWS-StartPortForwardingSessionToRemoteHost",
                "--parameters",
                &format!("host={HOST},portNumber=3306,localPortNumber=54321"),
                "--region",
                "ap-northeast-1",
                "--profile",
                "work",
            ]
        );
        let no_profile = SsmTunnelSpec {
            profile: None,
            ..spec
        };
        assert!(!build_args(&no_profile, 1).iter().any(|a| a == "--profile"));
    }

    #[test]
    fn ssh_and_ssm_are_mutually_exclusive() {
        assert!(ensure_exclusive(true, true).is_err());
        assert!(ensure_exclusive(true, false).is_ok());
        assert!(ensure_exclusive(false, true).is_ok());
        assert!(ensure_exclusive(false, false).is_ok());
    }

    #[test]
    fn failure_messages_are_actionable_and_bounded() {
        let m = describe_failure(
            "SessionManagerPlugin is not found. Please refer to SessionManager Documentation",
            Some(255),
        );
        assert!(m.contains("session-manager-plugin"), "{m}");

        let long = "x".repeat(5000);
        let m = describe_failure(&long, Some(1));
        assert!(m.chars().count() < MAX_OUTPUT_CHARS + 100, "{}", m.len());
        assert!(m.contains("status 1"));

        let m = describe_failure("  ", None);
        assert!(m.contains("unknown"));
    }

    #[test]
    fn config_serde_defaults_and_roundtrip() {
        let c: SsmConfig = serde_json::from_str(r#"{"target":"i-0123456789abcdef0"}"#).unwrap();
        assert_eq!(c.region, "");
        assert_eq!(c.profile, None);
        let back: SsmConfig = serde_json::from_str(&serde_json::to_string(&c).unwrap()).unwrap();
        assert_eq!(back, c);
    }

    #[test]
    fn config_validation_checks_format_only() {
        assert!(validate_config(&cfg("i-0123456789abcdef0", "", None)).is_ok());
        assert!(validate_config(&cfg("", "", None)).is_err());
        assert!(validate_config(&cfg("i-0123456789abcdef0", "Bad Region", None)).is_err());
    }

    #[tokio::test]
    async fn missing_aws_cli_reports_not_found() {
        let spec = build_spec(&cfg("i-0123456789abcdef0", "", None), HOST, 3306, &no_env).unwrap();
        let err = match SsmTunnel::open_with_program("noobdb-no-such-aws-cli-binary", &spec).await {
            Ok(_) => panic!("must fail"),
            Err(e) => e,
        };
        assert!(err.to_string().contains("AWS CLI was not found"), "{err}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn child_exiting_before_listening_surfaces_its_output() {
        let spec = build_spec(&cfg("i-0123456789abcdef0", "", None), HOST, 3306, &no_env).unwrap();
        // `false` は即終了する (出力なし) ので、終了コード付きのエラーになる。
        let err = match SsmTunnel::open_with_program("false", &spec).await {
            Ok(_) => panic!("must fail"),
            Err(e) => e,
        };
        assert!(err.to_string().contains("exited with status 1"), "{err}");
    }

    #[test]
    fn ready_lines_are_recognized_for_this_port_only() {
        assert!(is_ready_line("Waiting for connections...", 1));
        assert!(is_ready_line("Port 54321 opened for sessionId abc.", 54321));
        assert!(!is_ready_line(
            "Port 54322 opened for sessionId abc.",
            54321
        ));
        assert!(!is_ready_line(
            "Starting session with SessionId: abc",
            54321
        ));
    }

    /// 偽の `aws` スクリプトによるライフサイクルテスト (Linux)。
    #[cfg(target_os = "linux")]
    mod lifecycle {
        use super::*;
        use std::os::unix::fs::PermissionsExt;
        use std::path::{Path, PathBuf};

        /// 一時ディレクトリに置いた偽 `aws`。起動すると自身と孫 (`sleep &`) の PID を
        /// ファイルへ書く。`ready` なら session-manager-plugin と同じ行を stdout に出す。
        struct FakeAws {
            dir: PathBuf,
            script: PathBuf,
        }

        impl FakeAws {
            fn new(tag: &str, ready: bool) -> Self {
                let dir = std::env::temp_dir().join(format!(
                    "noobdb-fake-aws-{tag}-{}-{}",
                    std::process::id(),
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map_or(0, |d| d.as_nanos())
                ));
                std::fs::create_dir_all(&dir).unwrap();
                let announce = if ready {
                    "echo \"Starting session with SessionId: x\"\n\
                     echo \"Port $p opened for sessionId x.\"\n\
                     echo \"Waiting for connections...\"\n"
                } else {
                    ""
                };
                let body = format!(
                    "#!/bin/sh\n\
                     d=$(dirname \"$0\")\n\
                     for a in \"$@\"; do case \"$a\" in *localPortNumber=*) p=${{a##*localPortNumber=}};; esac; done\n\
                     echo $$ > \"$d/self.pid\"\n\
                     sleep 300 &\n\
                     echo $! > \"$d/child.pid\"\n\
                     {announce}\
                     wait\n"
                );
                let script = dir.join("aws");
                std::fs::write(&script, body).unwrap();
                std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
                Self { dir, script }
            }

            fn pid(&self, name: &str) -> i32 {
                std::fs::read_to_string(self.dir.join(name))
                    .unwrap()
                    .trim()
                    .parse()
                    .unwrap()
            }
        }

        impl Drop for FakeAws {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.dir);
            }
        }

        /// プロセスが消えた (または回収待ちのゾンビ) か。
        fn is_gone(pid: i32) -> bool {
            match std::fs::read_to_string(Path::new("/proc").join(pid.to_string()).join("stat")) {
                Err(_) => true,
                // `pid (comm) S ...` — comm は括弧を含みうるので最後の ')' の後ろを見る。
                Ok(stat) => stat
                    .rsplit_once(')')
                    .is_some_and(|(_, rest)| rest.trim_start().starts_with('Z')),
            }
        }

        async fn wait_gone(pid: i32) -> bool {
            for _ in 0..50 {
                if is_gone(pid) {
                    return true;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            false
        }

        fn spec() -> SsmTunnelSpec {
            build_spec(&cfg("i-0123456789abcdef0", "", None), HOST, 3306, &no_env).unwrap()
        }

        #[tokio::test]
        async fn drop_terminates_the_child_and_its_process_group() {
            let fake = FakeAws::new("ok", true);
            let program = fake.script.to_string_lossy().into_owned();
            let tunnel = tokio::time::timeout(
                Duration::from_secs(10),
                SsmTunnel::open_with_program(&program, &spec()),
            )
            .await
            .expect("must not time out")
            .expect("must open");
            assert!(tunnel.is_alive());
            assert!(tunnel.local_port > 0);
            let (own, grandchild) = (fake.pid("self.pid"), fake.pid("child.pid"));
            assert!(!is_gone(own) && !is_gone(grandchild));

            drop(tunnel);
            assert!(wait_gone(own).await, "child must be gone after drop");
            assert!(
                wait_gone(grandchild).await,
                "grandchild must be gone after drop"
            );
        }

        #[tokio::test]
        async fn cancelling_a_pending_open_stops_the_child() {
            // 待ち受け開始の行を出さない偽 aws。タイムアウトで open の future が捨てられる。
            let fake = FakeAws::new("pending", false);
            let program = fake.script.to_string_lossy().into_owned();
            let res = tokio::time::timeout(
                Duration::from_secs(1),
                SsmTunnel::open_with_program(&program, &spec()),
            )
            .await;
            assert!(res.is_err(), "open must still be waiting");
            let (own, grandchild) = (fake.pid("self.pid"), fake.pid("child.pid"));
            assert!(wait_gone(own).await, "child must be stopped on cancel");
            assert!(
                wait_gone(grandchild).await,
                "grandchild must be stopped on cancel"
            );
        }
    }
}
