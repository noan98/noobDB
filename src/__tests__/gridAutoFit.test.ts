import { describe, expect, it } from "vitest";
import { AUTOFIT_SAMPLE_ROWS, computeAutoFitWidth } from "../components/gridAutoFit";

const measure = (s: string) => s.length * 10;

describe("computeAutoFitWidth", () => {
  it("ヘッダとセルの最大幅に余白を足す", () => {
    const w = computeAutoFitWidth({
      headerTexts: ["id"],
      values: ["a", "abcdef", null],
      measure,
      padding: 5,
      min: 20,
      max: 500,
    });
    expect(w).toBe(65);
  });
  it("NULL は NULL バッジの幅で測る", () => {
    const w = computeAutoFitWidth({ headerTexts: [], values: [null], measure, padding: 0, min: 0, max: 500 });
    expect(w).toBe(40);
  });
  it("min / max にクランプする", () => {
    const base = { headerTexts: [], measure, padding: 0 };
    expect(computeAutoFitWidth({ ...base, values: ["a"], min: 60, max: 800 })).toBe(60);
    expect(computeAutoFitWidth({ ...base, values: ["x".repeat(100)], min: 60, max: 800 })).toBe(800);
  });
  it("先頭 AUTOFIT_SAMPLE_ROWS 行だけ測る", () => {
    const values = Array.from({ length: AUTOFIT_SAMPLE_ROWS + 1 }, (_, i) =>
      i === AUTOFIT_SAMPLE_ROWS ? "x".repeat(50) : "a",
    );
    const w = computeAutoFitWidth({ headerTexts: [], values, measure, padding: 0, min: 0, max: 5000 });
    expect(w).toBe(10);
  });
});
