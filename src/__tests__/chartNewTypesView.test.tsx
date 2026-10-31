import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, renderWithProviders, screen } from "./testUtils";
import { ChartView } from "../components/ChartView";
import { setLocale, t } from "../i18n";
import type { QueryResult } from "../api/tauri";

const numeric: QueryResult = {
  columns: [
    { name: "month", type_name: "TEXT" },
    { name: "sales", type_name: "INT" },
    { name: "cost", type_name: "INT" },
  ],
  rows: [
    ["jan", 10, 4],
    ["feb", 20, 6],
    ["mar", 30, 9],
  ],
  rows_affected: 0,
  elapsed_ms: 1,
} as unknown as QueryResult;

const oneNumeric: QueryResult = {
  columns: [
    { name: "month", type_name: "TEXT" },
    { name: "sales", type_name: "INT" },
  ],
  rows: [
    ["jan", 10],
    ["feb", 20],
  ],
  rows_affected: 0,
  elapsed_ms: 1,
} as unknown as QueryResult;

async function pickType(label: string) {
  fireEvent.click(screen.getByRole("combobox", { name: t("chartType") }));
  fireEvent.click(await screen.findByRole("option", { name: label }));
}

describe("ChartView の新しい種類 (#1941)", () => {
  beforeEach(() => {
    setLocale("en");
    localStorage.clear();
  });

  it("散布図: 数値の X/Y を選んで点を描く", async () => {
    const { container } = renderWithProviders(
      <ChartView result={numeric} sourceSql="select 1" onChangeView={() => {}} />,
    );
    await pickType(t("chartTypeScatter"));
    expect(container.querySelector('svg[data-chart-kind="scatter"]')).not.toBeNull();
    expect(container.querySelectorAll("[data-scatter-series] circle").length).toBe(3);
  });

  it("ヒストグラム: Y 列と集計の選択を隠し、ビン数を選べる", async () => {
    const { container } = renderWithProviders(
      <ChartView result={numeric} sourceSql="select 1" onChangeView={() => {}} />,
    );
    await pickType(t("chartTypeHistogram"));
    expect(container.querySelector('svg[data-chart-kind="histogram"]')).not.toBeNull();
    expect(container.querySelectorAll("[data-histogram-bin]").length).toBe(10);
    expect(screen.queryByRole("combobox", { name: t("chartAggregation") })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "cost" })).toBeNull();
    expect(screen.getByRole("combobox", { name: t("chartBins") })).toBeInTheDocument();
  });

  it("積み上げ棒: 系列ごとの区画を描く", async () => {
    const { container } = renderWithProviders(
      <ChartView result={numeric} sourceSql="select 1" onChangeView={() => {}} />,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "cost" }));
    await pickType(t("chartTypeStackedBar"));
    expect(container.querySelectorAll("svg[data-chart-svg] rect[stroke]").length).toBeGreaterThanOrEqual(6);
  });

  it("複合: 折れ線は右軸で描き、折れ線の列を選べる", async () => {
    const { container } = renderWithProviders(
      <ChartView result={numeric} sourceSql="select 1" onChangeView={() => {}} />,
    );
    await pickType(t("chartTypeCombo"));
    expect(container.querySelector("[data-chart-right-axis]")).not.toBeNull();
    expect(container.querySelectorAll("svg[data-chart-svg] polyline").length).toBe(1);
    expect(screen.getByRole("combobox", { name: t("chartComboLine") })).toBeInTheDocument();
  });

  it("要求する列が足りないときは案内を出す", async () => {
    renderWithProviders(<ChartView result={oneNumeric} sourceSql="select 2" onChangeView={() => {}} />);
    await pickType(t("chartTypeScatter"));
    expect(screen.getByText(t("chartNeedScatter"))).toBeInTheDocument();
    await pickType(t("chartTypeCombo"));
    expect(screen.getByText(t("chartNeedCombo"))).toBeInTheDocument();
  });
});
