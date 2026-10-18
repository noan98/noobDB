use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::assertions::transfer::ImportRejection;
use crate::commands::profiles::ImportStrategy;
use crate::error::{AppError, Result};
use crate::snippets::store::{self, new_snippet_id};
use crate::snippets::transfer::{self, ImportCounts};
use crate::snippets::{Snippet, SnippetScope};

/// `preview_import_snippets` の結果 (#1490)。書き込まずに、適用前の確認に使う。
#[derive(Debug, Clone, Serialize)]
pub struct SnippetImportPreview {
    /// ファイル内で取り込み対象になった件数 (解釈できた要素)。
    pub total: u32,
    /// 既存と ID が衝突しない (そのまま追加される) 件数。
    pub new_count: u32,
    /// 既存と ID が衝突する件数。戦略 (採番 / スキップ / 上書き) で扱いが変わる。
    pub conflict_count: u32,
    /// 取り込み先に無いプロファイルを指すため全接続スコープへ戻す件数 (戦略別)。
    pub scope_reset_by_strategy: ScopeResetByStrategy,
    /// ファイルの中で ID が重複している件数 (既存との衝突とは別)。
    pub duplicate_in_file_count: u32,
    /// 既存と ID が衝突する要素の先頭数件 (「上書き」で何が置き換わるかを見せる)。
    pub conflicts: Vec<SnippetConflict>,
    /// 解釈・検証に失敗して取り込めない要素。
    pub rejected: Vec<ImportRejection>,
}

/// 衝突 1 件 (`SnippetImportPreview::conflicts`。#1490)。
pub use crate::snippets::transfer::SnippetConflict;

/// 戦略ごとの、全接続スコープへ付け替える件数。衝突する要素は Rename / Overwrite では
/// 取り込まれ、Skip では捨てられるので、戦略によって変わる。
#[derive(Debug, Clone, Serialize)]
pub struct ScopeResetByStrategy {
    pub rename: u32,
    pub skip: u32,
    pub overwrite: u32,
}

/// プレビューに載せる衝突の最大件数 (全件数は `conflict_count`)。
const MAX_PREVIEW_CONFLICTS: usize = 20;

/// `import_snippets` の結果 (#1490)。
#[derive(Debug, Clone, Serialize)]
pub struct SnippetImportResult {
    pub imported: u32,
    pub skipped: u32,
    pub overwritten: u32,
    pub scope_reset: u32,
    pub rejected: Vec<ImportRejection>,
}

/// 同期ファイル I/O (`std::fs` + `std::sync::Mutex`) を blocking スレッドへ逃がす。
async fn blocking<T, F>(f: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}

fn known_profile_ids() -> Result<HashSet<String>> {
    Ok(crate::profiles::store::load_all()?
        .into_iter()
        .map(|p| p.id)
        .collect())
}

#[derive(Debug, Deserialize)]
pub struct SaveSnippetRequest {
    /// If empty/None a new id is generated.
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub folder: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    pub sql: String,
    #[serde(default)]
    pub driver: Option<String>,
    #[serde(default)]
    pub scope: SnippetScope,
}

#[tauri::command]
pub async fn list_snippets() -> Result<Vec<Snippet>> {
    store::load_all()
}

#[tauri::command]
pub async fn save_snippet(req: SaveSnippetRequest) -> Result<Snippet> {
    let id = req
        .id
        .filter(|s| !s.is_empty())
        .unwrap_or_else(new_snippet_id);
    let tags = req
        .tags
        .into_iter()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .collect();
    let snippet = Snippet {
        id,
        name: req.name,
        folder: req.folder.filter(|s| !s.trim().is_empty()),
        tags,
        sql: req.sql,
        driver: req.driver.filter(|s| !s.is_empty()),
        scope: req.scope,
    };
    store::upsert(snippet.clone())?;
    Ok(snippet)
}

#[tauri::command]
pub async fn delete_snippet(id: String) -> Result<()> {
    store::delete(&id)?;
    // 実行計画ウォッチ (#743 / #1260): 削除したスニペットのウォッチと世代を全
    // プロファイルのストアから取り除く (孤立データを残さない)。スニペット自体は
    // 既に削除済みなので、ウォッチ側の掃除に失敗しても削除は成功として扱う。
    if let Err(e) = crate::plan_watch::store::delete_snippet(&id).await {
        tracing::warn!(snippet_id = %id, error = %e, "failed to drop plan watch data of a deleted snippet");
    }
    Ok(())
}

/// スニペットを JSON 文字列として書き出す (#1490)。`ids` が空/None なら全件、指定があれば
/// その ID だけ (一覧の並び順を保つ)。非秘密なので keyring は関与しない。ファイルへの保存は
/// フロントが保存ダイアログ + `write_text_file` で行う (新しい書き込み経路を増やさない)。
#[tauri::command]
pub async fn export_snippets(ids: Option<Vec<String>>) -> Result<String> {
    blocking(move || {
        let all = store::load_all()?;
        let picked: Vec<Snippet> = match ids.filter(|v| !v.is_empty()) {
            Some(ids) => all.into_iter().filter(|s| ids.contains(&s.id)).collect(),
            None => all,
        };
        transfer::export_json(
            &picked,
            &chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        )
    })
    .await
}

/// 取り込み前のプレビュー (#1490)。ファイルの JSON から取り込み件数・衝突件数・
/// スコープの付け替え件数・解釈できない要素を数えるだけで、何も書き込まない。
#[tauri::command]
pub async fn preview_import_snippets(json: String) -> Result<SnippetImportPreview> {
    blocking(move || {
        let (incoming, rejected) = transfer::parse_import(&json)?;
        let total = u32::try_from(incoming.len()).unwrap_or(u32::MAX);
        let existing = store::load_all()?;
        let known = known_profile_ids()?;
        // 3 つの戦略それぞれで (副作用なしに) 統合を回し、件数と衝突一覧を同じ処理から出す。
        let run = |strategy| {
            transfer::plan_import(
                existing.clone(),
                incoming.clone(),
                strategy,
                &known,
                new_snippet_id,
            )
            .1
        };
        let skip: ImportCounts = run(ImportStrategy::Skip);
        let rename = run(ImportStrategy::Rename);
        let overwrite = run(ImportStrategy::Overwrite);
        let mut conflicts = skip.conflict_list.clone();
        conflicts.truncate(MAX_PREVIEW_CONFLICTS);
        let counts = skip;
        Ok(SnippetImportPreview {
            total,
            new_count: total.saturating_sub(counts.conflicts + counts.duplicates_in_file),
            conflict_count: counts.conflicts,
            scope_reset_by_strategy: ScopeResetByStrategy {
                rename: rename.scope_reset,
                skip: counts.scope_reset,
                overwrite: overwrite.scope_reset,
            },
            duplicate_in_file_count: counts.duplicates_in_file,
            conflicts,
            rejected,
        })
    })
    .await
}

/// 書き出した JSON (または定義の配列) を取り込む (#1490)。ID の衝突は `strategy`
/// (新規採番 / スキップ / 上書き) で解決する。プロファイル限定スコープが取り込み先に無い
/// プロファイルを指していれば全接続スコープへ戻す。解釈・検証に失敗した要素は理由つきで
/// 報告し、残りは取り込む。
#[tauri::command]
pub async fn import_snippets(
    json: String,
    strategy: ImportStrategy,
) -> Result<SnippetImportResult> {
    blocking(move || {
        let (incoming, rejected) = transfer::parse_import(&json)?;
        let known = known_profile_ids()?;
        let counts = store::import(incoming, strategy, &known, new_snippet_id)?;
        tracing::info!(
            imported = counts.imported,
            skipped = counts.skipped,
            overwritten = counts.overwritten,
            "snippets imported"
        );
        Ok(SnippetImportResult {
            imported: counts.imported,
            skipped: counts.skipped,
            overwritten: counts.overwritten,
            scope_reset: counts.scope_reset,
            rejected,
        })
    })
    .await
}
