import { describe, it, expect } from "vitest";
import {
  DENSITY_TRANSITION_ATTR,
  DENSITY_TRANSITION_MS,
  densityTransitionDirection,
} from "../densityTransition";

/**
 * 密度変更の遷移演出 (#1023) の純ロジック。App.tsx はこの結果だけを見て
 * `data-density-transition` 属性を立てる/外すタイミングを決めるので、ここでは
 * 「いつ発火すべきか」と「向き (grow/shrink)」の判定だけを検証する。実際の
 * DOM 操作・タイマーは App.tsx 側の責務。
 */
describe("densityTransitionDirection", () => {
  it("does not flash on initial mount (prev is null)", () => {
    expect(densityTransitionDirection(null, "compact")).toBeNull();
    expect(densityTransitionDirection(null, "normal")).toBeNull();
    expect(densityTransitionDirection(null, "spacious")).toBeNull();
  });

  it("does not flash when the density did not actually change", () => {
    expect(densityTransitionDirection("compact", "compact")).toBeNull();
    expect(densityTransitionDirection("normal", "normal")).toBeNull();
    expect(densityTransitionDirection("spacious", "spacious")).toBeNull();
  });

  it("returns 'grow' when moving to a more spacious preset", () => {
    expect(densityTransitionDirection("compact", "normal")).toBe("grow");
    expect(densityTransitionDirection("compact", "spacious")).toBe("grow");
    expect(densityTransitionDirection("normal", "spacious")).toBe("grow");
  });

  it("returns 'shrink' when moving to a more compact preset", () => {
    expect(densityTransitionDirection("spacious", "normal")).toBe("shrink");
    expect(densityTransitionDirection("spacious", "compact")).toBe("shrink");
    expect(densityTransitionDirection("normal", "compact")).toBe("shrink");
  });
});

describe("density transition constants", () => {
  it("exposes a stable attribute name (also referenced from App.css)", () => {
    expect(DENSITY_TRANSITION_ATTR).toBe("data-density-transition");
  });

  it("uses a short, positive timeout so the transient scope is short-lived", () => {
    expect(DENSITY_TRANSITION_MS).toBeGreaterThan(0);
    // 数百 ms 程度に収まっていること (常時有効化しない、という設計意図の回帰防止)。
    expect(DENSITY_TRANSITION_MS).toBeLessThan(1000);
  });
});
