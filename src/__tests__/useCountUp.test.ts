import { describe, expect, it } from "vitest";
import { COUNT_UP_TOKEN, shouldAnimateCountUp, splitAroundCountUpToken } from "../useCountUp";

describe("shouldAnimateCountUp (#977)", () => {
  it("never animates on the initial display (no previous value)", () => {
    expect(shouldAnimateCountUp(null, 0)).toBe(false);
    expect(shouldAnimateCountUp(null, 5000)).toBe(false);
  });

  it("does not animate when the value is unchanged", () => {
    expect(shouldAnimateCountUp(42, 42)).toBe(false);
    expect(shouldAnimateCountUp(0, 0)).toBe(false);
  });

  it("skips small absolute deltas even with no prior value scale (avoids flicker for +1)", () => {
    expect(shouldAnimateCountUp(10, 11)).toBe(false); // delta 1 < MIN_ABS_DELTA (2)
    expect(shouldAnimateCountUp(10, 12)).toBe(true); // delta 2 meets the absolute floor
  });

  it("requires a meaningful relative delta for large numbers", () => {
    // 10,000 -> 10,005 is a 0.05% change: below the 1% relative threshold.
    expect(shouldAnimateCountUp(10_000, 10_005)).toBe(false);
    // 10,000 -> 10,200 is a 2% change: above the relative threshold.
    expect(shouldAnimateCountUp(10_000, 10_200)).toBe(true);
  });

  it("animates a real drop as well as a rise (both directions)", () => {
    expect(shouldAnimateCountUp(100, 40)).toBe(true);
    expect(shouldAnimateCountUp(40, 100)).toBe(true);
  });

  it("treats non-finite inputs as not animatable (fail closed)", () => {
    expect(shouldAnimateCountUp(NaN, 5)).toBe(false);
    expect(shouldAnimateCountUp(5, Infinity)).toBe(false);
    expect(shouldAnimateCountUp(5, NaN)).toBe(false);
  });
});

describe("splitAroundCountUpToken (#977)", () => {
  it("splits an English template around the row-count placeholder", () => {
    const rendered = `${COUNT_UP_TOKEN} rows · 42 ms`;
    const [prefix, suffix] = splitAroundCountUpToken(rendered);
    expect(prefix).toBe("");
    expect(suffix).toBe(" rows · 42 ms");
  });

  it("splits a Japanese template around the row-count placeholder", () => {
    const rendered = `${COUNT_UP_TOKEN} 件 · 42 ms`;
    const [prefix, suffix] = splitAroundCountUpToken(rendered);
    expect(prefix).toBe("");
    expect(suffix).toBe(" 件 · 42 ms");
  });

  it("preserves text before the placeholder when it isn't at the start", () => {
    const rendered = `elapsed 42 ms, returned${COUNT_UP_TOKEN} rows`;
    const [prefix, suffix] = splitAroundCountUpToken(rendered);
    expect(prefix).toBe("elapsed 42 ms, returned");
    expect(suffix).toBe(" rows");
  });

  it("falls back to the whole string with an empty suffix when the token is missing", () => {
    const rendered = "42 rows · 10 ms";
    const [prefix, suffix] = splitAroundCountUpToken(rendered);
    expect(prefix).toBe(rendered);
    expect(suffix).toBe("");
  });
});
