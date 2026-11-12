// サブセット抽出プレビューの「親 ← 起点 → 子」の FK 辿り図の純ロジック (#2266)。
//
// プレビュー (`SubsetPreview`) と外部キー一覧 (`api.foreignKeys`) から、表をどのレーンに置くか・
// 行数バーの割合・深さ・循環と打ち切りの印・多いときの `+N` への折りたたみ・エッジの曲線を決める。
// 描画は SubsetPreviewGraph.tsx。DOM に依存しないので Vitest で直接検証する。

import type { ForeignKey, SubsetPreview, SubsetTablePreview } from "../api/tauri";

export type SubsetLane = "parent" | "root" | "child";

/** 左 (親) → 中央 (起点) → 右 (子) の並び。 */
export const SUBSET_LANES: readonly SubsetLane[] = ["parent", "root", "child"];

/** 表がこの数以上のとき、レーンの中を `+N` へ折りたたむ。 */
export const COLLAPSE_THRESHOLD = 12;
/** 折りたたむとき、1 レーンに残す表の数 (印の付いた表は数えずに必ず残す)。 */
export const LANE_VISIBLE = 4;

export interface SubsetTruncation {
  kind: "root" | "child";
  limit: number;
}

export interface SubsetNode {
  id: string;
  table: string;
  lane: SubsetLane;
  rows: number;
  rootRows: number;
  childRows: number;
  parentRows: number;
  /** 起点からの外部キーの段数 (起点は 0。辿れなければ 1)。 */
  depth: number;
  /** 最大の行数に対する割合 (0〜1)。 */
  share: number;
  truncations: SubsetTruncation[];
  cycle: boolean;
}

export interface SubsetEdge {
  /** 外部キーを持つ側 (子)。 */
  from: string;
  /** 参照される側 (親)。 */
  to: string;
}

export interface SubsetGraph {
  nodes: SubsetNode[];
  edges: SubsetEdge[];
  /** 親方向・子方向それぞれの最大の段数。 */
  parentDepth: number;
  childDepth: number;
}

/**
 * 表の所属レーン。起点の行があれば起点、子だけなら子、親だけなら親。
 * 子と親の両方で出た表 (循環や共有の親) は行数の多いほう、同数なら親 (最後まで辿る側) に置く。
 */
export function assignLane(t: Pick<SubsetTablePreview, "rootRows" | "childRows" | "parentRows">): SubsetLane {
  if (t.rootRows > 0) return "root";
  if (t.childRows > 0 && t.parentRows === 0) return "child";
  if (t.parentRows > 0 && t.childRows === 0) return "parent";
  return t.childRows > t.parentRows ? "child" : "parent";
}

/** 表名 → 起点からの距離 (幅優先)。`next` が辿る向き、`allow` が通ってよい表。 */
function bfsDepth(
  starts: string[],
  next: Map<string, string[]>,
  allow: (id: string) => boolean,
): Map<string, number> {
  const dist = new Map<string, number>();
  const queue: string[] = [];
  for (const s of starts) {
    dist.set(s, 0);
    queue.push(s);
  }
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head];
    const d = dist.get(cur) ?? 0;
    for (const n of next.get(cur) ?? []) {
      if (dist.has(n) || !allow(n)) continue;
      dist.set(n, d + 1);
      queue.push(n);
    }
  }
  return dist;
}

function pushTo(map: Map<string, string[]>, key: string, value: string) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

export function buildSubsetGraph(preview: SubsetPreview, foreignKeys: readonly ForeignKey[]): SubsetGraph {
  const known = new Set(preview.tables.map((t) => t.table));
  const cycleTables = new Set(preview.cycles.flat());
  const maxRows = preview.tables.reduce((m, t) => Math.max(m, t.rows), 0);

  const truncations = new Map<string, SubsetTruncation[]>();
  for (const w of preview.warnings) {
    if (w.kind !== "childTruncated" && w.kind !== "rootTruncated") continue;
    const list = truncations.get(w.table) ?? [];
    list.push({ kind: w.kind === "rootTruncated" ? "root" : "child", limit: w.limit });
    truncations.set(w.table, list);
  }

  // エッジ: プレビューに含まれる表どうしの外部キー (自己参照・重複は除く)。
  const edgeKeys = new Set<string>();
  const edges: SubsetEdge[] = [];
  for (const fk of foreignKeys) {
    if (fk.table === fk.referenced_table) continue;
    if (!known.has(fk.table) || !known.has(fk.referenced_table)) continue;
    const key = `${fk.table}\u0000${fk.referenced_table}`;
    if (edgeKeys.has(key)) continue;
    edgeKeys.add(key);
    edges.push({ from: fk.table, to: fk.referenced_table });
  }
  const up = new Map<string, string[]>();
  const down = new Map<string, string[]>();
  for (const e of edges) {
    pushTo(up, e.from, e.to);
    pushTo(down, e.to, e.from);
  }

  const lanes = new Map(preview.tables.map((t) => [t.table, assignLane(t)] as const));
  const rootIds = preview.tables.filter((t) => lanes.get(t.table) === "root").map((t) => t.table);
  const childDist = bfsDepth(rootIds, down, (id) => lanes.get(id) !== "parent");
  const parentDist = bfsDepth(rootIds, up, () => true);

  const nodes: SubsetNode[] = preview.tables.map((t) => {
    const lane = lanes.get(t.table) ?? "root";
    const dist = lane === "child" ? childDist.get(t.table) : lane === "parent" ? parentDist.get(t.table) : 0;
    return {
      id: t.table,
      table: t.table,
      lane,
      rows: t.rows,
      rootRows: t.rootRows,
      childRows: t.childRows,
      parentRows: t.parentRows,
      depth: lane === "root" ? 0 : Math.max(1, dist ?? 1),
      share: maxRows > 0 ? t.rows / maxRows : 0,
      truncations: truncations.get(t.table) ?? [],
      cycle: cycleTables.has(t.table),
    };
  });

  const maxDepthOf = (lane: SubsetLane) =>
    nodes.reduce((m, n) => (n.lane === lane ? Math.max(m, n.depth) : m), 0);
  return { nodes, edges, parentDepth: maxDepthOf("parent"), childDepth: maxDepthOf("child") };
}

/** レーン内の並び: 起点に近い (段数が小さい) 順 → 行数の多い順 → 表名。 */
function compareNodes(a: SubsetNode, b: SubsetNode): number {
  return a.depth - b.depth || b.rows - a.rows || a.table.localeCompare(b.table);
}

export interface SubsetMoreItem {
  kind: "more";
  id: string;
  lane: SubsetLane;
  /** 折りたたまれた表の数。 */
  count: number;
  /** 折りたたまれた表の行数の合計。 */
  rows: number;
  /** 折りたたまれた表の名前 (ツールチップ用)。 */
  tables: string[];
}
export interface SubsetNodeItem {
  kind: "node";
  id: string;
  node: SubsetNode;
}
export type SubsetLaneItem = SubsetNodeItem | SubsetMoreItem;

export interface CollapseOptions {
  threshold?: number;
  laneVisible?: number;
  /** 展開済みのレーン (折りたたまない)。 */
  expanded?: ReadonlySet<SubsetLane>;
}

/** 表を折りたたみ対象にするか (総数が閾値以上)。 */
export function shouldCollapse(total: number, threshold = COLLAPSE_THRESHOLD): boolean {
  return total >= threshold;
}

/**
 * 各レーンの表示項目を決める。折りたたむときは、起点・印 (循環 / 打ち切り) の付いた表を必ず残し、
 * 残りの枠を行数の多い順に埋め、あふれた表を 1 つの `+N` にまとめる (1 つだけあふれるなら、そのまま表示)。
 */
export function collapseLanes(
  nodes: readonly SubsetNode[],
  opts: CollapseOptions = {},
): Record<SubsetLane, SubsetLaneItem[]> {
  const { threshold = COLLAPSE_THRESHOLD, laneVisible = LANE_VISIBLE, expanded } = opts;
  const collapse = shouldCollapse(nodes.length, threshold);
  const out: Record<SubsetLane, SubsetLaneItem[]> = { parent: [], root: [], child: [] };
  for (const lane of SUBSET_LANES) {
    const laneNodes = nodes.filter((n) => n.lane === lane).sort(compareNodes);
    const asItems = (list: SubsetNode[]): SubsetLaneItem[] =>
      list.map((node) => ({ kind: "node", id: node.id, node }));
    if (!collapse || lane === "root" || expanded?.has(lane) || laneNodes.length <= laneVisible + 1) {
      out[lane] = asItems(laneNodes);
      continue;
    }
    const must = laneNodes.filter((n) => n.cycle || n.truncations.length > 0);
    const rest = laneNodes
      .filter((n) => !must.includes(n))
      .sort((a, b) => b.rows - a.rows || a.table.localeCompare(b.table));
    const room = Math.max(0, laneVisible - must.length);
    const shown = new Set<SubsetNode>([...must, ...rest.slice(0, room)]);
    const hidden = laneNodes.filter((n) => !shown.has(n));
    if (hidden.length < 2) {
      out[lane] = asItems(laneNodes);
      continue;
    }
    out[lane] = [
      ...asItems(laneNodes.filter((n) => shown.has(n))),
      {
        kind: "more",
        id: `more:${lane}`,
        lane,
        count: hidden.length,
        rows: hidden.reduce((s, n) => s + n.rows, 0),
        tables: hidden.map((n) => n.table),
      },
    ];
  }
  return out;
}

export interface PlacedEdge {
  from: string;
  to: string;
  /** SVG の path (`d`)。座標は `GEOMETRY` の単位 (レーン幅 3・溝 1) で、縦は 1 行 = 1。 */
  d: string;
}

/** 図の幾何 (SVG の viewBox の単位)。レーン幅 3・溝 1 の「レーン 溝 レーン 溝 レーン」。 */
export const GEOMETRY = {
  laneWidth: 3,
  gutter: 1,
  /** viewBox の幅。 */
  width: 11,
} as const;

function laneLeft(lane: SubsetLane): number {
  return SUBSET_LANES.indexOf(lane) * (GEOMETRY.laneWidth + GEOMETRY.gutter);
}

/**
 * 外部キー (`from` が `to` を参照) を、レーン上の位置の間の曲線にする。
 * 別のレーンどうしは近い側の縁から縁へ、同じレーンの中どうしは起点側の溝へ張り出す曲線にする。
 * 折りたたまれた表は `+N` の項目へ付け替え、同じ項目どうしの辺と重複は捨てる。
 */
export function layoutEdges(
  lanes: Record<SubsetLane, SubsetLaneItem[]>,
  edges: readonly SubsetEdge[],
): PlacedEdge[] {
  const pos = new Map<string, { lane: SubsetLane; row: number; id: string }>();
  for (const lane of SUBSET_LANES) {
    lanes[lane].forEach((item, row) => {
      if (item.kind === "node") pos.set(item.node.table, { lane, row, id: item.id });
      else for (const t of item.tables) pos.set(t, { lane, row, id: item.id });
    });
  }
  const seen = new Set<string>();
  const out: PlacedEdge[] = [];
  for (const e of edges) {
    const a = pos.get(e.from);
    const b = pos.get(e.to);
    if (!a || !b || a.id === b.id) continue;
    const key = `${a.id}\u0000${b.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const y1 = a.row + 0.5;
    const y2 = b.row + 0.5;
    const li = SUBSET_LANES.indexOf(a.lane);
    const lj = SUBSET_LANES.indexOf(b.lane);
    let d: string;
    if (li === lj) {
      // 同じレーン: 起点側 (parent/root は右、child は左) の縁から溝へ張り出す。
      const edgeX = a.lane === "child" ? laneLeft(a.lane) : laneLeft(a.lane) + GEOMETRY.laneWidth;
      const bulge = a.lane === "child" ? -GEOMETRY.gutter * 0.8 : GEOMETRY.gutter * 0.8;
      d = `M ${edgeX} ${y1} C ${edgeX + bulge} ${y1}, ${edgeX + bulge} ${y2}, ${edgeX} ${y2}`;
    } else {
      // from が右 (li > lj) なら from の左縁 → to の右縁。逆なら from の右縁 → to の左縁。
      const x1 = li > lj ? laneLeft(a.lane) : laneLeft(a.lane) + GEOMETRY.laneWidth;
      const x2 = li > lj ? laneLeft(b.lane) + GEOMETRY.laneWidth : laneLeft(b.lane);
      const mid = (x1 + x2) / 2;
      d = `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`;
    }
    out.push({ from: e.from, to: e.to, d });
  }
  return out;
}

/** 行数バーの幅の割合 (%)。0 行でなければ最低 4% を確保して、小さい値でも見えるようにする。 */
export function barPercent(share: number): number {
  if (!(share > 0)) return 0;
  return Math.max(4, Math.round(Math.min(1, share) * 100));
}
