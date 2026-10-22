import { describe, expect, it } from "vitest";
import { pageTurnDirection } from "../components/pageTurn";

describe("pageTurnDirection (#1752)", () => {
  it("同じページは再生しない", () => {
    expect(pageTurnDirection(3, 3)).toBeNull();
  });
  it("次ページは 1、前ページは -1", () => {
    expect(pageTurnDirection(3, 4)).toBe(1);
    expect(pageTurnDirection(3, 2)).toBe(-1);
    expect(pageTurnDirection(1, 2)).toBe(1);
  });
  it("先頭 / 末尾 / 任意ページへのジャンプは方向なし (0)", () => {
    expect(pageTurnDirection(5, 1)).toBe(0);
    expect(pageTurnDirection(1, 20)).toBe(0);
    expect(pageTurnDirection(3, 5)).toBe(0);
    expect(pageTurnDirection(2, 1)).toBe(-1);
  });
  it("非有限値は再生しない", () => {
    expect(pageTurnDirection(Number.NaN, 2)).toBeNull();
    expect(pageTurnDirection(1, Number.POSITIVE_INFINITY)).toBeNull();
  });
});
