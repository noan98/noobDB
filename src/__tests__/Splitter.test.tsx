import { beforeEach, describe, expect, it, vi } from "vitest";

import { fireEvent, renderWithProviders, screen } from "./testUtils";
import { Splitter } from "../components/Splitter";

// 分割ペインのセパレータ。ドラッグはポインタキャプチャを伴い jsdom では
// 再現しづらいため、キーボードによるリサイズ・リセットと a11y 属性を検証する。
describe("Splitter (#478)", () => {
  beforeEach(() => localStorage.clear());

  function renderSplitter() {
    return renderWithProviders(
      <Splitter
        direction="row"
        defaultFraction={0.5}
        ariaLabel="panes"
        first={<div>A</div>}
        second={<div>B</div>}
      />,
    );
  }

  it("separator ロールと aria-value 属性を持つ", () => {
    renderSplitter();
    const sep = screen.getByRole("separator", { name: "panes" });
    expect(sep.getAttribute("aria-orientation")).toBe("vertical");
    expect(sep.getAttribute("aria-valuenow")).toBe("50");
    expect(sep.getAttribute("tabindex")).toBe("0");
  });

  it("矢印キーで配分を増減できる", () => {
    renderSplitter();
    const sep = screen.getByRole("separator", { name: "panes" });
    fireEvent.keyDown(sep, { key: "ArrowRight" });
    expect(sep.getAttribute("aria-valuenow")).toBe("52");
    fireEvent.keyDown(sep, { key: "ArrowLeft" });
    fireEvent.keyDown(sep, { key: "ArrowLeft" });
    expect(sep.getAttribute("aria-valuenow")).toBe("48");
  });

  it("Home / End で端まで寄せ、Enter で既定に戻す", () => {
    renderSplitter();
    const sep = screen.getByRole("separator", { name: "panes" });
    fireEvent.keyDown(sep, { key: "End" });
    expect(sep.getAttribute("aria-valuenow")).toBe("100");
    fireEvent.keyDown(sep, { key: "Home" });
    expect(sep.getAttribute("aria-valuenow")).toBe("0");
    fireEvent.keyDown(sep, { key: "Enter" });
    expect(sep.getAttribute("aria-valuenow")).toBe("50");
  });

  it("配分を localStorage に永続化する", () => {
    renderWithProviders(
      <Splitter
        direction="row"
        defaultFraction={0.5}
        storageKey="test.split"
        ariaLabel="panes"
        first={<div>A</div>}
        second={<div>B</div>}
      />,
    );
    const sep = screen.getByRole("separator", { name: "panes" });
    fireEvent.keyDown(sep, { key: "ArrowRight" });
    expect(Number(localStorage.getItem("test.split"))).toBeCloseTo(0.52, 2);
  });

  it("ポインタのドラッグ中は localStorage に書かず、離したときに 1 回だけ保存する (#1312)", () => {
    const rafs: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => rafs.push(cb));
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    try {
      renderWithProviders(
        <Splitter
          direction="row"
          defaultFraction={0.5}
          storageKey="test.drag"
          ariaLabel="panes"
          first={<div>A</div>}
          second={<div>B</div>}
        />,
      );
      const sep = screen.getByRole("separator", { name: "panes" });
      const container = sep.parentElement as HTMLElement;
      container.getBoundingClientRect = () =>
        ({ left: 0, top: 0, width: 1000, height: 600, right: 1000, bottom: 600, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
      fireEvent.pointerDown(sep, { pointerId: 1, clientX: 500, clientY: 10 });
      fireEvent.pointerMove(sep, { pointerId: 1, clientX: 600, clientY: 10 });
      fireEvent.pointerMove(sep, { pointerId: 1, clientX: 700, clientY: 10 });
      expect(rafs).toHaveLength(1);
      rafs.shift()?.(0);
      expect(sep.getAttribute("aria-valuenow")).toBe("70");
      expect(setItem.mock.calls.filter(([k]) => k === "test.drag")).toHaveLength(0);
      fireEvent.pointerUp(sep, { pointerId: 1 });
      const writes = setItem.mock.calls.filter(([k]) => k === "test.drag");
      expect(writes).toHaveLength(1);
      expect(Number(writes[0][1])).toBeCloseTo(0.7, 2);
      expect(sep.getAttribute("aria-valuenow")).toBe("70");
    } finally {
      setItem.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("保存済みの配分を復元する", () => {
    localStorage.setItem("test.restore", "0.3000");
    renderWithProviders(
      <Splitter direction="row" storageKey="test.restore" ariaLabel="panes" first={<div>A</div>} second={<div>B</div>} />,
    );
    expect(screen.getByRole("separator", { name: "panes" }).getAttribute("aria-valuenow")).toBe("30");
  });
});
