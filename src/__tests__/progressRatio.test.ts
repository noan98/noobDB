import { describe, expect, it } from "vitest";
import { progressRatio } from "../components/progressRatio";

describe("progressRatio", () => {
  it("done / total を 0〜1 で返す", () => {
    expect(progressRatio(0, 10)).toBe(0);
    expect(progressRatio(5, 10)).toBe(0.5);
    expect(progressRatio(10, 10)).toBe(1);
  });
  it("超過は 1、負値・NaN は 0 にクランプする", () => {
    expect(progressRatio(12, 10)).toBe(1);
    expect(progressRatio(-1, 10)).toBe(0);
    expect(progressRatio(Number.NaN, 10)).toBe(0);
  });
  it("total が 0 以下・非有限なら 0 (ゼロ除算を避ける)", () => {
    expect(progressRatio(3, 0)).toBe(0);
    expect(progressRatio(3, -5)).toBe(0);
    expect(progressRatio(3, Number.POSITIVE_INFINITY)).toBe(0);
  });
});
