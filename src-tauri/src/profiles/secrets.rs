use keyring::Entry;

use crate::error::Result;

const SERVICE: &str = "noobDB";

fn target(profile_id: &str, kind: &str) -> String {
    format!("{profile_id}/{kind}")
}

/// Stores a secret in the OS keyring. Only the profile id and the secret *kind*
/// are ever logged — never the value itself.
fn set_secret(profile_id: &str, kind: &str, value: &str) -> Result<()> {
    let entry = Entry::new(SERVICE, &target(profile_id, kind))?;
    match entry.set_password(value) {
        Ok(()) => Ok(()),
        Err(e) => {
            tracing::error!(profile_id, kind, error = %e, "keyring: failed to set secret");
            Err(e.into())
        }
    }
}

/// Reads a secret. A missing entry (`NoEntry`) is normal and returns `None`
/// without logging; any other failure is logged as an error.
fn get_secret(profile_id: &str, kind: &str) -> Result<Option<String>> {
    let entry = Entry::new(SERVICE, &target(profile_id, kind))?;
    match entry.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => {
            tracing::error!(profile_id, kind, error = %e, "keyring: failed to read secret");
            Err(e.into())
        }
    }
}

/// Deletes a secret. A missing entry is treated as success; other failures are
/// logged as errors.
fn delete_secret(profile_id: &str, kind: &str) -> Result<()> {
    let entry = Entry::new(SERVICE, &target(profile_id, kind))?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => {
            tracing::error!(profile_id, kind, error = %e, "keyring: failed to delete secret");
            Err(e.into())
        }
    }
}

/// Returns whether a secret of `kind` exists for the profile, without exposing
/// the value. A read failure (other than a missing entry) degrades to `false`
/// since callers use this only as a display hint; `get_secret` already logged
/// the underlying error.
fn has_secret(profile_id: &str, kind: &str) -> bool {
    matches!(get_secret(profile_id, kind), Ok(Some(_)))
}

pub fn set_db_password(profile_id: &str, password: &str) -> Result<()> {
    set_secret(profile_id, "db_password", password)
}

pub fn get_db_password(profile_id: &str) -> Result<Option<String>> {
    get_secret(profile_id, "db_password")
}

pub fn has_db_password(profile_id: &str) -> bool {
    has_secret(profile_id, "db_password")
}

pub fn delete_db_password(profile_id: &str) -> Result<()> {
    delete_secret(profile_id, "db_password")
}

pub fn set_ssh_passphrase(profile_id: &str, passphrase: &str) -> Result<()> {
    set_secret(profile_id, "ssh_passphrase", passphrase)
}

pub fn get_ssh_passphrase(profile_id: &str) -> Result<Option<String>> {
    get_secret(profile_id, "ssh_passphrase")
}

pub fn has_ssh_passphrase(profile_id: &str) -> bool {
    has_secret(profile_id, "ssh_passphrase")
}

pub fn delete_ssh_passphrase(profile_id: &str) -> Result<()> {
    delete_secret(profile_id, "ssh_passphrase")
}

pub fn set_ssh_password(profile_id: &str, password: &str) -> Result<()> {
    set_secret(profile_id, "ssh_password", password)
}

pub fn get_ssh_password(profile_id: &str) -> Result<Option<String>> {
    get_secret(profile_id, "ssh_password")
}

pub fn has_ssh_password(profile_id: &str) -> bool {
    has_secret(profile_id, "ssh_password")
}

pub fn delete_ssh_password(profile_id: &str) -> Result<()> {
    delete_secret(profile_id, "ssh_password")
}

/// The bastion/jump hop's secrets (#708) use a `_hop0` suffix so they live
/// alongside — never collide with — the main SSH hop's `ssh_passphrase` /
/// `ssh_password` entries above, which keep their pre-#708 kind names for
/// backward compatibility with profiles saved before multi-hop existed.
pub fn set_ssh_jump_passphrase(profile_id: &str, passphrase: &str) -> Result<()> {
    set_secret(profile_id, "ssh_passphrase_hop0", passphrase)
}

pub fn get_ssh_jump_passphrase(profile_id: &str) -> Result<Option<String>> {
    get_secret(profile_id, "ssh_passphrase_hop0")
}

pub fn has_ssh_jump_passphrase(profile_id: &str) -> bool {
    has_secret(profile_id, "ssh_passphrase_hop0")
}

pub fn delete_ssh_jump_passphrase(profile_id: &str) -> Result<()> {
    delete_secret(profile_id, "ssh_passphrase_hop0")
}

pub fn set_ssh_jump_password(profile_id: &str, password: &str) -> Result<()> {
    set_secret(profile_id, "ssh_password_hop0", password)
}

pub fn get_ssh_jump_password(profile_id: &str) -> Result<Option<String>> {
    get_secret(profile_id, "ssh_password_hop0")
}

pub fn has_ssh_jump_password(profile_id: &str) -> bool {
    has_secret(profile_id, "ssh_password_hop0")
}

pub fn delete_ssh_jump_password(profile_id: &str) -> Result<()> {
    delete_secret(profile_id, "ssh_password_hop0")
}

/// keyring に置く秘密の kind 文字列の全件 (#710 の暗号化バックアップが
/// プロファイルごとに列挙して読み書きする)。新しい秘密の種類を足すときはここと
/// `commands::profiles::SecretKind` / フロントの `ProfileSecretKind` /
/// `backup::BackupSecrets` を揃えること。
pub const ALL_KINDS: [&str; 5] = [
    "db_password",
    "ssh_passphrase",
    "ssh_password",
    "ssh_passphrase_hop0",
    "ssh_password_hop0",
];

/// kind 文字列で秘密を読む (#710)。値はログに出さない。
pub fn get_kind(profile_id: &str, kind: &str) -> Result<Option<String>> {
    get_secret(profile_id, kind)
}

/// kind 文字列で秘密を書く (#710)。
pub fn set_kind(profile_id: &str, kind: &str, value: &str) -> Result<()> {
    set_secret(profile_id, kind, value)
}

/// kind 文字列で秘密を消す (#710)。未登録は成功扱い。
pub fn delete_kind(profile_id: &str, kind: &str) -> Result<()> {
    delete_secret(profile_id, kind)
}

pub fn delete_all(profile_id: &str) -> Result<()> {
    delete_db_password(profile_id)?;
    delete_ssh_passphrase(profile_id)?;
    delete_ssh_password(profile_id)?;
    delete_ssh_jump_passphrase(profile_id)?;
    delete_ssh_jump_password(profile_id)?;
    Ok(())
}

/// エクスポート時の仮名化 (#733) に使うアプリ単位のソルトの keyring 上の位置。
/// プロファイル ID は `new_profile_id` の英数字 8 文字なので、`export-masking` という
/// 名前空間とは衝突しない。
const EXPORT_MASK_NAMESPACE: &str = "export-masking";
const EXPORT_MASK_SALT_KIND: &str = "hash_salt";
/// ソルトのバイト長 (HMAC-SHA256 のブロック長未満で十分なエントロピー)。
const EXPORT_MASK_SALT_BYTES: usize = 32;

/// 初回生成の競合 (2 本のエクスポートが同時に「未作成」を観測して別々のソルトを書く)
/// を防ぐ直列化。敗者のエクスポートだけ別の仮名になるのを避ける。
static EXPORT_MASK_SALT_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// エクスポートの仮名化 (`hash` ルール) に使うソルトを keyring から取り出す。無ければ
/// 乱数で生成して保存してから返す。
///
/// **ソルトは秘密情報として OS keyring にのみ置く** — `profiles.json`・設定
/// (localStorage)・ログ・フロントエンドには出さない (値を返すのはバックエンド内部の
/// マスキング処理だけで、IPC では返さない)。ソルトが漏れると、同じ仮名を持つ値を
/// 辞書から総当たりで復元できるようになるため。keyring のエントリを削除すると次回の
/// エクスポートで新しいソルトが作られ、以降の仮名は以前のファイルと結合できなくなる。
pub fn get_or_create_export_mask_salt() -> Result<Vec<u8>> {
    use rand::RngExt;
    let _guard = EXPORT_MASK_SALT_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(hex) = get_secret(EXPORT_MASK_NAMESPACE, EXPORT_MASK_SALT_KIND)? {
        if !hex.is_empty() {
            return Ok(hex.into_bytes());
        }
    }
    let mut rng = rand::rng();
    let bytes: Vec<u8> = (0..EXPORT_MASK_SALT_BYTES)
        .map(|_| rng.random::<u8>())
        .collect();
    let hex = data_encoding::HEXLOWER.encode(&bytes);
    set_secret(EXPORT_MASK_NAMESPACE, EXPORT_MASK_SALT_KIND, &hex)?;
    tracing::info!("keyring: generated a new export masking salt");
    Ok(hex.into_bytes())
}
