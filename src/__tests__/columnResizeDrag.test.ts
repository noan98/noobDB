// @vitest-environment jsdom (localStorage / DOM に触れるため。DOM を使わないテストは node 環境で走る)
import { describe, expect, it, vi } from "vitest";
import {
  beginColumnResizeDrag,
  formatResizeWidth,
  resizeClampState,
  resizedColumnWidth,
} from "../components/columnResizeDrag";

describe("resizedColumnWidth (#1312)", () => {
  it("ドラッグ量を足し、min / max に収める", () => {
    expect(resizedColumnWidth(100, 30, 20, 500)).toBe(130);
    expect(resizedColumnWidth(100, -200, 20, 500)).toBe(20);
    expect(resizedColumnWidth(100, 900, 20, 500)).toBe(500);
  });
});

describe("beginColumnResizeDrag (#1312)", () => {
  it("ドラッグ中は <col> / <table> を直接書き換え、離したときだけ確定する", () => {
    const rafs: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => rafs.push(cb));
    vi.stubGlobal("cancelAnimationFrame", () => {});
    try {
      const col = document.createElement("col");
      const table = document.createElement("table");
      table.getBoundingClientRect = () => ({ width: 1000 }) as DOMRect;
      const th = document.createElement("th");
      const onCommit = vi.fn();
      beginColumnResizeDrag({
        event: {
          nativeEvent: new MouseEvent("mousedown", { clientX: 100, button: 0 }),
        } as unknown as React.MouseEvent,
        startSize: 150,
        minSize: 40,
        maxSize: 600,
        col,
        table,
        header: th,
        onCommit,
      });
      expect(th.classList.contains("is-resizing")).toBe(true);
      document.dispatchEvent(new MouseEvent("mousemove", { clientX: 130 }));
      document.dispatchEvent(new MouseEvent("mousemove", { clientX: 160 }));
      expect(rafs).toHaveLength(1);
      rafs.shift()?.(0);
      expect(col.style.width).toBe("210px");
      expect(table.style.width).toBe("1060px");
      expect(onCommit).not.toHaveBeenCalled();
      document.dispatchEvent(new MouseEvent("mouseup"));
      expect(onCommit).toHaveBeenCalledTimes(1);
      expect(onCommit).toHaveBeenCalledWith(210);
      expect(th.classList.contains("is-resizing")).toBe(false);
      // 解除済み: 以後の mousemove は何も起こさない。
      document.dispatchEvent(new MouseEvent("mousemove", { clientX: 400 }));
      expect(rafs).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("幅が変わらなければ確定しない", () => {
    const onCommit = vi.fn();
    beginColumnResizeDrag({
      event: {
        nativeEvent: new MouseEvent("mousedown", { clientX: 100, button: 0 }),
      } as unknown as React.MouseEvent,
      startSize: 150,
      minSize: 40,
      maxSize: 600,
      col: null,
      table: null,
      header: null,
      onCommit,
    });
    document.dispatchEvent(new MouseEvent("mouseup"));
    expect(onCommit).not.toHaveBeenCalled();
  });
});

describe("ライブガイド (#1580)", () => {
  it("幅バッジは整数 px、最小 / 最大に張り付いたら状態を返す", () => {
    expect(formatResizeWidth(150.4)).toBe("150");
    expect(formatResizeWidth(150.5)).toBe("151");
    expect(resizeClampState(40, 40, 600)).toBe("min");
    expect(resizeClampState(600, 40, 600)).toBe("max");
    expect(resizeClampState(300, 40, 600)).toBeNull();
  });

  it("ドラッグ中だけガイドを body に出し、幅バッジを更新し、離すと消す", () => {
    const rafs: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => rafs.push(cb));
    vi.stubGlobal("cancelAnimationFrame", () => {});
    try {
      const th = document.createElement("th");
      th.getBoundingClientRect = () => ({ top: 10, right: 250 }) as DOMRect;
      beginColumnResizeDrag({
        event: {
          nativeEvent: new MouseEvent("mousedown", { clientX: 100, button: 0 }),
        } as unknown as React.MouseEvent,
        startSize: 150,
        minSize: 40,
        maxSize: 600,
        col: null,
        table: null,
        header: th,
        guideLabel: (w) => `幅 ${w} px`,
        onCommit: vi.fn(),
      });
      const guide = document.querySelector<HTMLElement>(".col-resize-guide");
      expect(guide).not.toBeNull();
      expect(guide?.textContent).toBe("幅 150 px");
      document.dispatchEvent(new MouseEvent("mousemove", { clientX: 130 }));
      rafs.shift()?.(0);
      expect(guide?.textContent).toBe("幅 180 px");
      document.dispatchEvent(new MouseEvent("mousemove", { clientX: -500 }));
      rafs.shift()?.(0);
      expect(guide?.textContent).toBe("幅 40 px");
      expect(guide?.dataset.clamp).toBe("min");
      document.dispatchEvent(new MouseEvent("mouseup"));
      expect(document.querySelector(".col-resize-guide")).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
