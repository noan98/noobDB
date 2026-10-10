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
  return new PointerEvent(type, { pointerId: 1, isPrimary: true, button: 0, buttons: 1, bubbles: true, cancelable: true, clientX: x, clientY: y, ...init });
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
});
