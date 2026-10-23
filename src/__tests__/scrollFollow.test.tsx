import { afterEach, describe, expect, it, vi } from "vitest";
import { followScrollBehavior, scrollFollowIntoView } from "../components/scrollFollow";

function mockReducedMedia(matches: boolean) {
  window.matchMedia = vi.fn().mockReturnValue({ matches }) as unknown as typeof window.matchMedia;
}

afterEach(() => {
  document.documentElement.removeAttribute("data-motion");
});

describe("followScrollBehavior", () => {
  it("既定は smooth", () => {
    mockReducedMedia(false);
    expect(followScrollBehavior()).toBe("smooth");
  });
  it("OS の prefers-reduced-motion では即時 (auto)", () => {
    mockReducedMedia(true);
    expect(followScrollBehavior()).toBe("auto");
  });
  it('data-motion="reduced" は OS 設定に関わらず即時', () => {
    mockReducedMedia(false);
    document.documentElement.setAttribute("data-motion", "reduced");
    expect(followScrollBehavior()).toBe("auto");
  });
  it('data-motion="full" は OS が reduce でも smooth', () => {
    mockReducedMedia(true);
    document.documentElement.setAttribute("data-motion", "full");
    expect(followScrollBehavior()).toBe("smooth");
  });
});

describe("scrollFollowIntoView", () => {
  it("nearest + smooth で呼ぶ", () => {
    mockReducedMedia(false);
    const el = document.createElement("div");
    const fn = vi.fn();
    el.scrollIntoView = fn;
    scrollFollowIntoView(el);
    expect(fn).toHaveBeenCalledWith({ block: "nearest", behavior: "smooth" });
  });
  it("inline 指定を通す", () => {
    mockReducedMedia(false);
    const el = document.createElement("div");
    const fn = vi.fn();
    el.scrollIntoView = fn;
    scrollFollowIntoView(el, { inline: "nearest", block: "nearest" });
    expect(fn).toHaveBeenCalledWith({ inline: "nearest", block: "nearest", behavior: "smooth" });
  });
  it("null / scrollIntoView 未実装 (jsdom) でも落ちない", () => {
    expect(() => scrollFollowIntoView(null)).not.toThrow();
    const el = document.createElement("div");
    (el as { scrollIntoView?: unknown }).scrollIntoView = undefined;
    expect(() => scrollFollowIntoView(el)).not.toThrow();
  });
});
