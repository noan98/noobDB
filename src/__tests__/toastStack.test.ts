import { describe, expect, it } from "vitest";
import { MAX_VISIBLE_TOASTS, splitToastStack } from "../components/toastStack";

const n = (id: number, action = false) => ({ id, action: action ? {} : undefined });
const ids = (xs: { id: number }[]) => xs.map((x) => x.id);

describe("splitToastStack (#1501)", () => {
  it("上限以内なら畳まない", () => {
    const r = splitToastStack([n(1), n(2)], 4);
    expect(ids(r.visible)).toEqual([1, 2]);
    expect(r.hiddenCount).toBe(0);
  });
  it("超過分は古い方から畳み、新しいものを残す", () => {
    const r = splitToastStack([n(1), n(2), n(3), n(4), n(5), n(6)], 4);
    expect(ids(r.visible)).toEqual([3, 4, 5, 6]);
    expect(r.hiddenCount).toBe(2);
  });
  it("アクション付きは古くても優先して残す", () => {
    const r = splitToastStack([n(1, true), n(2), n(3), n(4), n(5)], 3);
    expect(ids(r.visible)).toEqual([1, 4, 5]);
    expect(r.hiddenCount).toBe(2);
  });
  it("アクション付きだけで超過すると古い方から畳む", () => {
    const r = splitToastStack([n(1, true), n(2, true), n(3, true)], 2);
    expect(ids(r.visible)).toEqual([2, 3]);
    expect(r.hiddenCount).toBe(1);
  });
  it("アクション付きで埋まっていても最新の 1 件は必ず表示する", () => {
    const r = splitToastStack([n(1, true), n(2, true), n(3, true), n(4, true), n(5)], 4);
    expect(ids(r.visible)).toEqual([2, 3, 4, 5]);
    expect(r.hiddenCount).toBe(1);
  });
  it("max が不正でも最低 1 件は残し、既定値は 4", () => {
    expect(splitToastStack([n(1), n(2)], 0).visible).toHaveLength(1);
    expect(MAX_VISIBLE_TOASTS).toBe(4);
  });
});
