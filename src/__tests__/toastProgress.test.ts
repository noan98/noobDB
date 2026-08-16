import { describe, expect, it } from "vitest";
import { railDurationSeconds, railRatio } from "../components/toastProgress";

describe("railRatio", () => {
  it("満量なら 1", () => {
    expect(railRatio(8000, 8000)).toBe(1);
  });

  it("半分の残り時間なら 0.5", () => {
    expect(railRatio(4000, 8000)).toBe(0.5);
  });

  it("残り 0 なら 0", () => {
    expect(railRatio(0, 8000)).toBe(0);
  });

  it("負値は 0 にクランプする", () => {
    expect(railRatio(-100, 8000)).toBe(0);
  });

  it("全体を超える残り時間は 1 にクランプする", () => {
    expect(railRatio(9000, 8000)).toBe(1);
  });

  it("totalMs が 0 以下なら常に 0 (ゼロ除算を避ける)", () => {
    expect(railRatio(4000, 0)).toBe(0);
    expect(railRatio(4000, -1)).toBe(0);
  });

  it("NaN 入力は 0 を返す", () => {
    expect(railRatio(NaN, 8000)).toBe(0);
    expect(railRatio(4000, NaN)).toBe(0);
  });
});

describe("railDurationSeconds", () => {
  it("ms を秒へ変換する", () => {
    expect(railDurationSeconds(8000)).toBe(8);
    expect(railDurationSeconds(500)).toBe(0.5);
  });

  it("0 以下は 0 にクランプする", () => {
    expect(railDurationSeconds(0)).toBe(0);
    expect(railDurationSeconds(-50)).toBe(0);
  });

  it("NaN は 0 を返す", () => {
    expect(railDurationSeconds(NaN)).toBe(0);
  });
});
