import type { ProcessInfo } from "../api/tauri";
import { buildBlockingTree } from "./processList";

/**
 * ロック待機グラフの配置 (#2237)。`buildBlockingTree` が出す待機ツリーを、左から右へ
 * 「根のブロッカー → 待たされているプロセス」と流れる図にする純関数。描画は `BlockingGraph.tsx`。
 *
 * 座標はすべて抽象ユニット (1 ユニット = `--space-1`)。描画側が `calc(N * var(--space-1))` に直すので、
 * フォント拡大設定に追従し、px 直値は出てこない。
 * - 複数のブロッカーに待たされるプロセスは 1 ノードにまとめ、矢印を複数本引き込む。
 * - 循環 (デッドロック) は DFS で閉じる辺 (`back`) を見つけ、層の計算から外して下側の弧で描く。
 */

export const BLOCKING_GRAPH_UNITS = {
  tileW: 56,
  tileH: 26,
  gapX: 20,
  gapY: 6,
  pad: 3,
  /** 閉じる辺 (循環) の弧が、タイルの下へ張り出す深さ。 */
  arcDepth: 8,
} as const;

/** 経過時間 (`time_secs`: PostgreSQL はクエリの経過時間、MySQL は現状態の継続時間。ロック経過時間そのものではない) の段階。 */
export type WaitLevel = "unknown" | "short" | "medium" | "long";

/** この秒数以上で `medium` / `long`。 */
export const WAIT_MEDIUM_SECS = 5;
export const WAIT_LONG_SECS = 30;

export function waitLevel(secs: number | null | undefined): WaitLevel {
  if (secs == null || secs < 0) return "unknown";
  if (secs >= WAIT_LONG_SECS) return "long";
  if (secs >= WAIT_MEDIUM_SECS) return "medium";
  return "short";
}

/** 段階 → 矢印の太さ (色だけに頼らない)。 */
export function waitThickness(level: WaitLevel): 1 | 2 | 3 {
  switch (level) {
    case "long":
      return 3;
    case "medium":
      return 2;
    default:
      return 1;
  }
}

export interface BlockingGraphNode {
  id: number;
  /** 外部ブロッカーは id 以外が空のスタブ。 */
  process: ProcessInfo;
  /** 列 (左 = 根)。 */
  column: number;
  /** 列内の行。 */
  row: number;
  /** タイル左上のユニット座標。 */
  x: number;
  y: number;
  isRoot: boolean;
  /** 一覧にないブロッカー (kill 不可)。 */
  external: boolean;
  /** 循環待ち (デッドロック) のメンバー。 */
  inCycle: boolean;
  /** 直接・間接に待たせているプロセス数。 */
  victims: number;
  /** このノードを待たせているブロッカーの id (重複なし)。 */
  blockers: number[];
}

export interface BlockingGraphPoint {
  x: number;
  y: number;
}

export interface BlockingGraphEdge {
  key: string;
  /** ブロッカー側。 */
  from: number;
  /** 待っている側。矢印はブロッカー (from) → 待機者 (to) に引く。 */
  to: number;
  /** 待っている側の経過時間 (`time_secs`)。 */
  waitSecs: number | null;
  level: WaitLevel;
  thickness: 1 | 2 | 3;
  /** 循環の一部 (デッドロック)。 */
  cycle: boolean;
  /** 循環を閉じる辺 (下側の弧で描く)。 */
  back: boolean;
  /** SVG の path `d` (ユニット座標)。 */
  path: string;
  /** 経路の折れ点 (始点・終点を含む)。列をまたぐ辺・循環の辺はタイルを避ける折れ線。 */
  points: BlockingGraphPoint[];
}

export interface BlockingGraphLayout {
  nodes: BlockingGraphNode[];
  edges: BlockingGraphEdge[];
  columns: number;
  /** 全体の大きさ (ユニット)。 */
  width: number;
  height: number;
}

const EMPTY: BlockingGraphLayout = { nodes: [], edges: [], columns: 0, width: 0, height: 0 };

export function layoutBlockingGraph(processes: readonly ProcessInfo[]): BlockingGraphLayout {
  const treeRows = buildBlockingTree(processes).filter((r) => !r.repeated);
  if (treeRows.length === 0) return EMPTY;
  const { tileW, tileH, gapX, gapY, pad, arcDepth } = BLOCKING_GRAPH_UNITS;

  const info = new Map(treeRows.map((r, index) => [r.process.id, { row: r, index }]));
  const ids = treeRows.map((r) => r.process.id);

  // 辺: ブロッカー → 待っているプロセス。
  const out = new Map<number, number[]>(ids.map((id) => [id, []]));
  const blockersOf = new Map<number, number[]>(ids.map((id) => [id, []]));
  for (const r of treeRows) {
    if (r.external) continue;
    for (const b of r.process.blocked_by ?? []) {
      if (b === r.process.id || !info.has(b) || blockersOf.get(r.process.id)?.includes(b)) continue;
      blockersOf.get(r.process.id)?.push(b);
      out.get(b)?.push(r.process.id);
    }
  }

  // DFS で循環を閉じる辺を見つける (行の並びは根が先頭)。
  const state = new Map<number, 0 | 1 | 2>();
  const back = new Set<string>();
  const edgeKey = (from: number, to: number) => `${from}>${to}`;
  const dfs = (u: number) => {
    state.set(u, 1);
    for (const v of out.get(u) ?? []) {
      const s = state.get(v) ?? 0;
      if (s === 1) back.add(edgeKey(u, v));
      else if (s === 0) dfs(v);
    }
    state.set(u, 2);
  };
  for (const id of ids) if ((state.get(id) ?? 0) === 0) dfs(id);

  // 到達可能性 (循環判定用)。ノード数は小さいので素直に BFS。
  const reach = new Map<number, Set<number>>();
  for (const id of ids) {
    const seen = new Set<number>();
    const stack = [...(out.get(id) ?? [])];
    while (stack.length > 0) {
      const cur = stack.pop();
      if (cur === undefined || seen.has(cur)) continue;
      seen.add(cur);
      stack.push(...(out.get(cur) ?? []));
    }
    reach.set(id, seen);
  }

  // 層 = 閉じる辺を除いた DAG での最長経路。
  const layer = new Map<number, number>();
  const layerOf = (id: number): number => {
    const known = layer.get(id);
    if (known !== undefined) return known;
    let l = 0;
    for (const b of blockersOf.get(id) ?? []) {
      if (back.has(edgeKey(b, id))) continue;
      l = Math.max(l, layerOf(b) + 1);
    }
    layer.set(id, l);
    return l;
  };
  for (const id of ids) layerOf(id);

  const columns = Math.max(...ids.map((id) => layer.get(id) ?? 0)) + 1;
  const rowOf = new Map<number, number>();
  const byColumn: number[][] = Array.from({ length: columns }, () => []);
  for (const id of ids) byColumn[layer.get(id) ?? 0]?.push(id);
  for (const col of byColumn) {
    const score = (id: number) => {
      const preds = (blockersOf.get(id) ?? []).filter((b) => !back.has(edgeKey(b, id)) && rowOf.has(b));
      if (preds.length === 0) return Number.POSITIVE_INFINITY;
      return preds.reduce((s, b) => s + (rowOf.get(b) ?? 0), 0) / preds.length;
    };
    const order = col
      .map((id) => ({ id, s: score(id), i: info.get(id)?.index ?? 0 }))
      .sort((a, b) => (a.s === b.s ? a.i - b.i : a.s - b.s));
    order.forEach((o, r) => {
      rowOf.set(o.id, r);
    });
  }
  const maxRows = Math.max(...byColumn.map((c) => c.length));

  // 循環の戻り辺は列の外側の溝を通るので、左右に余白を確保してノードをずらす。
  const padX = back.size > 0 ? Math.max(pad, gapX / 2 + 1) : pad;
  const pos = (id: number) => ({
    x: padX + (layer.get(id) ?? 0) * (tileW + gapX),
    y: pad + (rowOf.get(id) ?? 0) * (tileH + gapY),
  });

  const nodes: BlockingGraphNode[] = ids.map((id) => {
    const r = info.get(id)?.row;
    const { x, y } = pos(id);
    return {
      id,
      process: r?.process as ProcessInfo,
      column: layer.get(id) ?? 0,
      row: rowOf.get(id) ?? 0,
      x,
      y,
      isRoot: r?.isRoot ?? false,
      external: r?.external ?? false,
      inCycle: reach.get(id)?.has(id) ?? false,
      victims: r?.victims ?? 0,
      blockers: blockersOf.get(id) ?? [],
    };
  });

  const rowStep = tileH + gapY;
  // 全行の最下端 (末尾の行間を含む)。循環の弧はこれより下を通す。
  const bottomAll = pad + maxRows * rowStep;
  let height = pad * 2 + maxRows * tileH + (maxRows - 1) * gapY;
  let backIndex = 0;
  const edges: BlockingGraphEdge[] = [];
  const fmt = (pts: BlockingGraphPoint[]) =>
    pts.map((q, i) => `${i === 0 ? "M" : "L"} ${q.x} ${q.y}`).join(" ");
  for (const id of ids) {
    for (const from of blockersOf.get(id) ?? []) {
      const a = pos(from);
      const b = pos(id);
      const isBack = back.has(edgeKey(from, id));
      const waitSecs = info.get(id)?.row.process.time_secs ?? null;
      const level = waitLevel(waitSecs);
      const x1 = a.x + tileW;
      const y1 = a.y + tileH / 2;
      const x2 = b.x;
      const y2 = b.y + tileH / 2;
      let path: string;
      let points: BlockingGraphPoint[];
      const span = (layer.get(id) ?? 0) - (layer.get(from) ?? 0);
      if (isBack) {
        // 列の間の溝を降り、全行の最下端より下を戻り、ブロックされた側の左の溝から入る。
        const lane = bottomAll + arcDepth / 2 + backIndex * 1.5;
        backIndex += 1;
        const xa = x1 + gapX / 2;
        const xb = x2 - gapX / 2;
        points = [
          { x: x1, y: y1 },
          { x: xa, y: y1 },
          { x: xa, y: lane },
          { x: xb, y: lane },
          { x: xb, y: y2 },
          { x: x2, y: y2 },
        ];
        path = fmt(points);
        height = Math.max(height, lane + pad);
      } else if (span > 1) {
        // 列をまたぐ辺は、中間のタイルを避けて行間の溝 (下側の行の直下) を通す。
        const lowRow = Math.max(rowOf.get(from) ?? 0, rowOf.get(id) ?? 0);
        const lane = pad + (lowRow + 1) * rowStep - gapY / 2;
        const xa = x1 + gapX / 2;
        const xb = x2 - gapX / 2;
        points = [
          { x: x1, y: y1 },
          { x: xa, y: y1 },
          { x: xa, y: lane },
          { x: xb, y: lane },
          { x: xb, y: y2 },
          { x: x2, y: y2 },
        ];
        path = fmt(points);
        height = Math.max(height, lane + pad);
      } else {
        const mx = (x1 + x2) / 2;
        points = [
          { x: x1, y: y1 },
          { x: x2, y: y2 },
        ];
        path = `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
      }
      edges.push({
        key: edgeKey(from, id),
        from,
        to: id,
        waitSecs,
        level,
        thickness: waitThickness(level),
        cycle: reach.get(id)?.has(from) ?? false,
        back: isBack,
        path,
        points,
      });
    }
  }

  return {
    nodes,
    edges,
    columns,
    width: padX * 2 + columns * tileW + (columns - 1) * gapX,
    height,
  };
}
