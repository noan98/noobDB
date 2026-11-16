import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, renderWithProviders, waitFor } from "./testUtils";
import { ResultGrid } from "../components/ResultGrid";
import type { CellValue, Column, QueryResult } from "../api/tauri";
import { setLocale, t } from "../i18n";
import { setColumnDistribution } from "../settings";

// 列ヘッダのミニ分布 (#2383) の結線: 型別の表示・設定のオン/オフ・ビンのクリックでの絞り込みと解除。

const COLUMNS: Column[] = [
  { name: "id", type_name: "INT" },
  { name: "status", type_name: "VARCHAR" },
  { name: "meta", type_name: "JSON" },
];

function makeResult(): QueryResult {
  const rows: CellValue[][] = [];
  for (let i = 1; i <= 40; i++) rows.push([i, i % 4 === 0 ? "done" : "open", null]);
  return { columns: COLUMNS, rows, rows_affected: 0, elapsed_ms: 3 };
}

function bodyRowCount(container: HTMLElement): number {
  return container.querySelectorAll("tbody tr:not(.grid-skeleton-row)").length;
}

beforeEach(() => {
  localStorage.clear();
  setLocale("en");
  setColumnDistribution(true);
});

describe("列ヘッダのミニ分布 (#2383)", () => {
  it("数値はヒストグラム、文字列は上位値、JSON は分布なしで描き、unique バッジは id にだけ付く", async () => {
    const { container } = renderWithProviders(<ResultGrid result={makeResult()} />);
    await waitFor(() => expect(container.querySelectorAll("thead .th-dist-bin").length).toBeGreaterThan(0));
    const strips = Array.from(container.querySelectorAll<HTMLElement>("thead .th-dist"));
    expect(strips).toHaveLength(3);
    expect(strips[0].querySelectorAll(".th-dist-bin").length).toBeGreaterThan(1);
    expect(strips[0].querySelector(".th-dist-unique")?.textContent).toBe(t("gridDistUnique"));
    expect(strips[1].querySelectorAll(".th-dist-seg")).toHaveLength(2);
    expect(strips[1].querySelector(".th-dist-unique")).toBeNull();
    expect(strips[2].querySelector(".th-dist-bin")).toBeNull();
    // 近似であることがラベル (ツールチップと同じ文言) で分かる。
    expect(strips[0].querySelector(".th-dist-bin")?.getAttribute("aria-label")).toContain(
      t("gridDistBasis", { n: "40" }),
    );
  });

  it("設定でオフにするとストリップを出さない", () => {
    setColumnDistribution(false);
    const { container } = renderWithProviders(<ResultGrid result={makeResult()} />);
    expect(container.querySelector("thead .th-dist")).toBeNull();
  });

  it("数値のビンのクリックで範囲に絞り込み、もう一度クリックで解除する", async () => {
    const { container } = renderWithProviders(<ResultGrid result={makeResult()} />);
    await waitFor(() => expect(container.querySelectorAll("thead .th-dist-bin").length).toBeGreaterThan(0));
    expect(bodyRowCount(container)).toBe(40);
    const bin = () =>
      container
        .querySelectorAll<HTMLElement>("thead .th-dist")[0]
        .querySelectorAll<HTMLElement>(".th-dist-bin")[0];
    const count = Number(/: (\d+) rows/.exec(bin().getAttribute("aria-label") ?? "")?.[1]);
    expect(count).toBeGreaterThan(0);
    fireEvent.click(bin());
    await waitFor(() => expect(bodyRowCount(container)).toBe(count));
    expect(bin()).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(bin());
    await waitFor(() => expect(bodyRowCount(container)).toBe(40));
  });
});
