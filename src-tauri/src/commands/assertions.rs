//! データ品質アサーション (#742) の IPC。
//!
//! 定義の CRUD (`list_assertions` / `save_assertion` / `delete_assertion`)、
//! 編集フォームの SQL プレビュー (`preview_assertion_sql`)、1 件の検証実行
//! (`run_assertion`) の 5 コマンド。
//!
//! 「すべて検証」はフロントが `run_assertion` を 1 件ずつ順に呼ぶ。こうすると
//! ルールごとにタイムアウトが効き、1 ルールの失敗 (エラー/タイムアウト) が残りを
//! 止めず、利用者の「中止」が次のルールの前で効く (実行中の 1 本はタイムアウトまで
//! 待つ — 裏方の `run_lookup_query` と同じ性質)。

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::assertions::{store, Assertion, AssertionRule};
use crate::commands::query::run_lookup_query_inner;
use crate::db::assertions::{build_sql, count_from_value, evaluate, validate, AssertionSql};
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
}

#[tauri::command]
pub async fn list_assertions() -> Result<Vec<Assertion>> {
    store::load_all()
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
    store::upsert(assertion.clone())?;
    Ok(assertion)
}

#[tauri::command]
pub async fn delete_assertion(id: String) -> Result<()> {
    store::delete(&id)
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
    let assertion = store::get(&id)?;
    run_assertion_with(
        state.inner(),
        &session_id,
        &assertion,
        database.as_deref(),
        query_timeout_secs,
    )
    .await
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
    .await?;
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
    })
}
