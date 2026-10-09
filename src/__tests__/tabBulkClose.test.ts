import { describe, expect, it } from "vitest";
import { tabsToClose } from "../tabBulkClose";

const ids = ["a", "b", "c", "d"];

describe("tabsToClose", () => {
  it("others: 基点以外すべて", () => {
    expect(tabsToClose(ids, "b", "others")).toEqual(["a", "c", "d"]);
  });
  it("others: 唯一のタブなら空", () => {
    expect(tabsToClose(["a"], "a", "others")).toEqual([]);
  });
  it("right: 基点より右だけ", () => {
    expect(tabsToClose(ids, "b", "right")).toEqual(["c", "d"]);
  });
  it("right: 末尾のタブなら空", () => {
    expect(tabsToClose(ids, "d", "right")).toEqual([]);
  });
  it("right: 先頭なら残り全部", () => {
    expect(tabsToClose(ids, "a", "right")).toEqual(["b", "c", "d"]);
  });
  it("all: 基点を含む全部", () => {
    expect(tabsToClose(ids, "c", "all")).toEqual(ids);
  });
  it("基点がペインに無ければ空 (どのモードでも)", () => {
    expect(tabsToClose(ids, "x", "others")).toEqual([]);
    expect(tabsToClose(ids, "x", "right")).toEqual([]);
    expect(tabsToClose(ids, "x", "all")).toEqual([]);
  });
  it("入力配列を破壊しない / all は別インスタンス", () => {
    const input = ["a", "b"];
    const out = tabsToClose(input, "a", "all");
    out.pop();
    expect(input).toEqual(["a", "b"]);
  });
});
