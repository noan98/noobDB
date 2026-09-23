import { describe, it, expect } from "vitest";
import {
  columnIdFromCellKey,
  computeFlipOffsets,
  reorderColumnIds,
} from "../components/columnReorderFlip";

/**
 * 結果グリッドの列ドラッグ並べ替え (#1021) の純ロジック。新しい列順の決定と、
 * FLIP アニメーションの Invert 量 (before − after) の計算を固定する。
 */
describe("reorderColumnIds (#1021)", () => {
  const base = ["0", "1", "2", "3", "4"];

  it("右へ動かすとドロップ先の手前に入る", () => {
    expect(reorderColumnIds(base, "0", "3")).toEqual(["1", "2", "0", "3", "4"]);
  });

  it("左へ動かすとドロップ先の手前に入る", () => {
    expect(reorderColumnIds(base, "4", "1")).toEqual(["0", "4", "1", "2", "3"]);
  });

  it("同じ列・存在しない列は null (何もしない)", () => {
    expect(reorderColumnIds(base, "2", "2")).toBeNull();
    expect(reorderColumnIds(base, "9", "2")).toBeNull();
    expect(reorderColumnIds(base, "2", "9")).toBeNull();
  });

  it("入力配列を破壊しない", () => {
    const copy = base.slice();
    reorderColumnIds(base, "0", "4");
    expect(base).toEqual(copy);
  });
});

describe("computeFlipOffsets (#1021)", () => {
  it("動いた列だけ before − after を返す", () => {
    // 幅 100 の列 A,B,C で A を C の手前へ: B,A,C
    const before = new Map([
      ["A", 0],
      ["B", 100],
      ["C", 200],
    ]);
    const after = new Map([
      ["B", 0],
      ["A", 100],
      ["C", 200],
    ]);
    const out = computeFlipOffsets(before, after);
    expect(Object.fromEntries(out)).toEqual({ A: -100, B: 100 });
  });

  it("前後どちらかにしか無い列 (列仮想化で出入り) は対象外", () => {
    const out = computeFlipOffsets(new Map([["A", 0], ["X", 50]]), new Map([["A", 80], ["Y", 10]]));
    expect(Object.fromEntries(out)).toEqual({ A: -80 });
  });

  it("サブピクセルの差と非有限値は無視する", () => {
    const out = computeFlipOffsets(
      new Map([
        ["A", 10],
        ["B", Number.NaN],
        ["C", 0],
      ]),
      new Map([
        ["A", 10.3],
        ["B", 5],
        ["C", 0.5],
      ]),
    );
    expect(Object.fromEntries(out)).toEqual({ C: -0.5 });
    expect(computeFlipOffsets(new Map([["C", 0]]), new Map([["C", 0.5]]), 1).size).toBe(0);
  });
});

describe("columnIdFromCellKey (#1021)", () => {
  it("行:列 のキーから列 id を取り出す", () => {
    expect(columnIdFromCellKey("12:3")).toBe("3");
    expect(columnIdFromCellKey("0:0")).toBe("0");
  });

  it("不正なキーは null", () => {
    expect(columnIdFromCellKey("12")).toBeNull();
    expect(columnIdFromCellKey("12:")).toBeNull();
  });
});
