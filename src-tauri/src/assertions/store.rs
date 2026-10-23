//! `assertions.json` の永続化 (#742)。`snippets/store.rs` と同じ JSON ストア
//! パターン: read-modify-write 全体をストア単位の `Mutex` で直列化し、書き込みは
//! PID + プロセス内カウンタで一意な一時ファイル経由のアトミック置換にする
//! (`noobdb-storage` スキルの必須対策 2 点)。

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use directories::ProjectDirs;
use serde::{Deserialize, Serialize};

use super::Assertion;
use crate::error::{AppError, Result};

const QUALIFIER: &str = "";
const ORG: &str = "";
const APP: &str = "noobDB";
const FILE_NAME: &str = "assertions.json";

/// 削除の取り消し (#1621) のために残す直近の削除済み件数。これを超えた古いものから捨てる。
const TRASH_LIMIT: usize = 50;

/// 削除済みアサーション 1 件。`assertions.json` の `trash` に直近 [`TRASH_LIMIT`] 件だけ
/// 残し、`restore` で元に戻せる (誤って数十件消した事故の取り消し用)。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DeletedAssertion {
    pub assertion: Assertion,
    /// 削除した時刻 (UTC, RFC 3339)。
    pub deleted_at: String,
}

/// On-disk shape: `{ "assertions": [...], "trash": [...] }`。配列を包んでおくことで、
/// 将来トップレベルのメタデータを足してもフォーマット移行が要らない。`trash` は
/// 後から足したフィールドなので、無い古いファイルは空として読む。
#[derive(Debug, Default, Serialize, Deserialize)]
struct AssertionFile {
    #[serde(default)]
    assertions: Vec<Assertion>,
    #[serde(default)]
    trash: Vec<DeletedAssertion>,
}

/// `assertions.json` への read-modify-write を直列化するロック。
/// `snippets::store::STORE_LOCK` と同じ理由・同じ設計 (Tauri の `async fn`
/// コマンドはプロセス内で並行実行されるため、無防備だと後勝ちで lost update)。
/// poisoning は `into_inner` で回復する — 書きかけの内容は `write_atomic` の
/// 一時ファイル側にしか無く、本ファイルは直前の一貫した状態のままなので安全。
static STORE_LOCK: Mutex<()> = Mutex::new(());

fn lock_store() -> Result<crate::store_lock::StoreGuard<'static>> {
    crate::store_lock::acquire(&STORE_LOCK, &assertions_path()?)
}

fn data_dir() -> Option<PathBuf> {
    ProjectDirs::from(QUALIFIER, ORG, APP).map(|p| p.data_dir().to_path_buf())
}

fn assertions_path() -> Result<PathBuf> {
    let dir = data_dir().ok_or(AppError::ConfigDir)?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join(FILE_NAME))
}

/// 実際のファイル読み込み (ロック非取得)。
fn load_from(path: &Path) -> Result<Vec<Assertion>> {
    Ok(load_file(path)?.assertions)
}

/// ファイル全体 (一覧 + ごみ箱) の読み込み (ロック非取得)。
fn load_file(path: &Path) -> Result<AssertionFile> {
    if !path.exists() {
        return Ok(AssertionFile::default());
    }
    let content = std::fs::read_to_string(path)?;
    if content.trim().is_empty() {
        return Ok(AssertionFile::default());
    }
    match serde_json::from_str::<AssertionFile>(&content) {
        Ok(file) => Ok(file),
        Err(e) => {
            // 壊れたままだと一覧・追加・編集・削除・定期タスクのアサーション実行が
            // すべて失敗し、画面から復旧できない。`tasks.json` と同じく退避して
            // 空から再開する (退避先は `assertions.json.corrupt-<UTC>`。内容は失わない)。
            let backup = crate::json_tolerant::corrupt_backup_path(path);
            tracing::error!(
                path = %path.display(),
                backup = %backup.display(),
                error = %e,
                "assertions: assertions.json is corrupt; moving it aside and starting empty"
            );
            std::fs::rename(path, &backup)?;
            Ok(AssertionFile::default())
        }
    }
}

/// 実際のファイル書き込み (ロック非取得)。`load_file` と対。
fn save_file(path: &Path, file: &AssertionFile) -> Result<()> {
    let content = serde_json::to_string_pretty(file)?;
    write_atomic(path, content.as_bytes())?;
    Ok(())
}

/// `load_file` → 変更 → `save_file` をパス指定で行う内部版 (ロック非取得)。
/// 公開関数とテストの両方から使う。
fn upsert_at(path: &Path, assertion: Assertion) -> Result<()> {
    let mut file = load_file(path)?;
    if let Some(existing) = file.assertions.iter_mut().find(|a| a.id == assertion.id) {
        *existing = assertion;
    } else {
        file.assertions.push(assertion);
    }
    save_file(path, &file)
}

/// 削除は一覧から外してごみ箱へ移す (#1621)。`deleted_at` は呼び出し側が渡す
/// (テストで固定できるよう、ここでは時計を読まない)。
fn delete_at(path: &Path, id: &str, deleted_at: &str) -> Result<()> {
    let mut file = load_file(path)?;
    let Some(pos) = file.assertions.iter().position(|a| a.id == id) else {
        return Ok(());
    };
    let removed = file.assertions.remove(pos);
    file.trash.retain(|d| d.assertion.id != id);
    file.trash.push(DeletedAssertion {
        assertion: removed,
        deleted_at: deleted_at.to_string(),
    });
    if file.trash.len() > TRASH_LIMIT {
        let excess = file.trash.len() - TRASH_LIMIT;
        file.trash.drain(..excess);
    }
    save_file(path, &file)
}

/// ごみ箱から 1 件を一覧へ戻す。ごみ箱に無ければ `InvalidInput`。同じ ID が既に
/// 一覧にあれば (削除後に同じ ID で保存し直した等) 上書きせずそちらを残す。
fn restore_at(path: &Path, id: &str) -> Result<Assertion> {
    let mut file = load_file(path)?;
    let Some(pos) = file.trash.iter().position(|d| d.assertion.id == id) else {
        return Err(AppError::InvalidInput(format!(
            "deleted assertion not found: {id}"
        )));
    };
    let restored = file.trash.remove(pos).assertion;
    if !file.assertions.iter().any(|a| a.id == restored.id) {
        file.assertions.push(restored.clone());
    }
    save_file(path, &file)?;
    Ok(restored)
}

/// 取り込んだアサーションをまとめて追加する (呼び出し側が ID の衝突を解決済み)。
fn append_at(path: &Path, items: &[Assertion]) -> Result<()> {
    let mut file = load_file(path)?;
    file.assertions.extend(items.iter().cloned());
    save_file(path, &file)
}

pub fn load_all() -> Result<Vec<Assertion>> {
    let _guard = lock_store()?;
    load_from(&assertions_path()?)
}

/// `id` のアサーションを 1 件返す。無ければ `InvalidInput`。
pub fn get(id: &str) -> Result<Assertion> {
    load_all()?
        .into_iter()
        .find(|a| a.id == id)
        .ok_or_else(|| AppError::InvalidInput(format!("assertion not found: {id}")))
}

pub fn upsert(assertion: Assertion) -> Result<()> {
    // 読み→書きの全体でロックを保持する (内部版はロックを取らない)。
    let _guard = lock_store()?;
    upsert_at(&assertions_path()?, assertion)
}

/// 一覧から外してごみ箱へ移す (取り消し可能、[`restore`])。
pub fn delete(id: &str) -> Result<()> {
    let _guard = lock_store()?;
    delete_at(
        &assertions_path()?,
        id,
        &chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
    )
}

/// 削除したアサーションを一覧へ戻す (#1621)。
pub fn restore(id: &str) -> Result<Assertion> {
    let _guard = lock_store()?;
    restore_at(&assertions_path()?, id)
}

/// 取り込み (#1621): 既存一覧との重複・ID の衝突を解決した結果を追記する。
/// 判定から追記までを 1 回のロックで行う (取り込み中の保存と競合しない)。
pub fn import(
    incoming: Vec<Assertion>,
    mut new_id: impl FnMut() -> String,
) -> Result<ImportOutcome> {
    let _guard = lock_store()?;
    let path = assertions_path()?;
    let existing = load_from(&path)?;
    let outcome = plan_import(&existing, incoming, &mut new_id);
    if !outcome.imported.is_empty() {
        append_at(&path, &outcome.imported)?;
    }
    Ok(outcome)
}

/// 取り込み結果。
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct ImportOutcome {
    /// 追加されたアサーション (ID は衝突時に採番し直したもの)。
    pub imported: Vec<Assertion>,
    /// 既存と内容が同じため追加しなかった件数。
    pub skipped_duplicates: u32,
}

/// 内容 (ID 以外) が同じかどうか。再度の取り込みで同じルールが二重に増えないようにする。
fn same_content(a: &Assertion, b: &Assertion) -> bool {
    a.name == b.name
        && a.scope == b.scope
        && a.schema == b.schema
        && a.table == b.table
        && a.rule == b.rule
}

/// 取り込みの純ロジック: 既存と同内容のものは飛ばし、ID が既存 (または取り込み内の
/// 先行分) と衝突するものは `new_id` で採番し直す。
pub fn plan_import(
    existing: &[Assertion],
    incoming: Vec<Assertion>,
    new_id: &mut impl FnMut() -> String,
) -> ImportOutcome {
    let mut out = ImportOutcome::default();
    let mut taken: std::collections::HashSet<String> =
        existing.iter().map(|a| a.id.clone()).collect();
    for mut a in incoming {
        let dup = existing
            .iter()
            .chain(out.imported.iter())
            .any(|e| same_content(e, &a));
        if dup {
            out.skipped_duplicates += 1;
            continue;
        }
        if a.id.is_empty() || taken.contains(&a.id) {
            // 衝突し続ける生成器でも無限ループしないよう、試行回数に上限を置く。
            let mut candidate = new_id();
            let mut tries = 0;
            while taken.contains(&candidate) && tries < 16 {
                candidate = new_id();
                tries += 1;
            }
            a.id = candidate;
        }
        taken.insert(a.id.clone());
        out.imported.push(a);
    }
    out
}

/// `path` をアトミックに (全体差し替えで) 書き込む。`snippets::store::write_atomic`
/// と同じ理由・同じ実装 (モジュールをまたいだ共有ヘルパーにはせず各ストアで完結させる
/// 既存の流儀に合わせる)。
fn write_atomic(path: &Path, content: &[u8]) -> std::io::Result<()> {
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    // PID だけでは同一プロセス内の並行呼び出しを区別できないため、プロセス内で
    // 単調増加するカウンタも足して一時ファイル名を一意にする。
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    let tmp_path = dir.join(format!(
        ".{}.tmp.{}.{}",
        path.file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| FILE_NAME.to_string()),
        std::process::id(),
        seq
    ));
    // `create_new` (`O_CREAT|O_EXCL`) で排他予約する (シンボリックリンクの先を
    // 切り詰めない。`snippets::store` と同じ防御)。`open` 自体の失敗時に消さない
    // のも同じ理由 (他プロセスの書きかけを指しうる)。
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp_path)?;
    let written = f.write_all(content).and_then(|()| f.sync_all());
    // Windows は開いたままのファイルを rename できないため、先に閉じる。
    drop(f);
    let written = written.and_then(|()| std::fs::rename(&tmp_path, path));
    if written.is_err() {
        let _ = std::fs::remove_file(&tmp_path);
    }
    written
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assertions::AssertionRule;
    use crate::snippets::SnippetScope;

    fn scratch_dir(tag: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!(
            "noobdb_assertions_store_test_{tag}_{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn sample(id: &str, name: &str) -> Assertion {
        Assertion {
            id: id.into(),
            name: name.into(),
            scope: SnippetScope::Profile {
                profile_id: "p1".into(),
            },
            schema: None,
            table: "users".into(),
            rule: AssertionRule::NotNull {
                column: "email".into(),
            },
        }
    }

    // 定義が再起動後も保持される (= ファイルへ書いた内容を別の load で読み戻せる)
    // こと、upsert が同 ID を置換し delete が消すことを固定する。
    #[test]
    fn upsert_replace_and_delete_roundtrip() {
        let dir = scratch_dir("roundtrip");
        let path = dir.join(FILE_NAME);
        assert!(
            load_from(&path).unwrap().is_empty(),
            "missing file is empty"
        );

        upsert_at(&path, sample("aaaaaaaa", "first")).unwrap();
        upsert_at(&path, sample("bbbbbbbb", "second")).unwrap();
        upsert_at(&path, sample("aaaaaaaa", "renamed")).unwrap();
        let all = load_from(&path).unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].name, "renamed");
        assert_eq!(all[1], sample("bbbbbbbb", "second"));

        delete_at(&path, "aaaaaaaa", "2026-01-01T00:00:00Z").unwrap();
        let all = load_from(&path).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].id, "bbbbbbbb");

        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name() != FILE_NAME)
            .collect();
        assert!(leftovers.is_empty(), "temp file left: {leftovers:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // 削除はごみ箱へ移り、restore で元に戻せる。ごみ箱は一覧の保存を跨いで保持される。
    #[test]
    fn delete_moves_to_trash_and_restore_brings_it_back() {
        let dir = scratch_dir("trash");
        let path = dir.join(FILE_NAME);
        upsert_at(&path, sample("aaaaaaaa", "first")).unwrap();
        upsert_at(&path, sample("bbbbbbbb", "second")).unwrap();
        delete_at(&path, "aaaaaaaa", "2026-01-01T00:00:00Z").unwrap();
        // 別の保存でごみ箱が消えない。
        upsert_at(&path, sample("cccccccc", "third")).unwrap();
        let file = load_file(&path).unwrap();
        assert_eq!(file.assertions.len(), 2);
        assert_eq!(file.trash.len(), 1);
        assert_eq!(file.trash[0].deleted_at, "2026-01-01T00:00:00Z");

        let back = restore_at(&path, "aaaaaaaa").unwrap();
        assert_eq!(back.name, "first");
        let file = load_file(&path).unwrap();
        assert_eq!(file.assertions.len(), 3);
        assert!(file.trash.is_empty());
        assert!(restore_at(&path, "aaaaaaaa").is_err(), "already restored");
        // 存在しない ID の削除は何もしない。
        delete_at(&path, "zzzzzzzz", "2026-01-01T00:00:00Z").unwrap();
        assert!(load_file(&path).unwrap().trash.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ごみ箱は直近 TRASH_LIMIT 件だけを保持する。
    #[test]
    fn trash_is_capped() {
        let dir = scratch_dir("trash_cap");
        let path = dir.join(FILE_NAME);
        for i in 0..(TRASH_LIMIT + 5) {
            let id = format!("id{i:06}");
            upsert_at(&path, sample(&id, "n")).unwrap();
            delete_at(&path, &id, "2026-01-01T00:00:00Z").unwrap();
        }
        let file = load_file(&path).unwrap();
        assert_eq!(file.trash.len(), TRASH_LIMIT);
        assert_eq!(file.trash[0].assertion.id, "id000005");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // `trash` を持たない古いファイルも読める。
    #[test]
    fn legacy_file_without_trash_loads() {
        let dir = scratch_dir("legacy");
        let path = dir.join(FILE_NAME);
        std::fs::write(&path, "{\"assertions\": []}").unwrap();
        assert!(load_file(&path).unwrap().trash.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn plan_import_resolves_id_collisions_and_skips_duplicates() {
        let existing = vec![sample("aaaaaaaa", "first")];
        let mut other = sample("aaaaaaaa", "other");
        other.table = "orders".into();
        let incoming = vec![
            sample("zzzzzzzz", "first"), // 既存と同内容 → スキップ
            other,                       // ID 衝突 → 採番し直し
            sample("bbbbbbbb", "fresh"), // そのまま
            sample("bbbbbbbb", "fresh"), // 取り込み内の重複 → スキップ
        ];
        let mut n = 0;
        let mut gen = || {
            n += 1;
            format!("new{n:05}")
        };
        let out = plan_import(&existing, incoming, &mut gen);
        assert_eq!(out.skipped_duplicates, 2);
        assert_eq!(out.imported.len(), 2);
        assert_eq!(out.imported[0].id, "new00001");
        assert_eq!(out.imported[0].table, "orders");
        assert_eq!(out.imported[1].id, "bbbbbbbb");
    }

    #[test]
    fn plan_import_gives_empty_ids_a_fresh_one() {
        let mut a = sample("", "x");
        a.id = String::new();
        let mut gen = || "gen00001".to_string();
        let out = plan_import(&[], vec![a], &mut gen);
        assert_eq!(out.imported[0].id, "gen00001");
    }

    // 空ファイルは空一覧として扱う (手で truncate されたファイルでも起動できる)。
    #[test]
    fn empty_file_loads_as_empty_list() {
        let dir = scratch_dir("empty");
        let path = dir.join(FILE_NAME);
        std::fs::write(&path, "  \n").unwrap();
        assert!(load_from(&path).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    // 壊れた JSON は退避して空から再開し、その後の追加が成功する。
    #[test]
    fn corrupt_file_is_quarantined_and_store_recovers() {
        let dir = scratch_dir("corrupt");
        let path = dir.join(FILE_NAME);
        std::fs::write(&path, "{\"assertions\": [,]}").unwrap();
        assert!(load_from(&path).unwrap().is_empty());
        let backups: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".corrupt-"))
            .collect();
        assert_eq!(backups.len(), 1);
        assert_eq!(
            std::fs::read_to_string(backups[0].path()).unwrap(),
            "{\"assertions\": [,]}"
        );
        upsert_at(&path, sample("aaaaaaaa", "first")).unwrap();
        assert_eq!(load_from(&path).unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_atomic_is_safe_under_same_process_concurrency() {
        let dir = scratch_dir("atomic_concurrent");
        let path = std::sync::Arc::new(dir.join(FILE_NAME));
        let handles: Vec<_> = (0..16)
            .map(|i| {
                let path = std::sync::Arc::clone(&path);
                std::thread::spawn(move || {
                    write_atomic(&path, format!("payload-{i}").as_bytes()).unwrap();
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        assert!(std::fs::read_to_string(&*path)
            .unwrap()
            .starts_with("payload-"));
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name() != FILE_NAME)
            .collect();
        assert!(leftovers.is_empty(), "temp file left: {leftovers:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
