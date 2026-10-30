import { describe, expect, it } from "vitest";
import { renderWithProviders, screen } from "./testUtils";
import { PinnedComparisonView } from "../components/PinnedComparisonView";
import { t } from "../i18n";
import type { PinnedResult } from "../pinnedCompare";

function pin(id: string, names: string[], rows: (string | number | null)[][]): PinnedResult {
  return {
    id,
    title: id,
    sql: "select",
    columns: names.map((name) => ({ name, type_name: "text" })),
    rows,
    rowsAffected: rows.length,
    elapsedMs: 1,
    pinnedAt: 1,
  };
}

function mount(pinned: PinnedResult[]) {
  return renderWithProviders(
    <PinnedComparisonView
      pinned={pinned}
      driver="mysql"
      onUnpin={() => {}}
      onClear={() => {}}
      onClose={() => {}}
    />,
  );
}

describe("PinnedComparisonView の差分サマリとキー検査 (#1625)", () => {
  it("差分の件数 (変更・追加・削除) を上部に出す", async () => {
    mount([
      pin(
        "a",
        ["id", "v"],
        [
          [1, "x"],
          [2, "y"],
          [3, "z"],
        ],
      ),
      pin(
        "b",
        ["id", "v"],
        [
          [1, "x"],
          [2, "Y"],
          [4, "w"],
        ],
      ),
    ]);
    expect(
      await screen.findByText(
        t("pinCompareSummary", { from: "#1", to: "#2", changed: 1, added: 1, removed: 1 }),
      ),
    ).toBeInTheDocument();
  });

  it("キーが重複していれば差分が不正確という警告を出す", async () => {
    mount([
      pin(
        "a",
        ["k", "v"],
        [
          [1, "x"],
          [1, "x"],
        ],
      ),
      pin(
        "b",
        ["k", "v"],
        [
          [1, "x"],
          [1, "x"],
        ],
      ),
    ]);
    // どの列も一意でないので既定のキーは先頭列 (k) になり、両側で 2 行ずつ重複する。
    expect(await screen.findByText(t("pinCompareKeyDuplicate", { left: 2, right: 2 }))).toBeInTheDocument();
  });

  it("列順が違う結果も列名で対応づけて比較し、その旨を案内する", async () => {
    mount([pin("a", ["id", "v"], [[1, "x"]]), pin("b", ["v", "id", "extra"], [["x", 1, "e"]])]);
    expect(
      await screen.findByText(t("pinCompareMappedByName", { shared: 2, excluded: "extra" })),
    ).toBeInTheDocument();
    expect(screen.getByText(t("pinCompareSummaryNone"))).toBeInTheDocument();
    expect(screen.queryByText(t("pinCompareNotComparable"))).toBeNull();
  });

  it("共通の列名が無ければ比較できない旨を出す", async () => {
    mount([pin("a", ["a"], [[1]]), pin("b", ["b"], [[1]])]);
    expect(await screen.findByText(t("pinCompareNotComparable"))).toBeInTheDocument();
  });
});
