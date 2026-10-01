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
use crate::schema_drift::{capture_payload, summarize_payloads, DriftSummary, GenerationMeta};
use crate::state::{AppState, Session};

/// `schema_drift_capture` の結果。
#[derive(Debug, Serialize)]
pub struct SchemaDriftCapture {
    /// 新しい世代が追加されたか (直前世代と同一内容なら false)。
    pub added: bool,
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

/// `database` の現在のスキーマを取得して世代として記録し、前世代からの変化サマリを返す。
#[tauri::command]
pub async fn schema_drift_capture(
    session_id: String,
    profile_id: String,
    database: String,
    state: State<'_, AppState>,
) -> Result<SchemaDriftCapture> {
    let session = session_of(&state, &session_id).await?;
    let payload = capture_payload(&session.conn, &database).await?;
    let outcome = store::record(&profile_id, &payload).await?;
    if !outcome.added {
        return Ok(SchemaDriftCapture {
            added: false,
            generations: Vec::new(),
            summary: None,
        });
    }
    // 新世代がサイズ超過で省略された場合でも、比較には手元の `payload` を使える。
    let summary = outcome
        .prev
        .as_ref()
        .and_then(|p| p.payload.as_ref())
        .map(|prev| summarize_payloads(prev, &payload));
    Ok(SchemaDriftCapture {
        added: true,
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
/// どちらかの世代が (サイズ超過で) 省略されている、または存在しないときは `None`。
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
        (Some(a), Some(b)) => Ok(Some(summarize_payloads(&a, &b))),
        _ => Ok(None),
    }
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
