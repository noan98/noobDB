import { describe, expect, it } from "vitest";
import { sidebarSlideAnimate, sidebarSlideDirection, sidebarSlideHidden } from "../components/sidebarTabNav";

const ORDER = ["connections", "snippets", "history", "local"] as const;

describe("sidebarSlideDirection", () => {
  it("右のタブへ移ると +1、左へ移ると -1", () => {
    expect(sidebarSlideDirection(ORDER, "connections", "snippets")).toBe(1);
    expect(sidebarSlideDirection(ORDER, "connections", "local")).toBe(1);
    expect(sidebarSlideDirection(ORDER, "local", "history")).toBe(-1);
    expect(sidebarSlideDirection(ORDER, "local", "connections")).toBe(-1);
  });
  it("同じタブ・並びに無いタブは 0", () => {
    expect(sidebarSlideDirection(ORDER, "history", "history")).toBe(0);
    expect(sidebarSlideDirection(ORDER, "history", "nope" as never)).toBe(0);
  });
});

describe("sidebarSlide アニメーション値", () => {
  it("向きの符号が x の開始値に反映される", () => {
    expect(sidebarSlideHidden(1).x).toBeGreaterThan(0);
    expect(sidebarSlideHidden(-1).x).toBeLessThan(0);
    expect(sidebarSlideHidden(0).x).toBe(0);
    expect(sidebarSlideHidden(1).opacity).toBe(0);
    const a = sidebarSlideAnimate(-1);
    expect(a.x[0]).toBeLessThan(0);
    expect(a.x[1]).toBe(0);
    expect(a.opacity).toEqual([0, 1]);
  });
});
