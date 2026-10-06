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

/** `dir` 直下に書き出す各テーブルのファイルパス (`tables` と同じ順)。区切り文字は `dir` が
 *  使っているものに合わせ、ファイル名に使えない文字は `_` に置き換える。置き換えや大文字小文字
 *  だけの違い (`a/b` と `a_b`、`Users` と `users`) で名前が重なるときは、大文字小文字を無視して
 *  比べ、後ろの方に `_2` `_3` … を付けて必ず別ファイルにする。 */
export function bulkExportPaths(dir: string, tables: readonly string[], format: ExportFormat): string[] {
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  const base = dir.replace(/[\\/]+$/, "");
  const used = new Set<string>();
  return tables.map((table) => {
    const stem = table.replace(/[\\/:*?"<>|]/g, "_").replace(/[ .]+$/, "") || "table";
    let name = stem;
    for (let n = 2; used.has(name.toLowerCase()); n += 1) name = `${stem}_${n}`;
    used.add(name.toLowerCase());
    return `${base}${sep}${name}${EXTENSIONS[format]}`;
  });
}

/** 長い一覧を先頭 `max` 件に切り詰める。残りの件数は `rest` (0 なら切り詰め無し)。 */
export function abbreviateList<T>(items: readonly T[], max: number): { shown: T[]; rest: number } {
  return { shown: items.slice(0, max), rest: Math.max(0, items.length - max) };
}
