//! 実行計画ウォッチ (#743 / #1260) の IPC コマンド。
//!
//! EXPLAIN の実行・正規化・フィンガープリント・世代記録・前世代との比較を Rust 内で
//! 完結させ、フロントへは「何件記録され、何件が重要な変化か」だけを返す。EXPLAIN は
//! `Connection::execute` を直接呼ぶので、クエリ履歴を汚さず、クエリ結果キャッシュも
//! 経由しない (計画の変化を見るので常に最新を取る)。読み取り専用ガードは
//! `ensure_allowed_for_session` を通す (EXPLAIN は読み取り専用セッションでも許可)。
//! 設計の詳細は `crate::plan_watch` のモジュール doc。

use serde::Serialize;
use tauri::State;

use super::query::ensure_allowed_for_session;
use crate::error::{AppError, Result};
use crate::plan_watch::store::{self, WatchEntry};
use crate::plan_watch::{
    compare_plans, explain_snapshot, ops_from_payload, plan_fingerprint, DEFAULT_ROW_FACTOR,
};
use crate::snippets::store as snippet_store;
use crate::state::AppState;

/// 1 スニペットの更新失敗。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanWatchRefreshError {
    pub snippet_id: String,
    pub name: String,
    pub error: String,
}

/// `plan_watch_refresh` の結果。
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanWatchRefresh {
    /// 新しい世代が記録された件数 (同一計画は含まない)。
    pub recorded: usize,
    /// 記録された世代のうち、前世代から重要な変化があった件数 (初回取得は含まない)。
    pub changed: usize,
    pub errors: Vec<PlanWatchRefreshError>,
}

/// プロファイルのウォッチ一覧 (世代つき)。セッション不要。
#[tauri::command]
pub async fn plan_watch_list(profile_id: String) -> Result<Vec<WatchEntry>> {
    store::list(&profile_id).await
}

/// ウォッチの登録 / 解除。解除時は蓄積した世代ごと削除する。
#[tauri::command]
pub async fn plan_watch_set(profile_id: String, snippet_id: String, watched: bool) -> Result<()> {
    store::set_watched(&profile_id, &snippet_id, watched).await
}

/// ウォッチ中のスニペット (`snippet_ids` 指定時はその部分集合) の EXPLAIN をまとめて
/// 実行し、世代を記録する。個々のスニペットの失敗は `errors` に入れて続行する。
/// 削除済みスニペットのウォッチは黙ってスキップする。
#[tauri::command]
pub async fn plan_watch_refresh(
    session_id: String,
    profile_id: String,
    snippet_ids: Option<Vec<String>>,
    state: State<'_, AppState>,
) -> Result<PlanWatchRefresh> {
    let session = state
        .get(&session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;
    let driver = session.conn.driver_kind();
    let driver_name = driver.as_str();
    let targets: Vec<String> = store::watched_ids(&profile_id)
        .await?
        .into_iter()
        .filter(|id| snippet_ids.as_ref().map_or(true, |only| only.contains(id)))
        .collect();
    let mut out = PlanWatchRefresh::default();
    if targets.is_empty() {
        return Ok(out);
    }
    let snippets = snippet_store::load_all()?;
    for id in targets {
        let Some(snippet) = snippets.iter().find(|s| s.id == id) else {
            continue;
        };
        let mut fail = |error: String| {
            out.errors.push(PlanWatchRefreshError {
                snippet_id: id.clone(),
                name: snippet.name.clone(),
                error,
            });
        };
        let explain_sql = format!(
            "{}{}",
            crate::plan_watch::explain_prefix(driver),
            snippet.sql
        );
        if let Err(e) = ensure_allowed_for_session(&session, &explain_sql) {
            fail(e.to_string());
            continue;
        }
        let snapshot = match explain_snapshot(&session.conn, &snippet.sql).await {
            Ok(Some(s)) => s,
            Ok(None) => continue,
            Err(e) => {
                fail(e.to_string());
                continue;
            }
        };
        let ops = ops_from_payload(driver_name, snapshot.payload_kind, &snapshot.payload);
        let fingerprint = plan_fingerprint(&ops);
        let rec = match store::record(
            &profile_id,
            &id,
            driver_name,
            snapshot.payload_kind,
            &snapshot.payload,
            &fingerprint,
        )
        .await
        {
            Ok(r) => r,
            Err(e) => {
                fail(e.to_string());
                continue;
            }
        };
        if !rec.added {
            continue;
        }
        out.recorded += 1;
        if let Some(prev) = rec.prev {
            let prev_ops = ops_from_payload(&prev.driver, prev.payload_kind, &prev.payload);
            if !compare_plans(&prev_ops, &ops, DEFAULT_ROW_FACTOR).is_empty() {
                out.changed += 1;
            }
        }
    }
    Ok(out)
}

/// 旧 localStorage のウォッチ (世代は新しい順) をストアへ一度だけ取り込む。既に
/// ウォッチ済みのスニペットは触らない。取り込んだウォッチ数を返す。
#[tauri::command]
pub async fn plan_watch_import_legacy(
    profile_id: String,
    watches: Vec<WatchEntry>,
) -> Result<usize> {
    store::import_legacy(&profile_id, watches).await
}
