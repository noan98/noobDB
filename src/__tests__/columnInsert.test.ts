import { describe, expect, it } from "vitest";
import { columnInsertText, qualifiedColumnInsertText } from "../components/columnInsert";

describe("columnInsertText", () => {
  it("通常の識別子はクォートしない", () => {
    for (const d of ["mysql", "postgres", "sqlite"]) {
      expect(columnInsertText(d, "user_id")).toBe("user_id");
    }
  });

  it("予約語はドライバ別の文字でクォートする", () => {
    expect(columnInsertText("mysql", "order")).toBe("`order`");
    expect(columnInsertText("postgres", "order")).toBe('"order"');
    expect(columnInsertText("sqlite", "order")).toBe('"order"');
  });

  it("PostgreSQL は大文字を含む名前をクォートする (MySQL / SQLite は不要)", () => {
    expect(columnInsertText("postgres", "UserId")).toBe('"UserId"');
    expect(columnInsertText("mysql", "UserId")).toBe("UserId");
    expect(columnInsertText("sqlite", "UserId")).toBe("UserId");
  });

  it("空白・記号・日本語を含む名前はクォートし、内部のクォート文字をエスケープする", () => {
    expect(columnInsertText("mysql", "my col")).toBe("`my col`");
    expect(columnInsertText("mysql", "a`b")).toBe("`a``b`");
    expect(columnInsertText("postgres", 'a"b')).toBe('"a""b"');
    expect(columnInsertText("sqlite", "名前")).toBe('"名前"');
    expect(columnInsertText("mysql", "1st")).toBe("`1st`");
  });
});

describe("qualifiedColumnInsertText", () => {
  it("表.列 を組み立てる (データベース名は含めない)", () => {
    expect(qualifiedColumnInsertText("mysql", "users", "id")).toBe("users.id");
  });

  it("表・列それぞれ独立にクォートの要否を判定する", () => {
    expect(qualifiedColumnInsertText("mysql", "order", "key")).toBe("`order`.`key`");
    expect(qualifiedColumnInsertText("postgres", "Users", "id")).toBe('"Users".id');
    expect(qualifiedColumnInsertText("sqlite", "t", "my col")).toBe('t."my col"');
  });
});
