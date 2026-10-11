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
