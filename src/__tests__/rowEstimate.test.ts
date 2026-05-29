import { describe, it, expect } from "vitest";
import { formatRowEstimate } from "../components/rowEstimate";

describe("formatRowEstimate", () => {
  it("空テーブルは近似記号なしの 0", () => {
    expect(formatRowEstimate(0)).toBe("0");
  });

  it("小さい値はそのまま ~ 付きで表示", () => {
    expect(formatRowEstimate(1)).toBe("~1");
    expect(formatRowEstimate(42)).toBe("~42");
    expect(formatRowEstimate(999)).toBe("~999");
  });

  it("千・百万・十億単位をコンパクト表記にする", () => {
    expect(formatRowEstimate(1000)).toBe("~1K");
    expect(formatRowEstimate(1234)).toBe("~1.2K");
    expect(formatRowEstimate(1_000_000)).toBe("~1M");
    expect(formatRowEstimate(2_500_000)).toBe("~2.5M");
    expect(formatRowEstimate(1_000_000_000)).toBe("~1B");
  });

  it("負値・非有限値は空文字 (バッジを出さない)", () => {
    expect(formatRowEstimate(-1)).toBe("");
    expect(formatRowEstimate(Number.NaN)).toBe("");
    expect(formatRowEstimate(Number.POSITIVE_INFINITY)).toBe("");
  });
});
