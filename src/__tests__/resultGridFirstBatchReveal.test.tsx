import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "./testUtils";
import { ResultGrid } from "../components/ResultGrid";
import type { Column, QueryResult } from "../api/tauri";
import { setLocale } from "../i18n";

// 初回バッチ着弾の stagger リビール (#1579)。jsdom には Element.animate が無いのでスタブする。

const reducedRef = vi.hoisted(() => ({ value: false }));
vi.mock("motion/react", async (importOriginal) => {
  const mod = await importOriginal<typeof import("motion/react")>();
  return { ...mod, useReducedMotionConfig: () => reducedRef.value };
});

const columns: Column[] = [{ name: "id", type_name: "INT" }];
const result = (n: number): QueryResult => ({
  columns,
  rows: Array.from({ length: n }, (_, i) => [i]),
  rows_affected: n,
  elapsed_ms: 1,
});

describe("結果グリッドの初回バッチリビール (#1579)", () => {
  const cancel = vi.fn();
  const animate = vi.fn(() => ({ cancel }));
  beforeEach(() => {
    localStorage.clear();
    setLocale("en");
    reducedRef.value = false;
    animate.mockClear();
    cancel.mockClear();
    Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate });
  });
  afterEach(() => {
    Reflect.deleteProperty(HTMLElement.prototype, "animate");
    document.documentElement.removeAttribute("data-theme");
  });

  it("スケルトン → 最初の行で行 <tr> ごとに stagger 再生し、追加バッチでは再生しない", () => {
    const { rerender } = renderWithProviders(<ResultGrid result={result(0)} streaming />);
    expect(animate).not.toHaveBeenCalled();
    rerender(<ResultGrid result={result(5)} streaming />);
    expect(animate).toHaveBeenCalledTimes(5);
    const calls = animate.mock.calls as unknown as Array<[unknown, { delay: number }]>;
    expect(calls.map((c) => c[1].delay)).toEqual([0, 35, 70, 105, 140]);
    animate.mockClear();
    rerender(<ResultGrid result={result(50)} streaming />);
    expect(animate).not.toHaveBeenCalled();
  });

  it("ストリーミングでない通常表示 (行が最初からある / 後から差し替わる) では再生しない", () => {
    const { rerender } = renderWithProviders(<ResultGrid result={result(0)} />);
    rerender(<ResultGrid result={result(5)} />);
    expect(animate).not.toHaveBeenCalled();
  });

  it("reduced-motion では再生しない", () => {
    reducedRef.value = true;
    const { rerender } = renderWithProviders(<ResultGrid result={result(0)} streaming />);
    rerender(<ResultGrid result={result(5)} streaming />);
    expect(animate).not.toHaveBeenCalled();
  });

  it("ハイコントラストテーマでは再生しない", () => {
    document.documentElement.setAttribute("data-theme", "hc-dark");
    const { rerender } = renderWithProviders(<ResultGrid result={result(0)} streaming />);
    rerender(<ResultGrid result={result(5)} streaming />);
    expect(animate).not.toHaveBeenCalled();
  });

  it("2 回目のクエリ (スケルトンに戻る → 再着弾) でもう一度再生する", () => {
    const { rerender } = renderWithProviders(<ResultGrid result={result(0)} streaming />);
    rerender(<ResultGrid result={result(3)} streaming />);
    expect(animate).toHaveBeenCalledTimes(3);
    rerender(<ResultGrid result={result(0)} streaming />);
    animate.mockClear();
    rerender(<ResultGrid result={result(4)} streaming />);
    expect(animate).toHaveBeenCalledTimes(4);
  });

  it("アンマウント時に再生中の Animation を cancel する", () => {
    const { rerender, unmount } = renderWithProviders(<ResultGrid result={result(0)} streaming />);
    rerender(<ResultGrid result={result(3)} streaming />);
    cancel.mockClear();
    unmount();
    expect(cancel).toHaveBeenCalledTimes(3);
  });
});
