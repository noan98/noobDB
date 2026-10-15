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

/** 列の近似ユニーク数から読み取れる傾向 (#1628)。 */
export type DistinctHintKind = "candidateKey" | "constant" | "lowCardinality";

export interface DistinctHint {
  /** 近似ユニーク数 (HyperLogLog。標準誤差は約 1.6%)。 */
  estimate: number;
  kind: DistinctHintKind | null;
}

/** 候補キーとみなす近似ユニーク数の下限 (行数に対する比率)。標準誤差 1.6% の約 2σ 下。 */
const CANDIDATE_KEY_RATIO = 0.97;
/** 傾向の判定に最低限必要な行数。少ない行数では偶然一意になりやすい。 */
const CANDIDATE_KEY_MIN_ROWS = 10;
const LOW_CARDINALITY_MIN_ROWS = 100;
const LOW_CARDINALITY_MAX_DISTINCT = 10;

/**
 * 列 `i` の近似ユニーク数と傾向 (候補キー / 定数列 / 低カーディナリティ)。追加のクエリ無しで、
 * ストリーム逐次統計の HyperLogLog (`distinctEstimates`) だけから求める。推定が無い (古いバックエンド・
 * 非 NULL 値が無い列) ときは null。
 */
export function distinctHintFor(
  stats: StreamStatsSnapshot,
  rowCount: number,
  i: number,
): DistinctHint | null {
  const est = stats.distinctEstimates?.[i];
  const nulls = stats.nullCounts[i];
  if (est === undefined || nulls === undefined || rowCount - nulls <= 0) return null;
  const nonNull = rowCount - nulls;
  let kind: DistinctHintKind | null = null;
  if (est <= 1 && nonNull >= 2) kind = "constant";
  else if (nulls === 0 && rowCount >= CANDIDATE_KEY_MIN_ROWS && est >= rowCount * CANDIDATE_KEY_RATIO)
    kind = "candidateKey";
  else if (rowCount >= LOW_CARDINALITY_MIN_ROWS && est <= LOW_CARDINALITY_MAX_DISTINCT)
    kind = "lowCardinality";
  return { estimate: est, kind };
}
