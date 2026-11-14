import { describe, expect, it } from "vitest";
import {
  applyTabDrop,
  insertionIndex,
  isDraggedOut,
  resolveTabDrop,
  dragOutDistance,
  type DropPane,
  type PaneGeometry,
} from "../tabPaneDrop";

// タブのペイン間ドラッグ (#2332) の純ロジック。

const bar = { left: 0, top: 0, right: 400, bottom: 30 };
const tabsOf = (ids: string[], x0 = 0) =>
  ids.map((id, i) => ({ id, left: x0 + i * 100, right: x0 + (i + 1) * 100 }));
const pane = (paneId: string, x0: number, ids: string[]): PaneGeometry => ({
  paneId,
  rect: { left: x0, top: 0, right: x0 + 400, bottom: 300 },
  bar: { ...bar, left: x0, right: x0 + 400 },
  tabs: tabsOf(ids, x0),
});

describe("isDraggedOut", () => {
  const d = dragOutDistance(bar); // バー高さ 30 × 0.75
  it("距離はバーの高さに比例する", () => {
    expect(d).toBe(22.5);
    expect(dragOutDistance({ ...bar, bottom: 60 })).toBe(45);
  });
  it("帯から縦に距離以上離れたときだけ true", () => {
    expect(isDraggedOut(10, 30 + d, bar)).toBe(false);
    expect(isDraggedOut(10, 30 + d + 1, bar)).toBe(true);
    expect(isDraggedOut(10, -d - 1, bar)).toBe(true);
    expect(isDraggedOut(10, 15, bar)).toBe(false);
  });
  it("バーの左右の外へ出ても、別ペインのバーの上でなければ切り替えない (並べ替えを切らない)", () => {
    expect(isDraggedOut(900, 15, bar)).toBe(false);
    expect(isDraggedOut(-500, 15, bar)).toBe(false);
  });
  it("別ペインのバーの上に入ったら切り替える", () => {
    const other = { left: 400, top: 0, right: 800, bottom: 30 };
    expect(isDraggedOut(399, 15, bar, [other])).toBe(false);
    expect(isDraggedOut(401, 15, bar, [other])).toBe(true);
  });
});

describe("insertionIndex", () => {
  const tabs = tabsOf(["a", "b", "c"]);
  it("タブの中点より左なら手前、右端なら末尾", () => {
    expect(insertionIndex(tabs, 10)).toBe(0);
    expect(insertionIndex(tabs, 60)).toBe(1);
    expect(insertionIndex(tabs, 149)).toBe(1);
    expect(insertionIndex(tabs, 151)).toBe(2);
    expect(insertionIndex(tabs, 999)).toBe(3);
  });
  it("除外したタブは数えない", () => {
    expect(insertionIndex(tabs, 999, "c")).toBe(2);
  });
});

describe("resolveTabDrop", () => {
  const two = [pane("p1", 0, ["a", "b"]), pane("p2", 400, ["c", "d"])];
  it("別ペインのタブバー → その位置への挿入とマーカー", () => {
    const r = resolveTabDrop(460, 10, two, "p1", "a");
    expect(r?.target).toEqual({ kind: "bar", paneId: "p2", index: 1 });
    expect(r?.preview).toEqual({ kind: "marker", rect: { left: 500, right: 500, top: 0, bottom: 30 } });
  });
  it("マーカーはタブバーの内側に収まる (スクロールで見切れたタブの外へ出さない)", () => {
    const wide = {
      ...pane("p2", 400, ["c", "d", "e", "f", "g", "h"]),
      bar: { left: 400, top: 0, right: 700, bottom: 30 },
    };
    const r = resolveTabDrop(690, 10, [pane("p1", 0, ["a"]), wide], "p1", "a");
    expect(r?.preview.rect.left).toBeLessThanOrEqual(700);
    expect(r?.preview.rect.left).toBeGreaterThanOrEqual(400);
  });
  it("別ペインのタブバーの右の空き → 末尾", () => {
    const r = resolveTabDrop(790, 10, two, "p1", "a");
    expect(r?.target).toEqual({ kind: "bar", paneId: "p2", index: 2 });
  });
  it("2 ペイン: 別ペインの本体 → 末尾へ (面プレビュー)", () => {
    const r = resolveTabDrop(600, 150, two, "p1", "a");
    expect(r?.target).toEqual({ kind: "append", paneId: "p2" });
    expect(r?.preview.kind).toBe("face");
    expect(r?.preview.rect.top).toBe(30);
  });
  it("元のペイン自身の上は落とせない", () => {
    expect(resolveTabDrop(100, 150, two, "p1", "a")).toBeNull();
    expect(resolveTabDrop(100, 10, two, "p1", "a")).toBeNull();
  });
  it("ペインの外は null", () => {
    expect(resolveTabDrop(900, 150, two, "p1", "a")).toBeNull();
  });

  const one = [pane("p1", 0, ["a", "b"])];
  it("1 ペイン: 右端 → 右半面へ分割", () => {
    const r = resolveTabDrop(390, 150, one, "p1", "a");
    expect(r?.target).toEqual({ kind: "split" });
    expect(r?.preview.rect).toEqual({ left: 200, right: 400, top: 30, bottom: 300 });
  });
  it("1 ペイン: 左端と中央は落とせない (左分割は再マウントを招くので持たない)", () => {
    expect(resolveTabDrop(10, 150, one, "p1", "a")).toBeNull();
    expect(resolveTabDrop(200, 150, one, "p1", "a")).toBeNull();
  });
  it("右端ゾーンの境界 (幅の 25%)", () => {
    expect(resolveTabDrop(299, 150, one, "p1", "a")).toBeNull();
    expect(resolveTabDrop(300, 150, one, "p1", "a")?.target).toEqual({ kind: "split" });
  });
  it("1 ペインでタブが 1 つだけなら分割できない", () => {
    expect(resolveTabDrop(390, 150, [pane("p1", 0, ["a"])], "p1", "a")).toBeNull();
  });
});

describe("applyTabDrop", () => {
  let n = 0;
  const mk = () => `new${++n}`;
  const two: DropPane[] = [
    { id: "p1", tabIds: ["a", "b", "c"], activeTabId: "b" },
    { id: "p2", tabIds: ["d", "e"], activeTabId: "d" },
  ];
  it("タブバーへ: 指定位置に入り、移動先でアクティブ。元のアクティブは隣へ", () => {
    const r = applyTabDrop(two, "b", { kind: "bar", paneId: "p2", index: 1 }, mk);
    expect(r?.panes).toEqual([
      { id: "p1", tabIds: ["a", "c"], activeTabId: "c" },
      { id: "p2", tabIds: ["d", "b", "e"], activeTabId: "b" },
    ]);
    expect(r?.activePaneId).toBe("p2");
  });
  it("アクティブでないタブを移しても元のアクティブは変わらない", () => {
    const r = applyTabDrop(two, "a", { kind: "append", paneId: "p2" }, mk);
    expect(r?.panes[0]).toEqual({ id: "p1", tabIds: ["b", "c"], activeTabId: "b" });
    expect(r?.panes[1].tabIds).toEqual(["d", "e", "a"]);
  });
  it("元が空になったら 1 ペインへ戻る", () => {
    const r = applyTabDrop(
      [{ id: "p1", tabIds: ["a"], activeTabId: "a" }, two[1]],
      "a",
      { kind: "append", paneId: "p2" },
      mk,
    );
    expect(r?.panes.map((p) => p.id)).toEqual(["p2"]);
    expect(r?.activePaneId).toBe("p2");
  });
  it("1 ペインの右端へ: 新しいペインが右に入る", () => {
    const r = applyTabDrop([two[0]], "c", { kind: "split" }, () => "np");
    expect(r?.panes).toEqual([
      { id: "p1", tabIds: ["a", "b"], activeTabId: "b" },
      { id: "np", tabIds: ["c"], activeTabId: "c" },
    ]);
    expect(r?.activePaneId).toBe("np");
  });
  it("成立しない組み合わせは null", () => {
    expect(applyTabDrop(two, "zz", { kind: "append", paneId: "p2" }, mk)).toBeNull();
    expect(applyTabDrop(two, "a", { kind: "append", paneId: "p1" }, mk)).toBeNull();
    expect(applyTabDrop(two, "a", { kind: "split" }, mk)).toBeNull();
    expect(
      applyTabDrop([{ id: "p1", tabIds: ["a"], activeTabId: "a" }], "a", { kind: "split" }, mk),
    ).toBeNull();
  });
  it("入力を破壊しない", () => {
    const before = JSON.stringify(two);
    applyTabDrop(two, "a", { kind: "append", paneId: "p2" }, mk);
    expect(JSON.stringify(two)).toBe(before);
  });
});
