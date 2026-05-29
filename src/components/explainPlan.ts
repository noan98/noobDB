import type { I18nKey } from "../i18n";

/**
 * MySQL `EXPLAIN FORMAT=JSON` プランの純粋ロジック層。
 *
 * パース・コスト抽出・パフォーマンスヒント検出・「重さスコア」算出といった、
 * React/Chakra に依存しないロジックをここに集約する。`ExplainViewer.tsx` は
 * 表示 (ツリー/詳細パネル/スコアバッジ) のみを担当し、本モジュールを利用する。
 * 純粋関数なので `src/__tests__/explainPlan.test.ts` でユニットテストできる。
 */

/**
 * A parsed node of the MySQL EXPLAIN plan tree. `attrs` keeps the scalar
 * fields (and flattened `cost_info.*`) for the detail panel; `children` are
 * the structural sub-plans (nested_loop tables, ordering/grouping operations,
 * sub-queries, ...).
 */
export interface PlanNode {
  id: string;
  kind: string;
  label: string;
  cost: number | null;
  attrs: [string, unknown][];
  children: PlanNode[];
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isScalarArray(v: unknown[]): boolean {
  return v.every((x) => x === null || typeof x !== "object");
}

export function parseNum(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Pick the most representative cost for a node. `query_block`/operation nodes
 * carry a `query_cost` (whole-subtree cost); `table` nodes carry a cumulative
 * `prefix_cost`. We fall back to read_cost + eval_cost when neither is set.
 */
function nodeCost(costInfo: Record<string, unknown> | undefined): number | null {
  if (!costInfo) return null;
  const qc = parseNum(costInfo.query_cost);
  if (qc !== null) return qc;
  const pc = parseNum(costInfo.prefix_cost);
  if (pc !== null) return pc;
  const rc = parseNum(costInfo.read_cost);
  const ec = parseNum(costInfo.eval_cost);
  if (rc !== null || ec !== null) return (rc ?? 0) + (ec ?? 0);
  return null;
}

const KIND_LABELS: Record<string, string> = {
  query_block: "Query block",
  nested_loop: "Nested loop",
  ordering_operation: "Ordering",
  grouping_operation: "Grouping",
  duplicates_removal: "Duplicates removal",
  buffer_result: "Buffer result",
  materialized_from_subquery: "Materialized subquery",
  union_result: "Union result",
  query_specifications: "Query specifications",
  attached_subqueries: "Attached subqueries",
  optimized_away_subqueries: "Optimized-away subqueries",
  select_list_subqueries: "Select-list subqueries",
  group_by_subqueries: "GROUP BY subqueries",
  order_by_subqueries: "ORDER BY subqueries",
  windowing: "Windowing",
  table: "Table",
};

function humanize(key: string): string {
  return KIND_LABELS[key] ?? key.replace(/_/g, " ");
}

function labelFor(key: string, obj: Record<string, unknown> | null): string {
  if (key === "table" && obj && typeof obj.table_name === "string") {
    return `table: ${obj.table_name}`;
  }
  return humanize(key);
}

// `cost_info` is an object but it is an attribute, not a sub-plan, so it is
// flattened into `attrs` rather than walked as a child.
const ATTR_OBJECT_KEYS = new Set(["cost_info"]);

function buildNode(key: string, obj: Record<string, unknown>, path: string): PlanNode {
  const attrs: [string, unknown][] = [];
  let costInfo: Record<string, unknown> | undefined;
  for (const [k, v] of Object.entries(obj)) {
    if (k === "cost_info" && isPlainObject(v)) {
      costInfo = v;
      for (const [ck, cv] of Object.entries(v)) attrs.push([`cost_info.${ck}`, cv]);
      continue;
    }
    if (isPlainObject(v)) continue; // structural child
    if (Array.isArray(v)) {
      if (isScalarArray(v)) attrs.push([k, v]); // scalar array → attribute
      continue; // structural array → child
    }
    attrs.push([k, v]); // scalar attribute
  }
  return {
    id: path,
    kind: key,
    label: labelFor(key, obj),
    cost: nodeCost(costInfo),
    attrs,
    children: buildChildren(obj, path),
  };
}

function buildChildren(obj: Record<string, unknown>, path: string): PlanNode[] {
  const out: PlanNode[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (ATTR_OBJECT_KEYS.has(k)) continue;
    if (isPlainObject(v)) {
      out.push(buildNode(k, v, `${path}/${k}`));
    } else if (Array.isArray(v) && v.some(isPlainObject)) {
      // Structural arrays (nested_loop, query_specifications, *_subqueries).
      // Each element typically wraps a single sub-plan (e.g. nested_loop
      // elements are `{ table: {...} }`), so we splice the element's own
      // children in to avoid an empty intermediate wrapper per element.
      const arrPath = `${path}/${k}`;
      const children: PlanNode[] = [];
      v.forEach((el, i) => {
        if (isPlainObject(el)) children.push(...buildChildren(el, `${arrPath}/${i}`));
      });
      out.push({ id: arrPath, kind: k, label: humanize(k), cost: null, attrs: [], children });
    }
  }
  return out;
}

export function parsePlan(json: string): { root: PlanNode | null; error: string | null } {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (e) {
    return { root: null, error: e instanceof Error ? e.message : String(e) };
  }
  if (!isPlainObject(data)) return { root: null, error: "unexpected plan shape" };
  if (isPlainObject(data.query_block)) {
    return { root: buildNode("query_block", data.query_block, "query_block"), error: null };
  }
  return { root: buildNode("plan", data, "plan"), error: null };
}

export function maxCost(node: PlanNode): number {
  let m = node.cost ?? 0;
  for (const c of node.children) m = Math.max(m, maxCost(c));
  return m;
}

export function collectIds(node: PlanNode, into: string[]): void {
  into.push(node.id);
  for (const c of node.children) collectIds(c, into);
}

export function findNode(node: PlanNode, id: string): PlanNode | null {
  if (node.id === id) return node;
  for (const c of node.children) {
    const hit = findNode(c, id);
    if (hit) return hit;
  }
  return null;
}

export type Heat = "" | "warm" | "hot";

export function heatFor(cost: number | null, max: number): Heat {
  if (cost === null || max <= 0) return "";
  const r = cost / max;
  if (r >= 0.66) return "hot";
  if (r >= 0.33) return "warm";
  return "";
}

export function attrVal(node: PlanNode, key: string): unknown {
  const hit = node.attrs.find(([k]) => k === key);
  return hit ? hit[1] : undefined;
}

export function formatNumber(n: number): string {
  if (Number.isInteger(n)) return n.toLocaleString();
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export function formatValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (Array.isArray(v)) return v.map((x) => formatValue(x)).join(", ");
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return formatNumber(v);
  return String(v);
}

export type HintSeverity = "info" | "caution" | "warning";

export interface PlanHint {
  severity: HintSeverity;
  key: I18nKey;
}

// `rows_examined_per_scan` above these thresholds is flagged so juniors notice
// scans that won't scale. Tuned conservatively to avoid false alarms on the
// small tables that dominate development databases.
const ROWS_CAUTION_THRESHOLD = 100_000;
const ROWS_WARNING_THRESHOLD = 1_000_000;

export const SEVERITY_RANK: Record<HintSeverity, number> = { info: 0, caution: 1, warning: 2 };

// Reads a node's raw MySQL EXPLAIN attributes and derives plain-language
// performance hints. Each hint maps to an i18n key explaining the cause and a
// concrete fix. Returns an empty array when nothing notable is found.
export function computeHints(node: PlanNode): PlanHint[] {
  const hints: PlanHint[] = [];

  if (node.kind === "table") {
    const access = attrVal(node, "access_type");
    if (access === "ALL") {
      hints.push({ severity: "warning", key: "explainHintFullScan" });
    } else if (access === "index") {
      hints.push({ severity: "caution", key: "explainHintFullIndexScan" });
    }
    if (typeof attrVal(node, "using_join_buffer") === "string") {
      hints.push({ severity: "caution", key: "explainHintJoinBuffer" });
    }
    const rows = parseNum(attrVal(node, "rows_examined_per_scan"));
    if (rows !== null && rows >= ROWS_WARNING_THRESHOLD) {
      hints.push({ severity: "warning", key: "explainHintManyRows" });
    } else if (rows !== null && rows >= ROWS_CAUTION_THRESHOLD) {
      hints.push({ severity: "caution", key: "explainHintManyRows" });
    }
    if (attrVal(node, "using_index") === true) {
      hints.push({ severity: "info", key: "explainHintCoveringIndex" });
    }
  }

  // Sort/group bookkeeping flags can appear on operation nodes regardless of
  // kind, so they are checked on every node.
  if (attrVal(node, "using_temporary_table") === true) {
    hints.push({ severity: "caution", key: "explainHintTempTable" });
  }
  if (attrVal(node, "using_filesort") === true) {
    hints.push({ severity: "caution", key: "explainHintFilesort" });
  }

  return hints;
}

export function worstSeverity(hints: PlanHint[]): HintSeverity | null {
  let worst: HintSeverity | null = null;
  for (const h of hints) {
    if (worst === null || SEVERITY_RANK[h.severity] > SEVERITY_RANK[worst]) worst = h.severity;
  }
  return worst;
}

export function severityLabelKey(s: HintSeverity): I18nKey {
  if (s === "warning") return "explainSeverityWarning";
  if (s === "caution") return "explainSeverityCaution";
  return "explainSeverityInfo";
}

// --- 重さスコア (0=軽い 〜 100=重い) -------------------------------------
//
// EXPLAIN の見積りコストと、検出したパフォーマンスリスク (フルスキャン・
// filesort 等) を 0〜100 の単一スコアに合成する。これは実測ではなく
// オプティマイザの見積りに基づく「相対的な重さの目安」であり、絶対的な実行
// 速度を保証するものではない (ヘルプ/ツールチップにも明記)。

export type ScoreBand = "low" | "mid" | "high";

export interface PlanScore {
  /** 0 (軽い) 〜 100 (重い) に丸めた総合スコア。 */
  score: number;
  /** 色・文言の出し分けに使う粗い帯。 */
  band: ScoreBand;
  /** コスト由来のサブスコア (0〜100)。透明性のため保持する。 */
  costScore: number;
  /** リスク (ヒント) 由来のサブスコア (0〜100)。 */
  riskScore: number;
  /** プランにコスト情報が無く、リスクのみでスコアを出した場合 true。 */
  costMissing: boolean;
}

// コストは桁が大きく開く (1 〜 数百万) ため対数スケールで正規化する。
// FLOOR 以下は 0、CEIL 以上は 100、その間を log10 で線形補間する。
const COST_FLOOR = 10;
const COST_CEIL = 1_000_000;

function costToScore(cost: number | null): { score: number; missing: boolean } {
  if (cost === null || cost <= 0) return { score: 0, missing: true };
  if (cost <= COST_FLOOR) return { score: 0, missing: false };
  if (cost >= COST_CEIL) return { score: 100, missing: false };
  const r =
    (Math.log10(cost) - Math.log10(COST_FLOOR)) /
    (Math.log10(COST_CEIL) - Math.log10(COST_FLOOR));
  return { score: r * 100, missing: false };
}

// ヒントの重大度ごとの加点。info (カバリングインデックス等の良い兆候) は
// 加点しない。プラン全体のヒントを合算し 100 で頭打ちにする。
const HINT_WEIGHT: Record<HintSeverity, number> = { info: 0, caution: 12, warning: 30 };

function riskToScore(root: PlanNode): number {
  let sum = 0;
  const walk = (n: PlanNode) => {
    for (const h of computeHints(n)) sum += HINT_WEIGHT[h.severity];
    n.children.forEach(walk);
  };
  walk(root);
  return Math.min(100, sum);
}

function bandFor(score: number): ScoreBand {
  if (score >= 67) return "high";
  if (score >= 34) return "mid";
  return "low";
}

/**
 * プランツリー全体から重さスコアを算出する。コストが「今どれだけ重いか」を
 * 主に決め、リスクがスケールしないプランを押し上げる補正として効く。
 * オプティマイザがコストを返さなかった場合はリスクのみで評価する。
 */
export function scorePlan(root: PlanNode): PlanScore {
  const { score: costScore, missing } = costToScore(root.cost);
  const riskScore = riskToScore(root);
  const raw = missing ? riskScore : 0.65 * costScore + 0.35 * riskScore;
  const score = Math.round(Math.min(100, Math.max(0, raw)));
  return {
    score,
    band: bandFor(score),
    costScore: Math.round(costScore),
    riskScore: Math.round(riskScore),
    costMissing: missing,
  };
}
