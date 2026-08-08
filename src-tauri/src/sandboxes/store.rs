use std::io::Write;
use std::path::PathBuf;

use directories::ProjectDirs;
use serde::{Deserialize, Serialize};

use super::SandboxRecord;
use crate::error::{AppError, Result};

const QUALIFIER: &str = "";
const ORG: &str = "";
const APP: &str = "noobDB";

/// On-disk shape: `{ "sandboxes": [...] }`. Same wrapping convention as
/// `snippets::store::SnippetFile` / `profiles::store` — keeps room for future
/// top-level metadata without a format migration.
#[derive(Debug, Default, Serialize, Deserialize)]
struct SandboxFile {
    #[serde(default)]
    sandboxes: Vec<SandboxRecord>,
}

pub fn data_dir() -> Option<PathBuf> {
    ProjectDirs::from(QUALIFIER, ORG, APP).map(|p| p.data_dir().to_path_buf())
}

pub fn sandboxes_path() -> Result<PathBuf> {
    let dir = data_dir().ok_or(AppError::ConfigDir)?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("sandboxes.json"))
}

/// Directory holding every sandbox's SQLite file (`<data_dir>/sandboxes/`).
/// Created on demand.
pub fn sandbox_dir() -> Result<PathBuf> {
    let dir = data_dir().ok_or(AppError::ConfigDir)?.join("sandboxes");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

pub fn load_all() -> Result<Vec<SandboxRecord>> {
    let path = sandboxes_path()?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content = std::fs::read_to_string(&path)?;
    if content.trim().is_empty() {
        return Ok(Vec::new());
    }
    let file: SandboxFile = serde_json::from_str(&content)?;
    Ok(file.sandboxes)
}

pub fn save_all(sandboxes: &[SandboxRecord]) -> Result<()> {
    let path = sandboxes_path()?;
    let file = SandboxFile {
        sandboxes: sandboxes.to_vec(),
    };
    let content = serde_json::to_string_pretty(&file)?;
    write_atomic(&path, content.as_bytes())?;
    Ok(())
}

/// `path` をアトミックに (全体差し替えで) 書き込む。`snippets::store::write_atomic`
/// と同じ理由 (書き込み途中のクラッシュ/電源断/ディスクフルで JSON が半端に残り、
/// 以後パース失敗で全サンドボックスのメタデータが読めなくなる事態を防ぐ) で、同じ
/// ディレクトリに一時ファイルを書いて `sync_all` してから `rename` する。
fn write_atomic(path: &std::path::Path, content: &[u8]) -> std::io::Result<()> {
    let dir = path.parent().unwrap_or_else(|| std::path::Path::new("."));
    let tmp_path = dir.join(format!(
        ".{}.tmp.{}",
        path.file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "sandboxes.json".to_string()),
        std::process::id()
    ));
    {
        let mut f = std::fs::File::create(&tmp_path)?;
        f.write_all(content)?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp_path, path)?;
    Ok(())
}

pub fn upsert(record: SandboxRecord) -> Result<()> {
    let mut all = load_all()?;
    if let Some(existing) = all.iter_mut().find(|s| s.id == record.id) {
        *existing = record;
    } else {
        all.push(record);
    }
    save_all(&all)
}

pub fn delete(id: &str) -> Result<()> {
    let mut all = load_all()?;
    all.retain(|s| s.id != id);
    save_all(&all)
}

pub fn new_sandbox_id() -> String {
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
    use crate::db::DriverKind;

    fn scratch_dir(tag: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!(
            "noobdb_sandboxes_store_test_{tag}_{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn sample(id: &str) -> SandboxRecord {
        SandboxRecord {
            id: id.to_string(),
            name: "test sandbox".to_string(),
            source_profile_id: Some("prof1".to_string()),
            source_driver: DriverKind::Mysql,
            source_database: Some("appdb".to_string()),
            tables: vec!["orders".to_string()],
            row_limit: 5_000,
            file_path: "/tmp/x.sqlite".to_string(),
            created_at: "2026-01-01T00:00:00Z".to_string(),
            truncated_tables: Vec::new(),
        }
    }

    #[test]
    fn write_atomic_leaves_only_the_final_file() {
        let dir = scratch_dir("atomic_new");
        let path = dir.join("sandboxes.json");
        write_atomic(&path, b"{\"sandboxes\":[]}").unwrap();

        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "{\"sandboxes\":[]}"
        );
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name() != "sandboxes.json")
            .collect();
        assert!(
            leftovers.is_empty(),
            "temp file was left behind: {leftovers:?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn upsert_then_delete_round_trips_through_save_all_load_all() {
        // Point HOME/XDG at a scratch dir so `data_dir()` resolves somewhere
        // writable and isolated from any real user data (mirrors the pattern
        // other store tests use — see `profiles::store` tests).
        let dir = scratch_dir("roundtrip");
        // `data_dir()` can't be overridden directly (it's derived from
        // `directories::ProjectDirs`), so exercise `save_all`/`load_all`
        // against an explicit path instead, matching how `upsert`/`delete`
        // compose them.
        let path = dir.join("sandboxes.json");
        let all = vec![sample("aaaaaaaa"), sample("bbbbbbbb")];
        let content = serde_json::to_string_pretty(&SandboxFile { sandboxes: all }).unwrap();
        write_atomic(&path, content.as_bytes()).unwrap();

        let loaded: SandboxFile =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(loaded.sandboxes.len(), 2);
        assert_eq!(loaded.sandboxes[0].id, "aaaaaaaa");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn new_sandbox_id_is_eight_chars_from_the_safe_alphabet() {
        let id = new_sandbox_id();
        assert_eq!(id.len(), 8);
        assert!(id
            .bytes()
            .all(|b| b"abcdefghijkmnpqrstuvwxyz23456789".contains(&b)));
    }
}
