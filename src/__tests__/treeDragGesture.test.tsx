import { describe, expect, it } from "vitest";
import {
  IDLE_PHASE,
  TREE_DRAG_THRESHOLD,
  cancelPhase,
  movePhase,
  pickDropTarget,
  pressPhase,
  releasePhase,
} from "../components/treeDragGesture";
import type { TreeDragItem } from "../components/treeDragInsert";

const item: TreeDragItem = { kind: "table", database: "d", table: "t" };

describe("treeDragGesture", () => {
  it("しきい値未満の移動は pending のまま (クリック扱い)", () => {
    const p = pressPhase(item, 10, 10);
    expect(movePhase(p, 10 + TREE_DRAG_THRESHOLD - 1, 10)).toBe(p);
    expect(movePhase(p, 11, 11)).toBe(p);
  });

  it("しきい値以上でドラッグ開始、以降は座標が追従する (斜めの距離で判定)", () => {
    const p = pressPhase(item, 0, 0);
    const d = movePhase(p, TREE_DRAG_THRESHOLD, 0);
    expect(d).toEqual({ kind: "dragging", item, x: TREE_DRAG_THRESHOLD, y: 0 });
    expect(movePhase(d, 50, 60)).toEqual({ kind: "dragging", item, x: 50, y: 60 });
    expect(movePhase(pressPhase(item, 0, 0), 4, 4).kind).toBe("dragging"); // hypot(4,4) ≈ 5.66
  });

  it("一度ドラッグになったら元の位置へ戻ってもドラッグのまま", () => {
    const d = movePhase(pressPhase(item, 0, 0), 20, 0);
    expect(movePhase(d, 0, 0).kind).toBe("dragging");
  });

  it("idle は移動しても idle", () => {
    expect(movePhase(IDLE_PHASE, 100, 100)).toBe(IDLE_PHASE);
  });

  it("離したとき: ドラッグ中だけ drop を返し、pending / idle は何もしない", () => {
    const d = movePhase(pressPhase(item, 0, 0), 20, 0);
    expect(releasePhase(d)).toEqual({ phase: IDLE_PHASE, drop: item });
    expect(releasePhase(pressPhase(item, 0, 0))).toEqual({ phase: IDLE_PHASE, drop: null });
    expect(releasePhase(IDLE_PHASE).drop).toBeNull();
  });

  it("キャンセルは idle", () => {
    expect(cancelPhase()).toBe(IDLE_PHASE);
  });

  it("ドロップ先判定: ポインタ下の要素を内包するエディタだけが対象、エディタ外なら null", () => {
    const editor = document.createElement("div");
    const inner = document.createElement("span");
    editor.appendChild(inner);
    const other = document.createElement("div");
    const a = { element: editor, id: "a" };
    expect(pickDropTarget([a], inner)).toBe(a);
    expect(pickDropTarget([a], editor)).toBe(a);
    expect(pickDropTarget([a], other)).toBeNull();
    expect(pickDropTarget([a], null)).toBeNull();
    expect(pickDropTarget([], inner)).toBeNull();
  });
});
