import { useEffect } from "react";
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
});

// ペインの分割 / 解除で残る方のペインを再マウントしない (#1310)。App.tsx は
// ペイン数が 1 でも Splitter を使い、2 枚目を畳むだけにしている。
describe("Splitter の 2 枚目の出し入れ (#1310)", () => {
  it("2 枚目を畳んで出し入れしても 1 枚目を再マウントしない", () => {
    const mounts = vi.fn();
    const unmounts = vi.fn();
    function Pane() {
      useEffect(() => {
        mounts();
        return () => unmounts();
      }, []);
      return <div data-testid="pane-a">A</div>;
    }
    const render = (split: boolean) => (
      <Splitter
        direction="row"
        ariaLabel="panes"
        first={<Pane />}
        second={split ? <div data-testid="pane-b">B</div> : null}
        secondCollapsed={!split}
      />
    );
    const view = renderWithProviders(render(false));
    const el = screen.getByTestId("pane-a");
    expect(screen.queryByRole("separator", { name: "panes" })).toBeNull();
    view.rerender(render(true));
    expect(screen.getByRole("separator", { name: "panes" })).toBeInTheDocument();
    expect(screen.getByTestId("pane-b")).toBeInTheDocument();
    view.rerender(render(false));
    expect(screen.queryByTestId("pane-b")).toBeNull();
    expect(screen.getByTestId("pane-a")).toBe(el);
    expect(mounts).toHaveBeenCalledTimes(1);
    expect(unmounts).not.toHaveBeenCalled();
  });
});
