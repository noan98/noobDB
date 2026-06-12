import { describe, it, expect } from "vitest";
import css from "../App.css?raw";
import modalSrc from "../components/Modal.tsx?raw";
import ctxSrc from "../components/ContextMenu.tsx?raw";
import toastSrc from "../components/Toast.tsx?raw";

/**
 * エレベーション/レイヤリング体系の回帰テスト。z-index スケールの順序と
 * オーバーレイがトークンを参照することを固定し、マジックナンバーの再混入を防ぐ。
 */
const root = css.match(/:root\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";

function zVar(name: string): number {
  const m = root.match(new RegExp(`--z-${name}:\\s*(\\d+);`));
  expect(m, `--z-${name} must be defined`).toBeTruthy();
  return Number(m![1]);
}

describe("z-index scale ordering (#500)", () => {
  it("orders layers base < sticky < raised < sidebar < modal < dropdown < popover < toast", () => {
    const order = ["base", "sticky", "raised", "sidebar", "modal", "dropdown", "popover", "toast"];
    const values = order.map(zVar);
    for (let i = 1; i < values.length; i++) {
      expect(values[i], `--z-${order[i]} must exceed --z-${order[i - 1]}`).toBeGreaterThan(
        values[i - 1],
      );
    }
  });

  it("keeps popovers/menus above modals (so context menus open inside dialogs)", () => {
    expect(zVar("popover")).toBeGreaterThan(zVar("modal"));
    expect(zVar("toast")).toBeGreaterThan(zVar("popover"));
  });
});

describe("elevation tokens (#500)", () => {
  it("defines per-layer elevation tokens referencing the shadow scale", () => {
    for (const layer of ["raised", "popover", "toast", "modal"]) {
      expect(
        new RegExp(`--elevation-${layer}:\\s*var\\(--shadow-`).test(root),
        `--elevation-${layer} must reference a --shadow-* token`,
      ).toBe(true);
    }
  });
});

describe("overlays reference layering tokens, not magic numbers (#500)", () => {
  it("Modal uses the modal layer token", () => {
    expect(modalSrc).toMatch(/zIndex:\s*"modal"/);
    expect(modalSrc).not.toMatch(/zIndex:\s*100\b/);
  });
  it("ContextMenu uses the popover layer token", () => {
    expect(ctxSrc).toMatch(/zIndex="popover"/);
    expect(ctxSrc).not.toMatch(/zIndex=\{1000\}/);
  });
  it("Toast uses the toast layer token", () => {
    expect(toastSrc).toMatch(/zIndex="toast"/);
    expect(toastSrc).not.toMatch(/zIndex=\{2000\}/);
  });
});
