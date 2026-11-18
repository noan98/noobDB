import { actualTotalMs, findNode, hasActual, planAncestorIds, type PlanNode } from "./explainPlan";

/**
 * 実行計画の「時間配分」アイシクル図 (#2407) の純粋ロジック層。
 *
 * 自己時間 (子を引いた、そのノード自身の時間) の計算と、横幅 = 包含時間の矩形配置だけを
 * 担当し、React / SVG には依存しない (`ExplainIcicleView.tsx` が描画する)。
 * `src/__tests__/explainIcicle.test.ts` でユニットテストする。
 */

/** 図が使う量。`actual` = EXPLAIN ANALYZE の実測時間 (ms)、`cost` = 推定コスト。 */
export type IcicleBasis = "actual" | "cost";

/** ホットスポットとして強調するノード数。 */
export const ICICLE_HOTSPOT_COUNT = 3;

/** 子の合計が親を超えた分がこの割合 (または絶対値) 以下なら丸め誤差とみなし「推定」にしない。 */
const CLAMP_REL_TOLERANCE = 0.001;
const CLAMP_ABS_TOLERANCE = 0.001;

/** 描画する最小の相対幅。これ未満の矩形は見えないので描かない。 */
export const ICICLE_MIN_VISIBLE_WIDTH = 0.002;

/** 実測があればその時間、無ければ推定コストで描く。 */
export function icicleBasis(root: PlanNode): IcicleBasis {
  return hasActual(root) && anyActualTime(root) ? "actual" : "cost";
}

function anyActualTime(node: PlanNode): boolean {
  if (actualTotalMs(node) !== null) return true;
  return node.children.some(anyActualTime);
}

/**
 * ノード自身が申告する包含値 (子の分を含む)。
 * - actual: `totalMs × loops`。実測を持つが時間が無いノード (一度も実行されなかった) は 0。
 *   実測を持たない中継ノード (MySQL JSON のラッパーなど) は null。
 * - cost: ノードの推定コスト (無ければ null)。
 * 負値・非有限は 0 に丸める。
 */
export function nodeInclusive(node: PlanNode, basis: IcicleBasis): number | null {
  let v: number | null;
  if (basis === "actual") {
    v = actualTotalMs(node);
    if (v === null && node.actual) v = 0;
  } else {
    v = node.cost;
  }
  if (v === null) return null;
  return Number.isFinite(v) && v > 0 ? v : 0;
}

export interface SelfTimeEntry {
  id: string;
  /** 包含値。自身が申告しない中継ノードは子の包含値の和。 */
  inclusive: number;
  /** 自己値 = max(0, 包含 − 子の包含の和)。 */
  self: number;
  /** 子の合計が自身を超え、自己値を 0 へ丸めた (並列ワーカー / loops 由来)。 */
  clamped: boolean;
}

/**
 * 全ノードの包含値と自己値を計算する。
 * 並列 (PostgreSQL の `Gather` の下は loops = ワーカー数 + 1) や MySQL の loops で
 * 子の包含値の和が親を超えることがあり、その場合の自己値は 0 に丸めて `clamped` を立てる。
 */
export function computeSelfTimes(root: PlanNode, basis: IcicleBasis): Map<string, SelfTimeEntry> {
  const out = new Map<string, SelfTimeEntry>();
  const walk = (node: PlanNode): number => {
    let childSum = 0;
    for (const c of node.children) childSum += walk(c);
    const own = nodeInclusive(node, basis);
    const inclusive = own ?? childSum;
    const over = childSum - inclusive;
    const clamped = own !== null && over > Math.max(CLAMP_ABS_TOLERANCE, inclusive * CLAMP_REL_TOLERANCE);
    out.set(node.id, { id: node.id, inclusive, self: Math.max(0, inclusive - childSum), clamped });
    return inclusive;
  };
  walk(root);
  return out;
}

export interface IcicleRect {
  id: string;
  label: string;
  /** 描画の基準 (ズーム先) からの深さ。基準ノードが 0。 */
  depth: number;
  parentId: string | null;
  childIds: string[];
  /** 左端と幅 (基準ノードの幅が 1 の相対値)。 */
  x: number;
  w: number;
  inclusive: number;
  self: number;
  /** 自己値が計画全体 (ルートの包含値) に占める割合 (0–1)。 */
  share: number;
  /** 色の濃さ (0–1) = 自己値 / 計画内の最大の自己値。ズームしても色が変わらない。 */
  heat: number;
  clamped: boolean;
}

export interface IcicleHotspot {
  id: string;
  label: string;
  self: number;
  share: number;
}

export interface IcicleLayout {
  basis: IcicleBasis;
  focusId: string;
  /** 基準ノードの包含値 (幅 1 に相当)。 */
  focusTotal: number;
  /** 計画全体 (ルート) の包含値。 */
  planTotal: number;
  rects: IcicleRect[];
  /** 基準ノードからの最大の深さ。 */
  maxDepth: number;
  /** 計画全体の自己値の上位 (ズームしても変わらない)。 */
  hotspots: IcicleHotspot[];
  /** 子の合計が親を超えて自己値を丸めたノードがある (「推定」と注記する)。 */
  estimated: boolean;
}

/**
 * アイシクル図の矩形を配置する。`focusId` を指すと、その部分木が幅 1 になる (ズーム)。
 * 子の幅は 親の幅 × 子の包含値 / max(親の包含値, 子の包含値の和) で、子の合計が親を超えても
 * 親の枠からはみ出さない (超えた分は縮小)。親が余る分 (自己値) は右端に空きとして残る。
 * 描く量が無い (ルートの包含値が 0) とき、または `focusId` が無いときは null。
 */
export function layoutIcicle(root: PlanNode, basis: IcicleBasis, focusId?: string): IcicleLayout | null {
  const times = computeSelfTimes(root, basis);
  const planTotal = times.get(root.id)?.inclusive ?? 0;
  if (!(planTotal > 0)) return null;
  const focus = focusId ? findNode(root, focusId) : root;
  if (!focus) return null;
  const focusTotal = times.get(focus.id)?.inclusive ?? 0;
  if (!(focusTotal > 0)) return null;

  let maxSelf = 0;
  for (const e of times.values()) maxSelf = Math.max(maxSelf, e.self);

  const rects: IcicleRect[] = [];
  const place = (node: PlanNode, depth: number, parentId: string | null, x: number, w: number) => {
    const e = times.get(node.id);
    if (!e) return;
    rects.push({
      id: node.id,
      label: node.label,
      depth,
      parentId,
      childIds: node.children.map((c) => c.id),
      x,
      w,
      inclusive: e.inclusive,
      self: e.self,
      share: e.self / planTotal,
      heat: maxSelf > 0 ? e.self / maxSelf : 0,
      clamped: e.clamped,
    });
    let childSum = 0;
    for (const c of node.children) childSum += times.get(c.id)?.inclusive ?? 0;
    const denom = Math.max(e.inclusive, childSum);
    if (!(denom > 0)) return;
    let cx = x;
    for (const c of node.children) {
      const cw = (w * (times.get(c.id)?.inclusive ?? 0)) / denom;
      place(c, depth + 1, node.id, cx, cw);
      cx += cw;
    }
  };
  place(focus, 0, null, 0, 1);

  const all = [...times.values()];
  const order = new Map<string, number>();
  const labelOf = new Map<string, string>();
  const index = (n: PlanNode) => {
    order.set(n.id, order.size);
    labelOf.set(n.id, n.label);
    n.children.forEach(index);
  };
  index(root);
  const hotspots = all
    .filter((e) => e.self > 0)
    .sort((a, b) => b.self - a.self || (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
    .slice(0, ICICLE_HOTSPOT_COUNT)
    .map((e) => ({ id: e.id, label: labelOf.get(e.id) ?? e.id, self: e.self, share: e.self / planTotal }));

  return {
    basis,
    focusId: focus.id,
    focusTotal,
    planTotal,
    rects,
    maxDepth: rects.reduce((m, r) => Math.max(m, r.depth), 0),
    hotspots,
    estimated: all.some((e) => e.clamped),
  };
}

/** ルートからズーム先までのパンくず (ルート → … → ズーム先)。見つからなければ空。 */
export function icicleBreadcrumb(root: PlanNode, focusId: string): { id: string; label: string }[] {
  const target = findNode(root, focusId);
  if (!target) return [];
  const out: { id: string; label: string }[] = [];
  for (const id of planAncestorIds(root, focusId)) {
    const n = findNode(root, id);
    if (n) out.push({ id: n.id, label: n.label });
  }
  out.push({ id: target.id, label: target.label });
  return out;
}

/** `id` が (ズーム先の) 部分木に含まれるか。 */
export function icicleHasNode(layout: IcicleLayout, id: string): boolean {
  return layout.rects.some((r) => r.id === id);
}
