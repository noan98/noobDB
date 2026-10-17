import { describe, it, expect } from "vitest";
import {
  anchorsForStep,
  clipRect,
  computeCoachmarkLayout,
  isAnchorUsable,
  rectsOverlap,
  sameRect,
  spotlightRect,
  TOUR_ANCHORS,
} from "../onboardingAnchors";
import { TOUR_STEP_COUNT } from "../onboarding";
import type { TooltipRect } from "../components/tooltipPosition";

const rect = (left: number, top: number, width: number, height: number): TooltipRect => ({
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height,
});
const VP = { width: 1280, height: 800 };

describe("onboardingAnchors (#1504)", () => {
  it("全ステップにアンカー候補がある", () => {
    expect(TOUR_ANCHORS).toHaveLength(TOUR_STEP_COUNT);
    for (const c of TOUR_ANCHORS) expect(c.length).toBeGreaterThan(0);
  });

  it("範囲外のステップ番号は端へ丸める", () => {
    expect(anchorsForStep(-3)).toBe(TOUR_ANCHORS[0]);
    expect(anchorsForStep(99)).toBe(TOUR_ANCHORS[TOUR_STEP_COUNT - 1]);
  });

  it("clipRect: ビューポートでクリップし、交差が無ければ null", () => {
    expect(clipRect(rect(-10, -10, 100, 100), VP)).toMatchObject({ left: 0, top: 0, width: 90, height: 90 });
    expect(clipRect(rect(2000, 10, 50, 50), VP)).toBeNull();
  });

  it("isAnchorUsable: 大きさ無し・画面外は不可、半分以上見えていれば可", () => {
    expect(isAnchorUsable(rect(10, 10, 0, 0), VP)).toBe(false);
    expect(isAnchorUsable(rect(10, 900, 100, 50), VP)).toBe(false);
    expect(isAnchorUsable(rect(1250, 10, 100, 50), VP)).toBe(false); // 30% しか見えない
    expect(isAnchorUsable(rect(1230, 10, 100, 50), VP)).toBe(true); // 50%
    expect(isAnchorUsable(rect(10, 10, 100, 50), VP)).toBe(true);
  });

  it("spotlightRect: 余白ぶん広がり、クリップ後の矩形を基準にする", () => {
    expect(spotlightRect(rect(100, 100, 50, 20), VP, 4)).toEqual(rect(96, 96, 58, 28));
    expect(spotlightRect(rect(-20, 10, 60, 20), VP, 4)).toEqual(rect(-4, 6, 48, 28));
    expect(spotlightRect(rect(0, 2000, 10, 10), VP)).toBeNull();
  });

  it("rectsOverlap: 接するだけは重ならない", () => {
    expect(rectsOverlap(rect(0, 0, 10, 10), rect(10, 0, 10, 10))).toBe(false);
    expect(rectsOverlap(rect(0, 0, 10, 10), rect(9, 9, 10, 10))).toBe(true);
  });

  it("computeCoachmarkLayout: 下に置け、優先側がはみ出すとフリップする", () => {
    const size = { width: 320, height: 160 };
    const below = computeCoachmarkLayout(rect(100, 100, 100, 30), size, "bottom", VP);
    expect(below.top).toBe(138);
    expect(below.covers).toBe(false);
    const flipped = computeCoachmarkLayout(rect(100, 700, 100, 30), size, "bottom", VP);
    expect(flipped.top).toBeLessThan(700);
    expect(flipped.covers).toBe(false);
  });

  it("computeCoachmarkLayout: 巨大なアンカーでは covers=true", () => {
    const size = { width: 320, height: 160 };
    const out = computeCoachmarkLayout(rect(0, 0, 1280, 800), size, "top", VP);
    expect(out.covers).toBe(true);
  });

  it("sameRect: 丸めて同じなら true", () => {
    expect(sameRect(rect(1, 2, 3.2, 4), rect(1, 2, 3.4, 4))).toBe(true);
    expect(sameRect(rect(1, 2, 3, 4), rect(1, 2, 5, 4))).toBe(false);
    expect(sameRect(null, null)).toBe(true);
    expect(sameRect(rect(1, 2, 3, 4), null)).toBe(false);
  });
});
