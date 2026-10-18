import { describe, expect, it } from "vitest";
import { tabsToClose } from "../tabBulkClose";

const ids = ["a", "b", "c", "d"];

describe("tabsToClose: ピン留めタブの除外 (#1486)", () => {
  const ids = ["p1", "a", "b", "c"];
  const pinned = new Set(["p1", "b"]);

  it("others / left / right / all のどれもピン留めタブを含めない", () => {
    expect(tabsToClose(ids, "a", "others", pinned)).toEqual(["c"]);
    expect(tabsToClose(ids, "c", "left", pinned)).toEqual(["a"]);
    expect(tabsToClose(ids, "p1", "right", pinned)).toEqual(["a", "c"]);
    expect(tabsToClose(ids, "a", "all", pinned)).toEqual(["a", "c"]);
  });

  it("基点自身がピン留めでも all では閉じない", () => {
    expect(tabsToClose(ids, "p1", "all", pinned)).toEqual(["a", "c"]);
  });

  it("ピン無し (未指定 / 空) は従来どおり", () => {
    expect(tabsToClose(ids, "a", "others")).toEqual(["p1", "b", "c"]);
    expect(tabsToClose(ids, "a", "others", new Set())).toEqual(["p1", "b", "c"]);
  });
});

describe("tabsToClose", () => {
  it("others: 基点以外すべて", () => {
    expect(tabsToClose(ids, "b", "others")).toEqual(["a", "c", "d"]);
  });
  it("others: 唯一のタブなら空", () => {
    expect(tabsToClose(["a"], "a", "others")).toEqual([]);
  });
  it("left は基点より左のタブだけを返す", () => {
    expect(tabsToClose(ids, "c", "left")).toEqual(["a", "b"]);
    expect(tabsToClose(ids, "a", "left")).toEqual([]);
    expect(tabsToClose(ids, "x", "left")).toEqual([]);
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
      kind: "query",
      title: "q1",
      titleManual: false,
      sql: "SELECT 1",
      database: "db",
      lastExecutedSql: "",
    });
  });
  it("手動リネーム済みのフラグを複製にも引き継ぐ (#1390)", () => {
    const s = duplicateTabSpec({ kind: "query", title: "月次集計", titleManual: true }, "SELECT 1");
    expect(s.titleManual).toBe(true);
    expect(s.title).toBe("月次集計");
  });
  it("explain は titleManual が立っていても引き継がない (#1390)", () => {
    expect(
      duplicateTabSpec({ kind: "explain", title: "x", titleManual: true }, "EXPLAIN SELECT 1").titleManual,
    ).toBe(false);
  });
  it("table: クエリタブとして複製しテーブル名タイトルを引き継ぐ", () => {
    const s = duplicateTabSpec({ kind: "table", title: "users", database: "app" }, "SELECT * FROM users");
    expect(s.kind).toBe("query");
    expect(s.title).toBe("users");
  });
  it("explain: クエリタブになりタイトルは引き継がない", () => {
    const s = duplicateTabSpec({ kind: "explain", title: "Explain: x" }, "EXPLAIN SELECT 1");
    expect(s).toEqual({
      kind: "query",
      title: null,
      titleManual: false,
      sql: "EXPLAIN SELECT 1",
      database: undefined,
      lastExecutedSql: "",
    });
  });
});
