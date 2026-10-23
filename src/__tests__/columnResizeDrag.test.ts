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
      document.dispatchEvent(new MouseEvent("mousemove", { clientX: 130, buttons: 1 }));
      document.dispatchEvent(new MouseEvent("mousemove", { clientX: 160, buttons: 1 }));
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
      document.dispatchEvent(new MouseEvent("mousemove", { clientX: 400, buttons: 1 }));
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
      th.getBoundingClientRect = () => ({ top: 10, bottom: 34, left: 100, right: 250 }) as DOMRect;
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
      expect(guide?.style.top).toBe("10px");
      expect(guide?.style.transform).toBe("translateX(250px)");
      // バッジはヘッダ行 (高さ 24px) の下に出す。
      expect(guide?.querySelector<HTMLElement>(".col-resize-guide-badge")?.style.top).toBe("24px");
      document.dispatchEvent(new MouseEvent("mousemove", { clientX: 130, buttons: 1 }));
      rafs.shift()?.(0);
      expect(guide?.textContent).toBe("幅 180 px");
      document.dispatchEvent(new MouseEvent("mousemove", { clientX: -500, buttons: 1 }));
      rafs.shift()?.(0);
      expect(guide?.textContent).toBe("幅 40 px");
      expect(guide?.dataset.clamp).toBe("min");
      document.dispatchEvent(new MouseEvent("mouseup"));
      expect(document.querySelector(".col-resize-guide")).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  function setup(opts: { table: DOMRect; scroll?: DOMRect; header?: Partial<DOMRect> }) {
    const wrap = document.createElement("div");
    wrap.style.overflowY = "auto";
    wrap.getBoundingClientRect = () =>
      (opts.scroll ?? { top: 0, bottom: 500, left: 0, right: 600 }) as DOMRect;
    const table = document.createElement("table");
    table.getBoundingClientRect = () => opts.table;
    wrap.appendChild(table);
    document.body.appendChild(wrap);
    const th = document.createElement("th");
    th.getBoundingClientRect = () =>
      ({ top: 10, bottom: 34, left: 100, right: 250, ...opts.header }) as DOMRect;
    const onCommit = vi.fn();
    beginColumnResizeDrag({
      event: {
        nativeEvent: new MouseEvent("mousedown", { clientX: 100, button: 0 }),
      } as unknown as React.MouseEvent,
      startSize: 150,
      minSize: 40,
      maxSize: 600,
      col: null,
      table,
      header: th,
      guideLabel: (w) => w,
      onCommit,
    });
    return { wrap, onCommit, th };
  }

  it("縦範囲の下端は min(スクロール領域, テーブル) で、行が少なくても空白を貫かない", () => {
    const a = setup({ table: { width: 500, bottom: 120 } as DOMRect });
    expect(document.querySelector<HTMLElement>(".col-resize-guide")?.style.height).toBe("110px");
    document.dispatchEvent(new MouseEvent("mouseup"));
    a.wrap.remove();
    const b = setup({ table: { width: 500, bottom: 900 } as DOMRect });
    expect(document.querySelector<HTMLElement>(".col-resize-guide")?.style.height).toBe("490px");
    document.dispatchEvent(new MouseEvent("mouseup"));
    b.wrap.remove();
  });

  it("ガイドはスクロール領域の left〜right に収め、右端ではバッジを左側へ反転する", () => {
    const { wrap } = setup({
      table: { width: 500, bottom: 300 } as DOMRect,
      scroll: { top: 0, bottom: 500, left: 50, right: 400 } as DOMRect,
    });
    const guide = document.querySelector<HTMLElement>(".col-resize-guide");
    expect(guide?.style.transform).toBe("translateX(250px)");
    expect(guide?.dataset.flip).toBe("");
    document.dispatchEvent(new MouseEvent("mouseup"));
    wrap.remove();
    const c = setup({
      table: { width: 500, bottom: 300 } as DOMRect,
      scroll: { top: 0, bottom: 500, left: 50, right: 400 } as DOMRect,
      header: { right: 10 },
    });
    expect(document.querySelector<HTMLElement>(".col-resize-guide")?.style.transform).toBe(
      "translateX(50px)",
    );
    document.dispatchEvent(new MouseEvent("mouseup"));
    c.wrap.remove();
    const d = setup({
      table: { width: 500, bottom: 300 } as DOMRect,
      scroll: { top: 0, bottom: 500, left: 50, right: 400 } as DOMRect,
      header: { right: 900 },
    });
    const g = document.querySelector<HTMLElement>(".col-resize-guide");
    expect(g?.style.transform).toBe("translateX(400px)");
    expect(g?.dataset.flip).toBe("left");
    document.dispatchEvent(new MouseEvent("mouseup"));
    d.wrap.remove();
  });

  it("mouseup を取り逃がしても、ボタンが離れた mousemove / window blur で終了する", () => {
    const a = setup({ table: { width: 500, bottom: 300 } as DOMRect });
    expect(document.querySelector(".col-resize-guide")).not.toBeNull();
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 120, buttons: 0 }));
    expect(document.querySelector(".col-resize-guide")).toBeNull();
    expect(a.th.classList.contains("is-resizing")).toBe(false);
    a.wrap.remove();
    const b = setup({ table: { width: 500, bottom: 300 } as DOMRect });
    window.dispatchEvent(new Event("blur"));
    expect(document.querySelector(".col-resize-guide")).toBeNull();
    expect(b.th.classList.contains("is-resizing")).toBe(false);
    b.wrap.remove();
  });
});
