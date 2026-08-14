use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, PoisonError};

use directories::ProjectDirs;
use serde::{Deserialize, Serialize};

use super::Snippet;
use crate::error::{AppError, Result};

const QUALIFIER: &str = "";
const ORG: &str = "";
const APP: &str = "noobDB";

/// On-disk shape: `{ "snippets": [...] }`. Wrapping the array keeps room for
/// future top-level metadata without a format migration.
#[derive(Debug, Default, Serialize, Deserialize)]
struct SnippetFile {
    #[serde(default)]
    snippets: Vec<Snippet>,
}

/// `snippets.json` への read-modify-write を直列化するロック。`profiles::store::
/// STORE_LOCK` (根拠は `ssh::known_hosts::KNOWN_HOSTS_LOCK`) と同じ理由・同じ設計:
/// Tauri の `async fn` コマンドはプロセス内で並行実行されるため、`upsert`/`delete`
/// の「読み → 変更 → 書き」を無防備にすると後勝ちの `save_all` が他方の変更を
/// 消す。poisoning は `into_inner` で回復する — パニック時点の書きかけ内容は
/// `write_atomic` の一時ファイル側にしか無く、本ファイルは直前の一貫した状態の
/// ままなので安全。
static STORE_LOCK: Mutex<()> = Mutex::new(());

fn lock_store() -> std::sync::MutexGuard<'static, ()> {
    STORE_LOCK.lock().unwrap_or_else(PoisonError::into_inner)
}

pub fn data_dir() -> Option<PathBuf> {
    ProjectDirs::from(QUALIFIER, ORG, APP).map(|p| p.data_dir().to_path_buf())
}

pub fn snippets_path() -> Result<PathBuf> {
    let dir = data_dir().ok_or(AppError::ConfigDir)?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("snippets.json"))
}

/// 実際のファイル読み込み (ロック非取得)。`upsert`/`delete` のようにロックを跨いだ
/// 複合操作から使うための内部版。
fn load_all_locked() -> Result<Vec<Snippet>> {
    let path = snippets_path()?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content = std::fs::read_to_string(&path)?;
    if content.trim().is_empty() {
        return Ok(Vec::new());
    }
    let file: SnippetFile = serde_json::from_str(&content)?;
    Ok(file.snippets)
}

/// 実際のファイル書き込み (ロック非取得)。`load_all_locked` と対。
fn save_all_locked(snippets: &[Snippet]) -> Result<()> {
    let path = snippets_path()?;
    let file = SnippetFile {
        snippets: snippets.to_vec(),
    };
    let content = serde_json::to_string_pretty(&file)?;
    write_atomic(&path, content.as_bytes())?;
    Ok(())
}

pub fn load_all() -> Result<Vec<Snippet>> {
    let _guard = lock_store();
    load_all_locked()
}

/// `path` をアトミックに (全体差し替えで) 書き込む。`profiles::store::write_atomic`
/// と同じ理由 (書き込み途中のクラッシュ/電源断/ディスクフルで JSON が半端に残り、
/// 以後パース失敗で全スニペットが読めなくなる事態を防ぐ) で、同じディレクトリに
/// 一時ファイルを書いて `sync_all` してから `rename` する。モジュールをまたいだ
/// 共有ヘルパーにはせず、このファイル内で完結させている。
fn write_atomic(path: &std::path::Path, content: &[u8]) -> std::io::Result<()> {
    let dir = path.parent().unwrap_or_else(|| std::path::Path::new("."));
    // PID だけでは同一プロセス内の並行呼び出し (Tauri の `async fn` コマンドは
    // プロセス内で並行実行される) を区別できないため、プロセス内で単調増加する
    // カウンタも足して一時ファイル名を一意にする。
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    let tmp_path = dir.join(format!(
        ".{}.tmp.{}.{}",
        path.file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "snippets.json".to_string()),
        std::process::id(),
        seq
    ));
    {
        let mut f = std::fs::File::create(&tmp_path)?;
        f.write_all(content)?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp_path, path)?;
    Ok(())
}

pub fn upsert(snippet: Snippet) -> Result<()> {
    // 読み→書きの全体でロックを保持するため、ロックを取らない内部版を直接使う。
    let _guard = lock_store();
    let mut all = load_all_locked()?;
    if let Some(existing) = all.iter_mut().find(|s| s.id == snippet.id) {
        *existing = snippet;
    } else {
        all.push(snippet);
    }
    save_all_locked(&all)
}

pub fn delete(id: &str) -> Result<()> {
    let _guard = lock_store();
    let mut all = load_all_locked()?;
    all.retain(|s| s.id != id);
    save_all_locked(&all)
}

pub fn new_snippet_id() -> String {
    use rand::RngExt;
    const ALPHABET: &[u8] = b"abcdefghijkmnpqrstuvwxyz23456789";
    let mut rng = rand::rng();
    (0..8)
        .map(|_| ALPHABET[rng.random_range(0..ALPHABET.len())] as char)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch_dir(tag: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!(
            "noobdb_snippets_store_test_{tag}_{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    // 同一プロセス内で `write_atomic` を並行に呼んでも一時ファイル名が衝突しない
    // こと (`profiles::store` と同じ回帰テスト)。
    #[test]
    fn write_atomic_is_safe_under_same_process_concurrency() {
        let dir = scratch_dir("atomic_concurrent");
        let path = dir.join("snippets.json");
        let path = std::sync::Arc::new(path);

        let handles: Vec<_> = (0..16)
            .map(|i| {
                let path = std::sync::Arc::clone(&path);
                std::thread::spawn(move || {
                    let content = format!("payload-{i}");
                    write_atomic(&path, content.as_bytes()).unwrap();
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }

        let final_content = std::fs::read_to_string(&*path).unwrap();
        assert!(final_content.starts_with("payload-"));

        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name() != "snippets.json")
            .collect();
        assert!(
            leftovers.is_empty(),
            "temp file was left behind: {leftovers:?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    // H3: write_atomic はリネーム後に内容が読め、一時ファイルを残さないこと。
    #[test]
    fn write_atomic_leaves_only_the_final_file() {
        let dir = scratch_dir("atomic_new");
        let path = dir.join("snippets.json");
        write_atomic(&path, b"{\"snippets\":[]}").unwrap();

        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"snippets\":[]}");
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name() != "snippets.json")
            .collect();
        assert!(
            leftovers.is_empty(),
            "temp file was left behind: {leftovers:?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_atomic_overwrites_existing_file() {
        let dir = scratch_dir("atomic_overwrite");
        let path = dir.join("snippets.json");
        write_atomic(&path, b"old").unwrap();
        write_atomic(&path, b"new").unwrap();

        assert_eq!(std::fs::read_to_string(&path).unwrap(), "new");
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name() != "snippets.json")
            .collect();
        assert!(
            leftovers.is_empty(),
            "temp file was left behind: {leftovers:?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
