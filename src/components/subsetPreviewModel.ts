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
  /** 含まれる循環の表名 (循環でなければ空)。 */
  cycleTables: string[];
  /** この表が外部キーで参照している表 (図に出ているものだけ)。 */
  references: string[];
}

export interface SubsetEdge {
  /** 外部キーを持つ側 (子)。 */
  from: string;
  /** 参照される側 (親)。 */
  to: string;
  /** この辺をなす外部キーの列名 (`子.列 → 親.列`)。同じ表どうしの複数の外部キーはまとめる (#2293)。 */
  labels: string[];
}

/** 辺の識別子 (子 → 親)。 */
export function edgeKey(from: string, to: string): string {
  return `${from}\u0000${to}`;
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
  // 参照先の列が分からず辿れなかった外部キーはエッジにしない。
  const unresolved = new Set(
    preview.warnings.flatMap((w) =>
      w.kind === "unresolvedForeignKey" ? [`${w.table}\u0000${w.constraint}`] : [],
    ),
  );
  const edgeByKey = new Map<string, SubsetEdge>();
  const edges: SubsetEdge[] = [];
  for (const fk of foreignKeys) {
    if (fk.table === fk.referenced_table) continue;
    if (!known.has(fk.table) || !known.has(fk.referenced_table)) continue;
    if (fk.constraint_name !== null && unresolved.has(`${fk.table}\u0000${fk.constraint_name}`)) continue;
    const label = `${fk.table}.${fk.column} → ${fk.referenced_table}.${fk.referenced_column ?? "?"}`;
    const key = edgeKey(fk.table, fk.referenced_table);
    const existing = edgeByKey.get(key);
    if (existing) {
      if (!existing.labels.includes(label)) existing.labels.push(label);
      continue;
    }
    const edge: SubsetEdge = { from: fk.table, to: fk.referenced_table, labels: [label] };
    edgeByKey.set(key, edge);
    edges.push(edge);
  }
  const up = new Map<string, string[]>();
  const down = new Map<string, string[]>();
  for (const e of edges) {
    pushTo(up, e.from, e.to);
    pushTo(down, e.to, e.from);
  }

  const lanes = new Map(preview.tables.map((t) => [t.table, assignLane(t)] as const));
  const rootIds = preview.tables.filter((t) => lanes.get(t.table) === "root").map((t) => t.table);
  // 辿れるかどうかは表示レーンではなく行の役割で決める。親と子の両方の行を持つ表は
  // 親レーンに置かれることがあるが、子の経路の中継点でもあるので子の BFS から外さない。
  const byTable = new Map(preview.tables.map((t) => [t.table, t] as const));
  const hasChildRole = (id: string) => {
    const t = byTable.get(id);
    return !!t && (t.childRows > 0 || t.rootRows > 0);
  };
  const childDist = bfsDepth(rootIds, down, hasChildRole);
  // 親は「起点か子の行を持つすべての表」から辿る (子経由で取り込まれた親も段数を持つ)。
  const parentStarts = preview.tables.filter((t) => hasChildRole(t.table)).map((t) => t.table);
  const parentDist = bfsDepth(parentStarts, up, () => true);

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
      cycleTables: preview.cycles.find((c) => c.includes(t.table)) ?? [],
      references: up.get(t.table) ?? [],
    };
  });

  const maxDepthOf = (lane: SubsetLane) =>
    nodes.reduce((m, n) => (n.lane === lane ? Math.max(m, n.depth) : m), 0);
  return { nodes, edges, parentDepth: maxDepthOf("parent"), childDepth: maxDepthOf("child") };
}

export interface SubsetPath {
  /** 経路上の表 (起点の表自身と、たどり着いた起点レーンの表を含む)。 */
  tables: Set<string>;
  /** 経路上の辺。 */
  edges: SubsetEdge[];
}

/**
 * `table` から起点 (起点レーンの表) までの外部キーの経路 (#2293)。
 * `buildSubsetGraph` の段数 (`parentDist` / `childDist`) と同じ意味で、2 局面の幅優先で辿る。
 * - 局面「親」: 子の方向 (参照している側) へ進む。子の行か起点の行を持つ表 (`hasChildRole`) に着いたら、局面「子」へも移れる。
 * - 局面「子」: 親の方向へ進む。子の行か起点の行を持つ表の中だけを通る (親だけの表は中継しない)。
 * 子レーンの表は局面「子」から、親レーンの表は局面「親」から (子の行も持つなら局面「子」からも) 始める。
 * 最も近い起点までの最短経路の辺をすべて返す。訪問済みは (表, 局面) 単位なので循環があっても停止する。
 * 起点自身・起点へ着かない表は、その表だけを含む空の経路。
 */
export function tracePathToRoot(graph: Pick<SubsetGraph, "nodes" | "edges">, table: string): SubsetPath {
  const self: SubsetPath = { tables: new Set([table]), edges: [] };
  const byTable = new Map(graph.nodes.map((n) => [n.table, n] as const));
  const start = byTable.get(table);
  if (!start || start.lane === "root") return self;
  const hasChildRole = (id: string) => {
    const n = byTable.get(id);
    return !!n && (n.childRows > 0 || n.rootRows > 0);
  };
  type Phase = "parent" | "child";
  const key = (t: string, ph: Phase) => `${t}\u0000${ph}`;
  const split = (k: string) => k.split("\u0000")[0];
  const up = new Map<string, SubsetEdge[]>(); // 子 → 親へ (e.from === cur)
  const down = new Map<string, SubsetEdge[]>(); // 親 → 子へ (e.to === cur)
  for (const e of graph.edges) {
    const u = up.get(e.from);
    if (u) u.push(e);
    else up.set(e.from, [e]);
    const d = down.get(e.to);
    if (d) d.push(e);
    else down.set(e.to, [e]);
  }

  const dist = new Map<string, number>();
  const preds = new Map<string, { state: string; edge: SubsetEdge }[]>();
  const queue: { t: string; ph: Phase }[] = [];
  const enqueue = (t: string, ph: Phase, d: number) => {
    dist.set(key(t, ph), d);
    queue.push({ t, ph });
  };
  if (start.lane === "child") enqueue(table, "child", 0);
  else {
    enqueue(table, "parent", 0);
    if (hasChildRole(table)) enqueue(table, "child", 0);
  }

  let rootDist = Number.POSITIVE_INFINITY;
  const rootStates: string[] = [];
  const reach = (t: string, ph: Phase, d: number, from: string, edge: SubsetEdge) => {
    const k = key(t, ph);
    const nd = dist.get(k);
    if (nd === undefined) {
      dist.set(k, d);
      preds.set(k, [{ state: from, edge }]);
      if (byTable.get(t)?.lane === "root") {
        if (d <= rootDist) {
          rootDist = d;
          rootStates.push(k);
        }
      } else {
        queue.push({ t, ph });
      }
    } else if (nd === d) {
      preds.get(k)?.push({ state: from, edge });
    }
  };
  for (let head = 0; head < queue.length; head++) {
    const { t, ph } = queue[head];
    const from = key(t, ph);
    const d = (dist.get(from) ?? 0) + 1;
    if (d > rootDist) break;
    if (ph === "parent") {
      for (const e of down.get(t) ?? []) {
        reach(e.from, "parent", d, from, e);
        if (hasChildRole(e.from)) reach(e.from, "child", d, from, e);
      }
    } else {
      for (const e of up.get(t) ?? []) {
        if (hasChildRole(e.to)) reach(e.to, "child", d, from, e);
      }
    }
  }
  const roots = rootStates.filter((k) => dist.get(k) === rootDist);
  if (roots.length === 0) return self;
  const tables = new Set<string>([table]);
  const edgeSet = new Set<SubsetEdge>();
  const seen = new Set<string>(roots);
  const stack = [...roots];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    tables.add(split(cur));
    for (const pr of preds.get(cur) ?? []) {
      edgeSet.add(pr.edge);
      if (!seen.has(pr.state)) {
        seen.add(pr.state);
        stack.push(pr.state);
      }
    }
  }
  return { tables, edges: [...edgeSet] };
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
  /** この曲線がまとめている辺の識別子 (`edgeKey`)。折りたたみで複数の辺が 1 本になることがある。 */
  keys: string[];
  /** この曲線がまとめている辺の列名 (`子.列 → 親.列`)。 */
  labels: Record<string, string[]>;
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
  const seen = new Map<string, PlacedEdge>();
  const out: PlacedEdge[] = [];
  for (const e of edges) {
    const a = pos.get(e.from);
    const b = pos.get(e.to);
    if (!a || !b || a.id === b.id) continue;
    const key = `${a.id}\u0000${b.id}`;
    const dup = seen.get(key);
    if (dup) {
      dup.keys.push(edgeKey(e.from, e.to));
      dup.labels[edgeKey(e.from, e.to)] = e.labels;
      continue;
    }
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
      const mx = (x1 + x2) / 2;
      d = `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
    }
    const k = edgeKey(e.from, e.to);
    const placed: PlacedEdge = { from: e.from, to: e.to, d, keys: [k], labels: { [k]: e.labels } };
    seen.set(key, placed);
    out.push(placed);
  }
  return out;
}

/** 行数バーの幅の割合 (%)。0 行でなければ最低 4% を確保して、小さい値でも見えるようにする。 */
export function barPercent(share: number): number {
  if (!(share > 0)) return 0;
  return Math.max(4, Math.round(Math.min(1, share) * 100));
}
