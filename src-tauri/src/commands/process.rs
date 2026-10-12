use std::collections::{HashMap, HashSet};

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
    let rows = session.conn.list_processes_without_locks().await?;
    Ok(rows
        .into_iter()
        .find(|p| p.id == process_id)
        .and_then(|p| p.query))
}

/// 複数プロセスの SQL 全文を 1 回の一覧取得でまとめて返す。AI ロック診断は最大 12 件の
/// 全文を引くので、`get_process_query` を件数分呼ぶと混んだサーバに同じ一覧クエリが
/// 件数分同時に走る。ここでは一覧を 1 回だけ取り、指定 id のうちクエリ本文があるものだけを
/// `id -> 全文` で返す (消えたプロセス・本文なしは含めない)。読み取りのみ。
#[tauri::command]
pub async fn get_process_queries(
    session_id: String,
    process_ids: Vec<i64>,
    state: State<'_, AppState>,
) -> Result<HashMap<i64, String>> {
    get_process_queries_inner(state.inner(), &session_id, &process_ids).await
}

/// Core of [`get_process_queries`]. See [`list_processes_inner`] (#881).
pub async fn get_process_queries_inner(
    state: &AppState,
    session_id: &str,
    process_ids: &[i64],
) -> Result<HashMap<i64, String>> {
    let session = state
        .get(session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.to_string()))?;
    if process_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let wanted: HashSet<i64> = process_ids.iter().copied().collect();
    let rows = session.conn.list_processes_without_locks().await?;
    Ok(select_process_queries(rows, &wanted))
}

/// 一覧から `wanted` の id だけを選び、クエリ本文があるものを `id -> 全文` にする純関数。
fn select_process_queries(
    rows: Vec<crate::db::types::ProcessInfo>,
    wanted: &HashSet<i64>,
) -> HashMap<i64, String> {
    rows.into_iter()
        .filter(|p| wanted.contains(&p.id))
        .filter_map(|p| p.query.map(|q| (p.id, q)))
        .collect()
}

/// `list_processes` が返した id のプロセス/接続をまとめて強制終了する (#1259)。
/// read_only ガードは 1 回だけ。PostgreSQL は `unnest` で 1 文、MySQL は 1 接続上で
/// 順に `KILL` する。`statement_only` なら接続は残して実行中の文だけを止める
/// (MySQL `KILL QUERY` / PostgreSQL `pg_cancel_backend`)。失敗があっても残りは続行し、成功件数・失敗件数・最初のエラーを返す。
#[tauri::command]
pub async fn kill_processes(
    session_id: String,
    process_ids: Vec<i64>,
    statement_only: Option<bool>,
    state: State<'_, AppState>,
) -> Result<KillProcessesResult> {
    kill_processes_inner(
        state.inner(),
        &session_id,
        &process_ids,
        statement_only.unwrap_or(false),
    )
    .await
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
    statement_only: bool,
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
    tracing::info!(session_id = %session.id, count = process_ids.len(), statement_only, "killing server processes");
    session
        .conn
        .kill_processes(process_ids, statement_only)
        .await
}

#[cfg(test)]
mod tests {
    use super::select_process_queries;
    use crate::db::types::ProcessInfo;
    use std::collections::HashSet;

    fn proc(id: i64, query: Option<&str>) -> ProcessInfo {
        ProcessInfo {
            id,
            user: None,
            host: None,
            database: None,
            command: None,
            state: None,
            time_secs: None,
            query: query.map(str::to_string),
            is_self: false,
            blocked_by: vec![],
        }
    }

    #[test]
    fn select_process_queries_keeps_only_wanted_ids_with_a_query() {
        let rows = vec![
            proc(1, Some("SELECT 1")),
            proc(2, Some("SELECT 2")),
            proc(3, None),
            proc(4, Some("SELECT 4")),
        ];
        let wanted: HashSet<i64> = [1, 3, 9].into_iter().collect();
        let got = select_process_queries(rows, &wanted);
        assert_eq!(got.len(), 1);
        assert_eq!(got.get(&1).map(String::as_str), Some("SELECT 1"));
    }

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
