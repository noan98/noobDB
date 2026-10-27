import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "./testUtils";
import { PivotView } from "../components/PivotView";
import type { QueryResult } from "../api/tauri";
import { setLocale } from "../i18n";

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
});
