pub mod store;

use serde::{Deserialize, Serialize};

/// Where a snippet is offered. `Any` shows everywhere; `Profile` only when
/// connected to that exact profile; `Group` for any profile in that group.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SnippetScope {
    #[default]
    Any,
    Profile {
        profile_id: String,
    },
    Group {
        group: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Snippet {
    /// Short slug (8 chars). Stable across renames.
    pub id: String,
    /// Human-readable name shown in the sidebar.
    pub name: String,
    /// Optional folder used to group snippets in the sidebar.
    #[serde(default)]
    pub folder: Option<String>,
    /// Free-form tags used for search/filtering.
    #[serde(default)]
    pub tags: Vec<String>,
    /// The SQL body inserted into the editor.
    pub sql: String,
    /// Driver this snippet targets (`mysql` / `postgres` / `sqlite`). `None`
    /// means driver-agnostic.
    #[serde(default)]
    pub driver: Option<String>,
    /// Visibility scope. Defaults to `any`.
    #[serde(default)]
    pub scope: SnippetScope,
}
