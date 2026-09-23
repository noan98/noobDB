//! `assertions.json` の永続化 (#742)。`snippets/store.rs` と同じ JSON ストア
//! パターン: read-modify-write 全体をストア単位の `Mutex` で直列化し、書き込みは
//! PID + プロセス内カウンタで一意な一時ファイル経由のアトミック置換にする
//! (`noobdb-storage` スキルの必須対策 2 点)。

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};

use directories::ProjectDirs;
use serde::{Deserialize, Serialize};

use super::Assertion;
use crate::error::{AppError, Result};

const QUALIFIER: &str = "";
const ORG: &str = "";
const APP: &str = "noobDB";
const FILE_NAME: &str = "assertions.json";

/// On-disk shape: `{ "assertions": [...] }`。配列を包んでおくことで、将来
/// トップレベルのメタデータを足してもフォーマット移行が要らない。
#[derive(Debug, Default, Serialize, Deserialize)]
struct AssertionFile {
    #[serde(default)]
    assertions: Vec<Assertion>,
}

/// `assertions.json` への read-modify-write を直列化するロック。
/// `snippets::store::STORE_LOCK` と同じ理由・同じ設計 (Tauri の `async fn`
/// コマンドはプロセス内で並行実行されるため、無防備だと後勝ちで lost update)。
/// poisoning は `into_inner` で回復する — 書きかけの内容は `write_atomic` の
/// 一時ファイル側にしか無く、本ファイルは直前の一貫した状態のままなので安全。
static STORE_LOCK: Mutex<()> = Mutex::new(());

fn lock_store() -> std::sync::MutexGuard<'static, ()> {
    STORE_LOCK.lock().unwrap_or_else(PoisonError::into_inner)
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
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content = std::fs::read_to_string(path)?;
    if content.trim().is_empty() {
        return Ok(Vec::new());
    }
    let file: AssertionFile = serde_json::from_str(&content)?;
    Ok(file.assertions)
}

/// 実際のファイル書き込み (ロック非取得)。`load_from` と対。
fn save_to(path: &Path, assertions: &[Assertion]) -> Result<()> {
    let file = AssertionFile {
        assertions: assertions.to_vec(),
    };
    let content = serde_json::to_string_pretty(&file)?;
    write_atomic(path, content.as_bytes())?;
    Ok(())
}

/// `load_from` → 変更 → `save_to` をパス指定で行う内部版 (ロック非取得)。
/// 公開関数とテストの両方から使う。
fn upsert_at(path: &Path, assertion: Assertion) -> Result<()> {
    let mut all = load_from(path)?;
    if let Some(existing) = all.iter_mut().find(|a| a.id == assertion.id) {
        *existing = assertion;
    } else {
        all.push(assertion);
    }
    save_to(path, &all)
}

fn delete_at(path: &Path, id: &str) -> Result<()> {
    let mut all = load_from(path)?;
    all.retain(|a| a.id != id);
    save_to(path, &all)
}

pub fn load_all() -> Result<Vec<Assertion>> {
    let _guard = lock_store();
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
    let _guard = lock_store();
    upsert_at(&assertions_path()?, assertion)
}

pub fn delete(id: &str) -> Result<()> {
    let _guard = lock_store();
    delete_at(&assertions_path()?, id)
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

        delete_at(&path, "aaaaaaaa").unwrap();
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

    // 空ファイルは空一覧として扱う (手で truncate されたファイルでも起動できる)。
    #[test]
    fn empty_file_loads_as_empty_list() {
        let dir = scratch_dir("empty");
        let path = dir.join(FILE_NAME);
        std::fs::write(&path, "  \n").unwrap();
        assert!(load_from(&path).unwrap().is_empty());
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
