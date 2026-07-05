use std::io::{BufWriter, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::commands::query::ensure_allowed_for_session;
use crate::db::data_diff::sql_literal;
use crate::db::sync::quote_ident;
use crate::db::types::{Column, StreamBatch, Value};
use crate::db::{is_read_only_sql, DriverKind};
use crate::error::{AppError, Result};
use crate::state::{AppState, StreamHandle, StreamKind};

/// SQL INSERT 形式で出力するときの対象テーブル名が空のときに使うプレースホルダ。
/// JOIN など結果元テーブルが特定できないケースでも有効な SQL になるようにする。
/// フロントの `exportPreview.ts` も同じ既定を使ってプレビューをミラーする。
const DEFAULT_SQL_TABLE: &str = "exported_table";

/// 1 つの `INSERT` 文へまとめる行数の既定上限。`batch_size` が未指定/0 のときに使う。
const DEFAULT_SQL_BATCH: usize = 100;

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    Csv,
    Json,
    /// NDJSON (改行区切り JSON、1 行 1 オブジェクト)。JSON 配列と違い先頭/末尾の
    /// 括弧・行間カンマを持たず、行単位で独立しているためストリーミング処理向き。
    Ndjson,
    /// Markdown テーブル (GFM)。ヘッダ行 + 区切り行 + データ行。GitHub の Issue/PR や
    /// ドキュメントにそのまま貼れる。セル内のパイプ `|` と改行はエスケープする。
    Markdown,
    /// SQL INSERT 文。対象テーブルと列を指定し、ドライバ別リテラルエスケープで
    /// `INSERT INTO ... VALUES (...), (...);` を生成する。複数行はバッチサイズ単位で
    /// 1 文へまとめる。
    Sql,
}

/// SQL INSERT 形式の出力に必要なパラメータ (対象テーブル・ドライバ・バッチサイズ)。
/// CSV/JSON/NDJSON/Markdown では使われない。
#[derive(Debug, Clone)]
struct SqlExportOpts {
    driver: DriverKind,
    table: String,
    batch_size: usize,
}

impl SqlExportOpts {
    /// コマンド引数から SQL 出力用パラメータを組み立てる。空テーブル名は
    /// `DEFAULT_SQL_TABLE`、0/未指定のバッチは `DEFAULT_SQL_BATCH` にフォールバックする。
    fn build(driver: Option<DriverKind>, table: Option<String>, batch_size: Option<usize>) -> Self {
        let table = table
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())
            .unwrap_or_else(|| DEFAULT_SQL_TABLE.to_string());
        let batch_size = batch_size.filter(|n| *n > 0).unwrap_or(DEFAULT_SQL_BATCH);
        Self {
            // ドライバ未指定 (在グリッドで取得できない等) は MySQL 方言にフォールバック。
            driver: driver.unwrap_or(DriverKind::Mysql),
            table,
            batch_size,
        }
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn export_query_result(
    path: String,
    format: ExportFormat,
    columns: Vec<Column>,
    rows: Vec<Vec<Value>>,
    // JSON 形式のとき出力に同梱する実行クエリ。None / 空なら同梱しない。
    // CSV / NDJSON / Markdown / SQL では無視する。
    query: Option<String>,
    // SQL INSERT 形式のときの対象テーブル名・ドライバ・バッチサイズ。他形式では無視。
    table: Option<String>,
    driver: Option<DriverKind>,
    batch_size: Option<usize>,
) -> Result<u64> {
    if path.trim().is_empty() {
        return Err(AppError::InvalidInput("save path is empty".into()));
    }
    let row_count = rows.len();
    let sql_opts = SqlExportOpts::build(driver, table, batch_size);
    let result = write_export(path, format, columns, rows, query, sql_opts).await;
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
    query: Option<String>,
    sql_opts: SqlExportOpts,
) -> Result<u64> {
    tokio::task::spawn_blocking(move || -> Result<u64> {
        let file = std::fs::File::create(&path)?;
        let mut writer = std::io::BufWriter::new(file);
        match format {
            ExportFormat::Csv => write_csv(&mut writer, &columns, &rows)?,
            ExportFormat::Json => write_json(&mut writer, &columns, &rows, query.as_deref())?,
            ExportFormat::Ndjson => write_ndjson(&mut writer, &columns, &rows)?,
            ExportFormat::Markdown => write_markdown(&mut writer, &columns, &rows)?,
            ExportFormat::Sql => write_sql_insert(&mut writer, &columns, &rows, &sql_opts)?,
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

/// CSV インジェクション (Excel/LibreOffice などでセルが数式として評価されてしまう
/// 問題) の緩和。セル値の先頭がこれらの文字だと開いたアプリで数式として実行されうる
/// (例: `=HYPERLINK(...)`)。ただし `-5`・`+3.2` のような符号付き数値まで壊さないよう、
/// 値全体が数値としてパース可能な場合は前置しない (`=`/`@` は数値の先頭に来ないため
/// 誤検出しないが、`+`/`-` は符号付き数値と衝突するのでここで除外する)。
const CSV_FORMULA_TRIGGERS: [char; 6] = ['=', '+', '-', '@', '\t', '\r'];

/// 数式トリガ文字で始まり、かつ数値としてパースできない値の先頭にシングルクオート
/// `'` を前置して文字列として固定する。Excel/LibreOffice はセル先頭の `'` を
/// リテラル文字列マーカーとして扱うため表示上は無害化される。
fn mitigate_formula_injection(s: &str) -> String {
    match s.chars().next() {
        Some(c) if CSV_FORMULA_TRIGGERS.contains(&c) && s.trim().parse::<f64>().is_err() => {
            format!("'{s}")
        }
        _ => s.to_string(),
    }
}

fn csv_field(s: &str) -> String {
    let mitigated = mitigate_formula_injection(s);
    let needs_quote = mitigated.contains(',')
        || mitigated.contains('"')
        || mitigated.contains('\n')
        || mitigated.contains('\r');
    if !needs_quote {
        return mitigated;
    }
    let escaped = mitigated.replace('"', "\"\"");
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

/// Pretty JSON of the result set, serialized directly to the writer.
///
/// When `query` is `None`/empty the output is a top-level array of row objects,
/// built and serialized one element at a time via `SerializeSeq` so the full
/// `Vec`-of-objects tree is never materialized. The output is byte-identical to
/// `serde_json::to_vec_pretty` of the equivalent array.
///
/// When `query` is `Some(non-empty)` the output is wrapped as
/// `{ "query": <sql>, "rows": [ ... ] }` so the executed query travels with the
/// data (JSON 形式のみの追加機能)。キーは serde_json 既定の `BTreeMap` 出力に従い
/// アルファベット順 (`query` → `rows`) になる。
fn write_json<W: Write>(
    w: &mut W,
    columns: &[Column],
    rows: &[Vec<Value>],
    query: Option<&str>,
) -> Result<()> {
    use serde::ser::{SerializeSeq, Serializer};

    if let Some(q) = query.filter(|q| !q.is_empty()) {
        // 行オブジェクトを材料化してラッパオブジェクトとして整形出力する。
        // 在グリッドのエクスポートは既に全行をメモリに持つため材料化で問題ない。
        let rows_json: Vec<serde_json::Value> = rows
            .iter()
            .map(|row| row_to_json_object(columns, row))
            .collect();
        let wrapper = serde_json::json!({ "query": q, "rows": rows_json });
        serde_json::to_writer_pretty(w, &wrapper)?;
        return Ok(());
    }

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

// ── Markdown テーブル ──

/// Markdown テーブルのセル文字列をエスケープする。GFM ではセル区切りの `|` を
/// `\|` でエスケープし、セル内改行はテーブルを壊すため `<br>` に置換する。まず
/// バックスラッシュ `\` を `\\` に置換する (これを最初にしないと、後段で `|` を `\|`
/// にしたときに既存の `\` が誤って区切りをエスケープしてしまう)。フロントの
/// `exportPreview.ts` の `mdEscape` と完全に一致させる。
fn md_escape(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('|', "\\|")
        .replace('\r', "")
        .replace('\n', "<br>")
}

fn value_to_markdown(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::Bool(b) => if *b { "true" } else { "false" }.to_string(),
        Value::Int(i) => i.to_string(),
        Value::UInt(u) => u.to_string(),
        Value::Float(f) => f.to_string(),
        Value::String(s) => md_escape(s),
        Value::Bytes(hex) => md_escape(&format!("0x{}", hex)),
    }
}

/// GFM テーブル: ヘッダ行 + 区切り行 (`| --- | ... |`) + データ行。各セルは
/// 前後にスペースを 1 つ置き、`|` を区切りとする。空結果でもヘッダ + 区切りは出力する
/// (列構造が分かるように)。
fn write_markdown<W: Write>(w: &mut W, columns: &[Column], rows: &[Vec<Value>]) -> Result<()> {
    write_markdown_header(w, columns)?;
    write_markdown_rows(w, columns, rows)
}

/// ヘッダ行と区切り行だけを書く。ストリーミング経路が columns イベントで使う。
fn write_markdown_header<W: Write>(w: &mut W, columns: &[Column]) -> Result<()> {
    let mut line = String::from("|");
    for col in columns {
        line.push(' ');
        line.push_str(&md_escape(&col.name));
        line.push_str(" |");
    }
    line.push('\n');
    // 区切り行は列ごとに `---`。
    line.push('|');
    for _ in columns {
        line.push_str(" --- |");
    }
    line.push('\n');
    w.write_all(line.as_bytes())?;
    Ok(())
}

/// データ行のみ書く (ヘッダ無し)。ストリーミングのバッチ書き出しで使う。
fn write_markdown_rows<W: Write>(w: &mut W, columns: &[Column], rows: &[Vec<Value>]) -> Result<()> {
    let mut line = String::new();
    for row in rows {
        line.clear();
        line.push('|');
        for i in 0..columns.len() {
            line.push(' ');
            line.push_str(&value_to_markdown(row.get(i).unwrap_or(&Value::Null)));
            line.push_str(" |");
        }
        line.push('\n');
        w.write_all(line.as_bytes())?;
    }
    Ok(())
}

// ── SQL INSERT 文 ──

/// 列名リスト `(c1, c2, ...)` をドライバ別の識別子クオートで生成する。
fn sql_columns_clause(driver: DriverKind, columns: &[Column]) -> String {
    columns
        .iter()
        .map(|c| quote_ident(driver, &c.name))
        .collect::<Vec<_>>()
        .join(", ")
}

/// 1 行を `(v1, v2, ...)` の VALUES タプルへ変換する。リテラルエスケープは
/// `data_diff::sql_literal` を共有 (ドライバ別の文字列/BLOB/真偽値エスケープ)。
fn sql_values_tuple(driver: DriverKind, columns: &[Column], row: &[Value]) -> String {
    let vals = (0..columns.len())
        .map(|i| sql_literal(driver, row.get(i).unwrap_or(&Value::Null)))
        .collect::<Vec<_>>()
        .join(", ");
    format!("({})", vals)
}

/// SQL INSERT 文を書き出す。`batch_size` 行ごとに 1 文へまとめ、各文は
/// `INSERT INTO <table> (cols) VALUES\n  (...),\n  (...);` の形にする。空結果なら
/// 何も書かない。ストリーミング経路でも同じ関数でバッチ単位の自己完結した文を書く。
fn write_sql_insert<W: Write>(
    w: &mut W,
    columns: &[Column],
    rows: &[Vec<Value>],
    opts: &SqlExportOpts,
) -> Result<()> {
    if columns.is_empty() || rows.is_empty() {
        return Ok(());
    }
    let table = quote_ident(opts.driver, &opts.table);
    let cols = sql_columns_clause(opts.driver, columns);
    for chunk in rows.chunks(opts.batch_size.max(1)) {
        let mut stmt = format!("INSERT INTO {} ({}) VALUES\n", table, cols);
        for (i, row) in chunk.iter().enumerate() {
            if i > 0 {
                stmt.push_str(",\n");
            }
            stmt.push_str("  ");
            stmt.push_str(&sql_values_tuple(opts.driver, columns, row));
        }
        stmt.push_str(";\n");
        w.write_all(stmt.as_bytes())?;
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
    /// Rows already written to the output file before the run failed.
    /// Informational only — a failed/cancelled export always deletes its
    /// partial output file (see [`PartialFileCleanup`]), but the UI can still
    /// use this to explain how far the run got (#685).
    rows: u64,
}

/// Incremental file writer for the streaming export. Writes the header (CSV) or
/// opening bracket (JSON) on the columns event, then row batches, and closes the
/// JSON array on `finish`.
struct StreamExportSink {
    writer: BufWriter<std::fs::File>,
    format: ExportFormat,
    columns: Vec<Column>,
    json_count: usize,
    /// JSON 形式のとき出力に同梱する実行クエリ。`Some(non-empty)` のときは配列
    /// ではなく `{ "query": ..., "rows": [...] }` でラップする。
    json_query: Option<String>,
    /// SQL INSERT 形式のときの対象テーブル・ドライバ・バッチサイズ。他形式では未使用。
    sql_opts: SqlExportOpts,
}

impl StreamExportSink {
    fn with_query(
        path: &str,
        format: ExportFormat,
        query: Option<String>,
        sql_opts: SqlExportOpts,
    ) -> Result<Self> {
        let file = std::fs::File::create(path)?;
        // クエリ同梱は JSON 形式のみ。空文字列は同梱しない。
        let json_query = match format {
            ExportFormat::Json => query.filter(|q| !q.is_empty()),
            _ => None,
        };
        Ok(Self {
            writer: BufWriter::new(file),
            format,
            columns: Vec::new(),
            json_count: 0,
            json_query,
            sql_opts,
        })
    }

    fn on_columns(&mut self, columns: Vec<Column>) -> Result<()> {
        self.columns = columns;
        match self.format {
            ExportFormat::Csv => write_csv_header(&mut self.writer, &self.columns)?,
            ExportFormat::Json => {
                if let Some(q) = &self.json_query {
                    // `{ "query": <sql>, "rows": [` まで書き、行は後続バッチで足す。
                    let q_str = serde_json::to_string(q)?;
                    self.writer.write_all(b"{\n  \"query\": ")?;
                    self.writer.write_all(q_str.as_bytes())?;
                    self.writer.write_all(b",\n  \"rows\": [")?;
                } else {
                    self.writer.write_all(b"[")?;
                }
            }
            // Markdown はヘッダ + 区切り行を columns イベントで書く。
            ExportFormat::Markdown => write_markdown_header(&mut self.writer, &self.columns)?,
            // NDJSON / SQL にはヘッダも開き括弧も無いので columns イベントでは何も書かない
            // (SQL は各バッチで自己完結した INSERT 文を書く)。
            ExportFormat::Ndjson | ExportFormat::Sql => {}
        }
        Ok(())
    }

    fn on_rows(&mut self, rows: &[Vec<Value>]) -> Result<usize> {
        match self.format {
            ExportFormat::Csv => write_csv_rows(&mut self.writer, &self.columns, rows)?,
            ExportFormat::Markdown => write_markdown_rows(&mut self.writer, &self.columns, rows)?,
            // SQL は各 on_rows でバッチサイズ単位の自己完結した INSERT 文を書く。
            ExportFormat::Sql => {
                write_sql_insert(&mut self.writer, &self.columns, rows, &self.sql_opts)?
            }
            ExportFormat::Json => {
                // クエリ同梱時は rows が 1 段深いので字下げを増やす。
                let (first, rest): (&[u8], &[u8]) = if self.json_query.is_some() {
                    (b"\n    ", b",\n    ")
                } else {
                    (b"\n  ", b",\n  ")
                };
                for row in rows {
                    self.writer
                        .write_all(if self.json_count == 0 { first } else { rest })?;
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
            if self.json_query.is_some() {
                // rows 配列を閉じてラッパオブジェクトも閉じる。
                self.writer.write_all(if self.json_count == 0 {
                    b"]\n}"
                } else {
                    b"\n  ]\n}"
                })?;
            } else {
                // Close the array. `[` was written on the columns event; for an empty
                // result that yields `[]`, otherwise `[ ... \n]`.
                self.writer
                    .write_all(if self.json_count == 0 { b"]" } else { b"\n]" })?;
            }
        }
        // NDJSON は行ごとに完結しており、終端処理は不要 (各行末の `\n` のみ)。
        let file = self
            .writer
            .into_inner()
            .map_err(|e| AppError::Io(e.into_error()))?;
        Ok(file.metadata()?.len())
    }
}

/// キャンセル (abort) や失敗時に書きかけの出力ファイルを残さないための RAII ガード。
///
/// `cancel_stream` は対象タスクを `AbortHandle::abort()` で即座に中断し、タスクの
/// future をその場で drop する。そのため `Err` 分岐にある明示的な `remove_file` も
/// 正常完了時の `finish()` もどちらも実行されず、`BufWriter` の Drop でバッファ内容が
/// フラッシュされて書きかけの (閉じ括弧の無い不正な JSON や途中で切れた CSV) 出力が
/// 保存先に残ってしまう。
///
/// このガードを spawn されるタスクのスコープ (async fn のローカル変数) に持たせ、
/// 正常完了時にのみ `commit()` を呼ぶ。それ以外の経路 (エラー・タイムアウト・
/// キャンセルによる future drop) では `Drop` 実装が確実に出力ファイルを削除する —
/// abort は future を drop するだけなので、Rust の通常の Drop 順序に乗るこの方式なら
/// キャンセル経路でも漏れなく効く。
struct PartialFileCleanup {
    path: PathBuf,
    committed: bool,
}

impl PartialFileCleanup {
    fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            committed: false,
        }
    }

    /// 出力が完了し、保存先ファイルをそのまま残してよいことを示す。以降 Drop されても
    /// 削除しない。
    fn commit(&mut self) {
        self.committed = true;
    }
}

impl Drop for PartialFileCleanup {
    fn drop(&mut self) {
        if !self.committed {
            let _ = std::fs::remove_file(&self.path);
        }
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
    // SQL INSERT 形式のときの対象テーブル名・バッチサイズ。ドライバはセッションから取る。
    table: Option<String>,
    batch_size: Option<usize>,
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

    // SQL 形式のドライバはセッション (実接続) の方言を使う。
    let sql_opts = SqlExportOpts::build(Some(session.conn.driver_kind()), table, batch_size);

    // Create the file up front so a bad path surfaces synchronously to the caller.
    // JSON 形式では実行クエリを出力に同梱する (sink 側で JSON のときだけ反映)。
    let sink = StreamExportSink::with_query(&path, format, Some(sql.clone()), sql_opts)?;
    let shared = Arc::new(Mutex::new(Some(sink)));
    // ファイルは既に作成済み (`with_query` 内)。正常完了以外の経路 (エラー/タイムアウト/
    // キャンセル) では Drop で自動的に削除される。
    let cleanup = PartialFileCleanup::new(&path);
    // Shared with `AppState` so `cancel_stream` can read how many rows had
    // already been written when it aborts this task (#685).
    let counter = Arc::new(AtomicU64::new(0));

    // register_stream をタスク本体より前に完了させるためのゲート
    // (run_query_stream / preview_query_stream と同じ理由。#685)。ゲートが
    // 無いと、即エラーや極小結果の export が register より先に forget_stream し、
    // 完了済み StreamHandle が streams に残り後続の cancel_stream が誤って成功を
    // 返す競合窓ができる。
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel::<()>();
    let stream_id_for_task = stream_id.clone();
    let counter_for_task = counter.clone();
    let handle = tokio::spawn(async move {
        let _ = ready_rx.await;
        spawn_export_stream(
            app,
            session,
            stream_id_for_task,
            sql,
            database,
            initial_batch,
            chunk_size,
            query_timeout_secs,
            shared,
            cleanup,
            counter_for_task,
        )
        .await;
    });
    state
        .register_stream(
            stream_id,
            StreamHandle {
                abort: handle.abort_handle(),
                delivered_rows: counter,
                kind: StreamKind::Export,
            },
        )
        .await;
    // register_stream 完了後にタスク本体の実行を許可する。
    let _ = ready_tx.send(());
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn spawn_export_stream(
    app: AppHandle,
    session: Arc<crate::state::Session>,
    stream_id: String,
    sql: String,
    database: Option<String>,
    initial_batch: usize,
    chunk_size: usize,
    query_timeout_secs: Option<u64>,
    shared: Arc<Mutex<Option<StreamExportSink>>>,
    mut cleanup: PartialFileCleanup,
    counter: Arc<AtomicU64>,
) {
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
                    // 出力が完全に書き終わったので、以降 Drop されてもファイルは消さない。
                    cleanup.commit();
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
                    // finish (JSON の閉じ括弧書き込み等) 失敗。cleanup は未 commit の
                    // ままなので、関数末尾での Drop が部分ファイルを削除する。
                    let _ = app.emit(
                        EV_EXPORT_ERROR,
                        ExportErrorEvent {
                            stream_id: stream_id.clone(),
                            message: e.to_string(),
                            rows: counter.load(Ordering::SeqCst),
                        },
                    );
                }
                None => {}
            }
        }
        Err(e) => {
            // 実行がエラー/タイムアウトになった。sink を drop するだけでよく、部分
            // ファイルの削除は cleanup が関数末尾の Drop で行う (cancel/abort による
            // future drop でも同じ Drop 経路を通るため、そちらもここで担保される)。
            if let Ok(mut g) = shared.lock() {
                g.take();
            }
            let _ = app.emit(
                EV_EXPORT_ERROR,
                ExportErrorEvent {
                    stream_id: stream_id.clone(),
                    message: e.to_string(),
                    rows: counter.load(Ordering::SeqCst),
                },
            );
        }
    }

    if let Some(state) = app.try_state::<AppState>() {
        state.forget_stream(&stream_id).await;
    }
    // `cleanup` はここ (関数末尾) で drop される。abort によりこの関数の実行自体が
    // 途中で打ち切られた場合も、future の drop に伴い同じ Drop 実装が走る。
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
        write_json(&mut buf, columns, rows, None).unwrap();
        buf
    }

    fn json_bytes_with_query(columns: &[Column], rows: &[Vec<Value>], query: &str) -> Vec<u8> {
        let mut buf = Vec::new();
        write_json(&mut buf, columns, rows, Some(query)).unwrap();
        buf
    }

    fn ndjson_bytes(columns: &[Column], rows: &[Vec<Value>]) -> Vec<u8> {
        let mut buf = Vec::new();
        write_ndjson(&mut buf, columns, rows).unwrap();
        buf
    }

    fn markdown_bytes(columns: &[Column], rows: &[Vec<Value>]) -> Vec<u8> {
        let mut buf = Vec::new();
        write_markdown(&mut buf, columns, rows).unwrap();
        buf
    }

    fn sql_bytes(columns: &[Column], rows: &[Vec<Value>], opts: &SqlExportOpts) -> Vec<u8> {
        let mut buf = Vec::new();
        write_sql_insert(&mut buf, columns, rows, opts).unwrap();
        buf
    }

    /// CSV/JSON/NDJSON/Markdown のテストで SQL 用パラメータは使われないが、
    /// `with_query` の引数として必要なのでデフォルトを用意する。
    fn test_sql_opts() -> SqlExportOpts {
        SqlExportOpts::build(Some(DriverKind::Mysql), Some("t".into()), Some(100))
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

    // CSV インジェクション対策: `=`/`@`/`+`/`-` 始まりの非数値セルは `'` を前置する。
    #[test]
    fn csv_mitigates_formula_injection_on_non_numeric_leading_triggers() {
        let columns = vec![col("note")];
        let rows = vec![
            vec![Value::String("=HYPERLINK(\"http://evil\")".into())],
            vec![Value::String("@SUM(A1:A2)".into())],
            vec![Value::String("+cmd|/c calc".into())],
            vec![Value::String("-cmd|/c calc".into())],
        ];
        let out = String::from_utf8(csv_bytes(&columns, &rows)).unwrap();
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines[1], "\"'=HYPERLINK(\"\"http://evil\"\")\"");
        assert_eq!(lines[2], "'@SUM(A1:A2)");
        assert_eq!(lines[3], "'+cmd|/c calc");
        assert_eq!(lines[4], "'-cmd|/c calc");
    }

    // 符号付き数値 (`-5`, `+3.2` 等) はそのまま (前置しない) — 数値表現を壊さない。
    #[test]
    fn csv_does_not_mitigate_signed_numeric_strings() {
        let columns = vec![col("n")];
        let rows = vec![
            vec![Value::String("-5".into())],
            vec![Value::String("+3.2".into())],
            vec![Value::String("-1e10".into())],
        ];
        let out = String::from_utf8(csv_bytes(&columns, &rows)).unwrap();
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines[1], "-5");
        assert_eq!(lines[2], "+3.2");
        assert_eq!(lines[3], "-1e10");
    }

    // 通常の文字列 (トリガ文字で始まらない) は無変更。
    #[test]
    fn csv_leaves_normal_strings_untouched() {
        let columns = vec![col("name")];
        let rows = vec![vec![Value::String("Alice".into())]];
        let out = String::from_utf8(csv_bytes(&columns, &rows)).unwrap();
        assert_eq!(out, "name\r\nAlice\r\n");
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

    // JSON 形式で query を渡すと `{ "query": ..., "rows": [...] }` でラップされる。
    #[test]
    fn json_with_query_wraps_rows() {
        let columns = vec![col("id"), col("name")];
        let rows = vec![
            vec![Value::Int(1), Value::String("Alice".into())],
            vec![Value::Int(2), Value::String("Bob".into())],
        ];
        let out = json_bytes_with_query(&columns, &rows, "SELECT * FROM users");
        let parsed: serde_json::Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(parsed["query"], serde_json::json!("SELECT * FROM users"));
        let arr = parsed["rows"].as_array().unwrap();
        assert_eq!(arr.len(), 2);
        assert_eq!(arr[0]["id"], serde_json::json!(1));
        assert_eq!(arr[0]["name"], serde_json::json!("Alice"));
    }

    // 空クエリ文字列ではラップせず従来どおり配列を出力する (後方互換)。
    #[test]
    fn json_with_empty_query_stays_array() {
        let columns = vec![col("id")];
        let rows = vec![vec![Value::Int(1)]];
        assert_eq!(
            json_bytes_with_query(&columns, &rows, ""),
            json_bytes(&columns, &rows),
        );
    }

    // 0 行でも query 同梱なら空配列を持つラッパオブジェクトになる。
    #[test]
    fn json_with_query_empty_rows() {
        let columns = vec![col("id")];
        let rows: Vec<Vec<Value>> = vec![];
        let out = json_bytes_with_query(&columns, &rows, "SELECT 1");
        let parsed: serde_json::Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(parsed["query"], serde_json::json!("SELECT 1"));
        assert_eq!(parsed["rows"].as_array().unwrap().len(), 0);
    }

    // ストリーミング sink も query 同梱でラップされ、有効な JSON になること。
    #[test]
    fn stream_sink_json_with_query_wraps_rows() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("noobdb_export_jsonq_{}.json", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let columns = vec![col("id"), col("name")];
        let mut sink = StreamExportSink::with_query(
            path.to_str().unwrap(),
            ExportFormat::Json,
            Some("SELECT * FROM t".into()),
            test_sql_opts(),
        )
        .unwrap();
        sink.on_columns(columns.clone()).unwrap();
        sink.on_rows(&[vec![Value::Int(1), Value::String("a".into())]])
            .unwrap();
        sink.on_rows(&[vec![Value::Int(2), Value::String("b".into())]])
            .unwrap();
        sink.finish().unwrap();
        let parsed: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(parsed["query"], serde_json::json!("SELECT * FROM t"));
        let arr = parsed["rows"].as_array().unwrap();
        assert_eq!(arr.len(), 2);
        assert_eq!(arr[1]["name"], serde_json::json!("b"));
        let _ = std::fs::remove_file(&path);
    }

    // ストリーミング sink: query 同梱 + 0 行でも有効な空配列ラッパになる。
    #[test]
    fn stream_sink_json_with_query_empty() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("noobdb_export_jsonqe_{}.json", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let mut sink = StreamExportSink::with_query(
            path.to_str().unwrap(),
            ExportFormat::Json,
            Some("SELECT 1".into()),
            test_sql_opts(),
        )
        .unwrap();
        sink.on_columns(vec![col("id")]).unwrap();
        sink.finish().unwrap();
        let parsed: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(parsed["query"], serde_json::json!("SELECT 1"));
        assert_eq!(parsed["rows"].as_array().unwrap().len(), 0);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn stream_sink_csv_writes_header_then_rows() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("noobdb_export_csv_{}.csv", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let columns = vec![col("id"), col("name")];
        let mut sink = StreamExportSink::with_query(
            path.to_str().unwrap(),
            ExportFormat::Csv,
            None,
            test_sql_opts(),
        )
        .unwrap();
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
        let mut sink = StreamExportSink::with_query(
            path.to_str().unwrap(),
            ExportFormat::Json,
            None,
            test_sql_opts(),
        )
        .unwrap();
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
        let mut sink = StreamExportSink::with_query(
            path.to_str().unwrap(),
            ExportFormat::Json,
            None,
            test_sql_opts(),
        )
        .unwrap();
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
        let mut sink = StreamExportSink::with_query(
            path.to_str().unwrap(),
            ExportFormat::Ndjson,
            None,
            test_sql_opts(),
        )
        .unwrap();
        sink.on_columns(columns.clone()).unwrap();
        // バッチを分けても in-memory の一括書き出しと同じバイト列になること。
        sink.on_rows(&rows[0..1]).unwrap();
        sink.on_rows(&rows[1..2]).unwrap();
        sink.finish().unwrap();
        let out = std::fs::read(&path).unwrap();
        assert_eq!(out, ndjson_bytes(&columns, &rows));
        let _ = std::fs::remove_file(&path);
    }

    // ── Markdown テーブル ──

    #[test]
    fn markdown_writes_header_separator_and_rows() {
        let columns = vec![col("id"), col("name")];
        let rows = vec![
            vec![Value::Int(1), Value::String("Alice".into())],
            vec![Value::Int(2), Value::Null],
        ];
        let out = String::from_utf8(markdown_bytes(&columns, &rows)).unwrap();
        let expected = "| id | name |\n\
                        | --- | --- |\n\
                        | 1 | Alice |\n\
                        | 2 |  |\n";
        assert_eq!(out, expected);
    }

    #[test]
    fn markdown_escapes_pipe_and_newline_and_blob() {
        let columns = vec![col("note"), col("blob")];
        let rows = vec![vec![
            Value::String("a|b\nc".into()),
            Value::Bytes("00ff".into()),
        ]];
        let out = String::from_utf8(markdown_bytes(&columns, &rows)).unwrap();
        // パイプは `\|`、改行は `<br>`、BLOB は `0x` 接頭辞付き。
        assert!(out.contains("| a\\|b<br>c | 0x00ff |"), "got: {out}");
    }

    // バックスラッシュを先にエスケープしないと、後段の `|` → `\|` で既存の `\` が
    // 区切りを誤ってエスケープしてしまう。入力 `a\|b` は `a\\\|b` になること。
    #[test]
    fn markdown_escapes_backslash_before_pipe() {
        let columns = vec![col("note")];
        let rows = vec![vec![Value::String("a\\|b".into())]];
        let out = String::from_utf8(markdown_bytes(&columns, &rows)).unwrap();
        assert!(out.contains("| a\\\\\\|b |"), "got: {out}");
    }

    // 空結果でもヘッダ + 区切り行は出力する (列構造が分かるように)。
    #[test]
    fn markdown_empty_rows_keeps_header() {
        let columns = vec![col("id"), col("name")];
        let rows: Vec<Vec<Value>> = vec![];
        let out = String::from_utf8(markdown_bytes(&columns, &rows)).unwrap();
        assert_eq!(out, "| id | name |\n| --- | --- |\n");
    }

    #[test]
    fn stream_sink_markdown_matches_in_memory() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("noobdb_export_md_{}.md", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let columns = vec![col("id"), col("name")];
        let rows = vec![
            vec![Value::Int(1), Value::String("a|b".into())],
            vec![Value::Int(2), Value::String("c".into())],
        ];
        let mut sink = StreamExportSink::with_query(
            path.to_str().unwrap(),
            ExportFormat::Markdown,
            None,
            test_sql_opts(),
        )
        .unwrap();
        sink.on_columns(columns.clone()).unwrap();
        sink.on_rows(&rows[0..1]).unwrap();
        sink.on_rows(&rows[1..2]).unwrap();
        sink.finish().unwrap();
        let out = std::fs::read(&path).unwrap();
        assert_eq!(out, markdown_bytes(&columns, &rows));
        let _ = std::fs::remove_file(&path);
    }

    // ── SQL INSERT 文 ──

    #[test]
    fn sql_insert_groups_rows_and_quotes_idents() {
        let columns = vec![col("id"), col("name")];
        let rows = vec![
            vec![Value::Int(1), Value::String("Alice".into())],
            vec![Value::Int(2), Value::String("Bob".into())],
        ];
        let opts = SqlExportOpts::build(Some(DriverKind::Mysql), Some("users".into()), Some(100));
        let out = String::from_utf8(sql_bytes(&columns, &rows, &opts)).unwrap();
        let expected = "INSERT INTO `users` (`id`, `name`) VALUES\n\
                        \u{20}\u{20}(1, 'Alice'),\n\
                        \u{20}\u{20}(2, 'Bob');\n";
        assert_eq!(out, expected);
    }

    #[test]
    fn sql_insert_respects_batch_size() {
        let columns = vec![col("id")];
        let rows = vec![
            vec![Value::Int(1)],
            vec![Value::Int(2)],
            vec![Value::Int(3)],
        ];
        let opts = SqlExportOpts::build(Some(DriverKind::Postgres), Some("t".into()), Some(2));
        let out = String::from_utf8(sql_bytes(&columns, &rows, &opts)).unwrap();
        // バッチ 2 行なので 2 文に分かれる (2 行 + 1 行)。Postgres は識別子をダブルクオート。
        let stmts: Vec<&str> = out
            .trim_end()
            .split(";\n")
            .filter(|s| !s.is_empty())
            .collect();
        assert_eq!(stmts.len(), 2);
        assert!(stmts[0].starts_with("INSERT INTO \"t\" (\"id\") VALUES"));
        assert!(stmts[0].contains("(1)") && stmts[0].contains("(2)"));
        assert!(stmts[1].contains("(3)"));
    }

    // ドライバ別リテラルエスケープ: 文字列のバックスラッシュ/クオート・BLOB・真偽値。
    #[test]
    fn sql_insert_driver_specific_literals() {
        let columns = vec![col("s"), col("b"), col("flag")];
        let rows = vec![vec![
            Value::String("a'b\\c".into()),
            Value::Bytes("00ff".into()),
            Value::Bool(true),
        ]];
        // MySQL: バックスラッシュ二重化 + X'..' BLOB + 1/0 真偽値。
        let my = String::from_utf8(sql_bytes(
            &columns,
            &rows,
            &SqlExportOpts::build(Some(DriverKind::Mysql), Some("t".into()), Some(100)),
        ))
        .unwrap();
        assert!(my.contains("'a''b\\\\c'"), "mysql string: {my}");
        assert!(my.contains("X'00ff'"), "mysql blob: {my}");
        assert!(my.contains(", 1)"), "mysql bool: {my}");
        // Postgres: クオートのみ二重化 + '\\x..' BLOB + TRUE/FALSE。
        let pg = String::from_utf8(sql_bytes(
            &columns,
            &rows,
            &SqlExportOpts::build(Some(DriverKind::Postgres), Some("t".into()), Some(100)),
        ))
        .unwrap();
        assert!(pg.contains("'a''b\\c'"), "pg string: {pg}");
        assert!(pg.contains("'\\x00ff'"), "pg blob: {pg}");
        assert!(pg.contains(", TRUE)"), "pg bool: {pg}");
    }

    #[test]
    fn sql_insert_empty_rows_is_empty() {
        let columns = vec![col("id")];
        let rows: Vec<Vec<Value>> = vec![];
        let opts = SqlExportOpts::build(Some(DriverKind::Sqlite), Some("t".into()), Some(100));
        assert!(sql_bytes(&columns, &rows, &opts).is_empty());
    }

    // 空テーブル名はプレースホルダ (`exported_table`) にフォールバックする。
    #[test]
    fn sql_insert_blank_table_falls_back_to_placeholder() {
        let columns = vec![col("id")];
        let rows = vec![vec![Value::Int(1)]];
        let opts = SqlExportOpts::build(Some(DriverKind::Mysql), Some("   ".into()), None);
        let out = String::from_utf8(sql_bytes(&columns, &rows, &opts)).unwrap();
        assert!(
            out.starts_with("INSERT INTO `exported_table`"),
            "got: {out}"
        );
    }

    #[test]
    fn stream_sink_sql_matches_in_memory() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("noobdb_export_sql_{}.sql", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let columns = vec![col("id"), col("name")];
        let rows = [
            vec![Value::Int(1), Value::String("a".into())],
            vec![Value::Int(2), Value::String("b".into())],
        ];
        let opts = SqlExportOpts::build(Some(DriverKind::Mysql), Some("users".into()), Some(100));
        let mut sink = StreamExportSink::with_query(
            path.to_str().unwrap(),
            ExportFormat::Sql,
            None,
            opts.clone(),
        )
        .unwrap();
        sink.on_columns(columns.clone()).unwrap();
        // ストリーミングはバッチごとに自己完結した INSERT 文を書く。
        sink.on_rows(&rows[0..1]).unwrap();
        sink.on_rows(&rows[1..2]).unwrap();
        sink.finish().unwrap();
        let out = std::fs::read_to_string(&path).unwrap();
        // 2 バッチ = 2 文 (各 1 行)。
        assert_eq!(out.matches("INSERT INTO `users`").count(), 2);
        assert!(out.contains("(1, 'a')"));
        assert!(out.contains("(2, 'b')"));
        let _ = std::fs::remove_file(&path);
    }

    // ── PartialFileCleanup (I1: キャンセル時に部分ファイルを残さない RAII ガード) ──

    // commit() を呼ばずに drop すると、出力ファイルは削除される
    // (エラー/タイムアウト/abort による future drop を模した経路)。
    #[test]
    fn partial_file_cleanup_removes_file_when_not_committed() {
        let path = std::env::temp_dir().join(format!(
            "noobdb_export_cleanup_uncommitted_{}.tmp",
            std::process::id()
        ));
        std::fs::write(&path, b"partial").unwrap();
        assert!(path.exists());
        {
            let _guard = PartialFileCleanup::new(&path);
            // commit() を呼ばずにスコープを抜ける。
        }
        assert!(
            !path.exists(),
            "uncommitted guard should remove the partial file on drop"
        );
    }

    // commit() を呼んでから drop すると、出力ファイルは残る (正常完了経路)。
    #[test]
    fn partial_file_cleanup_keeps_file_when_committed() {
        let path = std::env::temp_dir().join(format!(
            "noobdb_export_cleanup_committed_{}.tmp",
            std::process::id()
        ));
        std::fs::write(&path, b"complete").unwrap();
        assert!(path.exists());
        {
            let mut guard = PartialFileCleanup::new(&path);
            guard.commit();
        }
        assert!(
            path.exists(),
            "committed guard must not remove the finished file on drop"
        );
        let _ = std::fs::remove_file(&path);
    }
}
