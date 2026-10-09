import { describe, expect, it } from "vitest";
import { columnInsertText, qualifiedColumnInsertText } from "../schemaInsertText";

describe("columnInsertText", () => {
  it("MySQL はバッククォート、PostgreSQL / SQLite はダブルクォートで囲む", () => {
    expect(columnInsertText("mysql", "id")).toBe("`id`");
    expect(columnInsertText("postgres", "id")).toBe('"id"');
    expect(columnInsertText("sqlite", "id")).toBe('"id"');
  });

  it("クォート文字・空白・予約語を含む列名をエスケープする", () => {
    expect(columnInsertText("mysql", "a`b")).toBe("`a``b`");
    expect(columnInsertText("postgres", 'a"b')).toBe('"a""b"');
    expect(columnInsertText("sqlite", "order by")).toBe('"order by"');
  });

  it("未知のドライバは MySQL 扱い", () => {
    expect(columnInsertText("weird", "c")).toBe("`c`");
  });
});

describe("qualifiedColumnInsertText", () => {
  it("表.列 の形にし、双方をクォートする", () => {
    expect(qualifiedColumnInsertText("mysql", "users", "id")).toBe("`users`.`id`");
    expect(qualifiedColumnInsertText("postgres", "users", "id")).toBe('"users"."id"');
    expect(qualifiedColumnInsertText("sqlite", "t", "c")).toBe('"t"."c"');
  });

  it("表名・列名それぞれのクォート文字をエスケープする", () => {
    expect(qualifiedColumnInsertText("mysql", "a`t", "b`c")).toBe("`a``t`.`b``c`");
  });
});
