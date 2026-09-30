import { describe, it, expect } from "vitest";
import { fireEvent } from "@testing-library/react";
import { renderWithProviders } from "./testUtils";
import { ExplainViewer } from "../components/ExplainViewer";
import type { QueryResult } from "../api/tauri";
import { EXPLAIN_SKELETON_ROWS, staggerPlanIds } from "../components/explainSkeleton";
import { MAX_STAGGER_ITEMS } from "../components/commandPaletteSearch";

/** SQLite の EXPLAIN QUERY PLAN 行 (id, parent, notused, detail)。 */
function sqliteResult(): QueryResult {
  return {
    columns: [],
    rows: [
      [1, 0, 0, "SEARCH a USING INDEX i (x=?)"],
      [2, 1, 0, "SCAN b"],
      [3, 1, 0, "SCAN c"],
    ],
    rows_affected: 0,
    elapsed_ms: 1,
  } as unknown as QueryResult;
}

describe("staggerPlanIds (#1236)", () => {
  it("上限以内なら全ノードを対象にする", () => {
    expect([...staggerPlanIds(["a", "b", "c"])]).toEqual(["a", "b", "c"]);
  });

  it("大量ノードでは先頭 MAX_STAGGER_ITEMS 件だけに限る", () => {
    const ids = Array.from({ length: MAX_STAGGER_ITEMS + 30 }, (_, i) => `n${i}`);
    const set = staggerPlanIds(ids);
    expect(set.size).toBe(MAX_STAGGER_ITEMS);
    expect(set.has("n0")).toBe(true);
    expect(set.has(`n${MAX_STAGGER_ITEMS}`)).toBe(false);
  });

  it("空なら空集合", () => {
    expect(staggerPlanIds([]).size).toBe(0);
  });
});

describe("EXPLAIN_SKELETON_ROWS (#1236)", () => {
  it("ルートから始まり、隣接行の階層は 1 段ずつしか深くならない", () => {
    expect(EXPLAIN_SKELETON_ROWS[0].depth).toBe(0);
    for (let i = 1; i < EXPLAIN_SKELETON_ROWS.length; i++) {
      expect(EXPLAIN_SKELETON_ROWS[i].depth - EXPLAIN_SKELETON_ROWS[i - 1].depth).toBeLessThanOrEqual(1);
    }
  });

  it("幅は 100% 以内", () => {
    for (const r of EXPLAIN_SKELETON_ROWS) {
      expect(r.width).toBeGreaterThan(0);
      expect(r.width).toBeLessThanOrEqual(100);
    }
  });
});

describe("ExplainViewer の待機表示 (#1236)", () => {
  it("取得中はツリー状 Skeleton を出し、スピナーは出さない", () => {
    const { container, getByRole } = renderWithProviders(
      <ExplainViewer result={null} driver="sqlite" streaming />,
    );
    expect(getByRole("status").textContent).toBeTruthy();
    const hidden = container.querySelector('[aria-hidden="true"]');
    expect(hidden).toBeTruthy();
    expect(hidden?.children.length).toBe(EXPLAIN_SKELETON_ROWS.length);
    expect(container.querySelector('[role="progressbar"], svg.spinner')).toBeNull();
  });

  it("完了後はプランツリーが描画され、展開/折りたたみ後もノードが残る", () => {
    const { getAllByRole, getAllByLabelText } = renderWithProviders(
      <ExplainViewer result={sqliteResult()} driver="sqlite" />,
    );
    const before = getAllByRole("treeitem").length;
    expect(before).toBeGreaterThanOrEqual(3);
    const caret = getAllByLabelText(/.+/).find((el) => el.tagName === "BUTTON" && el.getAttribute("aria-label"));
    if (caret) fireEvent.click(caret);
    expect(getAllByRole("treeitem").length).toBeGreaterThan(0);
  });
});
