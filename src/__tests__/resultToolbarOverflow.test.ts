import { describe, expect, it } from "vitest";
import {
  COLLAPSIBLE_TOOLBAR_ACTIONS,
  nextCollapsedCount,
  splitCollapsed,
} from "../components/resultToolbarOverflow";

const base = { collapsed: 0, total: 5, clientWidth: 1000, scrollWidth: 1000, nextExpandWidth: 100 };

describe("splitCollapsed", () => {
  const present = ["a", "b", "c", "d"];
  it("0 個なら全部残す", () => {
    expect(splitCollapsed(present, 0)).toEqual({ visible: present, collapsed: [] });
  });
  it("末尾から畳む", () => {
    expect(splitCollapsed(present, 2)).toEqual({ visible: ["a", "b"], collapsed: ["c", "d"] });
  });
  it("個数が範囲外でもクランプする", () => {
    expect(splitCollapsed(present, 99).visible).toEqual([]);
    expect(splitCollapsed(present, -3).collapsed).toEqual([]);
  });
  it("空配列でも落ちない", () => {
    expect(splitCollapsed([], 2)).toEqual({ visible: [], collapsed: [] });
  });
});

describe("nextCollapsedCount", () => {
  it("はみ出していれば 1 つ畳む", () => {
    expect(nextCollapsedCount({ ...base, scrollWidth: 1200 })).toBe(1);
  });
  it("すでに全部畳んでいたらそれ以上増やさない", () => {
    expect(nextCollapsedCount({ ...base, collapsed: 5, scrollWidth: 1500 })).toBe(5);
  });
  it("1px 以内の誤差は無視する", () => {
    expect(nextCollapsedCount({ ...base, scrollWidth: 1001 })).toBe(0);
  });
  it("余白が足りなければ展開しない", () => {
    expect(nextCollapsedCount({ ...base, collapsed: 2, scrollWidth: 900 })).toBe(2);
  });
  it("余白が十分なら 1 つ展開する", () => {
    expect(nextCollapsedCount({ ...base, collapsed: 2, scrollWidth: 800 })).toBe(1);
  });
  it("幅が未計測なら展開しない", () => {
    expect(
      nextCollapsedCount({ ...base, collapsed: 2, scrollWidth: 100, nextExpandWidth: null }),
    ).toBe(2);
  });
  it("展開直後の幅では再び畳まない (往復しない)", () => {
    const after = nextCollapsedCount({ ...base, collapsed: 2, scrollWidth: 800 });
    // 展開で scrollWidth が +100 になっても clientWidth 以内に収まる。
    expect(nextCollapsedCount({ ...base, collapsed: after, scrollWidth: 900 })).toBe(after);
  });
  it("畳める操作は Export を含まず重複しない", () => {
    expect(new Set(COLLAPSIBLE_TOOLBAR_ACTIONS).size).toBe(COLLAPSIBLE_TOOLBAR_ACTIONS.length);
  });
});
