import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  attachTreeDragSource,
  beginPointerDrag,
  getTreeDragSnapshot,
  insertAtEditorCaret,
  registerTreeDropTarget,
  type TreeDropTarget,
} from "../components/treeDragStore";
import type { TreeDragItem } from "../components/treeDragInsert";

const item: TreeDragItem = { kind: "column", database: "d", table: "t", column: "c" };

function ptr(type: string, x: number, y: number, init: PointerEventInit = {}) {
  return new PointerEvent(type, {
    pointerId: 1,
    isPrimary: true,
    button: 0,
    buttons: 1,
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    ...init,
  });
}

describe("treeDragStore (ポインタ・ドラッグ)", () => {
  let source: HTMLElement;
  let editor: HTMLElement;
  let target: TreeDropTarget;
  let detach: () => void;
  let unregister: () => void;
  let hit: Element | null;
  const originalElementFromPoint = document.elementFromPoint;

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
  afterEach(async () => {
    // ドラッグ後に張られるクリック握りつぶしは setTimeout(0) で外れる。次のテストへ持ち越さない。
    await new Promise((r) => setTimeout(r, 0));
    document.elementFromPoint = originalElementFromPoint;
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
    expect(target.insert).toHaveBeenCalledWith(item, 3, true, false);
    expect(getTreeDragSnapshot().active).toBe(false);
    expect(target.setMarker).toHaveBeenLastCalledWith(null);
    source.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it("Shift を押して離すと FK JOIN 雛形の挿入を要求する (joinFk=true, #1540)", () => {
    source.dispatchEvent(ptr("pointerdown", 0, 0));
    window.dispatchEvent(ptr("pointermove", 30, 0));
    window.dispatchEvent(ptr("pointerup", 30, 0, { shiftKey: true }));
    expect(target.insert).toHaveBeenCalledWith(item, 3, true, true);
  });

  it("Alt を押して離すと列名のみ (qualified=false)", () => {
    source.dispatchEvent(ptr("pointerdown", 0, 0));
    window.dispatchEvent(ptr("pointermove", 30, 0));
    window.dispatchEvent(ptr("pointerup", 30, 0, { altKey: true }));
    expect(target.insert).toHaveBeenCalledWith(item, 3, false, false);
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
    // 離すのを待たずにカーソルは戻る (user-select は離すまで維持)。
    expect(document.body.style.cursor).not.toBe("grabbing");
    expect(document.body.style.userSelect).toBe("none");
    window.dispatchEvent(ptr("pointermove", 40, 0));
    window.dispatchEvent(ptr("pointerup", 40, 0));
    expect(document.body.style.userSelect).not.toBe("none");
    expect(target.insert).not.toHaveBeenCalled();
  });

  it("しきい値未満なら click は source に届く (握りつぶされない)", () => {
    const onClick = vi.fn();
    source.addEventListener("click", onClick);
    source.dispatchEvent(ptr("pointerdown", 0, 0));
    window.dispatchEvent(ptr("pointermove", 2, 1));
    window.dispatchEvent(ptr("pointerup", 2, 1));
    source.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    source.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("buttons=0 の pointermove (pointerup の取り逃し) でキャンセルされ、次の pointerup で挿入されない", () => {
    source.dispatchEvent(ptr("pointerdown", 0, 0));
    window.dispatchEvent(ptr("pointermove", 30, 0));
    expect(getTreeDragSnapshot().active).toBe(true);
    window.dispatchEvent(ptr("pointermove", 31, 0, { buttons: 0 }));
    expect(getTreeDragSnapshot().active).toBe(false);
    expect(target.setMarker).toHaveBeenLastCalledWith(null);
    window.dispatchEvent(ptr("pointerup", 40, 0));
    expect(target.insert).not.toHaveBeenCalled();
  });

  it("window の blur でキャンセルされる", () => {
    source.dispatchEvent(ptr("pointerdown", 0, 0));
    window.dispatchEvent(ptr("pointermove", 30, 0));
    expect(getTreeDragSnapshot().active).toBe(true);
    window.dispatchEvent(new Event("blur"));
    expect(getTreeDragSnapshot().active).toBe(false);
    window.dispatchEvent(ptr("pointerup", 40, 0));
    expect(target.insert).not.toHaveBeenCalled();
  });

  it("ドラッグ中にドロップ先が登録解除されたら dispatch せず、離しても挿入しない", () => {
    source.dispatchEvent(ptr("pointerdown", 0, 0));
    window.dispatchEvent(ptr("pointermove", 30, 0));
    unregister();
    vi.mocked(target.setMarker).mockClear();
    window.dispatchEvent(ptr("pointermove", 35, 0));
    window.dispatchEvent(ptr("pointerup", 35, 0));
    expect(target.setMarker).not.toHaveBeenCalled();
    expect(target.insert).not.toHaveBeenCalled();
    unregister = registerTreeDropTarget(target);
  });

  it("位置が変わらない pointermove ではマーカーを更新し直さない", () => {
    source.dispatchEvent(ptr("pointerdown", 0, 0));
    window.dispatchEvent(ptr("pointermove", 30, 0));
    window.dispatchEvent(ptr("pointermove", 31, 0));
    window.dispatchEvent(ptr("pointermove", 32, 0));
    expect(target.setMarker).toHaveBeenCalledTimes(1);
    window.dispatchEvent(ptr("pointerup", 32, 0));
  });

  it("しきい値未満の Esc は伝播を止めない (ドラッグ開始後の Esc だけ止める)", () => {
    const onKey = vi.fn();
    document.body.addEventListener("keydown", onKey);
    source.dispatchEvent(ptr("pointerdown", 0, 0));
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(onKey).toHaveBeenCalledTimes(1);
    window.dispatchEvent(ptr("pointerup", 0, 0));
    document.body.removeEventListener("keydown", onKey);
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

  it("beginPointerDrag: text アイテムをグリッドから落とせる。しきい値未満で離すと onTap", () => {
    const textItem: TreeDragItem = { kind: "text", text: "`id` IN (1, 2)", label: "`id` IN (1, 2)" };
    const onTap = vi.fn();
    expect(beginPointerDrag(source, ptr("pointerdown", 0, 0), textItem, onTap)).toBe(true);
    window.dispatchEvent(ptr("pointerup", 1, 0));
    expect(onTap).toHaveBeenCalledTimes(1);
    expect(target.insert).not.toHaveBeenCalled();

    expect(beginPointerDrag(source, ptr("pointerdown", 0, 0), textItem, onTap)).toBe(true);
    window.dispatchEvent(ptr("pointermove", 30, 0));
    expect(getTreeDragSnapshot()).toMatchObject({ active: true, label: "`id` IN (1, 2)", overEditor: true });
    window.dispatchEvent(ptr("pointerup", 30, 0));
    expect(target.insert).toHaveBeenCalledWith(textItem, 3, true, false);
    expect(onTap).toHaveBeenCalledTimes(1);
  });

  it("beginPointerDrag: Esc で取り消すと挿入も onTap もない", () => {
    const textItem: TreeDragItem = { kind: "text", text: "1", label: "1" };
    const onTap = vi.fn();
    beginPointerDrag(source, ptr("pointerdown", 0, 0), textItem, onTap);
    window.dispatchEvent(ptr("pointermove", 30, 0));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(target.setMarker).toHaveBeenLastCalledWith(null);
    window.dispatchEvent(ptr("pointerup", 30, 0, { buttons: 0 }));
    expect(target.insert).not.toHaveBeenCalled();
    expect(onTap).not.toHaveBeenCalled();
  });

  describe("insertAtEditorCaret", () => {
    const textItem: TreeDragItem = { kind: "text", text: "x", label: "x" };
    const show = (el: Element, visible: boolean) => {
      el.getClientRects = () => (visible ? ([{}] as unknown as DOMRectList) : ([] as unknown as DOMRectList));
    };

    it("見えるエディタの選択範囲へ挿入する", () => {
      show(editor, true);
      target.insertAtSelection = vi.fn();
      expect(insertAtEditorCaret(textItem)).toBe(true);
      expect(target.insertAtSelection).toHaveBeenCalledWith(textItem);
    });

    it("見えるエディタが無ければ (非表示タブのエディタには挿入せず) false", () => {
      show(editor, false);
      target.insertAtSelection = vi.fn();
      expect(insertAtEditorCaret(textItem)).toBe(false);
      expect(target.insertAtSelection).not.toHaveBeenCalled();
      expect(target.insert).not.toHaveBeenCalled();
    });

    it("ドロップ先が無ければ false", () => {
      unregister();
      expect(insertAtEditorCaret(textItem)).toBe(false);
      unregister = registerTreeDropTarget(target);
    });

    it("分割ペインで複数見えるときは、グリッドと同じペインのエディタを選ぶ", () => {
      const paneA = document.createElement("div");
      const paneB = document.createElement("div");
      const gridA = document.createElement("div");
      const editorA = document.createElement("div");
      const editorB = document.createElement("div");
      paneA.append(gridA, editorA);
      paneB.append(editorB);
      document.body.append(paneA, paneB);
      for (const el of [editor, editorA, editorB]) show(el, true);
      const insertA = vi.fn();
      const insertB = vi.fn();
      const offA = registerTreeDropTarget({ ...target, element: editorA, insertAtSelection: insertA });
      const offB = registerTreeDropTarget({ ...target, element: editorB, insertAtSelection: insertB });
      expect(insertAtEditorCaret(textItem, gridA)).toBe(true);
      expect(insertA).toHaveBeenCalledTimes(1);
      expect(insertB).not.toHaveBeenCalled();
      offA();
      offB();
      paneA.remove();
      paneB.remove();
    });

    it("同じ近さなら最後にフォーカスされたエディタを選ぶ", () => {
      const e1 = document.createElement("div");
      const e2 = document.createElement("div");
      const input = document.createElement("textarea");
      e1.append(input);
      document.body.append(e1, e2);
      show(editor, false);
      for (const el of [e1, e2]) show(el, true);
      const i1 = vi.fn();
      const i2 = vi.fn();
      const off1 = registerTreeDropTarget({ ...target, element: e1, insertAtSelection: i1 });
      const off2 = registerTreeDropTarget({ ...target, element: e2, insertAtSelection: i2 });
      input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      expect(insertAtEditorCaret(textItem)).toBe(true);
      expect(i1).toHaveBeenCalledTimes(1);
      expect(i2).not.toHaveBeenCalled();
      off1();
      off2();
      e1.remove();
      e2.remove();
    });
  });
});
