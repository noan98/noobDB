import type { CellValue, Column } from "../api/tauri";
import { MASK_PLACEHOLDER } from "./columnMask";
import { buildCsv, buildJson } from "./exportPreview";

/**
 * 結果グリッドの「CSV / JSON としてコピー」(#1113) の純ロジック。
 *
 * 書式はエクスポート (`exportPreview.ts` の `buildCsv` / `buildJson`) をそのまま
 * 再利用し、ファイル書き出しとクリップボードで同じ出力になるようにする
 * (CSV は RFC4180 風 + `\r\n`、JSON は 2 スペース字下げでキーをソート)。
 *
 * 対象範囲 (行・列) は呼び出し側 (`ResultGrid`) が表示順で決めて渡す:
 * 矩形選択があればその範囲、無ければ右クリックした 1 行の表示中の全列。
 *
 * 機微カラムのマスク (#1069) は TSV コピー (`maskedCopyText`) と同じ規則に従う:
 * マスク中のセルは「プレースホルダをコピーする」設定のときだけ伏せ字に置き換え、
 * オフなら実値をコピーする。
 */

export type GridCopyFormat = "csv" | "json";

export interface GridCopyInput {
  columns: readonly Column[];
  rows: readonly (readonly CellValue[])[];
  /** 対象行 (元データの行インデックス、表示順)。 */
  rowIndices: readonly number[];
  /** 対象列 (元データの列インデックス、表示順)。 */
  colIndices: readonly number[];
  /** セルがいまマスク表示中か。 */
  isMasked: (rowIdx: number, colIdx: number) => boolean;
  /** マスク中のセルを伏せ字でコピーする設定か。 */
  copyPlaceholder: boolean;
}

/** 対象範囲を (列, 値行列) へ切り出す。マスク規則をここで適用する。 */
export function sliceForCopy(input: GridCopyInput): { columns: Column[]; rows: CellValue[][] } {
  const columns = input.colIndices
    .map((ci) => input.columns[ci])
    .filter((c): c is Column => !!c);
  const validCols = input.colIndices.filter((ci) => !!input.columns[ci]);
  const rows: CellValue[][] = [];
  for (const ri of input.rowIndices) {
    const row = input.rows[ri];
    if (!row) continue;
    rows.push(
      validCols.map((ci) =>
        input.copyPlaceholder && input.isMasked(ri, ci) ? MASK_PLACEHOLDER : (row[ci] ?? null),
      ),
    );
  }
  return { columns, rows };
}

/** 対象範囲を指定形式のテキストにする。対象が空なら空文字。 */
export function buildGridCopyText(format: GridCopyFormat, input: GridCopyInput): string {
  const { columns, rows } = sliceForCopy(input);
  if (columns.length === 0 || rows.length === 0) return "";
  return format === "csv" ? buildCsv(columns, rows) : buildJson(columns, rows);
}
