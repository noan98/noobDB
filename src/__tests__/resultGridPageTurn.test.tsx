import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "./testUtils";
import { ResultGrid } from "../components/ResultGrid";
import type { Column, QueryResult } from "../api/tauri";
import { setLocale } from "../i18n";
import { slideOffsets } from "../motion";

// ページ送り時の <tbody> スライド (#1752)。jsdom には Element.animate が無いのでスタブする。

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
  rows: Array.from({ length: 10 }, (_, i) => [i, `v${i}`]),
  rows_affected: 10,
  elapsed_ms: 1,
};

describe("結果グリッドのページ送り演出 (#1752)", () => {
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

  const frames = () => (animate.mock.calls[0] as unknown as [Array<Record<string, unknown>>])[0];

  it("マウント時は再生せず、次ページで右から入るスライドを 1 回再生し、DOM は作り直さない", () => {
    const { container, rerender } = renderWithProviders(
      <ResultGrid result={result} pageTurnPage={1} pageTurnScope="t1" />,
    );
    expect(animate).not.toHaveBeenCalled();
    const tbody = container.querySelector("tbody");
    rerender(<ResultGrid result={{ ...result }} pageTurnPage={2} pageTurnScope="t1" />);
    expect(animate).toHaveBeenCalledTimes(1);
    expect(frames()[0]).toMatchObject({ opacity: 0, transform: `translateX(${slideOffsets.page}px)` });
    expect(container.querySelector("tbody")).toBe(tbody);
  });

  it("前ページは左から入る", () => {
    const { rerender } = renderWithProviders(
      <ResultGrid result={result} pageTurnPage={3} pageTurnScope="t1" />,
    );
    rerender(<ResultGrid result={{ ...result }} pageTurnPage={2} pageTurnScope="t1" />);
    expect(frames()[0]).toMatchObject({ transform: `translateX(${-slideOffsets.page}px)` });
  });

  it("大ジャンプは方向なしのクロスフェード", () => {
    const { rerender } = renderWithProviders(
      <ResultGrid result={result} pageTurnPage={1} pageTurnScope="t1" />,
    );
    rerender(<ResultGrid result={{ ...result }} pageTurnPage={9} pageTurnScope="t1" />);
    expect(frames()[0]).toMatchObject({ transform: "translateX(0px)" });
    expect(frames()[0].opacity).toBeGreaterThan(0);
  });

  it("タブ (scope) が変わったときは再生しない", () => {
    const { rerender } = renderWithProviders(
      <ResultGrid result={result} pageTurnPage={1} pageTurnScope="t1" />,
    );
    rerender(<ResultGrid result={{ ...result }} pageTurnPage={2} pageTurnScope="t2" />);
    expect(animate).not.toHaveBeenCalled();
  });

  it("ハイコントラストテーマ (hc-*) では再生しない", () => {
    document.documentElement.setAttribute("data-theme", "hc-dark");
    try {
      const { rerender } = renderWithProviders(
        <ResultGrid result={result} pageTurnPage={1} pageTurnScope="t1" />,
      );
      rerender(<ResultGrid result={{ ...result }} pageTurnPage={2} pageTurnScope="t1" />);
      expect(animate).not.toHaveBeenCalled();
    } finally {
      document.documentElement.removeAttribute("data-theme");
    }
  });

  it("ページ変更でスクロールが先頭に戻り、scope 変更では維持される", () => {
    const { container, rerender } = renderWithProviders(
      <ResultGrid result={result} pageTurnPage={1} pageTurnScope="t1" />,
    );
    const scroller = container.querySelector("tbody")?.closest("div") as HTMLElement;
    scroller.scrollTop = 50;
    rerender(<ResultGrid result={{ ...result }} pageTurnPage={2} pageTurnScope="t2" />);
    expect(scroller.scrollTop).toBe(50);
    rerender(<ResultGrid result={{ ...result }} pageTurnPage={3} pageTurnScope="t2" />);
    expect(scroller.scrollTop).toBe(0);
  });

  it("列が少なく横にはみ出さない表では、再生中だけ overflow-x を隠す", () => {
    const fin = Promise.resolve();
    animate.mockImplementation(() => ({ cancel: vi.fn(), finished: fin }) as never);
    const { container, rerender } = renderWithProviders(
      <ResultGrid result={result} pageTurnPage={1} pageTurnScope="t1" />,
    );
    const scroller = container.querySelector("tbody")?.closest("div") as HTMLElement;
    rerender(<ResultGrid result={{ ...result }} pageTurnPage={2} pageTurnScope="t1" />);
    // jsdom は scrollWidth/clientWidth とも 0 なので「はみ出さない」扱い。
    expect(scroller.style.overflowX).toBe("hidden");
    return fin.then(() => {
      expect(scroller.style.overflowX).toBe("");
    });
  });

  it("reduced-motion では再生しない", () => {
    reducedRef.value = true;
    const { rerender } = renderWithProviders(
      <ResultGrid result={result} pageTurnPage={1} pageTurnScope="t1" />,
    );
    rerender(<ResultGrid result={{ ...result }} pageTurnPage={2} pageTurnScope="t1" />);
    expect(animate).not.toHaveBeenCalled();
  });
});
