import type { CellValue, Column } from "../api/tauri";
import { buildCsv, buildMarkdownTable, mitigateFormulaInjection } from "./exportPreview";

/**
 * 表形式データ (ヘッダ + 行) を CSV / TSV / Markdown のテキストへ整形する純ロジック (#1539)。
 * CSV / Markdown のエスケープはエクスポート (`exportPreview.ts`) と同じ実装を流用する
 * ので、セル内のカンマ・改行・ダブルクオートや数式インジェクション緩和の規則が揃う。
 */

/** 列名の配列から `Column` を作る (型名は表示に使わないので空)。 */
export function namesToColumns(names: readonly string[]): Column[] {
  return names.map((name) => ({ name, type_name: "" }));
}

/** CSV (RFC4180 風、`\r\n` 終端)。 */
export function tableToCsv(header: readonly string[], rows: readonly CellValue[][]): string {
  return buildCsv(namesToColumns(header), rows as CellValue[][]);
}

/** Markdown (GFM) テーブル。 */
export function tableToMarkdown(header: readonly string[], rows: readonly CellValue[][]): string {
  return buildMarkdownTable(namesToColumns(header), rows as CellValue[][]);
}

/** TSV のセル: タブ・改行は空白 1 つへ潰す (表計算へ貼ったときに行・列が崩れないように)。 */
function tsvCell(v: CellValue): string {
  if (v === null) return "";
  // 表計算へ貼ったときの数式インジェクションは CSV と同じ規則で緩和する。
  return mitigateFormulaInjection(String(v)).replace(/[\t\r\n]+/g, " ");
}

/** TSV (`\n` 終端)。クオートはせず、タブ・改行を空白へ置換する。 */
export function tableToTsv(header: readonly string[], rows: readonly CellValue[][]): string {
  const lines = [header.map((h) => tsvCell(h)).join("\t")];
  for (const row of rows) {
    lines.push(header.map((_, i) => tsvCell(row[i] ?? null)).join("\t"));
  }
  return lines.join("\n") + "\n";
}

/** 書き出し形式 → 拡張子 (保存ダイアログのフィルタ・既定ファイル名に使う)。 */
export const TEXT_FORMAT_EXT = {
  csv: "csv",
  tsv: "tsv",
  json: "json",
  markdown: "md",
  text: "txt",
} as const;
export type TextFormatId = keyof typeof TEXT_FORMAT_EXT;
