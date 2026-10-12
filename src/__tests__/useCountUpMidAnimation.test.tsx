import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// motion の命令的 animate() を差し替え、開始値と onUpdate を観測する。
const animateCalls: { from: number; to: number; onUpdate: (v: number) => void }[] = [];
vi.mock("motion/react", () => ({
  useReducedMotion: () => false,
  animate: (from: number, to: number, opts: { onUpdate: (v: number) => void }) => {
    animateCalls.push({ from, to, onUpdate: opts.onUpdate });
    return { stop: () => {} };
  },
}));

import { useCountUp } from "../useCountUp";

describe("useCountUp: 補間の途中で目標が変わったとき (#1534)", () => {
  beforeEach(() => {
    animateCalls.length = 0;
  });

  it("新しい補間は前回の目標値ではなく、画面に出ている現在の補間値から始まる", () => {
    const { result, rerender } = renderHook(({ v }) => useCountUp(v), { initialProps: { v: 100 } });

    rerender({ v: 1000 });
    expect(animateCalls).toHaveLength(1);
    expect(animateCalls[0].from).toBe(100);

    // 100 → 1000 の補間が 400 まで進んだところで、目標が 2000 に変わる。
    act(() => animateCalls[0].onUpdate(400));
    expect(result.current.display).toBe(400);
    rerender({ v: 2000 });

    expect(animateCalls).toHaveLength(2);
    expect(animateCalls[1].from).toBe(400);
    expect(animateCalls[1].to).toBe(2000);
  });
});
