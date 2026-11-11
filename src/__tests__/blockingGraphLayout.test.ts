import { describe, expect, it } from "vitest";
import type { ProcessInfo } from "../api/tauri";
import {
  BLOCKING_GRAPH_UNITS,
  layoutBlockingGraph,
  waitLevel,
  waitThickness,
} from "../components/blockingGraphLayout";

const base: ProcessInfo = {
  id: 1,
  user: "app",
  host: "localhost",
  database: "db",
  command: "Query",
  state: null,
  time_secs: 10,
  query_summary: "UPDATE t",
  query_truncated: false,
  is_self: false,
  blocked_by: [],
};
const p = (id: number, blocked_by: number[] = [], time_secs: number | null = 10): ProcessInfo => ({
  ...base,
  id,
  blocked_by,
  time_secs,
});
const node = (l: ReturnType<typeof layoutBlockingGraph>, id: number) => {
  const n = l.nodes.find((x) => x.id === id);
  if (!n) throw new Error(`no node ${id}`);
  return n;
};

describe("layoutBlockingGraph (#2237)", () => {
  it("待機が無ければ空", () => {
    expect(layoutBlockingGraph([p(1), p(2)]).nodes).toEqual([]);
  });

  it("単純な鎖は列が 1 つずつ右へ進む", () => {
    const l = layoutBlockingGraph([p(1), p(2, [1]), p(3, [2])]);
    expect(l.columns).toBe(3);
    expect([1, 2, 3].map((id) => node(l, id).column)).toEqual([0, 1, 2]);
    expect(node(l, 1).isRoot).toBe(true);
    expect(node(l, 1).victims).toBe(2);
    expect(l.edges.map((e) => e.key)).toEqual(["1>2", "2>3"]);
    expect(l.edges.every((e) => !e.cycle && !e.back)).toBe(true);
  });

  it("分岐: 1 つの根から複数の待機者へ。同じ列の別の行になる", () => {
    const l = layoutBlockingGraph([p(1), p(2, [1]), p(3, [1])]);
    expect(node(l, 2).column).toBe(1);
    expect(node(l, 3).column).toBe(1);
    expect(new Set([node(l, 2).row, node(l, 3).row]).size).toBe(2);
    expect(node(l, 1).victims).toBe(2);
  });

  it("合流: 複数のブロッカーに待たされるプロセスは 1 ノードで矢印が複数本入る", () => {
    const l = layoutBlockingGraph([p(1), p(2), p(3, [1, 2])]);
    expect(l.nodes.filter((n) => n.id === 3)).toHaveLength(1);
    expect(node(l, 3).blockers).toEqual([1, 2]);
    expect(l.edges.filter((e) => e.to === 3)).toHaveLength(2);
    expect(node(l, 1).isRoot && node(l, 2).isRoot).toBe(true);
  });

  it("合流で層は最長経路 (ブロッカーの層 + 1)", () => {
    const l = layoutBlockingGraph([p(1), p(2, [1]), p(3, [1, 2])]);
    expect(node(l, 3).column).toBe(2);
  });

  it("循環 (デッドロック): 閉じる辺は back で、全辺が cycle", () => {
    const l = layoutBlockingGraph([p(10, [11]), p(11, [10])]);
    expect(l.nodes).toHaveLength(2);
    expect(l.nodes.every((n) => n.inCycle)).toBe(true);
    expect(l.edges).toHaveLength(2);
    expect(l.edges.filter((e) => e.back)).toHaveLength(1);
    expect(l.edges.every((e) => e.cycle)).toBe(true);
    expect(l.columns).toBe(2);
    expect(Number.isFinite(l.height)).toBe(true);
  });

  it("循環の外の待機者は cycle ではない", () => {
    const l = layoutBlockingGraph([p(10, [11]), p(11, [10]), p(12, [10])]);
    expect(node(l, 12).inCycle).toBe(false);
    expect(l.edges.find((e) => e.to === 12)?.cycle).toBe(false);
  });

  it("一覧にないブロッカーは external の根 (待機者は消えない)", () => {
    const l = layoutBlockingGraph([p(2, [99])]);
    expect(node(l, 99).external).toBe(true);
    expect(node(l, 99).isRoot).toBe(true);
    expect(node(l, 99).column).toBe(0);
    expect(node(l, 2).column).toBe(1);
    expect(l.edges).toHaveLength(1);
  });

  it("自己参照は無視する", () => {
    expect(layoutBlockingGraph([p(1, [1])]).nodes).toEqual([]);
  });

  it("矢印の段階と太さは待機者の経過時間で決まる", () => {
    const l = layoutBlockingGraph([p(1), p(2, [1], 1), p(3, [1], 10), p(4, [1], 60), p(5, [1], null)]);
    const lv = (to: number) => l.edges.find((e) => e.to === to);
    expect(lv(2)?.level).toBe("short");
    expect(lv(3)?.level).toBe("medium");
    expect(lv(4)?.level).toBe("long");
    expect(lv(4)?.thickness).toBe(3);
    expect(lv(5)?.level).toBe("unknown");
  });

  it("ノードが重ならない (同じ列の y が異なる)", () => {
    const l = layoutBlockingGraph([p(1), p(2, [1]), p(3, [1]), p(4, [1])]);
    const ys = l.nodes.filter((n) => n.column === 1).map((n) => n.y);
    expect(new Set(ys).size).toBe(3);
    expect(l.height).toBeGreaterThan(0);
    expect(l.width).toBeGreaterThan(0);
  });
});

describe("経路がタイルと重ならない (#2237)", () => {
  const { tileW, tileH } = BLOCKING_GRAPH_UNITS;
  const hitsTile = (l: ReturnType<typeof layoutBlockingGraph>, pts: { x: number; y: number }[]) => {
    for (let i = 0; i < pts.length - 1; i++) {
      for (let k = 1; k < 40; k++) {
        const t = k / 40;
        const x = pts[i].x + (pts[i + 1].x - pts[i].x) * t;
        const y = pts[i].y + (pts[i + 1].y - pts[i].y) * t;
        for (const n of l.nodes) {
          if (x > n.x + 0.01 && x < n.x + tileW - 0.01 && y > n.y + 0.01 && y < n.y + tileH - 0.01)
            return true;
        }
      }
    }
    return false;
  };

  it("列をまたぐ辺 (1→2→3 と 1→3) は中間タイルを避ける", () => {
    const l = layoutBlockingGraph([p(1), p(2, [1]), p(3, [1, 2])]);
    expect(l.nodes.every((n) => n.row === 0)).toBe(true);
    const long = l.edges.find((e) => e.key === "1>3");
    expect(long?.points.length).toBeGreaterThan(2);
    for (const e of l.edges) expect(hitsTile(l, e.points)).toBe(false);
    const lane = long?.points[2].y ?? 0;
    expect(lane).toBeGreaterThan(l.nodes[0].y + tileH);
    expect(l.height).toBeGreaterThan(lane);
  });

  it("循環の閉じる辺は全行の最下端より下を通り、タイルに潜らない", () => {
    const l = layoutBlockingGraph([p(1), p(2, [1, 3]), p(3, [2]), p(4, [1]), p(5, [1])]);
    const back = l.edges.find((e) => e.back);
    expect(back).toBeDefined();
    const { pad, gapY } = BLOCKING_GRAPH_UNITS;
    const rows = Math.max(...l.nodes.map((n) => n.row)) + 1;
    const bottomAll = pad + rows * (tileH + gapY);
    expect(back?.points[2].y).toBeGreaterThan(bottomAll);
    expect(l.height).toBeGreaterThan(back?.points[2].y ?? 0);
    for (const e of l.edges) expect(hitsTile(l, e.points)).toBe(false);
  });
});

describe("全経路が描画領域に収まる (#2237)", () => {
  it.each([
    ["2 プロセスのデッドロック", [p(10, [11]), p(11, [10])]],
    ["根から辿れる循環", [p(1), p(2, [1, 3]), p(3, [2])]],
    ["一覧外から入る循環", [p(2, [99, 3]), p(3, [2])]],
    ["長い辺", [p(1), p(2, [1]), p(3, [1, 2])]],
  ])("%s", (_name, procs) => {
    const l = layoutBlockingGraph(procs);
    for (const e of l.edges) {
      for (const q of e.points) {
        expect(q.x).toBeGreaterThanOrEqual(0);
        expect(q.x).toBeLessThanOrEqual(l.width);
        expect(q.y).toBeGreaterThanOrEqual(0);
        expect(q.y).toBeLessThanOrEqual(l.height);
      }
    }
    for (const n of l.nodes) {
      expect(n.x).toBeGreaterThanOrEqual(0);
      expect(n.x + BLOCKING_GRAPH_UNITS.tileW).toBeLessThanOrEqual(l.width);
    }
  });
});

describe("waitLevel", () => {
  it("境界", () => {
    expect(waitLevel(null)).toBe("unknown");
    expect(waitLevel(-1)).toBe("unknown");
    expect(waitLevel(4)).toBe("short");
    expect(waitLevel(5)).toBe("medium");
    expect(waitLevel(29)).toBe("medium");
    expect(waitLevel(30)).toBe("long");
    expect(waitThickness("short")).toBe(1);
  });
});
