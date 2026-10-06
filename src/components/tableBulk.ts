/**
 * スキーマツリーで複数選択したテーブルへの一括操作 (#1399) の純ロジック。
 * 実行は既存コマンド (`get_object_definition` / `export_query_stream` / `dump_database` /
 * `run_query`) の束ねで、ここは文字列の組み立てだけを持つ。
 */

import type { ExportFormat } from "../api/tauri";

/** 一括操作の種類。 */
export type BulkTableAction = "copyDdl" | "showDdl" | "export" | "dump" | "drop";

/** 一括エクスポートで選べる形式 (結果 1 件ぶんのエクスポートと同じ集合)。 */
export const BULK_EXPORT_FORMATS: readonly ExportFormat[] = ["csv", "json", "ndjson", "markdown", "sql", "xlsx"];

const EXTENSIONS: Record<ExportFormat, string> = {
  csv: ".csv",
  json: ".json",
  ndjson: ".ndjson",
  markdown: ".md",
  sql: ".sql",
  xlsx: ".xlsx",
};

/** 複数テーブルの CREATE TABLE を 1 本のスクリプトにまとめる (各文を `;` で終え、空行で区切る)。 */
export function joinTableDdls(ddls: readonly string[]): string {
  return ddls
    .map((d) => d.trim())
    .filter((d) => d !== "")
    .map((d) => (d.endsWith(";") ? d : `${d};`))
    .join("\n\n");
}

/** `dir` 直下に書き出すファイルのパス。区切り文字は `dir` が使っているものに合わせ、
 *  テーブル名のうちファイル名に使えない文字は `_` に置き換える。 */
export function bulkExportPath(dir: string, table: string, format: ExportFormat): string {
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  const stem = table.replace(/[\\/:*?"<>|]/g, "_").replace(/[ .]+$/, "") || "table";
  return `${dir.replace(/[\\/]+$/, "")}${sep}${stem}${EXTENSIONS[format]}`;
}
