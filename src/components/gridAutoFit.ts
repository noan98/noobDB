/**
 * 列境界のダブルクリックで「内容に合わせた幅」を求める純ロジック (#1610)。
 *
 * 取得済みの先頭 `sampleLimit` 行 (とヘッダ名) の文字列幅の最大値に余白を足し、
 * 列の min / max にクランプする。幅の測定 (`measure`) は呼び出し側 (canvas) が渡す。
 */
import type { CellValue } from "../api/tauri";

/** 測定に使う最大行数 (数十万行でも一瞬で返すため)。 */
export const AUTOFIT_SAMPLE_ROWS = 1000;
/** 1 セルあたり測定する最大文字数 (長大テキストで測定が重くならないように)。 */
const AUTOFIT_MAX_CHARS = 200;

export function autoFitText(v: CellValue | undefined): string {
  if (v === null || v === undefined) return "NULL";
  const s = String(v);
  return s.length > AUTOFIT_MAX_CHARS ? s.slice(0, AUTOFIT_MAX_CHARS) : s;
}

export function computeAutoFitWidth(opts: {
  headerTexts: string[];
  values: CellValue[];
  measure: (text: string) => number;
  padding: number;
  min: number;
  max: number;
}): number {
  const { headerTexts, values, measure, padding, min, max } = opts;
  let widest = 0;
  for (const h of headerTexts) widest = Math.max(widest, measure(h));
  const limit = Math.min(values.length, AUTOFIT_SAMPLE_ROWS);
  for (let i = 0; i < limit; i++) widest = Math.max(widest, measure(autoFitText(values[i])));
  return Math.min(max, Math.max(min, Math.ceil(widest + padding)));
}
