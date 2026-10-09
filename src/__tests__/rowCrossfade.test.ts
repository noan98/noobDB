import { describe, expect, it } from "vitest";
import { rowCrossfadeKey } from "../components/rowCrossfade";

describe("rowCrossfadeKey (#1416)", () => {
  it("同じ状態なら同じキー", () => {
    const a = rowCrossfadeKey([{ id: "1", desc: false }], [], "x");
    expect(rowCrossfadeKey([{ id: "1", desc: false }], [], "x")).toBe(a);
  });
  it("ソート・列フィルタ・グローバルフィルタの変化でキーが変わる", () => {
    const base = rowCrossfadeKey([], [], "");
    expect(rowCrossfadeKey([{ id: "1", desc: true }], [], "")).not.toBe(base);
    expect(rowCrossfadeKey([], [{ id: "1", value: "a" }], "")).not.toBe(base);
    expect(rowCrossfadeKey([], [], "abc")).not.toBe(base);
  });
  it("グローバルフィルタの前後空白と null / undefined は同一視", () => {
    const base = rowCrossfadeKey([], [], "");
    expect(rowCrossfadeKey([], [], "  ")).toBe(base);
    expect(rowCrossfadeKey([], [], undefined)).toBe(base);
    expect(rowCrossfadeKey([], [], null)).toBe(base);
  });
});
