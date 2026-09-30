use tauri::State;

use crate::db::types::{KillProcessesResult, ProcessListItem};
use crate::error::{AppError, Result};
use crate::state::AppState;

/// サーバ側プロセス/接続の一覧を返す (プロセス監視パネル用)。エンジンのメモリ上の
/// 状態 (`processlist` / `pg_stat_activity`) を読むだけでテーブル I/O は発生しない
/// ため、ポーリングしても安全。読み取り操作なので read_only セッションでも許可する。
/// クエリ本文は Rust 側で 1 行要約 (`query_summary` / `query_truncated`) にして返し、
/// 全文は `get_process_query` で id 指定で取得する (#1259)。
#[tauri::command]
pub async fn list_processes(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<ProcessListItem>> {
    list_processes_inner(state.inner(), &session_id).await
}

/// Core of [`list_processes`] without Tauri's `State` wrapper, so integration
/// tests can drive the exact command path without a Tauri runtime — same
/// pattern as [`kill_process_inner`] (#881).
pub async fn list_processes_inner(
    state: &AppState,
    session_id: &str,
) -> Result<Vec<ProcessListItem>> {
    let session = state
        .get(session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.to_string()))?;
    let rows = session.conn.list_processes().await?;
    Ok(rows.into_iter().map(ProcessListItem::from).collect())
}

/// 1 プロセスの実行中 (または直近) の SQL 全文を返す (#1259)。一覧は要約しか運ばないので、
/// ツールチップ表示・コピーなど全文が要るときだけ呼ぶ。プロセスが既に消えていれば `None`。
/// 読み取りのみなので read_only セッションでも許可する。
#[tauri::command]
pub async fn get_process_query(
    session_id: String,
    process_id: i64,
    state: State<'_, AppState>,
) -> Result<Option<String>> {
    get_process_query_inner(state.inner(), &session_id, process_id).await
}

/// Core of [`get_process_query`]. See [`list_processes_inner`] (#881).
pub async fn get_process_query_inner(
    state: &AppState,
    session_id: &str,
    process_id: i64,
) -> Result<Option<String>> {
    let session = state
        .get(session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.to_string()))?;
    let rows = session.conn.list_processes().await?;
    Ok(rows
        .into_iter()
        .find(|p| p.id == process_id)
        .and_then(|p| p.query))
}

/// `list_processes` が返した id のプロセス/接続をまとめて強制終了する (#1259)。
/// read_only ガードは 1 回だけ。PostgreSQL は `unnest` で 1 文、MySQL は 1 接続上で
/// 順に `KILL` する。失敗があっても残りは続行し、成功件数・失敗件数・最初のエラーを返す。
#[tauri::command]
pub async fn kill_processes(
    session_id: String,
    process_ids: Vec<i64>,
    state: State<'_, AppState>,
) -> Result<KillProcessesResult> {
    kill_processes_inner(state.inner(), &session_id, &process_ids).await
}

/// Core of [`kill_processes`] decoupled from Tauri's `State` wrapper so
/// integration tests can drive the exact command path. KILL /
/// `pg_terminate_backend` はサーバ状態を変更する操作なので、`read_only`
/// プロファイルは **バックエンド強制** で拒否する (SQL 文として
/// `is_read_only_sql` を通らない経路のため、ここで明示的にガードする)。
pub(crate) async fn kill_processes_inner(
    state: &AppState,
    session_id: &str,
    process_ids: &[i64],
) -> Result<KillProcessesResult> {
    let session = state
        .get(session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.to_string()))?;
    if session.read_only {
        tracing::warn!(
            session_id = %session.id,
            count = process_ids.len(),
            "read-only guard rejected a kill request"
        );
        return Err(AppError::ReadOnly(
            "killing processes is not allowed on a read-only session".into(),
        ));
    }
    if process_ids.is_empty() {
        return Ok(KillProcessesResult::default());
    }
    tracing::info!(session_id = %session.id, count = process_ids.len(), "killing server processes");
    session.conn.kill_processes(process_ids).await
}

#[cfg(test)]
mod tests {
    use crate::db::types::{summarize_process_query, PROCESS_QUERY_SUMMARY_MAX};

    #[test]
    fn empty_or_whitespace_query_has_no_summary() {
        assert_eq!(summarize_process_query(None, 200), (None, false));
        assert_eq!(summarize_process_query(Some(""), 200), (None, false));
        assert_eq!(summarize_process_query(Some("   \n  "), 200), (None, false));
    }

    #[test]
    fn whitespace_is_collapsed_to_one_line() {
        assert_eq!(
            summarize_process_query(Some("SELECT *\n  FROM   users\nWHERE id = 1"), 200),
            (Some("SELECT * FROM users WHERE id = 1".to_string()), false)
        );
    }

    #[test]
    fn long_query_is_truncated_with_ellipsis_at_the_boundary() {
        let exact = "a".repeat(PROCESS_QUERY_SUMMARY_MAX);
        assert_eq!(
            summarize_process_query(Some(&exact), PROCESS_QUERY_SUMMARY_MAX),
            (Some(exact.clone()), false)
        );
        let over = "a".repeat(PROCESS_QUERY_SUMMARY_MAX + 1);
        let (summary, truncated) = summarize_process_query(Some(&over), PROCESS_QUERY_SUMMARY_MAX);
        assert!(truncated);
        let summary = summary.unwrap_or_default();
        assert_eq!(summary.chars().count(), PROCESS_QUERY_SUMMARY_MAX + 1);
        assert!(summary.ends_with('…'));
    }

    #[test]
    fn truncation_counts_characters_not_bytes() {
        let s = "あ".repeat(60);
        let (summary, truncated) = summarize_process_query(Some(&s), 50);
        assert!(truncated);
        assert_eq!(summary.unwrap_or_default(), format!("{}…", "あ".repeat(50)));
    }
}
