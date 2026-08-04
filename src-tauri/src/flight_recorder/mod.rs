//! DML flight recorder (#735) — best-effort before/after row capture for
//! write statements plus one-click undo.
//!
//! Mirrors `history`'s split: [`store`] owns the lazily-opened local SQLite
//! store (`flight_recorder.sqlite`, alongside `history.sqlite` /
//! `profiles.json` in the project data dir). This module holds the plain
//! data types shared between the store and the IPC command layer
//! (`commands::flight_recorder`), plus [`undo`], the pure reverse-SQL/
//! conflict-detection logic that layer drives.
//!
//! **Position in the safety-net hierarchy (see CLAUDE.md):** this is a
//! best-effort local insurance policy, not a backend-enforced guarantee.
//! Capture can silently fail to apply (unresolvable target table/primary key,
//! row count over the cap, a statement shape it doesn't recognise) and the
//! write still goes through unchanged — capturing must never block a write.
//! DDL (`DROP` / `TRUNCATE` / ...) is entirely out of scope; only
//! `INSERT` / `UPDATE` / `DELETE` are ever captured. Triggers, cascades, and
//! any other server-side secondary effect of a captured statement are not
//! recorded — only the rows the statement itself directly touched (as
//! reported by the driver) are. Undo re-runs through the same
//! `run_query_transaction` all-or-nothing path as any other write, so every
//! existing guard (read-only sessions, per-statement validation, history
//! recording) still applies to the reverse SQL.

pub mod store;
pub mod undo;

use serde::{Deserialize, Serialize};

use crate::db::types::Value;
use crate::db::WriteKind;

/// A persisted capture of one write statement's before/after image. Mirrors
/// the `write_capture` table; `id`/`captured_at` are filled in by the store.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WriteCaptureRecord {
    pub id: i64,
    /// Profile the session was opened from, or `None` for an ad-hoc connection.
    pub profile_id: Option<String>,
    /// `DriverKind::as_str()` wire name ("mysql" / "postgres" / "sqlite").
    pub driver: String,
    pub database: Option<String>,
    pub table: String,
    pub kind: WriteKind,
    pub sql: String,
    pub primary_key: Vec<String>,
    /// All captured columns, in `SELECT *` order (same order as `before_rows`
    /// / `after_rows`).
    pub columns: Vec<String>,
    /// Column type names, parallel to `columns`. Used the same way as
    /// `db::data_diff::DataDiff::column_types` — to restore `Value::Bytes`
    /// for BLOB columns after a JSON round trip re-serializes them as
    /// `Value::String`.
    pub column_types: Vec<String>,
    /// Rows removed/changed by the original write. Empty for `Insert`.
    pub before_rows: Vec<Vec<Value>>,
    /// Rows added/changed by the original write. Empty for `Delete`.
    pub after_rows: Vec<Vec<Value>>,
    pub rows_affected: i64,
    /// RFC3339 (UTC) timestamp of when the capture was recorded.
    pub captured_at: String,
    /// True once [`undo::build_undo_plan`]'s statements have been
    /// successfully applied for this record.
    pub undone: bool,
}

/// Insert payload — everything except the auto-assigned `id`.
#[derive(Debug, Clone)]
pub struct NewWriteCapture {
    pub profile_id: Option<String>,
    pub driver: String,
    pub database: Option<String>,
    pub table: String,
    pub kind: WriteKind,
    pub sql: String,
    pub primary_key: Vec<String>,
    pub columns: Vec<String>,
    pub column_types: Vec<String>,
    pub before_rows: Vec<Vec<Value>>,
    pub after_rows: Vec<Vec<Value>>,
    pub rows_affected: i64,
    pub captured_at: String,
}

/// Summary used for list views — omits the (potentially large) row payloads.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WriteCaptureSummary {
    pub id: i64,
    pub profile_id: Option<String>,
    pub driver: String,
    pub database: Option<String>,
    pub table: String,
    pub kind: WriteKind,
    pub sql: String,
    pub rows_affected: i64,
    pub captured_at: String,
    pub undone: bool,
}

impl From<&WriteCaptureRecord> for WriteCaptureSummary {
    fn from(r: &WriteCaptureRecord) -> Self {
        WriteCaptureSummary {
            id: r.id,
            profile_id: r.profile_id.clone(),
            driver: r.driver.clone(),
            database: r.database.clone(),
            table: r.table.clone(),
            kind: r.kind,
            sql: r.sql.clone(),
            rows_affected: r.rows_affected,
            captured_at: r.captured_at.clone(),
            undone: r.undone,
        }
    }
}
