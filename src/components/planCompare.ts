import type { QueryResult } from "../api/tauri";
import type { I18nKey } from "../i18n";
import {
  type HintSeverity,
  type PlanLabelT,
  type PlanNode,
  type PlanScore,
  actualTotalMs,
  computeHints,
  hasActual,
  parseExplainForDriver,
  scorePlan,
} from "./explainPlan";
import { type PlanChange, type PlanOp, comparePlans, normalizePlan } from "./planDiff";

/**
 * 2 つの EXPLAIN 結果を見比べる (#1539) 純ロジック。「インデックスを足す前後」のように、
 * EXPLAIN タブで固定した計画 (before) と今の計画 (after) を、スコア・総コスト・ヒント件数・
 * ノードごとの access / index / join の差分で要約する。パースは `parseExplainForDriver`、
 * 重さは `scorePlan` / `computeHints`、ノードの差分は実行計画ウォッチ (#743) の
 * `normalizePlan` + `comparePlans` をそのまま使う (新しい解析は持たない)。
 */

/** 1 つの計画の要約。 */
export interface PlanSummary {
  score: PlanScore;
  /** ルートノードの総コスト。オプティマイザが返さない方言・形式では null。 */
  totalCost: number | null;
  nodeCount: number;
  /** ヒントの件数 (重大度別)。 */
  hints: Record<HintSeverity, number>;
  /** 実測モード (EXPLAIN ANALYZE) の総実行時間 ms。実測でなければ null。 */
  actualMs: number | null;
  ops: PlanOp[];
}

/** 全ノードを辿ってヒントを重大度別に数える。 */
function countHints(root: PlanNode): { hints: Record<HintSeverity, number>; nodes: number } {
  const hints: Record<HintSeverity, number> = { info: 0, caution: 0, warning: 0 };
  let nodes = 0;
  const walk = (n: PlanNode) => {
    nodes++;
    for (const h of computeHints(n)) hints[h.severity]++;
    n.children.forEach(walk);
  };
  walk(root);
  return { hints, nodes };
}

/** パース済みの計画ツリーを要約する。 */
export function summarizePlanTree(root: PlanNode, driver: string): PlanSummary {
  const { hints, nodes } = countHints(root);
  return {
    score: scorePlan(root),
    totalCost: root.cost,
    nodeCount: nodes,
    hints,
    actualMs: hasActual(root) ? actualTotalMs(root) : null,
    ops: normalizePlan(root, driver),
  };
}

/** EXPLAIN 結果を要約する。空・パース失敗なら null。 */
export function summarizePlanResult(
  driver: string,
  result: QueryResult | null,
  tr?: PlanLabelT,
): PlanSummary | null {
  const parsed = parseExplainForDriver(driver, result, tr);
  if (!parsed.root) return null;
  return summarizePlanTree(parsed.root, driver);
}

/** 数値指標の差。`delta = after - before`。どちらかが無ければ null。 */
export function metricDelta(before: number | null, after: number | null): number | null {
  if (before === null || after === null) return null;
  return after - before;
}

/** 総合判定 (重さスコアの増減が主、同点ならヒント警告数、それも同じなら変化なし)。 */
export type PlanVerdict = "improved" | "regressed" | "same";

export interface PlanComparisonView {
  before: PlanSummary;
  after: PlanSummary;
  scoreDelta: number;
  costDelta: number | null;
  /** after / before。コストが 0 や欠落のとき null。 */
  costRatio: number | null;
  warningDelta: number;
  cautionDelta: number;
  actualMsDelta: number | null;
  changes: PlanChange[];
  verdict: PlanVerdict;
}

/**
 * before / after の要約を比べる。判定は「重さスコアが下がれば改善、上がれば悪化」で、
 * スコアが同じなら警告ヒント数の増減を見る。スコア差が 1 点以内のコストの微変動は
 * 「変化なし」に倒す (誤判定より見逃し優先 — ウォッチ #743 と同じ方針)。
 */
export function comparePlanSummaries(before: PlanSummary, after: PlanSummary): PlanComparisonView {
  const scoreDelta = after.score.score - before.score.score;
  const warningDelta = after.hints.warning - before.hints.warning;
  const cautionDelta = after.hints.caution - before.hints.caution;
  const costDelta = metricDelta(before.totalCost, after.totalCost);
  const costRatio =
    before.totalCost !== null && before.totalCost > 0 && after.totalCost !== null
      ? after.totalCost / before.totalCost
      : null;
  let verdict: PlanVerdict = "same";
  if (Math.abs(scoreDelta) > 1) verdict = scoreDelta < 0 ? "improved" : "regressed";
  else if (warningDelta !== 0) verdict = warningDelta < 0 ? "improved" : "regressed";
  return {
    before,
    after,
    scoreDelta,
    costDelta,
    costRatio,
    warningDelta,
    cautionDelta,
    actualMsDelta: metricDelta(before.actualMs, after.actualMs),
    changes: comparePlans(before.ops, after.ops).changes,
    verdict,
  };
}

/** 変化の種別 → 説明文の i18n キー (実行計画ウォッチと同じ文言を使う)。 */
export const PLAN_CHANGE_I18N_KEY: Record<PlanChange["kind"], I18nKey> = {
  access: "planWatchChangeAccess",
  index: "planWatchChangeIndex",
  join: "planWatchChangeJoin",
  estRows: "planWatchChangeRows",
  opAdded: "planWatchChangeAdded",
  opRemoved: "planWatchChangeRemoved",
};
