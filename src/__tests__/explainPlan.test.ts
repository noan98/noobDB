import { describe, it, expect } from "vitest";
import { parsePlan, scorePlan, computeHints, type PlanNode } from "../components/explainPlan";

/** Build a plan tree from a MySQL EXPLAIN-FORMAT-JSON-like object. */
function plan(obj: Record<string, unknown>): PlanNode {
  const { root, error } = parsePlan(JSON.stringify(obj));
  expect(error).toBeNull();
  if (!root) throw new Error("expected a root node");
  return root;
}

// 単純な単一テーブルクエリ。query_cost を持つ query_block + 1 テーブル。
function singleTable(cost: number, table: Record<string, unknown>): PlanNode {
  return plan({
    query_block: {
      select_id: 1,
      cost_info: { query_cost: String(cost) },
      table: { table_name: "t", ...table },
    },
  });
}

describe("scorePlan", () => {
  it("rates a trivial low-cost indexed lookup as light", () => {
    const root = singleTable(5, { access_type: "const", cost_info: { prefix_cost: "1.0" } });
    const s = scorePlan(root);
    expect(s.costMissing).toBe(false);
    expect(s.score).toBeLessThan(34);
    expect(s.band).toBe("low");
  });

  it("rates a huge-cost full scan as heavy", () => {
    const root = singleTable(2_000_000, {
      access_type: "ALL",
      rows_examined_per_scan: 5_000_000,
      cost_info: { prefix_cost: "2000000" },
    });
    const s = scorePlan(root);
    expect(s.score).toBeGreaterThanOrEqual(67);
    expect(s.band).toBe("high");
    // コストは CEIL を超えるので 100、リスクも警告 2 件で頭打ち付近。
    expect(s.costScore).toBe(100);
    expect(s.riskScore).toBeGreaterThan(0);
  });

  it("scales with cost on a logarithmic curve", () => {
    const cheap = scorePlan(singleTable(100, { access_type: "ref" })).score;
    const mid = scorePlan(singleTable(10_000, { access_type: "ref" })).score;
    const dear = scorePlan(singleTable(900_000, { access_type: "ref" })).score;
    expect(cheap).toBeLessThan(mid);
    expect(mid).toBeLessThan(dear);
  });

  it("nudges the score up for risky plans at the same cost", () => {
    const clean = scorePlan(singleTable(1000, { access_type: "ref" })).score;
    const risky = scorePlan(
      singleTable(1000, { access_type: "ALL", rows_examined_per_scan: 2_000_000 }),
    ).score;
    expect(risky).toBeGreaterThan(clean);
  });

  it("falls back to a risk-only score when the optimizer gave no cost", () => {
    const root = plan({
      query_block: {
        select_id: 1,
        table: { table_name: "t", access_type: "ALL" },
      },
    });
    const s = scorePlan(root);
    expect(s.costMissing).toBe(true);
    // 警告 1 件 (フルスキャン) = 30 → riskScore のみが総合になる。
    expect(s.score).toBe(s.riskScore);
    expect(s.score).toBe(30);
  });

  it("treats a present zero cost as light, not missing", () => {
    const root = singleTable(0, { access_type: "const" });
    const s = scorePlan(root);
    expect(s.costMissing).toBe(false);
    expect(s.score).toBe(0);
    expect(s.band).toBe("low");
  });

  it("clamps the combined score to the 0..100 range", () => {
    const root = singleTable(10_000_000, {
      access_type: "ALL",
      rows_examined_per_scan: 9_000_000,
      using_temporary_table: true,
      using_filesort: true,
    });
    const s = scorePlan(root);
    expect(s.score).toBeLessThanOrEqual(100);
    expect(s.score).toBeGreaterThanOrEqual(0);
  });
});

describe("computeHints (regression after extraction)", () => {
  it("flags a full table scan as a warning", () => {
    const root = singleTable(50, { access_type: "ALL" });
    const table = root.children[0];
    const hints = computeHints(table);
    expect(hints.some((h) => h.severity === "warning" && h.key === "explainHintFullScan")).toBe(
      true,
    );
  });

  it("treats a covering index as a positive info hint", () => {
    const root = singleTable(50, { access_type: "ref", using_index: true });
    const table = root.children[0];
    const hints = computeHints(table);
    expect(hints).toContainEqual({ severity: "info", key: "explainHintCoveringIndex" });
  });
});
