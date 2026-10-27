import { useCallback, useEffect, useRef, useState } from "react";

import { durations, staggerTiming } from "../motion";

/**
 * React Flow サーフェス (ER 図 / EXPLAIN 図, #1861) のノード入場スタッガーと再レイアウト・
 * モーフの共通部品。見た目は App.css の `.flow-node-enter` / `.flow-edge-enter` /
 * `.flow-morphing`、ここは「深さ → 遅延インデックス」「入場にかかる時間」「モーフ中フラグ」
 * だけを持つ。レイアウトの純ロジック (`erDiagram.ts` / `explainPlan.ts`) は変えない。
 */

/** ノード (React Flow ラッパ) に付けるクラス。入場アニメと位置モーフの対象を示す。 */
export const FLOW_NODE_ENTER_CLASS = "flow-node-enter";
/** エッジに付けるクラス。線の描画 (stroke-dashoffset) を遅延付きで走らせる。 */
export const FLOW_EDGE_ENTER_CLASS = "flow-edge-enter";

/** スタッガーの段数の上限。巨大なグラフでも入場全体が長引かないよう頭打ちにする。 */
export const FLOW_STAGGER_MAX_INDEX = 12;

/** 同じ深さとみなす中心座標の許容差 (px)。dagre は同一ランクを同じ中心に置く。 */
const RANK_EPSILON = 1;

/**
 * ランク軸 (TB なら y、LR なら x) の中心座標から、グラフの深さ (0 始まり) を求める。
 * 同じ中心を持つノードは同じ深さ。戻り値は入力と同じ並び。純関数。
 */
export function rankIndices(centers: readonly number[]): number[] {
  const sorted = [...centers].sort((a, b) => a - b);
  const levels: number[] = [];
  for (const c of sorted) {
    const last = levels[levels.length - 1];
    if (last === undefined || c - last > RANK_EPSILON) levels.push(c);
  }
  return centers.map((c) => {
    const i = levels.findIndex((l) => Math.abs(l - c) <= RANK_EPSILON);
    return Math.min(Math.max(i, 0), FLOW_STAGGER_MAX_INDEX);
  });
}

/** 最も深いノードの入場が終わるまでの時間 (ms)。fit のタイミングを後ろへずらすのに使う。 */
export function flowEntranceMs(maxIndex: number): number {
  const idx = Math.min(Math.max(maxIndex, 0), FLOW_STAGGER_MAX_INDEX);
  return Math.round((staggerTiming.delay + idx * staggerTiming.each + durations.med) * 1000);
}

/** 位置モーフにかかる時間 (ms)。CSS の `--dur-med` と同じ。ビューポートの fit もこれに揃える。 */
export const FLOW_MORPH_MS = Math.round(durations.med * 1000);

/** React Flow のノード / エッジの `style` に渡す、スタッガー用のカスタムプロパティ。 */
export function staggerStyle(index: number): Record<string, number> {
  return { "--stagger-index": index };
}

/**
 * 再レイアウト中 (ノードが新しい位置へ滑っている間) だけ true を返すフック。エッジは React
 * Flow が最終位置から引くため、ノードの滑りとずれる。その間は CSS (`.flow-morphing`) で
 * エッジを隠し、終わったらフェードインさせる。`begin()` はモーションが有効なときだけ呼ぶ。
 */
export function useFlowMorphing(): { morphing: boolean; begin: () => void } {
  const [morphing, setMorphing] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const begin = useCallback(() => {
    setMorphing(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setMorphing(false), FLOW_MORPH_MS);
  }, []);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return { morphing, begin };
}
