use std::io::{BufWriter, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::commands::query::ensure_allowed_for_session;
use crate::db::is_read_only_sql;
use crate::db::types::{Column, StreamBatch, Value};
use crate::error::{AppError, Result};
use crate::state::AppState;

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    Csv,
    Json,
    /// NDJSON (改行区切り JSON、1 行 1 オブジェクト)。JSON 配列と違い先頭/末尾の
    /// 括弧・行間カンマを持たず、行単位で独立しているためストリーミング処理向き。
    Ndjson,
}

#[tauri::command]
pub async fn export_query_result(
    path: String,
    format: ExportFormat,
    columns: Vec<Column>,
    rows: Vec<Vec<Value>>,
) -> Result<u64> {
    if path.trim().is_empty() {
        return Err(AppError::InvalidInput("save path is empty".into()));
    }
    let row_count = rows.len();
    let result = write_export(path, format, columns, rows).await;
    match &result {
        Ok(bytes) => tracing::info!(
            format = ?format,
            rows = row_count,
            bytes = *bytes,
            "query result exported"
        ),
        Err(e) => tracing::error!(format = ?format, error = %e, "failed to export query result"),
    }
    result
}

/// Write the result set to `path`, streaming row-by-row into a buffered writer
/// instead of building the whole output in memory first. The CPU-bound
/// formatting and synchronous file I/O run on a blocking thread so the async
/// runtime worker is not held up by a large export. Returns the bytes written.
async fn write_export(
    path: String,
    format: ExportFormat,
    columns: Vec<Column>,
    rows: Vec<Vec<Value>>,
) -> Result<u64> {
    tokio::task::spawn_blocking(move || -> Result<u64> {
        let file = std::fs::File::create(&path)?;
        let mut writer = std::io::BufWriter::new(file);
        match format {
            ExportFormat::Csv => write_csv(&mut writer, &columns, &rows)?,
            ExportFormat::Json => write_json(&mut writer, &columns, &rows)?,
            ExportFormat::Ndjson => write_ndjson(&mut writer, &columns, &rows)?,
        }
        // `into_inner` flushes the buffer; surface any flush error as I/O.
        let file = writer
            .into_inner()
            .map_err(|e| AppError::Io(e.into_error()))?;
        let bytes = file.metadata()?.len();
        Ok(bytes)
    })
    .await
    .map_err(|e| AppError::Other(format!("export task failed: {e}")))?
}

fn csv_field(s: &str) -> String {
    let needs_quote = s.contains(',') || s.contains('"') || s.contains('\n') || s.contains('\r');
    if !needs_quote {
        return s.to_string();
    }
    let escaped = s.replace('"', "\"\"");
    format!("\"{}\"", escaped)
}

fn value_to_csv(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::Bool(b) => if *b { "true" } else { "false" }.to_string(),
        Value::Int(i) => i.to_string(),
        Value::UInt(u) => u.to_string(),
        Value::Float(f) => f.to_string(),
        Value::String(s) => csv_field(s),
        Value::Bytes(hex) => csv_field(&format!("0x{}", hex)),
    }
}

/// RFC4180-ish CSV with `\r\n` terminators, written one row at a time. A single
/// reused line buffer keeps allocations and `write` syscalls down (one write per
/// row); the `BufWriter` from the caller batches them further.
fn write_csv<W: Write>(w: &mut W, columns: &[Column], rows: &[Vec<Value>]) -> std::io::Result<()> {
    write_csv_header(w, columns)?;
    write_csv_rows(w, columns, rows)
}

/// Write just the CSV header line. Split out so the streaming export can
/// write the header on the columns event and rows on later batches.
fn write_csv_header<W: Write>(w: &mut W, columns: &[Column]) -> std::io::Result<()> {
    let mut line = String::new();
    for (i, col) in columns.iter().enumerate() {
        if i > 0 {
            line.push(',');
        }
        line.push_str(&csv_field(&col.name));
    }
    line.push_str("\r\n");
    w.write_all(line.as_bytes())
}

/// Write a batch of CSV data rows (no header).
fn write_csv_rows<W: Write>(
    w: &mut W,
    columns: &[Column],
    rows: &[Vec<Value>],
) -> std::io::Result<()> {
    let mut line = String::new();
    for row in rows {
        line.clear();
        for i in 0..columns.len() {
            if i > 0 {
                line.push(',');
            }
            line.push_str(&value_to_csv(row.get(i).unwrap_or(&Value::Null)));
        }
        line.push_str("\r\n");
        w.write_all(line.as_bytes())?;
    }
    Ok(())
}

/// Build a JSON object for one row, keyed by column name. Shared by the
/// in-memory `write_json` and the streaming export sink.
fn row_to_json_object(columns: &[Column], row: &[Value]) -> serde_json::Value {
    use serde_json::{Map, Value as J};
    let mut obj = Map::with_capacity(columns.len());
    for (i, col) in columns.iter().enumerate() {
        let jv = match row.get(i).unwrap_or(&Value::Null) {
            Value::Bytes(hex) => J::String(format!("0x{}", hex)),
            v => serde_json::to_value(v).unwrap_or(J::Null),
        };
        obj.insert(col.name.clone(), jv);
    }
    J::Object(obj)
}

/// Pretty JSON array of row objects, serialized directly to the writer. Each row
/// object is built and serialized individually via `SerializeSeq`, so the full
/// `Vec`-of-objects tree is never materialized. The output is byte-identical to
/// `serde_json::to_vec_pretty` of the equivalent array (serde drives a `Vec`
/// through the same `serialize_seq`/`serialize_element` path).
fn write_json<W: Write>(w: &mut W, columns: &[Column], rows: &[Vec<Value>]) -> Result<()> {
    use serde::ser::{SerializeSeq, Serializer};

    let mut ser = serde_json::Serializer::pretty(w);
    let mut seq = ser.serialize_seq(Some(rows.len()))?;
    for row in rows {
        seq.serialize_element(&row_to_json_object(columns, row))?;
    }
    seq.end()?;
    Ok(())
}

/// NDJSON (改行区切り JSON): 各行を 1 つの JSON オブジェクトとして 1 行ずつ書き、
/// 各行を `\n` で終端する。JSON 配列のような先頭/末尾の括弧・行間カンマは無い。
/// 値のエンコード (BLOB の 16 進・NULL・数値) は `write_json` と共有する
/// `row_to_json_object` を使うため JSON 配列経路と一致する。空結果なら何も書かない。
fn write_ndjson<W: Write>(w: &mut W, columns: &[Column], rows: &[Vec<Value>]) -> Result<()> {
    for row in rows {
        let obj = row_to_json_object(columns, row);
        let s = serde_json::to_string(&obj)?;
        w.write_all(s.as_bytes())?;
        w.write_all(b"\n")?;
    }
    Ok(())
}

// ── 全件ストリーミングエクスポート ──
//
// 在メモリ行に依存せず、クエリをバックエンドで再実行してストリーミングで直接ファイルへ
// 書き出す。run_query_stream と同じ枠組み (execute_stream + register/forget_stream +
// stream_id イベント) に乗せ、自動 LIMIT は付与しない (全件)。SELECT 系のみ許可する。

const EV_EXPORT_PROGRESS: &str = "export-stream:progress";
const EV_EXPORT_DONE: &str = "export-stream:done";
const EV_EXPORT_ERROR: &str = "export-stream:error";

#[derive(Serialize, Clone)]
struct ExportProgressEvent {
    #[serde(rename = "streamId")]
    stream_id: String,
    rows: u64,
}

#[derive(Serialize, Clone)]
struct ExportDoneEvent {
    #[serde(rename = "streamId")]
    stream_id: String,
    rows: u64,
    bytes: u64,
}

#[derive(Serialize, Clone)]
struct ExportErrorEvent {
    #[serde(rename = "streamId")]
    stream_id: String,
    message: String,
}

/// Incremental file writer for the streaming export. Writes the header (CSV) or
/// opening bracket (JSON) on the columns event, then row batches, and closes the
/// JSON array on `finish`.
struct StreamExportSink {
    writer: BufWriter<std::fs::File>,
    format: ExportFormat,
    columns: Vec<Column>,
    json_count: usize,
}

impl StreamExportSink {
    fn new(path: &str, format: ExportFormat) -> Result<Self> {
        let file = std::fs::File::create(path)?;
        Ok(Self {
            writer: BufWriter::new(file),
            format,
            columns: Vec::new(),
            json_count: 0,
        })
    }

    fn on_columns(&mut self, columns: Vec<Column>) -> Result<()> {
        self.columns = columns;
        match self.format {
            ExportFormat::Csv => write_csv_header(&mut self.writer, &self.columns)?,
            ExportFormat::Json => self.writer.write_all(b"[")?,
            // NDJSON にはヘッダも開き括弧も無いので columns イベントでは何も書かない。
            ExportFormat::Ndjson => {}
        }
        Ok(())
    }

    fn on_rows(&mut self, rows: &[Vec<Value>]) -> Result<usize> {
        match self.format {
            ExportFormat::Csv => write_csv_rows(&mut self.writer, &self.columns, rows)?,
            ExportFormat::Json => {
                for row in rows {
                    self.writer.write_all(if self.json_count == 0 {
                        b"\n  "
                    } else {
                        b",\n  "
                    })?;
                    let obj = row_to_json_object(&self.columns, row);
                    let s = serde_json::to_string(&obj)?;
                    self.writer.write_all(s.as_bytes())?;
                    self.json_count += 1;
                }
            }
            // 1 行 1 オブジェクト + `\n`。in-memory の write_ndjson と同じ書式。
            ExportFormat::Ndjson => write_ndjson(&mut self.writer, &self.columns, rows)?,
        }
        Ok(rows.len())
    }

    fn finish(mut self) -> Result<u64> {
        if let ExportFormat::Json = self.format {
            // Close the array. `[` was written on the columns event; for an empty
            // result that yields `[]`, otherwise `[ ... \n]`.
            self.writer
                .write_all(if self.json_count == 0 { b"]" } else { b"\n]" })?;
        }
        // NDJSON は行ごとに完結しており、終端処理は不要 (各行末の `\n` のみ)。
        let file = self
            .writer
            .into_inner()
            .map_err(|e| AppError::Io(e.into_error()))?;
        Ok(file.metadata()?.len())
    }
}

/// Re-run `sql` and stream the full result set to `path`. Progress is
/// reported via `export-stream:*` events keyed by `stream_id`; `cancel_stream`
/// aborts it and returns the connection to the pool. Only read-only (SELECT)
/// statements are accepted, so an export can never mutate data.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn export_query_stream(
    app: AppHandle,
    session_id: String,
    stream_id: String,
    sql: String,
    database: Option<String>,
    format: ExportFormat,
    path: String,
    initial_batch: usize,
    chunk_size: usize,
    query_timeout_secs: Option<u64>,
    state: State<'_, AppState>,
) -> Result<()> {
    if path.trim().is_empty() {
        return Err(AppError::InvalidInput("save path is empty".into()));
    }
    let session = state
        .get(&session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;
    // Read-only sessions reject non-SELECT outright; and even writable sessions
    // may only export read-only statements (an export must never mutate).
    ensure_allowed_for_session(&session, &sql)?;
    if !is_read_only_sql(&sql) {
        return Err(AppError::ReadOnly(
            "export supports only read-only statements (SELECT / SHOW / DESCRIBE / EXPLAIN / WITH)"
                .into(),
        ));
    }

    // Create the file up front so a bad path surfaces synchronously to the caller.
    let sink = StreamExportSink::new(&path, format)?;
    let shared = Arc::new(Mutex::new(Some(sink)));

    let handle = tokio::spawn(spawn_export_stream(
        app,
        session,
        stream_id.clone(),
        sql,
        database,
        path,
        initial_batch,
        chunk_size,
        query_timeout_secs,
        shared,
    ));
    state
        .register_stream(stream_id, handle.abort_handle())
        .await;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn spawn_export_stream(
    app: AppHandle,
    session: Arc<crate::state::Session>,
    stream_id: String,
    sql: String,
    database: Option<String>,
    path: String,
    initial_batch: usize,
    chunk_size: usize,
    query_timeout_secs: Option<u64>,
    shared: Arc<Mutex<Option<StreamExportSink>>>,
) {
    let counter = Arc::new(AtomicU64::new(0));
    let emit_app = app.clone();
    let emit_id = stream_id.clone();
    let sink_cb = shared.clone();
    let counter_cb = counter.clone();

    let exec = session.conn.execute_stream(
        &sql,
        database.as_deref(),
        initial_batch,
        chunk_size,
        move |batch| {
            let mut guard = sink_cb
                .lock()
                .map_err(|_| AppError::Other("export sink lock poisoned".into()))?;
            let sink = guard
                .as_mut()
                .ok_or_else(|| AppError::Other("export sink already finished".into()))?;
            match batch {
                StreamBatch::Columns(columns) => sink.on_columns(columns)?,
                StreamBatch::Rows(rows) => {
                    let n = sink.on_rows(&rows)?;
                    let total = counter_cb.fetch_add(n as u64, Ordering::SeqCst) + n as u64;
                    // Progress is best-effort; a failed emit shouldn't abort the export.
                    let _ = emit_app.emit(
                        EV_EXPORT_PROGRESS,
                        ExportProgressEvent {
                            stream_id: emit_id.clone(),
                            rows: total,
                        },
                    );
                }
            }
            Ok(())
        },
    );

    let result = match query_timeout_secs {
        Some(secs) if secs > 0 => {
            match tokio::time::timeout(std::time::Duration::from_secs(secs), exec).await {
                Ok(res) => res,
                Err(_) => Err(AppError::Timeout(secs)),
            }
        }
        _ => exec.await,
    };

    match result {
        Ok(_) => {
            let sink = shared.lock().ok().and_then(|mut g| g.take());
            match sink.map(|s| s.finish()) {
                Some(Ok(bytes)) => {
                    let rows = counter.load(Ordering::SeqCst);
                    tracing::info!(stream_id = %stream_id, rows, bytes, "streaming export complete");
                    let _ = app.emit(
                        EV_EXPORT_DONE,
                        ExportDoneEvent {
                            stream_id: stream_id.clone(),
                            rows,
                            bytes,
                        },
                    );
                }
                Some(Err(e)) => {
                    let _ = std::fs::remove_file(&path);
                    let _ = app.emit(
                        EV_EXPORT_ERROR,
                        ExportErrorEvent {
                            stream_id: stream_id.clone(),
                            message: e.to_string(),
                        },
                    );
                }
                None => {}
            }
        }
        Err(e) => {
            // Drop the sink and remove the partial file so a cancelled/failed
            // export doesn't leave a truncated artifact behind.
            if let Ok(mut g) = shared.lock() {
                g.take();
            }
            let _ = std::fs::remove_file(&path);
            let _ = app.emit(
                EV_EXPORT_ERROR,
                ExportErrorEvent {
                    stream_id: stream_id.clone(),
                    message: e.to_string(),
                },
            );
        }
    }

    if let Some(state) = app.try_state::<AppState>() {
        state.forget_stream(&stream_id).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn col(name: &str) -> Column {
        Column {
            name: name.into(),
            type_name: "VARCHAR".into(),
        }
    }

    fn csv_bytes(columns: &[Column], rows: &[Vec<Value>]) -> Vec<u8> {
        let mut buf = Vec::new();
        write_csv(&mut buf, columns, rows).unwrap();
        buf
    }

    fn json_bytes(columns: &[Column], rows: &[Vec<Value>]) -> Vec<u8> {
        let mut buf = Vec::new();
        write_json(&mut buf, columns, rows).unwrap();
        buf
    }

    fn ndjson_bytes(columns: &[Column], rows: &[Vec<Value>]) -> Vec<u8> {
        let mut buf = Vec::new();
        write_ndjson(&mut buf, columns, rows).unwrap();
        buf
    }

    #[test]
    fn csv_escapes_special_chars() {
        let columns = vec![col("id"), col("name"), col("note")];
        let rows = vec![
            vec![
                Value::Int(1),
                Value::String("Alice".into()),
                Value::String("ok".into()),
            ],
            vec![
                Value::Int(2),
                Value::String("Bob, the \"Builder\"".into()),
                Value::String("multi\nline".into()),
            ],
            vec![Value::Int(3), Value::Null, Value::Bool(true)],
        ];
        let out = String::from_utf8(csv_bytes(&columns, &rows)).unwrap();
        let expected = "id,name,note\r\n\
                        1,Alice,ok\r\n\
                        2,\"Bob, the \"\"Builder\"\"\",\"multi\nline\"\r\n\
                        3,,true\r\n";
        assert_eq!(out, expected);
    }

    #[test]
    fn json_uses_column_names_and_handles_bytes() {
        let columns = vec![col("id"), col("blob")];
        let rows = vec![
            vec![Value::Int(7), Value::Bytes("deadbeef".into())],
            vec![Value::Null, Value::Null],
        ];
        let out = json_bytes(&columns, &rows);
        let parsed: serde_json::Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(parsed[0]["id"], serde_json::json!(7));
        assert_eq!(parsed[0]["blob"], serde_json::json!("0xdeadbeef"));
        assert_eq!(parsed[1]["id"], serde_json::Value::Null);
        assert_eq!(parsed[1]["blob"], serde_json::Value::Null);
    }

    // Streaming serialization must stay byte-identical to
    // "build the whole array then to_vec_pretty" output.
    #[test]
    fn json_matches_to_vec_pretty() {
        use serde_json::{Map, Value as J};
        let columns = vec![col("id"), col("name"), col("blob")];
        let rows = vec![
            vec![
                Value::Int(1),
                Value::String("Alice".into()),
                Value::Bytes("00ff".into()),
            ],
            vec![Value::Null, Value::String("x\"y".into()), Value::Null],
        ];

        // Reference: the old in-memory construction.
        let mut arr: Vec<J> = Vec::with_capacity(rows.len());
        for row in &rows {
            let mut obj = Map::with_capacity(columns.len());
            for (i, c) in columns.iter().enumerate() {
                let v = row.get(i).cloned().unwrap_or(Value::Null);
                let jv = match v {
                    Value::Bytes(ref hex) => J::String(format!("0x{}", hex)),
                    _ => serde_json::to_value(&v).unwrap_or(J::Null),
                };
                obj.insert(c.name.clone(), jv);
            }
            arr.push(J::Object(obj));
        }
        let reference = serde_json::to_vec_pretty(&arr).unwrap();

        assert_eq!(json_bytes(&columns, &rows), reference);
    }

    #[test]
    fn stream_sink_csv_writes_header_then_rows() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("noobdb_export_csv_{}.csv", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let columns = vec![col("id"), col("name")];
        let mut sink = StreamExportSink::new(path.to_str().unwrap(), ExportFormat::Csv).unwrap();
        sink.on_columns(columns.clone()).unwrap();
        sink.on_rows(&[vec![Value::Int(1), Value::String("a".into())]])
            .unwrap();
        sink.on_rows(&[vec![Value::Int(2), Value::String("b, c".into())]])
            .unwrap();
        let bytes = sink.finish().unwrap();
        let out = std::fs::read_to_string(&path).unwrap();
        assert_eq!(out, "id,name\r\n1,a\r\n2,\"b, c\"\r\n");
        assert_eq!(bytes as usize, out.len());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn stream_sink_json_is_valid_array() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("noobdb_export_json_{}.json", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let columns = vec![col("id"), col("blob")];
        let mut sink = StreamExportSink::new(path.to_str().unwrap(), ExportFormat::Json).unwrap();
        sink.on_columns(columns.clone()).unwrap();
        sink.on_rows(&[
            vec![Value::Int(7), Value::Bytes("deadbeef".into())],
            vec![Value::Null, Value::Null],
        ])
        .unwrap();
        sink.finish().unwrap();
        let parsed: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(parsed.as_array().unwrap().len(), 2);
        assert_eq!(parsed[0]["id"], serde_json::json!(7));
        assert_eq!(parsed[0]["blob"], serde_json::json!("0xdeadbeef"));
        assert_eq!(parsed[1]["id"], serde_json::Value::Null);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn stream_sink_json_empty_is_empty_array() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("noobdb_export_jsone_{}.json", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let mut sink = StreamExportSink::new(path.to_str().unwrap(), ExportFormat::Json).unwrap();
        sink.on_columns(vec![col("id")]).unwrap();
        sink.finish().unwrap();
        let out = std::fs::read_to_string(&path).unwrap();
        assert_eq!(out, "[]");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn json_empty_rows_is_empty_array() {
        let columns = vec![col("id")];
        let rows: Vec<Vec<Value>> = vec![];
        let reference = serde_json::to_vec_pretty(&Vec::<serde_json::Value>::new()).unwrap();
        assert_eq!(json_bytes(&columns, &rows), reference);
    }

    // NDJSON: 1 行 1 オブジェクトで `\n` 区切り。先頭/末尾の括弧・行間カンマは無く、
    // 各行は独立した JSON としてパースできる。値エンコードは JSON 配列経路と一致する。
    #[test]
    fn ndjson_writes_one_object_per_line() {
        let columns = vec![col("id"), col("name"), col("blob")];
        let rows = vec![
            vec![
                Value::Int(1),
                Value::String("Alice".into()),
                Value::Bytes("00ff".into()),
            ],
            vec![Value::Null, Value::String("x\"y".into()), Value::Null],
        ];
        let out = String::from_utf8(ndjson_bytes(&columns, &rows)).unwrap();
        // 末尾の改行を含め 2 行 + 空末尾。括弧・カンマで囲まれていないこと。
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines.len(), 2);
        assert!(out.ends_with('\n'));
        assert!(!out.starts_with('['));
        // 各行が独立した JSON オブジェクトとしてパースでき、JSON 配列経路と同じ
        // 値エンコード (BLOB の 16 進・NULL) になっていること。
        let r0: serde_json::Value = serde_json::from_str(lines[0]).unwrap();
        let r1: serde_json::Value = serde_json::from_str(lines[1]).unwrap();
        assert_eq!(r0["id"], serde_json::json!(1));
        assert_eq!(r0["name"], serde_json::json!("Alice"));
        assert_eq!(r0["blob"], serde_json::json!("0x00ff"));
        assert_eq!(r1["id"], serde_json::Value::Null);
        assert_eq!(r1["name"], serde_json::json!("x\"y"));
        assert_eq!(r1["blob"], serde_json::Value::Null);
    }

    #[test]
    fn ndjson_empty_rows_is_empty_output() {
        let columns = vec![col("id")];
        let rows: Vec<Vec<Value>> = vec![];
        assert!(ndjson_bytes(&columns, &rows).is_empty());
    }

    #[test]
    fn stream_sink_ndjson_matches_in_memory() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!(
            "noobdb_export_ndjson_{}.ndjson",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        let columns = vec![col("id"), col("blob")];
        let rows = vec![
            vec![Value::Int(7), Value::Bytes("deadbeef".into())],
            vec![Value::Null, Value::Null],
        ];
        let mut sink = StreamExportSink::new(path.to_str().unwrap(), ExportFormat::Ndjson).unwrap();
        sink.on_columns(columns.clone()).unwrap();
        // バッチを分けても in-memory の一括書き出しと同じバイト列になること。
        sink.on_rows(&rows[0..1]).unwrap();
        sink.on_rows(&rows[1..2]).unwrap();
        sink.finish().unwrap();
        let out = std::fs::read(&path).unwrap();
        assert_eq!(out, ndjson_bytes(&columns, &rows));
        let _ = std::fs::remove_file(&path);
    }
}
