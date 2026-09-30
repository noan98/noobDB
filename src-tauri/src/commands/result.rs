//! 結果ハンドル (#1264) を扱う IPC コマンド。
//!
//! ストリーミング実行 (`run_query_stream`) が保持した行 (`db::result_store`) に対して、
//! ソート・フィルタ・検索・列統計・テキスト書き出しをバックエンド側で行う。フロントは
//! `result_id` と条件だけを送り、行そのものは往復させない。
//!
//! ハンドルが破棄済み (LRU・切断・上限超過) のとき、`result_*` 系は `null` を返し、
//! 行を受け取るコマンド (`export_query_result` など) は [`RESULT_GONE`] を含むエラーを返す。
//! どちらもフロントは JS 経路 (行を送る従来の経路) へフォールバックする。

use std::sync::Arc;

use serde::Deserialize;
use tauri::State;

use crate::commands::export::{load_mask_spec, write_export_to, ExportFormat, SqlExportOpts};
use crate::db::masking::ColumnMask;
use crate::db::result_ops::{
    column_stats, find, sort_filter, ColumnStatsOut, FilterSpec, FindOptions, FindOutput, SortSpec,
};
use crate::db::result_store::{StoredResult, RESULT_GONE};
use crate::db::types::{Column, Value};
use crate::db::DriverKind;
use crate::error::{AppError, Result};
use crate::state::AppState;

/// ハンドルを引く。無ければ `None`。
fn lookup(state: &AppState, result_id: &str) -> Option<StoredResult> {
    state
        .results
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(result_id)
}

pub(crate) fn gone_error(result_id: &str) -> AppError {
    AppError::InvalidInput(format!("{RESULT_GONE}: {result_id}"))
}

/// `result_id` があればハンドルの行、無ければ渡された `rows` を返す。
/// ハンドル指定なのに無いときは [`RESULT_GONE`] のエラー (黙って空にしない)。
pub fn resolve_rows(
    state: &AppState,
    result_id: Option<&str>,
    rows: Vec<Vec<Value>>,
) -> Result<Arc<Vec<Vec<Value>>>> {
    match result_id {
        Some(id) => lookup(state, id)
            .map(|r| r.rows)
            .ok_or_else(|| gone_error(id)),
        None => Ok(Arc::new(rows)),
    }
}

/// 表示順の行インデックスを返す。`null` はハンドル無し。
pub async fn result_sort_filter_inner(
    state: &AppState,
    result_id: &str,
    sort: Vec<SortSpec>,
    filters: Vec<FilterSpec>,
    global: String,
) -> Result<Option<Vec<u32>>> {
    let Some(stored) = lookup(state, result_id) else {
        return Ok(None);
    };
    let order = tokio::task::spawn_blocking(move || {
        sort_filter(&stored.rows, stored.col_count, &sort, &filters, &global)
    })
    .await
    .map_err(|e| AppError::Other(format!("result sort task failed: {e}")))?;
    Ok(Some(order))
}

/// ソート・列フィルタ・全体フィルタを適用した表示順の行インデックス (元の行位置) を返す。
/// 意味論はフロントの `ResultGrid.tsx` と同じ (`db::result_ops`)。
#[tauri::command]
pub async fn result_sort_filter(
    result_id: String,
    sort: Vec<SortSpec>,
    filters: Vec<FilterSpec>,
    global: String,
    state: State<'_, AppState>,
) -> Result<Option<Vec<u32>>> {
    result_sort_filter_inner(&state, &result_id, sort, filters, global).await
}

pub async fn result_find_inner(
    state: &AppState,
    result_id: &str,
    query: String,
    options: FindOptions,
    limit: usize,
) -> Result<Option<FindOutput>> {
    let Some(stored) = lookup(state, result_id) else {
        return Ok(None);
    };
    let out = tokio::task::spawn_blocking(move || {
        find(&stored.rows, stored.col_count, &query, options, limit)
    })
    .await
    .map_err(|e| AppError::Other(format!("result find task failed: {e}")))?;
    Ok(Some(out))
}

/// 結果内検索 (正規表現なし)。ヒットは行優先で最大 `limit` 件、総数と打ち切りの有無を添える。
#[tauri::command]
pub async fn result_find(
    result_id: String,
    query: String,
    options: FindOptions,
    limit: usize,
    state: State<'_, AppState>,
) -> Result<Option<FindOutput>> {
    result_find_inner(&state, &result_id, query, options, limit).await
}

pub async fn result_column_stats_inner(
    state: &AppState,
    result_id: &str,
    col: usize,
) -> Result<Option<ColumnStatsOut>> {
    let Some(stored) = lookup(state, result_id) else {
        return Ok(None);
    };
    if col >= stored.col_count {
        return Err(AppError::InvalidInput(format!(
            "column index out of range: {col}"
        )));
    }
    let out = tokio::task::spawn_blocking(move || column_stats(&stored.rows, col))
        .await
        .map_err(|e| AppError::Other(format!("result stats task failed: {e}")))?;
    Ok(Some(out))
}

/// 列クイック統計 (件数・NULL・DISTINCT・数値レンジ・文字列長・最頻値)。
#[tauri::command]
pub async fn result_column_stats(
    result_id: String,
    col: usize,
    state: State<'_, AppState>,
) -> Result<Option<ColumnStatsOut>> {
    result_column_stats_inner(&state, &result_id, col).await
}

/// 結果ハンドルを破棄する。無い id でも成功 (冪等)。
#[tauri::command]
pub async fn release_result(result_id: String, state: State<'_, AppState>) -> Result<()> {
    state
        .results
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .release(&result_id);
    Ok(())
}

/// `render_export_text` の入力行の出どころ。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderExportRequest {
    pub format: ExportFormat,
    pub columns: Vec<Column>,
    #[serde(default)]
    pub rows: Vec<Vec<Value>>,
    #[serde(default)]
    pub result_id: Option<String>,
    #[serde(default)]
    pub query: Option<String>,
    #[serde(default)]
    pub table: Option<String>,
    #[serde(default)]
    pub driver: Option<DriverKind>,
    #[serde(default)]
    pub batch_size: Option<usize>,
    #[serde(default)]
    pub masks: Option<Vec<ColumnMask>>,
}

pub async fn render_export_text_inner(
    state: &AppState,
    req: RenderExportRequest,
) -> Result<String> {
    if matches!(req.format, ExportFormat::Xlsx) {
        return Err(AppError::InvalidInput(
            "xlsx is binary and has no text rendering".into(),
        ));
    }
    let rows = resolve_rows(state, req.result_id.as_deref(), req.rows)?;
    let sql_opts = SqlExportOpts::build(req.driver, req.table, req.batch_size);
    let mask_spec = load_mask_spec(req.masks).await?;
    let (format, columns, query) = (req.format, req.columns, req.query);
    let bytes = tokio::task::spawn_blocking(move || -> Result<Vec<u8>> {
        let plan = mask_spec.as_ref().map(|s| s.plan(&columns));
        let mut buf: Vec<u8> = Vec::new();
        // ファイル出力 (`write_export`) と同じ書式ライタ・マスキング経路を通す。
        write_export_to(
            &mut buf,
            format,
            &columns,
            &rows,
            query.as_deref(),
            &sql_opts,
            plan.as_ref(),
        )?;
        Ok(buf)
    })
    .await
    .map_err(|e| AppError::Other(format!("render export task failed: {e}")))??;
    String::from_utf8(bytes).map_err(|e| AppError::Other(format!("export text is not utf-8: {e}")))
}

/// エクスポート内容をテキストとして生成して返す (全文コピー・プレビュー・調査バンドル用)。
/// ファイル出力と**同じ** `write_export_to` を `Vec<u8>` に向けるので、書式はファイルと
/// バイト一致する。マスキングもここで適用する (ソルトはフロントへ出さない)。
#[tauri::command]
pub async fn render_export_text(
    req: RenderExportRequest,
    state: State<'_, AppState>,
) -> Result<String> {
    render_export_text_inner(&state, req).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::result_ops::{FilterOp, NullMode, SortKind};

    fn state_with(id: &str, rows: Vec<Vec<Value>>) -> AppState {
        let state = AppState::default();
        let bytes = rows
            .iter()
            .map(|r| crate::db::result_store::approx_row_bytes(r))
            .sum();
        assert!(state.results.lock().unwrap().insert(
            id.to_string(),
            "s".to_string(),
            2,
            rows,
            bytes
        ));
        state
    }

    fn sample_rows() -> Vec<Vec<Value>> {
        vec![
            vec![Value::Int(3), Value::String("c".into())],
            vec![Value::Int(1), Value::String("a,b".into())],
            vec![Value::Int(2), Value::Null],
        ]
    }

    #[tokio::test]
    async fn sort_filter_and_find_run_against_the_stored_rows() {
        let state = state_with("r1", sample_rows());
        let order = result_sort_filter_inner(
            &state,
            "r1",
            vec![SortSpec {
                col: 0,
                kind: SortKind::Numeric,
                desc: false,
            }],
            vec![FilterSpec {
                col: 0,
                op: FilterOp::Gt,
                value: "1".into(),
                value2: String::new(),
                null_mode: NullMode::Any,
            }],
            String::new(),
        )
        .await
        .unwrap();
        assert_eq!(order, Some(vec![2, 0]));

        let hits = result_find_inner(
            &state,
            "r1",
            "A".into(),
            FindOptions {
                case_sensitive: false,
                whole_cell: false,
            },
            10,
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(hits.total, 1);
    }

    #[tokio::test]
    async fn missing_handles_report_gone_without_error_for_queries() {
        let state = AppState::default();
        assert_eq!(
            result_sort_filter_inner(&state, "nope", vec![], vec![], String::new())
                .await
                .unwrap(),
            None
        );
        assert!(result_column_stats_inner(&state, "nope", 0)
            .await
            .unwrap()
            .is_none());
        let err = resolve_rows(&state, Some("nope"), vec![]).unwrap_err();
        assert!(err.to_string().contains(RESULT_GONE));
    }

    #[tokio::test]
    async fn render_export_text_matches_between_handle_and_inline_rows() {
        let state = state_with("r1", sample_rows());
        let columns = vec![
            Column {
                name: "id".into(),
                type_name: "INTEGER".into(),
            },
            Column {
                name: "v".into(),
                type_name: "TEXT".into(),
            },
        ];
        for format in [
            ExportFormat::Csv,
            ExportFormat::Json,
            ExportFormat::Ndjson,
            ExportFormat::Markdown,
            ExportFormat::Sql,
        ] {
            let by_handle = render_export_text_inner(
                &state,
                RenderExportRequest {
                    format,
                    columns: columns.clone(),
                    rows: vec![],
                    result_id: Some("r1".into()),
                    query: None,
                    table: Some("t".into()),
                    driver: Some(DriverKind::Sqlite),
                    batch_size: None,
                    masks: None,
                },
            )
            .await
            .unwrap();
            let inline = render_export_text_inner(
                &state,
                RenderExportRequest {
                    format,
                    columns: columns.clone(),
                    rows: sample_rows(),
                    result_id: None,
                    query: None,
                    table: Some("t".into()),
                    driver: Some(DriverKind::Sqlite),
                    batch_size: None,
                    masks: None,
                },
            )
            .await
            .unwrap();
            assert_eq!(by_handle, inline, "{format:?}");
            assert!(!by_handle.is_empty(), "{format:?}");
        }
    }

    #[tokio::test]
    async fn render_export_text_rejects_xlsx() {
        let state = AppState::default();
        let err = render_export_text_inner(
            &state,
            RenderExportRequest {
                format: ExportFormat::Xlsx,
                columns: vec![],
                rows: vec![],
                result_id: None,
                query: None,
                table: None,
                driver: None,
                batch_size: None,
                masks: None,
            },
        )
        .await
        .unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)));
    }
}
