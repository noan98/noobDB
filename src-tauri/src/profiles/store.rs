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
    std::fs::write(&path, content).map_err(|e| {
        tracing::error!(path = %path.display(), error = %e, "profiles: failed to write profiles.json");
        e
    })?;
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
