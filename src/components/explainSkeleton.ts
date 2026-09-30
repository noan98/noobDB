import { shouldStaggerEntrance } from "./commandPaletteSearch";

/**
 * EXPLAIN プラン取得中に出すツリー状スケルトンの行定義 (#1236)。
 * `depth` はインデント段数、`width` はバーの幅 (%)。実際のプランツリーの階層
 * (ルート → ジョインの子 → 走査ノード) を模す。
 */
export interface ExplainSkeletonRow {
  depth: number;
  width: number;
}

export const EXPLAIN_SKELETON_ROWS: readonly ExplainSkeletonRow[] = [
  { depth: 0, width: 70 },
  { depth: 1, width: 58 },
  { depth: 2, width: 48 },
  { depth: 2, width: 42 },
  { depth: 1, width: 52 },
  { depth: 2, width: 38 },
];

/**
 * プランツリーの初回描画で stagger 出現させるノード ID の集合を返す。
 * `preorderIds` は表示順 (ルートが先頭の先行順) の全 ID。コマンドパレットと同じ
 * 上限ガード (`shouldStaggerEntrance`) を流用し、大量ノードでは後続を遅延なく
 * 即時表示する。
 */
export function staggerPlanIds(preorderIds: readonly string[]): Set<string> {
  const ids = new Set<string>();
  preorderIds.forEach((id, i) => {
    if (shouldStaggerEntrance(i)) ids.add(id);
  });
  return ids;
}
