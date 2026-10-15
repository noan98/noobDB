import { beforeEach, describe, expect, it } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "./testUtils";
import { ResultGrid } from "../components/ResultGrid";
import { attachStreamStats } from "../components/streamStats";
import type { CellValue, Column, QueryResult } from "../api/tauri";
import { setLocale, t } from "../i18n";
import { setColumnNullBars } from "../settings";

// 結果グリッドの重複キー検出 (#1628) と、ヘッダの近似ユニーク数 (HyperLogLog) の一言。

const COLUMNS: Column[] = [
  { name: "code", type_name: "VARCHAR" },
  { name: "plan", type_name: "VARCHAR" },
];

function makeResult(rows: CellValue[][]): QueryResult {
  return { columns: COLUMNS, rows, rows_affected: 0, elapsed_ms: 3 };
}

function bodyRows(container: HTMLElement): string[][] {
  return Array.from(container.querySelectorAll("tbody tr")).map((tr) =>
    Array.from(tr.querySelectorAll("td"))
      .filter((td) => !td.classList.contains("row-index") && !td.classList.contains("col-filler"))
      .map((td) => td.textContent ?? ""),
  );
}

beforeEach(() => {
  localStorage.clear();
  setLocale("en");
  setColumnNullBars(true);
});

describe("列メニューの重複検出 (#1628)", () => {
  it("検出して「重複行だけ表示」で絞り込み、チップで解除できる", async () => {
    const user = userEvent.setup();
    const result = makeResult([
      ["a1", "pro"],
      ["b1", "pro"],
      ["a1", "free"],
      ["c1", "pro"],
    ]);
    const { container } = renderWithProviders(<ResultGrid result={result} database="db" table="users" />);
    await user.click(screen.getByRole("button", { name: t("gridFilterAria", { column: "code" }) }));
    await user.click(screen.getByText(t("gridFindDuplicates")));

    const summary = await screen.findByTestId("dup-keys-summary");
    expect(summary).toHaveTextContent(t("dupKeysSummary", { groups: "1", rows: "2", extra: "1" }));
    await user.click(screen.getByRole("button", { name: t("dupKeysShowOnly") }));

    await waitFor(() =>
      expect(bodyRows(container)).toEqual([
        ["a1", "pro"],
        ["a1", "free"],
      ]),
    );
    // モーダルの閉じるアニメーションが終わると、背面の aria-hidden が外れてチップに届く。
    await user.click(await screen.findByRole("button", { name: t("dupKeysFilterChipClear") }));
    await waitFor(() => expect(bodyRows(container)).toHaveLength(4));
  });
});

describe("ヘッダの近似ユニーク数 (#1628)", () => {
  function labelsWith(estimates: number[] | undefined, rows: CellValue[][]): string[] {
    const result = makeResult(rows);
    attachStreamStats(result.rows, {
      rowCount: rows.length,
      nullCounts: [0, 0],
      numMin: [null, null],
      numMax: [null, null],
      duplicateRows: false,
      distinctEstimates: estimates,
    });
    const { container } = renderWithProviders(<ResultGrid result={result} />);
    return Array.from(container.querySelectorAll("thead .th-nullbar")).map(
      (el) => el.getAttribute("aria-label") ?? "",
    );
  }

  const rows: CellValue[][] = Array.from({ length: 200 }, (_, i) => [`u${i}`, i % 3 === 0 ? "pro" : "free"]);

  it("ほぼ全行が異なる列は候補キー、少ない種類の列は低カーディナリティと添える", () => {
    const labels = labelsWith([200, 2], rows);
    expect(labels[0]).toContain(t("gridDistinctCandidateKey", { count: "200" }));
    expect(labels[1]).toContain(t("gridDistinctLow", { count: "2" }));
  });

  it("推定が無いバックエンドでは従来どおり NULL 率だけ", () => {
    const labels = labelsWith(undefined, rows);
    expect(labels[0]).toBe(t("gridNullBarAria", { column: "code", percent: "0", count: "200" }));
  });
});

describe("機微カラムのマスク中は重複検出に使えない (#1628)", () => {
  it("マスクされた列には「重複を検出」を出さない", async () => {
    const user = userEvent.setup();
    const result: QueryResult = {
      columns: [
        { name: "password", type_name: "VARCHAR" },
        { name: "plan", type_name: "VARCHAR" },
      ],
      rows: [
        ["x", "pro"],
        ["x", "pro"],
      ],
      rows_affected: 0,
      elapsed_ms: 1,
    };
    renderWithProviders(<ResultGrid result={result} database="db" table="users" />);
    await user.click(screen.getByRole("button", { name: t("gridFilterAria", { column: "password" }) }));
    expect(screen.queryByText(t("gridFindDuplicates"))).toBeNull();
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: t("gridFilterAria", { column: "plan" }) }));
    expect(screen.getByText(t("gridFindDuplicates"))).toBeInTheDocument();
  });
});
