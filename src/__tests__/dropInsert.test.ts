import { describe, expect, it } from "vitest";
import { joinDroppedSql, physicalToCssPoint } from "../dropInsert";

describe("physicalToCssPoint (#1627)", () => {
  it("物理ピクセルを倍率で割って CSS ピクセルにする", () => {
    expect(physicalToCssPoint({ x: 300, y: 150 }, 1.5)).toEqual({ x: 200, y: 100 });
    expect(physicalToCssPoint({ x: 10, y: 20 }, 1)).toEqual({ x: 10, y: 20 });
  });
  it("倍率が不正なら 1 とみなす", () => {
    expect(physicalToCssPoint({ x: 10, y: 20 }, 0)).toEqual({ x: 10, y: 20 });
    expect(physicalToCssPoint({ x: 10, y: 20 }, Number.NaN)).toEqual({ x: 10, y: 20 });
    expect(physicalToCssPoint({ x: 10, y: 20 }, -2)).toEqual({ x: 10, y: 20 });
  });
});

describe("joinDroppedSql (#1627)", () => {
  it("末尾の改行を落とし、空行 1 つで区切る", () => {
    expect(joinDroppedSql(["SELECT 1;\n", "SELECT 2;\r\n\r\n"])).toBe("SELECT 1;\n\nSELECT 2;");
  });
  it("1 件はそのまま (末尾改行だけ除く)、空の本文は捨てる", () => {
    expect(joinDroppedSql(["SELECT 1;\n"])).toBe("SELECT 1;");
    expect(joinDroppedSql(["", "\n", "x"])).toBe("x");
    expect(joinDroppedSql([])).toBe("");
  });
});
