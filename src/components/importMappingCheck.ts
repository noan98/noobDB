// 取り込みの列対応付け (#2126) の判定ロジック (純関数)。表示専用で、実際の取り込みは
// バックエンドが行う。「必須列をスキップしたまま取り込む」失敗を dry-run の前に見せる。

import type { TableColumnInfo } from "../api/tauri";
import { insertDefaultHint } from "./insertDefaults";

/** 対応付けの状態。`required` は必須列が未対応 (取り込むと NOT NULL 違反になりうる)。 */
export type MappingRowState = "mapped" | "skipped" | "required";

/**
 * 取り込み時に値の指定が必須な列か。NOT NULL で、DEFAULT・自動採番・生成列のどれでも
 * ない列だけが対象 (これらは省略するとDBが値を補う)。`insertDefaultHint` と同じ判定。
 */
export function isRequiredColumn(driver: string, col: TableColumnInfo, table: TableColumnInfo[]): boolean {
  return !col.nullable && insertDefaultHint(driver, col, table) === null;
}

/** 1 列の対応状態。`csvIndex` が null / undefined なら未対応。 */
export function mappingRowState(
  driver: string,
  col: TableColumnInfo,
  table: TableColumnInfo[],
  csvIndex: number | null | undefined,
): MappingRowState {
  if (csvIndex !== null && csvIndex !== undefined) return "mapped";
  return isRequiredColumn(driver, col, table) ? "required" : "skipped";
}

/** 未対応の必須列の名前 (テーブルの列順)。 */
export function missingRequiredColumns(
  driver: string,
  table: TableColumnInfo[],
  mapping: Record<string, number | null | undefined>,
): string[] {
  return table
    .filter((c) => mappingRowState(driver, c, table, mapping[c.name]) === "required")
    .map((c) => c.name);
}

/** 見出しの要約「対応 n / m 列」。 */
export function mappingSummary(
  table: TableColumnInfo[],
  mapping: Record<string, number | null | undefined>,
): { mapped: number; total: number } {
  const mapped = table.filter((c) => mapping[c.name] !== null && mapping[c.name] !== undefined).length;
  return { mapped, total: table.length };
}

/** 先頭行のサンプル値。列が無い (行が短い) ときは null、空文字は "" のまま返す。 */
export function sampleValue(rows: string[][], csvIndex: number | null | undefined): string | null {
  if (csvIndex === null || csvIndex === undefined || rows.length === 0) return null;
  return rows[0][csvIndex] ?? null;
}
