//! 実行計画のインデックス試算 (#2326) の IPC ラッパー。
//!
//! 「このインデックスが無かったら / あったら」の計画を、本番の構造を変えずに取る。方法の選択・
//! ロックを取る経路の確認・`read_only` の拒否はここ (バックエンド) で強制する。ドライバごとの
//! 安全性の根拠は `db::index_whatif` のモジュール doc。

use std::time::Instant;

use tauri::State;

use crate::db::index_whatif::{
    compute_support, explain_prefix, run_with_timeout, validate_action, validate_target_sql,
    IndexWhatIfAction, IndexWhatIfMethod, IndexWhatIfModeSupport, IndexWhatIfOutcome,
    IndexWhatIfRequest, IndexWhatIfSupport, IndexWhatIfUnavailable, WhatIfPlan,
    DEFAULT_LOCK_TIMEOUT_SECS, MAX_LOCK_TIMEOUT_SECS,
};
use crate::error::{AppError, Result};
use crate::state::AppState;

/// この接続で使える試算の一覧 (方法・ロックの有無・使えない理由)。読み取りだけなので `read_only` でも許可する。
#[tauri::command]
pub async fn get_index_whatif_support(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<IndexWhatIfSupport> {
    get_index_whatif_support_inner(state.inner(), &session_id).await
}

pub async fn get_index_whatif_support_inner(
    state: &AppState,
    session_id: &str,
) -> Result<IndexWhatIfSupport> {
    let session = state
        .get(session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.to_string()))?;
    let hypopg = session.conn.index_whatif_hypopg().await?;
    Ok(compute_support(
        session.conn.driver_kind(),
        session.read_only,
        hypopg.as_ref(),
    ))
}

/// インデックスを無効化 / 追加した場合の計画を、今の計画と一緒に返す。実 DB に変更は残らない。
/// `read_only` 接続で DDL を使う経路は拒否し、ロックを取る経路は `confirm_locking` が無ければ実行しない。
#[tauri::command]
pub async fn run_index_whatif(
    session_id: String,
    request: IndexWhatIfRequest,
    state: State<'_, AppState>,
) -> Result<IndexWhatIfOutcome> {
    run_index_whatif_inner(state.inner(), &session_id, request).await
}

pub async fn run_index_whatif_inner(
    state: &AppState,
    session_id: &str,
    request: IndexWhatIfRequest,
) -> Result<IndexWhatIfOutcome> {
    let session = state
        .get(session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.to_string()))?;
    let conn = &session.conn;
    let driver = conn.driver_kind();
    let sql = validate_target_sql(driver, &request.sql)?;
    let database = request.database.as_deref().filter(|d| !d.is_empty());
    // 未指定なら対象の名前空間と同じ (従来の動作)。
    let query_database = request
        .query_database
        .as_deref()
        .filter(|d| !d.is_empty())
        .or(database);

    let hypopg = conn.index_whatif_hypopg().await?;
    let support = compute_support(driver, session.read_only, hypopg.as_ref());
    let mode: &IndexWhatIfModeSupport = match request.action {
        IndexWhatIfAction::Disable => &support.disable,
        IndexWhatIfAction::Add => &support.add,
    };
    let Some(method) = mode.method else {
        return Err(match mode.unavailable {
            Some(IndexWhatIfUnavailable::ReadOnly) => {
                tracing::warn!(session_id = %session.id, "read-only guard rejected an index what-if");
                AppError::ReadOnly(
                    "read-only profile: this what-if needs a temporary DDL and is not allowed"
                        .into(),
                )
            }
            Some(IndexWhatIfUnavailable::NeedsHypopg) => AppError::InvalidInput(
                "what-if: adding an index needs the hypopg extension on PostgreSQL".into(),
            ),
            _ => AppError::InvalidInput("what-if: not supported for this driver".into()),
        });
    };
    // 多重の防御: DDL を使う経路は、`compute_support` の判定とは別にここでも read_only を拒否する。
    // 畳むと readOnlyGuardParity が探す `if session.read_only {` の形でなくなるため、あえて入れ子にする。
    #[allow(clippy::collapsible_if)]
    if session.read_only {
        if method == IndexWhatIfMethod::RollbackDdl {
            return Err(AppError::ReadOnly(
                "read-only profile: this what-if needs a temporary DDL and is not allowed".into(),
            ));
        }
    }
    if mode.locks_table && !request.confirm_locking {
        return Err(AppError::InvalidInput(
            "what-if: this method takes a table lock; confirmation is required".into(),
        ));
    }

    conn.reject_if_attached_sqlite(database.unwrap_or(""), "index what-if")?;
    // 既存インデックスの検証 (無効化の対象が表にあること・主キーでないこと)。
    let indexes = conn
        .list_indexes(database.unwrap_or(""), &request.table)
        .await?;
    validate_action(&request, &indexes)?;

    let lock_secs = request
        .lock_timeout_secs
        .unwrap_or(DEFAULT_LOCK_TIMEOUT_SECS)
        .clamp(1, MAX_LOCK_TIMEOUT_SECS);
    let plan = WhatIfPlan {
        database,
        query_database,
        table: &request.table,
        explain_before: format!("{}{}", explain_prefix(driver), sql),
        sql: &sql,
        action: request.action,
        index: request.index.as_deref(),
        columns: &request.columns,
        method,
        hypopg: hypopg.as_ref(),
        lock_timeout_ms: lock_secs * 1000,
    };
    let started = Instant::now();
    let raw = run_with_timeout(conn, &plan).await?;
    Ok(IndexWhatIfOutcome {
        before: raw.before,
        after: raw.after,
        method,
        statements: raw.statements,
        refs_applied: raw.refs.map(|r| r.0),
        refs_mentioned: raw.refs.map(|r| r.1),
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}
