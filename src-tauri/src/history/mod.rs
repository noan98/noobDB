pub mod store;

use serde::{Deserialize, Serialize};

/// A persisted record of one executed statement. Mirrors the
/// `query_history` table; `id`/`executed_at` are filled in by the store.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryEntry {
    pub id: i64,
    /// Profile the session was opened from, or `None` for an ad-hoc connection.
    pub profile_id: Option<String>,
    pub driver: String,
    pub database: Option<String>,
    pub sql: String,
    /// Number of rows returned (SELECT-shaped statements). `None` for writes.
    pub rows: Option<i64>,
    /// Number of rows affected (write statements). `None` for SELECTs.
    pub rows_affected: Option<i64>,
    pub elapsed_ms: Option<i64>,
    /// `"ok"` or `"error"`.
    pub status: String,
    pub error: Option<String>,
    /// ISO8601 (RFC3339, UTC) timestamp.
    pub executed_at: String,
}

/// Insert payload — everything except the auto-assigned `id`.
#[derive(Debug, Clone)]
pub struct NewHistoryEntry {
    pub profile_id: Option<String>,
    pub driver: String,
    pub database: Option<String>,
    pub sql: String,
    pub rows: Option<i64>,
    pub rows_affected: Option<i64>,
    pub elapsed_ms: Option<i64>,
    pub status: String,
    pub error: Option<String>,
    pub executed_at: String,
}
