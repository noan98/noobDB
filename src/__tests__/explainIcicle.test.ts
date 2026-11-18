import { describe, expect, it } from "vitest";
import {
  computeSelfTimes,
  icicleBasis,
  icicleBreadcrumb,
  layoutIcicle,
  nodeInclusive,
} from "../components/explainIcicle";
import {
  parseMysqlAnalyzeText,
  parsePlan,
  parsePostgresPlan,
  parseSqlitePlan,
  type PlanNode,
} from "../components/explainPlan";

function pg(plan: unknown): PlanNode {
  const { root, error } = parsePostgresPlan(JSON.stringify([{ Plan: plan }]));
  expect(error).toBeNull();
  return root as PlanNode;
}

const PG_ANALYZE = {
  "Node Type": "Hash Join",
  "Total Cost": 500,
  "Plan Rows": 10,
  "Actual Rows": 10,
  "Actual Loops": 1,
  "Actual Startup Time": 1,
  "Actual Total Time": 100,
  Plans: [
    {
      "Node Type": "Seq Scan",
      "Relation Name": "a",
      "Total Cost": 300,
      "Plan Rows": 10,
      "Actual Rows": 10,
      "Actual Loops": 1,
      "Actual Startup Time": 0,
      "Actual Total Time": 70,
    },
    {
      "Node Type": "Index Scan",
      "Relation Name": "b",
      "Total Cost": 50,
      "Plan Rows": 1,
      "Actual Rows": 1,
      "Actual Loops": 10,
      "Actual Startup Time": 0,
      "Actual Total Time": 1,
    },
  ],
};

describe("computeSelfTimes: PostgreSQL EXPLAIN ANALYZE", () => {
  it("自己時間 = 包含 − 子の包含の和 (loops を掛ける)", () => {
    const root = pg(PG_ANALYZE);
    expect(icicleBasis(root)).toBe("actual");
    const m = computeSelfTimes(root, "actual");
    const [a, b] = root.children;
    expect(m.get(root.id)).toMatchObject({ inclusive: 100, self: 20, clamped: false });
    expect(m.get(a.id)).toMatchObject({ inclusive: 70, self: 70 });
    // 1ms × 10 loops = 10ms
    expect(m.get(b.id)).toMatchObject({ inclusive: 10, self: 10 });
  });

  it("並列 (Gather の子が loops = 3) で子の合計が親を超えたら 0 に丸めて clamped", () => {
    const root = pg({
      "Node Type": "Gather",
      "Total Cost": 100,
      "Actual Rows": 5,
      "Actual Loops": 1,
      "Actual Total Time": 40,
      Plans: [
        {
          "Node Type": "Parallel Seq Scan",
          "Total Cost": 90,
          "Actual Rows": 2,
          "Actual Loops": 3,
          "Actual Total Time": 30,
        },
      ],
    });
    const m = computeSelfTimes(root, "actual");
    expect(m.get(root.id)).toMatchObject({ inclusive: 40, self: 0, clamped: true });
    expect(m.get(root.children[0].id)?.inclusive).toBe(90);
    const layout = layoutIcicle(root, "actual");
    expect(layout?.estimated).toBe(true);
    // 子は親の枠 (幅 1) に収まる
    const child = layout?.rects.find((r) => r.depth === 1);
    expect(child?.x).toBe(0);
    expect(child?.w).toBeLessThanOrEqual(1);
  });

  it("丸め誤差程度の超過は clamped にしない", () => {
    const root = pg({
      "Node Type": "Sort",
      "Actual Rows": 1,
      "Actual Loops": 1,
      "Actual Total Time": 10,
      Plans: [{ "Node Type": "Seq Scan", "Actual Rows": 1, "Actual Loops": 1, "Actual Total Time": 10.0004 }],
    });
    const e = computeSelfTimes(root, "actual").get(root.id);
    expect(e).toMatchObject({ self: 0, clamped: false });
  });

  it("一度も実行されなかったノード (loops=0) は 0", () => {
    const root = pg({
      "Node Type": "Nested Loop",
      "Actual Rows": 1,
      "Actual Loops": 1,
      "Actual Total Time": 5,
      Plans: [
        { "Node Type": "Seq Scan", "Actual Rows": 1, "Actual Loops": 1, "Actual Total Time": 4 },
        { "Node Type": "Index Scan", "Actual Rows": 0, "Actual Loops": 0, "Actual Total Time": 0 },
      ],
    });
    const [, never] = root.children;
    expect(nodeInclusive(never, "actual")).toBe(0);
    const layout = layoutIcicle(root, "actual");
    expect(layout?.rects.find((r) => r.id === never.id)?.w).toBe(0);
  });
});

describe("computeSelfTimes: MySQL EXPLAIN ANALYZE", () => {
  const text = [
    "-> Nested loop inner join  (cost=1.1 rows=2) (actual time=0.05..2.00 rows=2000 loops=1)",
    "    -> Table scan on a  (cost=0.35 rows=2) (actual time=0.02..0.50 rows=2 loops=1)",
    "    -> Single-row index lookup on b using PRIMARY (id=a.id)  (cost=0.25 rows=1) (actual time=0.1..0.2 rows=1 loops=4)",
  ].join("\n");

  it("totalMs × loops で自己時間を出し、ホットスポットが降順に並ぶ", () => {
    const { root, error } = parseMysqlAnalyzeText(text);
    expect(error).toBeNull();
    const r = root as PlanNode;
    const m = computeSelfTimes(r, "actual");
    const [scan, lookup] = r.children;
    expect(m.get(scan.id)?.self).toBeCloseTo(0.5);
    expect(m.get(lookup.id)?.self).toBeCloseTo(0.8); // 0.2 × 4
    expect(m.get(r.id)?.self).toBeCloseTo(0.7); // 2.0 − 0.5 − 0.8
    const layout = layoutIcicle(r, "actual");
    expect(layout?.hotspots.map((h) => h.id)).toEqual([lookup.id, r.id, scan.id]);
    const total = layout?.hotspots.reduce((s, h) => s + h.share, 0) ?? 0;
    expect(total).toBeCloseTo(1);
  });
});

describe("コスト (実測なし) の図", () => {
  it("通常の EXPLAIN (PostgreSQL) は推定コストで描く", () => {
    const root = pg({
      "Node Type": "Aggregate",
      "Total Cost": 200,
      Plans: [{ "Node Type": "Seq Scan", "Total Cost": 150 }],
    });
    expect(icicleBasis(root)).toBe("cost");
    const layout = layoutIcicle(root, "cost");
    expect(layout?.basis).toBe("cost");
    expect(layout?.hotspots[0]).toMatchObject({ self: 150 });
    expect(layout?.rects[1]).toMatchObject({ x: 0, w: 0.75 });
  });

  it("MySQL EXPLAIN FORMAT=JSON も推定コストで描く", () => {
    const { root } = parsePlan(
      JSON.stringify({
        query_block: {
          cost_info: { query_cost: "10.00" },
          table: { table_name: "t", cost_info: { prefix_cost: "4.00" } },
        },
      }),
    );
    const layout = layoutIcicle(root as PlanNode, icicleBasis(root as PlanNode));
    expect(layout?.basis).toBe("cost");
    expect(layout?.planTotal).toBe(10);
  });

  it("SQLite (コストなし) は描くものが無く null", () => {
    const { root } = parseSqlitePlan([{ id: 2, parent: 0, detail: "SCAN users" }]);
    expect(layoutIcicle(root as PlanNode, icicleBasis(root as PlanNode))).toBeNull();
  });

  it("値の無い中継ノードは子の和を包含値にする", () => {
    const root = pg({
      "Node Type": "Append",
      Plans: [
        { "Node Type": "Seq Scan", "Total Cost": 30 },
        { "Node Type": "Seq Scan", "Total Cost": 70 },
      ],
    });
    expect(computeSelfTimes(root, "cost").get(root.id)).toMatchObject({
      inclusive: 100,
      self: 0,
      clamped: false,
    });
  });
});

describe("layoutIcicle: ズーム", () => {
  const root = pg(PG_ANALYZE);
  it("部分木が幅 1 になり、色 (heat) と share は全景のまま", () => {
    const full = layoutIcicle(root, "actual");
    const zoomed = layoutIcicle(root, "actual", root.children[0].id);
    expect(zoomed?.rects).toHaveLength(1);
    expect(zoomed?.rects[0]).toMatchObject({ depth: 0, x: 0, w: 1 });
    expect(zoomed?.rects[0].heat).toBe(full?.rects.find((r) => r.id === root.children[0].id)?.heat);
    expect(zoomed?.planTotal).toBe(100);
    expect(zoomed?.hotspots).toEqual(full?.hotspots);
  });

  it("不明な focusId は null、パンくずはルートから", () => {
    expect(layoutIcicle(root, "actual", "nope")).toBeNull();
    expect(icicleBreadcrumb(root, root.children[1].id).map((c) => c.id)).toEqual([
      root.id,
      root.children[1].id,
    ]);
    expect(icicleBreadcrumb(root, "nope")).toEqual([]);
  });
});
