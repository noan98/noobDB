//! スキーマドリフト・タイムライン (#736 / #1260) の IPC コマンド。
//!
//! 取得 (`columns_for_database` / `indexes_for_database` の 2 クエリ)・正規化・
//! フィンガープリント・保存・前世代との差分計算を Rust 内で完結させ、フロントへは
//! 要約だけを返す。設計の詳細は `crate::schema_drift` のモジュール doc。
//! メタデータの読み取りのみで、クエリ履歴には記録されず、読み取り専用セッションでも
//! そのまま動く。

use serde::Serialize;
use tauri::State;

use crate::error::{AppError, Result};
use crate::schema_drift::store::{self, LegacyGeneration};
use crate::schema_drift::{
    capture_payload, summarize_payloads, DriftSummary, GenerationMeta, SnapshotPayload,
};
use crate::state::{AppState, Session};

/// `schema_drift_capture` の結果。
#[derive(Debug, Serialize)]
pub struct SchemaDriftCapture {
    /// 新しい世代が追加されたか (直前世代と同一内容なら false)。
    pub added: bool,
    /// 実際に取得した対象の名前。PostgreSQL ではプロファイルの DB 名が既定スキーマ
    /// (`current_schema()`) に解決される (#1537)。MySQL / SQLite は要求した名前のまま。
    pub database: String,
    /// 追加後の世代一覧 (新しい順)。`added` が false のときは空 (一覧は変わっていない)。
    pub generations: Vec<GenerationMeta>,
    /// 直前世代からの変化サマリ。初回取得・どちらかの世代が省略済み・追加なしのときは `None`。
    /// 変化が無ければ `tables` が空のサマリになる。
    pub summary: Option<DriftSummary>,
}

async fn session_of(state: &AppState, session_id: &str) -> Result<std::sync::Arc<Session>> {
    state
        .get(session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.to_string()))
}

fn parse_id(id: &str) -> Result<i64> {
    id.parse::<i64>()
        .map_err(|_| AppError::InvalidInput(format!("invalid schema drift generation id '{id}'")))
}

/// 世代に紐づける実行 SQL の最大文字数。長大なスクリプトでタイムラインを重くしない。
const MAX_TRIGGER_SQL_CHARS: usize = 2000;

/// 世代に紐づける SQL を整える (純関数)。前後の空白を落とし、空なら `None`、長すぎるときは
/// 先頭 `MAX_TRIGGER_SQL_CHARS` 文字で切って `…` を付ける。
pub(crate) fn normalize_trigger_sql(sql: Option<&str>) -> Option<String> {
    let sql = sql?.trim();
    if sql.is_empty() {
        return None;
    }
    if sql.chars().count() <= MAX_TRIGGER_SQL_CHARS {
        return Some(sql.to_string());
    }
    let mut cut: String = sql.chars().take(MAX_TRIGGER_SQL_CHARS).collect();
    cut.push('…');
    Some(cut)
}

/// `database` の現在のスキーマを取得して世代として記録し、前世代からの変化サマリを返す。
///
/// `trigger_sql` は DDL の成功をきっかけにした自動取得のときに、そのとき実行した SQL
/// (#1537)。世代に紐づけて保存し、タイムラインで「どの文でスキーマが変わったか」を辿れる
/// ようにする。履歴を残さない接続 (`skip_history`) では SQL を保存しない。
#[tauri::command]
pub async fn schema_drift_capture(
    session_id: String,
    profile_id: String,
    database: String,
    trigger_sql: Option<String>,
    state: State<'_, AppState>,
) -> Result<SchemaDriftCapture> {
    let session = session_of(&state, &session_id).await?;
    let payload = capture_payload(&session.conn, &database).await?;
    let trigger_sql = if session.skip_history {
        None
    } else {
        normalize_trigger_sql(trigger_sql.as_deref())
    };
    let outcome = store::record(&profile_id, &payload, trigger_sql.as_deref()).await?;
    if !outcome.added {
        return Ok(SchemaDriftCapture {
            added: false,
            database: payload.database,
            generations: Vec::new(),
            summary: None,
        });
    }
    // 新世代がサイズ超過で省略された場合でも、比較には手元の `payload` を使える。
    let summary = outcome
        .prev
        .as_ref()
        .and_then(|p| p.payload.as_ref())
        // 対象 (DB / スキーマ) が前世代と違うと全テーブルが増減したように見えるので比べない
        // (PostgreSQL で DB 名のまま空を取っていた旧世代との境目など)。
        .and_then(|prev| summarize_if_same_target(prev, &payload));
    Ok(SchemaDriftCapture {
        added: true,
        database: payload.database,
        generations: store::list(&profile_id).await?,
        summary,
    })
}

/// プロファイルの世代一覧 (新しい順。保持上限はストア側のローテーション)。セッション不要。
#[tauri::command]
pub async fn schema_drift_list(profile_id: String) -> Result<Vec<GenerationMeta>> {
    store::list(&profile_id).await
}

/// 同じプロファイルの 2 世代 (`from_id` = 比較元、`to_id` = 比較先) の変化サマリ。
/// どちらかの世代が (サイズ超過で) 省略されている、存在しない、または対象 (DB / スキーマ)
/// が異なるときは `None` (対象が違うと全テーブルが増減したように見えるため。PostgreSQL で
/// 実 DB 名のまま空を取っていた旧世代との比較など, #1537)。
#[tauri::command]
pub async fn schema_drift_compare(
    profile_id: String,
    from_id: String,
    to_id: String,
) -> Result<Option<DriftSummary>> {
    let (from, to) = (parse_id(&from_id)?, parse_id(&to_id)?);
    let a = store::load(&profile_id, from).await?;
    let b = store::load(&profile_id, to).await?;
    match (a.and_then(|g| g.payload), b.and_then(|g| g.payload)) {
        (Some(a), Some(b)) => Ok(summarize_if_same_target(&a, &b)),
        _ => Ok(None),
    }
}

/// 2 つのペイロードの対象 (DB / スキーマ) が同じときだけ差分サマリを作る。
pub(crate) fn summarize_if_same_target(
    prev: &SnapshotPayload,
    next: &SnapshotPayload,
) -> Option<DriftSummary> {
    (prev.database == next.database).then(|| summarize_payloads(prev, next))
}

/// 旧 localStorage の世代 (新しい順) をストアへ一度だけ取り込む。既にこのプロファイルの
/// 世代があるときは何もしない。読めない世代は捨てる。取り込んだ件数を返す。
#[tauri::command]
pub async fn schema_drift_import_legacy(
    profile_id: String,
    generations: Vec<serde_json::Value>,
) -> Result<usize> {
    // 旧ストアの JSON は古いバージョンが書いたものを含みうるので、世代ごとに読み、
    // 読めないもの (必須フィールド欠落など) だけを捨てて残りを取り込む。
    let generations: Vec<LegacyGeneration> = generations
        .into_iter()
        .filter_map(|v| serde_json::from_value(v).ok())
        .collect();
    store::import_legacy(&profile_id, generations).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::DriverKind;

    fn payload(database: &str) -> SnapshotPayload {
        SnapshotPayload {
            driver: DriverKind::Postgres,
            database: database.to_string(),
            tables: Vec::new(),
        }
    }

    #[test]
    fn summaries_are_only_made_for_the_same_target() {
        assert!(summarize_if_same_target(&payload("public"), &payload("public")).is_some());
        // 実 DB 名で空を取っていた旧世代と、既定スキーマの新世代は比べない。
        assert!(summarize_if_same_target(&payload("testdb"), &payload("public")).is_none());
    }

    #[test]
    fn normalize_trigger_sql_trims_and_drops_empty() {
        assert_eq!(normalize_trigger_sql(None), None);
        assert_eq!(normalize_trigger_sql(Some("  \n ")), None);
        assert_eq!(
            normalize_trigger_sql(Some("  ALTER TABLE t ADD c INT;\n")).as_deref(),
            Some("ALTER TABLE t ADD c INT;")
        );
    }

    #[test]
    fn normalize_trigger_sql_truncates_on_char_boundary() {
        let long = "あ".repeat(MAX_TRIGGER_SQL_CHARS + 10);
        let out = normalize_trigger_sql(Some(&long)).unwrap();
        assert_eq!(out.chars().count(), MAX_TRIGGER_SQL_CHARS + 1);
        assert!(out.ends_with('…'));
        let exact = "x".repeat(MAX_TRIGGER_SQL_CHARS);
        assert_eq!(normalize_trigger_sql(Some(&exact)).unwrap(), exact);
    }
}
