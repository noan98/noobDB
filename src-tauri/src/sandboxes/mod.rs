pub mod store;

use serde::{Deserialize, Serialize};

use crate::db::DriverKind;

/// Non-secret metadata for a sandbox (branch), persisted to `sandboxes.json`
/// (same JSON-file pattern as `snippets::Snippet` / `profiles::ConnectionProfile`).
/// The sandbox's actual data lives in the SQLite file at `file_path`, opened as
/// an ordinary session via `connect` — this record only carries what's needed
/// to (a) list/discard sandboxes and (b) compute the writeback diff against the
/// real database (`source_driver` drives the SQL dialect `generate_sync_sql` /
/// `generate_data_sync_sql` render into; see `commands::sandbox`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SandboxRecord {
    /// Short slug (8 chars), also the SQLite file's basename.
    pub id: String,
    pub name: String,
    /// Source profile id, when the source session was opened from a saved
    /// profile. `None` for an ad-hoc connection.
    pub source_profile_id: Option<String>,
    pub source_driver: DriverKind,
    /// Database/schema the tables were copied from (driver-dependent meaning;
    /// `None` for SQLite, whose sessions have no separate database name).
    pub source_database: Option<String>,
    /// Live table names copied into the sandbox (after FK-closure expansion,
    /// if requested). Excludes the shadow (`db::sandbox::shadow_table_name`)
    /// mirrors, which exist per table but aren't user-facing.
    pub tables: Vec<String>,
    /// Per-table row copy cap applied at creation (`db::sandbox::clamp_row_limit`).
    pub row_limit: u64,
    /// Absolute path to the sandbox's SQLite file.
    pub file_path: String,
    /// RFC3339 creation timestamp.
    pub created_at: String,
    /// Tables whose row copy hit `row_limit` — the sandbox holds a partial
    /// copy of these, surfaced as a warning in the creation/review UI.
    #[serde(default)]
    pub truncated_tables: Vec<String>,
}
