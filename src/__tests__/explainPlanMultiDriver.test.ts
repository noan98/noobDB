import { describe, expect, it } from "vitest";
import {
  buildPlanGraph,
  computeHints,
  heatT,
  layoutPlanGraph,
  parsePostgresPlan,
  parseSqlitePlan,
  planNodeWidth,
  type PlanNode,
  type SqlitePlanRow,
} from "../components/explainPlan";

describe("parsePostgresPlan", () => {
  const json = JSON.stringify([
    {
      Plan: {
        "Node Type": "Aggregate",
        "Total Cost": 200.5,
        "Plan Rows": 1,
        Plans: [
          {
            "Node Type": "Seq Scan",
            "Relation Name": "users",
            "Total Cost": 150.0,
            "Plan Rows": 5000,
          },
        ],
      },
      "Planning Time": 0.2,
    },
  ]);

  it("builds a tree rooted at the first element's Plan", () => {
    const { root, error } = parsePostgresPlan(json);
    expect(error).toBeNull();
    expect(root).not.toBeNull();
    expect(root!.kind).toBe("Aggregate");
    expect(root!.cost).toBe(200.5);
    expect(root!.children).toHaveLength(1);
    const child = root!.children[0];
    expect(child.kind).toBe("Seq Scan");
    expect(child.label).toBe("Seq Scan on users");
    expect(child.cost).toBe(150);
  });

  it("flattens scalar fields into attrs, skipping Plans", () => {
    const { root } = parsePostgresPlan(json);
    const keys = root!.attrs.map(([k]) => k);
    expect(keys).toContain("Node Type");
    expect(keys).toContain("Total Cost");
    expect(keys).not.toContain("Plans");
  });

  it("accepts a single (non-array) object too", () => {
    const { root } = parsePostgresPlan(
      JSON.stringify({ Plan: { "Node Type": "Result", "Total Cost": 1 } }),
    );
    expect(root!.kind).toBe("Result");
  });

  it("reports JSON parse errors", () => {
    const { root, error } = parsePostgresPlan("{not json");
    expect(root).toBeNull();
    expect(error).toBeTruthy();
  });

  it("flags a Seq Scan as a full-scan warning", () => {
    const { root } = parsePostgresPlan(json);
    const hints = computeHints(root!.children[0]);
    expect(hints.some((h) => h.key === "explainHintFullScan" && h.severity === "warning")).toBe(true);
  });
});

describe("parseSqlitePlan", () => {
  const rows: SqlitePlanRow[] = [
    { id: 2, parent: 0, detail: "SCAN users" },
    { id: 3, parent: 0, detail: "SEARCH orders USING INDEX ix_user (user_id=?)" },
    { id: 4, parent: 3, detail: "USE TEMP B-TREE FOR ORDER BY" },
  ];

  it("wraps multiple top-level steps under a synthetic root", () => {
    const { root, error } = parseSqlitePlan(rows);
    expect(error).toBeNull();
    expect(root!.kind).toBe("queryPlan");
    expect(root!.children).toHaveLength(2);
  });

  it("nests children by parent id", () => {
    const { root } = parseSqlitePlan(rows);
    const search = root!.children[1];
    expect(search.label).toContain("SEARCH orders");
    expect(search.children).toHaveLength(1);
    expect(search.children[0].label).toContain("TEMP B-TREE");
  });

  it("uses a single step directly as the root", () => {
    const { root } = parseSqlitePlan([{ id: 2, parent: 0, detail: "SCAN t" }]);
    expect(root!.label).toBe("SCAN t");
    expect(root!.kind).toBe("sqliteStep");
  });

  it("returns a null root for no rows", () => {
    expect(parseSqlitePlan([]).root).toBeNull();
  });

  it("flags a bare SCAN as a caution but not an indexed SEARCH", () => {
    const { root } = parseSqlitePlan(rows);
    const scanHints = computeHints(root!.children[0]);
    expect(scanHints.some((h) => h.key === "explainHintFullScan")).toBe(true);
    const searchHints = computeHints(root!.children[1]);
    expect(searchHints.some((h) => h.key === "explainHintFullScan")).toBe(false);
  });

  it("treats a covering index as a positive info hint", () => {
    const { root } = parseSqlitePlan([
      { id: 2, parent: 0, detail: "SCAN t USING COVERING INDEX ix" },
    ]);
    const hints = computeHints(root!);
    expect(hints.some((h) => h.key === "explainHintCoveringIndex" && h.severity === "info")).toBe(true);
    expect(hints.some((h) => h.key === "explainHintFullScan")).toBe(false);
  });
});

function leaf(id: string, label: string, cost: number | null, children: PlanNode[] = []): PlanNode {
  return { id, kind: "x", label, cost, attrs: [], children };
}

describe("buildPlanGraph / layoutPlanGraph", () => {
  const root = leaf("a", "root", 100, [
    leaf("b", "child-1", 50),
    leaf("c", "child-2", 30, [leaf("d", "grandchild", 10)]),
  ]);

  it("flattens every node and links parent→child edges", () => {
    const g = buildPlanGraph(root);
    expect(g.nodes.map((n) => n.id).sort()).toEqual(["a", "b", "c", "d"]);
    expect(g.edges).toEqual([
      { id: "a->b", source: "a", target: "b" },
      { id: "a->c", source: "a", target: "c" },
      { id: "c->d", source: "c", target: "d" },
    ]);
  });

  it("returns an empty graph for a null root", () => {
    expect(buildPlanGraph(null)).toEqual({ nodes: [], edges: [] });
  });

  it("assigns finite positions to every node", () => {
    const positioned = layoutPlanGraph(buildPlanGraph(root));
    expect(positioned.nodes).toHaveLength(4);
    for (const n of positioned.nodes) {
      expect(Number.isFinite(n.x)).toBe(true);
      expect(Number.isFinite(n.y)).toBe(true);
      expect(n.width).toBeGreaterThan(0);
      expect(n.height).toBeGreaterThan(0);
    }
  });

  it("places children below their parent (TB layout)", () => {
    const positioned = layoutPlanGraph(buildPlanGraph(root));
    const byId = Object.fromEntries(positioned.nodes.map((n) => [n.id, n]));
    expect(byId.a.y).toBeLessThan(byId.b.y);
    expect(byId.c.y).toBeLessThan(byId.d.y);
  });
});

describe("planNodeWidth", () => {
  it("clamps within the configured bounds", () => {
    expect(planNodeWidth(leaf("a", "x", null))).toBeGreaterThanOrEqual(160);
    expect(planNodeWidth(leaf("a", "x".repeat(200), null))).toBeLessThanOrEqual(320);
  });
});

describe("heatT", () => {
  it("normalizes cost against the max", () => {
    expect(heatT(50, 100)).toBe(0.5);
    expect(heatT(100, 100)).toBe(1);
    expect(heatT(0, 100)).toBe(0);
  });

  it("clamps out-of-range ratios", () => {
    expect(heatT(200, 100)).toBe(1);
    expect(heatT(-5, 100)).toBe(0);
  });

  it("returns null when cost is missing or max is non-positive", () => {
    expect(heatT(null, 100)).toBeNull();
    expect(heatT(50, 0)).toBeNull();
  });
});
