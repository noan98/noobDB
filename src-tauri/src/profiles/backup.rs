//! プロファイルの暗号化フルバックアップ (#710)。
//!
//! 接続プロファイル (非秘密) と keyring の秘密 (DB パスワード / SSH パスフレーズ /
//! SSH パスワード / 踏み台の同 2 種) を 1 つの JSON にまとめ、**利用者が指定した
//! パスフレーズ**から導出した鍵で封緘した単一ファイル (`.noobdb-backup`) にする。
//! マシン移行のための明示的な持ち出し経路で、秘密分離ポリシー (秘密は keyring
//! のみ) の例外ではなく「keyring → 暗号文」の変換にとどまる:
//!
//! - 平文ペイロードはメモリ上でのみ組み立て、暗号化してから書き出す。一時ファイルは
//!   作らない。平文 / 導出鍵のバッファは [`Zeroizing`] で破棄時にゼロ埋めする。
//! - パスフレーズ・秘密の値はログにも IPC 応答にも出さない (件数だけを返す)。
//! - パスフレーズ自体はどこにも保存しない。
//!
//! # ファイル形式 (v1)
//!
//! すべてリトルエンディアン。ヘッダ 52 バイト全体を AES-GCM の AAD (追加認証
//! データ) に入れるので、KDF パラメータ・ソルト・ノンスの改ざんも復号失敗として
//! 検出される。
//!
//! | offset | size | 内容 |
//! |---|---|---|
//! | 0  | 8  | マジック `NOOBDBBK` |
//! | 8  | 1  | 形式バージョン (`1`) |
//! | 9  | 1  | KDF 識別子 (`1` = Argon2id v0x13) |
//! | 10 | 1  | AEAD 識別子 (`1` = AES-256-GCM) |
//! | 11 | 1  | 予約 (`0`) |
//! | 12 | 4  | Argon2 `m_cost` (KiB) |
//! | 16 | 4  | Argon2 `t_cost` (反復回数) |
//! | 20 | 4  | Argon2 `p_cost` (並列度) |
//! | 24 | 16 | ソルト (OS 乱数) |
//! | 40 | 12 | ノンス (OS 乱数) |
//! | 52 | .. | 暗号文 + 16 バイトの認証タグ |
//!
//! 既定の KDF パラメータは Argon2id `m=64 MiB, t=3, p=1` (OWASP の推奨下限
//! `m=19 MiB, t=2` より強め、デスクトップで 1 秒未満)。ファイルごとにソルトが
//! 変わる = 鍵が変わるので、96 bit のランダムノンスでも鍵・ノンスの再利用は
//! 起こらない。復号側はヘッダのパラメータに従うが、細工されたファイルで巨大な
//! メモリ確保をさせられないよう上限 ([`MAX_M_COST_KIB`] など) を設ける。
//!
//! 復号後の平文は JSON `{ "format": "noobdb-profiles-encrypted", "version": 1,
//! "profiles": [{ "profile": ConnectionProfile, "secrets": { kind: value } }] }`。

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::Aes256Gcm;
use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, Zeroizing};

use super::ConnectionProfile;

/// ファイル先頭のマジック。平文 JSON エクスポート (`{` 始まり) と取り違えない。
pub const MAGIC: &[u8; 8] = b"NOOBDBBK";
/// 現行の形式バージョン。これより新しい値は「アプリを更新してください」で拒否する。
pub const FORMAT_VERSION: u8 = 1;
const KDF_ARGON2ID: u8 = 1;
const AEAD_AES256GCM: u8 = 1;
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 12;
const TAG_LEN: usize = 16;
const KEY_LEN: usize = 32;
/// ヘッダ長 (= AAD の範囲)。
pub const HEADER_LEN: usize = 8 + 4 + 12 + SALT_LEN + NONCE_LEN;

/// 復号側が受け入れる KDF パラメータの上限。細工されたヘッダで数十 GiB の
/// メモリ確保や膨大な反復をさせられる DoS を防ぐ (正規の書き出しは既定値のみ)。
pub const MAX_M_COST_KIB: u32 = 1024 * 1024; // 1 GiB
pub const MAX_T_COST: u32 = 16;
pub const MAX_P_COST: u32 = 16;

/// エクスポート時のパスフレーズの最小文字数 (Unicode スカラ値数)。フロントの
/// `profileBackup.ts::MIN_BACKUP_PASSPHRASE_LENGTH` と揃える。
pub const MIN_PASSPHRASE_CHARS: usize = 8;

/// 平文ペイロードの形式識別子とバージョン。
pub const PAYLOAD_FORMAT: &str = "noobdb-profiles-encrypted";
pub const PAYLOAD_VERSION: u32 = 1;

/// Argon2id のコストパラメータ。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KdfParams {
    pub m_cost_kib: u32,
    pub t_cost: u32,
    pub p_cost: u32,
}

impl KdfParams {
    /// 書き出しに使う既定値 (m=64 MiB, t=3, p=1)。
    pub const DEFAULT: KdfParams = KdfParams {
        m_cost_kib: 64 * 1024,
        t_cost: 3,
        p_cost: 1,
    };
}

/// 封緘 / 開封の失敗理由。メッセージにはパスフレーズも秘密の値も含めない。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BackupError {
    /// 先頭がマジックでない。平文 JSON エクスポートらしければ `looks_like_json`。
    NotABackup { looks_like_json: bool },
    /// ヘッダ途中で切れている、または暗号文がタグ長に満たない。
    Truncated,
    /// 未知の形式バージョン (新しいアプリで作られたファイル)。
    UnsupportedVersion(u8),
    /// 未知の KDF / AEAD 識別子。
    UnsupportedAlgorithm,
    /// KDF パラメータが受け入れ範囲外。
    KdfParamsOutOfRange,
    /// 認証タグ不一致 = パスフレーズ誤り、またはファイルの改ざん / 破損。
    /// AEAD の性質上この 2 つは区別できない (区別できてはいけない)。
    DecryptFailed,
    /// 復号はできたが中身が想定の JSON 形式でない。
    InvalidPayload(String),
    /// パスフレーズが空 / 短すぎる。
    WeakPassphrase,
    /// KDF / 乱数 / 暗号ライブラリの内部エラー。
    Crypto(String),
}

impl std::fmt::Display for BackupError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BackupError::NotABackup { looks_like_json: true } => write!(
                f,
                "This is a plain (unencrypted) profile export, not an encrypted backup. Use \"Import profiles\" instead."
            ),
            BackupError::NotABackup { looks_like_json: false } => {
                write!(f, "Not a noobDB encrypted backup file.")
            }
            BackupError::Truncated => write!(f, "The backup file is truncated or corrupted."),
            BackupError::UnsupportedVersion(v) => write!(
                f,
                "Unsupported backup format version {v}. Update noobDB to import this file."
            ),
            BackupError::UnsupportedAlgorithm => {
                write!(f, "The backup file uses an unsupported encryption algorithm.")
            }
            BackupError::KdfParamsOutOfRange => write!(
                f,
                "The backup file's key-derivation parameters are out of the accepted range (corrupted or tampered)."
            ),
            BackupError::DecryptFailed => write!(
                f,
                "Could not decrypt the backup: the passphrase is wrong, or the file has been modified or corrupted."
            ),
            BackupError::InvalidPayload(m) => write!(f, "The decrypted backup is malformed: {m}"),
            BackupError::WeakPassphrase => write!(
                f,
                "The backup passphrase must be at least {MIN_PASSPHRASE_CHARS} characters."
            ),
            BackupError::Crypto(m) => write!(f, "Encryption error: {m}"),
        }
    }
}

impl From<BackupError> for crate::error::AppError {
    fn from(e: BackupError) -> Self {
        match e {
            BackupError::Crypto(_) => crate::error::AppError::Other(e.to_string()),
            _ => crate::error::AppError::InvalidInput(e.to_string()),
        }
    }
}

/// エクスポートに使うパスフレーズの強度下限を検査する。
pub fn validate_export_passphrase(passphrase: &str) -> Result<(), BackupError> {
    if passphrase.chars().count() < MIN_PASSPHRASE_CHARS {
        return Err(BackupError::WeakPassphrase);
    }
    Ok(())
}

fn derive_key(
    passphrase: &str,
    salt: &[u8],
    params: KdfParams,
) -> Result<Zeroizing<[u8; KEY_LEN]>, BackupError> {
    let p = argon2::Params::new(
        params.m_cost_kib,
        params.t_cost,
        params.p_cost,
        Some(KEY_LEN),
    )
    .map_err(|_| BackupError::KdfParamsOutOfRange)?;
    let argon = argon2::Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, p);
    let mut key = Zeroizing::new([0u8; KEY_LEN]);
    argon
        .hash_password_into(passphrase.as_bytes(), salt, key.as_mut())
        .map_err(|e| BackupError::Crypto(format!("key derivation failed: {e}")))?;
    Ok(key)
}

fn cipher_for(key: &[u8; KEY_LEN]) -> Result<Aes256Gcm, BackupError> {
    Aes256Gcm::new_from_slice(key).map_err(|_| BackupError::Crypto("invalid key length".into()))
}

fn encode_header(params: KdfParams, salt: &[u8; SALT_LEN], nonce: &[u8; NONCE_LEN]) -> Vec<u8> {
    let mut h = Vec::with_capacity(HEADER_LEN);
    h.extend_from_slice(MAGIC);
    h.push(FORMAT_VERSION);
    h.push(KDF_ARGON2ID);
    h.push(AEAD_AES256GCM);
    h.push(0);
    h.extend_from_slice(&params.m_cost_kib.to_le_bytes());
    h.extend_from_slice(&params.t_cost.to_le_bytes());
    h.extend_from_slice(&params.p_cost.to_le_bytes());
    h.extend_from_slice(salt);
    h.extend_from_slice(nonce);
    h
}

fn random_bytes<const N: usize>() -> Result<[u8; N], BackupError> {
    use rand::TryRng;
    let mut buf = [0u8; N];
    rand::rngs::SysRng
        .try_fill_bytes(&mut buf)
        .map_err(|e| BackupError::Crypto(format!("OS random source unavailable: {e}")))?;
    Ok(buf)
}

/// 平文を `passphrase` で封緘し、ヘッダ込みのファイル内容を返す。ソルトと
/// ノンスは OS 乱数から毎回新しく取る。
pub fn seal(plaintext: &[u8], passphrase: &str, params: KdfParams) -> Result<Vec<u8>, BackupError> {
    let salt = random_bytes::<SALT_LEN>()?;
    let nonce = random_bytes::<NONCE_LEN>()?;
    seal_with(plaintext, passphrase, params, &salt, &nonce)
}

/// [`seal`] の決定的な版 (ソルト / ノンスを外から与える)。テスト用に分けてある。
fn seal_with(
    plaintext: &[u8],
    passphrase: &str,
    params: KdfParams,
    salt: &[u8; SALT_LEN],
    nonce: &[u8; NONCE_LEN],
) -> Result<Vec<u8>, BackupError> {
    if passphrase.is_empty() {
        return Err(BackupError::WeakPassphrase);
    }
    check_params(params)?;
    let key = derive_key(passphrase, salt, params)?;
    let cipher = cipher_for(&key)?;
    let mut out = encode_header(params, salt, nonce);
    let ct = cipher
        .encrypt(
            nonce.into(),
            Payload {
                msg: plaintext,
                aad: &out,
            },
        )
        .map_err(|_| BackupError::Crypto("encryption failed".into()))?;
    out.extend_from_slice(&ct);
    Ok(out)
}

fn check_params(p: KdfParams) -> Result<(), BackupError> {
    if p.m_cost_kib > MAX_M_COST_KIB
        || p.t_cost == 0
        || p.t_cost > MAX_T_COST
        || p.p_cost == 0
        || p.p_cost > MAX_P_COST
        || p.m_cost_kib < 8 * p.p_cost
    {
        return Err(BackupError::KdfParamsOutOfRange);
    }
    Ok(())
}

fn read_u32(bytes: &[u8], at: usize) -> u32 {
    let mut b = [0u8; 4];
    b.copy_from_slice(&bytes[at..at + 4]);
    u32::from_le_bytes(b)
}

/// ファイル内容を `passphrase` で開封し、平文 (ゼロ埋め付きバッファ) を返す。
/// 形式の検査はマジック → バージョン → アルゴリズム → パラメータ範囲 → 認証の
/// 順に行い、どこで弾かれたかを [`BackupError`] で区別する。
pub fn open(file: &[u8], passphrase: &str) -> Result<Zeroizing<Vec<u8>>, BackupError> {
    if file.len() < MAGIC.len() || &file[..MAGIC.len()] != MAGIC {
        let looks_like_json = file
            .iter()
            .find(|b| !b.is_ascii_whitespace())
            .is_some_and(|b| *b == b'{');
        return Err(BackupError::NotABackup { looks_like_json });
    }
    if file.len() < MAGIC.len() + 1 {
        return Err(BackupError::Truncated);
    }
    let version = file[8];
    if version != FORMAT_VERSION {
        return Err(BackupError::UnsupportedVersion(version));
    }
    if file.len() < HEADER_LEN + TAG_LEN {
        return Err(BackupError::Truncated);
    }
    if file[9] != KDF_ARGON2ID || file[10] != AEAD_AES256GCM || file[11] != 0 {
        return Err(BackupError::UnsupportedAlgorithm);
    }
    let params = KdfParams {
        m_cost_kib: read_u32(file, 12),
        t_cost: read_u32(file, 16),
        p_cost: read_u32(file, 20),
    };
    check_params(params)?;
    if passphrase.is_empty() {
        return Err(BackupError::DecryptFailed);
    }
    let salt = &file[24..24 + SALT_LEN];
    let mut nonce = [0u8; NONCE_LEN];
    nonce.copy_from_slice(&file[40..40 + NONCE_LEN]);
    let header = &file[..HEADER_LEN];
    let key = derive_key(passphrase, salt, params)?;
    let cipher = cipher_for(&key)?;
    let pt = cipher
        .decrypt(
            (&nonce).into(),
            Payload {
                msg: &file[HEADER_LEN..],
                aad: header,
            },
        )
        .map_err(|_| BackupError::DecryptFailed)?;
    Ok(Zeroizing::new(pt))
}

/// 1 プロファイル分の秘密。キー名は keyring の kind 文字列 (`profiles::secrets`)
/// と同一。未設定は `None` で、ファイル上ではキーごと省く。破棄時にゼロ埋めする。
#[derive(Default, Serialize, Deserialize)]
pub struct BackupSecrets {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub db_password: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ssh_passphrase: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ssh_password: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ssh_passphrase_hop0: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ssh_password_hop0: Option<String>,
}

// 値を絶対に表示しない Debug (誤って `{:?}` でログに出しても漏れないように)。
impl std::fmt::Debug for BackupSecrets {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BackupSecrets")
            .field("count", &self.count())
            .finish_non_exhaustive()
    }
}

impl Drop for BackupSecrets {
    fn drop(&mut self) {
        self.db_password.zeroize();
        self.ssh_passphrase.zeroize();
        self.ssh_password.zeroize();
        self.ssh_passphrase_hop0.zeroize();
        self.ssh_password_hop0.zeroize();
    }
}

impl BackupSecrets {
    /// keyring の kind 文字列で値を引く。空文字列は未設定扱い。
    pub fn get(&self, kind: &str) -> Option<&str> {
        let v = match kind {
            "db_password" => &self.db_password,
            "ssh_passphrase" => &self.ssh_passphrase,
            "ssh_password" => &self.ssh_password,
            "ssh_passphrase_hop0" => &self.ssh_passphrase_hop0,
            "ssh_password_hop0" => &self.ssh_password_hop0,
            _ => return None,
        };
        v.as_deref().filter(|s| !s.is_empty())
    }

    /// keyring の kind 文字列で値を設定する。未知の kind は無視する。
    pub fn set(&mut self, kind: &str, value: Option<String>) {
        let slot = match kind {
            "db_password" => &mut self.db_password,
            "ssh_passphrase" => &mut self.ssh_passphrase,
            "ssh_password" => &mut self.ssh_password,
            "ssh_passphrase_hop0" => &mut self.ssh_passphrase_hop0,
            "ssh_password_hop0" => &mut self.ssh_password_hop0,
            _ => return,
        };
        slot.zeroize();
        *slot = value.filter(|s| !s.is_empty());
    }

    /// 設定されている秘密の件数。
    pub fn count(&self) -> usize {
        super::secrets::ALL_KINDS
            .iter()
            .filter(|k| self.get(k).is_some())
            .count()
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BackupEntry {
    pub profile: ConnectionProfile,
    #[serde(default)]
    pub secrets: BackupSecrets,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BackupPayload {
    pub format: String,
    pub version: u32,
    pub profiles: Vec<BackupEntry>,
}

/// ペイロードを JSON にして封緘する。中間の平文 JSON はゼロ埋めバッファに置く。
pub fn seal_payload(
    entries: Vec<BackupEntry>,
    passphrase: &str,
    params: KdfParams,
) -> Result<Vec<u8>, BackupError> {
    validate_export_passphrase(passphrase)?;
    let payload = BackupPayload {
        format: PAYLOAD_FORMAT.to_string(),
        version: PAYLOAD_VERSION,
        profiles: entries,
    };
    let json = Zeroizing::new(
        serde_json::to_vec(&payload).map_err(|e| BackupError::Crypto(e.to_string()))?,
    );
    seal(&json, passphrase, params)
}

/// ファイルを開封してペイロードを取り出す。
pub fn open_payload(file: &[u8], passphrase: &str) -> Result<BackupPayload, BackupError> {
    let json = open(file, passphrase)?;
    // serde のエラーメッセージは入力の断片を含み得る (= 秘密が混ざる) ので、
    // 位置情報だけを返す。
    let payload: BackupPayload = serde_json::from_slice(&json).map_err(|e| {
        BackupError::InvalidPayload(format!(
            "JSON error at line {} column {}",
            e.line(),
            e.column()
        ))
    })?;
    if payload.format != PAYLOAD_FORMAT {
        return Err(BackupError::InvalidPayload(
            "unexpected payload format".into(),
        ));
    }
    if payload.version != PAYLOAD_VERSION {
        return Err(BackupError::UnsupportedVersion(
            u8::try_from(payload.version).unwrap_or(u8::MAX),
        ));
    }
    Ok(payload)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// テストは高速化のため最小に近いパラメータを使う (形式上はヘッダに載るので
    /// 復号側もこの値で導出する)。
    const FAST: KdfParams = KdfParams {
        m_cost_kib: 64,
        t_cost: 1,
        p_cost: 1,
    };

    fn profile(id: &str) -> ConnectionProfile {
        serde_json::from_value(serde_json::json!({
            "id": id, "name": "Prod", "driver": "mysql", "host": "db.example",
            "port": 3306, "user": "app", "database": null, "ssh": null
        }))
        .unwrap()
    }

    fn entry(id: &str, pw: Option<&str>) -> BackupEntry {
        let mut secrets = BackupSecrets::default();
        secrets.set("db_password", pw.map(str::to_string));
        BackupEntry {
            profile: profile(id),
            secrets,
        }
    }

    #[test]
    fn seal_then_open_round_trips() {
        let file = seal(b"hello secrets", "correct horse", FAST).unwrap();
        assert_eq!(&file[..8], MAGIC);
        assert_eq!(file[8], FORMAT_VERSION);
        assert_eq!(file.len(), HEADER_LEN + b"hello secrets".len() + TAG_LEN);
        let pt = open(&file, "correct horse").unwrap();
        assert_eq!(pt.as_slice(), b"hello secrets");
    }

    #[test]
    fn ciphertext_does_not_contain_plaintext() {
        let file = seal(b"super-secret-password", "correct horse", FAST).unwrap();
        assert!(!file
            .windows(b"super-secret".len())
            .any(|w| w == b"super-secret"));
    }

    #[test]
    fn fresh_salt_and_nonce_every_seal() {
        let a = seal(b"x", "correct horse", FAST).unwrap();
        let b = seal(b"x", "correct horse", FAST).unwrap();
        assert_ne!(a[24..HEADER_LEN], b[24..HEADER_LEN]);
        assert_ne!(a, b);
    }

    #[test]
    fn deterministic_seal_is_stable_and_uses_header_params() {
        let salt = [7u8; SALT_LEN];
        let nonce = [9u8; NONCE_LEN];
        let a = seal_with(b"abc", "pw-12345", FAST, &salt, &nonce).unwrap();
        let b = seal_with(b"abc", "pw-12345", FAST, &salt, &nonce).unwrap();
        assert_eq!(a, b);
        assert_eq!(read_u32(&a, 12), FAST.m_cost_kib);
        assert_eq!(read_u32(&a, 16), FAST.t_cost);
        assert_eq!(read_u32(&a, 20), FAST.p_cost);
        // 別のパスフレーズからは別の鍵 = 別の暗号文。
        let c = seal_with(b"abc", "pw-12346", FAST, &salt, &nonce).unwrap();
        assert_ne!(a[HEADER_LEN..], c[HEADER_LEN..]);
    }

    #[test]
    fn wrong_passphrase_is_rejected() {
        let file = seal(b"data", "correct horse", FAST).unwrap();
        assert_eq!(
            open(&file, "wrong horse").unwrap_err(),
            BackupError::DecryptFailed
        );
        assert_eq!(open(&file, "").unwrap_err(), BackupError::DecryptFailed);
    }

    #[test]
    fn any_tampered_byte_is_rejected() {
        let file = seal(b"some payload bytes", "correct horse", FAST).unwrap();
        // ソルト・ノンス・暗号文・タグのどのバイトを反転しても認証で落ちる。
        for i in 24..file.len() {
            let mut t = file.clone();
            t[i] ^= 0x01;
            assert_eq!(
                open(&t, "correct horse").unwrap_err(),
                BackupError::DecryptFailed,
                "byte {i} flip was not detected"
            );
        }
        // KDF パラメータの改ざんも (範囲内なら) 鍵が変わる + AAD 不一致で落ちる。
        let mut t = file.clone();
        t[16] = 2; // t_cost 1 -> 2
        assert_eq!(
            open(&t, "correct horse").unwrap_err(),
            BackupError::DecryptFailed
        );
        // 予約バイトの改ざんは形式エラー。
        let mut t = file.clone();
        t[11] = 1;
        assert_eq!(
            open(&t, "correct horse").unwrap_err(),
            BackupError::UnsupportedAlgorithm
        );
    }

    #[test]
    fn truncated_file_is_rejected() {
        let file = seal(b"payload", "correct horse", FAST).unwrap();
        assert_eq!(
            open(&file[..HEADER_LEN + TAG_LEN - 1], "correct horse").unwrap_err(),
            BackupError::Truncated
        );
        assert_eq!(
            open(&file[..9], "correct horse").unwrap_err(),
            BackupError::Truncated
        );
        assert_eq!(
            open(&file[..8], "correct horse").unwrap_err(),
            BackupError::Truncated
        );
        // 末尾 1 バイト欠けはタグ不一致。
        assert_eq!(
            open(&file[..file.len() - 1], "correct horse").unwrap_err(),
            BackupError::DecryptFailed
        );
    }

    #[test]
    fn non_backup_files_are_classified() {
        assert_eq!(
            open(b"  {\"format\":\"noobdb-profiles\"}", "x").unwrap_err(),
            BackupError::NotABackup {
                looks_like_json: true
            }
        );
        assert_eq!(
            open(b"PK\x03\x04zip", "x").unwrap_err(),
            BackupError::NotABackup {
                looks_like_json: false
            }
        );
        assert_eq!(
            open(b"", "x").unwrap_err(),
            BackupError::NotABackup {
                looks_like_json: false
            }
        );
    }

    #[test]
    fn future_version_is_rejected_with_update_hint() {
        let mut file = seal(b"payload", "correct horse", FAST).unwrap();
        file[8] = 2;
        let err = open(&file, "correct horse").unwrap_err();
        assert_eq!(err, BackupError::UnsupportedVersion(2));
        assert!(err.to_string().contains("Update noobDB"));
        // バージョン 0 (存在しない旧形式) も拒否。
        file[8] = 0;
        assert_eq!(
            open(&file, "correct horse").unwrap_err(),
            BackupError::UnsupportedVersion(0)
        );
    }

    #[test]
    fn unknown_algorithm_ids_are_rejected() {
        let file = seal(b"payload", "correct horse", FAST).unwrap();
        for idx in [9usize, 10] {
            let mut t = file.clone();
            t[idx] = 9;
            assert_eq!(
                open(&t, "correct horse").unwrap_err(),
                BackupError::UnsupportedAlgorithm
            );
        }
    }

    #[test]
    fn out_of_range_kdf_params_are_rejected_before_deriving() {
        let file = seal(b"payload", "correct horse", FAST).unwrap();
        let mut t = file.clone();
        t[12..16].copy_from_slice(&(MAX_M_COST_KIB + 1).to_le_bytes());
        assert_eq!(
            open(&t, "correct horse").unwrap_err(),
            BackupError::KdfParamsOutOfRange
        );
        let mut t = file.clone();
        t[16..20].copy_from_slice(&0u32.to_le_bytes());
        assert_eq!(
            open(&t, "correct horse").unwrap_err(),
            BackupError::KdfParamsOutOfRange
        );
        let mut t = file.clone();
        t[20..24].copy_from_slice(&(MAX_P_COST + 1).to_le_bytes());
        assert_eq!(
            open(&t, "correct horse").unwrap_err(),
            BackupError::KdfParamsOutOfRange
        );
        // m < 8p も拒否。
        let mut t = file.clone();
        t[12..16].copy_from_slice(&8u32.to_le_bytes());
        t[20..24].copy_from_slice(&2u32.to_le_bytes());
        assert_eq!(
            open(&t, "correct horse").unwrap_err(),
            BackupError::KdfParamsOutOfRange
        );
    }

    #[test]
    fn default_params_are_within_accepted_range() {
        check_params(KdfParams::DEFAULT).unwrap();
        assert_eq!(KdfParams::DEFAULT.m_cost_kib, 65536);
        assert_eq!(KdfParams::DEFAULT.t_cost, 3);
        assert_eq!(KdfParams::DEFAULT.p_cost, 1);
    }

    #[test]
    fn payload_round_trip_keeps_secrets_and_unset_state() {
        let file = seal_payload(
            vec![entry("a", Some("s3cret!")), entry("b", None)],
            "correct horse",
            FAST,
        )
        .unwrap();
        let payload = open_payload(&file, "correct horse").unwrap();
        assert_eq!(payload.profiles.len(), 2);
        assert_eq!(payload.profiles[0].profile.id, "a");
        assert_eq!(
            payload.profiles[0].secrets.get("db_password"),
            Some("s3cret!")
        );
        assert_eq!(payload.profiles[0].secrets.count(), 1);
        // 秘密なしのプロファイルは「未設定」のまま往復する。
        assert_eq!(payload.profiles[1].secrets.count(), 0);
        assert_eq!(payload.profiles[1].secrets.get("db_password"), None);
    }

    #[test]
    fn export_passphrase_minimum_is_enforced() {
        assert_eq!(
            seal_payload(vec![], "short", FAST).unwrap_err(),
            BackupError::WeakPassphrase
        );
        // 文字数は Unicode スカラ値で数える (マルチバイトでも 8 文字で可)。
        validate_export_passphrase("パスフレーズ八文字").unwrap();
        assert!(validate_export_passphrase("1234567").is_err());
        validate_export_passphrase("12345678").unwrap();
    }

    #[test]
    fn payload_with_wrong_format_is_rejected() {
        let file = seal(
            br#"{"format":"other","version":1,"profiles":[]}"#,
            "correct horse",
            FAST,
        )
        .unwrap();
        assert!(matches!(
            open_payload(&file, "correct horse").unwrap_err(),
            BackupError::InvalidPayload(_)
        ));
        let file = seal(
            br#"{"format":"noobdb-profiles-encrypted","version":7,"profiles":[]}"#,
            "correct horse",
            FAST,
        )
        .unwrap();
        assert_eq!(
            open_payload(&file, "correct horse").unwrap_err(),
            BackupError::UnsupportedVersion(7)
        );
    }

    #[test]
    fn malformed_payload_error_does_not_echo_content() {
        let file = seal(br#"{"format": hunter2-secret"#, "correct horse", FAST).unwrap();
        let err = open_payload(&file, "correct horse")
            .unwrap_err()
            .to_string();
        assert!(!err.contains("hunter2"), "{err}");
    }

    #[test]
    fn debug_output_never_shows_secret_values() {
        let e = entry("a", Some("top-secret-value"));
        let dbg = format!("{e:?}");
        assert!(!dbg.contains("top-secret-value"), "{dbg}");
    }

    #[test]
    fn secrets_set_treats_empty_as_unset_and_ignores_unknown_kinds() {
        let mut s = BackupSecrets::default();
        s.set("ssh_password", Some(String::new()));
        assert_eq!(s.get("ssh_password"), None);
        s.set("unknown_kind", Some("x".into()));
        assert_eq!(s.count(), 0);
        s.set("ssh_password_hop0", Some("v".into()));
        assert_eq!(s.get("ssh_password_hop0"), Some("v"));
    }

    #[test]
    fn error_messages_never_contain_passphrase() {
        let file = seal(b"x", "my-private-passphrase", FAST).unwrap();
        let err = open(&file, "my-private-passphrase-typo")
            .unwrap_err()
            .to_string();
        assert!(!err.contains("my-private"), "{err}");
    }
}
