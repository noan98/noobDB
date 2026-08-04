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
use crate::db::{DriverKind, WriteCapture, WriteKind};

/// Default retention window (days) for captures, used whenever a caller
/// doesn't specify one explicitly. Mirrors the frontend setting's own
/// default (`DEFAULT_FLIGHT_RECORDER_RETENTION_DAYS` in `settings.ts`) — kept
/// as a single source here so the two capture entry points
/// (`commands::query::spawn_captured_write` and
/// `commands::flight_recorder::run_captured_write_inner`) can't drift apart.
pub const DEFAULT_RETENTION_DAYS: i64 = 30;

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

/// Persists a capturable write to the local store, honoring `skip_history`
/// (same policy as query history — a session flagged `skip_history` records
/// nothing) and defaulting the retention window via [`DEFAULT_RETENTION_DAYS`]
/// when the caller doesn't specify one. Best-effort: a store failure is
/// logged and returns `None`, never propagated — the write itself already
/// happened by the time this runs, so there is nothing to roll back.
///
/// Shared by the two capture entry points
/// (`commands::query::spawn_captured_write`, used by the editor's single-
/// statement run, and `commands::flight_recorder::run_captured_write_inner`,
/// the dedicated IPC command) so the persistence policy — and its defaults —
/// live in exactly one place instead of two copies drifting apart.
#[allow(clippy::too_many_arguments)]
pub async fn persist_capture(
    skip_history: bool,
    profile_id: Option<String>,
    driver: DriverKind,
    database: Option<String>,
    sql: String,
    capture: &WriteCapture,
    retention_days: Option<i64>,
) -> Option<i64> {
    if !capture.capturable || skip_history {
        return None;
    }
    let new = NewWriteCapture {
        profile_id,
        driver: driver.as_str().to_string(),
        database,
        table: capture.table.clone().unwrap_or_default(),
        kind: capture.kind,
        sql,
        primary_key: capture.primary_key.clone(),
        columns: capture.columns.clone(),
        column_types: capture.column_types.clone(),
        before_rows: capture.before_rows.clone(),
        after_rows: capture.after_rows.clone(),
        rows_affected: capture.rows_affected as i64,
        captured_at: chrono::Utc::now().to_rfc3339(),
    };
    let retention = retention_days.unwrap_or(DEFAULT_RETENTION_DAYS);
    match store::record(new, retention).await {
        Ok(id) => Some(id),
        Err(e) => {
            tracing::warn!(error = %e, "failed to persist flight recorder capture");
            None
        }
    }
}
