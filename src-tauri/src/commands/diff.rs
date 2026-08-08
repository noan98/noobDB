//! Schema & data comparison commands.

use tauri::State;

use crate::db::data_diff::{compute_data_diff, DataDiff};
use crate::db::diff::{compute_schema_diff, SchemaDiff, TableColumns};
use crate::db::sync::quote_ident;
use crate::db::{Connection, DriverKind};
use crate::error::{AppError, Result};
use crate::state::AppState;

/// Hard cap on rows read per side for a data comparison. Data sync targets
/// master / configuration tables; bulk tables are out of scope and would make
/// the diff (and the generated DML) unwieldy. `pub(crate)`: `commands::sandbox`
/// applies the same cap to its (structurally identical) desired/conflict diffs.
pub(crate) const MAX_DATA_ROWS: usize = 5000;
pub(crate) const DEFAULT_DATA_ROWS: usize = 1000;

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
/// reconciliation is out of scope.
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

/// Diffs two schema snapshots captured independently of any live session
/// (schema drift timeline, #736). A thin, session-less passthrough to
/// `compute_schema_diff`: the frontend captures `TableColumns` snapshots via
/// `list_tables` + `describe_table` (mirroring what `compare_schema` collects
/// live above) into `localStorage` on every connect, then calls this command
/// to compare any two stored generations — including the current snapshot
/// against the immediately preceding one, to detect drift right after
/// connecting. Pure and synchronous like `sync::generate_sync_sql`; no
/// `AppState` needed since both sides are supplied by the caller.
#[tauri::command]
pub fn diff_schema_snapshots(
    source_driver: DriverKind,
    target_driver: DriverKind,
    source: Vec<TableColumns>,
    target: Vec<TableColumns>,
) -> SchemaDiff {
    compute_schema_diff(source_driver, target_driver, &source, &target)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::diff::DiffStatus;
    use crate::db::types::TableColumnInfo;

    fn col(name: &str, data_type: &str) -> TableColumnInfo {
        TableColumnInfo {
            name: name.to_string(),
            data_type: data_type.to_string(),
            nullable: true,
            key: String::new(),
            default: None,
            extra: String::new(),
            referenced_table: None,
            referenced_column: None,
        }
    }

    #[test]
    fn diff_schema_snapshots_diffs_two_snapshots_without_a_session() {
        let source = vec![TableColumns {
            name: "orders".to_string(),
            columns: vec![col("id", "int")],
        }];
        let target = vec![TableColumns {
            name: "orders".to_string(),
            columns: vec![col("id", "int"), col("total", "numeric(10,2)")],
        }];
        let diff = diff_schema_snapshots(DriverKind::Mysql, DriverKind::Mysql, source, target);
        assert_eq!(diff.tables.len(), 1);
        assert_eq!(diff.tables[0].name, "orders");
        assert_eq!(diff.tables[0].status, DiffStatus::Different);
        assert_eq!(diff.tables[0].columns.len(), 1);
        assert_eq!(diff.tables[0].columns[0].name, "total");
        assert_eq!(diff.tables[0].columns[0].status, DiffStatus::TargetOnly);
    }
}

/// Builds `SELECT <cols> FROM <table> ORDER BY <pk> LIMIT <n>` with identifiers
/// quoted for `driver`. The explicit column list (taken from the source) keeps
/// both sides' rows aligned even if column order differs. `pub(crate)`: reused
/// by `commands::sandbox` for its base/live/external row reads (same shape).
pub(crate) fn select_rows_sql(
    driver: DriverKind,
    table: &str,
    columns: &[String],
    primary_key: &[String],
    limit: usize,
) -> String {
    let cols = columns
        .iter()
        .map(|c| quote_ident(driver, c))
        .collect::<Vec<_>>()
        .join(", ");
    let order = primary_key
        .iter()
        .map(|c| quote_ident(driver, c))
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "SELECT {cols} FROM {} ORDER BY {order} LIMIT {limit}",
        quote_ident(driver, table)
    )
}

/// Compares the rows of one `table` between the source and target databases,
/// pairing by primary key. Reads at most `limit` rows per side (clamped to a
/// master-data-sized cap); a table without a primary key is rejected since
/// there is nothing to pair on. Both connections must use the same driver.
#[tauri::command]
pub async fn compare_table_data(
    source_session_id: String,
    source_database: String,
    target_session_id: String,
    target_database: String,
    table: String,
    limit: Option<usize>,
    state: State<'_, AppState>,
) -> Result<DataDiff> {
    let source = state
        .get(&source_session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(source_session_id.clone()))?;
    let target = state
        .get(&target_session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(target_session_id.clone()))?;

    let driver = source.conn.driver_kind();
    if driver != target.conn.driver_kind() {
        return Err(AppError::InvalidInput(
            "data comparison requires both connections to use the same driver".into(),
        ));
    }

    let col_info = source.conn.columns(&source_database, &table).await?;
    if col_info.is_empty() {
        return Err(AppError::InvalidInput(format!(
            "table '{table}' has no columns (does it exist on the source?)"
        )));
    }
    let columns: Vec<String> = col_info.iter().map(|c| c.name.clone()).collect();
    // `columns` と同じ並びの型名。修正3: BLOB 列が IPC 往復で Value::String に
    // 化けても、この型情報から Value::Bytes へ補正できるようにする
    // (`data_diff::generate_data_sync_sql` 参照)。
    let column_types: Vec<String> = col_info.iter().map(|c| c.data_type.clone()).collect();
    let primary_key: Vec<String> = col_info
        .iter()
        .filter(|c| c.key.eq_ignore_ascii_case("PRI"))
        .map(|c| c.name.clone())
        .collect();
    if primary_key.is_empty() {
        return Err(AppError::InvalidInput(format!(
            "table '{table}' has no primary key; data sync needs one to pair rows"
        )));
    }
    let pk_idx: Vec<usize> = primary_key
        .iter()
        .filter_map(|name| columns.iter().position(|c| c == name))
        .collect();

    // Read one extra row to detect (and flag) truncation without exceeding it.
    let want = limit.unwrap_or(DEFAULT_DATA_ROWS).min(MAX_DATA_ROWS);
    let sql = select_rows_sql(driver, &table, &columns, &primary_key, want + 1);

    let source_res = source.conn.execute(&sql, Some(&source_database)).await?;
    let target_res = target.conn.execute(&sql, Some(&target_database)).await?;

    let truncated = source_res.rows.len() > want || target_res.rows.len() > want;
    let source_rows: Vec<_> = source_res.rows.into_iter().take(want).collect();
    let target_rows: Vec<_> = target_res.rows.into_iter().take(want).collect();
    let source_count = source_rows.len();
    let target_count = target_rows.len();

    let rows = compute_data_diff(&columns, &pk_idx, &source_rows, &target_rows);

    Ok(DataDiff {
        target_driver: driver,
        table,
        columns,
        column_types,
        primary_key,
        rows,
        truncated,
        source_count,
        target_count,
    })
}
