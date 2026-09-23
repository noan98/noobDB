//! テーブル・タイムラプス (#739) の IPC コマンド。
//!
//! 取得は `commands::diff::compare_table_data` と同じ形の単一 `SELECT`
//! (`select_rows_sql`、PK 順・行数上限つき) を `Connection::execute` で直接流す
//! — クエリ履歴には記録されず (履歴記録はクエリ実行コマンド層の責務)、読み取り
//! 専用セッションでもそのまま動く。念のため `ensure_allowed_for_session` も通す。
//! 差分計算は `timelapse::diff_snapshots` (= `db::data_diff::compute_data_diff`)。
//! 設計の詳細 (保存先・容量・機微データの扱い) は `crate::timelapse` のモジュール doc。

use serde::Serialize;
use tauri::State;

use super::diff::{select_rows_sql, MAX_DATA_ROWS};
use super::query::ensure_allowed_for_session;
use crate::db::DriverKind;
use crate::error::{AppError, Result};
use crate::state::{AppState, Session};
use crate::timelapse::{
    clamp_max_generations, diff_snapshots, store, GenerationDiff, Snapshot, TableWatch,
};

/// `timelapse_watch_table` の結果。
#[derive(Debug, Serialize)]
pub struct WatchOutcome {
    /// 登録したウォッチの ID。行数上限超過で同意待ちのときは `None` (未登録)。
    pub watch_id: Option<i64>,
    /// テーブルが行数上限 (`row_limit`) を超えていたか。
    pub over_limit: bool,
    pub row_limit: usize,
    /// 初回スナップショットで世代が追加されたか。
    pub generation_added: bool,
}

/// `timelapse_capture` の 1 ウォッチ分の結果。
#[derive(Debug, Serialize)]
pub struct CaptureOutcome {
    pub watch_id: i64,
    pub database: String,
    pub table: String,
    /// 内容が直前世代と異なり、世代が追加されたか。
    pub added: bool,
    pub truncated: bool,
    /// 取得に失敗したときのメッセージ (他のウォッチの取得は続ける)。
    pub error: Option<String>,
}

async fn session_of(state: &AppState, session_id: &str) -> Result<std::sync::Arc<Session>> {
    state
        .get(session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.to_string()))
}

/// ウォッチはプロファイル単位で保存する。アドホック接続 (プロファイル無し) は
/// 次回接続時に同じ対象を特定できないため対象外。
fn profile_of(session: &Session) -> Result<String> {
    session.profile_id.clone().ok_or_else(|| {
        AppError::InvalidInput("table timelapse requires a saved connection profile".into())
    })
}

/// テーブルのスナップショットを 1 回取得する。PK が無ければ拒否 (行の同一性を
/// 追えないため。`compare_table_data` と同じ制約)。上限 + 1 行を読んで打ち切りを
/// 検出し、`truncated` を立てる。
async fn fetch_snapshot(session: &Session, database: &str, table: &str) -> Result<Snapshot> {
    let driver = session.conn.driver_kind();
    let col_info = session.conn.columns(database, table).await?;
    if col_info.is_empty() {
        return Err(AppError::InvalidInput(format!(
            "table '{table}' has no columns (does it exist?)"
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
            "table '{table}' has no primary key; table timelapse needs one to track rows"
        )));
    }
    let sql = select_rows_sql(driver, table, &columns, &primary_key, MAX_DATA_ROWS + 1);
    ensure_allowed_for_session(session, &sql)?;
    let res = session.conn.execute(&sql, Some(database)).await?;
    let truncated = res.rows.len() > MAX_DATA_ROWS;
    let rows = res.rows.into_iter().take(MAX_DATA_ROWS).collect();
    Ok(Snapshot {
        columns,
        column_types,
        primary_key,
        rows,
        truncated,
    })
}

/// テーブルをウォッチ登録し、初回スナップショットを取得する。行数上限を超える
/// テーブルは `allow_partial` が false なら登録せず `over_limit: true` を返す
/// (UI が「先頭 N 行だけを記録する」かどうかをユーザに確認して再呼び出しする)。
#[tauri::command]
pub async fn timelapse_watch_table(
    session_id: String,
    database: String,
    table: String,
    allow_partial: bool,
    max_generations: Option<u32>,
    state: State<'_, AppState>,
) -> Result<WatchOutcome> {
    let session = session_of(&state, &session_id).await?;
    let profile_id = profile_of(&session)?;
    let snapshot = fetch_snapshot(&session, &database, &table).await?;
    if snapshot.truncated && !allow_partial {
        return Ok(WatchOutcome {
            watch_id: None,
            over_limit: true,
            row_limit: MAX_DATA_ROWS,
            generation_added: false,
        });
    }
    let driver = session.conn.driver_kind();
    let watch_id = store::upsert_watch(
        &profile_id,
        driver.as_str(),
        &database,
        &table,
        snapshot.truncated,
    )
    .await?;
    let added =
        store::record_generation(watch_id, &snapshot, clamp_max_generations(max_generations))
            .await?;
    Ok(WatchOutcome {
        watch_id: Some(watch_id),
        over_limit: snapshot.truncated,
        row_limit: MAX_DATA_ROWS,
        generation_added: added,
    })
}

/// セッションのプロファイルに登録されたアクティブなウォッチを全件取得する
/// (接続時の自動取得と手動更新)。個々のテーブルの失敗は `error` に入れて続行する。
#[tauri::command]
pub async fn timelapse_capture(
    session_id: String,
    max_generations: Option<u32>,
    state: State<'_, AppState>,
) -> Result<Vec<CaptureOutcome>> {
    let session = session_of(&state, &session_id).await?;
    let Some(profile_id) = session.profile_id.clone() else {
        return Ok(Vec::new());
    };
    let max_generations = clamp_max_generations(max_generations);
    let mut out = Vec::new();
    for target in store::active_watches(&profile_id).await? {
        let outcome = match fetch_snapshot(&session, &target.database, &target.table).await {
            Ok(snapshot) => {
                match store::record_generation(target.id, &snapshot, max_generations).await {
                    Ok(added) => (added, snapshot.truncated, None),
                    Err(e) => (false, snapshot.truncated, Some(e.to_string())),
                }
            }
            Err(e) => (false, false, Some(e.to_string())),
        };
        out.push(CaptureOutcome {
            watch_id: target.id,
            database: target.database,
            table: target.table,
            added: outcome.0,
            truncated: outcome.1,
            error: outcome.2,
        });
    }
    Ok(out)
}

/// プロファイルのウォッチ一覧 (世代メタデータつき)。セッション不要。
#[tauri::command]
pub async fn timelapse_list_watches(profile_id: String) -> Result<Vec<TableWatch>> {
    store::list_watches(&profile_id).await
}

fn driver_from_wire(name: &str) -> Result<DriverKind> {
    serde_json::from_value(serde_json::Value::String(name.to_string()))
        .map_err(|_| AppError::InvalidInput(format!("unknown driver '{name}'")))
}

/// 同じウォッチの 2 世代 (`from_id` = 古い側, `to_id` = 新しい側) の行差分。
/// 呼び出し側が逆順に渡しても、取得時刻の古い方を `from` として扱う。
#[tauri::command]
pub async fn timelapse_diff_generations(from_id: i64, to_id: i64) -> Result<GenerationDiff> {
    let a = store::load_generation(from_id).await?;
    let b = store::load_generation(to_id).await?;
    if a.watch_id != b.watch_id {
        return Err(AppError::InvalidInput(
            "generations belong to different watched tables".into(),
        ));
    }
    // 世代 ID は単調増加なので、ID の小さい方が古い。
    let (older, newer) = if from_id <= to_id { (a, b) } else { (b, a) };
    let driver = driver_from_wire(&newer.driver)?;
    let (diff, columns_added, columns_removed) =
        diff_snapshots(driver, &newer.table, &older.snapshot, &newer.snapshot);
    Ok(GenerationDiff {
        partial: diff.truncated,
        diff,
        columns_added,
        columns_removed,
        from_captured_at: older.captured_at,
        to_captured_at: newer.captured_at,
    })
}

/// ウォッチを解除する。`delete_data` が true なら保存済み世代も削除する。
#[tauri::command]
pub async fn timelapse_unwatch(watch_id: i64, delete_data: bool) -> Result<()> {
    store::unwatch(watch_id, delete_data).await
}

/// 全プロファイルの全ウォッチ・全世代を削除する (設定画面の一括削除)。
#[tauri::command]
pub async fn timelapse_clear_all() -> Result<u64> {
    store::clear_all().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn driver_from_wire_round_trips_as_str() {
        for d in [
            DriverKind::Mysql,
            DriverKind::Postgres,
            DriverKind::Sqlite,
            DriverKind::DuckDb,
            DriverKind::Mssql,
        ] {
            assert_eq!(driver_from_wire(d.as_str()).unwrap(), d);
        }
        assert!(driver_from_wire("oracle").is_err());
    }
}
