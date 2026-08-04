//! Sandbox (branch) commands — issue #747.
//!
//! A sandbox is a local SQLite copy of selected tables (optionally expanded
//! along foreign keys) opened as an ordinary session, so the existing editor /
//! grid / cell-edit UI works on it completely unmodified — nothing here is a
//! parallel "sandbox mode" for the query surface. Alongside every live table a
//! frozen "base" mirror (`db::sandbox::shadow_table_name`) is copied once at
//! creation and never touched again; it is the fixed reference point for both
//! diffs this module computes:
//!
//! * **desired** — sandbox (live) vs. base: what the user changed while
//!   experimenting, to be written back to the real database.
//! * **external** — real database (current) vs. the *same* base: what changed
//!   there independently since the copy was made, used only to flag
//!   concurrent-edit conflicts (`db::sandbox::detect_conflicts`).
//!
//! Rendering either diff into SQL and applying it reuses the existing,
//! already-tested Diff/Sync commands unchanged (`generate_sync_sql` /
//! `generate_data_sync_sql` / `apply_sync_sql`, `commands::sync`) — from the
//! target database's point of view a sandbox writeback *is* an ordinary sync
//! apply. This module only produces the `SchemaDiff` / `DataDiff` inputs those
//! already accept, plus sandbox lifecycle (create / list / discard).
//!
//! Known limitation (documented in the creation dialog and help text, per
//! #747's acceptance criteria): the sandbox's local engine is always SQLite,
//! which is a *dialect approximation* of the source database — type affinity
//! and constraint support differ. It is meant for iterating on data-shaping
//! logic, not for performance or dialect-specific feature validation.
//!
//! Every command that needs `AppState` is a thin `#[tauri::command]` wrapper
//! over a `*_inner(state: &AppState, ...)` function, mirroring
//! `commands::sync::apply_sync_sql` / `commands::connection::reconnect` — so
//! `src-tauri/tests/` integration tests can drive the full path (session
//! lookup included) without a Tauri runtime, via `__test_api`.

use tauri::State;

use crate::db::data_diff::{compute_data_diff, sql_literal, DataDiff, RowStatus};
use crate::db::diff::{compute_schema_diff, SchemaDiff, TableColumns};
use crate::db::sandbox::{
    clamp_row_limit, detect_conflicts, filter_out_keys, fk_closure, is_shadow_table_name,
    row_to_cells, schema_conflict_tables, shadow_table_name, with_shadow_copies, SandboxConflict,
};
use crate::db::sync::{generate_sync_sql, quote_ident};
use crate::db::types::{TableColumnInfo, Value};
use crate::db::{Connection, DbConnectOptions, DriverKind};
use crate::error::{AppError, Result};
use crate::sandboxes::store as sandbox_store;
use crate::sandboxes::SandboxRecord;
use crate::state::{new_session_id, AppState, Session};

use super::diff::{select_rows_sql, DEFAULT_DATA_ROWS, MAX_DATA_ROWS};

/// Row batch size used when importing the copied data into the sandbox file.
const IMPORT_BATCH_SIZE: usize = 500;

fn sandbox_not_found(id: &str) -> AppError {
    AppError::InvalidInput(format!("sandbox '{id}' not found"))
}

fn find_record(id: &str) -> Result<SandboxRecord> {
    sandbox_store::load_all()?
        .into_iter()
        .find(|r| r.id == id)
        .ok_or_else(|| sandbox_not_found(id))
}

#[derive(Debug, serde::Serialize)]
pub struct SandboxCreateResponse {
    pub sandbox: SandboxRecord,
    pub session_id: String,
}

/// Copies `tables` (optionally expanded to their transitive foreign-key
/// closure) from `source_session_id`/`source_database` into a fresh local
/// SQLite file, opens it as a normal session, and returns both. Schema is
/// copied via the same `compute_schema_diff` + `generate_sync_sql` pass used
/// by the standalone Diff/Sync feature (rendered for the `sqlite` dialect);
/// data via `Connection::import_rows`. Every table is copied twice — once
/// under its real name (the live, freely-editable copy) and once under its
/// `shadow_table_name` (the frozen base, never touched again) — so later
/// diffing needs only the sandbox's own connection.
#[tauri::command]
pub async fn create_sandbox(
    source_session_id: String,
    source_database: Option<String>,
    name: String,
    tables: Vec<String>,
    include_related: bool,
    row_limit: Option<u64>,
    state: State<'_, AppState>,
) -> Result<SandboxCreateResponse> {
    create_sandbox_inner(
        state.inner(),
        source_session_id,
        source_database,
        name,
        tables,
        include_related,
        row_limit,
    )
    .await
}

/// Core of [`create_sandbox`], decoupled from Tauri's `State` wrapper so
/// integration tests can drive the exact command path without standing up a
/// Tauri runtime (exposed via `__test_api`).
pub(crate) async fn create_sandbox_inner(
    state: &AppState,
    source_session_id: String,
    source_database: Option<String>,
    name: String,
    tables: Vec<String>,
    include_related: bool,
    row_limit: Option<u64>,
) -> Result<SandboxCreateResponse> {
    if tables.is_empty() {
        return Err(AppError::InvalidInput(
            "select at least one table to copy into the sandbox".into(),
        ));
    }
    let source = state
        .get(&source_session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(source_session_id.clone()))?;
    let db = source_database.clone().unwrap_or_default();
    let source_driver = source.conn.driver_kind();

    if let Some(t) = tables.iter().find(|t| is_shadow_table_name(t)) {
        // The shadow prefix is a reserved namespace this module manages
        // internally (the frozen base mirror); a real table can't legally use
        // it as a name inside a sandbox without colliding with its own base
        // snapshot, so reject up front rather than silently corrupting the
        // diff later.
        return Err(AppError::InvalidInput(format!(
            "table '{t}' uses the reserved sandbox prefix and can't be copied into a sandbox"
        )));
    }
    let mut selected = tables;
    selected.sort();
    selected.dedup();
    let effective_tables = if include_related {
        let fks = source.conn.foreign_keys(&db).await?;
        fk_closure(&selected, &fks)
    } else {
        selected
    };

    let limit = clamp_row_limit(row_limit);

    // Collect column metadata for every table up front (needed for both the
    // CREATE TABLE DDL and the SELECT column list).
    let mut table_cols: Vec<(String, Vec<TableColumnInfo>)> =
        Vec::with_capacity(effective_tables.len());
    for t in &effective_tables {
        let cols = source.conn.columns(&db, t).await?;
        if cols.is_empty() {
            return Err(AppError::InvalidInput(format!(
                "table '{t}' has no columns (does it exist on the source?)"
            )));
        }
        table_cols.push((t.clone(), cols));
    }

    // Fetch rows (one extra per table to detect truncation without exceeding
    // the cap).
    struct FetchedTable {
        name: String,
        columns: Vec<String>,
        rows: Vec<Vec<crate::db::types::Value>>,
        truncated: bool,
    }
    let mut fetched: Vec<FetchedTable> = Vec::with_capacity(table_cols.len());
    for (t, cols) in &table_cols {
        let col_names: Vec<String> = cols.iter().map(|c| c.name.clone()).collect();
        // Order by the primary key when there is one (stable, cheap); a
        // table without one falls back to ordering by every column so
        // `select_rows_sql` never gets an empty `ORDER BY` list. Determinism
        // doesn't matter much here (rows are read once, at creation time) —
        // this is only about producing valid, reasonably efficient SQL.
        let pk_cols: Vec<String> = cols
            .iter()
            .filter(|c| c.key.eq_ignore_ascii_case("PRI"))
            .map(|c| c.name.clone())
            .collect();
        let order_cols = if pk_cols.is_empty() {
            &col_names
        } else {
            &pk_cols
        };
        let sql = select_rows_sql(source_driver, t, &col_names, order_cols, limit as usize + 1);
        let res = source.conn.execute(&sql, Some(&db)).await?;
        let truncated = res.rows.len() > limit as usize;
        let rows: Vec<_> = res.rows.into_iter().take(limit as usize).collect();
        fetched.push(FetchedTable {
            name: t.clone(),
            columns: col_names,
            rows,
            truncated,
        });
    }

    // Create the sandbox's SQLite file. `Connection::connect` opens with
    // `create_if_missing(false)`, so the (empty) file must exist first.
    let sandbox_id = sandbox_store::new_sandbox_id();
    let dir = sandbox_store::sandbox_dir()?;
    let file_path = dir.join(format!("{sandbox_id}.sqlite"));
    let file_path_str = file_path.to_string_lossy().to_string();
    std::fs::File::create(&file_path)?;

    let opts = DbConnectOptions {
        host: String::new(),
        port: 0,
        user: String::new(),
        password: String::new(),
        database: None,
        driver: DriverKind::Sqlite,
        file_path: Some(file_path_str.clone()),
        ssl_mode: None,
        ssl_root_cert: None,
        ssl_client_cert: None,
        ssl_client_key: None,
        init_sql: None,
    };
    let conn = match Connection::connect(&opts).await {
        Ok(c) => c,
        Err(e) => {
            let _ = std::fs::remove_file(&file_path);
            return Err(e);
        }
    };

    // Cleans up the sqlite file (and its -wal/-shm siblings, best-effort) and
    // closes the connection on any failure below, so a partially-created
    // sandbox never lingers on disk or in a half-registered state.
    async fn fail(conn: Connection, file_path: &std::path::Path, e: AppError) -> AppError {
        conn.close().await;
        remove_sandbox_files(file_path);
        e
    }

    // Schema: live + shadow copies of every table, in one CREATE TABLE batch
    // rendered for SQLite (`target_driver = Sqlite`).
    let combined: Vec<TableColumns> = with_shadow_copies(&table_cols);
    let schema_diff = compute_schema_diff(source_driver, DriverKind::Sqlite, &combined, &[]);
    let plan = generate_sync_sql(&schema_diff, false);
    let ddl: Vec<String> = plan.statements.into_iter().map(|s| s.sql).collect();
    if let Err(e) = conn.execute_transaction(&ddl, None).await {
        return Err(fail(conn, &file_path, e).await);
    }

    // Data: import into both the live and shadow tables.
    let mut truncated_tables = Vec::new();
    for t in &fetched {
        if t.truncated {
            truncated_tables.push(t.name.clone());
        }
        let cells: Vec<Vec<Option<String>>> = t.rows.iter().map(|r| row_to_cells(r)).collect();
        if let Err(e) = conn
            .import_rows(None, &t.name, &t.columns, &cells, IMPORT_BATCH_SIZE, |_| {
                Ok(())
            })
            .await
        {
            return Err(fail(conn, &file_path, e).await);
        }
        let shadow = shadow_table_name(&t.name);
        if let Err(e) = conn
            .import_rows(None, &shadow, &t.columns, &cells, IMPORT_BATCH_SIZE, |_| {
                Ok(())
            })
            .await
        {
            return Err(fail(conn, &file_path, e).await);
        }
    }

    let record = SandboxRecord {
        id: sandbox_id,
        name,
        source_profile_id: source.profile_id.clone(),
        source_driver,
        source_database,
        tables: fetched.iter().map(|t| t.name.clone()).collect(),
        row_limit: limit,
        file_path: file_path_str,
        created_at: chrono::Utc::now().to_rfc3339(),
        truncated_tables,
    };
    if let Err(e) = sandbox_store::upsert(record.clone()) {
        return Err(fail(conn, &file_path, e).await);
    }

    let session = Session {
        id: new_session_id(),
        profile_id: None,
        conn,
        read_only: false,
        emergency_write: std::sync::atomic::AtomicBool::new(false),
        skip_history: true,
        connect_options: opts,
        reconnect_ssh: None,
        // サンドボックスの裏ファイルは `SandboxRecord`/`sandboxes::store` が
        // ライフサイクルを管理する永続ファイルで、#740 のローカル横断クエリの
        // 揮発性一時ファイルとは異なり切断時に自動削除してはいけない。
        local_temp_file: None,
        _tunnel: None,
    };
    let session_id = state.insert(session).await;
    tracing::info!(
        sandbox_id = %record.id,
        session_id = %session_id,
        tables = record.tables.len(),
        "sandbox created"
    );

    Ok(SandboxCreateResponse {
        sandbox: record,
        session_id,
    })
}

/// Best-effort removal of a sandbox's SQLite file and its `-wal`/`-shm`
/// journal siblings (present only if WAL mode was ever used). Errors are
/// swallowed: a leftover file is a harmless disk-space nit, never a reason to
/// fail an otherwise-successful discard or a cleanup-after-failure path.
fn remove_sandbox_files(file_path: &std::path::Path) {
    let _ = std::fs::remove_file(file_path);
    let _ = std::fs::remove_file(file_path.with_extension("sqlite-wal"));
    let _ = std::fs::remove_file(file_path.with_extension("sqlite-shm"));
}

/// Lists every sandbox's non-secret metadata (name, source, tables, row
/// limit, file path, creation time). Doesn't require any session — this is
/// the same on-disk listing snippets/profiles use.
#[tauri::command]
pub fn list_sandboxes() -> Result<Vec<SandboxRecord>> {
    sandbox_store::load_all()
}

/// Discards a sandbox: closes its session (if still open), deletes its SQLite
/// file, and removes its metadata record. The metadata is always removed even
/// if closing the session or deleting the file fails (e.g. the file was
/// already gone) — a stale record pointing nowhere is worse than a leftover
/// file, and this is the only "did the user's data get deleted" signal the UI
/// has, so it always reflects the final state honestly.
#[tauri::command]
pub async fn discard_sandbox(
    sandbox_id: String,
    session_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<()> {
    discard_sandbox_inner(state.inner(), sandbox_id, session_id).await
}

/// Core of [`discard_sandbox`] (see [`create_sandbox_inner`] doc).
pub(crate) async fn discard_sandbox_inner(
    state: &AppState,
    sandbox_id: String,
    session_id: Option<String>,
) -> Result<()> {
    if let Some(sid) = &session_id {
        if let Some(sess) = state.remove(sid).await {
            sess.conn.close().await;
        }
    }
    if let Ok(record) = find_record(&sandbox_id) {
        remove_sandbox_files(std::path::Path::new(&record.file_path));
    }
    sandbox_store::delete(&sandbox_id)?;
    tracing::info!(sandbox_id = %sandbox_id, "sandbox discarded");
    Ok(())
}

#[derive(Debug, serde::Serialize)]
pub struct SandboxTableDiffResult {
    /// What changed in the sandbox since the snapshot, rendered for the
    /// *source* database's dialect (`target_driver`) — pass straight to the
    /// existing `generate_data_sync_sql` command to render writeback SQL.
    pub desired: DataDiff,
    /// Rows changed both in the sandbox and on the real database since the
    /// snapshot. Empty (and meaningless to read as "no conflicts") when
    /// `source_checked` is false.
    pub conflicts: Vec<SandboxConflict>,
    /// Whether `source_session_id` was supplied and resolved to a live
    /// session, i.e. whether conflict detection actually ran.
    pub source_checked: bool,
}

/// Computes the data writeback diff for one sandbox table: the sandbox's live
/// rows vs. its frozen base (`desired`), and — when `source_session_id` names
/// a currently open session — the real database's *current* rows vs. the same
/// base, intersected with `desired` to flag concurrent-edit conflicts.
#[tauri::command]
pub async fn sandbox_table_diff(
    sandbox_id: String,
    sandbox_session_id: String,
    table: String,
    source_session_id: Option<String>,
    limit: Option<usize>,
    state: State<'_, AppState>,
) -> Result<SandboxTableDiffResult> {
    sandbox_table_diff_inner(
        state.inner(),
        sandbox_id,
        sandbox_session_id,
        table,
        source_session_id,
        limit,
    )
    .await
}

/// Core of [`sandbox_table_diff`] (see [`create_sandbox_inner`] doc).
#[allow(clippy::too_many_arguments)]
pub(crate) async fn sandbox_table_diff_inner(
    state: &AppState,
    sandbox_id: String,
    sandbox_session_id: String,
    table: String,
    source_session_id: Option<String>,
    limit: Option<usize>,
) -> Result<SandboxTableDiffResult> {
    let record = find_record(&sandbox_id)?;
    if !record.tables.iter().any(|t| t == &table) {
        return Err(AppError::InvalidInput(format!(
            "table '{table}' is not part of sandbox '{sandbox_id}'"
        )));
    }
    let sandbox = state
        .get(&sandbox_session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(sandbox_session_id.clone()))?;

    let col_info = sandbox.conn.columns("", &table).await?;
    if col_info.is_empty() {
        return Err(AppError::InvalidInput(format!(
            "table '{table}' has no columns"
        )));
    }
    let columns: Vec<String> = col_info.iter().map(|c| c.name.clone()).collect();
    let column_types: Vec<String> = col_info.iter().map(|c| c.data_type.clone()).collect();
    let primary_key: Vec<String> = col_info
        .iter()
        .filter(|c| c.key.eq_ignore_ascii_case("PRI"))
        .map(|c| c.name.clone())
        .collect();
    if primary_key.is_empty() {
        return Err(AppError::InvalidInput(format!(
            "table '{table}' has no primary key; sandbox writeback needs one to pair rows"
        )));
    }
    let pk_idx: Vec<usize> = primary_key
        .iter()
        .filter_map(|n| columns.iter().position(|c| c == n))
        .collect();

    let want = limit.unwrap_or(DEFAULT_DATA_ROWS).min(MAX_DATA_ROWS);
    let live_sql = select_rows_sql(DriverKind::Sqlite, &table, &columns, &primary_key, want + 1);
    let base_sql = select_rows_sql(
        DriverKind::Sqlite,
        &shadow_table_name(&table),
        &columns,
        &primary_key,
        want + 1,
    );
    let live_res = sandbox.conn.execute(&live_sql, None).await?;
    let base_res = sandbox.conn.execute(&base_sql, None).await?;
    let truncated = live_res.rows.len() > want || base_res.rows.len() > want;
    let live_rows: Vec<_> = live_res.rows.into_iter().take(want).collect();
    let base_rows: Vec<_> = base_res.rows.into_iter().take(want).collect();
    let live_count = live_rows.len();
    let base_count = base_rows.len();

    let desired_rows = compute_data_diff(&columns, &pk_idx, &live_rows, &base_rows);
    let desired = DataDiff {
        target_driver: record.source_driver,
        table: table.clone(),
        columns: columns.clone(),
        column_types: column_types.clone(),
        primary_key: primary_key.clone(),
        rows: desired_rows,
        truncated,
        source_count: live_count,
        target_count: base_count,
    };

    let mut conflicts = Vec::new();
    let mut source_checked = false;
    if let Some(source_session_id) = source_session_id {
        if let Some(source) = state.get(&source_session_id).await {
            let source_db = record.source_database.clone().unwrap_or_default();
            let sql = select_rows_sql(
                record.source_driver,
                &table,
                &columns,
                &primary_key,
                want + 1,
            );
            let current_res = source.conn.execute(&sql, Some(&source_db)).await?;
            let current_rows: Vec<_> = current_res.rows.into_iter().take(want).collect();
            let external_rows = compute_data_diff(&columns, &pk_idx, &current_rows, &base_rows);
            let external = DataDiff {
                target_driver: record.source_driver,
                table: table.clone(),
                columns,
                column_types,
                primary_key,
                rows: external_rows,
                truncated: false,
                source_count: current_rows.len(),
                target_count: base_count,
            };
            conflicts = detect_conflicts(&desired, &external);
            source_checked = true;
        }
    }

    Ok(SandboxTableDiffResult {
        desired,
        conflicts,
        source_checked,
    })
}

/// Drops the rows a conflict was resolved as "skip (keep the real database's
/// value, don't overwrite)" for from `diff`. Pure passthrough to
/// `db::sandbox::filter_out_keys`, in the same style as `generate_sync_sql` /
/// `generate_data_sync_sql` (`commands::sync`) — no session involved, so the
/// frontend can apply conflict resolution before handing the trimmed diff to
/// the existing `generate_data_sync_sql` command to render writeback SQL.
#[tauri::command]
pub fn filter_sandbox_data_diff(diff: DataDiff, skip_keys: Vec<Vec<Value>>) -> DataDiff {
    filter_out_keys(&diff, &skip_keys)
}

#[derive(Debug, serde::Serialize)]
pub struct SandboxSchemaDiffResult {
    /// Schema changes made in the sandbox since the snapshot, rendered for
    /// the source database's dialect — pass to `generate_sync_sql` to render
    /// writeback DDL. **Column types come from the sandbox's SQLite copy**,
    /// so any type chosen for a column added/altered there is a SQLite type
    /// name, not necessarily valid on the source driver — reviewing the
    /// generated DDL before applying is essential (see the module doc).
    pub desired: SchemaDiff,
    /// Tables whose schema changed both in the sandbox and on the real
    /// database since the snapshot — informational only, not auto-resolved.
    pub external_changed_tables: Vec<String>,
    pub source_checked: bool,
}

/// Computes the schema writeback diff for a whole sandbox: its live tables vs.
/// their frozen base, plus (when `source_session_id` is a live session) the
/// list of tables that also changed on the real database since the snapshot.
#[tauri::command]
pub async fn sandbox_schema_diff(
    sandbox_id: String,
    sandbox_session_id: String,
    source_session_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<SandboxSchemaDiffResult> {
    sandbox_schema_diff_inner(
        state.inner(),
        sandbox_id,
        sandbox_session_id,
        source_session_id,
    )
    .await
}

/// Core of [`sandbox_schema_diff`] (see [`create_sandbox_inner`] doc).
pub(crate) async fn sandbox_schema_diff_inner(
    state: &AppState,
    sandbox_id: String,
    sandbox_session_id: String,
    source_session_id: Option<String>,
) -> Result<SandboxSchemaDiffResult> {
    let record = find_record(&sandbox_id)?;
    let sandbox = state
        .get(&sandbox_session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(sandbox_session_id.clone()))?;

    let mut live_tables: Vec<TableColumns> = Vec::with_capacity(record.tables.len());
    let mut base_tables: Vec<TableColumns> = Vec::with_capacity(record.tables.len());
    for t in &record.tables {
        let cols = sandbox.conn.columns("", t).await?;
        live_tables.push(TableColumns {
            name: t.clone(),
            columns: cols,
        });
        let base_cols = sandbox.conn.columns("", &shadow_table_name(t)).await?;
        base_tables.push(TableColumns {
            name: t.clone(),
            columns: base_cols,
        });
    }
    let desired = compute_schema_diff(
        DriverKind::Sqlite,
        record.source_driver,
        &live_tables,
        &base_tables,
    );

    let mut external_changed_tables = Vec::new();
    let mut source_checked = false;
    if let Some(source_session_id) = source_session_id {
        if let Some(source) = state.get(&source_session_id).await {
            let db = record.source_database.clone().unwrap_or_default();
            let mut current_tables: Vec<TableColumns> = Vec::with_capacity(record.tables.len());
            for t in &record.tables {
                let cols = source.conn.columns(&db, t).await?;
                current_tables.push(TableColumns {
                    name: t.clone(),
                    columns: cols,
                });
            }
            let external = compute_schema_diff(
                record.source_driver,
                record.source_driver,
                &current_tables,
                &base_tables,
            );
            external_changed_tables = schema_conflict_tables(&desired, &external);
            source_checked = true;
        }
    }

    Ok(SandboxSchemaDiffResult {
        desired,
        external_changed_tables,
        source_checked,
    })
}

/// Advances a table's frozen base snapshot to match the rows that were just
/// successfully written back to the real database (`applied` — the exact
/// [`DataDiff`] the caller rendered into the SQL it applied, typically the
/// `desired` diff after [`filter_sandbox_data_diff`] dropped any
/// conflict-skipped rows). Without this, the base never moves: every
/// subsequent `sandbox_table_diff` would keep reporting the *same* rows as
/// both "changed in the sandbox" and "changed externally" (because the real
/// database now matches the sandbox, which itself still differs from the
/// original — stale — base), manufacturing phantom conflicts on rows that are
/// already fully in sync. Call this once, right after a successful
/// `apply_sync_sql` writeback for `table`.
///
/// `allow_delete` must mirror the flag passed to `generate_data_sync_sql` for
/// this same diff: a `TargetOnly` row's base entry is only removed when a
/// `DELETE` was actually part of what got applied (`generate_data_sync_sql`
/// omits `DELETE` entirely when `allow_delete` is false, or when `applied` is
/// `truncated` — mirrored here as `can_delete`). `SourceOnly` / `Different`
/// rows (`INSERT` / `UPDATE`) are never gated this way, matching
/// `generate_data_sync_sql`.
///
/// Known gap: rows `generate_data_sync_sql` itself skips as unsafe
/// (`key_unreliable` — duplicate or colliding primary keys) are still
/// advanced here, since that per-row detail isn't part of the wire `DataDiff`
/// after an IPC round trip (see `RowDiff::key_unreliable`'s doc). This is the
/// same rare edge case already flagged as a known limitation in
/// `db::data_diff`; it would make the base silently forget a real divergence
/// for that one row rather than under- or over-counting a real change.
#[tauri::command]
pub async fn sandbox_advance_base(
    sandbox_id: String,
    sandbox_session_id: String,
    table: String,
    applied: DataDiff,
    allow_delete: bool,
    state: State<'_, AppState>,
) -> Result<()> {
    sandbox_advance_base_inner(
        state.inner(),
        sandbox_id,
        sandbox_session_id,
        table,
        applied,
        allow_delete,
    )
    .await
}

/// Core of [`sandbox_advance_base`] (see [`create_sandbox_inner`] doc).
pub(crate) async fn sandbox_advance_base_inner(
    state: &AppState,
    sandbox_id: String,
    sandbox_session_id: String,
    table: String,
    applied: DataDiff,
    allow_delete: bool,
) -> Result<()> {
    let record = find_record(&sandbox_id)?;
    if !record.tables.iter().any(|t| t == &table) {
        return Err(AppError::InvalidInput(format!(
            "table '{table}' is not part of sandbox '{sandbox_id}'"
        )));
    }
    let sandbox = state
        .get(&sandbox_session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(sandbox_session_id.clone()))?;
    let shadow = shadow_table_name(&table);
    let can_delete = allow_delete && !applied.truncated;

    let mut statements: Vec<String> = Vec::new();
    for row in &applied.rows {
        match row.status {
            RowStatus::SourceOnly | RowStatus::Different => {
                if let Some(values) = &row.source {
                    statements.push(upsert_shadow_sql(&shadow, &applied.columns, values));
                }
            }
            RowStatus::TargetOnly => {
                if can_delete {
                    statements.push(delete_shadow_sql(&shadow, &applied.primary_key, &row.key));
                }
            }
        }
    }
    if statements.is_empty() {
        return Ok(());
    }
    sandbox.conn.execute_transaction(&statements, None).await?;
    Ok(())
}

/// `INSERT OR REPLACE INTO <shadow> (...) VALUES (...)` — SQLite-only (the
/// shadow table always lives in the sandbox's own SQLite file), keyed on
/// whatever `UNIQUE`/`PRIMARY KEY` the shadow table already has (it was
/// created from the same source columns as the live table, so the same
/// primary key applies) so this both inserts a new base row and overwrites an
/// existing one.
fn upsert_shadow_sql(shadow_table: &str, columns: &[String], values: &[Value]) -> String {
    let cols = columns
        .iter()
        .map(|c| quote_ident(DriverKind::Sqlite, c))
        .collect::<Vec<_>>()
        .join(", ");
    let vals = values
        .iter()
        .map(|v| sql_literal(DriverKind::Sqlite, v))
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "INSERT OR REPLACE INTO {} ({cols}) VALUES ({vals})",
        quote_ident(DriverKind::Sqlite, shadow_table)
    )
}

/// `DELETE FROM <shadow> WHERE <pk predicate>`.
fn delete_shadow_sql(shadow_table: &str, primary_key: &[String], key: &[Value]) -> String {
    let pred = primary_key
        .iter()
        .zip(key.iter())
        .map(|(name, value)| {
            let ident = quote_ident(DriverKind::Sqlite, name);
            match value {
                Value::Null => format!("{ident} IS NULL"),
                _ => format!("{ident} = {}", sql_literal(DriverKind::Sqlite, value)),
            }
        })
        .collect::<Vec<_>>()
        .join(" AND ");
    format!(
        "DELETE FROM {} WHERE {pred}",
        quote_ident(DriverKind::Sqlite, shadow_table)
    )
}
