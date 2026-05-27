//! Schema comparison commands (Issue #245, phase 1).

use tauri::State;

use crate::db::diff::{compute_schema_diff, SchemaDiff, TableColumns};
use crate::db::Connection;
use crate::error::{AppError, Result};
use crate::state::AppState;

/// Fetches every table in `db` paired with its full column metadata. This is
/// N+1 by design (one `columns` round trip per table); acceptable for an
/// explicit, user-triggered comparison rather than a hot path.
pub(crate) async fn collect_table_columns(
    conn: &Connection,
    db: &str,
) -> Result<Vec<TableColumns>> {
    let tables = conn.tables(db).await?;
    let mut out = Vec::with_capacity(tables.len());
    for table in tables {
        let columns = conn.columns(db, &table).await?;
        out.push(TableColumns {
            name: table,
            columns,
        });
    }
    Ok(out)
}

/// Compares the schema of `source_database` (on the source session) against
/// `target_database` (on the target session) and returns a per-table /
/// per-column diff. The two sessions may be the same — comparing two schemas on
/// one server is a valid use — but must use the same driver: cross-driver type
/// reconciliation is out of scope for phase 1.
#[tauri::command]
pub async fn compare_schema(
    source_session_id: String,
    source_database: String,
    target_session_id: String,
    target_database: String,
    state: State<'_, AppState>,
) -> Result<SchemaDiff> {
    let source = state
        .get(&source_session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(source_session_id.clone()))?;
    let target = state
        .get(&target_session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(target_session_id.clone()))?;

    let source_driver = source.conn.driver_kind();
    let target_driver = target.conn.driver_kind();
    if source_driver != target_driver {
        return Err(AppError::InvalidInput(
            "schema comparison requires both connections to use the same driver".into(),
        ));
    }

    let source_tables = collect_table_columns(&source.conn, &source_database).await?;
    let target_tables = collect_table_columns(&target.conn, &target_database).await?;

    Ok(compute_schema_diff(
        source_driver,
        target_driver,
        &source_tables,
        &target_tables,
    ))
}
