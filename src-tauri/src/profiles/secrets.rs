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

pub fn get_db_password(profile_id: &str) -> Result<Option<String>> {
    get_secret(profile_id, "db_password")
}

pub fn has_db_password(profile_id: &str) -> bool {
    has_secret(profile_id, "db_password")
}

pub fn delete_db_password(profile_id: &str) -> Result<()> {
    delete_secret(profile_id, "db_password")
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
pub fn get_ssh_jump_passphrase(profile_id: &str) -> Result<Option<String>> {
    get_secret(profile_id, "ssh_passphrase_hop0")
}

pub fn has_ssh_jump_passphrase(profile_id: &str) -> bool {
    has_secret(profile_id, "ssh_passphrase_hop0")
}

pub fn delete_ssh_jump_passphrase(profile_id: &str) -> Result<()> {
    delete_secret(profile_id, "ssh_passphrase_hop0")
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

/// AI 基盤 (#690) の Anthropic API キー。プロファイルに属さないので、プロファイル ID の
/// 代わりに固定の名前空間 `ai` を使い、keyring 上は `ai/anthropic_api_key` になる
/// (プロファイル ID は英数字 8 文字なので衝突しない)。`profiles.json`・設定ストア・
/// ログには一切出さず、値を返すのはバックエンド内部の API 呼び出しだけ (IPC では
/// 「設定済みか」の bool しか返さない)。
const AI_NAMESPACE: &str = "ai";
const AI_API_KEY_KIND: &str = "anthropic_api_key";

pub fn set_ai_api_key(key: &str) -> Result<()> {
    set_secret(AI_NAMESPACE, AI_API_KEY_KIND, key)
}

pub fn get_ai_api_key() -> Result<Option<String>> {
    get_secret(AI_NAMESPACE, AI_API_KEY_KIND)
}

pub fn has_ai_api_key() -> bool {
    has_secret(AI_NAMESPACE, AI_API_KEY_KIND)
}

pub fn delete_ai_api_key() -> Result<()> {
    delete_secret(AI_NAMESPACE, AI_API_KEY_KIND)
}

pub fn delete_all(profile_id: &str) -> Result<()> {
    // 1 件が失敗しても残りの秘密は消す (孤立した秘密を keyring に残さない)。
    // 最初のエラーを返す。
    let results = [
        delete_db_password(profile_id),
        delete_ssh_passphrase(profile_id),
        delete_ssh_password(profile_id),
        delete_ssh_jump_passphrase(profile_id),
        delete_ssh_jump_password(profile_id),
    ];
    results.into_iter().collect::<Result<Vec<()>>>().map(|_| ())
}

/// エクスポート時の仮名化 (#733) に使うアプリ単位のソルトの keyring 上の位置。
/// プロファイル ID は `new_profile_id` の英数字 8 文字なので、`export-masking` という
/// 名前空間とは衝突しない。
const EXPORT_MASK_NAMESPACE: &str = "export-masking";
const EXPORT_MASK_SALT_KIND: &str = "hash_salt";
/// ソルトのバイト長 (HMAC-SHA256 のブロック長未満で十分なエントロピー)。
const EXPORT_MASK_SALT_BYTES: usize = 32;

/// OS keyring の疎通診断の結果 (#1622)。**秘密・エラー本文は含めない** — 失敗の理由は
/// 固定の分類コード (`reason`) だけで返す。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct KeyringStatus {
    pub available: bool,
    /// `None` なら正常。それ以外は `storage_unavailable` (Secret Service 等が無い) /
    /// `platform_failure` / `readback_missing` / `readback_mismatch` / `other`。
    pub reason: Option<&'static str>,
}

/// keyring のエラーを、本文を含まない固定コードへ分類する。
fn classify_keyring_error(e: &keyring::Error) -> &'static str {
    match e {
        keyring::Error::NoStorageAccess(_) => "storage_unavailable",
        keyring::Error::PlatformFailure(_) => "platform_failure",
        keyring::Error::NoEntry => "readback_missing",
        _ => "other",
    }
}

/// 診断用の一時エントリ名。固定にして、異常終了で残っても 1 件に収まるようにする。
const PROBE_TARGET: &str = "diagnostics/probe";
/// 診断で書く非秘密の値。
const PROBE_VALUE: &str = "noobdb-keyring-probe";

/// 診断結果のキャッシュ。ロックを持ったまま診断を実行するので、同時に呼ばれても書き込みは 1 回。
static KEYRING_STATUS: std::sync::Mutex<Option<KeyringStatus>> = std::sync::Mutex::new(None);

/// 診断済みならその結果を返す (書き込みはしない)。診断バンドルが使う。診断の実行中
/// (ロック保持中) は待たずに `None` (= 未確認扱い) を返し、async コマンドのワーカーを止めない。
pub fn cached_keyring_status() -> Option<KeyringStatus> {
    match KEYRING_STATUS.try_lock() {
        Ok(g) => g.clone(),
        Err(std::sync::TryLockError::Poisoned(e)) => e.into_inner().clone(),
        Err(std::sync::TryLockError::WouldBlock) => None,
    }
}

/// keyring の疎通診断を、プロセスで最初の 1 回だけ実行してキャッシュする。接続フォームで
/// パスワード欄 (保存先 = keyring) を初めて描画したときに呼ぶ。起動時には呼ばない。
pub fn check_keyring_once() -> KeyringStatus {
    let mut guard = KEYRING_STATUS.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(s) = guard.as_ref() {
        return s.clone();
    }
    let status = probe_keyring();
    *guard = Some(status.clone());
    status
}

/// 一時エントリを書いて読み戻し、削除する (パスワード保存の前に使えるかを確認する)。
/// 書く値は非秘密の固定文字列で、実プロファイルの秘密には触れない。
fn probe_keyring() -> KeyringStatus {
    let fail = |reason: &'static str| KeyringStatus {
        available: false,
        reason: Some(reason),
    };
    let entry = match Entry::new(SERVICE, PROBE_TARGET) {
        Ok(e) => e,
        Err(e) => return fail(classify_keyring_error(&e)),
    };
    if let Err(e) = entry.set_password(PROBE_VALUE) {
        return fail(classify_keyring_error(&e));
    }
    let result = match entry.get_password() {
        Ok(v) if v == PROBE_VALUE => None,
        Ok(_) => Some("readback_mismatch"),
        Err(e) => Some(classify_keyring_error(&e)),
    };
    // 後始末の失敗は診断結果に影響させない (残っても固定名の無害な 1 件)。
    let _ = entry.delete_credential();
    match result {
        None => KeyringStatus {
            available: true,
            reason: None,
        },
        Some(r) => fail(r),
    }
}

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

#[cfg(test)]
mod probe_tests {
    use super::*;

    #[test]
    fn classify_maps_errors_to_fixed_codes_without_text() {
        assert_eq!(
            classify_keyring_error(&keyring::Error::NoEntry),
            "readback_missing"
        );
        assert_eq!(
            classify_keyring_error(&keyring::Error::TooLong("x".into(), 1)),
            "other"
        );
        assert_eq!(
            classify_keyring_error(&keyring::Error::NoStorageAccess("secret".into())),
            "storage_unavailable"
        );
    }

    #[test]
    #[ignore = "実 OS keyring に書き込むため手動実行 (cargo test -- --ignored)"]
    fn probe_reports_a_consistent_status() {
        // 実 keyring の有無は環境依存。available と reason が矛盾しないことだけ確認する。
        let st = probe_keyring();
        assert_eq!(st.available, st.reason.is_none());
        // CI の Windows スモーク (#1945) は本物の Credential Manager がある前提なので、
        // NOOBDB_REQUIRE_KEYRING=1 のときは書き込みと読み戻しの成功まで要求する。
        // 未設定なら従来どおり整合性だけを見る (keyring の無い Linux 開発機で落とさない)。
        if std::env::var("NOOBDB_REQUIRE_KEYRING").as_deref() == Ok("1") {
            assert!(
                st.available,
                "keyring に書き込み・読み戻しできませんでした: {:?}",
                st.reason
            );
        }
    }
}
