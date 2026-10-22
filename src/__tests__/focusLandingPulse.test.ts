// @vitest-environment jsdom (DOM のクラス付与と animationend を確かめるため)
import { afterEach, describe, expect, it, vi } from "vitest";
import { focusLandingPulseEnabled, pulseFocusLanding } from "../components/focusLandingPulse";

function mountRegions() {
  document.body.innerHTML = `<aside id="side" data-focus-landing-region><input id="filter"></aside><div id="host" data-focus-landing-region><div class="cm-editor"><div id="cm" tabindex="0"></div></div></div><div id="grid" data-focus-landing-region tabindex="0"><div id="inner" tabindex="0"></div></div><input id="outside">`;
  return {
    side: document.getElementById("side") as HTMLElement,
    filter: document.getElementById("filter") as HTMLElement,
    grid: document.getElementById("grid") as HTMLElement,
    inner: document.getElementById("inner") as HTMLElement,
    root: document.getElementById("host") as HTMLElement,
    cm: document.getElementById("cm") as HTMLElement,
    outside: document.getElementById("outside") as HTMLElement,
  };
}

afterEach(() => {
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("data-motion");
  document.documentElement.removeAttribute("data-theme");
  vi.unstubAllGlobals();
});

describe("pulseFocusLanding (#1764)", () => {
  it("エディタは .cm-editor ではなく data-focus-landing-region のルートにクラスを付ける", () => {
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

  it("animationcancel でもクラスを外し、リスナーも外れる", () => {
    const { side, filter } = mountRegions();
    pulseFocusLanding(filter);
    side.dispatchEvent(new Event("animationcancel"));
    expect(side.classList.contains("is-focus-landing")).toBe(false);
    side.classList.add("is-focus-landing");
    side.dispatchEvent(new Event("animationend"));
    expect(side.classList.contains("is-focus-landing")).toBe(true);
  });

  it("領域の外 (body / 領域に属さない要素) では何も付けない", () => {
    const { outside } = mountRegions();
    pulseFocusLanding(document.body);
    pulseFocusLanding(document.documentElement);
    pulseFocusLanding(outside);
    expect(document.querySelectorAll(".is-focus-landing")).toHaveLength(0);
  });

  it("子孫のアニメーション完了ではクラスを外さない", () => {
    const { side, filter } = mountRegions();
    pulseFocusLanding(filter);
    filter.dispatchEvent(new Event("animationend", { bubbles: true }));
    expect(side.classList.contains("is-focus-landing")).toBe(true);
  });

  it("reduced-motion (アプリ設定 / OS)・hc-* テーマ・forced-colors では付かない", () => {
    const { side, filter } = mountRegions();
    document.documentElement.setAttribute("data-motion", "reduced");
    pulseFocusLanding(filter);
    expect(side.classList.contains("is-focus-landing")).toBe(false);

    document.documentElement.removeAttribute("data-motion");
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce") }));
    expect(focusLandingPulseEnabled()).toBe(false);
    // アプリ設定が "full" なら OS の reduce より優先して出す。
    document.documentElement.setAttribute("data-motion", "full");
    expect(focusLandingPulseEnabled()).toBe(true);

    document.documentElement.setAttribute("data-theme", "hc-dark");
    pulseFocusLanding(filter);
    expect(side.classList.contains("is-focus-landing")).toBe(false);

    document.documentElement.removeAttribute("data-theme");
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("forced-colors") }));
    pulseFocusLanding(filter);
    expect(side.classList.contains("is-focus-landing")).toBe(false);
  });
});
