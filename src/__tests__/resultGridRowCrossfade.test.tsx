import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen } from "./testUtils";
import { ResultGrid } from "../components/ResultGrid";
import type { Column, QueryResult } from "../api/tauri";
import { setLocale, t } from "../i18n";

// クライアント側ソート / フィルタ適用時の <tbody> クロスフェード (#1416)。
// jsdom には Element.animate が無いのでスタブして呼び出しを見る。

const reducedRef = vi.hoisted(() => ({ value: false }));
vi.mock("motion/react", async (importOriginal) => {
  const mod = await importOriginal<typeof import("motion/react")>();
  return { ...mod, useReducedMotionConfig: () => reducedRef.value };
});

const columns: Column[] = [
  { name: "id", type_name: "INT" },
  { name: "a", type_name: "VARCHAR" },
];
const result: QueryResult = {
  columns,
  rows: Array.from({ length: 10 }, (_, i) => [i, `v${9 - i}`]),
  rows_affected: 10,
  elapsed_ms: 1,
};

describe("結果グリッドの行クロスフェード (#1416)", () => {
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

  it("マウント時は再生せず、ソートで <tbody> に opacity を 1 回だけ再生し、DOM は作り直さない", async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(<ResultGrid result={result} />);
    expect(animate).not.toHaveBeenCalled();
    const tbody = container.querySelector("tbody");
    const cellBefore = Array.from(container.querySelectorAll("tbody td[role='gridcell']")).find(
      (td) => td.textContent === "v9",
    );
    await user.click(container.querySelectorAll<HTMLElement>(".th-sort-button")[1]);
    expect(animate).toHaveBeenCalledTimes(1);
    const calls = animate.mock.calls as unknown as unknown[][];
    expect(animate.mock.contexts[0]).toBe(tbody);
    expect(calls[0][0]).toEqual([{ opacity: 0.35 }, { opacity: 1 }]);
    // 再マウントされていない (スクロール・選択・編集状態が保たれる)。
    expect(container.querySelector("tbody")).toBe(tbody);
    expect(cellBefore?.isConnected).toBe(true);
  });

  it("検索 (グローバルフィルタ) の適用でも再生し、無関係な再レンダーでは再生しない", async () => {
    const user = userEvent.setup();
    const { rerender, container } = renderWithProviders(<ResultGrid result={result} />);
    rerender(<ResultGrid result={result} />);
    expect(animate).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText(t("gridSearchAria")), "v1");
    expect(animate).toHaveBeenCalled();
    expect(animate.mock.contexts.every((c) => c === container.querySelector("tbody"))).toBe(true);
  });

  it("reduced-motion では再生しない", async () => {
    reducedRef.value = true;
    const user = userEvent.setup();
    const { container } = renderWithProviders(<ResultGrid result={result} />);
    await user.click(container.querySelectorAll<HTMLElement>(".th-sort-button")[1]);
    expect(animate).not.toHaveBeenCalled();
  });
});
