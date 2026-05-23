use std::path::PathBuf;

use directories::ProjectDirs;
use serde::{Deserialize, Serialize};

use super::Snippet;
use crate::error::{AppError, Result};

const QUALIFIER: &str = "";
const ORG: &str = "";
const APP: &str = "tableX";

/// On-disk shape: `{ "snippets": [...] }`. Wrapping the array keeps room for
/// future top-level metadata without a format migration.
#[derive(Debug, Default, Serialize, Deserialize)]
struct SnippetFile {
    #[serde(default)]
    snippets: Vec<Snippet>,
}

pub fn data_dir() -> Option<PathBuf> {
    ProjectDirs::from(QUALIFIER, ORG, APP).map(|p| p.data_dir().to_path_buf())
}

pub fn snippets_path() -> Result<PathBuf> {
    let dir = data_dir().ok_or(AppError::ConfigDir)?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("snippets.json"))
}

pub fn load_all() -> Result<Vec<Snippet>> {
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

pub fn save_all(snippets: &[Snippet]) -> Result<()> {
    let path = snippets_path()?;
    let file = SnippetFile {
        snippets: snippets.to_vec(),
    };
    let content = serde_json::to_string_pretty(&file)?;
    std::fs::write(&path, content)?;
    Ok(())
}

pub fn upsert(snippet: Snippet) -> Result<()> {
    let mut all = load_all()?;
    if let Some(existing) = all.iter_mut().find(|s| s.id == snippet.id) {
        *existing = snippet;
    } else {
        all.push(snippet);
    }
    save_all(&all)
}

pub fn delete(id: &str) -> Result<()> {
    let mut all = load_all()?;
    all.retain(|s| s.id != id);
    save_all(&all)
}

pub fn new_snippet_id() -> String {
    use rand::RngExt;
    const ALPHABET: &[u8] = b"abcdefghijkmnpqrstuvwxyz23456789";
    let mut rng = rand::rng();
    (0..8)
        .map(|_| ALPHABET[rng.random_range(0..ALPHABET.len())] as char)
        .collect()
}
