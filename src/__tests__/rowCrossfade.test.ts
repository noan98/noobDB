import { describe, expect, it } from "vitest";
import { rowCrossfadeKeys } from "../components/rowCrossfade";

describe("rowCrossfadeKeys (#1416)", () => {
  it("同じ状態なら同じキー", () => {
    expect(rowCrossfadeKeys([{ id: "1", desc: false }], [], "x")).toEqual(
      rowCrossfadeKeys([{ id: "1", desc: false }], [], "x"),
    );
  });
  it("ソートは sort、列フィルタ・グローバルフィルタは filter のキーだけを変える", () => {
    const base = rowCrossfadeKeys([], [], "");
    const s = rowCrossfadeKeys([{ id: "1", desc: true }], [], "");
    expect(s.sort).not.toBe(base.sort);
    expect(s.filter).toBe(base.filter);
    const c = rowCrossfadeKeys([], [{ id: "1", value: "a" }], "");
    expect(c.filter).not.toBe(base.filter);
    expect(c.sort).toBe(base.sort);
    expect(rowCrossfadeKeys([], [], "abc").filter).not.toBe(base.filter);
  });
  it("グローバルフィルタの前後空白と null / undefined は同一視", () => {
    const base = rowCrossfadeKeys([], [], "");
    expect(rowCrossfadeKeys([], [], "  ")).toEqual(base);
    expect(rowCrossfadeKeys([], [], undefined)).toEqual(base);
    expect(rowCrossfadeKeys([], [], null)).toEqual(base);
  });
});
