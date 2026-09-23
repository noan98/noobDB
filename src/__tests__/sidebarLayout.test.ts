import { describe, expect, it } from "vitest";
import {
  clampSidebarWidth,
  parseSidebarWidth,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  sidebarWidthForKey,
} from "../components/sidebarLayout";

/**
 * サイドバーの幅変更 (#1112)。ポインタ専用だった区切りを `Splitter` と同じ操作体系
 * (矢印 / Home / End / Enter) に揃えた。クランプと永続値の破損耐性もここで固定する。
 */

describe("clampSidebarWidth", () => {
  it("範囲外は端へ寄せ、範囲内はそのまま", () => {
    expect(clampSidebarWidth(10)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampSidebarWidth(9999)).toBe(SIDEBAR_MAX_WIDTH);
    expect(clampSidebarWidth(320)).toBe(320);
  });
});

describe("parseSidebarWidth", () => {
  it("正の有限数はクランプして採用する", () => {
    expect(parseSidebarWidth("420")).toBe(420);
    expect(parseSidebarWidth(1000)).toBe(SIDEBAR_MAX_WIDTH);
    expect(parseSidebarWidth("50")).toBe(SIDEBAR_MIN_WIDTH);
  });

  it("欠損・破損値は既定幅", () => {
    for (const raw of [null, undefined, "", "abc", "0", "-3", NaN, Infinity]) {
      expect(parseSidebarWidth(raw)).toBe(SIDEBAR_DEFAULT_WIDTH);
    }
  });
});

describe("sidebarWidthForKey", () => {
  it("← / → で縮小 / 拡大し、Shift で大きく動く", () => {
    expect(sidebarWidthForKey(300, "ArrowLeft")).toBe(284);
    expect(sidebarWidthForKey(300, "ArrowRight")).toBe(316);
    expect(sidebarWidthForKey(300, "ArrowRight", true)).toBe(364);
  });

  it("端ではクランプされる", () => {
    expect(sidebarWidthForKey(SIDEBAR_MIN_WIDTH, "ArrowLeft")).toBe(SIDEBAR_MIN_WIDTH);
    expect(sidebarWidthForKey(SIDEBAR_MAX_WIDTH, "ArrowRight", true)).toBe(SIDEBAR_MAX_WIDTH);
  });

  it("Home / End で最小 / 最大、Enter で既定幅 (Splitter と同じ割り当て)", () => {
    expect(sidebarWidthForKey(400, "Home")).toBe(SIDEBAR_MIN_WIDTH);
    expect(sidebarWidthForKey(400, "End")).toBe(SIDEBAR_MAX_WIDTH);
    expect(sidebarWidthForKey(400, "Enter")).toBe(SIDEBAR_DEFAULT_WIDTH);
  });

  it("対象外のキーは null (既定動作を妨げない)", () => {
    for (const key of ["ArrowUp", "ArrowDown", "Tab", "a", " "]) {
      expect(sidebarWidthForKey(300, key)).toBeNull();
    }
  });
});
