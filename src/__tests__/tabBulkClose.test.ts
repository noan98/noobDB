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

import { duplicateTabSpec } from "../tabBulkClose";

describe("duplicateTabSpec", () => {
  it("query: タイトル・DB・SQL を引き継ぎ未実行扱い", () => {
    expect(duplicateTabSpec({ kind: "query", title: "q1", database: "db" }, "SELECT 1")).toEqual({
      kind: "query", title: "q1", titleManual: false, sql: "SELECT 1", database: "db", lastExecutedSql: "",
    });
  });
  it("query: 手動命名は引き継ぎ、自動名は自動のまま (#1390)", () => {
    expect(duplicateTabSpec({ kind: "query", title: "mine", titleManual: true }, "x").titleManual).toBe(true);
    expect(duplicateTabSpec({ kind: "query", title: "SELECT 1", titleManual: false }, "x").titleManual).toBe(false);
  });
  it("table: クエリタブとして複製しテーブル名タイトルを引き継ぐ", () => {
    const s = duplicateTabSpec({ kind: "table", title: "users", database: "app" }, "SELECT * FROM users");
    expect(s.kind).toBe("query");
    expect(s.title).toBe("users");
    expect(s.titleManual).toBe(false);
  });
  it("explain: クエリタブになりタイトルは引き継がない", () => {
    const s = duplicateTabSpec({ kind: "explain", title: "Explain: x" }, "EXPLAIN SELECT 1");
    expect(s).toEqual({
      kind: "query", title: null, titleManual: false, sql: "EXPLAIN SELECT 1", database: undefined, lastExecutedSql: "",
    });
  });
});
