import { describe, expect, it } from "vitest";
import {
  buildCopyFlashRange,
  collectCopyFlashKeys,
  isCellInCopyFlashRange,
} from "../components/gridCopyFlash";

describe("gridCopyFlash", () => {
  it("単一セルの範囲は該当セルだけに一致する", () => {
    const range = buildCopyFlashRange([3], [1]);
    expect(isCellInCopyFlashRange(range, 3, 1)).toBe(true);
    expect(isCellInCopyFlashRange(range, 3, 2)).toBe(false);
    expect(isCellInCopyFlashRange(range, 4, 1)).toBe(false);
  });

  it("行コピーの範囲はその行の全対象列に一致する", () => {
    const range = buildCopyFlashRange([2], [0, 1, 2]);
    expect(isCellInCopyFlashRange(range, 2, 0)).toBe(true);
    expect(isCellInCopyFlashRange(range, 2, 2)).toBe(true);
    expect(isCellInCopyFlashRange(range, 1, 0)).toBe(false);
  });

  it("矩形選択の範囲は行×列の直積で一致する", () => {
    const range = buildCopyFlashRange([0, 1], [1, 2]);
    expect(isCellInCopyFlashRange(range, 0, 1)).toBe(true);
    expect(isCellInCopyFlashRange(range, 1, 2)).toBe(true);
    // 直積の外側 (行だけ一致・列だけ一致) は含まれない。
    expect(isCellInCopyFlashRange(range, 0, 0)).toBe(false);
    expect(isCellInCopyFlashRange(range, 2, 1)).toBe(false);
  });

  it("range が null/undefined なら常に false", () => {
    expect(isCellInCopyFlashRange(null, 0, 0)).toBe(false);
    expect(isCellInCopyFlashRange(undefined, 0, 0)).toBe(false);
  });

  it("collectCopyFlashKeys は可視セルのキーのうち範囲内のものだけを返す", () => {
    const range = buildCopyFlashRange([1, 2], [0, 1]);
    const keys = ["0:0", "1:0", "1:1", "2:1", "2:2", "3:0"];
    expect(collectCopyFlashKeys(keys, range)).toEqual(["1:0", "1:1", "2:1"]);
  });

  it("collectCopyFlashKeys は選択範囲の大きさでなく可視セル数に比例する", () => {
    // 100万行を選択していても、実際に DOM にあるキーは数件だけなら数件しか返らない。
    const hugeRowIndices = Array.from({ length: 1_000_000 }, (_, i) => i);
    const range = buildCopyFlashRange(hugeRowIndices, [0, 1, 2]);
    const visibleKeys = ["10:1", "11:1", "999999:0"];
    expect(collectCopyFlashKeys(visibleKeys, range)).toEqual(visibleKeys);
  });

  it("不正な形式のキーは無視する", () => {
    const range = buildCopyFlashRange([0], [0]);
    expect(collectCopyFlashKeys(["not-a-key", "0:0"], range)).toEqual(["0:0"]);
  });
});
