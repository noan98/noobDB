import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, renderWithProviders, screen, waitFor } from "./testUtils";
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
    expect(screen.getAllByRole("status").some((e) => e.textContent === t("chartAggInDbPending"))).toBe(true);
    resolve({ ...result, rows: [["jan", 30]] } as unknown as QueryResult);
    await waitFor(() => expect(screen.queryByTestId("chart-skeleton")).toBeNull());
  });
});

describe("ChartView の DB 側集計待ち: 失敗・取消・エクスポート (#1834)", () => {
  const sourceSql = "select month, sales from t";
  beforeEach(() => {
    setLocale("en");
    localStorage.clear();
    const key = chartConfigKeyFrom(sourceSql);
    if (key) {
      localStorage.setItem(key, JSON.stringify({ type: "bar", xCol: 0, yCols: [1], aggregation: "sum" }));
    }
  });

  function mount(onRunQuery: () => Promise<QueryResult>) {
    renderWithProviders(
      <ChartView
        result={result}
        sourceSql={sourceSql}
        onChangeView={() => {}}
        driver="sqlite"
        onRunQuery={onRunQuery}
      />,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: t("chartAggInDb") }));
  }

  it("reject 時は骨格が外れ、手元のチャートと失敗文言が出る", async () => {
    let reject: (e: unknown) => void = () => {};
    mount(() => new Promise<QueryResult>((_, r) => (reject = r)));
    await screen.findByTestId("chart-skeleton");
    reject(new Error("boom"));
    await waitFor(() => expect(screen.queryByTestId("chart-skeleton")).toBeNull());
    expect(screen.getAllByRole("status").some((e) => e.textContent?.includes("boom"))).toBe(true);
    expect(document.querySelector("svg")).not.toBeNull();
  });

  it("待機中にチェックを外すと手元のチャートへ戻る", async () => {
    mount(() => new Promise<QueryResult>(() => {}));
    await screen.findByTestId("chart-skeleton");
    fireEvent.click(screen.getByRole("checkbox", { name: t("chartAggInDb") }));
    await waitFor(() => expect(screen.queryByTestId("chart-skeleton")).toBeNull());
    expect(document.querySelector("svg")).not.toBeNull();
  });

  it("待機中は画像・テキストのエクスポートを押せない", async () => {
    mount(() => new Promise<QueryResult>(() => {}));
    await screen.findByTestId("chart-skeleton");
    expect(screen.getByRole("button", { name: t("chartDataExport") })).toBeDisabled();
    expect(screen.getByRole("button", { name: t("imageExportButton") })).toBeDisabled();
  });
});

describe("ChartView の骨格表示の遅延 (#1834)", () => {
  const sourceSql = "select month, sales from t";
  beforeEach(() => {
    setLocale("en");
    localStorage.clear();
    const key = chartConfigKeyFrom(sourceSql);
    if (key) {
      localStorage.setItem(key, JSON.stringify({ type: "bar", xCol: 0, yCols: [1], aggregation: "sum" }));
    }
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function mount() {
    let resolve: (r: QueryResult) => void = () => {};
    renderWithProviders(
      <ChartView
        result={result}
        sourceSql={sourceSql}
        onChangeView={() => {}}
        driver="sqlite"
        onRunQuery={() => new Promise<QueryResult>((r) => (resolve = r))}
      />,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: t("chartAggInDb") }));
    return () => resolve(result);
  }

  it("179ms では骨格が出ず、181ms で出る", () => {
    mount();
    act(() => {
      vi.advanceTimersByTime(179);
    });
    expect(screen.queryByTestId("chart-skeleton")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(screen.queryByTestId("chart-skeleton")).not.toBeNull();
  });

  it("猶予の途中で結果が届けば骨格は出ない", async () => {
    const resolve = mount();
    act(() => {
      vi.advanceTimersByTime(100);
    });
    await act(async () => {
      resolve();
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.queryByTestId("chart-skeleton")).toBeNull();
  });
});
