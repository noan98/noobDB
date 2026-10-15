//! データ品質アサーション (#742) の IPC。
//!
//! 定義の CRUD (`list_assertions` / `save_assertion` / `delete_assertion`)、
//! 編集フォームの SQL プレビュー (`preview_assertion_sql`)、1 件の検証実行
//! (`run_assertion`)。#1621 で、削除の取り消し (`restore_assertion`)・JSON の書き出し /
//! 取り込み (`export_assertions` / `import_assertions`)・`accepted_values` の候補を実データの
//! DISTINCT から読む (`suggest_accepted_values`) を足した。
//!
//! 「すべて検証」はフロントが `run_assertion` を 1 件ずつ順に呼ぶ。こうすると
//! ルールごとにタイムアウトが効き、1 ルールの失敗 (エラー/タイムアウト) が残りを
//! 止めず、利用者の「中止」が次のルールの前で効く (実行中の 1 本はタイムアウトまで
//! 待つ — 裏方の `run_lookup_query` と同じ性質)。

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::assertions::transfer::{self, ImportRejection};
use crate::assertions::{history, store, Assertion, AssertionRule};
use crate::commands::query::run_lookup_query_inner;
use crate::db::assertions::{
    build_distinct_values_sql, build_sql, count_from_value, custom_sql_duplicate_column_hint,
    distinct_value_text, evaluate, validate, AssertionSql,
};
use crate::db::DriverKind;
use crate::error::{AppError, Result};
use crate::snippets::store::new_snippet_id;
use crate::snippets::SnippetScope;
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct SaveAssertionRequest {
    /// 空/None なら新しい ID を採番する。
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub scope: SnippetScope,
    #[serde(default)]
    pub schema: Option<String>,
    pub table: String,
    pub rule: AssertionRule,
}

/// 前回の実行結果 (#1621)。`assertion_history.json` に残した直近の 1 件。
#[derive(Debug, Clone, Serialize)]
pub struct AssertionPrevious {
    /// 前回の実行時刻 (UTC, RFC 3339)。
    pub at: String,
    pub observed: u64,
    pub passed: bool,
}

/// 1 件の検証結果。
#[derive(Debug, Clone, Serialize)]
pub struct AssertionOutcome {
    pub id: String,
    /// ルールを満たしたか。
    pub passed: bool,
    /// `check_sql` の結果。`row_count` は総行数、それ以外は違反件数。
    pub observed: u64,
    pub check_sql: String,
    pub violations_sql: String,
    pub elapsed_ms: u64,
    /// 前回の結果 (初回は `None`)。履歴に記録できる経路 (`run_assertion` IPC) だけが埋める。
    pub previous: Option<AssertionPrevious>,
}

/// `accepted_values` の候補の最大数 (これを超える DISTINCT は打ち切る)。
const DISTINCT_CANDIDATE_LIMIT: u32 = 50;

/// `suggest_accepted_values` の結果。
#[derive(Debug, Clone, Serialize)]
pub struct AcceptedValuesCandidates {
    /// 昇順の DISTINCT 値 (NULL・BLOB は除く、最大 50 件)。
    pub values: Vec<String>,
    /// DISTINCT の種類が上限を超えたため打ち切ったか。
    pub truncated: bool,
}

/// `import_assertions` の結果。
#[derive(Debug, Clone, Serialize)]
pub struct ImportAssertionsResult {
    /// 追加できたもの (ID は衝突時に振り直し済み)。
    pub imported: Vec<Assertion>,
    /// 既存と同じ内容なので追加しなかった件数。
    pub skipped_duplicates: u32,
    /// 解釈・検証に失敗して取り込めなかった要素。
    pub rejected: Vec<ImportRejection>,
}

/// 同期ファイル I/O (`std::fs` + `std::sync::Mutex`) のストア操作を blocking スレッドへ
/// 逃がす。Tokio のワーカーを塞がない (使用量台帳 `ai/usage.rs` と同じ方針)。
pub(crate) async fn blocking_store<T, F>(f: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn list_assertions() -> Result<Vec<Assertion>> {
    blocking_store(store::load_all).await
}

#[tauri::command]
pub async fn save_assertion(req: SaveAssertionRequest) -> Result<Assertion> {
    let name = req.name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::InvalidInput("assertion: name is required".into()));
    }
    validate(&req.table, &req.rule)?;
    let assertion = Assertion {
        id: req
            .id
            .filter(|s| !s.is_empty())
            .unwrap_or_else(new_snippet_id),
        name,
        scope: req.scope,
        schema: req
            .schema
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()),
        table: req.table.trim().to_string(),
        rule: req.rule,
    };
    let to_save = assertion.clone();
    blocking_store(move || store::upsert(to_save)).await?;
    Ok(assertion)
}

#[tauri::command]
pub async fn delete_assertion(id: String) -> Result<()> {
    blocking_store(move || store::delete(&id)).await
}

/// 削除したアサーションを一覧へ戻す (#1621)。
#[tauri::command]
pub async fn restore_assertion(id: String) -> Result<Assertion> {
    blocking_store(move || store::restore(&id)).await
}

/// 一覧のアサーションを JSON 文字列として書き出す (#1621)。`ids` が空/None なら全件、
/// 指定があればその ID だけ (一覧の並び順を保つ)。ファイルへの保存はフロントが
/// 保存ダイアログ + `write_text_file` で行う。
#[tauri::command]
pub async fn export_assertions(ids: Option<Vec<String>>) -> Result<String> {
    blocking_store(move || {
        let all = store::load_all()?;
        let picked: Vec<Assertion> = match ids.filter(|v| !v.is_empty()) {
            Some(ids) => all.into_iter().filter(|a| ids.contains(&a.id)).collect(),
            None => all,
        };
        transfer::export_json(
            &picked,
            &chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        )
    })
    .await
}

/// 書き出した JSON (または定義の配列) を取り込む (#1621)。ID の衝突は新規採番で避け、
/// 既存と同じ内容は飛ばし、保存時と同じ検証 (`validate`) を通らない要素は理由つきで
/// 報告して残りを取り込む。`profile_id` を渡すと、プロファイル限定のスコープをそのプロファイル
/// へ付け替える (別 PC のプロファイル ID は取り込み先に存在しないため)。
#[tauri::command]
pub async fn import_assertions(
    json: String,
    profile_id: Option<String>,
) -> Result<ImportAssertionsResult> {
    blocking_store(move || {
        let (incoming, rejected) = transfer::parse_import(&json, profile_id.as_deref())?;
        let outcome = store::import(incoming, new_snippet_id)?;
        Ok(ImportAssertionsResult {
            imported: outcome.imported,
            skipped_duplicates: outcome.skipped_duplicates,
            rejected,
        })
    })
    .await
}

/// 登録フォーム用 (#1621): 列の DISTINCT 値を読み取り専用 SELECT で取得し、
/// `accepted_values` の候補として返す。`run_lookup_query` と同じ経路なので
/// read_only 接続でも動き、履歴・結果キャッシュに載らない。
#[tauri::command]
pub async fn suggest_accepted_values(
    session_id: String,
    schema: Option<String>,
    table: String,
    column: String,
    database: Option<String>,
    query_timeout_secs: Option<u64>,
    state: State<'_, AppState>,
) -> Result<AcceptedValuesCandidates> {
    suggest_accepted_values_with(
        state.inner(),
        &session_id,
        schema.as_deref(),
        &table,
        &column,
        database.as_deref(),
        query_timeout_secs,
    )
    .await
}

/// `suggest_accepted_values` の核 (統合テストから駆動できるよう `State` から切り離す)。
pub(crate) async fn suggest_accepted_values_with(
    state: &AppState,
    session_id: &str,
    schema: Option<&str>,
    table: &str,
    column: &str,
    database: Option<&str>,
    query_timeout_secs: Option<u64>,
) -> Result<AcceptedValuesCandidates> {
    let session = state
        .get(session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.to_string()))?;
    let driver = session.conn.driver_kind();
    let sql = build_distinct_values_sql(driver, schema, table, column, DISTINCT_CANDIDATE_LIMIT)?;
    let result = run_lookup_query_inner(
        state,
        session_id,
        &sql,
        database,
        query_timeout_secs,
        Some(DISTINCT_CANDIDATE_LIMIT + 1),
    )
    .await?;
    let mut values: Vec<String> = result
        .rows
        .iter()
        .filter_map(|row| row.first())
        .filter_map(distinct_value_text)
        .collect();
    let truncated = values.len() > DISTINCT_CANDIDATE_LIMIT as usize;
    values.truncate(DISTINCT_CANDIDATE_LIMIT as usize);
    Ok(AcceptedValuesCandidates { values, truncated })
}

/// 編集フォーム用: 保存前のルールを `driver` 方言の SQL に変換して返す
/// (DB には触れない純粋な変換)。
#[tauri::command]
pub async fn preview_assertion_sql(
    driver: DriverKind,
    schema: Option<String>,
    table: String,
    rule: AssertionRule,
) -> Result<AssertionSql> {
    build_sql(driver, schema.as_deref(), &table, &rule)
}

#[tauri::command]
pub async fn run_assertion(
    session_id: String,
    id: String,
    database: Option<String>,
    query_timeout_secs: Option<u64>,
    state: State<'_, AppState>,
) -> Result<AssertionOutcome> {
    let id_for_get = id.clone();
    let assertion = blocking_store(move || store::get(&id_for_get)).await?;
    let mut outcome = run_assertion_with(
        state.inner(),
        &session_id,
        &assertion,
        database.as_deref(),
        query_timeout_secs,
    )
    .await?;
    // 観測値の履歴 (#1621): 前回の結果を引いて今回の結果を記録する。履歴は補助情報なので、
    // 記録に失敗しても検証結果そのものは返す。
    let sample = history::sample_now(outcome.observed, outcome.passed, outcome.elapsed_ms);
    let id_for_history = assertion.id.clone();
    match blocking_store(move || history::record(&id_for_history, sample)).await {
        Ok(prev) => {
            outcome.previous = prev.map(|p| AssertionPrevious {
                at: p.at,
                observed: p.observed,
                passed: p.passed,
            });
        }
        Err(e) => tracing::warn!(error = %e, "assertion history: failed to record"),
    }
    Ok(outcome)
}

/// 検証実行の核。`Assertion` 本体を受け取るので、将来タスクスケジューラ (#730)
/// のアクションから呼ぶときもストアを経由せずに使える。
///
/// 実行は `run_lookup_query_inner` へ委ねる: セッションの `read_only` に関係なく
/// 読み取り専用の文だけを通し、`query_timeout_secs` で打ち切り、クエリ履歴にも
/// 結果キャッシュにも載らない (検証の内部クエリで利用者の履歴を汚さない)。
pub(crate) async fn run_assertion_with(
    state: &AppState,
    session_id: &str,
    assertion: &Assertion,
    database: Option<&str>,
    query_timeout_secs: Option<u64>,
) -> Result<AssertionOutcome> {
    let session = state
        .get(session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.to_string()))?;
    let driver = session.conn.driver_kind();
    let sql = build_sql(
        driver,
        assertion.schema.as_deref(),
        &assertion.table,
        &assertion.rule,
    )?;
    let started = std::time::Instant::now();
    let result = run_lookup_query_inner(
        state,
        session_id,
        &sql.check_sql,
        database,
        query_timeout_secs,
        Some(1),
    )
    .await
    .map_err(|e| {
        match custom_sql_duplicate_column_hint(driver, &assertion.rule, &e.to_string()) {
            Some(hint) => AppError::Other(hint),
            None => e,
        }
    })?;
    let elapsed_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    let observed = result
        .rows
        .first()
        .and_then(|row| row.first())
        .and_then(count_from_value)
        .ok_or_else(|| AppError::Other("assertion check returned no count".into()))?;
    Ok(AssertionOutcome {
        id: assertion.id.clone(),
        passed: evaluate(&assertion.rule, observed),
        observed,
        check_sql: sql.check_sql,
        violations_sql: sql.violations_sql,
        elapsed_ms,
        previous: None,
    })
}
