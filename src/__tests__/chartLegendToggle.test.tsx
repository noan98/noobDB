import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, renderWithProviders, screen } from "./testUtils";
import { ChartView } from "../components/ChartView";
import { setLocale, t } from "../i18n";
import type { QueryResult } from "../api/tauri";

const result: QueryResult = {
  columns: [
    { name: "month", type_name: "TEXT" },
    { name: "sales", type_name: "INT" },
    { name: "cost", type_name: "INT" },
  ],
  rows: [
    ["jan", 10, 4],
    ["feb", 20, 6],
  ],
  rows_affected: 0,
  elapsed_ms: 1,
} as unknown as QueryResult;

describe("ChartView の凡例による系列の表示切替 (#1628)", () => {
  beforeEach(() => {
    setLocale("en");
    localStorage.clear();
  });

  function renderTwoSeries() {
    renderWithProviders(<ChartView result={result} sourceSql="select 1" onChangeView={() => {}} />);
    // 既定の Y 軸は先頭の数値列だけなので、2 系列にするため cost も選ぶ。
    fireEvent.click(screen.getByRole("checkbox", { name: "cost" }));
  }

  it("凡例を押すと系列を隠し、もう一度押すと戻る", () => {
    renderTwoSeries();
    const hideSales = screen.getByRole("button", { name: t("chartLegendHideSeries", { name: "sales" }) });
    expect(hideSales).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(hideSales);
    const showSales = screen.getByRole("button", { name: t("chartLegendShowSeries", { name: "sales" }) });
    expect(showSales).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(showSales);
    expect(
      screen.getByRole("button", { name: t("chartLegendHideSeries", { name: "sales" }) }),
    ).toBeInTheDocument();
  });

  it("最後の 1 系列は隠せない", () => {
    renderTwoSeries();
    fireEvent.click(screen.getByRole("button", { name: t("chartLegendHideSeries", { name: "sales" }) }));
    fireEvent.click(screen.getByRole("button", { name: t("chartLegendHideSeries", { name: "cost" }) }));
    expect(
      screen.getByRole("button", { name: t("chartLegendHideSeries", { name: "cost" }) }),
    ).toHaveAttribute("aria-pressed", "true");
  });
});
