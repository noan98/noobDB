import type { CellValue, StreamStatsSnapshot } from "../api/tauri";
import type { NumericStats } from "./cellConditionalFormat";

/**
 * ストリーミング中に Rust が逐次更新した列統計 (#1257) を、結果行の配列に紐づけて
 * 持つ小さなレジストリ。
 *
 * 統計は「その行配列の内容」に対してだけ正しい。セル編集の適用
 * (`applyEditsToRows`)・行の追加/削除・load-more などで `rows` が別の配列に
 * 置き換わると、`WeakMap` のキー (配列の同一性) が変わるため自動的に見つからなくなり、
 * 呼び出し側は JS の全行再計算へ戻る。`tab.result` に統計を載せないのは、結果が
 * JSON 化される経路 (タブ保存など) へ行配列が二重に載るのを避けるため。
 */
const registry = new WeakMap<object, StreamStatsSnapshot>();

/** `rows` の内容に対応する統計を登録する。 */
export function attachStreamStats(rows: CellValue[][], stats: StreamStatsSnapshot | null | undefined): void {
  if (stats) registry.set(rows, stats);
}

/**
 * `rows` に対応する統計を返す。無い・行数が食い違う (= 統計が古い) 場合は `null`。
 */
export function streamStatsFor(rows: CellValue[][] | null | undefined): StreamStatsSnapshot | null {
  if (!rows) return null;
  const s = registry.get(rows);
  if (!s || s.rowCount !== rows.length) return null;
  return s;
}

/** 列 `i` の数値 min/max (数値化できる値が無ければ `null`)。 */
export function numericStatsFromStream(stats: StreamStatsSnapshot, i: number): NumericStats | null {
  const min = stats.numMin[i];
  const max = stats.numMax[i];
  return min === null || min === undefined || max === null || max === undefined ? null : { min, max };
}
