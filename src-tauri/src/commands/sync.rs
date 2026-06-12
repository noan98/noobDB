//! Schema synchronisation commands.
//!
//! `generate_sync_sql` is a pure render of a diff into reconciling DDL;
//! `apply_sync_sql` runs the chosen statements against a writable target
//! session inside one transaction (all-or-nothing where the driver allows it —
//! MySQL implicitly commits DDL, so there it is best-effort sequential).

use tauri::State;

use crate::db::data_diff::{generate_data_sync_sql as generate_data, DataDiff};
use crate::db::diff::SchemaDiff;
use crate::db::sync::{generate_sync_sql as generate, SyncPlan};
use crate::error::{AppError, Result};
use crate::state::AppState;

/// Renders the DDL that would make the target schema match the source. Pure —
/// the frontend passes the (possibly user-filtered) diff it already holds, so
/// no database round trip is needed. Destructive `DROP`s appear only when
/// `allow_destructive` is set.
#[tauri::command]
pub fn generate_sync_sql(diff: SchemaDiff, allow_destructive: bool) -> SyncPlan {
    generate(&diff, allow_destructive)
}

/// Renders the INSERT / UPDATE / DELETE that make the target table's rows match
/// the source's. Pure; `DELETE`s appear only when `allow_delete` is set.
#[tauri::command]
pub fn generate_data_sync_sql(diff: DataDiff, allow_delete: bool) -> SyncPlan {
    generate_data(&diff, allow_delete)
}

/// Applies `statements` to `database` on the target session in one transaction
/// and returns the total rows affected. Rejects read-only sessions outright
/// (a read-only target must never be written), so the caller is expected to
/// open a writable session for the target whose profile permits writes.
#[tauri::command]
pub async fn apply_sync_sql(
    session_id: String,
    database: Option<String>,
    statements: Vec<String>,
    state: State<'_, AppState>,
) -> Result<u64> {
    let session = state
        .get(&session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;

    if session.read_only {
        return Err(AppError::ReadOnly(
            "read-only session: schema sync cannot be applied to a read-only target".into(),
        ));
    }
    if statements.is_empty() {
        return Err(AppError::InvalidInput(
            "no statements selected to apply".into(),
        ));
    }

    session
        .conn
        .execute_transaction(&statements, database.as_deref())
        .await
}
