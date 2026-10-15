import { describe, expect, it } from "vitest";
import type { FilterOp } from "../components/gridSortFilter";
import { normalizeGridView, toPersistedGridView } from "../components/gridViewState";

const ALL_OPS: FilterOp[] = [
  "contains",
  "equals",
  "notEquals",
  "startsWith",
  "endsWith",
  "eq",
  "ne",
  "gt",
  "lt",
  "between",
];

describe("gridViewState の列フィルタ往復", () => {
  it.each(ALL_OPS)("演算子 %s が保存と復元で消えない", (op) => {
    const value = { op, value: "a", value2: "b", nullMode: "any" as const };
    const persisted = toPersistedGridView([], [{ id: "c", value }]);
    expect(persisted.filters).toEqual([{ id: "c", value }]);
    const restored = normalizeGridView(JSON.parse(JSON.stringify(persisted)));
    expect(restored.filters).toEqual([{ id: "c", value }]);
  });
});

describe("値のチェックリスト (in) の保存と復元 (#1628)", () => {
  it("values を保持して往復する", () => {
    const value = { op: "in" as const, value: "", value2: "", nullMode: "any" as const, values: ["a", "b"] };
    const persisted = toPersistedGridView([], [{ id: "c", value }]);
    const restored = normalizeGridView(JSON.parse(JSON.stringify(persisted)));
    expect(restored.filters).toEqual([{ id: "c", value }]);
  });
  it("values が配列でない in は捨てる", () => {
    const broken = { op: "in", value: "", value2: "", nullMode: "any", values: "a" };
    expect(normalizeGridView({ filters: [{ id: "c", value: broken }] }).filters).toBeUndefined();
  });
});
