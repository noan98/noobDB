import { describe, expect, it } from "vitest";
import { columnInsertText, qualifiedColumnInsertText } from "../schemaInsertText";

describe("columnInsertText", () => {
  it("素の識別子はクォートしない", () => {
    expect(columnInsertText("mysql", "id")).toBe("id");
    expect(columnInsertText("postgres", "user_id")).toBe("user_id");
    expect(columnInsertText("sqlite", "Name")).toBe("Name");
  });

  it("PostgreSQL は大文字を含む名前をクォートする (MySQL / SQLite は不要)", () => {
    expect(columnInsertText("postgres", "Id")).toBe('"Id"');
    expect(columnInsertText("mysql", "Id")).toBe("Id");
  });

  it("予約語・空白・記号を含む名前をドライバ別の引用符で囲む", () => {
    expect(columnInsertText("mysql", "order")).toBe("`order`");
    expect(columnInsertText("postgres", "select")).toBe('"select"');
    expect(columnInsertText("sqlite", "order by")).toBe('"order by"');
    expect(columnInsertText("mysql", "a`b")).toBe("`a``b`");
    expect(columnInsertText("postgres", 'a"b')).toBe('"a""b"');
  });
});

describe("qualifiedColumnInsertText", () => {
  it("素の名前は 表.列 のまま", () => {
    expect(qualifiedColumnInsertText("mysql", "users", "id")).toBe("users.id");
    expect(qualifiedColumnInsertText("postgres", "users", "id")).toBe("users.id");
  });

  it("PostgreSQL の大文字を含む表・列は双方クォートする", () => {
    expect(qualifiedColumnInsertText("postgres", "Users", "Id")).toBe('"Users"."Id"');
  });

  it("空白を含む表名や予約語の列だけをクォートする", () => {
    expect(qualifiedColumnInsertText("mysql", "my table", "id")).toBe("`my table`.id");
    expect(qualifiedColumnInsertText("sqlite", "t", "order")).toBe('t."order"');
  });

  it("クォート文字をエスケープする", () => {
    expect(qualifiedColumnInsertText("mysql", "a`t", "b`c")).toBe("`a``t`.`b``c`");
    expect(qualifiedColumnInsertText("postgres", 'a"t', "c")).toBe('"a""t".c');
  });
});
