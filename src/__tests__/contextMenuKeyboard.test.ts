import { describe, expect, it } from "vitest";
import {
  contextMenuPointFromRect,
  contextMenuTriggerFromRect,
  isContextMenuOpenKey,
  pickContextMenuOpenKeys,
} from "../components/contextMenuKeyboard";

// 結果グリッド・スキーマツリーの行でコンテキストメニューをキーボードから開く
// 判定 (#1185)。DOM 無しで境界ケースを固定する (`modalKeys.test.ts` と同じ方針)。

describe("isContextMenuOpenKey", () => {
  it("Shift+F10 は開くキー", () => {
    expect(isContextMenuOpenKey({ key: "F10", shiftKey: true })).toBe(true);
  });

  it("Shift 無しの F10 は開かない", () => {
    expect(isContextMenuOpenKey({ key: "F10", shiftKey: false })).toBe(false);
  });

  it("独立した ContextMenu キーは Shift の有無に関わらず開く", () => {
    expect(isContextMenuOpenKey({ key: "ContextMenu", shiftKey: false })).toBe(true);
    expect(isContextMenuOpenKey({ key: "ContextMenu", shiftKey: true })).toBe(true);
  });

  it("それ以外のキーは開かない", () => {
    expect(isContextMenuOpenKey({ key: "Enter", shiftKey: true })).toBe(false);
    expect(isContextMenuOpenKey({ key: "F9", shiftKey: true })).toBe(false);
  });

  it("IME 変換中は無視する", () => {
    expect(isContextMenuOpenKey({ key: "ContextMenu", shiftKey: false, isComposing: true })).toBe(false);
    expect(isContextMenuOpenKey({ key: "F10", shiftKey: true, isComposing: true })).toBe(false);
  });

  it("既に処理済み (defaultPrevented) のキーは無視する", () => {
    expect(isContextMenuOpenKey({ key: "ContextMenu", shiftKey: false, defaultPrevented: true })).toBe(false);
  });
});

describe("pickContextMenuOpenKeys", () => {
  it("React のキーボードイベントから判定用の値だけを抜き出す", () => {
    const picked = pickContextMenuOpenKeys({
      key: "F10",
      shiftKey: true,
      defaultPrevented: false,
      nativeEvent: { isComposing: true },
    });
    expect(picked).toEqual({ key: "F10", shiftKey: true, isComposing: true, defaultPrevented: false });
  });
});

describe("contextMenuPointFromRect / contextMenuTriggerFromRect", () => {
  it("要素の左下をメニューの起点にする", () => {
    expect(contextMenuPointFromRect({ left: 10, bottom: 40 })).toEqual({ x: 10, y: 40 });
  });

  it("右クリックの onContextMenu がそのまま使える最小限のイベントを組み立てる", () => {
    const trigger = contextMenuTriggerFromRect({ left: 5, bottom: 20 });
    expect(trigger.clientX).toBe(5);
    expect(trigger.clientY).toBe(20);
    // preventDefault/stopPropagation は呼んでも例外を投げないダミー。
    expect(() => trigger.preventDefault()).not.toThrow();
    expect(() => trigger.stopPropagation()).not.toThrow();
  });
});
