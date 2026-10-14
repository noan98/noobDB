import { describe, expect, it } from "vitest";
import type { QueryResult } from "../api/tauri";
import {
  comparePlanSummaries,
  metricDelta,
  summarizePlanResult,
  type PlanSummary,
} from "../components/planCompare";

function mysqlPlan(table: Record<string, unknown>, cost = "10.00"): QueryResult {
  const json = JSON.stringify({
    query_block: { select_id: 1, cost_info: { query_cost: cost }, table },
  });
  return { columns: [{ name: "EXPLAIN", type_name: "" }], rows: [[json]], rows_affected: 0, elapsed_ms: 1 };
}

const scan = (rows: number) => ({
  table_name: "orders",
  access_type: "ALL",
  rows_examined_per_scan: rows,
  cost_info: { read_cost: "1.0", eval_cost: "1.0", prefix_cost: "2.0" },
});
const ref = {
  table_name: "orders",
  access_type: "ref",
  key: "ix_user",
  rows_examined_per_scan: 3,
  cost_info: { read_cost: "1.0", eval_cost: "1.0", prefix_cost: "2.0" },
};

describe("summarizePlanResult / comparePlanSummaries (#1539)", () => {
  it("フルスキャン → インデックス参照は改善で、access の変化が出る", () => {
    const before = summarizePlanResult("mysql", mysqlPlan(scan(2_000_000), "400000.00"));
    const after = summarizePlanResult("mysql", mysqlPlan(ref, "1.20"));
    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    const cmp = comparePlanSummaries(before as PlanSummary, after as PlanSummary);
    expect(cmp.verdict).toBe("improved");
    expect(cmp.scoreDelta).toBeLessThan(0);
    expect(cmp.warningDelta).toBeLessThan(0);
    expect(cmp.costDelta).toBeCloseTo(1.2 - 400000, 5);
    expect(cmp.costRatio).toBeLessThan(0.001);
    const access = cmp.changes.find((c) => c.kind === "access");
    expect(access).toMatchObject({ before: "ALL", after: "ref", object: "orders" });
  });

  it("逆向きは悪化 (警告の増加も数える)", () => {
    const before = summarizePlanResult("mysql", mysqlPlan(ref, "1.20")) as PlanSummary;
    const after = summarizePlanResult("mysql", mysqlPlan(scan(2_000_000), "400000.00")) as PlanSummary;
    const cmp = comparePlanSummaries(before, after);
    expect(cmp.verdict).toBe("regressed");
    expect(cmp.warningDelta).toBeGreaterThan(0);
    expect(cmp.changes.some((c) => c.kind === "access" && c.severity === "warning")).toBe(true);
  });

  it("同じ計画は変化なし", () => {
    const a = summarizePlanResult("mysql", mysqlPlan(ref, "1.20")) as PlanSummary;
    const b = summarizePlanResult("mysql", mysqlPlan(ref, "1.20")) as PlanSummary;
    const cmp = comparePlanSummaries(a, b);
    expect(cmp.verdict).toBe("same");
    expect(cmp.changes).toEqual([]);
    expect(cmp.scoreDelta).toBe(0);
  });

  it("SQLite の EXPLAIN QUERY PLAN も比べられる (総コストは無い)", () => {
    const rows = (detail: string): QueryResult => ({
      columns: ["id", "parent", "notused", "detail"].map((name) => ({ name, type_name: "" })),
      rows: [[2, 0, 0, detail]],
      rows_affected: 0,
      elapsed_ms: 1,
    });
    const before = summarizePlanResult("sqlite", rows("SCAN orders")) as PlanSummary;
    const after = summarizePlanResult(
      "sqlite",
      rows("SEARCH orders USING INDEX ix_user (user_id=?)"),
    ) as PlanSummary;
    expect(before.totalCost).toBeNull();
    const cmp = comparePlanSummaries(before, after);
    expect(cmp.costDelta).toBeNull();
    expect(cmp.changes.some((c) => c.kind === "access")).toBe(true);
  });

  it("空・パース不能は null、metricDelta は欠落で null", () => {
    expect(summarizePlanResult("mysql", null)).toBeNull();
    expect(
      summarizePlanResult("mysql", { columns: [], rows: [["not json"]], rows_affected: 0, elapsed_ms: 0 }),
    ).toBeNull();
    expect(metricDelta(null, 3)).toBeNull();
    expect(metricDelta(2, 5)).toBe(3);
  });
});
