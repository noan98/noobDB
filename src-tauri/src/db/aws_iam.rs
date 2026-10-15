//! AWS RDS / Aurora の IAM データベース認証 (#734)。
//!
//! 静的パスワードの代わりに、有効期限 15 分の **RDS 認証トークン** (= `rds-db`
//! サービス向け `connect` アクションの SigV4 署名付き URL から `https://` を
//! 除いた文字列) を DB パスワードとして渡す。トークン生成は AWS の API 呼び出しを
//! 伴わない**ローカルの署名計算だけ**なので、`aws-config` / `aws-sdk-rds` のような
//! 重い SDK は入れず、SigV4 (AWS4-HMAC-SHA256) の presign を自前で実装している
//! (依存は既に推移的に入っている `sha2` のみ)。
//!
//! 参照した一次資料:
//! - RDS IAM データベース認証:
//!   <https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.IAMDBAuth.html>
//! - 認証トークンの生成 (`aws rds generate-db-auth-token`):
//!   <https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.IAMDBAuth.Connecting.html>
//!   <https://docs.aws.amazon.com/cli/latest/reference/rds/generate-db-auth-token.html>
//! - SigV4 のクエリ文字列署名 (presigned URL):
//!   <https://docs.aws.amazon.com/IAM/latest/UserGuide/create-signed-request.html>
//!   <https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html>
//! - 資格情報ファイルと環境変数:
//!   <https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-files.html>
//!   <https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-envvars.html>
//!
//! 単体テストの期待値は AWS 公式 SDK のテストベクタ (smithy-rs
//! `aws-inlineable/src/rds_auth_token.rs` の `signing_works`、botocore
//! `tests/unit/test_signers.py` の `TestGenerateDBAuthToken`) と、SigV4 ドキュメントの
//! 署名鍵導出例 / S3 presigned URL 例をそのまま使っている。
//!
//! ## 秘密の扱い
//!
//! アクセスキー等の AWS 資格情報は **noobDB のストレージ (profiles.json / keyring)
//! に一切保存しない**。接続のたびに AWS 標準の置き場所 (環境変数 / 共有資格情報
//! ファイル) から読み、トークンを作ったら捨てる。プロファイルに残るのはリージョンと
//! AWS プロファイル名 (非秘密) だけ。生成したトークンもセッションの
//! `DbConnectOptions.password` には入れず (空のまま)、ログにも出さない。
//!
//! ## 対応する資格情報ソース
//!
//! 1. プロファイル名を明示した場合は、その名前のプロファイル (静的キー → `credential_process`
//!    の順で、静的キーがあればそれを優先)。AWS CLI の `--profile` と同じく環境変数の
//!    キーより優先。
//! 2. 明示しない場合は環境変数 `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`
//!    (+ 任意の `AWS_SESSION_TOKEN`)。
//! 3. それも無ければ `AWS_PROFILE` (未設定なら `default`) のプロファイル (1. と同様)。
//!
//! 共有資格情報ファイルは `AWS_SHARED_CREDENTIALS_FILE` (既定 `~/.aws/credentials`)、
//! 設定ファイルは `AWS_CONFIG_FILE` (既定 `~/.aws/config`)。
//!
//! ## `credential_process` (#1682、aws-vault 連携)
//!
//! プロファイルに `credential_process = aws-vault export --format=json <profile>` の
//! ようなコマンドがあれば、それを**シェルを介さず**実行し、標準出力の JSON
//! (`Version: 1` / `AccessKeyId` / `SecretAccessKey` / `SessionToken` / `Expiration`) から
//! 一時キーを受け取る (AWS CLI と同じ仕様)。結果は `Expiration` の 5 分前までプロセス内の
//! メモリだけにキャッシュし、10 分ごとのトークン更新のたびに外部コマンドを起動しない
//! (`Expiration` が無いときも 5 分だけ)。ディスクには保存しない。標準出力 (= 秘密) と
//! 標準エラーはログにもエラー文にも出さない。
//!
//! **IAM Identity Center (SSO)・`role_arn` による AssumeRole・EC2/ECS のメタデータ
//! エンドポイントは範囲外** (AWS API 呼び出しが要るため)。それらのプロファイルを
//! 指定した場合は `aws configure export-credentials` で一時キーを環境変数へ書き出す
//! 手順をエラーで案内する。

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::SslMode;
use crate::error::{AppError, Result};

/// 署名付きトークンの有効期限 (秒)。RDS の IAM 認証トークンは 15 分が上限。
pub const TOKEN_TTL_SECS: u64 = 900;

/// プールの接続オプションに載せたトークンを作り直す間隔。15 分で失効するため、
/// それより十分短い 10 分ごとに差し替え、プールが新しい物理接続を張るときに
/// 常に有効なトークンが使われるようにする。
pub const TOKEN_REFRESH_INTERVAL: Duration = Duration::from_secs(10 * 60);

/// SigV4 のサービス名 (RDS IAM 認証専用)。
const SERVICE: &str = "rds-db";
const ALGORITHM: &str = "AWS4-HMAC-SHA256";

/// プロファイル / 接続要求に載る IAM 認証設定 (非秘密)。`Some` のとき
/// 認証方式が `aws_iam`、`None` のとき従来のパスワード認証。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AwsIamConfig {
    /// AWS リージョン (例: `ap-northeast-1`)。空ならエンドポイント名
    /// (`*.<region>.rds.amazonaws.com`) → `AWS_REGION` / `AWS_DEFAULT_REGION`
    /// の順に推定する。
    #[serde(default)]
    pub region: String,
    /// `~/.aws/credentials` / `~/.aws/config` のプロファイル名。空/`None` なら
    /// AWS の既定の解決順 (環境変数 → `AWS_PROFILE` → `default`)。
    #[serde(default)]
    pub profile: Option<String>,
}

/// ドライバ層へ渡す、解決済みの IAM 認証パラメータ (非秘密)。
///
/// `endpoint_host` / `endpoint_port` は**SSH トンネルで 127.0.0.1 へ差し替える前の
/// 本来の RDS エンドポイント**。トークンはこのホスト名で署名しないと RDS 側の
/// 検証に失敗するため、`DbConnectOptions.host` (トンネル後の接続先) とは別に持つ。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AwsIamOptions {
    pub region: String,
    #[serde(default)]
    pub profile: Option<String>,
    pub endpoint_host: String,
    pub endpoint_port: u16,
}

/// AWS の資格情報。`Debug` は秘密を伏せる (ログ・エラーへの混入防止)。
#[derive(Clone, PartialEq, Eq)]
pub struct AwsCredentials {
    pub access_key_id: String,
    pub secret_access_key: String,
    pub session_token: Option<String>,
}

impl std::fmt::Debug for AwsCredentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AwsCredentials")
            .field("access_key_id", &"<redacted>")
            .field("secret_access_key", &"<redacted>")
            .field(
                "session_token",
                &self.session_token.as_ref().map(|_| "<redacted>"),
            )
            .finish()
    }
}

// ── 純ロジック: 設定の解決 ──────────────────────────────────────────────

/// IAM 認証は TLS 必須 (RDS の要件)。`None` / `disable` / `prefer` は平文へ
/// フォールバックしうるため `require` へ引き上げ、`require` 以上はそのまま。
/// UI (`awsIam.ts` の `effectiveSslModeForIam`) と同じ規則で、共有ゴールデン
/// (`src/__tests__/fixtures/awsIamGolden.json`) で両実装を固定している。
pub fn enforce_tls(mode: Option<SslMode>) -> SslMode {
    match mode {
        None | Some(SslMode::Disable) | Some(SslMode::Prefer) => SslMode::Require,
        Some(m) => m,
    }
}

/// RDS / Aurora / RDS Proxy のエンドポイント名からリージョンを推定する。
/// `<name>.<id>.<region>.rds.amazonaws.com` (中国リージョンは `.com.cn`) の
/// `rds` 直前のラベルを返す。該当しなければ `None`。
pub fn infer_region_from_host(host: &str) -> Option<String> {
    let host = host.trim().trim_end_matches('.').to_ascii_lowercase();
    let labels: Vec<&str> = host.split('.').collect();
    let rds = labels.iter().rposition(|l| *l == "rds")?;
    let suffix = &labels[rds + 1..];
    if suffix != ["amazonaws", "com"] && suffix != ["amazonaws", "com", "cn"] {
        return None;
    }
    // `<region>.rds...` の前に少なくとも 1 ラベル (インスタンス名) が要る。
    if rds < 2 {
        return None;
    }
    let region = labels[rds - 1];
    is_region_like(region).then(|| region.to_string())
}

/// `us-east-1` / `ap-northeast-1` / `us-gov-west-1` のような形か。
fn is_region_like(s: &str) -> bool {
    !s.is_empty()
        && s.contains('-')
        && s.chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && s.chars().last().is_some_and(|c| c.is_ascii_digit())
}

/// 設定・エンドポイント名・環境変数からリージョンを決める。
pub fn resolve_region(
    configured: &str,
    host: &str,
    env: &dyn Fn(&str) -> Option<String>,
) -> Result<String> {
    let configured = configured.trim();
    if !configured.is_empty() {
        return Ok(configured.to_string());
    }
    if let Some(r) = infer_region_from_host(host) {
        return Ok(r);
    }
    for key in ["AWS_REGION", "AWS_DEFAULT_REGION"] {
        if let Some(v) = env(key).map(|v| v.trim().to_string()) {
            if !v.is_empty() {
                return Ok(v);
            }
        }
    }
    Err(AppError::InvalidInput(
        "AWS IAM authentication needs an AWS region (set it in the connection form, \
         or use an *.<region>.rds.amazonaws.com endpoint, or set AWS_REGION)"
            .into(),
    ))
}

/// 接続要求 (IAM 設定 + 本来のエンドポイント) からドライバ層へ渡す
/// [`AwsIamOptions`] を組み立てる。**SSH トンネルでホストを差し替える前**に
/// 呼ぶこと (署名に使うのは本来の RDS エンドポイント名)。
pub fn build_options(
    config: &AwsIamConfig,
    endpoint_host: &str,
    endpoint_port: u16,
    env: &dyn Fn(&str) -> Option<String>,
) -> Result<AwsIamOptions> {
    let endpoint_host = endpoint_host.trim();
    if endpoint_host.is_empty() {
        return Err(AppError::InvalidInput(
            "AWS IAM authentication needs the RDS endpoint host name".into(),
        ));
    }
    let region = resolve_region(&config.region, endpoint_host, env)?;
    Ok(AwsIamOptions {
        region,
        profile: config
            .profile
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        endpoint_host: endpoint_host.to_string(),
        endpoint_port,
    })
}

// ── 純ロジック: SigV4 presign ───────────────────────────────────────────

/// SigV4 の URI エンコード。非予約文字 (`A-Z a-z 0-9 - _ . ~`) 以外を UTF-8 の
/// バイト単位で `%XX` (大文字 16 進) にする。`/` もエンコードする (クエリ値用)。
fn uri_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn sha256_hex(data: &[u8]) -> String {
    data_encoding::HEXLOWER.encode(&Sha256::digest(data))
}

/// HMAC-SHA256 (RFC 2104)。SHA-256 のブロック長は 64 バイト。
fn hmac_sha256(key: &[u8], data: &[u8]) -> [u8; 32] {
    const BLOCK: usize = 64;
    let mut k = [0u8; BLOCK];
    if key.len() > BLOCK {
        k[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        k[..key.len()].copy_from_slice(key);
    }
    let mut ipad = [0x36u8; BLOCK];
    let mut opad = [0x5cu8; BLOCK];
    for i in 0..BLOCK {
        ipad[i] ^= k[i];
        opad[i] ^= k[i];
    }
    let mut inner = Sha256::new();
    inner.update(ipad);
    inner.update(data);
    let inner = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(opad);
    outer.update(inner);
    outer.finalize().into()
}

/// SigV4 の署名鍵: `HMAC(HMAC(HMAC(HMAC("AWS4"+secret, date), region), service), "aws4_request")`。
fn signing_key(secret: &str, date: &str, region: &str, service: &str) -> [u8; 32] {
    let k_date = hmac_sha256(format!("AWS4{secret}").as_bytes(), date.as_bytes());
    let k_region = hmac_sha256(&k_date, region.as_bytes());
    let k_service = hmac_sha256(&k_region, service.as_bytes());
    hmac_sha256(&k_service, b"aws4_request")
}

/// GET リクエストをクエリ文字列方式 (presigned URL) で SigV4 署名する汎用部。
/// `params` は署名前のクエリパラメータ (未エンコード)。戻り値は
/// `(正規化済みクエリ文字列, 署名)`。`X-Amz-*` の署名パラメータは呼び出し側が
/// `params` に含めておく。
fn presign_get(
    host_header: &str,
    path: &str,
    params: &[(&str, &str)],
    payload_hash: &str,
    amz_date: &str,
    scope: &str,
    key: &[u8; 32],
) -> (String, String) {
    let mut encoded: Vec<(String, String)> = params
        .iter()
        .map(|(k, v)| (uri_encode(k), uri_encode(v)))
        .collect();
    encoded.sort();
    let canonical_query = encoded
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("&");
    let canonical_request =
        format!("GET\n{path}\n{canonical_query}\nhost:{host_header}\n\nhost\n{payload_hash}");
    let string_to_sign = format!(
        "{ALGORITHM}\n{amz_date}\n{scope}\n{}",
        sha256_hex(canonical_request.as_bytes())
    );
    let signature = data_encoding::HEXLOWER.encode(&hmac_sha256(key, string_to_sign.as_bytes()));
    (canonical_query, signature)
}

/// RDS IAM 認証トークンを生成する (純関数)。
///
/// `aws rds generate-db-auth-token --hostname H --port P --username U --region R`
/// と同じ文字列 — `H:P/?Action=connect&DBUser=U&X-Amz-Algorithm=...&X-Amz-Signature=...`
/// — を返す。`host` はトンネル前の本来のエンドポイント名を渡すこと。
pub fn generate_auth_token(
    host: &str,
    port: u16,
    user: &str,
    region: &str,
    creds: &AwsCredentials,
    now: DateTime<Utc>,
) -> String {
    // 署名対象の host ヘッダは URL の authority と同じ規則: https の既定ポート
    // (443) のときだけポートを省く (SDK が URL パーサ経由で作るのと一致させる)。
    let host = host.trim().to_ascii_lowercase();
    let host_header = if port == 443 {
        host.clone()
    } else {
        format!("{host}:{port}")
    };
    let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();
    let date = now.format("%Y%m%d").to_string();
    let scope = format!("{date}/{region}/{SERVICE}/aws4_request");
    let credential = format!("{}/{scope}", creds.access_key_id);
    let expires = TOKEN_TTL_SECS.to_string();
    let mut params: Vec<(&str, &str)> = vec![
        ("Action", "connect"),
        ("DBUser", user),
        ("X-Amz-Algorithm", ALGORITHM),
        ("X-Amz-Credential", &credential),
        ("X-Amz-Date", &amz_date),
        ("X-Amz-Expires", &expires),
        ("X-Amz-SignedHeaders", "host"),
    ];
    // 一時資格情報 (STS) のセッショントークンは署名対象のクエリに含める
    // (SDK の既定 `SessionTokenMode::Include` と同じ)。
    if let Some(token) = creds.session_token.as_deref().filter(|t| !t.is_empty()) {
        params.push(("X-Amz-Security-Token", token));
    }
    let key = signing_key(&creds.secret_access_key, &date, region, SERVICE);
    // RDS のトークンはボディを持たない GET の presign なので、ペイロードハッシュは
    // 空文字列の SHA-256。
    let (query, signature) = presign_get(
        &host_header,
        "/",
        &params,
        &sha256_hex(b""),
        &amz_date,
        &scope,
        &key,
    );
    format!("{host_header}/?{query}&X-Amz-Signature={signature}")
}

// ── 資格情報の解決 (環境変数 / 共有資格情報ファイル) ─────────────────────

/// 最小限の INI パーサ。`[section]` ごとに `key = value` を集める。`#` / `;` で
/// 始まる行はコメント。キーは小文字化して比較する (AWS CLI と同じく大小無視)。
fn parse_ini(text: &str) -> Vec<(String, Vec<(String, String)>)> {
    let mut sections: Vec<(String, Vec<(String, String)>)> = Vec::new();
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        if let Some(name) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            sections.push((name.trim().to_string(), Vec::new()));
            continue;
        }
        if let Some((k, v)) = line.split_once('=') {
            if let Some((_, entries)) = sections.last_mut() {
                entries.push((k.trim().to_ascii_lowercase(), v.trim().to_string()));
            }
        }
    }
    sections
}

/// `name` の節 (設定ファイルでは `default` 以外は `profile name`) を探す。
fn find_section<'a>(
    sections: &'a [(String, Vec<(String, String)>)],
    names: &[String],
) -> Option<&'a [(String, String)]> {
    sections
        .iter()
        .find(|(n, _)| names.iter().any(|want| want == n))
        .map(|(_, e)| e.as_slice())
}

fn get<'a>(entries: &'a [(String, String)], key: &str) -> Option<&'a str> {
    entries
        .iter()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.as_str())
        .filter(|v| !v.is_empty())
}

fn static_keys(entries: &[(String, String)]) -> Option<AwsCredentials> {
    Some(AwsCredentials {
        access_key_id: get(entries, "aws_access_key_id")?.to_string(),
        secret_access_key: get(entries, "aws_secret_access_key")?.to_string(),
        session_token: get(entries, "aws_session_token").map(str::to_string),
    })
}

// ── credential_process (#1682) ─────────────────────────────────────────

/// `credential_process` の最大待ち時間。aws-vault は MFA プロンプトで時間がかかる
/// ことがあるため長めに取る。超えたら子プロセスを kill してエラーにする。
const PROCESS_TIMEOUT: Duration = Duration::from_secs(60);

/// キャッシュを `Expiration` の何分前で無効扱いにするか。
const CACHE_EXPIRY_MARGIN_SECS: i64 = 5 * 60;

/// `Expiration` が無い出力をキャッシュする時間。
const CACHE_NO_EXPIRATION_SECS: i64 = 5 * 60;

/// 標準出力として読み込む上限。暴走したコマンドでメモリを食わないため。
const MAX_PROCESS_OUTPUT: u64 = 1024 * 1024;

/// 外部コマンドの実行結果。`stdout` は秘密なのでログ・エラー文に出さない。
/// 標準エラーは (秘密が混ざりうるため) 一切保持しない。
pub struct ProcessOutput {
    pub code: Option<i32>,
    pub success: bool,
    pub stdout: String,
}

impl std::fmt::Debug for ProcessOutput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // stdout は秘密なので出さない。
        f.debug_struct("ProcessOutput")
            .field("code", &self.code)
            .field("success", &self.success)
            .field("stdout", &"<redacted>")
            .finish()
    }
}

struct CachedCredentials {
    key: (String, String),
    creds: AwsCredentials,
    valid_until: DateTime<Utc>,
}

/// `credential_process` の結果のメモリキャッシュ (キー: プロファイル名 + コマンド文字列)。
pub struct ProcessCredentialCache(Mutex<Vec<CachedCredentials>>);

impl ProcessCredentialCache {
    pub const fn new() -> Self {
        Self(Mutex::new(Vec::new()))
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Vec<CachedCredentials>> {
        // 毒化しても中身は単なるキャッシュなので、そのまま使い続けて問題ない。
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn get(&self, key: &(String, String), now: DateTime<Utc>) -> Option<AwsCredentials> {
        self.lock()
            .iter()
            .find(|c| &c.key == key && now < c.valid_until)
            .map(|c| c.creds.clone())
    }

    fn put(&self, key: (String, String), creds: AwsCredentials, valid_until: DateTime<Utc>) {
        let mut g = self.lock();
        g.retain(|c| c.key != key && c.valid_until > Utc::now());
        g.push(CachedCredentials {
            key,
            creds,
            valid_until,
        });
    }
}

impl Default for ProcessCredentialCache {
    fn default() -> Self {
        Self::new()
    }
}

static PROCESS_CACHE: ProcessCredentialCache = ProcessCredentialCache::new();

/// コマンド文字列をシェルを介さず引数列に分割する。空白区切りで、`"..."` と `'...'`
/// でまとめられる。`"..."` 内では `\"` と `\\` だけがエスケープ。引用の外の `\` は
/// そのまま (Windows のパス区切りを壊さないため)。閉じていない引用はエラー。
fn split_command(s: &str) -> Result<Vec<String>> {
    let mut args = Vec::new();
    let mut cur = String::new();
    let mut in_arg = false;
    let mut quote: Option<char> = None;
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        match quote {
            Some('"') => match c {
                '"' => quote = None,
                '\\' if matches!(chars.peek(), Some('"') | Some('\\')) => {
                    if let Some(n) = chars.next() {
                        cur.push(n);
                    }
                }
                _ => cur.push(c),
            },
            Some(_) => {
                if c == '\'' {
                    quote = None;
                } else {
                    cur.push(c);
                }
            }
            None => match c {
                '"' | '\'' => {
                    quote = Some(c);
                    in_arg = true;
                }
                c if c.is_whitespace() => {
                    if in_arg {
                        args.push(std::mem::take(&mut cur));
                        in_arg = false;
                    }
                }
                _ => {
                    cur.push(c);
                    in_arg = true;
                }
            },
        }
    }
    if quote.is_some() {
        return Err(AppError::InvalidInput(
            "credential_process has an unterminated quote".into(),
        ));
    }
    if in_arg {
        args.push(cur);
    }
    if args.is_empty() {
        return Err(AppError::InvalidInput("credential_process is empty".into()));
    }
    Ok(args)
}

/// `credential_process` の標準出力 JSON (AWS CLI の外部資格情報ソース仕様)。
#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct ProcessJson {
    version: Option<i64>,
    access_key_id: Option<String>,
    secret_access_key: Option<String>,
    session_token: Option<String>,
    expiration: Option<String>,
}

/// 出力を解釈して資格情報と有効期限を返す。エラー文に出力内容 (秘密) は含めない。
fn parse_process_output(stdout: &str) -> Result<(AwsCredentials, Option<DateTime<Utc>>)> {
    let bad = |why: &str| {
        AppError::InvalidInput(format!("credential_process returned invalid output: {why}"))
    };
    // serde_json のエラー文には値の断片が入りうるので、理由は固定文言にする。
    let j: ProcessJson =
        serde_json::from_str(stdout).map_err(|_| bad("not a JSON object of the expected shape"))?;
    if j.version != Some(1) {
        return Err(bad("`Version` must be 1"));
    }
    let non_empty = |v: Option<String>| v.filter(|s| !s.is_empty());
    let (Some(access_key_id), Some(secret_access_key)) =
        (non_empty(j.access_key_id), non_empty(j.secret_access_key))
    else {
        return Err(bad("`AccessKeyId` / `SecretAccessKey` missing"));
    };
    let expiration = match non_empty(j.expiration) {
        Some(e) => Some(
            DateTime::parse_from_rfc3339(&e)
                .map_err(|_| bad("`Expiration` is not RFC 3339"))?
                .with_timezone(&Utc),
        ),
        None => None,
    };
    Ok((
        AwsCredentials {
            access_key_id,
            secret_access_key,
            session_token: non_empty(j.session_token),
        },
        expiration,
    ))
}

/// キャッシュを使ってよい期限。`Expiration` の 5 分前、無ければ取得から 5 分。
fn cache_valid_until(now: DateTime<Utc>, expiration: Option<DateTime<Utc>>) -> DateTime<Utc> {
    match expiration {
        Some(e) => e - chrono::Duration::seconds(CACHE_EXPIRY_MARGIN_SECS),
        None => now + chrono::Duration::seconds(CACHE_NO_EXPIRATION_SECS),
    }
}

fn credentials_from_process(
    profile: &str,
    command: &str,
    src: &CredentialSources<'_>,
) -> Result<AwsCredentials> {
    let key = (profile.to_string(), command.to_string());
    if let Some(c) = src.cache.get(&key, src.now) {
        return Ok(c);
    }
    let argv = split_command(command)
        .map_err(|e| AppError::InvalidInput(format!("AWS profile '{profile}': {e}")))?;
    let out = (src.run_process)(&argv)?;
    if !out.success {
        // 標準エラーには秘密 (トークンやパスフレーズのエコー) が混ざりうるため、
        // 原因の手掛かりとして出すのは終了コードだけにする。
        let code = out
            .code
            .map_or_else(|| "signal".to_string(), |c| c.to_string());
        return Err(AppError::InvalidInput(format!(
            "credential_process for AWS profile '{profile}' failed (exit code: {code}); \
             run the command in a terminal to see its error"
        )));
    }
    let (creds, expiration) = parse_process_output(&out.stdout)
        .map_err(|e| AppError::InvalidInput(format!("AWS profile '{profile}': {e}")))?;
    let valid_until = cache_valid_until(src.now, expiration);
    if valid_until > src.now {
        src.cache.put(key, creds.clone(), valid_until);
    }
    Ok(creds)
}

/// 子プロセスを (シェルなしで) 起動し、`timeout` 以内に終わるのを待つ。標準入力は null、
/// 標準出力 / 標準エラーはパイプ。超過したら kill してエラー。
fn run_command(argv: &[String], timeout: Duration) -> Result<ProcessOutput> {
    let Some((program, args)) = argv.split_first() else {
        return Err(AppError::InvalidInput("credential_process is empty".into()));
    };
    let mut cmd = Command::new(program);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // GUI アプリから起動したときにコンソール窓を出さない (CREATE_NO_WINDOW)。
        cmd.creation_flags(0x0800_0000);
    }
    // 起動失敗の OS エラー文にはコマンドが含まれうるので、固定文言にする。
    let mut child = cmd.spawn().map_err(|e| {
        AppError::InvalidInput(format!(
            "failed to start credential_process ({:?})",
            e.kind()
        ))
    })?;
    // パイプが詰まって子が止まらないよう、別スレッドで読み出す。標準エラーは捨てる。
    let stdout_reader = child.stdout.take().map(|mut o| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = (&mut o).take(MAX_PROCESS_OUTPUT).read_to_end(&mut buf);
            let _ = std::io::copy(&mut o, &mut std::io::sink());
            buf
        })
    });
    if let Some(mut e) = child.stderr.take() {
        std::thread::spawn(move || {
            let _ = std::io::copy(&mut e, &mut std::io::sink());
        });
    }
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break st,
            Ok(None) => {}
            Err(e) => return Err(AppError::Io(e)),
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(AppError::InvalidInput(format!(
                "credential_process timed out after {} seconds",
                timeout.as_secs()
            )));
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    let stdout = stdout_reader
        .and_then(|h| h.join().ok())
        .map(|b| String::from_utf8_lossy(&b).into_owned())
        .unwrap_or_default();
    Ok(ProcessOutput {
        code: status.code(),
        success: status.success(),
        stdout,
    })
}

/// 資格情報の置き場所へのアクセスを差し替え可能にしたもの (テスト用に純化)。
pub struct CredentialSources<'a> {
    pub env: &'a dyn Fn(&str) -> Option<String>,
    pub read_file: &'a dyn Fn(&Path) -> Option<String>,
    pub home: Option<PathBuf>,
    /// `credential_process` の実行 (分割済みの argv を受け取り、終了コードと標準出力を返す)。
    pub run_process: &'a dyn Fn(&[String]) -> Result<ProcessOutput>,
    /// 現在時刻 (キャッシュの有効判定用)。
    pub now: DateTime<Utc>,
    /// `credential_process` の結果のメモリキャッシュ。
    pub cache: &'a ProcessCredentialCache,
}

impl CredentialSources<'_> {
    fn env_non_empty(&self, key: &str) -> Option<String> {
        (self.env)(key)
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
    }

    fn file_path(&self, env_key: &str, default_name: &str) -> Option<PathBuf> {
        if let Some(p) = self.env_non_empty(env_key) {
            return Some(PathBuf::from(p));
        }
        self.home
            .as_ref()
            .map(|h| h.join(".aws").join(default_name))
    }
}

/// 資格情報を解決する (解決順はモジュール先頭のコメント参照)。
pub fn resolve_credentials(
    profile: Option<&str>,
    src: &CredentialSources<'_>,
) -> Result<AwsCredentials> {
    let explicit = profile.map(str::trim).filter(|p| !p.is_empty());
    if explicit.is_none() {
        if let (Some(id), Some(secret)) = (
            src.env_non_empty("AWS_ACCESS_KEY_ID"),
            src.env_non_empty("AWS_SECRET_ACCESS_KEY"),
        ) {
            return Ok(AwsCredentials {
                access_key_id: id,
                secret_access_key: secret,
                session_token: src.env_non_empty("AWS_SESSION_TOKEN"),
            });
        }
    }
    let name = explicit
        .map(str::to_string)
        .or_else(|| src.env_non_empty("AWS_PROFILE"))
        .unwrap_or_else(|| "default".to_string());

    // 共有資格情報ファイルが設定ファイルより優先 (AWS CLI と同じ)。
    let creds_file = src
        .file_path("AWS_SHARED_CREDENTIALS_FILE", "credentials")
        .and_then(|p| (src.read_file)(&p))
        .map(|t| parse_ini(&t))
        .unwrap_or_default();
    let creds_entries = find_section(&creds_file, std::slice::from_ref(&name));
    if let Some(c) = creds_entries.and_then(static_keys) {
        return Ok(c);
    }
    let config_file = src
        .file_path("AWS_CONFIG_FILE", "config")
        .and_then(|p| (src.read_file)(&p))
        .map(|t| parse_ini(&t))
        .unwrap_or_default();
    let config_names = if name == "default" {
        vec!["default".to_string(), "profile default".to_string()]
    } else {
        vec![format!("profile {name}")]
    };
    let config_entries = find_section(&config_file, &config_names);
    if let Some(c) = config_entries.and_then(static_keys) {
        return Ok(c);
    }
    // 静的キーが無ければ `credential_process` (AWS CLI は credentials ファイル側の
    // 記述も受け付ける)。
    for entries in [creds_entries, config_entries].into_iter().flatten() {
        if let Some(cmd) = get(entries, "credential_process") {
            return credentials_from_process(&name, cmd, src);
        }
    }
    if let Some(entries) = config_entries {
        // SSO / AssumeRole は範囲外。黙って別の資格情報へ落ちるより、何をすれば
        // よいかを示して失敗させる。
        let unsupported = ["sso_session", "sso_start_url", "role_arn"];
        if let Some(kind) = unsupported.iter().find(|k| get(entries, k).is_some()) {
            return Err(AppError::InvalidInput(format!(
                "AWS profile '{name}' uses `{kind}`, which noobDB does not resolve \
                 (supported: static keys, `credential_process`, or environment variables). \
                 Run `aws configure export-credentials --profile {name} --format env` \
                 and start noobDB with those AWS_* variables set"
            )));
        }
    }
    Err(AppError::InvalidInput(format!(
        "AWS credentials not found (looked for AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY \
         and profile '{name}' in ~/.aws/credentials and ~/.aws/config)"
    )))
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

/// 実環境 (プロセスの環境変数・ホームディレクトリ) から資格情報を解決する。
pub fn load_credentials(profile: Option<&str>) -> Result<AwsCredentials> {
    let env = |k: &str| std::env::var(k).ok();
    let read_file = |p: &Path| std::fs::read_to_string(p).ok();
    resolve_credentials(
        profile,
        &CredentialSources {
            env: &env,
            read_file: &read_file,
            home: home_dir(),
            run_process: &|argv| run_command(argv, PROCESS_TIMEOUT),
            now: Utc::now(),
            cache: &PROCESS_CACHE,
        },
    )
}

/// プロセス環境変数を読むクロージャ (build_options 用)。
pub fn process_env(key: &str) -> Option<String> {
    std::env::var(key).ok()
}

/// `iam` の設定で今この瞬間に有効なトークンを作る。資格情報は毎回読み直し、
/// 保持しない。トークン・資格情報はログに出さない (出すのはエンドポイント情報のみ)。
pub fn fresh_token(iam: &AwsIamOptions, user: &str) -> Result<String> {
    let creds = load_credentials(iam.profile.as_deref())?;
    let token = generate_auth_token(
        &iam.endpoint_host,
        iam.endpoint_port,
        user,
        &iam.region,
        &creds,
        Utc::now(),
    );
    tracing::debug!(
        host = %iam.endpoint_host,
        port = iam.endpoint_port,
        region = %iam.region,
        "aws iam: generated RDS auth token"
    );
    Ok(token)
}

/// [`fresh_token`] を tokio のブロッキングプールで実行する。`credential_process` は
/// 外部プロセスの完了を同期的に待つため (MFA で最大 60 秒)、非同期ワーカーを塞がない
/// ようにする。tokio ランタイム内から呼ぶこと。
pub async fn fresh_token_blocking(iam: &AwsIamOptions, user: &str) -> Result<String> {
    let iam = iam.clone();
    let user = user.to_string();
    tokio::task::spawn_blocking(move || fresh_token(&iam, &user))
        .await
        .map_err(|_| AppError::Other("aws iam: token generation task failed".into()))?
}

/// ドライバの `connect` が使うパスワード。IAM 認証ならその場で作ったトークン、
/// そうでなければ保存済みのパスワード。
pub async fn password_for(opts: &super::DbConnectOptions) -> Result<String> {
    match &opts.aws_iam {
        Some(iam) => fresh_token_blocking(iam, &opts.user).await,
        None => Ok(opts.password.clone()),
    }
}

/// ネイティブダンプ (`mysqldump` / `pg_dump`) のように外部プロセスへ資格情報を
/// 渡す経路向け: IAM 認証ならパスワード欄を今有効なトークンに差し替えた複製を返す。
pub async fn with_fresh_password(
    opts: &super::DbConnectOptions,
) -> Result<super::DbConnectOptions> {
    let mut out = opts.clone();
    if opts.aws_iam.is_some() {
        out.password = password_for(opts).await?;
        out.ssl_mode = Some(enforce_tls(opts.ssl_mode));
    }
    Ok(out)
}

/// プールの接続オプションに載せたトークンを定期的に作り直すバックグラウンド
/// タスクのガード。ドロップでタスクを止める (セッション破棄と連動)。
pub struct TokenRefreshGuard(tokio::task::JoinHandle<()>);

impl Drop for TokenRefreshGuard {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// [`TOKEN_REFRESH_INTERVAL`] ごとに新しいトークンを作って `apply` に渡す。
/// `apply` が `false` を返したら (プールが閉じられた等) 終了する。トークン生成に
/// 失敗しても (資格情報ファイルの一時的な不在など) 旧トークンのまま次回に再試行する。
///
/// sqlx のプールには「物理接続を張る直前」のフックが無いため、
/// `Pool::set_connect_options` で新規接続用のオプションを差し替える方式を採る。
/// 確立済みの接続はトークン失効後も維持される (RDS はトークンを接続確立時にのみ検証)。
pub fn spawn_token_refresh(
    iam: AwsIamOptions,
    user: String,
    apply: impl Fn(String) -> bool + Send + 'static,
) -> TokenRefreshGuard {
    TokenRefreshGuard(tokio::spawn(async move {
        loop {
            tokio::time::sleep(TOKEN_REFRESH_INTERVAL).await;
            match fresh_token_blocking(&iam, &user).await {
                Ok(token) => {
                    if !apply(token) {
                        break;
                    }
                }
                Err(e) => tracing::warn!(
                    host = %iam.endpoint_host,
                    error = %e,
                    "aws iam: failed to refresh RDS auth token; keeping the previous one"
                ),
            }
        }
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn creds(id: &str, secret: &str, token: Option<&str>) -> AwsCredentials {
        AwsCredentials {
            access_key_id: id.into(),
            secret_access_key: secret.into(),
            session_token: token.map(str::to_string),
        }
    }

    /// smithy-rs (AWS SDK for Rust) `rds_auth_token.rs` の `signing_works` と同一の
    /// 入力・期待値 (完全一致)。
    #[test]
    fn matches_aws_sdk_for_rust_vector() {
        let now = Utc
            .timestamp_opt(1_724_709_600, 0)
            .single()
            .expect("valid ts");
        let token = generate_auth_token(
            "prod-instance.us-east-1.rds.amazonaws.com",
            3306,
            "peccy",
            "us-east-1",
            &creds("akid", "secret", None),
            now,
        );
        assert_eq!(
            token,
            "prod-instance.us-east-1.rds.amazonaws.com:3306/?Action=connect&DBUser=peccy&X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=akid%2F20240826%2Fus-east-1%2Frds-db%2Faws4_request&X-Amz-Date=20240826T220000Z&X-Amz-Expires=900&X-Amz-SignedHeaders=host&X-Amz-Signature=dd0cba843009474347af724090233265628ace491ea17ce3eb3da098b983ad89"
        );
    }

    /// botocore `TestGenerateDBAuthToken.test_generate_db_auth_token` と同一の入力。
    /// botocore はパラメータ順が異なるため (URL として等価比較している)、署名と
    /// 各パラメータの値を比較する。
    #[test]
    fn matches_botocore_vector() {
        let now = Utc
            .with_ymd_and_hms(2016, 11, 7, 17, 39, 33)
            .single()
            .expect("valid ts");
        let token = generate_auth_token(
            "prod-instance.us-east-1.rds.amazonaws.com",
            3306,
            "someusername",
            "us-east-1",
            &creds("akid", "skid", None),
            now,
        );
        assert!(token.starts_with(
            "prod-instance.us-east-1.rds.amazonaws.com:3306/?Action=connect&DBUser=someusername&"
        ));
        assert!(token.contains("&X-Amz-Date=20161107T173933Z&"));
        assert!(token
            .contains("&X-Amz-Credential=akid%2F20161107%2Fus-east-1%2Frds-db%2Faws4_request&"));
        assert!(token.ends_with(
            "&X-Amz-Signature=d1138cdbc0ca63eec012ec0fc6c2267e03642168f5884a7795320d4c18374c61"
        ));
    }

    /// SigV4 ドキュメントの署名鍵導出例 (secret `wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY`,
    /// 20120215 / us-east-1 / iam)。
    #[test]
    fn signing_key_matches_documented_example() {
        let key = signing_key(
            "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
            "20120215",
            "us-east-1",
            "iam",
        );
        assert_eq!(
            data_encoding::HEXLOWER.encode(&key),
            "f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d"
        );
    }

    /// S3 の SigV4 クエリ文字列認証ドキュメントの presigned URL 例 (GET /test.txt、
    /// 有効期限 86400 秒、UNSIGNED-PAYLOAD)。
    #[test]
    fn presign_matches_documented_s3_example() {
        let date = "20130524";
        let scope = format!("{date}/us-east-1/s3/aws4_request");
        let credential = format!("AKIAIOSFODNN7EXAMPLE/{scope}");
        let key = signing_key(
            "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
            date,
            "us-east-1",
            "s3",
        );
        let (_, sig) = presign_get(
            "examplebucket.s3.amazonaws.com",
            "/test.txt",
            &[
                ("X-Amz-Algorithm", ALGORITHM),
                ("X-Amz-Credential", &credential),
                ("X-Amz-Date", "20130524T000000Z"),
                ("X-Amz-Expires", "86400"),
                ("X-Amz-SignedHeaders", "host"),
            ],
            "UNSIGNED-PAYLOAD",
            "20130524T000000Z",
            &scope,
            &key,
        );
        assert_eq!(
            sig,
            "aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404"
        );
    }

    /// RFC 4231 Test Case 2 / 6 (鍵がブロック長超のケース)。
    #[test]
    fn hmac_sha256_matches_rfc4231() {
        assert_eq!(
            data_encoding::HEXLOWER.encode(&hmac_sha256(b"Jefe", b"what do ya want for nothing?")),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
        assert_eq!(
            data_encoding::HEXLOWER.encode(&hmac_sha256(
                &[0xaa; 131],
                b"Test Using Larger Than Block-Size Key - Hash Key First"
            )),
            "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"
        );
    }

    #[test]
    fn token_signs_the_endpoint_and_encodes_user_and_session_token() {
        let now = Utc
            .timestamp_opt(1_724_709_600, 0)
            .single()
            .expect("valid ts");
        let token = generate_auth_token(
            "  Prod.Cluster-abc.ap-northeast-1.rds.amazonaws.com ",
            5432,
            "app user@x",
            "ap-northeast-1",
            &creds("AKID", "secret", Some("tok/en+=")),
            now,
        );
        // ホスト名は小文字化・trim され、ポート付きで先頭に来る。
        assert!(token.starts_with("prod.cluster-abc.ap-northeast-1.rds.amazonaws.com:5432/?"));
        // DBUser とセッショントークンは SigV4 の URI エンコード。
        assert!(token.contains("DBUser=app%20user%40x"));
        assert!(token.contains("X-Amz-Security-Token=tok%2Fen%2B%3D"));
        // セッショントークンは署名対象 (ソート済みクエリ) の中、署名は最後。
        let sig_pos = token.find("X-Amz-Signature=").expect("signature");
        let tok_pos = token.find("X-Amz-Security-Token=").expect("token");
        assert!(tok_pos < sig_pos);
        assert!(token.contains("%2Fap-northeast-1%2Frds-db%2Faws4_request"));
        // 既定ポート 443 のときは host にポートを付けない (URL の authority 規則)。
        let t443 = generate_auth_token(
            "h.us-east-1.rds.amazonaws.com",
            443,
            "u",
            "us-east-1",
            &creds("a", "b", None),
            now,
        );
        assert!(t443.starts_with("h.us-east-1.rds.amazonaws.com/?"));
    }

    #[test]
    fn debug_redacts_secrets() {
        let s = format!("{:?}", creds("AKIAXXXX", "very-secret", Some("sess")));
        assert!(!s.contains("AKIAXXXX"));
        assert!(!s.contains("very-secret"));
        assert!(!s.contains("sess\""));
    }

    // ── 共有ゴールデン (フロント `awsIam.ts` と同じ判定) ──

    const GOLDEN: &str = include_str!("../../../src/__tests__/fixtures/awsIamGolden.json");

    #[test]
    fn golden_region_inference() {
        let v: serde_json::Value = serde_json::from_str(GOLDEN).expect("golden json");
        let cases = v["regionFromHost"].as_array().expect("regionFromHost");
        assert!(!cases.is_empty());
        for c in cases {
            let host = c["host"].as_str().expect("host");
            let want = c["region"].as_str();
            assert_eq!(infer_region_from_host(host).as_deref(), want, "host {host}");
        }
    }

    #[test]
    fn golden_tls_enforcement() {
        let v: serde_json::Value = serde_json::from_str(GOLDEN).expect("golden json");
        let cases = v["enforceTls"].as_array().expect("enforceTls");
        assert!(!cases.is_empty());
        for c in cases {
            let input: Option<SslMode> = serde_json::from_value(c["mode"].clone()).expect("mode");
            let want: SslMode = serde_json::from_value(c["effective"].clone()).expect("eff");
            assert_eq!(enforce_tls(input), want, "input {input:?}");
        }
    }

    #[test]
    fn region_resolution_order() {
        let no_env = |_: &str| None;
        let env = |k: &str| (k == "AWS_DEFAULT_REGION").then(|| "eu-west-1".to_string());
        // 明示設定が最優先。
        assert_eq!(
            resolve_region(" us-west-2 ", "x.us-east-1.rds.amazonaws.com", &no_env).ok(),
            Some("us-west-2".to_string())
        );
        // 次にエンドポイント名。
        assert_eq!(
            resolve_region("", "x.y.us-east-1.rds.amazonaws.com", &env).ok(),
            Some("us-east-1".to_string())
        );
        // 最後に環境変数。
        assert_eq!(
            resolve_region("", "db.internal", &env).ok(),
            Some("eu-west-1".to_string())
        );
        assert!(resolve_region("", "db.internal", &no_env).is_err());
    }

    #[test]
    fn build_options_keeps_the_pre_tunnel_endpoint() {
        let cfg = AwsIamConfig {
            region: String::new(),
            profile: Some("  ".into()),
        };
        let o =
            build_options(&cfg, "db.abc.us-east-2.rds.amazonaws.com", 3306, &|_| None).expect("ok");
        assert_eq!(o.endpoint_host, "db.abc.us-east-2.rds.amazonaws.com");
        assert_eq!(o.endpoint_port, 3306);
        assert_eq!(o.region, "us-east-2");
        assert_eq!(o.profile, None, "blank profile is normalized to None");
        assert!(build_options(&cfg, " ", 3306, &|_| None).is_err());
    }

    fn sources<'a>(
        env: &'a dyn Fn(&str) -> Option<String>,
        read_file: &'a dyn Fn(&Path) -> Option<String>,
    ) -> CredentialSources<'a> {
        static NO_CACHE: ProcessCredentialCache = ProcessCredentialCache::new();
        CredentialSources {
            env,
            read_file,
            home: Some(PathBuf::from("/home/u")),
            run_process: &|_| panic!("credential_process must not run in this test"),
            now: Utc::now(),
            cache: &NO_CACHE,
        }
    }

    const CREDENTIALS: &str = "\
# comment
[default]
aws_access_key_id = AKIDDEFAULT
aws_secret_access_key = SECRETDEFAULT

[work]
AWS_ACCESS_KEY_ID=AKIDWORK
aws_secret_access_key=SECRETWORK
aws_session_token = SESSWORK
";

    const CONFIG: &str = "\
[profile cfgonly]
aws_access_key_id = AKIDCFG
aws_secret_access_key = SECRETCFG

[profile vault]
credential_process = aws-vault export --format=json \"my profile\"

[profile both]
aws_access_key_id = AKIDBOTH
aws_secret_access_key = SECRETBOTH
credential_process = should-not-run

[profile sso]
sso_session = my-sso
sso_account_id = 123456789012
";

    fn read_files(p: &Path) -> Option<String> {
        // 本体と同じ `Path::join` で組み立てて比較する (Windows では区切りが `\` になり、
        // 文字列の完全一致では `/home/u\.aws\credentials` と一致しないため)。
        let aws = Path::new("/home/u").join(".aws");
        if p == aws.join("credentials") {
            Some(CREDENTIALS.to_string())
        } else if p == aws.join("config") {
            Some(CONFIG.to_string())
        } else {
            None
        }
    }

    #[test]
    fn credentials_env_wins_when_no_profile_is_named() {
        let env = |k: &str| match k {
            "AWS_ACCESS_KEY_ID" => Some("AKIDENV".to_string()),
            "AWS_SECRET_ACCESS_KEY" => Some("SECRETENV".to_string()),
            "AWS_SESSION_TOKEN" => Some("TOKENV".to_string()),
            _ => None,
        };
        let c = resolve_credentials(None, &sources(&env, &read_files)).expect("env");
        assert_eq!(c.access_key_id, "AKIDENV");
        assert_eq!(c.session_token.as_deref(), Some("TOKENV"));
        // 明示したプロファイルは環境変数より優先。
        let c = resolve_credentials(Some("work"), &sources(&env, &read_files)).expect("work");
        assert_eq!(c.access_key_id, "AKIDWORK");
        assert_eq!(c.session_token.as_deref(), Some("SESSWORK"));
    }

    #[test]
    fn credentials_fall_back_to_aws_profile_then_default() {
        let none = |_: &str| None;
        let c = resolve_credentials(None, &sources(&none, &read_files)).expect("default");
        assert_eq!(c.access_key_id, "AKIDDEFAULT");
        assert_eq!(c.session_token, None);
        let env = |k: &str| (k == "AWS_PROFILE").then(|| "work".to_string());
        let c = resolve_credentials(None, &sources(&env, &read_files)).expect("AWS_PROFILE");
        assert_eq!(c.access_key_id, "AKIDWORK");
        // 設定ファイルの `[profile x]` の静的キーも読む。
        let c = resolve_credentials(Some("cfgonly"), &sources(&none, &read_files)).expect("cfg");
        assert_eq!(c.access_key_id, "AKIDCFG");
    }

    #[test]
    fn credentials_honor_file_location_overrides() {
        let env =
            |k: &str| (k == "AWS_SHARED_CREDENTIALS_FILE").then(|| "/custom/creds".to_string());
        let read = |p: &Path| {
            (p == Path::new("/custom/creds"))
                .then(|| "[default]\naws_access_key_id=A\naws_secret_access_key=B\n".to_string())
        };
        let c = resolve_credentials(None, &sources(&env, &read)).expect("override");
        assert_eq!(c.access_key_id, "A");
    }

    #[test]
    fn unsupported_profile_kinds_explain_the_workaround() {
        let none = |_: &str| None;
        let e = resolve_credentials(Some("sso"), &sources(&none, &read_files))
            .expect_err("sso is out of scope");
        let msg = e.to_string();
        assert!(msg.contains("sso_session"), "{msg}");
        assert!(msg.contains("export-credentials"), "{msg}");
        let e = resolve_credentials(Some("missing"), &sources(&none, &read_files))
            .expect_err("missing");
        assert!(e.to_string().contains("not found"));
        // エラー文に秘密が混ざらない。
        assert!(!msg.contains("SECRET"));
    }

    // ── credential_process (#1682) ──

    const PROC_JSON: &str = r#"{"Version":1,"AccessKeyId":"AKIDPROC","SecretAccessKey":"SECRETPROC","SessionToken":"SESSPROC","Expiration":"2030-01-01T00:00:00Z"}"#;

    fn ok_output(stdout: &str) -> Result<ProcessOutput> {
        Ok(ProcessOutput {
            code: Some(0),
            success: true,
            stdout: stdout.to_string(),
        })
    }

    #[test]
    fn split_command_handles_quotes_without_a_shell() {
        let v = |s: &str| split_command(s).expect("split");
        assert_eq!(
            v("aws-vault export --format=json work"),
            ["aws-vault", "export", "--format=json", "work"]
        );
        assert_eq!(
            v(r#"  cmd "a b"  'c d' e"f g"h  """#),
            ["cmd", "a b", "c d", "ef gh", ""]
        );
        assert_eq!(v(r#"cmd "say \"hi\" \\""#), ["cmd", r#"say "hi" \"#]);
        // 引用の外の `\` はそのまま (Windows のパス)。
        assert_eq!(v(r"C:\bin\tool.exe x"), [r"C:\bin\tool.exe", "x"]);
        // `;` や `$()` はシェルで解釈されない。
        assert_eq!(v("a; rm -rf $(x)"), ["a;", "rm", "-rf", "$(x)"]);
        assert!(split_command("cmd \"open").is_err());
        assert!(split_command("cmd 'open").is_err());
        assert!(split_command("   ").is_err());
    }

    #[test]
    fn process_output_is_parsed_per_the_aws_spec() {
        let (c, exp) = parse_process_output(PROC_JSON).expect("ok");
        assert_eq!(c.access_key_id, "AKIDPROC");
        assert_eq!(c.session_token.as_deref(), Some("SESSPROC"));
        assert_eq!(
            exp,
            Some(Utc.with_ymd_and_hms(2030, 1, 1, 0, 0, 0).unwrap())
        );
        // SessionToken / Expiration は任意。
        let (c, exp) =
            parse_process_output(r#"{"Version":1,"AccessKeyId":"A","SecretAccessKey":"B"}"#)
                .expect("minimal");
        assert_eq!((c.session_token, exp), (None, None));
        // Version が 1 以外 / 無いものはエラー。
        for bad in [
            r#"{"Version":2,"AccessKeyId":"A","SecretAccessKey":"B"}"#,
            r#"{"AccessKeyId":"A","SecretAccessKey":"B"}"#,
            r#"{"Version":1,"AccessKeyId":"A"}"#,
            r#"{"Version":1,"AccessKeyId":"A","SecretAccessKey":"B","Expiration":"tomorrow"}"#,
            "not json SECRETLEAK",
        ] {
            let e = parse_process_output(bad).expect_err(bad).to_string();
            assert!(!e.contains("SECRETLEAK"), "{e}");
        }
    }

    #[test]
    fn cache_validity_window() {
        let now = Utc.with_ymd_and_hms(2030, 1, 1, 0, 0, 0).unwrap();
        let exp = now + chrono::Duration::minutes(60);
        assert_eq!(
            cache_valid_until(now, Some(exp)),
            now + chrono::Duration::minutes(55)
        );
        assert_eq!(
            cache_valid_until(now, None),
            now + chrono::Duration::minutes(5)
        );
        // 期限まで 5 分を切っていればキャッシュしない (valid_until <= now)。
        assert!(cache_valid_until(now, Some(now + chrono::Duration::minutes(3))) <= now);
    }

    #[test]
    fn credential_process_runs_once_and_is_cached_until_near_expiry() {
        use std::cell::Cell;
        let none = |_: &str| None;
        let calls = Cell::new(0);
        let cache = ProcessCredentialCache::new();
        let runner = |argv: &[String]| {
            calls.set(calls.get() + 1);
            assert_eq!(argv[0], "aws-vault");
            assert_eq!(argv[3], "my profile");
            ok_output(PROC_JSON)
        };
        let make = |now: DateTime<Utc>| CredentialSources {
            run_process: &runner,
            now,
            cache: &cache,
            ..sources(&none, &read_files)
        };
        let t0 = Utc.with_ymd_and_hms(2029, 12, 31, 22, 0, 0).unwrap();
        let c = resolve_credentials(Some("vault"), &make(t0)).expect("first");
        assert_eq!(c.access_key_id, "AKIDPROC");
        resolve_credentials(Some("vault"), &make(t0 + chrono::Duration::minutes(10)))
            .expect("cached");
        assert_eq!(calls.get(), 1, "10 分後はキャッシュを使う");
        // Expiration の 5 分前を過ぎたら再実行。
        resolve_credentials(Some("vault"), &make(t0 + chrono::Duration::minutes(116)))
            .expect("refetch");
        assert_eq!(calls.get(), 2);
    }

    #[test]
    fn credential_process_without_expiration_is_cached_briefly() {
        use std::cell::Cell;
        let none = |_: &str| None;
        let calls = Cell::new(0);
        let cache = ProcessCredentialCache::new();
        let runner = |_: &[String]| {
            calls.set(calls.get() + 1);
            ok_output(r#"{"Version":1,"AccessKeyId":"A","SecretAccessKey":"B"}"#)
        };
        let make = |now: DateTime<Utc>| CredentialSources {
            run_process: &runner,
            now,
            cache: &cache,
            ..sources(&none, &read_files)
        };
        let t0 = Utc.with_ymd_and_hms(2030, 1, 1, 0, 0, 0).unwrap();
        resolve_credentials(Some("vault"), &make(t0)).expect("1");
        resolve_credentials(Some("vault"), &make(t0 + chrono::Duration::minutes(4))).expect("2");
        assert_eq!(calls.get(), 1);
        resolve_credentials(Some("vault"), &make(t0 + chrono::Duration::minutes(6))).expect("3");
        assert_eq!(calls.get(), 2);
    }

    #[test]
    fn static_keys_beat_credential_process() {
        // `both` は静的キーを持つのでコマンドは実行されない (sources の runner は panic)。
        let none = |_: &str| None;
        let c = resolve_credentials(Some("both"), &sources(&none, &read_files)).expect("both");
        assert_eq!(c.access_key_id, "AKIDBOTH");
    }

    #[test]
    fn credential_process_in_credentials_file_is_accepted() {
        let none = |_: &str| None;
        let read = |p: &Path| {
            p.ends_with("credentials")
                .then(|| "[ci]\ncredential_process = fetch-creds\n".to_string())
        };
        let runner = |argv: &[String]| {
            assert_eq!(argv, ["fetch-creds"]);
            ok_output(PROC_JSON)
        };
        let cache = ProcessCredentialCache::new();
        let src = CredentialSources {
            run_process: &runner,
            cache: &cache,
            ..sources(&none, &read)
        };
        let c = resolve_credentials(Some("ci"), &src).expect("ci");
        assert_eq!(c.access_key_id, "AKIDPROC");
    }

    #[test]
    fn credential_process_failure_does_not_leak_output() {
        let none = |_: &str| None;
        let runner = |_: &[String]| {
            Ok(ProcessOutput {
                code: Some(3),
                success: false,
                stdout: "SECRETLEAK".to_string(),
            })
        };
        let cache = ProcessCredentialCache::new();
        let src = CredentialSources {
            run_process: &runner,
            cache: &cache,
            ..sources(&none, &read_files)
        };
        let msg = resolve_credentials(Some("vault"), &src)
            .expect_err("exit 3")
            .to_string();
        assert!(msg.contains("exit code: 3"), "{msg}");
        assert!(!msg.contains("SECRETLEAK"), "{msg}");
    }

    #[cfg(unix)]
    #[test]
    fn run_command_captures_stdout_and_exit_code() {
        let argv = |s: &[&str]| s.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        let out = run_command(
            &argv(&["sh", "-c", "printf hello; echo err >&2"]),
            Duration::from_secs(10),
        )
        .expect("run");
        assert!(out.success);
        assert_eq!(out.stdout, "hello");
        let out =
            run_command(&argv(&["sh", "-c", "exit 7"]), Duration::from_secs(10)).expect("run");
        assert_eq!((out.success, out.code), (false, Some(7)));
        assert!(run_command(&argv(&["/nonexistent/bin"]), Duration::from_secs(1)).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn run_command_kills_on_timeout() {
        let started = Instant::now();
        let e = run_command(
            &["sleep".to_string(), "30".to_string()],
            Duration::from_millis(300),
        )
        .expect_err("timeout");
        assert!(e.to_string().contains("timed out"), "{e}");
        assert!(started.elapsed() < Duration::from_secs(10));
    }
}
