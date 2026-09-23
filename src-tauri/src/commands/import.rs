use std::sync::Arc;
use std::time::Instant;

use serde::{Deserialize, Serialize};

use crate::db::create_table::{render_create_table, render_drop_table, NewColumn};
use crate::db::upsert::{ConflictMode, ImportConflict};
use crate::db::DriverKind;
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
/// Upper bound on the size of a file that `parse_csv_preview` / `run_import`
/// will read into memory. Import reads the whole file before parsing, so an
/// unbounded read could OOM the process on a pathological input; this caps it
/// while still allowing large bulk imports. Mirrors the size-guard pattern in
/// `commands::file` (#687 review follow-up).
const MAX_IMPORT_FILE_BYTES: u64 = 512 * 1024 * 1024;

/// Read a file for import after rejecting an empty path and enforcing
/// `MAX_IMPORT_FILE_BYTES`. Like `commands::file::read_text_file`, `metadata`
/// alone is insufficient — it misses TOCTOU growth and special files whose
/// length is 0/undefined (e.g. FIFOs, `/proc`) — so the actual read is also
/// capped with `take` and the read length re-checked.
async fn read_import_file(path: &str) -> Result<Vec<u8>> {
    use tokio::io::AsyncReadExt;
    if path.trim().is_empty() {
        return Err(AppError::InvalidInput("import file path is empty".into()));
    }
    if let Ok(meta) = tokio::fs::metadata(path).await {
        if meta.len() > MAX_IMPORT_FILE_BYTES {
            return Err(AppError::InvalidInput(format!(
                "file too large to import ({} bytes, limit {} bytes)",
                meta.len(),
                MAX_IMPORT_FILE_BYTES
            )));
        }
    }
    let file = tokio::fs::File::open(path).await?;
    // Read at most limit + 1 bytes so an exactly-limit file is still accepted
    // while anything larger is detected by the actual read length.
    let mut limited = file.take(MAX_IMPORT_FILE_BYTES + 1);
    let mut bytes = Vec::new();
    limited.read_to_end(&mut bytes).await?;
    if bytes.len() as u64 > MAX_IMPORT_FILE_BYTES {
        return Err(AppError::InvalidInput(format!(
            "file too large to import (limit {MAX_IMPORT_FILE_BYTES} bytes)"
        )));
    }
    Ok(bytes)
}

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
    /// How to treat rows whose key already exists (#972). Defaults to plain
    /// INSERT (a duplicate key is a row error, handled by `error_mode`).
    #[serde(default)]
    pub conflict_mode: ConflictMode,
    /// Destination columns that identify a row for `conflict_mode` `skip` /
    /// `update`. Must be a non-empty subset of the mapped columns in those
    /// modes; ignored for `insert`.
    #[serde(default)]
    pub key_columns: Vec<String>,
}

impl ImportOptions {
    /// The DB-layer conflict spec for this import (#972).
    fn conflict(&self) -> ImportConflict {
        ImportConflict {
            mode: self.conflict_mode,
            key_columns: self.key_columns.clone(),
        }
    }
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
    let bytes = read_import_file(&path).await?;
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

// 構造体・フィールドの `pub` は #825 の zod ⇔ serde ゴールデン
// (`serde_schema_parity.rs`) が `__test_api` 経由で代表インスタンスを組み立てる
// ためのもの。IPC 経路としては引き続き非公開モジュール内に留まる (#824 の
// LogView と同じ最小限の可視性拡張パターン)。
#[derive(Debug, Serialize, Clone)]
pub struct ImportStartedEvent {
    #[serde(rename = "streamId")]
    pub stream_id: String,
    pub total: u64,
}

#[derive(Debug, Serialize, Clone)]
pub struct ImportProgressEvent {
    #[serde(rename = "streamId")]
    pub stream_id: String,
    pub inserted: u64,
    pub total: u64,
}

/// One skipped row surfaced to the UI (#687): the 1-based record number among
/// data records, the source file line (CSV only; `None` for JSON/NDJSON), and
/// the driver's rejection reason.
#[derive(Debug, Serialize, Clone)]
pub struct SkippedRowInfo {
    pub record: u64,
    pub line: Option<u64>,
    pub reason: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct ImportDoneEvent {
    #[serde(rename = "streamId")]
    pub stream_id: String,
    pub inserted: u64,
    #[serde(rename = "elapsedMs")]
    pub elapsed_ms: u64,
    /// Rows skipped in `skip` mode (empty in `abort` mode). #687.
    pub skipped: Vec<SkippedRowInfo>,
}

#[derive(Debug, Serialize, Clone)]
pub struct ImportErrorEvent {
    #[serde(rename = "streamId")]
    pub stream_id: String,
    pub error: String,
    /// For an `abort`-mode failure, the 1-based record number that was rejected
    /// (and its CSV file line), when it could be pinpointed (#687).
    pub record: Option<u64>,
    pub line: Option<u64>,
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
    create_table: Option<Vec<NewColumn>>,
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
    // UPSERT のキー列はマッピング済み列の部分集合でなければならない (#972)。
    // ストリーム開始前に同期的に弾き、入力ミスを即座にエラーとして返す。
    let mapped: Vec<String> = mapping.iter().map(|m| m.column.clone()).collect();
    options.conflict().validate(&mapped)?;
    // 新規テーブル作成 (#985) の定義も同期的に検証する (空名・重複列名・長さ
    // 上限・マッピング先が作成列に含まれるか)。DDL の実行自体はファイルの
    // パースが成功した後 (`run_import_core`) で行い、壊れたファイルで空テーブル
    // だけが残るのを避ける。
    if let Some(cols) = &create_table {
        validate_create_spec(session.conn.driver_kind(), &table, cols, &mapped)?;
    }

    // Rows committed so far. In `skip` mode each chunk is auto-committed, so a
    // mid-import cancel leaves the committed rows persisted — this counter lets
    // `cancel_stream` report them (`deliveredRows`). In `abort` mode the whole
    // import is one transaction that rolls back on cancel, so it stays 0 (#687
    // review follow-up).
    let committed = Arc::new(std::sync::atomic::AtomicU64::new(0));

    // register_stream をタスク本体より前に完了させるためのゲート
    // (run_query_stream / preview_query_stream と同じ理由。#685)。入力エラー等で
    // 即終了する import が register より先に forget_stream し、完了済みハンドルが
    // streams に残る競合を防ぐ。oneshot は register_stream が発行したトークンを
    // 運び、タスクはそれで自分の登録だけを forget_stream する — stream_id は
    // クライアント指定で再利用がありうるため、トークン照合なしだと「同じ id で
    // 登録された新しい import のエントリを、遅れて後始末した旧タスクが消して
    // しまう」競合が起こる (#state.rs の I4 対応)。
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel::<u64>();
    let stream_id_for_task = stream_id.clone();
    let committed_for_task = committed.clone();
    let handle = tokio::spawn(async move {
        let Ok(token) = ready_rx.await else {
            return;
        };
        spawn_import(
            app,
            session,
            stream_id_for_task,
            token,
            database,
            table,
            path,
            options,
            mapping,
            batch_size.unwrap_or(DEFAULT_BATCH_SIZE),
            create_table,
            committed_for_task,
        )
        .await;
    });
    let token = state
        .register_stream(
            stream_id,
            StreamHandle {
                abort: handle.abort_handle(),
                // Reports rows committed so far on cancel — meaningful only in
                // `skip` mode; `abort` mode rolls back and leaves this at 0.
                delivered_rows: committed,
                kind: StreamKind::Import,
                // #1096: Import ストリームは引き続き `app.emit()` の名前付き
                // イベント (`csv-import:cancelled`) 経由でキャンセルを通知する
                // (query/preview だけが Channel 経由の `on_cancel` を使う)。
                on_cancel: None,
            },
        )
        .await;
    // register_stream 完了後にタスク本体の実行を許可する。
    let _ = ready_tx.send(token);
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn spawn_import(
    app: AppHandle,
    session: Arc<Session>,
    stream_id: String,
    stream_token: u64,
    database: Option<String>,
    table: String,
    path: String,
    options: ImportOptions,
    mapping: Vec<ColumnMapping>,
    batch_size: usize,
    create_table: Option<Vec<NewColumn>>,
    committed: Arc<std::sync::atomic::AtomicU64>,
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
        &app,
        &session,
        &stream_id,
        database,
        table,
        path,
        options,
        mapping,
        batch_size,
        create_table,
        committed,
    )
    .await;

    // Query Result Cache (#1097): インポートはバルク書き込みなので、対象
    // テーブルの行が実際に増えていた場合 (skip モードの部分成功も含む) は
    // このセッションのクエリ結果キャッシュを丸ごと invalidate する。
    if let Ok(ImportRun::Ok { inserted, .. }) = &result {
        if *inserted > 0 {
            session.query_cache.invalidate_all().await;
        }
    }

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
        state.forget_stream(&stream_id, stream_token).await;
    }
}

/// Tauri 側のラッパー: `csv-import:*` イベントの emit を `run_import_core` へ
/// 渡すだけ。取り込みの本体 (パース → 新規テーブル作成 → `import_rows`) は
/// AppHandle 無しでも統合テストから駆動できるよう core に置く (#985)。
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
    create_table: Option<Vec<NewColumn>>,
    committed: Arc<std::sync::atomic::AtomicU64>,
) -> Result<ImportRun> {
    let started_app = app.clone();
    let started_id = stream_id.to_string();
    let on_started = move |total: u64| {
        if let Err(e) = started_app.emit(
            EV_IMPORT_STARTED,
            ImportStartedEvent {
                stream_id: started_id.clone(),
                total,
            },
        ) {
            tracing::warn!(stream_id = %started_id, error = %e, "failed to emit import started event");
        }
    };
    let progress_app = app.clone();
    let progress_id = stream_id.to_string();
    let on_progress = move |inserted: u64, total: u64| -> Result<()> {
        if let Err(e) = progress_app.emit(
            EV_IMPORT_PROGRESS,
            ImportProgressEvent {
                stream_id: progress_id.clone(),
                inserted,
                total,
            },
        ) {
            tracing::warn!(stream_id = %progress_id, error = %e, "failed to emit import progress event");
        }
        Ok(())
    };
    run_import_core(
        session,
        stream_id,
        database,
        table,
        path,
        options,
        mapping,
        batch_size,
        create_table,
        committed,
        on_started,
        on_progress,
    )
    .await
}

/// 新規テーブル作成 (#985) の定義を検証する。DDL を実際にレンダリングして
/// (= 実行時と同じ関数で) 名前・重複・長さ上限を確かめ、さらにマッピング先の
/// 列がすべて作成する列に含まれていることを確かめる。
fn validate_create_spec(
    driver: DriverKind,
    table: &str,
    columns: &[NewColumn],
    mapped: &[String],
) -> Result<()> {
    render_create_table(driver, table, columns)?;
    for m in mapped {
        if !columns.iter().any(|c| &c.name == m) {
            return Err(AppError::InvalidInput(format!(
                "mapped column {m} is not part of the new table definition"
            )));
        }
    }
    Ok(())
}

/// 取り込みの本体。ファイルを読んでパースし、`create_table` があれば新規
/// テーブルを作成してから、既存の `import_rows` / `import_rows_skipping`
/// 経路へ合流する (新しい書き込み経路は増やさない)。
///
/// 新規テーブルは**パース成功後**に作る (壊れたファイルで空テーブルだけが
/// 残らないように)。`abort` モードで取り込みが失敗したときは、作ったばかりの
/// テーブルをベストエフォートで DROP して「ファイル → テーブル」を
/// all-or-nothing に近づける (MySQL の DDL は暗黙コミットで同一トランザクションに
/// 入れられないため、DROP による後始末で揃える)。`skip` モードは良い行を
/// コミットする設計なので DROP しない。
#[allow(clippy::too_many_arguments)]
async fn run_import_core<S, P>(
    session: &Session,
    stream_id: &str,
    database: Option<String>,
    table: String,
    path: String,
    options: ImportOptions,
    mapping: Vec<ColumnMapping>,
    batch_size: usize,
    create_table: Option<Vec<NewColumn>>,
    committed: Arc<std::sync::atomic::AtomicU64>,
    on_started: S,
    mut on_progress: P,
) -> Result<ImportRun>
where
    S: FnOnce(u64),
    P: FnMut(u64, u64) -> Result<()>,
{
    let bytes = read_import_file(&path).await?;
    let text = decode_bytes(&bytes, &options.encoding);
    let columns: Vec<String> = mapping.iter().map(|m| m.column.clone()).collect();
    // `lines[i]` is record i's source file line (CSV only), used to report a bad
    // row by both record number and file line (#687).
    let (rows, lines) = parse_rows_with_lines(text.as_bytes(), &options, &mapping)?;
    let total = rows.len() as u64;
    let conflict = options.conflict();

    // 新規テーブル作成 (#985)。パース成功後に実行する。DDL は履歴にも残す
    // (インポート自体の要約とは別エントリ)。
    let created = match &create_table {
        Some(cols) => {
            create_table_for_import(session, database.as_deref(), &table, cols).await?;
            tracing::info!(
                session_id = %session.id,
                stream_id = %stream_id,
                table = %table,
                columns = cols.len(),
                "created table for import"
            );
            true
        }
        None => false,
    };

    tracing::info!(
        session_id = %session.id,
        stream_id = %stream_id,
        table = %table,
        total,
        error_mode = ?options.error_mode,
        conflict_mode = ?options.conflict_mode,
        key_columns = options.key_columns.len(),
        created_table = created,
        "csv import starting"
    );

    on_started(total);

    let started = Instant::now();
    match options.error_mode {
        ImportErrorMode::Skip => {
            // Resilient: skip rows the DB rejects, report them at the end. Each
            // chunk auto-commits, so publish the cumulative committed count into
            // the shared counter after every chunk — a cancel mid-import can
            // then report the rows that actually persisted.
            let progress = move |n: u64| -> Result<()> {
                committed.store(n, std::sync::atomic::Ordering::SeqCst);
                on_progress(n, total)
            };
            let outcome = session
                .conn
                .import_rows_skipping(
                    database.as_deref(),
                    &table,
                    &columns,
                    &rows,
                    batch_size,
                    &conflict,
                    progress,
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
                    &conflict,
                    |n| on_progress(n, total),
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
                        .probe_failing_row(database.as_deref(), &table, &columns, &rows, &conflict)
                        .await
                        .ok()
                        .flatten();
                    let (record, line) = match &located {
                        Some((idx, _)) => {
                            (Some(*idx as u64 + 1), lines.get(*idx).copied().flatten())
                        }
                        None => (None, None),
                    };
                    let mut message = match (record, line) {
                        (Some(r), Some(l)) => {
                            format!("{e} (failed at record {r}, line {l})")
                        }
                        (Some(r), None) => format!("{e} (failed at record {r})"),
                        _ => e.to_string(),
                    };
                    if created {
                        message.push_str(
                            &drop_created_table(session, database.as_deref(), &table).await,
                        );
                    }
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

/// 新規テーブルを作成し、DDL を履歴に残してキャッシュを捨てる (#985)。
/// 失敗した場合もレンダリング済み DDL をエラー付きで履歴に残す。
async fn create_table_for_import(
    session: &Session,
    database: Option<&str>,
    table: &str,
    columns: &[NewColumn],
) -> Result<()> {
    let started = Instant::now();
    match session
        .conn
        .create_table_from_columns(database, table, columns)
        .await
    {
        Ok(ddl) => {
            record_write_history(
                session,
                ddl,
                database,
                None,
                Some(started.elapsed().as_millis() as i64),
                None,
            )
            .await;
            // テーブルが増えたのでスキーマ / 結果キャッシュを捨てる。
            session.schema_cache.invalidate_all().await;
            session.query_cache.invalidate_all().await;
            Ok(())
        }
        Err(e) => {
            let ddl = render_create_table(session.conn.driver_kind(), table, columns)
                .unwrap_or_else(|_| format!("-- CREATE TABLE {table}"));
            record_write_history(session, ddl, database, None, None, Some(e.to_string())).await;
            Err(e)
        }
    }
}

/// abort モードの取り込み失敗時に、直前に作成したテーブルを DROP する (#985)。
/// 失敗してもインポートのエラー自体は返したいので、結果はメッセージの
/// 接尾辞として返す。
async fn drop_created_table(session: &Session, database: Option<&str>, table: &str) -> String {
    let sql = render_drop_table(session.conn.driver_kind(), table);
    match session.conn.execute(&sql, database).await {
        Ok(_) => {
            record_write_history(session, sql, database, None, None, None).await;
            session.schema_cache.invalidate_all().await;
            " (the newly created table was dropped)".to_string()
        }
        Err(drop_err) => {
            tracing::warn!(
                table = %table,
                error = %drop_err,
                "failed to drop the table created for a failed import"
            );
            format!(" (the newly created table could not be dropped: {drop_err})")
        }
    }
}

/// 統合テスト向けの入口 (#985): `import_csv` と同じ検証 (read_only ガード・
/// 新規テーブル定義の検証) を掛けてから、AppHandle 無しで `run_import_core`
/// を走らせる。成功なら `Ok(Ok(挿入行数))`、abort モードの行エラーは
/// `Ok(Err(メッセージ))`、セットアップ失敗は `Err`。
pub(crate) async fn import_file_for_test(
    session: &Session,
    database: Option<String>,
    table: String,
    path: String,
    options: ImportOptions,
    mapping: Vec<ColumnMapping>,
    create_table: Option<Vec<NewColumn>>,
) -> Result<std::result::Result<u64, String>> {
    ensure_import_writable(session)?;
    let mapped: Vec<String> = mapping.iter().map(|m| m.column.clone()).collect();
    options.conflict().validate(&mapped)?;
    if let Some(cols) = &create_table {
        validate_create_spec(session.conn.driver_kind(), &table, cols, &mapped)?;
    }
    let run = run_import_core(
        session,
        "test",
        database,
        table,
        path,
        options,
        mapping,
        DEFAULT_BATCH_SIZE,
        create_table,
        Arc::new(std::sync::atomic::AtomicU64::new(0)),
        |_| {},
        |_, _| Ok(()),
    )
    .await?;
    Ok(match run {
        ImportRun::Ok { inserted, .. } => Ok(inserted),
        ImportRun::Failed { message, .. } => Err(message),
    })
}

/// `preview_create_table_ddl` IPC: インポートモーダルが「実際に流れる DDL」を
/// 表示するため、実行時 (`create_table_from_columns`) と同じ
/// [`render_create_table`] を通す (#985)。書き込みを伴わないので read_only でも可。
#[tauri::command]
pub async fn preview_create_table_ddl(
    driver: DriverKind,
    table: String,
    columns: Vec<NewColumn>,
) -> Result<String> {
    render_create_table(driver, &table, &columns)
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
            conflict_mode: ConflictMode::Insert,
            key_columns: Vec::new(),
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
            conflict_mode: ConflictMode::Insert,
            key_columns: Vec::new(),
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
