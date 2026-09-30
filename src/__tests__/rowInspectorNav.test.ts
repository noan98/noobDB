import { describe, expect, it } from "vitest";
import { inspectorWidth, rowSlideDirection } from "../components/rowInspectorNav";
import { directionalSlide, slideOffsets } from "../motion";

describe("rowSlideDirection", () => {
  it("next は負、prev は正、同じ行は 0", () => {
    expect(rowSlideDirection(3, 4)).toBe(-1);
    expect(rowSlideDirection(4, 3)).toBe(1);
    expect(rowSlideDirection(5, 5)).toBe(0);
  });
  it("行番号が飛んでも符号だけで判定する", () => {
    expect(rowSlideDirection(1, 100)).toBe(-1);
    expect(rowSlideDirection(100, 1)).toBe(1);
  });
});

describe("directionalSlide", () => {
  it("prev(+1) は右から入って左へ、next(-1) は左から入って右へ抜ける", () => {
    expect(directionalSlide.initial(1)).toEqual({ opacity: 0, x: slideOffsets.row });
    expect(directionalSlide.exit(1)).toEqual({ opacity: 0, x: -slideOffsets.row });
    expect(directionalSlide.initial(-1).x).toBe(-slideOffsets.row);
    expect(directionalSlide.exit(-1).x).toBe(slideOffsets.row);
  });
  it("方向 0 は x 移動なしのフェード", () => {
    expect(directionalSlide.initial(0).x).toBeCloseTo(0);
    expect(directionalSlide.exit(0).x).toBeCloseTo(0);
    expect(directionalSlide.animate).toEqual({ opacity: 1, x: 0 });
  });
});

describe("inspectorWidth", () => {
  it("関連タブは広い", () => {
    expect(inspectorWidth("related")).toContain("560px");
    expect(inspectorWidth("fields")).toContain("380px");
  });
});
