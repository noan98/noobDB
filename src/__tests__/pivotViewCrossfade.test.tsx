import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor, within } from "./testUtils";
import { PivotView } from "../components/PivotView";
import type { QueryResult } from "../api/tauri";
import { setLocale, t } from "../i18n";

// ピボット再集計の <tbody> クロスフェード (#1862)。jsdom には Element.animate が無いのでスタブする。

const reducedRef = vi.hoisted(() => ({ value: false }));
vi.mock("motion/react", async (importOriginal) => {
  const mod = await importOriginal<typeof import("motion/react")>();
  return { ...mod, useReducedMotionConfig: () => reducedRef.value };
});

const result: QueryResult = {
  columns: [
    { name: "region", type_name: "VARCHAR" },
    { name: "amount", type_name: "INT" },
  ],
  rows: [
    ["east", 10],
    ["west", 20],
    ["east", 5],
  ],
  rows_affected: 3,
  elapsed_ms: 1,
};

describe("ピボットの再集計クロスフェード (#1862)", () => {
  const animate = vi.fn(() => ({ cancel: vi.fn() }));
  beforeEach(() => {
    localStorage.clear();
    setLocale("en");
    reducedRef.value = false;
    animate.mockClear();
    Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate });
  });
  afterEach(() => {
    Reflect.deleteProperty(HTMLElement.prototype, "animate");
  });

  it("マウント時は再生せず、設定の切替で <tbody> に 1 回だけ再生し、DOM は作り直さない", async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(
      <PivotView result={result} driver="mysql" sourceSql="SELECT 1" onChangeView={() => {}} />,
    );
    expect(animate).not.toHaveBeenCalled();
    const tbody = container.querySelector("tbody");
    await user.click(container.querySelector("input[type='checkbox']") as HTMLElement);
    expect(animate).toHaveBeenCalledTimes(1);
    const calls = animate.mock.calls as unknown as unknown[][];
    expect(animate.mock.contexts[0]).toBe(tbody);
    expect(calls[0][0]).toEqual([{ opacity: 0.35 }, { opacity: 1 }]);
    expect(container.querySelector("tbody")).toBe(tbody);
  });

  it("reduced-motion では再生しない", async () => {
    reducedRef.value = true;
    const user = userEvent.setup();
    const { container } = renderWithProviders(
      <PivotView result={result} driver="mysql" sourceSql="SELECT 1" onChangeView={() => {}} />,
    );
    await user.click(container.querySelector("input[type='checkbox']") as HTMLElement);
    expect(animate).not.toHaveBeenCalled();
  });

  it("集計関数を変えると最終値が正しく出る (補間は span 1 つだけで二重にならない)", async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(
      <PivotView result={result} driver="mysql" sourceSql="SELECT 1" onChangeView={() => {}} />,
    );
    const eastRow = () => within(screen.getByText("east", { selector: "td" }).closest("tr") as HTMLElement);
    expect(eastRow().getAllByText("15").length).toBeGreaterThan(0);
    await user.click(screen.getByRole("combobox", { name: t("pivotAgg") }));
    await user.click(screen.getByRole("option", { name: t("pivotAgg_max") }));
    await waitFor(() => expect(eastRow().getAllByText("10").length).toBe(2));
    expect(eastRow().queryByText("15")).toBeNull();
    // 数値セルは見える桁の span 1 つだけ (ドラッグコピーで値が二重にならない)。
    for (const td of Array.from(container.querySelectorAll("tbody td:not(:first-child)"))) {
      expect(td.querySelectorAll("span").length).toBe(1);
      expect(td.textContent).toMatch(/^\d+$/);
    }
  });

  it("セル数が上限 (600) を超える大きな表は補間せず静的に表示する", () => {
    const rows = Array.from({ length: 40 }, (_, r) =>
      Array.from({ length: 20 }, (_, c) => [`r${r}`, `c${c}`, r * 20 + c + 1]),
    ).flat();
    const big: QueryResult = {
      columns: [
        { name: "a", type_name: "VARCHAR" },
        { name: "b", type_name: "VARCHAR" },
        { name: "n", type_name: "INT" },
      ],
      rows,
      rows_affected: rows.length,
      elapsed_ms: 1,
    };
    const { container } = renderWithProviders(
      <PivotView result={big} driver="mysql" sourceSql="SELECT 2" onChangeView={() => {}} />,
    );
    expect(container.querySelectorAll("tbody td").length).toBeGreaterThan(600);
    expect(container.querySelectorAll("tbody td span").length).toBe(0);
    expect(within(container).getAllByText("1").length).toBeGreaterThan(0);
  });
});
