// @vitest-environment jsdom (DOM のクラス付与と animationend を確かめるため)
import { afterEach, describe, expect, it, vi } from "vitest";
import { focusLandingPulseEnabled, pulseFocusLanding } from "../components/focusLandingPulse";

function mountRegions() {
  document.body.innerHTML = `<aside id="side"><input id="filter"></aside><div id="host"><div><div class="cm-editor"><div id="cm" tabindex="0"></div></div></div></div><div id="grid" tabindex="0"></div>`;
  return {
    side: document.getElementById("side") as HTMLElement,
    filter: document.getElementById("filter") as HTMLElement,
    grid: document.getElementById("grid") as HTMLElement,
    root: document.getElementById("host") as HTMLElement,
    cm: document.getElementById("cm") as HTMLElement,
  };
}

afterEach(() => {
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("data-motion");
  document.documentElement.removeAttribute("data-theme");
  vi.unstubAllGlobals();
});

describe("pulseFocusLanding (#1764)", () => {
  it("エディタは .cm-editor ではなくそのルート (親の親) にクラスを付ける", () => {
    const { root, cm } = mountRegions();
    pulseFocusLanding(cm);
    expect(root.classList.contains("is-focus-landing")).toBe(true);
    expect(document.querySelector(".cm-editor")?.classList.contains("is-focus-landing")).toBe(false);
  });

  it("内側のフォーカス要素から領域 (aside) を辿ってクラスを付け、animationend で外す", () => {
    const { side, filter } = mountRegions();
    pulseFocusLanding(filter);
    expect(side.classList.contains("is-focus-landing")).toBe(true);
    side.dispatchEvent(new Event("animationend"));
    expect(side.classList.contains("is-focus-landing")).toBe(false);
  });

  it("領域が移ると前の領域のクラスは外れ、フォーカス要素自身が領域のこともある", () => {
    const { side, filter, grid } = mountRegions();
    pulseFocusLanding(filter);
    pulseFocusLanding(grid);
    expect(side.classList.contains("is-focus-landing")).toBe(false);
    expect(grid.classList.contains("is-focus-landing")).toBe(true);
  });

  it("子孫のアニメーション完了ではクラスを外さない", () => {
    const { side, filter } = mountRegions();
    pulseFocusLanding(filter);
    filter.dispatchEvent(new Event("animationend", { bubbles: true }));
    expect(side.classList.contains("is-focus-landing")).toBe(true);
  });

  it("reduced-motion (アプリ設定 / OS) と hc-* テーマでは付かない", () => {
    const { side, filter } = mountRegions();
    document.documentElement.setAttribute("data-motion", "reduced");
    pulseFocusLanding(filter);
    expect(side.classList.contains("is-focus-landing")).toBe(false);

    document.documentElement.removeAttribute("data-motion");
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    expect(focusLandingPulseEnabled()).toBe(false);
    // アプリ設定が "full" なら OS の reduce より優先して出す。
    document.documentElement.setAttribute("data-motion", "full");
    expect(focusLandingPulseEnabled()).toBe(true);

    document.documentElement.setAttribute("data-theme", "hc-dark");
    pulseFocusLanding(filter);
    expect(side.classList.contains("is-focus-landing")).toBe(false);
  });
});
