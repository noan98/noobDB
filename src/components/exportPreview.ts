import type { CellValue, Column, ExportFormat } from "../api/tauri";

/**
 * エクスポート内容をフロント側で生成するための純ロジック。エクスポートモーダルの
 * プレビュー表示と「全文コピー」に使う。バックエンド (`commands/export.rs`) の
 * 書き出しと**同じ書式**になるよう実装をミラーする:
 *
 * - CSV は RFC4180 風のクオートと `\r\n` 終端。
 * - JSON は 2 スペース字下げの pretty。オブジェクトのキーは serde_json (既定の
 *   `BTreeMap`) に合わせて**アルファベット順にソート**する。`query` を渡すと
 *   `{ "query": ..., "rows": [...] }` でラップする (JSON 形式のみ。#  実行クエリ同梱)。
 * - NDJSON は 1 行 1 オブジェクトの `\n` 区切り。
 *
 * フロントの `CellValue` は BLOB を区別しない (16 進文字列として届く) ため、
 * 在グリッド (current scope) のエクスポートと同じく文字列としてそのまま扱う。
 */

function csvField(s: string): string {
  const needsQuote =
    s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r");
  if (!needsQuote) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

function valueToCsv(v: CellValue): string {
  if (v === null) return "";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  return csvField(v);
}

/** RFC4180 風 CSV。ヘッダ行 + データ行、各行 `\r\n` 終端。 */
export function buildCsv(columns: Column[], rows: CellValue[][]): string {
  let out = columns.map((c) => csvField(c.name)).join(",") + "\r\n";
  for (const row of rows) {
    const line = columns
      .map((_, i) => valueToCsv(row[i] ?? null))
      .join(",");
    out += line + "\r\n";
  }
  return out;
}

/**
 * 1 行を列名キーのオブジェクトに変換する。キーは serde_json の `BTreeMap` 出力に
 * 合わせてソート済みのプレーンオブジェクトとして返す (`JSON.stringify` は非整数
 * キーの挿入順を保つため、ソート順に挿入すれば出力もソート順になる)。
 */
function rowToObject(columns: Column[], row: CellValue[]): Record<string, CellValue> {
  const pairs: [string, CellValue][] = columns.map((col, i) => [
    col.name,
    row[i] ?? null,
  ]);
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const obj: Record<string, CellValue> = {};
  for (const [k, v] of pairs) obj[k] = v;
  return obj;
}

/**
 * pretty JSON。`query` (非空) を渡すと `{ query, rows }` でラップする。
 * `query` < `rows` のため挿入順がそのままソート順 (serde_json と一致) になる。
 */
export function buildJson(
  columns: Column[],
  rows: CellValue[][],
  query?: string | null,
): string {
  const arr = rows.map((row) => rowToObject(columns, row));
  if (query && query.length > 0) {
    return JSON.stringify({ query, rows: arr }, null, 2);
  }
  return JSON.stringify(arr, null, 2);
}

/** NDJSON: 1 行 1 オブジェクト、`\n` 区切り。空なら空文字列。 */
export function buildNdjson(columns: Column[], rows: CellValue[][]): string {
  let out = "";
  for (const row of rows) {
    out += JSON.stringify(rowToObject(columns, row)) + "\n";
  }
  return out;
}

/**
 * Markdown テーブルのセルをエスケープする。バックエンド (`export.rs` の `md_escape`)
 * と完全に一致させる: まずバックスラッシュ `\` を `\\` に (これを最初にしないと、
 * 後段で `|` を `\|` にしたときに既存の `\` が誤って区切りをエスケープしてしまう)、
 * 次に区切りの `|` を `\|` に、CR を除去、LF を `<br>` に置換する。
 * スキーマエクスポート (`schemaExport.ts`) も同じエスケープを共有する。
 */
export function mdEscape(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\r/g, "")
    .replace(/\n/g, "<br>");
}

function valueToMarkdown(v: CellValue): string {
  if (v === null) return "";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  return mdEscape(v);
}

/**
 * GFM テーブル: ヘッダ行 + 区切り行 (`| --- | ... |`) + データ行。空結果でも
 * ヘッダ + 区切りは出力する (バックエンドの `write_markdown` と一致)。
 */
export function buildMarkdownTable(columns: Column[], rows: CellValue[][]): string {
  let out = "|";
  for (const c of columns) out += " " + mdEscape(c.name) + " |";
  out += "\n|";
  for (let i = 0; i < columns.length; i++) out += " --- |";
  out += "\n";
  for (const row of rows) {
    out += "|";
    for (let i = 0; i < columns.length; i++) out += " " + valueToMarkdown(row[i] ?? null) + " |";
    out += "\n";
  }
  return out;
}

/** SQL INSERT 形式で対象テーブル名が空のときに使うプレースホルダ (バックと一致)。 */
export const DEFAULT_SQL_TABLE = "exported_table";
/** SQL INSERT で 1 文へまとめる行数の既定上限 (バックと一致)。 */
export const DEFAULT_SQL_BATCH = 100;

function quoteSqlIdent(driver: string, name: string): string {
  if (driver === "postgres" || driver === "sqlite") {
    return '"' + name.replace(/"/g, '""') + '"';
  }
  return "`" + name.replace(/`/g, "``") + "`";
}

/**
 * 1 つの値を SQL リテラルへ変換する。バックエンドの `data_diff::sql_literal` を
 * JSON 化された値の意味でミラーする (BLOB は文字列として届くため、`Value::Bytes`
 * の専用エンコードではなく文字列リテラルになる点も在グリッド経路と一致する)。
 */
function sqlLiteral(driver: string, v: CellValue): string {
  if (v === null) return "NULL";
  if (typeof v === "boolean") {
    if (driver === "postgres") return v ? "TRUE" : "FALSE";
    return v ? "1" : "0";
  }
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  const escaped =
    driver === "postgres" || driver === "sqlite"
      ? v.replace(/'/g, "''")
      : v.replace(/\\/g, "\\\\").replace(/'/g, "''");
  return "'" + escaped + "'";
}

/**
 * SQL INSERT 文を生成する。`batchSize` 行ごとに 1 文へまとめ、各文は
 * `INSERT INTO <table> (cols) VALUES\n  (...),\n  (...);` の形。空結果なら空文字列。
 * バックエンドの `write_sql_insert` と一致させる。
 */
export function buildSqlInsert(
  driver: string,
  table: string | null,
  columns: Column[],
  rows: CellValue[][],
  batchSize = DEFAULT_SQL_BATCH,
): string {
  if (columns.length === 0 || rows.length === 0) return "";
  const tbl = (table ?? "").trim() || DEFAULT_SQL_TABLE;
  const size = batchSize > 0 ? batchSize : DEFAULT_SQL_BATCH;
  const ref = quoteSqlIdent(driver, tbl);
  const cols = columns.map((c) => quoteSqlIdent(driver, c.name)).join(", ");
  let out = "";
  for (let start = 0; start < rows.length; start += size) {
    const chunk = rows.slice(start, start + size);
    out += `INSERT INTO ${ref} (${cols}) VALUES\n`;
    out += chunk
      .map(
        (row) =>
          "  (" + columns.map((_, i) => sqlLiteral(driver, row[i] ?? null)).join(", ") + ")",
      )
      .join(",\n");
    out += ";\n";
  }
  return out;
}

/** SQL/Markdown 形式の出力に必要な追加コンテキスト。 */
export interface ExportFormatContext {
  driver?: string;
  table?: string | null;
  sqlBatchSize?: number;
}

/**
 * 指定形式でエクスポート内容を生成する。`query` は JSON 形式のときだけ反映され、
 * CSV / NDJSON / Markdown / SQL では無視される (バックエンドの挙動と一致)。SQL 形式は
 * `ctx` のドライバ/テーブル/バッチサイズを使う。
 */
export function buildExportContent(
  format: ExportFormat,
  columns: Column[],
  rows: CellValue[][],
  query?: string | null,
  ctx?: ExportFormatContext,
): string {
  switch (format) {
    case "csv":
      return buildCsv(columns, rows);
    case "ndjson":
      return buildNdjson(columns, rows);
    case "markdown":
      return buildMarkdownTable(columns, rows);
    case "sql":
      return buildSqlInsert(
        ctx?.driver ?? "mysql",
        ctx?.table ?? null,
        columns,
        rows,
        ctx?.sqlBatchSize ?? DEFAULT_SQL_BATCH,
      );
    default:
      return buildJson(columns, rows, query);
  }
}
