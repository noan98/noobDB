import { describe, it, expect } from "vitest";
import {
  toNumber,
  computeNumericStats,
  normalize,
  dataBarPercent,
  heatmapColor,
  HEAT_PALETTES,
  DEFAULT_HEAT_PALETTE,
} from "../components/cellConditionalFormat";

describe("toNumber (#499)", () => {
  it("parses finite numbers and numeric strings", () => {
    expect(toNumber(42)).toBe(42);
    expect(toNumber("3.5")).toBe(3.5);
    expect(toNumber(" -7 ")).toBe(-7);
  });
  it("rejects NULL, empty and non-numeric values", () => {
    expect(toNumber(null)).toBeNull();
    expect(toNumber(undefined)).toBeNull();
    expect(toNumber("")).toBeNull();
    expect(toNumber("abc")).toBeNull();
    expect(toNumber(NaN)).toBeNull();
    expect(toNumber(true)).toBeNull();
  });
});

describe("computeNumericStats (#499)", () => {
  it("ignores non-numeric / NULL cells", () => {
    expect(computeNumericStats([1, "x", null, 5, "3"])).toEqual({ min: 1, max: 5 });
  });
  it("returns null when no numeric values exist", () => {
    expect(computeNumericStats([null, "x", ""])).toBeNull();
  });
});

describe("normalize / dataBarPercent (#499)", () => {
  const stats = { min: 0, max: 10 };
  it("maps value to [0,1] and clamps out-of-range", () => {
    expect(normalize(0, stats)).toBe(0);
    expect(normalize(5, stats)).toBe(0.5);
    expect(normalize(10, stats)).toBe(1);
    expect(normalize(-3, stats)).toBe(0);
    expect(normalize(99, stats)).toBe(1);
  });
  it("returns 0 for a degenerate (all-equal) column so nothing is shaded", () => {
    expect(normalize(7, { min: 7, max: 7 })).toBe(0);
  });
  it("dataBarPercent is normalize scaled to 0–100", () => {
    expect(dataBarPercent(5, stats)).toBe(50);
    expect(dataBarPercent(10, stats)).toBe(100);
  });
});

describe("heatmapColor (#499)", () => {
  const pal = HEAT_PALETTES[DEFAULT_HEAT_PALETTE];
  it("returns the endpoint colors at t=0 and t=1", () => {
    expect(heatmapColor(0, pal)).toBe("rgb(239, 246, 255)"); // #eff6ff
    expect(heatmapColor(1, pal)).toBe("rgb(29, 78, 216)"); // #1d4ed8
  });
  it("interpolates between stops at the midpoint", () => {
    // 3 ストップの中点はちょうど中央ストップ (#93c5fd)。
    expect(heatmapColor(0.5, pal)).toBe("rgb(147, 197, 253)");
  });
  it("clamps t outside [0,1]", () => {
    expect(heatmapColor(-1, pal)).toBe(heatmapColor(0, pal));
    expect(heatmapColor(2, pal)).toBe(heatmapColor(1, pal));
  });
  it("ships at least one color-blind-safe palette", () => {
    expect(Object.values(HEAT_PALETTES).some((p) => p.colorBlindSafe)).toBe(true);
    expect(HEAT_PALETTES[DEFAULT_HEAT_PALETTE].colorBlindSafe).toBe(true);
  });
});
