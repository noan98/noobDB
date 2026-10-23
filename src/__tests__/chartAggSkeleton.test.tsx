import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, renderWithProviders, screen, waitFor } from "./testUtils";
import { ChartView } from "../components/ChartView";
import { chartConfigKeyFrom } from "../components/chartData";
import { setLocale, t } from "../i18n";
import type { QueryResult } from "../api/tauri";

const result = {
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

describe("ChartView の DB 側集計待ちスケルトン (#1834)", () => {
  beforeEach(() => {
    setLocale("en");
    localStorage.clear();
  });

  it("集計待ちの間は軸 + 棒の骨格と status 文言を出し、結果が届くと骨格を外す", async () => {
    const sourceSql = "select month, sales from t";
    const key = chartConfigKeyFrom(sourceSql);
    if (key) {
      localStorage.setItem(key, JSON.stringify({ type: "bar", xCol: 0, yCols: [1], aggregation: "sum" }));
    }
    let resolve: (r: QueryResult) => void = () => {};
    const onRunQuery = () => new Promise<QueryResult>((r) => (resolve = r));
    renderWithProviders(
      <ChartView
        result={result}
        sourceSql={sourceSql}
        onChangeView={() => {}}
        driver="sqlite"
        onRunQuery={onRunQuery}
      />,
    );
    expect(screen.queryByTestId("chart-skeleton")).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: t("chartAggInDb") }));
    expect(await screen.findByTestId("chart-skeleton")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByRole("status")).toHaveTextContent(t("chartAggInDbPending"));
    resolve({ ...result, rows: [["jan", 30]] } as unknown as QueryResult);
    await waitFor(() => expect(screen.queryByTestId("chart-skeleton")).toBeNull());
  });
});
