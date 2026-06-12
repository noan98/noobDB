import { beforeEach, describe, expect, it } from "vitest";

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
});
