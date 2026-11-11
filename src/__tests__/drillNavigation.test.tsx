import { createRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { act, fireEvent, renderWithProviders, screen, waitFor } from "./testUtils";
import { PivotView } from "../components/PivotView";
import { CartesianChart } from "../components/ChartView";
import { DrillChip } from "../components/DrillChip";
import { ResultGrid, type ResultGridHandle } from "../components/ResultGrid";
import type { ColumnFilterRequest } from "../components/drillFilter";
import type { CellValue, QueryResult } from "../api/tauri";
import { setLocale } from "../i18n";

// ピボット / チャートから、絞り込んだグリッドへ移る結線 (#2236)。

const ROWS: CellValue[][] = [
  ["east", "paid", 10],
  ["east", "open", 5],
  ["west", "paid", 20],
  [null, "paid", 1],
];
const result: QueryResult = {
  columns: [
    { name: "region", type_name: "VARCHAR" },
    { name: "status", type_name: "VARCHAR" },
    { name: "amount", type_name: "INT" },
  ],
  rows: ROWS,
  rows_affected: 0,
  elapsed_ms: 1,
};

beforeEach(() => {
  localStorage.clear();
  setLocale("en");
});

describe("PivotView の絞り込み導線", () => {
  const render = (onDrill = vi.fn(), initialScrollTop?: number) =>
    renderWithProviders(
      <PivotView
        result={result}
        driver="mysql"
        sourceSql="SELECT 1"
        onChangeView={() => {}}
        onDrill={onDrill}
        initialScrollTop={initialScrollTop}
      />,
    );

  it("本体セルはクリックで行軸 × 列軸の条件を渡す", async () => {
    const onDrill = vi.fn();
    render(onDrill);
    const cell = screen.getByRole("cell", { name: /region=east × status=paid: 10/ });
    await userEvent.setup().click(cell);
    expect(onDrill).toHaveBeenCalledTimes(1);
    expect(onDrill.mock.calls[0][0].conditions).toEqual([
      { colIdx: 0, column: "region", value: "east" },
      { colIdx: 1, column: "status", value: "paid" },
    ]);
  });

  it("フォーカスして Enter / Space でも同じ操作ができる", () => {
    const onDrill = vi.fn();
    render(onDrill);
    const cell = screen.getByRole("cell", { name: /region=west × status=paid: 20/ });
    fireEvent.keyDown(cell, { key: "Enter" });
    fireEvent.keyDown(cell, { key: " " });
    fireEvent.keyDown(cell, { key: "a" });
    expect(onDrill).toHaveBeenCalledTimes(2);
  });

  it("Tab 停止は表全体で 1 つ。矢印キーで操作できるセルへ移り、空セルは飛ばす", () => {
    const { container } = render();
    const stops = () => container.querySelectorAll("[data-drill-pos][tabindex='0']");
    expect(stops()).toHaveLength(1);
    // 先頭の操作可能セルは先頭の列見出し。
    const first = stops()[0] as HTMLElement;
    expect(first.getAttribute("data-drill-pos")).toBe("0:1");
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    // 見出しの下は east 行の先頭セル (r=1, c=1)。
    expect(document.activeElement).toHaveAttribute("data-drill-pos", "1:1");
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowRight" });
    expect(document.activeElement).toHaveAttribute("data-drill-pos", "1:2");
    // フォーカスしたセルが新しい Tab 停止になる。
    expect(stops()).toHaveLength(1);
    expect(stops()[0]).toBe(document.activeElement);
    // End は行末 (行の合計、c = 列数 + 1) へ。
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "End" });
    expect(document.activeElement).toHaveAttribute("data-drill-pos", "1:3");
    // 下へ: west × open は空セルだが、行の合計 (1 列右端) は操作できる。空セルを踏まず移れる。
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowDown" });
    expect(document.activeElement).toHaveAttribute("data-drill-pos", "2:3");
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowLeft" });
    expect(document.activeElement).toHaveAttribute("data-drill-pos", "2:1");
  });

  it("行見出しは行軸だけ、NULL の行は NULL 条件で絞る", () => {
    const onDrill = vi.fn();
    render(onDrill);
    fireEvent.click(screen.getByRole("cell", { name: /^region=east\./ }));
    expect(onDrill.mock.calls[0][0].conditions).toEqual([{ colIdx: 0, column: "region", value: "east" }]);
    fireEvent.click(screen.getByRole("cell", { name: /^region=NULL\./ }));
    expect(onDrill.mock.calls[1][0].conditions).toEqual([{ colIdx: 0, column: "region", value: null }]);
  });

  it("データの無い空セルと総計は操作対象にしない", () => {
    const { container } = render();
    // west × open は該当行が無い空セル。
    const tds = container.querySelectorAll("tbody tr:nth-child(2) td");
    const empty = Array.from(tds).filter((td) => td.textContent === "");
    expect(empty.length).toBeGreaterThan(0);
    for (const td of empty) expect(td).not.toHaveAttribute("tabindex");
    const grand = container.querySelector("tfoot tr td:last-child");
    expect(grand).not.toHaveAttribute("tabindex");
  });

  it("onDrill が無ければ従来どおり操作できない", () => {
    const { container } = renderWithProviders(
      <PivotView result={result} driver="mysql" sourceSql="SELECT 1" onChangeView={() => {}} />,
    );
    expect(container.querySelector("td[tabindex]")).toBeNull();
  });

  it("スクロール位置を戻ってきたときに復元する", () => {
    const { container } = render(vi.fn(), 120);
    expect((container.querySelector("table")?.parentElement as HTMLElement).scrollTop).toBe(120);
  });
});

describe("CartesianChart の絞り込み導線", () => {
  const model = {
    labels: ["a", "b", "c"],
    series: [{ name: "s", values: [1, 2, 3] }],
    sampledFrom: null,
  };

  it("矢印で選んだ点で Enter を押すと、その点のインデックスを渡す", () => {
    const onDrillIndex = vi.fn();
    renderWithProviders(
      <CartesianChart model={model} type="bar" xName="x" colors={["#000"]} onDrillIndex={onDrillIndex} />,
    );
    const svg = screen.getByRole("group");
    fireEvent.keyDown(svg, { key: "Enter" });
    expect(onDrillIndex).not.toHaveBeenCalled(); // まだ点を選んでいない
    fireEvent.keyDown(svg, { key: "ArrowRight" });
    fireEvent.keyDown(svg, { key: "ArrowRight" });
    expect(screen.getByRole("status")).toHaveTextContent("b: s 2");
    fireEvent.keyDown(svg, { key: "Enter" });
    expect(onDrillIndex).toHaveBeenCalledWith(1);
  });

  it("onDrillIndex が無ければ Enter では何も起きず、読み上げに操作ヒントも出ない", () => {
    renderWithProviders(<CartesianChart model={model} type="bar" xName="x" colors={["#000"]} />);
    const svg = screen.getByRole("group");
    expect(svg.getAttribute("aria-label")).not.toMatch(/Enter/);
    fireEvent.keyDown(svg, { key: "ArrowRight" });
    expect(screen.getByRole("status")).not.toHaveTextContent("Enter");
  });

  it("操作できるチャートは aria-label で Enter での絞り込みを案内する", () => {
    renderWithProviders(
      <CartesianChart model={model} type="bar" xName="x" colors={["#000"]} onDrillIndex={() => {}} />,
    );
    expect(screen.getByRole("group").getAttribute("aria-label")).toMatch(/Enter/);
  });
});

describe("DrillChip", () => {
  it("要約と 2 つの操作を出し、押すと対応するコールバックを呼ぶ", async () => {
    const onBack = vi.fn();
    const onClear = vi.fn();
    renderWithProviders(
      <DrillChip source="pivot" summary="region=east × status=paid" onBack={onBack} onClear={onClear} />,
    );
    expect(screen.getByTestId("drill-chip")).toHaveTextContent(
      "Filtered from pivot: region=east × status=paid",
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Back to pivot/ }));
    await user.click(screen.getByRole("button", { name: /Clear filter/ }));
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("サーバ側ページングでは対象が取得済みの行だけであることを示す", () => {
    renderWithProviders(
      <DrillChip source="chart" summary="region=east" count={50} onBack={() => {}} onClear={() => {}} />,
    );
    expect(screen.getByTestId("drill-chip")).toHaveTextContent("(50 fetched rows)");
    expect(screen.getByRole("button", { name: /Back to chart/ })).toBeInTheDocument();
  });
});

describe("ResultGrid の外部列フィルタ", () => {
  const apply: ColumnFilterRequest = {
    mode: "apply",
    conditions: [
      { colIdx: 0, column: "region", value: "east" },
      { colIdx: 1, column: "status", value: "paid" },
    ],
  };

  it("宣言的な要求を適用し、適用済みを 1 回通知する", async () => {
    const onApplied = vi.fn();
    const { container } = renderWithProviders(
      <ResultGrid result={result} columnFilterRequest={apply} onColumnFilterRequestApplied={onApplied} />,
    );
    await waitFor(() => expect(container.querySelectorAll("tbody tr")).toHaveLength(1));
    expect(onApplied).toHaveBeenCalledTimes(1);
  });

  it("命令型ハンドルで適用 / 解除できる (NULL キーは IS NULL)", async () => {
    const ref = createRef<ResultGridHandle>();
    const { container } = renderWithProviders(<ResultGrid ref={ref} result={result} />);
    expect(container.querySelectorAll("tbody tr")).toHaveLength(4);
    act(() =>
      ref.current?.applyColumnFilters({
        mode: "apply",
        conditions: [{ colIdx: 0, column: "region", value: null }],
      }),
    );
    await waitFor(() => expect(container.querySelectorAll("tbody tr")).toHaveLength(1));
    act(() =>
      ref.current?.applyColumnFilters({
        mode: "clear",
        conditions: [{ colIdx: 0, column: "region", value: null }],
      }),
    );
    await waitFor(() => expect(container.querySelectorAll("tbody tr")).toHaveLength(4));
  });
});
