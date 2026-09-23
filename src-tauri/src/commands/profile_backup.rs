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
        std::fs::write(&req.path, &file)?;
        tracing::info!(
            path = %req.path,
            profiles,
            secrets = secret_count,
            "profiles exported (encrypted backup)"
        );
        Ok(EncryptedExportResult {
            profiles,
            secrets: secret_count,
            bytes: file.len(),
        })
    })
    .await
    .map_err(|e| AppError::Other(format!("export task failed: {e}")))?;
    if let Err(e) = &res {
        tracing::error!(error = %e, "encrypted profile export failed");
    }
    res
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

    #[test]
    fn read_backup_file_rejects_empty_path() {
        assert!(matches!(
            read_backup_file("  ").unwrap_err(),
            AppError::InvalidInput(_)
        ));
    }
}
