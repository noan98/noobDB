import { describe, expect, it } from "vitest";
import {
  AUTOSCROLL_EDGE,
  AUTOSCROLL_MAX_SPEED,
  GLIDE_MAX_VIEWPORTS,
  MARQUEE_DRAG_THRESHOLD,
  activeFrameKey,
  autoScrollDelta,
  boxesEqual,
  canStartMarquee,
  exceedsDragThreshold,
  marqueeSelection,
  parseCellKey,
  selectionFrameKey,
  selectionMountedRows,
  shouldGlide,
  toContentBox,
  unionBoxes,
} from "../components/selectionGlide";

// 滑って追従する選択枠とマーキー選択の純ロジック (#1578)。

const box = (left: number, top: number, width: number, height: number) => ({ left, top, width, height });

describe("toContentBox", () => {
  it("ビューポート座標をスクロール量・ボーダーを考慮したコンテンツ座標へ直す", () => {
    const m = { left: 100, top: 50, clientLeft: 1, clientTop: 2, scrollLeft: 30, scrollTop: 400 };
    expect(toContentBox({ left: 160, top: 90, right: 260, bottom: 120 }, m)).toEqual(box(89, 438, 100, 30));
  });
});

describe("unionBoxes / boxesEqual", () => {
  it("外接矩形を返し、空なら null", () => {
    expect(unionBoxes([])).toBeNull();
    expect(unionBoxes([box(10, 10, 20, 10), box(40, 30, 10, 10)])).toEqual(box(10, 10, 40, 30));
    expect(unionBoxes([box(5, 6, 7, 8)])).toEqual(box(5, 6, 7, 8));
  });
  it("サブピクセル誤差は同じとみなす", () => {
    expect(boxesEqual(box(0, 0, 10, 10), box(0.3, 0, 10, 10.2))).toBe(true);
    expect(boxesEqual(box(0, 0, 10, 10), box(1, 0, 10, 10))).toBe(false);
    expect(boxesEqual(null, null)).toBe(true);
    expect(boxesEqual(null, box(0, 0, 1, 1))).toBe(false);
  });
});

describe("shouldGlide", () => {
  const from = box(0, 0, 100, 20);
  it("直前が無い / 動いていないなら滑らせない", () => {
    expect(shouldGlide(null, box(0, 20, 100, 20), 400)).toBe(false);
    expect(shouldGlide(from, from, 400)).toBe(false);
  });
  it("近い移動は滑らせ、ビューポートの倍数を超える移動は即座に置く", () => {
    expect(shouldGlide(from, box(0, 20, 100, 20), 400)).toBe(true);
    expect(shouldGlide(from, box(0, 400 * GLIDE_MAX_VIEWPORTS, 100, 20), 400)).toBe(true);
    expect(shouldGlide(from, box(0, 400 * GLIDE_MAX_VIEWPORTS + 1, 100, 20), 400)).toBe(false);
  });
  it("ビューポート高さが 0 でも例外にならず遠い移動は滑らせない", () => {
    expect(shouldGlide(from, box(0, 5000, 100, 20), 0)).toBe(false);
  });
});

describe("枠のキー", () => {
  it("対象が無ければ null、あれば対象ごとに一意", () => {
    expect(activeFrameKey(null)).toBeNull();
    expect(activeFrameKey({ rowIdx: 1, colIdx: 2 })).not.toBe(activeFrameKey({ rowIdx: 2, colIdx: 1 }));
    expect(selectionFrameKey(null)).toBeNull();
    const a = { rowIdx: 0, colIdx: 0 };
    expect(selectionFrameKey({ anchor: a, focus: { rowIdx: 1, colIdx: 1 } })).not.toBe(
      selectionFrameKey({ anchor: a, focus: { rowIdx: 1, colIdx: 2 } }),
    );
  });
  it("セル参照キーを分解する", () => {
    expect(parseCellKey("12:3")).toEqual({ rowIdx: 12, colIdx: 3 });
    expect(parseCellKey("x:3")).toBeNull();
    expect(parseCellKey("12")).toBeNull();
    expect(parseCellKey(":3")).toBeNull();
  });
});

describe("マーキー開始条件", () => {
  const base = {
    button: 0,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    editing: false,
    onInteractive: false,
  };
  it("素の左ボタンだけが対象", () => {
    expect(canStartMarquee(base)).toBe(true);
    expect(canStartMarquee({ ...base, button: 2 })).toBe(false);
    expect(canStartMarquee({ ...base, button: 1 })).toBe(false);
  });
  it("Shift+クリック (範囲拡張) / 修飾キー / 編集中 / 入力欄上は既存の挙動に任せる", () => {
    for (const k of ["shiftKey", "ctrlKey", "metaKey", "altKey", "editing", "onInteractive"] as const) {
      expect(canStartMarquee({ ...base, [k]: true })).toBe(false);
    }
  });
  it("手ぶれ程度の移動では始まらない", () => {
    expect(exceedsDragThreshold(1, 1)).toBe(false);
    expect(exceedsDragThreshold(MARQUEE_DRAG_THRESHOLD, 0)).toBe(true);
    expect(exceedsDragThreshold(-3, -3)).toBe(true);
  });
});

describe("autoScrollDelta", () => {
  const min = 100;
  const max = 700;
  it("領域の内側では 0", () => {
    expect(autoScrollDelta(400, min, max)).toBe(0);
    expect(autoScrollDelta(min + AUTOSCROLL_EDGE, min, max)).toBe(0);
    expect(autoScrollDelta(max - AUTOSCROLL_EDGE, min, max)).toBe(0);
  });
  it("端に近づくほど加速し、負は上/左、正は下/右", () => {
    const near = autoScrollDelta(min + AUTOSCROLL_EDGE - 4, min, max);
    const far = autoScrollDelta(min + 4, min, max);
    expect(near).toBeLessThan(0);
    expect(far).toBeLessThan(near);
    expect(autoScrollDelta(max - 4, min, max)).toBeGreaterThan(
      autoScrollDelta(max - AUTOSCROLL_EDGE + 4, min, max),
    );
    expect(autoScrollDelta(max - 4, min, max)).toBeGreaterThan(0);
  });
  it("領域の外でも最大速度で頭打ち", () => {
    expect(autoScrollDelta(min - 500, min, max)).toBe(-AUTOSCROLL_MAX_SPEED);
    expect(autoScrollDelta(max + 500, min, max)).toBe(AUTOSCROLL_MAX_SPEED);
  });
  it("端に入った瞬間でも最低 1px は動く / 領域が狭い・非有限は 0", () => {
    expect(Math.abs(autoScrollDelta(min + AUTOSCROLL_EDGE - 1, min, max))).toBeGreaterThanOrEqual(1);
    expect(autoScrollDelta(50, 0, 2 * AUTOSCROLL_EDGE)).toBe(0);
    expect(autoScrollDelta(Number.NaN, min, max)).toBe(0);
  });
});

describe("marqueeSelection", () => {
  const a = { rowIdx: 1, colIdx: 1 };
  it("別セルなら基点からの範囲、同じセルや位置不明なら選択なし", () => {
    expect(marqueeSelection(a, { rowIdx: 3, colIdx: 2 })).toEqual({
      anchor: a,
      focus: { rowIdx: 3, colIdx: 2 },
    });
    expect(marqueeSelection(a, a)).toBeNull();
    expect(marqueeSelection(a, null)).toBeNull();
  });
});

describe("selectionMountedRows", () => {
  it("選択とマウント済みの行範囲の交わりを返す", () => {
    expect(selectionMountedRows(0, 99999, { first: 500, last: 540 })).toEqual({ top: 500, bottom: 540 });
    expect(selectionMountedRows(510, 520, { first: 500, last: 540 })).toEqual({ top: 510, bottom: 520 });
    expect(selectionMountedRows(0, 505, { first: 500, last: 540 })).toEqual({ top: 500, bottom: 505 });
  });
  it("重なりが無ければ null、仮想化しない (null) なら選択範囲そのまま", () => {
    expect(selectionMountedRows(0, 10, { first: 500, last: 540 })).toBeNull();
    expect(selectionMountedRows(0, 10, { first: 1, last: 0 })).toBeNull();
    expect(selectionMountedRows(3, 9, null)).toEqual({ top: 3, bottom: 9 });
  });
});
