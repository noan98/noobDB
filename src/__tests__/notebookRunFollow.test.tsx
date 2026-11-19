import { describe, expect, it } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { followScrollOptions, isManualScrollInput, useFollowLatch } from "../components/notebookRunFollow";
import { useRef, type ReactNode } from "react";

describe("isManualScrollInput", () => {
  it("ホイール / タッチ移動はコンテナ自身が動くときだけ手動スクロール", () => {
    expect(isManualScrollInput({ type: "wheel" })).toBe(true);
    expect(isManualScrollInput({ type: "touchmove" })).toBe(true);
    // 内側のスクロール領域 (エディタ・結果グリッド) 上のホイールはコンテナを動かさない
    expect(isManualScrollInput({ type: "wheel", innerScroller: true })).toBe(false);
  });
  it("pointerdown はスクロールバー上だけ (余白のクリックは対象外)", () => {
    expect(isManualScrollInput({ type: "pointerdown", onScrollbar: true })).toBe(true);
    expect(isManualScrollInput({ type: "pointerdown", onScrollbar: false })).toBe(false);
    expect(isManualScrollInput({ type: "pointerdown" })).toBe(false);
  });
  it("スクロールキーは編集欄の外でだけ手動スクロール", () => {
    for (const key of ["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown"]) {
      expect(isManualScrollInput({ type: "keydown", key })).toBe(true);
      expect(isManualScrollInput({ type: "keydown", key, editable: true })).toBe(false);
    }
    expect(isManualScrollInput({ type: "keydown", key: "a" })).toBe(false);
  });
  it("Space はボタン上では押下なので手動スクロールではない", () => {
    expect(isManualScrollInput({ type: "keydown", key: " " })).toBe(true);
    expect(isManualScrollInput({ type: "keydown", key: " ", onButton: true })).toBe(false);
    expect(isManualScrollInput({ type: "keydown", key: " ", editable: true })).toBe(false);
  });
  it("未知のイベントは対象外", () => {
    expect(isManualScrollInput({ type: "click" })).toBe(false);
  });
});

describe("followScrollOptions", () => {
  it("block は nearest。still ではスムーズにしない", () => {
    expect(followScrollOptions(false)).toEqual({ block: "nearest", behavior: "smooth" });
    expect(followScrollOptions(true)).toEqual({ block: "nearest", behavior: "auto" });
  });
});

describe("useFollowLatch", () => {
  function Probe({
    active,
    onRef,
    children,
  }: {
    active: boolean;
    onRef: (v: () => boolean) => void;
    children?: ReactNode;
  }) {
    const host = useRef<HTMLDivElement>(null);
    const following = useFollowLatch(host, active);
    onRef(() => following.current);
    return (
      <div ref={host} data-testid="host">
        {children}
      </div>
    );
  }
  it("手動スクロールで追従を止め、次の実行 (active の立ち上がり) で戻す", () => {
    let read = () => false;
    const { getByTestId, rerender } = render(<Probe active onRef={(v) => (read = v)} />);
    expect(read()).toBe(true);
    fireEvent.wheel(getByTestId("host"));
    expect(read()).toBe(false);
    rerender(<Probe active={false} onRef={(v) => (read = v)} />);
    rerender(<Probe active onRef={(v) => (read = v)} />);
    expect(read()).toBe(true);
  });
  it("余白クリック・ボタン上の Space・編集欄のキーでは追従を止めない", () => {
    let read = () => false;
    const { getByTestId } = render(
      <Probe active onRef={(v) => (read = v)}>
        <button type="button" data-testid="btn" />
        <textarea data-testid="ta" />
      </Probe>,
    );
    fireEvent.pointerDown(getByTestId("host"));
    fireEvent.keyDown(getByTestId("btn"), { key: " " });
    fireEvent.keyDown(getByTestId("ta"), { key: "ArrowDown" });
    expect(read()).toBe(true);
    fireEvent.keyDown(getByTestId("host"), { key: "ArrowDown" });
    expect(read()).toBe(false);
  });
});
