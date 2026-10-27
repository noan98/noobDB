import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders as render } from "./testUtils";
import { RevealTbody } from "../components/RevealTbody";
import { revealViewportBottom } from "../components/rowsMountReveal";

// 読み取り専用メタデータパネルの行リビール (#1886)。jsdom には Element.animate が無いのでスタブする。

const reducedRef = vi.hoisted(() => ({ value: false }));
vi.mock("motion/react", async (importOriginal) => {
  const mod = await importOriginal<typeof import("motion/react")>();
  return { ...mod, useReducedMotionConfig: () => reducedRef.value };
});

const table = (n: number) => (
  <table>
    <RevealTbody>
      {Array.from({ length: n }, (_, i) => (
        <tr key={i}>
          <td>{i}</td>
        </tr>
      ))}
    </RevealTbody>
  </table>
);

describe("RevealTbody (#1886)", () => {
  const cancel = vi.fn();
  const animate = vi.fn(() => ({ cancel }));
  beforeEach(() => {
    reducedRef.value = false;
    animate.mockClear();
    cancel.mockClear();
    Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate });
  });
  afterEach(() => {
    Reflect.deleteProperty(HTMLElement.prototype, "animate");
  });

  it("マウント時に行ごとへ 1 回だけ再生し、再レンダーでは再生しない", () => {
    const { rerender } = render(table(3));
    expect(animate).toHaveBeenCalledTimes(3);
    rerender(table(5));
    expect(animate).toHaveBeenCalledTimes(3);
  });

  it("遅延は段数の上限で頭打ちになる", () => {
    render(table(30));
    const delays = (animate.mock.calls as unknown as [unknown, { delay: number }][]).map((c) => c[1].delay);
    expect(delays[0]).toBe(0);
    expect(delays[11]).toBe(delays[29]);
  });

  it("reduced-motion では再生しない", () => {
    reducedRef.value = true;
    render(table(3));
    expect(animate).not.toHaveBeenCalled();
  });
});

describe("revealViewportBottom (#1886)", () => {
  it("最も近いスクロール祖先の下端、無ければ window の高さ", () => {
    const outer = document.createElement("div");
    const inner = document.createElement("div");
    outer.appendChild(inner);
    outer.getBoundingClientRect = () => ({ bottom: 240 }) as DOMRect;
    expect(revealViewportBottom(inner, (el) => (el === outer ? "auto" : "visible"), 800)).toBe(240);
    expect(revealViewportBottom(inner, () => "visible", 800)).toBe(800);
  });

  it("内側が auto で高さ無制限でも、外側のスクロール領域の下端で止まる", () => {
    const outer = document.createElement("div");
    const mid = document.createElement("div");
    const inner = document.createElement("div");
    outer.appendChild(mid);
    mid.appendChild(inner);
    outer.getBoundingClientRect = () => ({ bottom: 300 }) as DOMRect;
    mid.getBoundingClientRect = () => ({ bottom: 5000 }) as DOMRect;
    expect(revealViewportBottom(inner, () => "auto", 800)).toBe(300);
    expect(revealViewportBottom(inner, (el) => (el === mid ? "auto" : "visible"), 800)).toBe(800);
  });
});

describe("RevealTbody の行数上限 (#1886)", () => {
  it("下端が無制限でも FIRST_BATCH_REVEAL_FALLBACK_ROWS 行までしか再生しない", () => {
    const animate = vi.fn(() => ({ cancel: vi.fn() }));
    Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate });
    try {
      reducedRef.value = false;
      render(table(500));
      expect(animate).toHaveBeenCalledTimes(50);
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, "animate");
    }
  });
});
