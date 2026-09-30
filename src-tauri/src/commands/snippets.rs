use serde::Deserialize;

use crate::error::Result;
use crate::snippets::store::{self, new_snippet_id};
use crate::snippets::{Snippet, SnippetScope};

#[derive(Debug, Deserialize)]
pub struct SaveSnippetRequest {
    /// If empty/None a new id is generated.
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub folder: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    pub sql: String,
    #[serde(default)]
    pub driver: Option<String>,
    #[serde(default)]
    pub scope: SnippetScope,
}

#[tauri::command]
pub async fn list_snippets() -> Result<Vec<Snippet>> {
    store::load_all()
}

#[tauri::command]
pub async fn save_snippet(req: SaveSnippetRequest) -> Result<Snippet> {
    let id = req
        .id
        .filter(|s| !s.is_empty())
        .unwrap_or_else(new_snippet_id);
    let tags = req
        .tags
        .into_iter()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .collect();
    let snippet = Snippet {
        id,
        name: req.name,
        folder: req.folder.filter(|s| !s.trim().is_empty()),
        tags,
        sql: req.sql,
        driver: req.driver.filter(|s| !s.is_empty()),
        scope: req.scope,
    };
    store::upsert(snippet.clone())?;
    Ok(snippet)
}

#[tauri::command]
pub async fn delete_snippet(id: String) -> Result<()> {
    store::delete(&id)?;
    // 実行計画ウォッチ (#743 / #1260): 削除したスニペットのウォッチと世代を全
    // プロファイルのストアから取り除く (孤立データを残さない)。スニペット自体は
    // 既に削除済みなので、ウォッチ側の掃除に失敗しても削除は成功として扱う。
    if let Err(e) = crate::plan_watch::store::delete_snippet(&id).await {
        tracing::warn!(snippet_id = %id, error = %e, "failed to drop plan watch data of a deleted snippet");
    }
    Ok(())
}
