import { describe, expect, it } from "vitest";
import { rowSelectRange, selectAllRange } from "../components/gridSelection";

/** 結果グリッドの一括範囲選択 (Ctrl/Cmd+A・行番号クリック, #1529) の純ロジック。 */
describe("selectAllRange", () => {
  it("表示順の先頭行・先頭列から末尾行・末尾列までの矩形を返す", () => {
    // ソート済みで元の行 index が入れ替わっている / 列が並べ替え・非表示になっている想定。
    expect(selectAllRange([4, 2, 9], [3, 0, 1])).toEqual({
      anchor: { rowIdx: 4, colIdx: 3 },
      focus: { rowIdx: 9, colIdx: 1 },
    });
  });

  it("行か列が無ければ null", () => {
    expect(selectAllRange([], [0])).toBeNull();
    expect(selectAllRange([0], [])).toBeNull();
  });
});

describe("rowSelectRange", () => {
  it("クリックした行の先頭列から末尾列を選ぶ", () => {
    expect(rowSelectRange(5, [2, 0, 1], false, 1)).toEqual({
      anchor: { rowIdx: 5, colIdx: 2 },
      focus: { rowIdx: 5, colIdx: 1 },
    });
  });

  it("Shift+クリックはアンカー行からクリック行まで (全列) に伸ばす", () => {
    expect(rowSelectRange(7, [0, 1], true, 3)).toEqual({
      anchor: { rowIdx: 3, colIdx: 0 },
      focus: { rowIdx: 7, colIdx: 1 },
    });
  });

  it("Shift でもアンカーが無ければクリック行だけ", () => {
    expect(rowSelectRange(7, [0, 1], true, null)).toEqual({
      anchor: { rowIdx: 7, colIdx: 0 },
      focus: { rowIdx: 7, colIdx: 1 },
    });
  });

  it("列が無ければ null", () => {
    expect(rowSelectRange(0, [], false, null)).toBeNull();
  });
});
