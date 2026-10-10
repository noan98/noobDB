import { describe, expect, it } from "vitest";
import { duplicateSpec, tabsToClose } from "../tabMenuActions";

describe("tabsToClose", () => {
  const ids = ["a", "b", "c", "d"];
  it("others は対象以外すべて", () => {
    expect(tabsToClose(ids, "b", "others")).toEqual(["a", "c", "d"]);
  });
  it("right は対象より後ろだけ (末尾なら空)", () => {
    expect(tabsToClose(ids, "b", "right")).toEqual(["c", "d"]);
    expect(tabsToClose(ids, "d", "right")).toEqual([]);
    expect(tabsToClose(ids, "a", "right")).toEqual(["b", "c", "d"]);
  });
  it("all は対象を含む全部で、元配列を共有しない", () => {
    const r = tabsToClose(ids, "c", "all");
    expect(r).toEqual(ids);
    expect(r).not.toBe(ids);
  });
  it("単一タブ: others は空、all は自身", () => {
    expect(tabsToClose(["a"], "a", "others")).toEqual([]);
    expect(tabsToClose(["a"], "a", "all")).toEqual(["a"]);
  });
  it("ペインに無い ID では何も閉じない", () => {
    expect(tabsToClose(ids, "x", "all")).toEqual([]);
    expect(tabsToClose(ids, "x", "others")).toEqual([]);
    expect(tabsToClose(ids, "x", "right")).toEqual([]);
  });
});

describe("duplicateSpec", () => {
  it("query は SQL とタイトルを引き継ぐ", () => {
    expect(duplicateSpec({ kind: "query", title: "q", sql: "SELECT 1", lastExecutedSql: "SELECT 1" })).toEqual({
      kind: "query",
      title: "q",
      titleManual: false,
      sql: "SELECT 1",
      lastExecutedSql: "SELECT 1",
    });
  });
  it("dirty な元タブは lastExecutedSql を引き継ぎ、複製も dirty のまま", () => {
    const r = duplicateSpec({ kind: "query", title: "q", sql: "SELECT 2", lastExecutedSql: "SELECT 1" });
    expect(r.sql).toBe("SELECT 2");
    expect(r.lastExecutedSql).toBe("SELECT 1");
  });
  it("手動リネーム済みのフラグを複製にも引き継ぐ (#1390)", () => {
    const r = duplicateSpec({ kind: "query", title: "月次集計", titleManual: true, sql: "SELECT 1", lastExecutedSql: "" });
    expect(r.titleManual).toBe(true);
    expect(r.title).toBe("月次集計");
  });
  it("explain は query タブになり、計画用タイトルは引き継がない", () => {
    expect(
      duplicateSpec({ kind: "explain", title: "EXPLAIN: x", titleManual: true, sql: "SELECT 1", lastExecutedSql: "SELECT 1" }),
    ).toEqual({ kind: "query", title: null, titleManual: false, sql: "SELECT 1", lastExecutedSql: "SELECT 1" });
  });
  it("table は query タブになる", () => {
    expect(duplicateSpec({ kind: "table", title: "users", sql: "SELECT * FROM users", lastExecutedSql: "SELECT * FROM users" })).toEqual({
      kind: "query",
      title: "users",
      titleManual: false,
      sql: "SELECT * FROM users",
      lastExecutedSql: "SELECT * FROM users",
    });
  });
});
