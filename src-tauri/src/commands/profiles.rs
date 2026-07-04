use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};
use crate::profiles::store::{self, new_profile_id};
use crate::profiles::{secrets, ConnectionProfile, SshProfile};

#[derive(Debug, Deserialize)]
pub struct SaveProfileRequest {
    /// If empty/None a new id is generated.
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    pub driver: String,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub port: u16,
    #[serde(default)]
    pub user: String,
    #[serde(default)]
    pub database: Option<String>,
    #[serde(default)]
    pub ssh: Option<SshProfile>,
    /// If Some, password is stored in the OS keyring; if None, no change.
    /// Empty string clears the stored password.
    #[serde(default)]
    pub db_password: Option<String>,
    /// Same semantics for the SSH passphrase.
    #[serde(default)]
    pub ssh_passphrase: Option<String>,
    /// Same semantics for the SSH password (password auth method).
    #[serde(default)]
    pub ssh_password: Option<String>,
    #[serde(default)]
    pub group: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub is_production: bool,
    #[serde(default)]
    pub confirm_writes: bool,
    #[serde(default)]
    pub read_only: bool,
    #[serde(default)]
    pub skip_history: bool,
    /// Required for file-backed drivers (SQLite); ignored otherwise.
    #[serde(default)]
    pub file_path: Option<String>,
    /// TLS requirement level. `None` keeps the driver default.
    #[serde(default)]
    pub ssl_mode: Option<crate::db::SslMode>,
    /// CA (root) certificate file path. Non-secret; stored in profiles.json.
    #[serde(default)]
    pub ssl_root_cert: Option<String>,
    /// Client certificate file path for mutual TLS.
    #[serde(default)]
    pub ssl_client_cert: Option<String>,
    /// Client private key file path for mutual TLS.
    #[serde(default)]
    pub ssl_client_key: Option<String>,
    /// Session-initialization SQL run right after each connection is established.
    #[serde(default)]
    pub init_sql: Option<String>,
}

/// A stored profile plus flags telling the UI which secrets already exist in the
/// keyring. The secret *values* never leave the backend; only their presence is
/// reported so the form can show a masked indicator instead of an empty field.
/// `ConnectionProfile` is flattened so the wire shape stays a superset of the
/// plain profile (the extra `has_*` fields are not persisted to profiles.json).
#[derive(Debug, Clone, Serialize)]
pub struct ProfileWithSecretFlags {
    #[serde(flatten)]
    pub profile: ConnectionProfile,
    pub has_db_password: bool,
    pub has_ssh_passphrase: bool,
    pub has_ssh_password: bool,
}

#[tauri::command]
pub async fn list_profiles() -> Result<Vec<ProfileWithSecretFlags>> {
    let profiles = store::load_all()?;
    Ok(profiles
        .into_iter()
        .map(|profile| {
            let has_db_password = secrets::has_db_password(&profile.id);
            let has_ssh_passphrase = secrets::has_ssh_passphrase(&profile.id);
            let has_ssh_password = secrets::has_ssh_password(&profile.id);
            ProfileWithSecretFlags {
                profile,
                has_db_password,
                has_ssh_passphrase,
                has_ssh_password,
            }
        })
        .collect())
}

#[tauri::command]
pub async fn save_profile(req: SaveProfileRequest) -> Result<ConnectionProfile> {
    let id = req
        .id
        .clone()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(new_profile_id);
    let result = save_profile_inner(id.clone(), req);
    match &result {
        Ok(_) => tracing::info!(profile_id = %id, "profile saved"),
        Err(e) => tracing::error!(profile_id = %id, error = %e, "failed to save profile"),
    }
    result
}

/// Persists the profile row and any changed secrets. The secret *values* are
/// never logged — only which secret kind was set or cleared, at debug level.
fn save_profile_inner(id: String, req: SaveProfileRequest) -> Result<ConnectionProfile> {
    let profile = ConnectionProfile {
        id: id.clone(),
        name: req.name,
        driver: req.driver,
        host: req.host,
        port: req.port,
        user: req.user,
        database: req.database,
        ssh: req.ssh,
        group: req.group.filter(|s| !s.is_empty()),
        color: req.color.filter(|s| !s.is_empty()),
        is_production: req.is_production,
        confirm_writes: req.confirm_writes,
        read_only: req.read_only,
        skip_history: req.skip_history,
        file_path: req.file_path.filter(|s| !s.is_empty()),
        // Trim before the empty check so a whitespace-only path is stored as
        // "unset", matching how the connect path normalizes it (`non_empty`).
        ssl_mode: req.ssl_mode,
        ssl_root_cert: req
            .ssl_root_cert
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()),
        ssl_client_cert: req
            .ssl_client_cert
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()),
        ssl_client_key: req
            .ssl_client_key
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()),
        init_sql: req.init_sql.filter(|s| !s.trim().is_empty()),
    };
    store::upsert(profile.clone())?;

    if let Some(pw) = req.db_password {
        if pw.is_empty() {
            tracing::debug!(profile_id = %id, secret = "db_password", "clearing secret");
            secrets::delete_db_password(&id)?;
        } else {
            tracing::debug!(profile_id = %id, secret = "db_password", "setting secret");
            secrets::set_db_password(&id, &pw)?;
        }
    }
    if let Some(pp) = req.ssh_passphrase {
        if pp.is_empty() {
            tracing::debug!(profile_id = %id, secret = "ssh_passphrase", "clearing secret");
            secrets::delete_ssh_passphrase(&id)?;
        } else {
            tracing::debug!(profile_id = %id, secret = "ssh_passphrase", "setting secret");
            secrets::set_ssh_passphrase(&id, &pp)?;
        }
    }
    if let Some(pw) = req.ssh_password {
        if pw.is_empty() {
            tracing::debug!(profile_id = %id, secret = "ssh_password", "clearing secret");
            secrets::delete_ssh_password(&id)?;
        } else {
            tracing::debug!(profile_id = %id, secret = "ssh_password", "setting secret");
            secrets::set_ssh_password(&id, &pw)?;
        }
    }
    Ok(profile)
}

/// エクスポートファイルのトップレベル形。`profiles` は `ConnectionProfile`
/// (= profiles.json と同じ非秘密フィールドのみ) の配列。**秘密情報 (パスワード /
/// パスフレーズ) は OS keyring に分離保存されており、この構造体にもエクスポート
/// JSON にも一切含まれない** (CLAUDE.md の秘密分離ポリシー)。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileExport {
    /// 形式識別子。インポート時の取り違え防止に使う。
    pub format: String,
    /// スキーマバージョン。将来の互換用。
    pub version: u32,
    /// 秘密情報が含まれない旨を人間に明示する注記。
    pub note: String,
    pub profiles: Vec<ConnectionProfile>,
}

const EXPORT_FORMAT: &str = "noobdb-profiles";
const EXPORT_VERSION: u32 = 1;
const EXPORT_NOTE: &str =
    "This file contains connection profiles WITHOUT any secrets (passwords / passphrases). \
     Re-enter credentials after importing.";

/// ID 衝突時の取り込み戦略。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ImportStrategy {
    /// 衝突する ID は新しい ID を採番して取り込む (既存を温存)。
    Rename,
    /// 衝突する ID はスキップする (既存を温存)。
    Skip,
    /// 衝突する ID は上書きする。
    Overwrite,
}

/// インポート結果の要約。UI のトースト表示に使う。
#[derive(Debug, Clone, Serialize)]
pub struct ImportResult {
    pub imported: usize,
    pub skipped: usize,
    pub overwritten: usize,
    pub invalid: usize,
}

fn is_known_driver(driver: &str) -> bool {
    matches!(driver, "mysql" | "postgres" | "sqlite")
}

/// インポートされたプロファイル群を既存リストへ統合する純粋ロジック。ストレージに
/// 触れないのでユニットテストできる。`gen_id` は ID 衝突時 (Rename) や ID 欠落時に
/// 新 ID を採番するクロージャ (本番は `new_profile_id`、テストは決定的なカウンタ)。
/// 3 つ目の戻り値は Overwrite で本体を差し替えた既存プロファイルの id 一覧 —
/// これらは呼び出し元 (`import_profiles`) が keyring の秘密を消すのに使う
/// (インポートされるプロファイルは秘密を含まないため、host/user が変わった旧
/// keyring エントリを新プロファイル宛に誤って引き継がないようにするため。#H4)。
/// Rename で新規採番される経路は別 id なので既存秘密に影響しない。
fn merge_imported(
    mut all: Vec<ConnectionProfile>,
    imported: Vec<ConnectionProfile>,
    strategy: ImportStrategy,
    mut gen_id: impl FnMut() -> String,
) -> (Vec<ConnectionProfile>, ImportResult, Vec<String>) {
    let mut result = ImportResult {
        imported: 0,
        skipped: 0,
        overwritten: 0,
        invalid: 0,
    };
    let mut overwritten_ids = Vec::new();
    for mut profile in imported {
        if profile.name.trim().is_empty() || !is_known_driver(&profile.driver) {
            result.invalid += 1;
            continue;
        }
        let collides = !profile.id.is_empty() && all.iter().any(|p| p.id == profile.id);
        if collides {
            match strategy {
                ImportStrategy::Skip => {
                    result.skipped += 1;
                    continue;
                }
                ImportStrategy::Overwrite => {
                    if let Some(existing) = all.iter_mut().find(|p| p.id == profile.id) {
                        overwritten_ids.push(profile.id.clone());
                        *existing = profile;
                    }
                    result.overwritten += 1;
                    continue;
                }
                ImportStrategy::Rename => {
                    profile.id = gen_id();
                }
            }
        } else if profile.id.is_empty() {
            // Defensive: a hand-edited file might omit ids.
            profile.id = gen_id();
        }
        all.push(profile);
        result.imported += 1;
    }
    (all, result, overwritten_ids)
}

/// 指定 (または全) プロファイルを秘密情報抜きで JSON 化する純粋ロジック。`ids` が
/// `None`/空なら全件。存在しない ID は無視する。ファイル IO に触れずテストできる。
fn build_export_json(all: Vec<ConnectionProfile>, ids: Option<Vec<String>>) -> Result<String> {
    let selected: Vec<ConnectionProfile> = match ids {
        Some(ids) if !ids.is_empty() => all
            .into_iter()
            .filter(|p| ids.iter().any(|id| id == &p.id))
            .collect(),
        _ => all,
    };
    let export = ProfileExport {
        format: EXPORT_FORMAT.to_string(),
        version: EXPORT_VERSION,
        note: EXPORT_NOTE.to_string(),
        profiles: selected,
    };
    Ok(serde_json::to_string_pretty(&export)?)
}

/// 指定 (または全) プロファイルを秘密情報抜きで `path` に JSON 出力する。返り値は
/// 書き込んだバイト数。`ids` が `None`/空のときは全件。ファイルへの書き込みは
/// バックエンドが行う (フロントは dialog でパスを選ぶだけ。fs capability 不要)。
#[tauri::command]
pub async fn export_profiles(path: String, ids: Option<Vec<String>>) -> Result<usize> {
    let all = store::load_all()?;
    let json = build_export_json(all, ids)?;
    std::fs::write(&path, &json)?;
    tracing::info!(path = %path, "profiles exported");
    Ok(json.len())
}

/// `path` の JSON (`export_profiles` 出力) を取り込む。形式を検証し、ドライバ不正な
/// 行はスキップ、ID 衝突は `strategy` に従って解決する。**秘密情報は JSON に含まれ
/// ないため、取り込んだプロファイルは資格情報未設定として扱われ、接続時に再入力が
/// 促される。** ファイルの読み取りはバックエンドが行う (fs capability 不要)。
#[tauri::command]
pub async fn import_profiles(path: String, strategy: ImportStrategy) -> Result<ImportResult> {
    let content = std::fs::read_to_string(&path)?;
    let parsed: ProfileExport = serde_json::from_str(&content)
        .map_err(|e| AppError::InvalidInput(format!("Invalid profile export file: {e}")))?;
    if parsed.format != EXPORT_FORMAT {
        return Err(AppError::InvalidInput(format!(
            "Unrecognized profile export format: {}",
            parsed.format
        )));
    }

    let all = store::load_all()?;
    let (merged, result, overwritten_ids) =
        merge_imported(all, parsed.profiles, strategy, new_profile_id);
    store::save_all(&merged)?;
    // Overwrite で本体を差し替えた既存プロファイルの keyring 秘密を消す。
    // インポートされるプロファイル本体には秘密が含まれないため (エクスポート
    // 注記のとおり)、host/user が変わっていた場合に旧サーバ向けパスワードが
    // 新しい接続先へ誤って使い回されるのを防ぐ (#H4)。次回接続時は資格情報の
    // 再入力が必要になるが、これは export/import の既知の制約と整合する。
    for id in &overwritten_ids {
        if let Err(e) = secrets::delete_all(id) {
            tracing::warn!(profile_id = %id, error = %e, "failed to clear keyring secrets for overwritten profile");
        }
    }
    tracing::info!(
        imported = result.imported,
        skipped = result.skipped,
        overwritten = result.overwritten,
        invalid = result.invalid,
        "profiles imported"
    );
    Ok(result)
}

#[tauri::command]
pub async fn delete_profile(id: String) -> Result<()> {
    let result = delete_profile_ordered(&id, store::delete, secrets::delete_all);
    match &result {
        Ok(()) => tracing::info!(profile_id = %id, "profile deleted"),
        Err(e) => tracing::error!(profile_id = %id, error = %e, "failed to delete profile"),
    }
    result
}

/// プロファイル削除の順序を切り出した純粋ロジック (#H5)。**先にプロファイル本体
/// (`store_delete`) を削除し、それが成功した後にのみ keyring の秘密
/// (`secrets_delete`) を消す。** 逆順だと `store_delete` が失敗したときに
/// 「プロファイルは残っているのに秘密だけ消えている」という不整合な状態になる。
/// この順序なら store 削除が失敗しても秘密は残り、プロファイルも残るので整合性
/// が保たれる。孤立 keyring エントリ防止という元の意図 (プロファイルが消えたのに
/// 秘密が残る) は、store 削除成功後に secrets を消すことで引き続き達成される。
/// 呼び出しをクロージャとして受け取ることで、実ファイル/keyring に触れずに
/// 呼び出し順序をユニットテストできる。
fn delete_profile_ordered(
    id: &str,
    store_delete: impl FnOnce(&str) -> Result<()>,
    secrets_delete: impl FnOnce(&str) -> Result<()>,
) -> Result<()> {
    store_delete(id)?;
    secrets_delete(id)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(id: &str, name: &str, driver: &str) -> ConnectionProfile {
        ConnectionProfile {
            id: id.to_string(),
            name: name.to_string(),
            driver: driver.to_string(),
            host: "localhost".to_string(),
            port: 3306,
            user: "root".to_string(),
            database: None,
            ssh: None,
            group: None,
            color: None,
            is_production: false,
            confirm_writes: false,
            read_only: false,
            skip_history: false,
            file_path: None,
            ssl_mode: None,
            ssl_root_cert: None,
            ssl_client_cert: None,
            ssl_client_key: None,
            init_sql: None,
        }
    }

    fn counter() -> impl FnMut() -> String {
        let mut n = 0;
        move || {
            n += 1;
            format!("new{n}")
        }
    }

    #[test]
    fn export_json_contains_no_secret_fields() {
        // ConnectionProfile has no secret fields by design; assert the serialized
        // profile shape never grows a password-like key so a future field can't
        // leak secrets. (The human-readable `note` legitimately mentions the word
        // "password", so we check the profile body specifically, not the wrapper.)
        let json = serde_json::to_string(&profile("a", "Prod", "mysql")).unwrap();
        let lower = json.to_lowercase();
        assert!(
            !lower.contains("password"),
            "profile JSON leaked a password field: {json}"
        );
        assert!(
            !lower.contains("passphrase"),
            "profile JSON leaked a passphrase field: {json}"
        );

        // The export wrapper carries the format tag for import validation.
        let export = build_export_json(vec![profile("a", "Prod", "mysql")], None).unwrap();
        assert!(export.contains("noobdb-profiles"));
    }

    #[test]
    fn import_rename_assigns_fresh_ids_on_collision() {
        let existing = vec![profile("a", "Existing", "mysql")];
        let incoming = vec![profile("a", "Incoming", "postgres")];
        let (merged, res, overwritten_ids) =
            merge_imported(existing, incoming, ImportStrategy::Rename, counter());
        assert_eq!(res.imported, 1);
        assert_eq!(merged.len(), 2);
        // Original kept, new one got a fresh id (not "a").
        assert!(merged.iter().any(|p| p.id == "a" && p.name == "Existing"));
        assert!(merged
            .iter()
            .any(|p| p.id == "new1" && p.name == "Incoming"));
        // Rename never touches an existing id in place, so no keyring secrets
        // need clearing.
        assert!(overwritten_ids.is_empty());
    }

    #[test]
    fn import_skip_keeps_existing() {
        let existing = vec![profile("a", "Existing", "mysql")];
        let incoming = vec![profile("a", "Incoming", "postgres")];
        let (merged, res, overwritten_ids) =
            merge_imported(existing, incoming, ImportStrategy::Skip, counter());
        assert_eq!(res.skipped, 1);
        assert_eq!(res.imported, 0);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].name, "Existing");
        assert!(overwritten_ids.is_empty());
    }

    #[test]
    fn import_overwrite_replaces_existing() {
        let existing = vec![profile("a", "Existing", "mysql")];
        let incoming = vec![profile("a", "Incoming", "postgres")];
        let (merged, res, overwritten_ids) =
            merge_imported(existing, incoming, ImportStrategy::Overwrite, counter());
        assert_eq!(res.overwritten, 1);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].name, "Incoming");
        assert_eq!(merged[0].driver, "postgres");
        // H4: the overwritten id must be reported so the caller can clear its
        // stale keyring secrets (host/user may have changed under the same id).
        assert_eq!(overwritten_ids, vec!["a".to_string()]);
    }

    #[test]
    fn import_rejects_invalid_rows() {
        let incoming = vec![
            profile("", "NoDriver", "oracle"), // unknown driver
            profile("", "", "mysql"),          // empty name
            profile("", "Good", "sqlite"),     // valid, fresh id
        ];
        let (merged, res, overwritten_ids) =
            merge_imported(vec![], incoming, ImportStrategy::Rename, counter());
        assert_eq!(res.invalid, 2);
        assert_eq!(res.imported, 1);
        assert_eq!(merged.len(), 1);
        assert!(overwritten_ids.is_empty());
        assert_eq!(merged[0].name, "Good");
        assert_eq!(merged[0].id, "new1");
    }

    #[test]
    fn import_strategy_deserializes_from_lowercase() {
        let s: ImportStrategy = serde_json::from_str("\"overwrite\"").unwrap();
        assert_eq!(s, ImportStrategy::Overwrite);
    }

    // H5: store 削除→secrets 削除の順で呼ばれること。
    #[test]
    fn delete_profile_ordered_deletes_store_before_secrets() {
        use std::cell::RefCell;
        let calls: RefCell<Vec<&str>> = RefCell::new(Vec::new());
        let result = delete_profile_ordered(
            "a",
            |_| {
                calls.borrow_mut().push("store");
                Ok(())
            },
            |_| {
                calls.borrow_mut().push("secrets");
                Ok(())
            },
        );
        assert!(result.is_ok());
        assert_eq!(calls.into_inner(), vec!["store", "secrets"]);
    }

    // store 削除が失敗した場合、secrets 削除は呼ばれず、プロファイルと秘密の
    // どちらも残る (不整合な「秘密だけ消えた」状態を防ぐ)。
    #[test]
    fn delete_profile_ordered_skips_secrets_when_store_delete_fails() {
        use std::cell::RefCell;
        let secrets_called = RefCell::new(false);
        let result = delete_profile_ordered(
            "a",
            |_| Err(AppError::Io(std::io::Error::other("disk full"))),
            |_| {
                *secrets_called.borrow_mut() = true;
                Ok(())
            },
        );
        assert!(result.is_err());
        assert!(!*secrets_called.borrow());
    }
}
