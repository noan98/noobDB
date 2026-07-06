use std::io::Write;
use std::path::PathBuf;

use directories::ProjectDirs;

use super::ConnectionProfile;
use crate::error::{AppError, Result};

const QUALIFIER: &str = "";
const ORG: &str = "";
const APP: &str = "noobDB";

pub fn data_dir() -> Option<PathBuf> {
    ProjectDirs::from(QUALIFIER, ORG, APP).map(|p| p.data_dir().to_path_buf())
}

pub fn profiles_path() -> Result<PathBuf> {
    let dir = data_dir().ok_or(AppError::ConfigDir)?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("profiles.json"))
}

pub fn load_all() -> Result<Vec<ConnectionProfile>> {
    let path = profiles_path()?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content = std::fs::read_to_string(&path).map_err(|e| {
        tracing::error!(path = %path.display(), error = %e, "profiles: failed to read profiles.json");
        e
    })?;
    if content.trim().is_empty() {
        return Ok(Vec::new());
    }
    let profiles: Vec<ConnectionProfile> = serde_json::from_str(&content).map_err(|e| {
        tracing::error!(path = %path.display(), error = %e, "profiles: failed to parse profiles.json");
        e
    })?;
    Ok(profiles)
}

pub fn save_all(profiles: &[ConnectionProfile]) -> Result<()> {
    let path = profiles_path()?;
    let content = serde_json::to_string_pretty(profiles).map_err(|e| {
        tracing::error!(error = %e, "profiles: failed to serialize profiles");
        e
    })?;
    write_atomic(&path, content.as_bytes()).map_err(|e| {
        tracing::error!(path = %path.display(), error = %e, "profiles: failed to write profiles.json");
        e
    })?;
    Ok(())
}

/// `path` をアトミックに (全体差し替えで) 書き込む。同じディレクトリに一時ファイル
/// を書いて `sync_all` してから `rename` することで、書き込み途中のクラッシュ/
/// 電源断/ディスクフルで本ファイルが半端な内容のまま残る (以後 JSON パース失敗で
/// 全プロファイルが読めなくなる) 事態を防ぐ。同一ファイルシステム内の `rename` は
/// アトミックなので、途中状態は一時ファイル側にしか現れない。
fn write_atomic(path: &std::path::Path, content: &[u8]) -> std::io::Result<()> {
    let dir = path.parent().unwrap_or_else(|| std::path::Path::new("."));
    // プロセスごとに一意な一時ファイル名にして、並行書き込み同士が互いの一時
    // ファイルを踏まないようにする。
    let tmp_path = dir.join(format!(
        ".{}.tmp.{}",
        path.file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "profiles.json".to_string()),
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

pub fn upsert(profile: ConnectionProfile) -> Result<()> {
    let mut all = load_all()?;
    if let Some(existing) = all.iter_mut().find(|p| p.id == profile.id) {
        *existing = profile;
    } else {
        all.push(profile);
    }
    save_all(&all)
}

pub fn delete(id: &str) -> Result<()> {
    let mut all = load_all()?;
    all.retain(|p| p.id != id);
    save_all(&all)
}

pub fn new_profile_id() -> String {
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
            "noobdb_profiles_store_test_{tag}_{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    // H3: write_atomic はリネーム後に内容が読め、一時ファイルを残さないこと。
    #[test]
    fn write_atomic_leaves_only_the_final_file() {
        let dir = scratch_dir("atomic_new");
        let path = dir.join("profiles.json");
        write_atomic(&path, b"{\"a\":1}").unwrap();

        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"a\":1}");
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name() != "profiles.json")
            .collect();
        assert!(
            leftovers.is_empty(),
            "temp file was left behind: {leftovers:?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    // 既存ファイルを上書きするケースでも、書き込み完了後は新しい内容だけが
    // 残ること (アトミックな置き換え)。
    #[test]
    fn write_atomic_overwrites_existing_file() {
        let dir = scratch_dir("atomic_overwrite");
        let path = dir.join("profiles.json");
        write_atomic(&path, b"old").unwrap();
        write_atomic(&path, b"new").unwrap();

        assert_eq!(std::fs::read_to_string(&path).unwrap(), "new");
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name() != "profiles.json")
            .collect();
        assert!(
            leftovers.is_empty(),
            "temp file was left behind: {leftovers:?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
