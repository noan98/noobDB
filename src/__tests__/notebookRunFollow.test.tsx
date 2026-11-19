import { describe, expect, it } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { followScrollOptions, isManualScrollInput, useFollowLatch } from "../components/notebookRunFollow";
import { useRef } from "react";

describe("isManualScrollInput", () => {
  it("ホイール / タッチ移動は手動スクロール", () => {
    expect(isManualScrollInput({ type: "wheel" })).toBe(true);
    expect(isManualScrollInput({ type: "touchmove" })).toBe(true);
  });
  it("コンテナ自身への pointerdown (スクロールバー) だけ手動スクロール", () => {
    expect(isManualScrollInput({ type: "pointerdown", onContainer: true })).toBe(true);
    expect(isManualScrollInput({ type: "pointerdown", onContainer: false })).toBe(false);
  });
  it("スクロールキーは編集中でなければ手動スクロール", () => {
    expect(isManualScrollInput({ type: "keydown", key: "PageDown" })).toBe(true);
    expect(isManualScrollInput({ type: "keydown", key: " " })).toBe(true);
    expect(isManualScrollInput({ type: "keydown", key: " ", editable: true })).toBe(false);
    expect(isManualScrollInput({ type: "keydown", key: "a" })).toBe(false);
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
  function Probe({ active, onRef }: { active: boolean; onRef: (v: () => boolean) => void }) {
    const host = useRef<HTMLDivElement>(null);
    const following = useFollowLatch(host, active);
    onRef(() => following.current);
    return <div ref={host} data-testid="host" />;
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
});
