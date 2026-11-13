//! 変更履歴 (監査) テーブルとトリガーの生成 (#2305)。DDL の組み立ては純層 `db::audit_trigger` が持ち、
//! ここは表の列を読んで渡すだけの読み取り専用 introspection。実行は通常の DDL 経路
//! (`run_query_transaction`) で行うので、`read_only` の拒否はそちらのバックエンドが担う。

use tauri::State;

use crate::db::audit_trigger::{
    audit_status, build_audit_ddl, AuditColumn, AuditDdl, AuditOptions, AuditStatus,
};
use crate::db::Connection;
use crate::error::{AppError, Result};
use crate::state::AppState;

async fn load_columns(conn: &Connection, database: &str, table: &str) -> Result<Vec<AuditColumn>> {
    let cols = conn.columns(database, table).await?;
    if cols.is_empty() {
        return Err(AppError::InvalidInput(format!(
            "表 {table} の列を取得できません"
        )));
    }
    Ok(cols
        .into_iter()
        .map(|c| AuditColumn {
            primary_key: c.key == "PRI",
            name: c.name,
            data_type: c.data_type,
        })
        .collect())
}

/// 監査の DDL を生成する (書き込みはしない)。MySQL は事前警告 (権限・バイナリログ) も付ける。
pub async fn generate_audit_ddl_core(
    conn: &Connection,
    database: &str,
    table: &str,
    options: &AuditOptions,
    regenerate: bool,
) -> Result<AuditDdl> {
    let columns = load_columns(conn, database, table).await?;
    let mut ddl = build_audit_ddl(
        conn.driver_kind(),
        database,
        table,
        &columns,
        options,
        regenerate,
    )?;
    // 警告は補助情報。権限の読み取りに失敗しても生成自体は返す。
    if let Ok(w) = conn.audit_trigger_preflight().await {
        ddl.warnings.extend(w);
    }
    Ok(ddl)
}

/// 表の監査トリガーの有無と、記録中の列と現在の列の差を返す。
pub async fn get_audit_status_core(
    conn: &Connection,
    database: &str,
    table: &str,
) -> Result<AuditStatus> {
    let triggers = conn.list_table_triggers(database, table).await?;
    let current: Vec<String> = conn
        .columns(database, table)
        .await?
        .into_iter()
        .map(|c| c.name)
        .collect();
    Ok(audit_status(conn.driver_kind(), table, &triggers, &current))
}

/// 変更履歴 (監査) の DDL を生成する (#2305)。読み取り専用なので read_only セッションでも許可する。
#[tauri::command]
pub async fn generate_audit_ddl(
    session_id: String,
    database: String,
    table: String,
    options: AuditOptions,
    regenerate: bool,
    state: State<'_, AppState>,
) -> Result<AuditDdl> {
    let session = state
        .get(&session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;
    generate_audit_ddl_core(&session.conn, &database, &table, &options, regenerate).await
}

/// 表の監査状態 (再生成が必要か) を返す (#2305)。読み取り専用。
#[tauri::command]
pub async fn get_audit_status(
    session_id: String,
    database: String,
    table: String,
    state: State<'_, AppState>,
) -> Result<AuditStatus> {
    let session = state
        .get(&session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;
    get_audit_status_core(&session.conn, &database, &table).await
}
