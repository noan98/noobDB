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
    /// Same `Some`/`None`/empty-clears semantics, for the bastion/jump hop's
    /// passphrase (#708). Independent of `ssh_passphrase` above.
    #[serde(default)]
    pub ssh_jump_passphrase: Option<String>,
    /// Same semantics, for the bastion/jump hop's password.
    #[serde(default)]
    pub ssh_jump_password: Option<String>,
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
    /// AWS IAM database authentication settings (#734). Non-secret.
    #[serde(default)]
    pub aws_iam: Option<crate::db::aws_iam::AwsIamConfig>,
    /// AWS SSM ポートフォワード設定 (#1683)。`ssh` と排他。非秘密。
    #[serde(default)]
    pub ssm: Option<crate::ssm::SsmConfig>,
}

/// A stored profile plus flags telling the UI which secrets already exist in the
/// keyring. This payload carries only their presence, never the values, so the
/// form can show a masked indicator instead of an empty field; reading a value
/// takes a separate, explicit [`reveal_profile_secret`] call (#938).
/// `ConnectionProfile` is flattened so the wire shape stays a superset of the
/// plain profile (the extra `has_*` fields are not persisted to profiles.json).
#[derive(Debug, Clone, Serialize)]
pub struct ProfileWithSecretFlags {
    #[serde(flatten)]
    pub profile: ConnectionProfile,
    pub has_db_password: bool,
    pub has_ssh_passphrase: bool,
    pub has_ssh_password: bool,
    /// Whether a jump/bastion hop passphrase is stored (#708). Only
    /// meaningful when `profile.ssh.jump` is set.
    pub has_ssh_jump_passphrase: bool,
    /// Whether a jump/bastion hop password is stored (#708).
    pub has_ssh_jump_password: bool,
}

/// `profiles.json` から読めたプロファイルのうち、現在サポートしているドライバの
/// ものだけを残す。対応ドライバを縮小した後 (例: MSSQL / DuckDB 廃止) に残っている
/// 旧エントリが 1 件でもあると、フロントの `driverKind` zod スキーマ (3 種のみ許可)
/// が配列全体の parse に失敗し、プロファイル一覧が丸ごと読めなくなる — それを
/// 避けるため、未知のドライバのプロファイルだけをここで読み飛ばす (警告ログ付き)。
fn filter_supported_driver_profiles(profiles: Vec<ConnectionProfile>) -> Vec<ConnectionProfile> {
    profiles
        .into_iter()
        .filter(|profile| {
            let known = crate::db::DriverKind::parse(&profile.driver).is_some();
            if !known {
                tracing::warn!(
                    profile_id = %profile.id,
                    driver = %profile.driver,
                    "profiles: skipping profile with unsupported driver"
                );
            }
            known
        })
        .collect()
}

/// `list_profiles` が一覧に載せなかったプロファイル 1 件の要約 (#1614)。読み飛ばしを
/// 無言にせず、接続一覧の警告帯と「削除」に使う。秘密・その他のフィールドは含めない。
#[derive(Debug, Clone, Serialize)]
pub struct SkippedProfile {
    /// `unparsable` (解釈できない要素) / `unsupported_driver` (対応外ドライバ)。
    pub kind: String,
    /// `unparsable` のとき、`delete_skipped_profile` に渡す並び順。
    pub index: usize,
    pub id: Option<String>,
    pub name: Option<String>,
    pub driver: Option<String>,
    pub reason: String,
}

/// 一覧に出ないプロファイル (解釈できない要素 + 対応外ドライバ) の要約を返す。
#[tauri::command]
pub async fn list_skipped_profiles() -> Result<Vec<SkippedProfile>> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut out: Vec<SkippedProfile> = store::list_skipped()?
            .into_iter()
            .map(|e| SkippedProfile {
                kind: "unparsable".into(),
                index: e.index,
                id: e.id,
                name: e.name,
                driver: e.driver,
                reason: e.reason,
            })
            .collect();
        for p in store::load_all()? {
            if crate::db::DriverKind::parse(&p.driver).is_none() {
                out.push(SkippedProfile {
                    kind: "unsupported_driver".into(),
                    index: 0,
                    reason: format!("unsupported driver: {}", p.driver),
                    id: Some(p.id),
                    name: Some(p.name),
                    driver: Some(p.driver),
                });
            }
        }
        Ok(out)
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}

/// 解釈できず読み飛ばされた要素 (`kind: "unparsable"`) を `profiles.json` から削除する。
/// 対応外ドライバのプロファイルは通常の `delete_profile` で消す。
#[tauri::command]
pub async fn delete_skipped_profile(index: usize, id: Option<String>) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || store::delete_skipped(index, id.as_deref()))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn list_profiles() -> Result<Vec<ProfileWithSecretFlags>> {
    // keyring の存在確認 (プロファイル 1 件につき 5 回) は OS の資格情報マネージャを
    // 同期でブロックする。async コマンドの runtime worker を塞がないよう、
    // ファイル読み込みと一緒に blocking スレッドへ逃がす (#1530)。
    tauri::async_runtime::spawn_blocking(|| {
        let profiles = filter_supported_driver_profiles(store::load_all()?);
        Ok(profiles
            .into_iter()
            .map(|profile| {
                let has_db_password = secrets::has_db_password(&profile.id);
                let has_ssh_passphrase = secrets::has_ssh_passphrase(&profile.id);
                let has_ssh_password = secrets::has_ssh_password(&profile.id);
                let has_ssh_jump_passphrase = secrets::has_ssh_jump_passphrase(&profile.id);
                let has_ssh_jump_password = secrets::has_ssh_jump_password(&profile.id);
                ProfileWithSecretFlags {
                    profile,
                    has_db_password,
                    has_ssh_passphrase,
                    has_ssh_password,
                    has_ssh_jump_passphrase,
                    has_ssh_jump_password,
                }
            })
            .collect())
    })
    .await
    .map_err(|e| AppError::Other(format!("list_profiles task failed: {e}")))?
}

/// keyring に保存された秘密の種類。`as_str` は `profiles::secrets` の内部 kind
/// 文字列 (= keyring のアカウント名 `<profile_id>/<kind>` の後半) とそのまま一致
/// させてあり、監査ログの `secret` フィールド (`save_profile_inner` の set/clear
/// ログと同じ名前) から keyring 上のエントリを直接引ける。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SecretKind {
    DbPassword,
    SshPassphrase,
    SshPassword,
    SshJumpPassphrase,
    SshJumpPassword,
}

impl SecretKind {
    /// ログ用の安定した識別子 (keyring の kind 文字列と同一)。
    fn as_str(self) -> &'static str {
        match self {
            SecretKind::DbPassword => "db_password",
            SecretKind::SshPassphrase => "ssh_passphrase",
            SecretKind::SshPassword => "ssh_password",
            SecretKind::SshJumpPassphrase => "ssh_passphrase_hop0",
            SecretKind::SshJumpPassword => "ssh_password_hop0",
        }
    }
}

/// 保存済みの秘密を keyring から読み出して**平文のまま**フロントへ返す、唯一の
/// IPC (#938)。ユーザが自分で保存したパスワードを確認したいだけのために OS の
/// 資格情報マネージャ / Keychain / secret-tool を叩かせるのは体験として悪いので、
/// 接続フォームの「表示」操作からだけ呼ばれる読み出し口を用意する。
///
/// **秘密分離ポリシー (CLAUDE.md) の意図的な例外である点に注意。** 前提は
/// 「keyring を読めるのは OS ユーザ自身であり、そのユーザは同じ値を OS 標準
/// ツールでも読める」こと — アプリは新しい権限を得ておらず、既に持っている
/// アクセスへの導線を短くしているだけ。したがってここでの守るべき性質は
/// 「値をどこにも残さない」ことに尽きる:
///
/// - 値はログに出さない (`secrets.rs` と同じ方針)。**表示された事実だけ**を
///   `warn` レベルで記録し、後から「いつ・どのプロファイルの・どの種類の秘密を
///   表示したか」を追跡できるようにする。
/// - クエリ履歴 (`history`) を経由しない (そもそも SQL ではない)。
/// - 返り値はフロントの表示バッファに載るだけで、`profiles.json` にも
///   localStorage にも書かない (呼び出し側の責務。`ConnectionForm` は再マスク
///   時に state から破棄する)。
///
/// 未保存 (エントリ無し) のときは `None` を返す — 呼び出し側はこれを「表示する
/// ものが無い」として扱えばよく、エラーと区別できる。
#[tauri::command]
pub async fn reveal_profile_secret(profile_id: String, kind: SecretKind) -> Result<Option<String>> {
    if profile_id.trim().is_empty() {
        return Err(AppError::InvalidInput("profileId is required".to_string()));
    }
    // 値そのものは決して記録しない。表示イベントの監査証跡としてのみ残す。
    tracing::warn!(
        profile_id = %profile_id,
        secret = kind.as_str(),
        "revealing a stored secret to the UI"
    );
    match kind {
        SecretKind::DbPassword => secrets::get_db_password(&profile_id),
        SecretKind::SshPassphrase => secrets::get_ssh_passphrase(&profile_id),
        SecretKind::SshPassword => secrets::get_ssh_password(&profile_id),
        SecretKind::SshJumpPassphrase => secrets::get_ssh_jump_passphrase(&profile_id),
        SecretKind::SshJumpPassword => secrets::get_ssh_jump_password(&profile_id),
    }
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

/// 空・空白のみのプロファイル名は、接続一覧やヘルス表で中身のない行になるので拒否する。
fn validate_profile_name(name: &str) -> Result<()> {
    if name.trim().is_empty() {
        return Err(AppError::InvalidInput(
            "profile name must not be empty".into(),
        ));
    }
    Ok(())
}

/// SSM 設定を保存用に整える (#1683)。空白を落とし、SSH との排他と形式を検証する。
/// `target` が空のまま保存することは認めない (SSM を使わないなら `None` にする)。
fn normalize_ssm(
    ssm: Option<&crate::ssm::SsmConfig>,
    has_ssh: bool,
    driver: &str,
) -> Result<Option<crate::ssm::SsmConfig>> {
    // SQLite はファイル直開きでトンネルを使わない (ssh と同様に無視する) ので保存しない。
    if driver == "sqlite" {
        return Ok(None);
    }
    let Some(cfg) = ssm else {
        return Ok(None);
    };
    crate::ssm::ensure_exclusive(has_ssh, true)?;
    crate::ssm::validate_config(cfg)?;
    Ok(Some(crate::ssm::SsmConfig {
        target: cfg.target.trim().to_string(),
        region: cfg.region.trim().to_string(),
        profile: cfg
            .profile
            .as_deref()
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .map(str::to_string),
    }))
}

/// Persists the profile row and any changed secrets. The secret *values* are
/// never logged — only which secret kind was set or cleared, at debug level.
fn save_profile_inner(id: String, req: SaveProfileRequest) -> Result<ConnectionProfile> {
    validate_profile_name(&req.name)?;
    let ssm = normalize_ssm(req.ssm.as_ref(), req.ssh.is_some(), &req.driver)?;
    let req_secrets = ProfileSecretUpdates {
        db_password: req.db_password.clone(),
        ssh_passphrase: req.ssh_passphrase.clone(),
        ssh_password: req.ssh_password.clone(),
        ssh_jump_passphrase: req.ssh_jump_passphrase.clone(),
        ssh_jump_password: req.ssh_jump_password.clone(),
    };
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
        aws_iam: req.aws_iam.map(|c| crate::db::aws_iam::AwsIamConfig {
            region: c.region.trim().to_string(),
            profile: c
                .profile
                .map(|p| p.trim().to_string())
                .filter(|p| !p.is_empty()),
        }),
        ssm,
    };
    // 秘密を先に書き、すべて成功してから本体を upsert する。秘密の書き込みが途中で失敗しても
    // それまでに書いた秘密は元の値へ戻し (既存プロファイル)、新規プロファイルなら孤立
    // させないよう掃除する。profiles.json には何も残らず、フォームとストアがずれない。
    let is_new = !store::load_all()?.iter().any(|p| p.id == id);
    let keyring = KeyringAccess;
    let undo = match write_profile_secrets(&keyring, &id, &req_secrets) {
        Ok(undo) => undo,
        Err(e) => {
            if is_new {
                let _ = secrets::delete_all(&id);
            }
            return Err(e);
        }
    };
    if let Err(e) = store::upsert(profile.clone()) {
        // 本体の保存に失敗したら、先に書いた秘密も元へ戻す (keyring だけ新しくならない)。
        restore_secrets(&keyring, &id, undo);
        if is_new {
            let _ = secrets::delete_all(&id);
        }
        return Err(e);
    }
    Ok(profile)
}

/// `save_profile` で変更された秘密の更新指示 (`None` = 変更なし、`Some("")` = 削除、
/// `Some(v)` = 設定)。値はログに出さず、種別名だけを debug で残す。
struct ProfileSecretUpdates {
    db_password: Option<String>,
    ssh_passphrase: Option<String>,
    ssh_password: Option<String>,
    ssh_jump_passphrase: Option<String>,
    ssh_jump_password: Option<String>,
}

/// keyring 読み書きの抽象 (本番は [`KeyringAccess`]、テストは失敗注入できるメモリ実装)。
trait SecretAccess {
    fn get(&self, id: &str, kind: &str) -> Result<Option<String>>;
    fn set(&self, id: &str, kind: &str, value: &str) -> Result<()>;
    fn delete(&self, id: &str, kind: &str) -> Result<()>;
}

struct KeyringAccess;

impl SecretAccess for KeyringAccess {
    fn get(&self, id: &str, kind: &str) -> Result<Option<String>> {
        secrets::get_kind(id, kind)
    }
    fn set(&self, id: &str, kind: &str, value: &str) -> Result<()> {
        secrets::set_kind(id, kind, value)
    }
    fn delete(&self, id: &str, kind: &str) -> Result<()> {
        secrets::delete_kind(id, kind)
    }
}

/// 書き換える前の値 (kind, 旧値)。`None` は未登録だった。ロールバック専用で、ログには出さない。
type SecretUndo = Vec<(&'static str, Option<String>)>;

/// 変更指示のある秘密を順に書く。途中で失敗したら、それまでに書いた秘密を元の値へ戻して
/// エラーを返す。成功時は呼び出し側が後続の失敗 (本体の保存) で戻せるよう undo 情報を返す。
fn write_profile_secrets(
    access: &impl SecretAccess,
    id: &str,
    u: &ProfileSecretUpdates,
) -> Result<SecretUndo> {
    let updates: [(&'static str, &Option<String>); 5] = [
        ("db_password", &u.db_password),
        ("ssh_passphrase", &u.ssh_passphrase),
        ("ssh_password", &u.ssh_password),
        ("ssh_passphrase_hop0", &u.ssh_jump_passphrase),
        ("ssh_password_hop0", &u.ssh_jump_password),
    ];
    let mut undo: SecretUndo = Vec::new();
    for (kind, value) in updates {
        let Some(v) = value.as_deref() else {
            continue;
        };
        let result = (|| -> Result<()> {
            let prior = access.get(id, kind)?;
            let applied = if v.is_empty() {
                tracing::debug!(profile_id = %id, secret = kind, "clearing secret");
                access.delete(id, kind)
            } else {
                tracing::debug!(profile_id = %id, secret = kind, "setting secret");
                access.set(id, kind, v)
            };
            // 書き込み自体が失敗しても部分的に書けた可能性があるので、旧値は先に控える。
            undo.push((kind, prior));
            applied
        })();
        if let Err(e) = result {
            restore_secrets(access, id, std::mem::take(&mut undo));
            return Err(e);
        }
    }
    Ok(undo)
}

/// `write_profile_secrets` が控えた旧値へ戻す (新しい書き込みと逆順)。戻せなかった kind は
/// 種別名だけを警告する (値は出さない)。
fn restore_secrets(access: &impl SecretAccess, id: &str, undo: SecretUndo) {
    for (kind, prior) in undo.into_iter().rev() {
        let res = match prior {
            Some(v) => access.set(id, kind, &v),
            None => access.delete(id, kind),
        };
        if let Err(e) = res {
            tracing::warn!(profile_id = %id, secret = kind, error = %e, "failed to restore secret after a failed save");
        }
    }
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

/// 取り込めるドライバか。`DriverKind::parse` に委ねるので、ドライバを足すと
/// インポートも自動で追従する。
fn is_known_driver(driver: &str) -> bool {
    crate::db::DriverKind::parse(driver).is_some()
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
    all: Vec<ConnectionProfile>,
    imported: Vec<ConnectionProfile>,
    strategy: ImportStrategy,
    gen_id: impl FnMut() -> String,
) -> (Vec<ConnectionProfile>, ImportResult, Vec<String>) {
    let (merged, result, overwritten_ids, _) =
        merge_imported_placed(all, imported, strategy, gen_id);
    (merged, result, overwritten_ids)
}

/// [`merge_imported`] の本体。4 つ目の戻り値は入力と同じ順・同じ長さの「取り込み
/// 先 id」で、スキップ / 不正行は `None`、Rename で採番し直した行は新 id になる。
/// 暗号化バックアップの取り込み (#710) が、各プロファイルの秘密をどの id の
/// keyring エントリへ書き戻すかを決めるのに使う。
pub(crate) fn merge_imported_placed(
    mut all: Vec<ConnectionProfile>,
    imported: Vec<ConnectionProfile>,
    strategy: ImportStrategy,
    mut gen_id: impl FnMut() -> String,
) -> (
    Vec<ConnectionProfile>,
    ImportResult,
    Vec<String>,
    Vec<Option<String>>,
) {
    let mut placed = Vec::with_capacity(imported.len());
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
            placed.push(None);
            continue;
        }
        let collides = !profile.id.is_empty() && all.iter().any(|p| p.id == profile.id);
        if collides {
            match strategy {
                ImportStrategy::Skip => {
                    result.skipped += 1;
                    placed.push(None);
                    continue;
                }
                ImportStrategy::Overwrite => {
                    let id = profile.id.clone();
                    if let Some(existing) = all.iter_mut().find(|p| p.id == profile.id) {
                        overwritten_ids.push(id.clone());
                        *existing = profile;
                    }
                    result.overwritten += 1;
                    placed.push(Some(id));
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
        placed.push(Some(profile.id.clone()));
        all.push(profile);
        result.imported += 1;
    }
    (all, result, overwritten_ids, placed)
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
    crate::atomic_write::write_atomic(std::path::Path::new(&path), json.as_bytes())?;
    tracing::info!(path = %path, "profiles exported");
    Ok(json.len())
}

/// 平文プロファイル取り込みファイルの上限。暗号化バックアップ側
/// (`profile_backup::MAX_BACKUP_FILE_BYTES`) と同じ 16 MiB。
const MAX_IMPORT_FILE_BYTES: u64 = 16 * 1024 * 1024;

/// 上限を超えるファイルは読まずに `InvalidInput` で拒否する。
fn read_import_file(path: &str) -> Result<String> {
    let len = std::fs::metadata(path)?.len();
    if len > MAX_IMPORT_FILE_BYTES {
        return Err(AppError::InvalidInput(format!(
            "Profile import file is too large ({len} bytes, max {MAX_IMPORT_FILE_BYTES})"
        )));
    }
    Ok(std::fs::read_to_string(path)?)
}

/// `path` の JSON (`export_profiles` 出力) を取り込む。形式を検証し、ドライバ不正な
/// 行はスキップ、ID 衝突は `strategy` に従って解決する。**秘密情報は JSON に含まれ
/// ないため、取り込んだプロファイルは資格情報未設定として扱われ、接続時に再入力が
/// 促される。** ファイルの読み取りはバックエンドが行う (fs capability 不要)。
#[tauri::command]
pub async fn import_profiles(path: String, strategy: ImportStrategy) -> Result<ImportResult> {
    let path_for_read = path.clone();
    let content = tauri::async_runtime::spawn_blocking(move || read_import_file(&path_for_read))
        .await
        .map_err(|e| AppError::Other(format!("import read task failed: {e}")))??;
    let parsed: ProfileExport = serde_json::from_str(&content)
        .map_err(|e| AppError::InvalidInput(format!("Invalid profile export file: {e}")))?;
    if parsed.format != EXPORT_FORMAT {
        return Err(AppError::InvalidInput(format!(
            "Unrecognized profile export format: {}",
            parsed.format
        )));
    }

    // 読み込み → マージ → 保存はストアのロックを握ったまま一息で行う。
    // `load_all()` と `save_all()` を別々に呼ぶと、その間に割り込んだ
    // `save_profile` / `delete_profile` の変更をインポートが丸ごと上書きする
    // (lost update)。結果 (`ImportResult` と上書き対象 id) はクロージャの外へ
    // 持ち出したいので、`Option` に退避してから受け取る。
    let mut outcome: Option<(ImportResult, Vec<String>)> = None;
    store::update_all(|all| {
        let (merged, result, overwritten_ids) =
            merge_imported(all, parsed.profiles, strategy, new_profile_id);
        outcome = Some((result, overwritten_ids));
        Ok(merged)
    })?;
    let (result, overwritten_ids) = outcome.ok_or_else(|| {
        // `update_all` が `f` を呼ばずに返ることは無いので到達しない。panic せず
        // 通常のエラーにするのはリポジトリ方針 (本体コードで unwrap/panic 禁止)。
        AppError::Other("profile import did not produce a result".into())
    })?;
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
    // プロファイル本体が消えたら、そのプロファイル専用だったスニペットを孤立させない
    // (スコープを Any へ戻す)。ベストエフォート。keyring 側の失敗で `result` が Err でも
    // 本体は既に消えているので掃除する。
    let gone = store::load_all().is_ok_and(|all| !all.iter().any(|p| p.id == id));
    if gone {
        if let Err(e) = crate::snippets::store::release_profile_scope(&id) {
            tracing::warn!(profile_id = %id, error = %e, "failed to release snippets scoped to deleted profile");
        }
        // テーブル・タイムラプスの行データ (機微データを含みうる) を残さない。ベストエフォート。
        if let Err(e) = crate::timelapse::store::delete_profile_data(&id).await {
            tracing::warn!(profile_id = %id, error = %e, "failed to delete timelapse data of deleted profile");
        }
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

/// 接続リストのドラッグ/キーボード並べ替え (#786)。`ordered_ids` の順に
/// `profiles.json` の配列を並べ替える — プロファイルの並び順は特別なフィールドを
/// 持たず、この配列順そのものが真実 (`list_profiles` はファイル順をそのまま返す)。
/// 新しいプロファイル追加時のフィールドを増やさずに済む、既存ストレージを最大限
/// 利用した永続化方針 (CLAUDE.md の「Rust 変更は最小限に」に沿う)。
#[tauri::command]
pub async fn reorder_profiles(ordered_ids: Vec<String>) -> Result<()> {
    // 並べ替えもインポートと同じく「読み → 変更 → 書き」なので、ロックを握った
    // まま一息で行う (途中で `save_profile` が割り込むと、その追加/変更が
    // 並べ替えの書き戻しで消える)。順列チェックも同じロック下で行うため、
    // 検証に使った一覧と書き戻す一覧が必ず同一のスナップショットになる。
    let mut count = 0usize;
    store::update_all(|all| {
        count = all.len();
        reorder_profiles_pure(all, &ordered_ids).ok_or_else(|| {
            AppError::InvalidInput(
                "orderedIds must be a permutation of the existing profile ids".to_string(),
            )
        })
    })?;
    tracing::info!(count, "profiles reordered");
    Ok(())
}

/// `ordered_ids` に従ってプロファイル一覧を並べ替える純粋ロジック。`ordered_ids`
/// は `all` の id 集合の**真の順列**でなければならない (欠落・重複・混入を拒否
/// する) — フロントの `connectionOrder.ts::reorderIfPermutation` と同じ不変条件を
/// バックエンドでも強制する。順列でなければ `None` を返す (IPC を直接叩く/競合
/// レースなど、フロント側のガードをすり抜けた不正な入力からストレージを守る)。
/// ファイル IO に触れないのでユニットテストできる。
fn reorder_profiles_pure(
    all: Vec<ConnectionProfile>,
    ordered_ids: &[String],
) -> Option<Vec<ConnectionProfile>> {
    // 未対応ドライバ (旧 mssql / duckdb など) のプロファイルは `list_profiles` が
    // 読み飛ばすのでフロントの `ordered_ids` には含まれない。順列検査は対応
    // ドライバのものだけで行い、未対応のものは元の位置に据え置く。
    let supported = |p: &ConnectionProfile| crate::db::DriverKind::parse(&p.driver).is_some();
    let slots: Vec<usize> = all
        .iter()
        .enumerate()
        .filter(|(_, p)| supported(p))
        .map(|(i, _)| i)
        .collect();
    if ordered_ids.len() != slots.len() {
        return None;
    }
    let mut result: Vec<Option<ConnectionProfile>> = Vec::with_capacity(all.len());
    let mut supported_profiles = Vec::with_capacity(slots.len());
    for p in all {
        if supported(&p) {
            result.push(None);
            supported_profiles.push(p);
        } else {
            result.push(Some(p));
        }
    }
    let reordered = reorder_supported(supported_profiles, ordered_ids)?;
    let mut it = reordered.into_iter();
    for (slot, _) in result.iter_mut().zip(0..) {
        if slot.is_none() {
            *slot = it.next();
        }
    }
    result.into_iter().collect()
}

fn reorder_supported(
    all: Vec<ConnectionProfile>,
    ordered_ids: &[String],
) -> Option<Vec<ConnectionProfile>> {
    if ordered_ids.len() != all.len() {
        return None;
    }
    let mut by_id: std::collections::HashMap<String, ConnectionProfile> =
        std::collections::HashMap::with_capacity(all.len());
    for p in all {
        // 既存ストレージに重複 id があるのは想定外の破損状態。安全側に倒し、
        // 並べ替えは行わずエラーとして扱う。
        if by_id.insert(p.id.clone(), p).is_some() {
            return None;
        }
    }
    let mut seen = std::collections::HashSet::with_capacity(ordered_ids.len());
    let mut reordered = Vec::with_capacity(ordered_ids.len());
    for id in ordered_ids {
        if !seen.insert(id.as_str()) {
            return None; // ordered_ids 内の重複
        }
        reordered.push(by_id.remove(id)?); // 混入 (未知の id) は remove が None を返す
    }
    if !by_id.is_empty() {
        return None; // ordered_ids に含まれなかった id が残っている (件数不一致の防御)
    }
    Some(reordered)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ssm::SsmConfig;
    use std::cell::RefCell;
    use std::collections::HashMap;

    /// 失敗注入できるメモリ keyring。`fail_set_kind` の set だけ失敗させる。
    #[derive(Default)]
    struct MemSecrets {
        map: RefCell<HashMap<String, String>>,
        fail_set_kind: Option<&'static str>,
    }

    impl SecretAccess for MemSecrets {
        fn get(&self, id: &str, kind: &str) -> Result<Option<String>> {
            Ok(self.map.borrow().get(&format!("{id}/{kind}")).cloned())
        }
        fn set(&self, id: &str, kind: &str, value: &str) -> Result<()> {
            if self.fail_set_kind == Some(kind) {
                return Err(AppError::Other("keyring write failed".into()));
            }
            self.map
                .borrow_mut()
                .insert(format!("{id}/{kind}"), value.to_string());
            Ok(())
        }
        fn delete(&self, id: &str, kind: &str) -> Result<()> {
            self.map.borrow_mut().remove(&format!("{id}/{kind}"));
            Ok(())
        }
    }

    fn updates(db: Option<&str>, pass: Option<&str>) -> ProfileSecretUpdates {
        ProfileSecretUpdates {
            db_password: db.map(String::from),
            ssh_passphrase: pass.map(String::from),
            ssh_password: None,
            ssh_jump_passphrase: None,
            ssh_jump_password: None,
        }
    }

    fn ssm_cfg(target: &str, profile: Option<&str>) -> SsmConfig {
        SsmConfig {
            target: target.into(),
            region: " ap-northeast-1 ".into(),
            profile: profile.map(str::to_string),
        }
    }

    #[test]
    fn normalize_ssm_trims_and_drops_blank_profile() {
        assert!(normalize_ssm(None, true, "mysql").unwrap().is_none());
        let out = normalize_ssm(
            Some(&ssm_cfg(" i-0123456789abcdef0 ", Some("  "))),
            false,
            "mysql",
        )
        .unwrap()
        .unwrap();
        assert_eq!(out.target, "i-0123456789abcdef0");
        assert_eq!(out.region, "ap-northeast-1");
        assert_eq!(out.profile, None);
    }

    #[test]
    fn normalize_ssm_drops_ssm_for_sqlite() {
        let cfg = ssm_cfg("i-0123456789abcdef0", None);
        assert!(normalize_ssm(Some(&cfg), true, "sqlite").unwrap().is_none());
    }

    #[test]
    fn normalize_ssm_rejects_ssh_combination_and_bad_target() {
        assert!(normalize_ssm(Some(&ssm_cfg("i-0123456789abcdef0", None)), true, "mysql").is_err());
        assert!(normalize_ssm(Some(&ssm_cfg("", None)), false, "mysql").is_err());
    }

    #[test]
    fn blank_profile_name_is_rejected() {
        assert!(validate_profile_name("").is_err());
        assert!(validate_profile_name(" \t ").is_err());
        assert!(validate_profile_name("prod").is_ok());
    }

    // 既存プロファイルで db_password 書き込み成功 → ssh_passphrase 失敗のとき、
    // db_password が旧値へ戻る (#1593)。
    #[test]
    fn secret_write_failure_rolls_back_earlier_writes() {
        let store = MemSecrets {
            fail_set_kind: Some("ssh_passphrase"),
            ..Default::default()
        };
        store
            .map
            .borrow_mut()
            .insert("p1/db_password".into(), "old".into());
        let err = write_profile_secrets(&store, "p1", &updates(Some("new"), Some("pp")));
        assert!(err.is_err());
        assert_eq!(
            store.get("p1", "db_password").unwrap().as_deref(),
            Some("old")
        );
        assert_eq!(store.get("p1", "ssh_passphrase").unwrap(), None);
    }

    // 旧値が無かった秘密は失敗時に削除へ戻る。成功時は undo で本体保存失敗にも戻せる。
    #[test]
    fn secret_write_undo_restores_prior_state() {
        let store = MemSecrets::default();
        store
            .map
            .borrow_mut()
            .insert("p1/db_password".into(), "old".into());
        let undo = write_profile_secrets(&store, "p1", &updates(Some("new"), Some("pp"))).unwrap();
        assert_eq!(
            store.get("p1", "db_password").unwrap().as_deref(),
            Some("new")
        );
        restore_secrets(&store, "p1", undo);
        assert_eq!(
            store.get("p1", "db_password").unwrap().as_deref(),
            Some("old")
        );
        assert_eq!(store.get("p1", "ssh_passphrase").unwrap(), None);
    }

    // 空文字は削除指示で、失敗時には旧値が復元される。
    #[test]
    fn secret_clear_is_restored_on_later_failure() {
        let store = MemSecrets {
            fail_set_kind: Some("ssh_passphrase"),
            ..Default::default()
        };
        store
            .map
            .borrow_mut()
            .insert("p1/db_password".into(), "old".into());
        assert!(write_profile_secrets(&store, "p1", &updates(Some(""), Some("pp"))).is_err());
        assert_eq!(
            store.get("p1", "db_password").unwrap().as_deref(),
            Some("old")
        );
    }

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
            aws_iam: None,
            ssm: None,
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
    fn import_accepts_every_supported_driver() {
        let incoming = ["mysql", "postgres", "sqlite"]
            .iter()
            .map(|d| profile("", d, d))
            .collect();
        let (_, res, _) = merge_imported(vec![], incoming, ImportStrategy::Rename, counter());
        assert_eq!(res.imported, 3);
        assert_eq!(res.invalid, 0);
    }

    /// 対応ドライバを縮小した後 (MSSQL / DuckDB 廃止) も、旧 profiles.json に
    /// 未知ドライバのエントリが残っている場合、それだけを読み飛ばし、
    /// 残りのプロファイルは影響を受けないこと。
    #[test]
    fn filter_supported_driver_profiles_skips_only_unknown_driver() {
        let profiles = vec![
            profile("a", "MySQL profile", "mysql"),
            profile("b", "Old MSSQL profile", "mssql"),
            profile("c", "Old DuckDB profile", "duckdb"),
            profile("d", "SQLite profile", "sqlite"),
        ];
        let kept = filter_supported_driver_profiles(profiles);
        let ids: Vec<&str> = kept.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids, vec!["a", "d"]);
    }

    #[test]
    fn merge_placed_reports_destination_ids_in_input_order() {
        let existing = vec![profile("a", "A", "mysql"), profile("b", "B", "mysql")];
        let incoming = vec![
            profile("a", "A2", "mysql"),   // collides
            profile("c", "C", "postgres"), // new
            profile("x", "Bad", "oracle"), // invalid
        ];
        let (_, _, _, placed) = merge_imported_placed(
            existing.clone(),
            incoming.clone(),
            ImportStrategy::Rename,
            counter(),
        );
        assert_eq!(placed, vec![Some("new1".into()), Some("c".into()), None]);
        let (_, _, _, placed) = merge_imported_placed(
            existing.clone(),
            incoming.clone(),
            ImportStrategy::Skip,
            counter(),
        );
        assert_eq!(placed, vec![None, Some("c".into()), None]);
        let (_, _, _, placed) =
            merge_imported_placed(existing, incoming, ImportStrategy::Overwrite, counter());
        assert_eq!(placed, vec![Some("a".into()), Some("c".into()), None]);
    }

    // #938: フロントは snake_case のリテラル ("db_password" 等) を送る。keyring の
    // kind 文字列と一対一に対応することも固定する (ログと keyring エントリ名の
    // 突き合わせが崩れないように)。
    #[test]
    fn secret_kind_deserializes_from_snake_case() {
        let k: SecretKind = serde_json::from_str("\"db_password\"").unwrap();
        assert_eq!(k, SecretKind::DbPassword);
        assert_eq!(k.as_str(), "db_password");

        let k: SecretKind = serde_json::from_str("\"ssh_jump_passphrase\"").unwrap();
        assert_eq!(k, SecretKind::SshJumpPassphrase);
        // 踏み台の秘密は keyring 上では `_hop0` サフィックス (#708)。
        assert_eq!(k.as_str(), "ssh_passphrase_hop0");

        let k: SecretKind = serde_json::from_str("\"ssh_jump_password\"").unwrap();
        assert_eq!(k.as_str(), "ssh_password_hop0");

        assert!(serde_json::from_str::<SecretKind>("\"dbPassword\"").is_err());
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

    // #786: 真の順列なら、指定順にプロファイルを並べ替えて返す。
    #[test]
    fn reorder_profiles_pure_accepts_a_valid_permutation() {
        let all = vec![
            profile("a", "A", "mysql"),
            profile("b", "B", "mysql"),
            profile("c", "C", "mysql"),
        ];
        let reordered =
            reorder_profiles_pure(all, &["c".to_string(), "a".to_string(), "b".to_string()])
                .unwrap();
        assert_eq!(
            reordered.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(),
            vec!["c", "a", "b"]
        );
    }

    // 件数が合わない (欠落) 場合は None。
    #[test]
    fn reorder_profiles_pure_rejects_wrong_length() {
        let all = vec![profile("a", "A", "mysql"), profile("b", "B", "mysql")];
        assert!(reorder_profiles_pure(all, &["a".to_string()]).is_none());
    }

    // ordered_ids 内の重複 (どこかのプロファイルが到達不能になる) は None。
    #[test]
    fn reorder_profiles_pure_rejects_duplicate_id() {
        let all = vec![profile("a", "A", "mysql"), profile("b", "B", "mysql")];
        assert!(reorder_profiles_pure(all, &["a".to_string(), "a".to_string()]).is_none());
    }

    // 未知の id が混入している場合は None。
    #[test]
    fn reorder_profiles_pure_rejects_foreign_id() {
        let all = vec![profile("a", "A", "mysql"), profile("b", "B", "mysql")];
        assert!(reorder_profiles_pure(all, &["a".to_string(), "x".to_string()]).is_none());
    }

    // 恒等順列 (現状維持) も正しく受理される。
    #[test]
    fn reorder_profiles_pure_accepts_identity_order() {
        let all = vec![profile("a", "A", "mysql"), profile("b", "B", "mysql")];
        let reordered = reorder_profiles_pure(all, &["a".to_string(), "b".to_string()]).unwrap();
        assert_eq!(
            reordered.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(),
            vec!["a", "b"]
        );
    }

    // 空リストも順列 (空 = 空) として許容する。
    #[test]
    fn reorder_profiles_pure_accepts_empty() {
        let reordered = reorder_profiles_pure(vec![], &[]).unwrap();
        assert!(reordered.is_empty());
    }

    #[test]
    fn reorder_ignores_unsupported_driver_profiles() {
        let all = vec![
            profile("a", "A", "mysql"),
            profile("x", "Old", "mssql"),
            profile("b", "B", "mysql"),
        ];
        // フロントは対応ドライバの 2 件しか知らない。
        let out = reorder_profiles_pure(all, &["b".to_string(), "a".to_string()]).unwrap();
        let ids: Vec<&str> = out.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids, ["b", "x", "a"]);
    }

    #[test]
    fn import_rejects_oversized_file() {
        let path = std::env::temp_dir().join(format!("noobdb_import_big_{}", std::process::id()));
        let f = std::fs::File::create(&path).unwrap();
        f.set_len(MAX_IMPORT_FILE_BYTES + 1).unwrap();
        let err = read_import_file(path.to_str().unwrap()).unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)));
        let _ = std::fs::remove_file(&path);
    }
}

/// OS keyring が使えるかの疎通診断 (#1622)。一時エントリを書いて読み戻し、削除する。
/// 結果は bool と固定の理由コードだけで、秘密もエラー本文も返さない。
#[tauri::command]
pub async fn check_keyring() -> Result<secrets::KeyringStatus> {
    tauri::async_runtime::spawn_blocking(secrets::probe_keyring)
        .await
        .map_err(|e| AppError::Other(e.to_string()))
}
