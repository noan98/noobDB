import { describe, expect, it } from "vitest";
import { fireEvent } from "@testing-library/react";
import { renderWithProviders } from "./testUtils";
import { ExplainViewer } from "../components/ExplainViewer";
import type { QueryResult } from "../api/tauri";
import { planAncestorIds, searchPlanNodes, type PlanNode } from "../components/explainPlan";

function n(id: string, label: string, children: PlanNode[] = [], attrs: [string, unknown][] = []): PlanNode {
  return { id, kind: "x", label, cost: null, attrs, children };
}
const tree = n("r", "Nested loop", [
  n("a", "Index lookup on users", [], [["key", "idx_email"]]),
  n("b", "Table scan on orders", [n("c", "Filter", [], [["rows", 1234]])]),
]);

describe("プランのノード検索 (#1628)", () => {
  it("ラベルを大文字小文字無視で検索し、先行順で返す", () => {
    expect(searchPlanNodes(tree, "SCAN")).toEqual(["b"]);
    expect(searchPlanNodes(tree, "on ")).toEqual(["a", "b"]);
  });
  it("属性のキーと値も対象にする", () => {
    expect(searchPlanNodes(tree, "idx_email")).toEqual(["a"]);
    expect(searchPlanNodes(tree, "1234")).toEqual(["c"]);
  });
  it("空白のみ・一致なしは空配列", () => {
    expect(searchPlanNodes(tree, "   ")).toEqual([]);
    expect(searchPlanNodes(tree, "zzz")).toEqual([]);
  });
  it("祖先 ID を根から親の順で返す", () => {
    expect(planAncestorIds(tree, "c")).toEqual(["r", "b"]);
    expect(planAncestorIds(tree, "r")).toEqual([]);
    expect(planAncestorIds(tree, "none")).toEqual([]);
  });
});

describe("ExplainViewer の検索 UI (#1628)", () => {
  const result = {
    columns: [],
    rows: [
      [1, 0, 0, "SEARCH a USING INDEX i (x=?)"],
      [2, 1, 0, "SCAN b"],
      [3, 1, 0, "SCAN c"],
    ],
    rows_affected: 0,
    elapsed_ms: 1,
  } as unknown as QueryResult;

  it("入力で一致行に印が付き、Enter で選択が巡回する", () => {
    const { getByRole, container } = renderWithProviders(<ExplainViewer result={result} driver="sqlite" />);
    const input = getByRole("textbox");
    fireEvent.change(input, { target: { value: "scan" } });
    expect(container.querySelectorAll('[data-search-match="true"]').length).toBe(2);
    fireEvent.keyDown(input, { key: "Enter" });
    const first = container.querySelector('[role="treeitem"][aria-selected="true"]')?.textContent;
    fireEvent.keyDown(input, { key: "Enter" });
    const second = container.querySelector('[role="treeitem"][aria-selected="true"]')?.textContent;
    expect(first).toContain("SCAN");
    expect(second).toContain("SCAN");
    expect(second).not.toBe(first);
  });
});
