use std::sync::Arc;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::commands::query::record_write_history;
use crate::error::{AppError, Result};
use crate::state::{AppState, Session};

/// Number of data rows returned by `parse_csv_preview` for the mapping UI.
const PREVIEW_ROW_LIMIT: usize = 50;
/// Rows per INSERT statement when the caller doesn't specify. Drivers clamp
/// this further to respect their own placeholder / statement-size limits.
const DEFAULT_BATCH_SIZE: usize = 500;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportOptions {
    /// Field delimiter — a single ASCII character (`,`, `\t`, `;`, ...).
    pub delimiter: char,
    /// Quote character — a single ASCII character.
    pub quote: char,
    /// Whether the first record is a header row (skipped on import, used as
    /// column names in the preview).
    pub has_header: bool,
    /// When `Some`, any field whose raw text equals this token is imported as
    /// SQL NULL (`Some("")` → empty cells become NULL, `Some("NULL")` → the
    /// literal text "NULL" becomes NULL). When `None`, no field is nulled.
    #[serde(default)]
    pub null_token: Option<String>,
    /// Encoding label understood by `encoding_rs` ("utf-8", "shift_jis",
    /// "euc-jp", ...). Unknown labels fall back to UTF-8.
    pub encoding: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnMapping {
    /// Destination table column name.
    pub column: String,
    /// Zero-based index of the source field within each CSV record.
    pub csv_index: usize,
}

#[derive(Debug, Serialize)]
pub struct CsvPreview {
    /// Column headers — the first record when `has_header`, otherwise
    /// synthesised as `column_1`, `column_2`, ...
    pub headers: Vec<String>,
    /// Up to `PREVIEW_ROW_LIMIT` data rows of raw field text (no NULL mapping
    /// applied — the preview shows the file verbatim).
    pub rows: Vec<Vec<String>>,
    /// True when the file has more data rows than were returned.
    pub truncated: bool,
}

fn validate_chars(opts: &ImportOptions) -> Result<()> {
    if !opts.delimiter.is_ascii() {
        return Err(AppError::InvalidInput(
            "delimiter must be a single ASCII character".into(),
        ));
    }
    if !opts.quote.is_ascii() {
        return Err(AppError::InvalidInput(
            "quote must be a single ASCII character".into(),
        ));
    }
    Ok(())
}

fn decode_bytes(bytes: &[u8], encoding: &str) -> String {
    let enc = encoding_rs::Encoding::for_label(encoding.as_bytes()).unwrap_or(encoding_rs::UTF_8);
    let (cow, _, _) = enc.decode(bytes);
    cow.into_owned()
}

fn build_reader<'a>(data: &'a [u8], opts: &ImportOptions) -> csv::Reader<&'a [u8]> {
    csv::ReaderBuilder::new()
        .delimiter(opts.delimiter as u8)
        .quote(opts.quote as u8)
        // We manage the header row ourselves so the preview can show synthetic
        // names for headerless files.
        .has_headers(false)
        // Tolerate ragged rows — missing trailing fields become NULL on import.
        .flexible(true)
        .from_reader(data)
}

fn csv_err(e: csv::Error) -> AppError {
    AppError::Other(format!("CSV parse error: {e}"))
}

fn parse_preview(data: &[u8], opts: &ImportOptions) -> Result<CsvPreview> {
    let mut rdr = build_reader(data, opts);
    let mut records = rdr.records();

    let mut headers: Vec<String> = Vec::new();
    if opts.has_header {
        if let Some(first) = records.next() {
            let rec = first.map_err(csv_err)?;
            headers = rec.iter().map(|s| s.to_string()).collect();
        }
    }

    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut truncated = false;
    for rec in records {
        let rec = rec.map_err(csv_err)?;
        if rows.len() >= PREVIEW_ROW_LIMIT {
            truncated = true;
            break;
        }
        let fields: Vec<String> = rec.iter().map(|s| s.to_string()).collect();
        if !opts.has_header && headers.is_empty() {
            headers = (1..=fields.len()).map(|i| format!("column_{i}")).collect();
        }
        rows.push(fields);
    }

    Ok(CsvPreview {
        headers,
        rows,
        truncated,
    })
}

/// Reads the file and returns the header + first rows for the mapping UI.
#[tauri::command]
pub async fn parse_csv_preview(path: String, options: ImportOptions) -> Result<CsvPreview> {
    validate_chars(&options)?;
    let bytes = tokio::fs::read(&path).await?;
    let text = decode_bytes(&bytes, &options.encoding);
    parse_preview(text.as_bytes(), &options)
}

fn apply_null(s: &str, opts: &ImportOptions) -> Option<String> {
    match &opts.null_token {
        Some(tok) if s == tok => None,
        _ => Some(s.to_string()),
    }
}

/// Parses every data record into target-column order, applying the NULL token.
/// Each output row has exactly `mapping.len()` cells; a CSV field that is
/// missing for a given mapping entry becomes NULL.
fn parse_rows(
    data: &[u8],
    opts: &ImportOptions,
    mapping: &[ColumnMapping],
) -> Result<Vec<Vec<Option<String>>>> {
    let mut rdr = build_reader(data, opts);
    let mut records = rdr.records();
    if opts.has_header {
        if let Some(first) = records.next() {
            first.map_err(csv_err)?;
        }
    }
    let mut out: Vec<Vec<Option<String>>> = Vec::new();
    for rec in records {
        let rec = rec.map_err(csv_err)?;
        let row: Vec<Option<String>> = mapping
            .iter()
            .map(|m| match rec.get(m.csv_index) {
                Some(s) => apply_null(s, opts),
                None => None,
            })
            .collect();
        out.push(row);
    }
    Ok(out)
}

#[derive(Debug, Serialize, Clone)]
struct ImportStartedEvent {
    #[serde(rename = "streamId")]
    stream_id: String,
    total: u64,
}

#[derive(Debug, Serialize, Clone)]
struct ImportProgressEvent {
    #[serde(rename = "streamId")]
    stream_id: String,
    inserted: u64,
    total: u64,
}

#[derive(Debug, Serialize, Clone)]
struct ImportDoneEvent {
    #[serde(rename = "streamId")]
    stream_id: String,
    inserted: u64,
    #[serde(rename = "elapsedMs")]
    elapsed_ms: u64,
}

#[derive(Debug, Serialize, Clone)]
struct ImportErrorEvent {
    #[serde(rename = "streamId")]
    stream_id: String,
    error: String,
}

const EV_IMPORT_STARTED: &str = "csv-import:started";
const EV_IMPORT_PROGRESS: &str = "csv-import:progress";
const EV_IMPORT_DONE: &str = "csv-import:done";
const EV_IMPORT_ERROR: &str = "csv-import:error";

/// Streams a CSV file into `table`. The whole import runs in one transaction
/// (all-or-nothing); progress is reported via `csv-import:*` events keyed by
/// `stream_id`, mirroring the query-stream protocol. Cancel via `cancel_stream`.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn import_csv(
    app: AppHandle,
    session_id: String,
    stream_id: String,
    database: Option<String>,
    table: String,
    path: String,
    options: ImportOptions,
    mapping: Vec<ColumnMapping>,
    batch_size: Option<usize>,
    state: State<'_, AppState>,
) -> Result<()> {
    let session = state
        .get(&session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;
    if session.read_only {
        return Err(AppError::ReadOnly(
            "read-only profile: CSV import is not allowed".into(),
        ));
    }
    validate_chars(&options)?;
    if mapping.is_empty() {
        return Err(AppError::InvalidInput(
            "no columns mapped for import".into(),
        ));
    }

    let handle = tokio::spawn(spawn_import(
        app,
        session,
        stream_id.clone(),
        database,
        table,
        path,
        options,
        mapping,
        batch_size.unwrap_or(DEFAULT_BATCH_SIZE),
    ));
    state
        .register_stream(stream_id, handle.abort_handle())
        .await;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn spawn_import(
    app: AppHandle,
    session: Arc<Session>,
    stream_id: String,
    database: Option<String>,
    table: String,
    path: String,
    options: ImportOptions,
    mapping: Vec<ColumnMapping>,
    batch_size: usize,
) {
    // Kept for the history summary after `run_import` consumes the originals.
    let summary_db = database.clone();
    let summary = format!("-- CSV import into {} ({} columns)", table, mapping.len());
    let result = run_import(
        &app, &session, &stream_id, database, table, path, options, mapping, batch_size,
    )
    .await;

    // A CSV import is a bulk write; record it to history like the edit-Apply
    // path so destructive imports are auditable (skip_history honoured).
    match &result {
        Ok((inserted, elapsed_ms)) => {
            record_write_history(
                &session,
                summary,
                summary_db.as_deref(),
                Some(*inserted as i64),
                Some(*elapsed_ms as i64),
                None,
            )
            .await
        }
        Err(e) => {
            record_write_history(
                &session,
                summary,
                summary_db.as_deref(),
                None,
                None,
                Some(e.to_string()),
            )
            .await
        }
    }

    match result {
        Ok((inserted, elapsed_ms)) => {
            let _ = app.emit(
                EV_IMPORT_DONE,
                ImportDoneEvent {
                    stream_id: stream_id.clone(),
                    inserted,
                    elapsed_ms,
                },
            );
        }
        Err(e) => {
            let _ = app.emit(
                EV_IMPORT_ERROR,
                ImportErrorEvent {
                    stream_id: stream_id.clone(),
                    error: e.to_string(),
                },
            );
        }
    }

    if let Some(state) = app.try_state::<AppState>() {
        state.forget_stream(&stream_id).await;
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_import(
    app: &AppHandle,
    session: &Session,
    stream_id: &str,
    database: Option<String>,
    table: String,
    path: String,
    options: ImportOptions,
    mapping: Vec<ColumnMapping>,
    batch_size: usize,
) -> Result<(u64, u64)> {
    let bytes = tokio::fs::read(&path).await?;
    let text = decode_bytes(&bytes, &options.encoding);
    let columns: Vec<String> = mapping.iter().map(|m| m.column.clone()).collect();
    let rows = parse_rows(text.as_bytes(), &options, &mapping)?;
    let total = rows.len() as u64;

    let _ = app.emit(
        EV_IMPORT_STARTED,
        ImportStartedEvent {
            stream_id: stream_id.to_string(),
            total,
        },
    );

    let started = Instant::now();
    let emit_app = app.clone();
    let emit_id = stream_id.to_string();
    let inserted = session
        .conn
        .import_rows(
            database.as_deref(),
            &table,
            &columns,
            &rows,
            batch_size,
            |n| {
                let _ = emit_app.emit(
                    EV_IMPORT_PROGRESS,
                    ImportProgressEvent {
                        stream_id: emit_id.clone(),
                        inserted: n,
                        total,
                    },
                );
                Ok(())
            },
        )
        .await?;

    Ok((inserted, started.elapsed().as_millis() as u64))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(has_header: bool, null_token: Option<&str>) -> ImportOptions {
        ImportOptions {
            delimiter: ',',
            quote: '"',
            has_header,
            null_token: null_token.map(|s| s.to_string()),
            encoding: "utf-8".into(),
        }
    }

    #[test]
    fn preview_uses_header_row() {
        let data = b"id,name\n1,Alice\n2,Bob\n";
        let p = parse_preview(data, &opts(true, None)).unwrap();
        assert_eq!(p.headers, vec!["id", "name"]);
        assert_eq!(p.rows, vec![vec!["1", "Alice"], vec!["2", "Bob"]]);
        assert!(!p.truncated);
    }

    #[test]
    fn preview_synthesises_headers_without_header_row() {
        let data = b"1,Alice\n2,Bob\n";
        let p = parse_preview(data, &opts(false, None)).unwrap();
        assert_eq!(p.headers, vec!["column_1", "column_2"]);
        assert_eq!(p.rows.len(), 2);
    }

    #[test]
    fn preview_handles_quoted_fields_with_embedded_delimiters() {
        let data = b"id,note\n1,\"a,b\nc\"\n";
        let p = parse_preview(data, &opts(true, None)).unwrap();
        assert_eq!(p.rows, vec![vec!["1".to_string(), "a,b\nc".to_string()]]);
    }

    #[test]
    fn rows_apply_mapping_and_null_token() {
        let data = b"id,name,age\n1,Alice,30\n2,,\n";
        let mapping = vec![
            ColumnMapping {
                column: "name".into(),
                csv_index: 1,
            },
            ColumnMapping {
                column: "age".into(),
                csv_index: 2,
            },
        ];
        let rows = parse_rows(data, &opts(true, Some("")), &mapping).unwrap();
        assert_eq!(
            rows,
            vec![
                vec![Some("Alice".to_string()), Some("30".to_string())],
                vec![None, None],
            ]
        );
    }

    #[test]
    fn rows_treat_missing_fields_as_null() {
        // Second row is short — the mapped index 2 is absent → NULL.
        let data = b"a,b,c\n1,2,3\n4,5\n";
        let mapping = vec![ColumnMapping {
            column: "c".into(),
            csv_index: 2,
        }];
        let rows = parse_rows(data, &opts(true, None), &mapping).unwrap();
        assert_eq!(rows, vec![vec![Some("3".to_string())], vec![None]]);
    }

    #[test]
    fn decode_falls_back_to_utf8_for_unknown_label() {
        assert_eq!(
            decode_bytes("héllo".as_bytes(), "no-such-encoding"),
            "héllo"
        );
    }
}
