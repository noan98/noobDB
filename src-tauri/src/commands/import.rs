use std::sync::Arc;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::commands::query::record_write_history;
use crate::error::{AppError, Result};
use crate::state::{AppState, Session, StreamHandle, StreamKind};

/// Parsed rows paired with each row's source file line (CSV only; `None` for
/// JSON/NDJSON). Aliased to keep the parse signature readable (#687).
type ParsedRowsWithLines = (Vec<Vec<Option<String>>>, Vec<Option<u64>>);

/// Number of data rows returned by `parse_csv_preview` for the mapping UI.
const PREVIEW_ROW_LIMIT: usize = 50;
/// Rows per INSERT statement when the caller doesn't specify. Drivers clamp
/// this further to respect their own placeholder / statement-size limits.
const DEFAULT_BATCH_SIZE: usize = 500;

/// Source data format for an import. Defaults to `Csv` so requests sent before
/// this field existed (and any caller that omits it) keep the CSV behavior.
#[derive(Debug, Clone, Copy, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ImportFormat {
    #[default]
    Csv,
    /// A top-level JSON array of objects (a bare object is treated as one row).
    Json,
    /// Newline-delimited JSON — one object per line.
    Ndjson,
}

/// How to handle a row the database rejects (#687). Defaults to `Abort` so the
/// import stays all-or-nothing unless the user opts into skipping.
#[derive(Debug, Clone, Copy, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ImportErrorMode {
    /// Roll the whole import back on the first bad row (all-or-nothing). The
    /// error names the failing record (and, for CSV, its file line).
    #[default]
    Abort,
    /// Skip bad rows and keep going; report the skipped rows at the end. Not
    /// all-or-nothing — good rows are committed.
    Skip,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportOptions {
    /// Source format. CSV uses the delimiter/quote/header fields below; JSON and
    /// NDJSON ignore them and key rows by object field name.
    #[serde(default)]
    pub format: ImportFormat,
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
    /// How to handle rows the database rejects (#687). Defaults to `Abort`
    /// (all-or-nothing) for requests that omit it.
    #[serde(default)]
    pub error_mode: ImportErrorMode,
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
    if opts.format != ImportFormat::Csv {
        return parse_json_preview(data, opts.format);
    }
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
/// Despite the `csv` name (kept for IPC stability) this handles CSV, JSON, and
/// NDJSON; the format is selected by `options.format`.
#[tauri::command]
pub async fn parse_csv_preview(path: String, options: ImportOptions) -> Result<CsvPreview> {
    if options.format == ImportFormat::Csv {
        validate_chars(&options)?;
    }
    let bytes = tokio::fs::read(&path).await?;
    let text = decode_bytes(&bytes, &options.encoding);
    parse_preview(text.as_bytes(), &options)
}

fn json_err(e: serde_json::Error) -> AppError {
    AppError::Other(format!("JSON parse error: {e}"))
}

/// Parses the source into a list of objects. JSON expects a top-level array of
/// objects (a bare object becomes a single row); NDJSON expects one object per
/// non-blank line. Non-object elements are rejected with a clear error.
fn parse_json_records(
    text: &str,
    format: ImportFormat,
) -> Result<Vec<serde_json::Map<String, serde_json::Value>>> {
    use serde_json::Value;
    match format {
        ImportFormat::Json => {
            let value: Value = serde_json::from_str(text).map_err(json_err)?;
            match value {
                Value::Array(items) => items.into_iter().map(json_object).collect(),
                Value::Object(_) => Ok(vec![json_object(value)?]),
                _ => Err(AppError::InvalidInput(
                    "JSON import expects an array of objects (or a single object)".into(),
                )),
            }
        }
        ImportFormat::Ndjson => {
            let mut out = Vec::new();
            for (i, line) in text.lines().enumerate() {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let value: Value = serde_json::from_str(trimmed).map_err(|e| {
                    AppError::Other(format!("NDJSON parse error on line {}: {e}", i + 1))
                })?;
                out.push(json_object(value)?);
            }
            Ok(out)
        }
        // The dispatcher only calls this for JSON/NDJSON.
        ImportFormat::Csv => Ok(Vec::new()),
    }
}

/// Ensures a JSON value is an object (one import row). Arrays/scalars at the row
/// level are rejected so the column mapping stays meaningful.
fn json_object(value: serde_json::Value) -> Result<serde_json::Map<String, serde_json::Value>> {
    match value {
        serde_json::Value::Object(map) => Ok(map),
        _ => Err(AppError::InvalidInput(
            "JSON import expects each element to be an object".into(),
        )),
    }
}

/// Union of object keys across all records, in first-seen order so the preview
/// and the import agree on column positions even when objects have heterogeneous
/// keys. `serde_json::Map` is a `BTreeMap` here, so each object's keys iterate
/// sorted; the union is deterministic regardless, because the same parse feeds
/// both the preview and the import.
fn collect_json_headers(records: &[serde_json::Map<String, serde_json::Value>]) -> Vec<String> {
    let mut headers: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for record in records {
        for key in record.keys() {
            if seen.insert(key.as_str().to_string()) {
                headers.push(key.clone());
            }
        }
    }
    headers
}

/// Converts a JSON value to its imported cell text. `null` → SQL NULL (`None`);
/// scalars use their textual form; nested objects/arrays are stringified to
/// compact JSON text so structured fields land in the table verbatim.
fn json_value_to_cell(value: &serde_json::Value) -> Option<String> {
    use serde_json::Value;
    match value {
        Value::Null => None,
        Value::Bool(b) => Some(b.to_string()),
        Value::Number(n) => Some(n.to_string()),
        Value::String(s) => Some(s.clone()),
        other => Some(other.to_string()),
    }
}

/// Header + first rows for the JSON/NDJSON mapping UI. Mirrors `parse_preview`'s
/// CSV branch: NULL/missing cells show as empty text in the verbatim preview.
fn parse_json_preview(data: &[u8], format: ImportFormat) -> Result<CsvPreview> {
    let text = std::str::from_utf8(data)
        .map_err(|e| AppError::Other(format!("invalid UTF-8 in import file: {e}")))?;
    let records = parse_json_records(text, format)?;
    let headers = collect_json_headers(&records);

    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut truncated = false;
    for record in &records {
        if rows.len() >= PREVIEW_ROW_LIMIT {
            truncated = true;
            break;
        }
        let row = headers
            .iter()
            .map(|h| match record.get(h) {
                Some(v) => json_value_to_cell(v).unwrap_or_default(),
                None => String::new(),
            })
            .collect();
        rows.push(row);
    }

    Ok(CsvPreview {
        headers,
        rows,
        truncated,
    })
}

/// Parses JSON/NDJSON records into target-column order via `mapping`. Each
/// `csv_index` indexes into the same header list `parse_json_preview` produced,
/// so the mapping the user picked in the preview stays aligned. The NULL token
/// is applied to resolved cell text for parity with the CSV path.
fn parse_json_rows(
    data: &[u8],
    opts: &ImportOptions,
    mapping: &[ColumnMapping],
) -> Result<Vec<Vec<Option<String>>>> {
    let text = std::str::from_utf8(data)
        .map_err(|e| AppError::Other(format!("invalid UTF-8 in import file: {e}")))?;
    let records = parse_json_records(text, opts.format)?;
    let headers = collect_json_headers(&records);

    let mut out: Vec<Vec<Option<String>>> = Vec::new();
    for record in &records {
        let row = mapping
            .iter()
            .map(|m| match headers.get(m.csv_index) {
                Some(key) => match record.get(key) {
                    Some(value) => json_value_to_cell(value).and_then(|s| apply_null(&s, opts)),
                    None => None,
                },
                None => None,
            })
            .collect();
        out.push(row);
    }
    Ok(out)
}

fn apply_null(s: &str, opts: &ImportOptions) -> Option<String> {
    match &opts.null_token {
        Some(tok) if s == tok => None,
        _ => Some(s.to_string()),
    }
}

/// Parses every data record into target-column order, applying the NULL token.
/// Each output row has exactly `mapping.len()` cells; a CSV field that is
/// missing for a given mapping entry becomes NULL. Thin wrapper over
/// [`parse_rows_with_lines`] that drops the line info; kept for the row-parsing
/// unit tests (the import path uses the with-lines form for error reporting).
#[cfg(test)]
fn parse_rows(
    data: &[u8],
    opts: &ImportOptions,
    mapping: &[ColumnMapping],
) -> Result<Vec<Vec<Option<String>>>> {
    Ok(parse_rows_with_lines(data, opts, mapping)?.0)
}

/// Like [`parse_rows`] but also returns, per parsed record, its 1-based source
/// **line** in the original file (`Some` for CSV, `None` for JSON/NDJSON where a
/// record index is the meaningful identifier). Used so a rejected row can be
/// reported by both record number and file line (#687).
fn parse_rows_with_lines(
    data: &[u8],
    opts: &ImportOptions,
    mapping: &[ColumnMapping],
) -> Result<ParsedRowsWithLines> {
    if opts.format != ImportFormat::Csv {
        let rows = parse_json_rows(data, opts, mapping)?;
        // JSON/NDJSON identify a row by its record index, not a file line.
        let lines = vec![None; rows.len()];
        return Ok((rows, lines));
    }
    let mut rdr = build_reader(data, opts);
    let mut records = rdr.records();
    if opts.has_header {
        if let Some(first) = records.next() {
            first.map_err(csv_err)?;
        }
    }
    let mut out: Vec<Vec<Option<String>>> = Vec::new();
    let mut lines: Vec<Option<u64>> = Vec::new();
    for rec in records {
        let rec = rec.map_err(csv_err)?;
        // The line where this record starts (accounts for quoted multi-line
        // fields, so it's the true file line, not a naive record+offset).
        lines.push(rec.position().map(|p| p.line()));
        let row: Vec<Option<String>> = mapping
            .iter()
            .map(|m| match rec.get(m.csv_index) {
                Some(s) => apply_null(s, opts),
                None => None,
            })
            .collect();
        out.push(row);
    }
    Ok((out, lines))
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

/// One skipped row surfaced to the UI (#687): the 1-based record number among
/// data records, the source file line (CSV only; `None` for JSON/NDJSON), and
/// the driver's rejection reason.
#[derive(Debug, Serialize, Clone)]
struct SkippedRowInfo {
    record: u64,
    line: Option<u64>,
    reason: String,
}

#[derive(Debug, Serialize, Clone)]
struct ImportDoneEvent {
    #[serde(rename = "streamId")]
    stream_id: String,
    inserted: u64,
    #[serde(rename = "elapsedMs")]
    elapsed_ms: u64,
    /// Rows skipped in `skip` mode (empty in `abort` mode). #687.
    skipped: Vec<SkippedRowInfo>,
}

#[derive(Debug, Serialize, Clone)]
struct ImportErrorEvent {
    #[serde(rename = "streamId")]
    stream_id: String,
    error: String,
    /// For an `abort`-mode failure, the 1-based record number that was rejected
    /// (and its CSV file line), when it could be pinpointed (#687).
    record: Option<u64>,
    line: Option<u64>,
}

/// Outcome of the DB-execution phase of an import (#687). Setup failures (file
/// read, parse, read-only guard) are still `Err(AppError)` from `run_import`;
/// this captures the two DB-level results: success (with any skipped rows) and
/// an abort-mode failure pinpointed to a record/line.
enum ImportRun {
    Ok {
        inserted: u64,
        elapsed_ms: u64,
        skipped: Vec<SkippedRowInfo>,
    },
    Failed {
        message: String,
        record: Option<u64>,
        line: Option<u64>,
    },
}

const EV_IMPORT_STARTED: &str = "csv-import:started";
const EV_IMPORT_PROGRESS: &str = "csv-import:progress";
const EV_IMPORT_DONE: &str = "csv-import:done";
const EV_IMPORT_ERROR: &str = "csv-import:error";

/// Rejects a CSV import on a read-only session. Extracted so the IPC-level
/// integration tests can assert the same guard `import_csv` enforces, keeping
/// the read-only contract covered against refactors.
pub(crate) fn ensure_import_writable(session: &Session) -> Result<()> {
    if session.read_only {
        tracing::warn!(
            session_id = %session.id,
            "read-only guard rejected a CSV import"
        );
        return Err(AppError::ReadOnly(
            "read-only profile: CSV import is not allowed".into(),
        ));
    }
    Ok(())
}

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
    ensure_import_writable(&session)?;
    if path.trim().is_empty() {
        return Err(AppError::InvalidInput("import file path is empty".into()));
    }
    if options.format == ImportFormat::Csv {
        validate_chars(&options)?;
    }
    if mapping.is_empty() {
        return Err(AppError::InvalidInput(
            "no columns mapped for import".into(),
        ));
    }

    // register_stream をタスク本体より前に完了させるためのゲート
    // (run_query_stream / preview_query_stream と同じ理由。#685)。入力エラー等で
    // 即終了する import が register より先に forget_stream し、完了済みハンドルが
    // streams に残る競合を防ぐ。
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel::<()>();
    let stream_id_for_task = stream_id.clone();
    let handle = tokio::spawn(async move {
        let _ = ready_rx.await;
        spawn_import(
            app,
            session,
            stream_id_for_task,
            database,
            table,
            path,
            options,
            mapping,
            batch_size.unwrap_or(DEFAULT_BATCH_SIZE),
        )
        .await;
    });
    state
        .register_stream(
            stream_id,
            StreamHandle {
                abort: handle.abort_handle(),
                // A CSV/JSON import runs as one all-or-nothing transaction, so
                // there's no meaningful "rows delivered so far" to report on
                // cancel (unlike the query/preview/export streams, #685) —
                // this counter is never incremented.
                delivered_rows: Arc::new(std::sync::atomic::AtomicU64::new(0)),
                kind: StreamKind::Import,
            },
        )
        .await;
    // register_stream 完了後にタスク本体の実行を許可する。
    let _ = ready_tx.send(());
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
    let fmt = match options.format {
        ImportFormat::Csv => "CSV",
        ImportFormat::Json => "JSON",
        ImportFormat::Ndjson => "NDJSON",
    };
    let summary = format!(
        "-- {} import into {} ({} columns)",
        fmt,
        table,
        mapping.len()
    );
    let result = run_import(
        &app, &session, &stream_id, database, table, path, options, mapping, batch_size,
    )
    .await;

    // A CSV import is a bulk write; record it to history like the edit-Apply
    // path so destructive imports are auditable (skip_history honoured). A
    // skip-mode run that dropped rows is recorded as a success with the count;
    // an abort-mode failure records the pinpointed message.
    match &result {
        Ok(ImportRun::Ok {
            inserted,
            elapsed_ms,
            ..
        }) => {
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
        Ok(ImportRun::Failed { message, .. }) => {
            record_write_history(
                &session,
                summary,
                summary_db.as_deref(),
                None,
                None,
                Some(message.clone()),
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
        Ok(ImportRun::Ok {
            inserted,
            elapsed_ms,
            skipped,
        }) => {
            tracing::info!(
                stream_id = %stream_id,
                inserted,
                skipped = skipped.len(),
                elapsed_ms,
                "csv import completed"
            );
            if let Err(e) = app.emit(
                EV_IMPORT_DONE,
                ImportDoneEvent {
                    stream_id: stream_id.clone(),
                    inserted,
                    elapsed_ms,
                    skipped,
                },
            ) {
                tracing::warn!(stream_id = %stream_id, error = %e, "failed to emit import done event");
            }
        }
        Ok(ImportRun::Failed {
            message,
            record,
            line,
        }) => {
            tracing::error!(stream_id = %stream_id, error = %message, record = ?record, "csv import failed");
            if let Err(emit_err) = app.emit(
                EV_IMPORT_ERROR,
                ImportErrorEvent {
                    stream_id: stream_id.clone(),
                    error: message,
                    record,
                    line,
                },
            ) {
                tracing::warn!(stream_id = %stream_id, error = %emit_err, "failed to emit import error event");
            }
        }
        Err(e) => {
            tracing::error!(stream_id = %stream_id, error = %e, "csv import failed (setup)");
            if let Err(emit_err) = app.emit(
                EV_IMPORT_ERROR,
                ImportErrorEvent {
                    stream_id: stream_id.clone(),
                    error: e.to_string(),
                    record: None,
                    line: None,
                },
            ) {
                tracing::warn!(
                    stream_id = %stream_id,
                    error = %emit_err,
                    "failed to emit import error event"
                );
            }
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
) -> Result<ImportRun> {
    let bytes = tokio::fs::read(&path).await?;
    let text = decode_bytes(&bytes, &options.encoding);
    let columns: Vec<String> = mapping.iter().map(|m| m.column.clone()).collect();
    // `lines[i]` is record i's source file line (CSV only), used to report a bad
    // row by both record number and file line (#687).
    let (rows, lines) = parse_rows_with_lines(text.as_bytes(), &options, &mapping)?;
    let total = rows.len() as u64;

    tracing::info!(
        session_id = %session.id,
        stream_id = %stream_id,
        table = %table,
        total,
        error_mode = ?options.error_mode,
        "csv import starting"
    );

    if let Err(e) = app.emit(
        EV_IMPORT_STARTED,
        ImportStartedEvent {
            stream_id: stream_id.to_string(),
            total,
        },
    ) {
        tracing::warn!(stream_id = %stream_id, error = %e, "failed to emit import started event");
    }

    // Cumulative-progress emitter shared by both modes.
    let emit_progress = {
        let emit_app = app.clone();
        let emit_id = stream_id.to_string();
        move |n: u64| -> Result<()> {
            if let Err(e) = emit_app.emit(
                EV_IMPORT_PROGRESS,
                ImportProgressEvent {
                    stream_id: emit_id.clone(),
                    inserted: n,
                    total,
                },
            ) {
                tracing::warn!(stream_id = %emit_id, error = %e, "failed to emit import progress event");
            }
            Ok(())
        }
    };

    let started = Instant::now();
    match options.error_mode {
        ImportErrorMode::Skip => {
            // Resilient: skip rows the DB rejects, report them at the end.
            let outcome = session
                .conn
                .import_rows_skipping(
                    database.as_deref(),
                    &table,
                    &columns,
                    &rows,
                    batch_size,
                    emit_progress,
                )
                .await?;
            let skipped = outcome
                .skipped
                .iter()
                .map(|s| SkippedRowInfo {
                    record: s.index as u64 + 1,
                    line: lines.get(s.index).copied().flatten(),
                    reason: s.reason.clone(),
                })
                .collect();
            Ok(ImportRun::Ok {
                inserted: outcome.inserted,
                elapsed_ms: started.elapsed().as_millis() as u64,
                skipped,
            })
        }
        ImportErrorMode::Abort => {
            // All-or-nothing. On failure, pinpoint the offending record (no side
            // effects — the probe rolls back) so the error can name it.
            match session
                .conn
                .import_rows(
                    database.as_deref(),
                    &table,
                    &columns,
                    &rows,
                    batch_size,
                    emit_progress,
                )
                .await
            {
                Ok(inserted) => Ok(ImportRun::Ok {
                    inserted,
                    elapsed_ms: started.elapsed().as_millis() as u64,
                    skipped: Vec::new(),
                }),
                Err(e) => {
                    let located = session
                        .conn
                        .probe_failing_row(database.as_deref(), &table, &columns, &rows)
                        .await
                        .ok()
                        .flatten();
                    let (record, line) = match &located {
                        Some((idx, _)) => {
                            (Some(*idx as u64 + 1), lines.get(*idx).copied().flatten())
                        }
                        None => (None, None),
                    };
                    let message = match (record, line) {
                        (Some(r), Some(l)) => {
                            format!("{e} (failed at record {r}, line {l})")
                        }
                        (Some(r), None) => format!("{e} (failed at record {r})"),
                        _ => e.to_string(),
                    };
                    Ok(ImportRun::Failed {
                        message,
                        record,
                        line,
                    })
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(has_header: bool, null_token: Option<&str>) -> ImportOptions {
        ImportOptions {
            format: ImportFormat::Csv,
            delimiter: ',',
            quote: '"',
            has_header,
            null_token: null_token.map(|s| s.to_string()),
            encoding: "utf-8".into(),
            error_mode: ImportErrorMode::Abort,
        }
    }

    /// Options for a JSON/NDJSON import. Delimiter/quote/header are unused by the
    /// JSON path but the struct still requires them.
    fn json_opts(format: ImportFormat, null_token: Option<&str>) -> ImportOptions {
        ImportOptions {
            format,
            delimiter: ',',
            quote: '"',
            has_header: true,
            null_token: null_token.map(|s| s.to_string()),
            encoding: "utf-8".into(),
            error_mode: ImportErrorMode::Abort,
        }
    }

    fn map(column: &str, idx: usize) -> ColumnMapping {
        ColumnMapping {
            column: column.into(),
            csv_index: idx,
        }
    }

    #[test]
    fn csv_parse_tracks_source_line_including_multiline_fields() {
        // A quoted field spans two physical lines, so record 2 starts at line 4,
        // not line 3 — the position tracking must reflect the true file line
        // (#687).
        let data = b"id,note\n1,ok\n2,\"line a\nline b\"\n3,done\n";
        let mapping = vec![map("id", 0), map("note", 1)];
        let (rows, lines) = parse_rows_with_lines(data, &opts(true, None), &mapping).unwrap();
        assert_eq!(rows.len(), 3);
        // Record 1 → line 2 (after the header on line 1).
        assert_eq!(lines[0], Some(2));
        // Record 2's quoted field occupies lines 3–4; its record starts at 3.
        assert_eq!(lines[1], Some(3));
        // Record 3 follows the two-line field, so it's on line 5.
        assert_eq!(lines[2], Some(5));
    }

    #[test]
    fn json_parse_has_no_source_lines() {
        // JSON/NDJSON rows are identified by record index, not a file line.
        let data = br#"[{"a":1},{"a":2}]"#;
        let mapping = vec![map("a", 0)];
        let (rows, lines) =
            parse_rows_with_lines(data, &json_opts(ImportFormat::Json, None), &mapping).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(lines, vec![None, None]);
    }

    #[test]
    fn json_preview_collects_union_of_keys() {
        let data = br#"[{"id":1,"name":"Alice"},{"id":2,"email":"b@x.io"}]"#;
        let p = parse_preview(data, &json_opts(ImportFormat::Json, None)).unwrap();
        // First-seen union across objects; each object's keys iterate sorted
        // (BTreeMap): id, name from the first object, then email from the second.
        // Missing keys render as empty text in the verbatim preview.
        assert_eq!(p.headers, vec!["id", "name", "email"]);
        assert_eq!(p.rows[0], vec!["1", "Alice", ""]);
        assert_eq!(p.rows[1], vec!["2", "", "b@x.io"]);
        assert!(!p.truncated);
    }

    #[test]
    fn json_preview_accepts_single_object() {
        let data = br#"{"a":1,"b":2}"#;
        let p = parse_preview(data, &json_opts(ImportFormat::Json, None)).unwrap();
        assert_eq!(p.headers, vec!["a", "b"]);
        assert_eq!(p.rows, vec![vec!["1", "2"]]);
    }

    #[test]
    fn json_rows_stringify_nested_and_null_to_sql_null() {
        let data = br#"[{"id":1,"meta":{"k":"v"},"tags":[1,2],"opt":null}]"#;
        let opts = json_opts(ImportFormat::Json, None);
        // Keys iterate sorted (BTreeMap): id, meta, opt, tags.
        let mapping = vec![map("id", 0), map("meta", 1), map("opt", 2), map("tags", 3)];
        let rows = parse_rows(data, &opts, &mapping).unwrap();
        assert_eq!(
            rows,
            vec![vec![
                Some("1".to_string()),
                Some("{\"k\":\"v\"}".to_string()),
                None,
                Some("[1,2]".to_string()),
            ]]
        );
    }

    #[test]
    fn ndjson_parses_one_object_per_line_skipping_blanks() {
        let data = b"{\"id\":1,\"name\":\"Alice\"}\n\n{\"id\":2,\"name\":\"Bob\"}\n";
        let p = parse_preview(data, &json_opts(ImportFormat::Ndjson, None)).unwrap();
        assert_eq!(p.headers, vec!["id", "name"]);
        assert_eq!(p.rows.len(), 2);
        let mapping = vec![map("name", 1)];
        let rows = parse_rows(data, &json_opts(ImportFormat::Ndjson, None), &mapping).unwrap();
        assert_eq!(
            rows,
            vec![
                vec![Some("Alice".to_string())],
                vec![Some("Bob".to_string())]
            ]
        );
    }

    #[test]
    fn json_rows_apply_null_token_for_csv_parity() {
        // An explicit empty-string value becomes NULL when the null token is "".
        let data = br#"[{"name":""},{"name":"x"}]"#;
        let mapping = vec![map("name", 0)];
        let rows = parse_rows(data, &json_opts(ImportFormat::Json, Some("")), &mapping).unwrap();
        assert_eq!(rows, vec![vec![None], vec![Some("x".to_string())]]);
    }

    #[test]
    fn json_rejects_non_object_elements() {
        let data = br#"[{"a":1}, 42]"#;
        let err = parse_preview(data, &json_opts(ImportFormat::Json, None));
        assert!(err.is_err());
    }

    #[test]
    fn json_rejects_top_level_scalar() {
        let data = br#"42"#;
        assert!(parse_preview(data, &json_opts(ImportFormat::Json, None)).is_err());
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

    // ── エンコーディング変換のラウンドトリップ / 境界ケース (#626) ──
    //
    // `decode_bytes` は `encoding_rs` で Shift_JIS / EUC-JP などをデコードする。
    // マルチバイト境界・不正バイト (ロッシー)・BOM の各入力で、静かなデータ破損や
    // panic が起きないことを固定する。テスト入力は `encoding_rs` の encoder で
    // 生成し、往復一致 (encode → decode_bytes → 原文) を確認する。

    /// 日本語文字列を各エンコーディングにエンコードして返す。エンコード不能文字が
    /// あればテストを落とす (テストデータが対象エンコーディングで表現可能なことを保証)。
    fn encode_to(text: &str, enc: &'static encoding_rs::Encoding) -> Vec<u8> {
        let (bytes, _, had_errors) = enc.encode(text);
        assert!(!had_errors, "test text must be encodable in {}", enc.name());
        bytes.into_owned()
    }

    #[test]
    fn decode_shift_jis_multibyte_roundtrips() {
        // ひらがな・漢字・全角記号を含む (Shift_JIS は 2 バイト文字の宝庫)。
        let text = "こんにちは、世界！ABC　（全角）";
        let bytes = encode_to(text, encoding_rs::SHIFT_JIS);
        // マルチバイト列であることを確認 (ASCII のみなら境界テストにならない)。
        assert!(bytes.len() > text.chars().count());
        assert_eq!(
            decode_bytes(&bytes, "shift_jis"),
            text,
            "Shift_JIS のマルチバイト文字が往復で一致するはず"
        );
    }

    #[test]
    fn decode_euc_jp_multibyte_roundtrips() {
        let text = "漢字とかな、混在テキスト";
        let bytes = encode_to(text, encoding_rs::EUC_JP);
        assert_eq!(
            decode_bytes(&bytes, "euc-jp"),
            text,
            "EUC-JP のマルチバイト文字が往復で一致するはず"
        );
    }

    #[test]
    fn decode_invalid_bytes_are_lossy_not_panicking() {
        // Shift_JIS として不正なバイト列 (単独の先行バイト 0x82 の直後に不正な後続)。
        // ロッシーデコードで置換文字 U+FFFD になり、panic しないこと。
        let bad = vec![0x82, 0xFF, b'a', b'b'];
        let decoded = decode_bytes(&bad, "shift_jis");
        assert!(
            decoded.contains('\u{FFFD}'),
            "不正バイトは置換文字 U+FFFD に落ちるはず: {decoded:?}"
        );
        // 末尾の妥当な ASCII は保持される。
        assert!(decoded.ends_with("ab"), "妥当な後続は保持されるはず");
    }

    #[test]
    fn decode_strips_utf8_bom() {
        // UTF-8 BOM (EF BB BF) 付きのテキストは、BOM が除去された本文になる
        // (encoding_rs の decode は BOM をスニッフして取り除く)。
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice("id,name".as_bytes());
        assert_eq!(
            decode_bytes(&bytes, "utf-8"),
            "id,name",
            "UTF-8 BOM は本文から除去されるはず (先頭に U+FEFF を残さない)"
        );
    }

    #[test]
    fn decode_utf16le_bom_is_honored() {
        // UTF-16LE BOM (FF FE) 付きの本文は、ラベルが utf-8 でも BOM のエンコーディングが
        // 優先されて正しくデコードされる (encoding_rs の BOM スニッフィング)。
        let mut bytes = vec![0xFF, 0xFE];
        for u in "AB".encode_utf16() {
            bytes.extend_from_slice(&u.to_le_bytes());
        }
        assert_eq!(
            decode_bytes(&bytes, "utf-8"),
            "AB",
            "UTF-16LE BOM が優先されてデコードされるはず"
        );
    }

    #[test]
    fn shift_jis_csv_preview_decodes_japanese_headers_and_values() {
        // decode_bytes → parse_preview の一連の流れ (parse_csv_preview と同じ順序) で、
        // Shift_JIS の CSV が正しい日本語ヘッダ/値になることを end-to-end で確認する。
        let csv = "名前,年齢\n山田,30\n";
        let bytes = encode_to(csv, encoding_rs::SHIFT_JIS);
        let text = decode_bytes(&bytes, "shift_jis");
        let p = parse_preview(text.as_bytes(), &opts(true, None)).unwrap();
        assert_eq!(p.headers, vec!["名前", "年齢"]);
        assert_eq!(p.rows, vec![vec!["山田", "30"]]);
    }
}
