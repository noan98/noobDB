import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  attachTreeDragSource,
  getTreeDragSnapshot,
  registerTreeDropTarget,
  type TreeDropTarget,
} from "../components/treeDragStore";
import type { TreeDragItem } from "../components/treeDragInsert";

const item: TreeDragItem = { kind: "column", database: "d", table: "t", column: "c" };

function ptr(type: string, x: number, y: number, init: PointerEventInit = {}) {
  return new PointerEvent(type, { pointerId: 1, isPrimary: true, button: 0, bubbles: true, cancelable: true, clientX: x, clientY: y, ...init });
}

describe("treeDragStore (ポインタ・ドラッグ)", () => {
  let source: HTMLElement;
  let editor: HTMLElement;
  let target: TreeDropTarget;
  let detach: () => void;
  let unregister: () => void;
  let hit: Element | null;

  beforeEach(() => {
    source = document.createElement("div");
    editor = document.createElement("div");
    document.body.append(source, editor);
    hit = editor;
    document.elementFromPoint = () => hit;
    target = {
      element: editor,
      posAtCoords: vi.fn(() => 3),
      setMarker: vi.fn(),
      insert: vi.fn(),
    };
    unregister = registerTreeDropTarget(target);
    detach = attachTreeDragSource(source, () => item);
  });
  afterEach(() => {
    detach();
    unregister();
    source.remove();
    editor.remove();
  });

  it("しきい値未満の移動 + 離しはクリック: ドラッグにならず挿入もされない", () => {
    source.dispatchEvent(ptr("pointerdown", 0, 0));
    window.dispatchEvent(ptr("pointermove", 2, 1));
    expect(getTreeDragSnapshot().active).toBe(false);
    window.dispatchEvent(ptr("pointerup", 2, 1));
    expect(target.insert).not.toHaveBeenCalled();
  });

  it("エディタ上で離すと 1 回だけ挿入され、直後のクリックは握りつぶされる", () => {
    const onClick = vi.fn();
    source.addEventListener("click", onClick);
    source.dispatchEvent(ptr("pointerdown", 0, 0));
    window.dispatchEvent(ptr("pointermove", 30, 0));
    expect(getTreeDragSnapshot()).toMatchObject({ active: true, label: "t.c", overEditor: true });
    expect(target.setMarker).toHaveBeenLastCalledWith(3);
    window.dispatchEvent(ptr("pointerup", 30, 0));
    expect(target.insert).toHaveBeenCalledTimes(1);
    expect(target.insert).toHaveBeenCalledWith(item, 3, true);
    expect(getTreeDragSnapshot().active).toBe(false);
    expect(target.setMarker).toHaveBeenLastCalledWith(null);
    source.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it("Alt を押して離すと列名のみ (qualified=false)", () => {
    source.dispatchEvent(ptr("pointerdown", 0, 0));
    window.dispatchEvent(ptr("pointermove", 30, 0));
    window.dispatchEvent(ptr("pointerup", 30, 0, { altKey: true }));
    expect(target.insert).toHaveBeenCalledWith(item, 3, false);
  });

  it("エディタ外で離したら何もしない", () => {
    hit = document.body;
    source.dispatchEvent(ptr("pointerdown", 0, 0));
    window.dispatchEvent(ptr("pointermove", 30, 0));
    expect(getTreeDragSnapshot()).toMatchObject({ active: true, overEditor: false });
    window.dispatchEvent(ptr("pointerup", 30, 0));
    expect(target.insert).not.toHaveBeenCalled();
    expect(getTreeDragSnapshot().active).toBe(false);
  });

  it("Esc でキャンセル: 離しても挿入されずゴーストも消える", () => {
    source.dispatchEvent(ptr("pointerdown", 0, 0));
    window.dispatchEvent(ptr("pointermove", 30, 0));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(getTreeDragSnapshot().active).toBe(false);
    window.dispatchEvent(ptr("pointermove", 40, 0));
    window.dispatchEvent(ptr("pointerup", 40, 0));
    expect(target.insert).not.toHaveBeenCalled();
  });

  it("pointercancel でも挿入せず後始末する", () => {
    source.dispatchEvent(ptr("pointerdown", 0, 0));
    window.dispatchEvent(ptr("pointermove", 30, 0));
    window.dispatchEvent(ptr("pointercancel", 30, 0));
    expect(getTreeDragSnapshot().active).toBe(false);
    expect(target.insert).not.toHaveBeenCalled();
  });

  it("pointerdown は祖先へ伝播しない (接続行の並べ替えドラッグを起動させない)", () => {
    const ancestorDown = vi.fn();
    document.body.addEventListener("pointerdown", ancestorDown);
    source.dispatchEvent(ptr("pointerdown", 0, 0));
    expect(ancestorDown).not.toHaveBeenCalled();
    window.dispatchEvent(ptr("pointerup", 0, 0));
    document.body.removeEventListener("pointerdown", ancestorDown);
  });

  it("右ボタン / 内側のボタン上の押下はドラッグを始めない", () => {
    source.dispatchEvent(ptr("pointerdown", 0, 0, { button: 2 }));
    window.dispatchEvent(ptr("pointermove", 30, 0));
    expect(getTreeDragSnapshot().active).toBe(false);
    const btn = document.createElement("button");
    source.appendChild(btn);
    btn.dispatchEvent(ptr("pointerdown", 0, 0));
    window.dispatchEvent(ptr("pointermove", 30, 0));
    expect(getTreeDragSnapshot().active).toBe(false);
  });
});
