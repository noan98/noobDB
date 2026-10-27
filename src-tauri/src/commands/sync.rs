//! Schema synchronisation commands.
//!
//! `generate_sync_sql` is a pure render of a diff into reconciling DDL;
//! `apply_sync_sql` runs the chosen statements against a writable target
//! session inside one transaction (all-or-nothing where the driver allows it —
//! MySQL implicitly commits DDL, so there it is best-effort sequential).

use tauri::State;

use crate::db::data_diff::generate_data_sync_sql as generate_data;
use crate::db::data_diff::RowStatus;
use crate::db::diff::SchemaDiff;
use crate::db::sandbox::{filter_out_keys, select_rows};
use crate::db::sync::{generate_sync_sql as generate, SyncPlan};
use crate::db::types::Value;
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
/// the source's; `DELETE`s appear only when `allow_delete` is set. The diff
/// itself stays in Rust (`AppState::data_diffs`, handed out as `diff_id` by
/// `compare_table_data` / `sandbox_table_diff`) — the frontend used to round-trip
/// up to 5,000 rows back through IPC just to get them rendered (#1259). `skip_keys`
/// drops rows (by typed primary key) before rendering — the sandbox conflict
/// resolution "skip (keep the real database's value)" (formerly
/// `filter_sandbox_data_diff`). An unknown / released / evicted `diff_id` is an
/// `InvalidInput` error ("compare again").
#[tauri::command]
pub fn generate_data_sync_sql(
    diff_id: String,
    allow_delete: bool,
    skip_keys: Option<Vec<Vec<Value>>>,
    kinds: Option<Vec<RowStatus>>,
    only_keys: Option<Vec<Vec<Value>>>,
    state: State<'_, AppState>,
) -> Result<SyncPlan> {
    generate_data_sync_sql_inner(
        state.inner(),
        &diff_id,
        allow_delete,
        &DataSyncSelection {
            skip_keys: skip_keys.as_deref(),
            kinds: kinds.as_deref(),
            only_keys: only_keys.as_deref(),
        },
    )
}

/// 同期 SQL に含める行の絞り込み (#1625)。全部 `None` なら全行。
#[derive(Debug, Default, Clone, Copy)]
pub(crate) struct DataSyncSelection<'a> {
    /// 主キーで除外する行 (サンドボックスの競合解決「スキップ」)。
    pub skip_keys: Option<&'a [Vec<Value>]>,
    /// 含める行の種別 (追加 / 更新 / 削除)。
    pub kinds: Option<&'a [RowStatus]>,
    /// 含める行の主キー (行ごとの選択)。
    pub only_keys: Option<&'a [Vec<Value>]>,
}

/// Core of [`generate_data_sync_sql`] without Tauri's `State` wrapper (#881).
pub(crate) fn generate_data_sync_sql_inner(
    state: &AppState,
    diff_id: &str,
    allow_delete: bool,
    selection: &DataSyncSelection<'_>,
) -> Result<SyncPlan> {
    let stored = stored_diff(state, diff_id)?;
    let mut diff = stored.as_ref().clone();
    if selection.kinds.is_some() || selection.only_keys.is_some() {
        diff = select_rows(&diff, selection.kinds, selection.only_keys);
    }
    if let Some(keys) = selection.skip_keys.filter(|k| !k.is_empty()) {
        diff = filter_out_keys(&diff, keys);
    }
    Ok(generate_data(&diff, allow_delete))
}

/// 保持中の差分を取り出す。無ければ (解放済み / 上限で破棄 / 切断で破棄) 比較のやり直しを促す。
pub(crate) fn stored_diff(
    state: &AppState,
    diff_id: &str,
) -> Result<std::sync::Arc<crate::db::data_diff::DataDiff>> {
    state.get_data_diff(diff_id).ok_or_else(|| {
        AppError::InvalidInput(
            "the compared data is no longer available (expired or released); compare again".into(),
        )
    })
}

/// 不要になった保持差分を破棄する (比較のやり直し・画面を閉じたとき, #1259)。未知の ID は無視する。
#[tauri::command]
pub fn release_data_diffs(diff_ids: Vec<String>, state: State<'_, AppState>) {
    state.release_data_diffs(&diff_ids);
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
    apply_sync_sql_inner(state.inner(), session_id, database, statements).await
}

/// SQLite の構造エディタのテーブル再作成 (#1888) を適用する。`apply_sync_sql` と同じ経路
/// (1 トランザクション・`PRAGMA foreign_keys` の退避・コミット前の外部キー検査・read_only 拒否) に、
/// 実行した SQL をクエリ履歴へ残す処理を足したもの。`apply_sync_sql` はスキーマ同期の適用で履歴を
/// 残さないので、構造エディタ側だけ専用に履歴を持たせる。
#[tauri::command]
pub async fn apply_sqlite_table_rebuild(
    session_id: String,
    database: Option<String>,
    statements: Vec<String>,
    state: State<'_, AppState>,
) -> Result<u64> {
    apply_sqlite_table_rebuild_inner(state.inner(), session_id, database, statements).await
}

pub(crate) async fn apply_sqlite_table_rebuild_inner(
    state: &AppState,
    session_id: String,
    database: Option<String>,
    statements: Vec<String>,
) -> Result<u64> {
    let session = state
        .get(&session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;
    let sql_text = statements.join("\n");
    let started = std::time::Instant::now();
    let result = apply_sync_sql_inner(state, session_id, database.clone(), statements).await;
    // 実行に入る前に拒否されたもの (read_only・空) は書き込みではないので履歴に残さない。
    if !matches!(
        result,
        Err(AppError::ReadOnly(_)) | Err(AppError::InvalidInput(_))
    ) {
        crate::commands::query::record_write_history(
            &session,
            sql_text,
            database.as_deref(),
            result.as_ref().ok().map(|n| *n as i64),
            Some(started.elapsed().as_millis() as i64),
            result.as_ref().err().map(|e| e.to_string()),
        )
        .await;
    }
    result
}

/// Core of [`apply_sync_sql`] decoupled from Tauri's `State` wrapper so
/// integration tests can drive the exact command path (session lookup +
/// read-only guard + empty-statement guard + transactional apply) without
/// standing up a Tauri runtime. The `#[tauri::command]` wrapper above is
/// intentionally a one-liner over this.
pub(crate) async fn apply_sync_sql_inner(
    state: &AppState,
    session_id: String,
    database: Option<String>,
    statements: Vec<String>,
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

    let result = session
        .conn
        .execute_sync_transaction(&statements, database.as_deref())
        .await;
    {
        // 失敗時も invalidate する (fail-closed)。MySQL は DDL の暗黙コミットで、
        // 途中の文が失敗して ROLLBACK しても先に実行した ALTER は残るため。
        //
        // Schema Cache (#1097): このコマンドの目的自体が「対象スキーマをソースに
        // 合わせて変更する」ことなので、渡された文の内容を判定せず常に
        // invalidate する (`sql_may_change_schema` による判定は不要 — ここに来る
        // `statements` は事実上すべて DDL)。
        session.schema_cache.invalidate_all().await;
        // Query Result Cache (#1097): `apply_sync_sql` はスキーマ同期だけでなく
        // データ同期 (`generate_data_sync_sql` が生成する INSERT/UPDATE/DELETE)
        // の適用にも使われる共通の apply エンドポイントなので、こちらも常に
        // invalidate する。
        session.query_cache.invalidate_all().await;
    }
    result
}
