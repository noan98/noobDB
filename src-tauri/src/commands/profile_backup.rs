//! プロファイルの暗号化フルエクスポート / インポート (#710)。
//!
//! 暗号の中身 (Argon2id + AES-256-GCM、ファイル形式) は `profiles::backup`。
//! ここは keyring / profiles.json との橋渡しと、取り込み時のロールバックを担う。
//!
//! 秘密の扱いの約束 (CLAUDE.md の秘密分離ポリシー):
//! - 平文の秘密・パスフレーズはログにも IPC 応答にも出さない。応答は件数のみ。
//! - 平文ペイロードはメモリ上でのみ組み立て、暗号化後のバイト列だけをディスクへ
//!   書く (一時ファイルを作らない)。
//! - パスフレーズはどこにも保存しない (引数として受け取り、使い終われば破棄)。

use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::commands::profiles::{merge_imported_placed, ImportResult, ImportStrategy};
use crate::error::{AppError, Result};
use crate::profiles::backup::{self, BackupEntry, BackupSecrets, KdfParams};
use crate::profiles::store::{self, new_profile_id};
use crate::profiles::{secrets, ConnectionProfile};

/// 暗号化バックアップの上限サイズ。プロファイル数百件でも数百 KiB に収まるので、
/// 誤って巨大ファイルを選んだときにメモリへ丸読みしないための安全弁。
const MAX_BACKUP_FILE_BYTES: u64 = 16 * 1024 * 1024;

/// エクスポート結果の要約 (件数のみ。秘密の値は含めない)。
#[derive(Debug, Clone, Serialize)]
pub struct EncryptedExportResult {
    /// 書き出したプロファイル数。
    pub profiles: usize,
    /// 同梱した秘密の件数 (プロファイル × 種類)。
    pub secrets: usize,
    /// 書き込んだバイト数 (暗号文 + ヘッダ)。
    pub bytes: usize,
    /// 書き出し直後にファイルを読み直し、パスフレーズで復号できて件数が一致することを確認済みか
    /// (#1624)。確認に失敗すると保存先は置き換えずエラーにするので、成功応答では常に `true`。
    pub verified: bool,
    /// 世代管理 (`keep_generations`) で削除した古い世代の数 (#1624)。指定が無ければ 0。
    pub generations_pruned: usize,
}

/// 暗号化インポートの結果要約。`ImportResult` に、keyring へ書き戻した秘密の
/// 件数を足したもの。
#[derive(Debug, Clone, Serialize)]
pub struct EncryptedImportResult {
    #[serde(flatten)]
    pub result: ImportResult,
    /// keyring へ書き戻した秘密の件数。
    pub secrets: usize,
}

/// `import_profiles_encrypted` の引数。パスフレーズを `Debug` に出さないため
/// 構造体で受ける。
#[derive(Deserialize)]
pub struct EncryptedImportRequest {
    pub path: String,
    /// 受け取った直後に `Zeroizing` へ移して使う (構造体に残さない)。
    pub passphrase: String,
    pub strategy: ImportStrategy,
}

/// `export_profiles_encrypted` の引数。
#[derive(Deserialize)]
pub struct EncryptedExportRequest {
    pub path: String,
    /// 受け取った直後に `Zeroizing` へ移して使う (構造体に残さない)。
    pub passphrase: String,
    /// `None` / 空なら全件。
    #[serde(default)]
    pub ids: Option<Vec<String>>,
    /// 保存先ディレクトリに残す世代数 (最新を含む, #1624)。`None` / 0 は世代管理なし (従来どおり
    /// 同名ファイルを置き換える)。指定時は、上書き前の既存ファイルを `<名前>.<日時>.<拡張子>` へ
    /// 退避し、古い退避から削除して合計がこの数に収まるようにする。
    #[serde(default)]
    pub keep_generations: Option<u32>,
}

impl std::fmt::Debug for EncryptedImportRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EncryptedImportRequest")
            .field("path", &self.path)
            .field("strategy", &self.strategy)
            .finish_non_exhaustive()
    }
}

impl std::fmt::Debug for EncryptedExportRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EncryptedExportRequest")
            .field("path", &self.path)
            .finish_non_exhaustive()
    }
}

/// keyring への読み書きを抽象化したもの。本番は [`KeyringStore`]、テストは
/// 失敗注入できるメモリ実装でロールバックを検証する。
trait SecretStore {
    fn get(&self, id: &str, kind: &str) -> Result<Option<String>>;
    fn set(&self, id: &str, kind: &str, value: &str) -> Result<()>;
    fn delete(&self, id: &str, kind: &str) -> Result<()>;
}

struct KeyringStore;

impl SecretStore for KeyringStore {
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

/// 対象プロファイルを選び、keyring の秘密を添えたバックアップ項目を作る。
/// keyring の読み取り失敗 (未登録以外) はエラーにする — 黙って秘密抜きで
/// 書き出すと、移行先で「なぜかパスワードが無い」状態を作ってしまうため。
fn collect_entries(
    store: &impl SecretStore,
    all: Vec<ConnectionProfile>,
    ids: Option<Vec<String>>,
) -> Result<Vec<BackupEntry>> {
    let selected: Vec<ConnectionProfile> = match ids {
        Some(ids) if !ids.is_empty() => all
            .into_iter()
            .filter(|p| ids.iter().any(|id| id == &p.id))
            .collect(),
        _ => all,
    };
    let mut entries = Vec::with_capacity(selected.len());
    for profile in selected {
        let mut s = BackupSecrets::default();
        for kind in secrets::ALL_KINDS {
            s.set(kind, store.get(&profile.id, kind)?);
        }
        entries.push(BackupEntry {
            profile,
            secrets: s,
        });
    }
    Ok(entries)
}

/// keyring へ書く前の値の記録 (ロールバック用)。値はゼロ埋めで破棄する。
struct JournalItem {
    id: String,
    kind: &'static str,
    previous: Option<Zeroizing<String>>,
}

// 値を出さない Debug (テストの `unwrap_err` などで誤って表示されても漏れない)。
impl std::fmt::Debug for JournalItem {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("JournalItem")
            .field("id", &self.id)
            .field("kind", &self.kind)
            .field("had_previous", &self.previous.is_some())
            .finish()
    }
}

/// 取り込み先 id ごとに、バックアップの秘密で keyring を置き換える。
/// バックアップに無い種類は削除する (「未設定」を維持する。Overwrite で旧サーバ
/// 向けの秘密が残るのも防ぐ)。途中で 1 件でも失敗したら、それまでに変更した
/// エントリを元の値へ戻してからエラーを返す。成功時は呼び出し元が後段 (profiles.json
/// の保存) の失敗時に戻せるよう、ジャーナルを返す。
fn apply_secrets(
    store: &impl SecretStore,
    plan: &[(String, BackupSecrets)],
) -> Result<(Vec<JournalItem>, usize)> {
    let mut journal: Vec<JournalItem> = Vec::new();
    let mut written = 0usize;
    for (id, bundle) in plan {
        for kind in secrets::ALL_KINDS {
            let step = (|| -> Result<bool> {
                let previous = store.get(id, kind)?.map(Zeroizing::new);
                journal.push(JournalItem {
                    id: id.clone(),
                    kind,
                    previous,
                });
                match bundle.get(kind) {
                    Some(v) => {
                        store.set(id, kind, v)?;
                        Ok(true)
                    }
                    None => {
                        store.delete(id, kind)?;
                        Ok(false)
                    }
                }
            })();
            match step {
                Ok(true) => written += 1,
                Ok(false) => {}
                Err(e) => {
                    rollback(store, &journal);
                    return Err(e);
                }
            }
        }
    }
    Ok((journal, written))
}

/// ジャーナルを逆順にたどって keyring を元に戻す。戻し自体の失敗は警告ログ
/// (id と種類のみ) に残して続行する — 残りのエントリはできるだけ戻したい。
fn rollback(store: &impl SecretStore, journal: &[JournalItem]) {
    for item in journal.iter().rev() {
        let res = match &item.previous {
            Some(v) => store.set(&item.id, item.kind, v),
            None => store.delete(&item.id, item.kind),
        };
        if let Err(e) = res {
            tracing::warn!(
                profile_id = %item.id,
                secret = item.kind,
                error = %e,
                "failed to roll back keyring entry after encrypted import failure"
            );
        }
    }
}

/// 全 (または指定) プロファイルを keyring の秘密込みで暗号化し、`path` に書き出す。
/// ファイル選択はフロントの保存ダイアログ (`dialog:allow-save`) で行い、書き込みは
/// ここで行う (fs capability 不要)。
#[tauri::command]
pub async fn export_profiles_encrypted(
    mut req: EncryptedExportRequest,
) -> Result<EncryptedExportResult> {
    let passphrase = Zeroizing::new(std::mem::take(&mut req.passphrase));
    if req.path.trim().is_empty() {
        return Err(AppError::InvalidInput("path is required".into()));
    }
    backup::validate_export_passphrase(&passphrase)?;
    // Argon2 (64 MiB × 3 パス) と keyring アクセスはブロッキングなので専用スレッドへ。
    let res = tokio::task::spawn_blocking(move || -> Result<EncryptedExportResult> {
        let all = store::load_all()?;
        let entries = collect_entries(&KeyringStore, all, req.ids)?;
        let profiles = entries.len();
        let secret_count = entries.iter().map(|e| e.secrets.count()).sum();
        let file = backup::seal_payload(entries, &passphrase, KdfParams::DEFAULT)?;
        let generations_pruned = write_verified(
            std::path::Path::new(&req.path),
            &file,
            &passphrase,
            (profiles, secret_count),
            req.keep_generations,
        )?;
        tracing::info!(
            path = %req.path,
            profiles,
            secrets = secret_count,
            generations_pruned,
            "profiles exported (encrypted backup)"
        );
        Ok(EncryptedExportResult {
            profiles,
            secrets: secret_count,
            bytes: file.len(),
            verified: true,
            generations_pruned,
        })
    })
    .await
    .map_err(|e| AppError::Other(format!("export task failed: {e}")))?;
    if let Err(e) = &res {
        tracing::error!(error = %e, "encrypted profile export failed");
    }
    res
}

/// 世代の退避名に使う日時の書式 (`<名前>.20260101-120000.<拡張子>`)。辞書順 = 時系列順。
const GENERATION_STAMP_FORMAT: &str = "%Y%m%d-%H%M%S";

/// `path` の退避ファイル名の幹と拡張子 (`backup.noobdb` → (`backup`, `.noobdb`))。
fn split_backup_name(path: &std::path::Path) -> (String, String) {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "backup".to_string());
    match name.rfind('.') {
        Some(i) if i > 0 => (name[..i].to_string(), name[i..].to_string()),
        _ => (name, String::new()),
    }
}

/// `name` が `<stem>.<日時 (YYYYMMDDhhmmss を `-` で区切った 15 文字)>[-<連番>]<ext>` の形の退避
/// ファイルなら、並べ替え用の `(日時, 連番)` を返す。
fn generation_key(name: &str, stem: &str, ext: &str) -> Option<(String, u32)> {
    let rest = name.strip_prefix(stem)?.strip_prefix('.')?;
    let mid = rest.strip_suffix(ext)?;
    let (stamp, seq) = match mid.split_once('-')? {
        // `20260101-120000` の `-` は日時の一部。連番は 2 つ目の `-` 以降。
        (date, tail) => match tail.split_once('-') {
            Some((time, seq)) => (format!("{date}-{time}"), Some(seq)),
            None => (format!("{date}-{tail}"), None),
        },
    };
    let stamp_ok = stamp.len() == 15
        && stamp.bytes().enumerate().all(|(i, b)| {
            if i == 8 {
                b == b'-'
            } else {
                b.is_ascii_digit()
            }
        });
    if !stamp_ok {
        return None;
    }
    let seq = match seq {
        None => 0,
        Some(q) if !q.is_empty() && q.bytes().all(|b| b.is_ascii_digit()) => q.parse().ok()?,
        Some(_) => return None,
    };
    Some((stamp, seq))
}

#[cfg(test)]
fn is_generation_name(name: &str, stem: &str, ext: &str) -> bool {
    generation_key(name, stem, ext).is_some()
}

/// 既存の `path` を退避名へ移す。退避名は更新日時 (無ければ現在) から作り、衝突したら連番を付ける。
fn archive_existing(path: &std::path::Path) -> Result<()> {
    let (stem, ext) = split_backup_name(path);
    let when = std::fs::metadata(path)
        .and_then(|m| m.modified())
        .map(chrono::DateTime::<chrono::Utc>::from)
        .unwrap_or_else(|_| chrono::Utc::now());
    let stamp = when.format(GENERATION_STAMP_FORMAT).to_string();
    let dir = path.parent().unwrap_or_else(|| std::path::Path::new("."));
    for n in 0..1000u32 {
        let name = if n == 0 {
            format!("{stem}.{stamp}{ext}")
        } else {
            format!("{stem}.{stamp}-{n}{ext}")
        };
        let dest = dir.join(name);
        if !dest.exists() {
            std::fs::rename(path, dest)?;
            return Ok(());
        }
    }
    Err(AppError::Other(
        "could not find a free name to archive the previous backup".into(),
    ))
}

/// 退避済みの世代を新しい順に `keep_archived` 件だけ残して削除し、削除した数を返す。
fn prune_generations(path: &std::path::Path, keep_archived: usize) -> Result<usize> {
    let (stem, ext) = split_backup_name(path);
    let dir = path.parent().unwrap_or_else(|| std::path::Path::new("."));
    let mut found: Vec<((String, u32), String)> = std::fs::read_dir(dir)?
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter_map(|n| generation_key(&n, &stem, &ext).map(|k| (k, n)))
        .collect();
    // 古い順 (日時 → 同じ秒の中では連番)。
    found.sort();
    let excess = found.len().saturating_sub(keep_archived);
    let mut pruned = 0;
    for (_, name) in found.into_iter().take(excess) {
        match std::fs::remove_file(dir.join(&name)) {
            Ok(()) => pruned += 1,
            Err(e) => tracing::warn!(file = %name, error = %e, "failed to remove an old backup generation"),
        }
    }
    Ok(pruned)
}

/// 暗号化済みの `file` を `path` に保存する (#1624)。
///
/// 1. 保存先と同じディレクトリの一時ファイルへ書き (原子的)、**読み直して**パスフレーズで復号し、
///    プロファイル数・秘密の件数が `expected` と一致することを確かめる。失敗したら一時ファイルを
///    消してエラーにし、既存の `path` には触れない。
/// 2. `keep_generations` が 1 以上なら、既存の `path` を退避名へ移し、古い退避を削除する。
/// 3. 一時ファイルを `path` へ rename する。
///
/// 戻り値は削除した古い世代の数。
fn write_verified(
    path: &std::path::Path,
    file: &[u8],
    passphrase: &str,
    expected: (usize, usize),
    keep_generations: Option<u32>,
) -> Result<usize> {
    let dir = path.parent().unwrap_or_else(|| std::path::Path::new("."));
    let (stem, ext) = split_backup_name(path);
    let tmp = dir.join(format!(".{stem}.verify.{}{ext}", std::process::id()));
    crate::atomic_write::write_atomic(&tmp, file)?;
    let verified = (|| -> Result<()> {
        let written = std::fs::read(&tmp)?;
        let payload = backup::open_payload(&written, passphrase)?;
        let profiles = payload.profiles.len();
        let secrets: usize = payload.profiles.iter().map(|e| e.secrets.count()).sum();
        if (profiles, secrets) != expected {
            return Err(AppError::Other(format!(
                "backup verification failed: expected {} profiles / {} secrets, read back {profiles} / {secrets}",
                expected.0, expected.1
            )));
        }
        Ok(())
    })();
    if let Err(e) = verified {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    let keep = keep_generations.filter(|n| *n > 0).map(|n| n as usize);
    let placed = (|| -> Result<usize> {
        if keep.is_some() && path.is_file() {
            archive_existing(path)?;
        }
        std::fs::rename(&tmp, path)?;
        match keep {
            Some(n) => prune_generations(path, n - 1),
            None => Ok(0),
        }
    })();
    if placed.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    placed
}

/// `path` の暗号化バックアップをパスフレーズで開封して取り込む。ID 衝突は
/// `strategy` (平文インポートと同じ Rename / Skip / Overwrite) で解決し、取り込んだ
/// 各プロファイルの秘密を取り込み先 id の keyring エントリへ書き戻す。
///
/// 整合性: profiles.json の読み → マージ → 保存をストアのロック下で行い、その
/// 保存の直前に keyring を書く。keyring の書き込みが途中で失敗したら keyring を
/// 元に戻して profiles.json は保存しない。profiles.json の保存が失敗した場合も
/// keyring を元に戻す。どちらの場合も取り込み前の状態に戻る。
#[tauri::command]
pub async fn import_profiles_encrypted(
    req: EncryptedImportRequest,
) -> Result<EncryptedImportResult> {
    let res = tokio::task::spawn_blocking(move || import_encrypted_blocking(&KeyringStore, req))
        .await
        .map_err(|e| AppError::Other(format!("import task failed: {e}")))?;
    match &res {
        Ok(r) => tracing::info!(
            imported = r.result.imported,
            skipped = r.result.skipped,
            overwritten = r.result.overwritten,
            invalid = r.result.invalid,
            secrets = r.secrets,
            "profiles imported (encrypted backup)"
        ),
        // エラー文言は BackupError / keyring / IO 由来で、秘密もパスフレーズも含まない。
        Err(e) => tracing::warn!(error = %e, "encrypted profile import failed"),
    }
    res
}

fn read_backup_file(path: &str) -> Result<Vec<u8>> {
    if path.trim().is_empty() {
        return Err(AppError::InvalidInput("path is required".into()));
    }
    let meta = std::fs::metadata(path)?;
    if meta.len() > MAX_BACKUP_FILE_BYTES {
        return Err(AppError::InvalidInput(format!(
            "The backup file is too large ({} bytes; limit {MAX_BACKUP_FILE_BYTES}).",
            meta.len()
        )));
    }
    Ok(std::fs::read(path)?)
}

fn import_encrypted_blocking(
    secret_store: &impl SecretStore,
    mut req: EncryptedImportRequest,
) -> Result<EncryptedImportResult> {
    let passphrase = Zeroizing::new(std::mem::take(&mut req.passphrase));
    let file = read_backup_file(&req.path)?;
    let payload = backup::open_payload(&file, &passphrase)?;
    drop(passphrase);

    let (profiles, bundles): (Vec<ConnectionProfile>, Vec<BackupSecrets>) = payload
        .profiles
        .into_iter()
        .map(|e| (e.profile, e.secrets))
        .unzip();

    let mut outcome: Option<(ImportResult, Vec<JournalItem>, usize)> = None;
    let saved = store::update_all(|all| {
        let (merged, result, _overwritten, placed) =
            merge_imported_placed(all, profiles, req.strategy, new_profile_id);
        let plan: Vec<(String, BackupSecrets)> = placed
            .into_iter()
            .zip(bundles)
            .filter_map(|(dest, bundle)| dest.map(|id| (id, bundle)))
            .collect();
        // keyring を先に書く。失敗したら apply_secrets が keyring を戻し、Err で
        // update_all は profiles.json を保存しない。
        let (journal, written) = apply_secrets(secret_store, &plan)?;
        outcome = Some((result, journal, written));
        Ok(merged)
    });
    match saved {
        Ok(()) => {
            let (result, _journal, secrets) = outcome.ok_or_else(|| {
                // update_all が f を呼ばずに Ok を返すことは無いので到達しない。
                AppError::Other("encrypted import did not produce a result".into())
            })?;
            Ok(EncryptedImportResult { result, secrets })
        }
        Err(e) => {
            // keyring は書けたが profiles.json の保存で失敗した場合はここで戻す
            // (keyring 側で失敗した場合は outcome が None で、既に戻してある)。
            if let Some((_, journal, _)) = &outcome {
                rollback(secret_store, journal);
            }
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    use std::collections::BTreeMap;

    /// メモリ上の keyring。`fail_set_after` 番目 (0 始まり) の set だけを失敗させる
    /// (ロールバック中の set は成功させて、戻し結果を検証するため)。
    #[derive(Default)]
    struct MemStore {
        map: RefCell<BTreeMap<(String, String), String>>,
        sets: Cell<usize>,
        fail_set_after: Option<usize>,
        fail_get: bool,
    }

    impl MemStore {
        fn with(entries: &[(&str, &str, &str)]) -> Self {
            let s = MemStore::default();
            for (id, kind, v) in entries {
                s.map
                    .borrow_mut()
                    .insert((id.to_string(), kind.to_string()), v.to_string());
            }
            s
        }
        fn value(&self, id: &str, kind: &str) -> Option<String> {
            self.map
                .borrow()
                .get(&(id.to_string(), kind.to_string()))
                .cloned()
        }
        fn snapshot(&self) -> BTreeMap<(String, String), String> {
            self.map.borrow().clone()
        }
    }

    impl SecretStore for MemStore {
        fn get(&self, id: &str, kind: &str) -> Result<Option<String>> {
            if self.fail_get {
                return Err(AppError::Keyring("locked".into()));
            }
            Ok(self.value(id, kind))
        }
        fn set(&self, id: &str, kind: &str, value: &str) -> Result<()> {
            let n = self.sets.get();
            self.sets.set(n + 1);
            if self.fail_set_after == Some(n) {
                return Err(AppError::Keyring("write denied".into()));
            }
            self.map
                .borrow_mut()
                .insert((id.to_string(), kind.to_string()), value.to_string());
            Ok(())
        }
        fn delete(&self, id: &str, kind: &str) -> Result<()> {
            self.map
                .borrow_mut()
                .remove(&(id.to_string(), kind.to_string()));
            Ok(())
        }
    }

    fn profile(id: &str) -> ConnectionProfile {
        serde_json::from_value(serde_json::json!({
            "id": id, "name": format!("P-{id}"), "driver": "postgres", "host": "h",
            "port": 5432, "user": "u", "database": null, "ssh": null
        }))
        .unwrap()
    }

    fn bundle(pairs: &[(&str, &str)]) -> BackupSecrets {
        let mut b = BackupSecrets::default();
        for (k, v) in pairs {
            b.set(k, Some(v.to_string()));
        }
        b
    }

    #[test]
    fn collect_entries_reads_every_kind_and_keeps_unset() {
        let store = MemStore::with(&[
            ("a", "db_password", "pw-a"),
            ("a", "ssh_password_hop0", "jump-a"),
        ]);
        let entries = collect_entries(&store, vec![profile("a"), profile("b")], None).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].secrets.get("db_password"), Some("pw-a"));
        assert_eq!(entries[0].secrets.get("ssh_password_hop0"), Some("jump-a"));
        assert_eq!(entries[0].secrets.count(), 2);
        assert_eq!(entries[1].secrets.count(), 0);
    }

    #[test]
    fn collect_entries_filters_by_ids() {
        let store = MemStore::default();
        let entries = collect_entries(
            &store,
            vec![profile("a"), profile("b")],
            Some(vec!["b".into(), "zzz".into()]),
        )
        .unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].profile.id, "b");
    }

    #[test]
    fn collect_entries_fails_on_keyring_read_error() {
        let store = MemStore {
            fail_get: true,
            ..Default::default()
        };
        assert!(collect_entries(&store, vec![profile("a")], None).is_err());
    }

    #[test]
    fn apply_secrets_sets_values_and_clears_missing_kinds() {
        // 既存の古い ssh_password は、バックアップに無いので消える (未設定を維持)。
        let store = MemStore::with(&[("a", "ssh_password", "stale")]);
        let plan = vec![("a".to_string(), bundle(&[("db_password", "new-pw")]))];
        let (_, written) = apply_secrets(&store, &plan).unwrap();
        assert_eq!(written, 1);
        assert_eq!(store.value("a", "db_password").as_deref(), Some("new-pw"));
        assert_eq!(store.value("a", "ssh_password"), None);
    }

    #[test]
    fn apply_secrets_rolls_back_every_change_on_failure() {
        let store = MemStore {
            fail_set_after: Some(2),
            ..MemStore::with(&[
                ("a", "db_password", "old-a"),
                ("a", "ssh_passphrase", "old-pp"),
                ("b", "db_password", "old-b"),
            ])
        };
        let before = store.snapshot();
        let plan = vec![
            ("a".to_string(), bundle(&[("db_password", "new-a")])), // set #0
            ("b".to_string(), bundle(&[("db_password", "new-b")])), // set #1
            ("c".to_string(), bundle(&[("db_password", "new-c")])), // set #2 -> fail
        ];
        let err = apply_secrets(&store, &plan).unwrap_err();
        assert!(matches!(err, AppError::Keyring(_)));
        // a の ssh_passphrase の削除も含め、すべて元の状態に戻っている。
        assert_eq!(store.snapshot(), before);
    }

    #[test]
    fn rollback_restores_after_later_failure() {
        let store = MemStore::with(&[("a", "db_password", "old")]);
        let before = store.snapshot();
        let plan = vec![(
            "a".to_string(),
            bundle(&[("db_password", "new"), ("ssh_password", "x")]),
        )];
        let (journal, _) = apply_secrets(&store, &plan).unwrap();
        assert_eq!(store.value("a", "db_password").as_deref(), Some("new"));
        // profiles.json の保存失敗を想定して戻す。
        rollback(&store, &journal);
        assert_eq!(store.snapshot(), before);
    }

    /// 別マシン (空の keyring) への移行を、純ロジックだけで端から端まで通す:
    /// 収集 → 封緘 → 開封 → マージ → keyring 書き戻し。
    #[test]
    fn export_then_import_into_empty_keyring_restores_secrets() {
        let src = MemStore::with(&[
            ("a", "db_password", "pw-a"),
            ("a", "ssh_passphrase", "pp-a"),
            ("b", "ssh_password", "sshpw-b"),
        ]);
        let entries =
            collect_entries(&src, vec![profile("a"), profile("b"), profile("c")], None).unwrap();
        let fast = KdfParams {
            m_cost_kib: 64,
            t_cost: 1,
            p_cost: 1,
        };
        let file = backup::seal_payload(entries, "migration passphrase", fast).unwrap();

        let payload = backup::open_payload(&file, "migration passphrase").unwrap();
        let (profiles, bundles): (Vec<_>, Vec<_>) = payload
            .profiles
            .into_iter()
            .map(|e| (e.profile, e.secrets))
            .unzip();
        let mut n = 0;
        let (merged, result, _, placed) =
            merge_imported_placed(vec![], profiles, ImportStrategy::Rename, || {
                n += 1;
                format!("gen{n}")
            });
        assert_eq!(result.imported, 3);
        assert_eq!(merged.len(), 3);
        let plan: Vec<_> = placed
            .into_iter()
            .zip(bundles)
            .filter_map(|(d, b)| d.map(|id| (id, b)))
            .collect();
        let dst = MemStore::default();
        let (_, written) = apply_secrets(&dst, &plan).unwrap();
        assert_eq!(written, 3);
        assert_eq!(dst.snapshot(), src.snapshot());
    }

    #[test]
    fn rename_on_collision_writes_secrets_under_the_new_id() {
        let fast = KdfParams {
            m_cost_kib: 64,
            t_cost: 1,
            p_cost: 1,
        };
        let src = MemStore::with(&[("a", "db_password", "incoming")]);
        let entries = collect_entries(&src, vec![profile("a")], None).unwrap();
        let file = backup::seal_payload(entries, "migration passphrase", fast).unwrap();
        let payload = backup::open_payload(&file, "migration passphrase").unwrap();
        let (profiles, bundles): (Vec<_>, Vec<_>) = payload
            .profiles
            .into_iter()
            .map(|e| (e.profile, e.secrets))
            .unzip();
        let (_, _, _, placed) =
            merge_imported_placed(vec![profile("a")], profiles, ImportStrategy::Rename, || {
                "fresh".to_string()
            });
        let plan: Vec<_> = placed
            .into_iter()
            .zip(bundles)
            .filter_map(|(d, b)| d.map(|id| (id, b)))
            .collect();
        let dst = MemStore::with(&[("a", "db_password", "existing")]);
        apply_secrets(&dst, &plan).unwrap();
        // 既存 a の秘密は温存、取り込んだ方は新 id に入る。
        assert_eq!(dst.value("a", "db_password").as_deref(), Some("existing"));
        assert_eq!(
            dst.value("fresh", "db_password").as_deref(),
            Some("incoming")
        );
    }

    #[test]
    fn request_debug_never_prints_passphrase() {
        let req: EncryptedImportRequest = serde_json::from_value(serde_json::json!({
            "path": "/tmp/x.noobdb-backup",
            "passphrase": "very-secret-pass",
            "strategy": "rename"
        }))
        .unwrap();
        let dbg = format!("{req:?}");
        assert!(!dbg.contains("very-secret-pass"), "{dbg}");
        let req: EncryptedExportRequest = serde_json::from_value(serde_json::json!({
            "path": "/tmp/x.noobdb-backup",
            "passphrase": "very-secret-pass"
        }))
        .unwrap();
        assert!(!format!("{req:?}").contains("very-secret-pass"));
    }

    fn sealed(ids: &[&str]) -> (Vec<u8>, (usize, usize)) {
        let fast = KdfParams {
            m_cost_kib: 8,
            t_cost: 1,
            p_cost: 1,
        };
        let entries: Vec<BackupEntry> = ids
            .iter()
            .map(|id| BackupEntry {
                profile: profile(id),
                secrets: bundle(&[("password", "pw")]),
            })
            .collect();
        let secrets = entries.iter().map(|e| e.secrets.count()).sum();
        let count = entries.len();
        (
            backup::seal_payload(entries, "migration passphrase", fast).unwrap(),
            (count, secrets),
        )
    }

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("noobdb_pbackup_{tag}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    // #1624: 書き出し直後の復号検証。件数が合わない・パスフレーズが違うときは保存先を置き換えない。
    #[test]
    fn write_verified_checks_decryption_and_keeps_existing_file_on_failure() {
        let dir = temp_dir("verify");
        let path = dir.join("b.noobdb");
        std::fs::write(&path, b"old").unwrap();
        let (file, expected) = sealed(&["a", "b"]);
        // 件数の期待値が合わない → エラー、既存ファイルは無傷、一時ファイルも残らない。
        let err = write_verified(&path, &file, "migration passphrase", (3, expected.1), None)
            .unwrap_err()
            .to_string();
        assert!(err.contains("verification failed"), "{err}");
        assert_eq!(std::fs::read(&path).unwrap(), b"old");
        // パスフレーズ違い → エラー。
        assert!(write_verified(&path, &file, "wrong passphrase!!", expected, None).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"old");
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        // 正常。
        assert_eq!(
            write_verified(&path, &file, "migration passphrase", expected, None).unwrap(),
            0
        );
        assert_eq!(std::fs::read(&path).unwrap(), file);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // #1624: 世代管理。上書き前のファイルを退避し、最新を含めて指定件数に収める。
    #[test]
    fn write_verified_keeps_the_requested_number_of_generations() {
        let dir = temp_dir("gens");
        let path = dir.join("b.noobdb");
        let (file, expected) = sealed(&["a"]);
        for _ in 0..5 {
            write_verified(&path, &file, "migration passphrase", expected, Some(3)).unwrap();
            // 退避名は秒単位の日時 + 連番なので、同じ秒でも衝突しない。
        }
        let mut names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        // 最新 1 + 退避 2 = 3 件。
        assert_eq!(names.len(), 3, "{names:?}");
        assert!(names.contains(&"b.noobdb".to_string()));
        assert_eq!(
            names.iter().filter(|n| is_generation_name(n, "b", ".noobdb")).count(),
            2
        );
        // 世代管理なし (None / 0) は退避も削除もしない。
        write_verified(&path, &file, "migration passphrase", expected, Some(0)).unwrap();
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 3);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn generation_names_are_recognised_strictly() {
        assert!(is_generation_name("b.20260101-120000.noobdb", "b", ".noobdb"));
        assert!(is_generation_name("b.20260101-120000-2.noobdb", "b", ".noobdb"));
        assert!(!is_generation_name("b.noobdb", "b", ".noobdb"));
        assert!(!is_generation_name("b.2026.noobdb", "b", ".noobdb"));
        assert!(!is_generation_name("c.20260101-120000.noobdb", "b", ".noobdb"));
        assert!(!is_generation_name("b.20260101-120000.txt", "b", ".noobdb"));
        assert!(!is_generation_name("b.20260101-1200xx.noobdb", "b", ".noobdb"));
        assert_eq!(
            split_backup_name(std::path::Path::new("/x/profiles.noobdb-backup")),
            ("profiles".to_string(), ".noobdb-backup".to_string())
        );
    }

    #[test]
    fn read_backup_file_rejects_empty_path() {
        assert!(matches!(
            read_backup_file("  ").unwrap_err(),
            AppError::InvalidInput(_)
        ));
    }
}
