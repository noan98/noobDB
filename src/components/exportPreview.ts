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
 * 指定形式でエクスポート内容を生成する。`query` は JSON 形式のときだけ反映され、
 * CSV / NDJSON では無視される (バックエンドの挙動と一致)。
 */
export function buildExportContent(
  format: ExportFormat,
  columns: Column[],
  rows: CellValue[][],
  query?: string | null,
): string {
  switch (format) {
    case "csv":
      return buildCsv(columns, rows);
    case "ndjson":
      return buildNdjson(columns, rows);
    default:
      return buildJson(columns, rows, query);
  }
}
