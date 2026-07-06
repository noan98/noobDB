import { describe, it, expect } from "vitest";
import { quoteValue } from "../components/QueryBuilder";

// 修正7 の回帰テスト: バックスラッシュの二重化は MySQL のみ行うべきで、
// PostgreSQL (標準 standard_conforming_strings = on) と SQLite では
// バックスラッシュはただの文字なので二重化してはいけない。
describe("quoteValue", () => {
  it("doubles backslashes for MySQL", () => {
    expect(quoteValue("mysql", "C:\\temp")).toBe("'C:\\\\temp'");
  });

  it("does not double backslashes for PostgreSQL", () => {
    expect(quoteValue("postgres", "C:\\temp")).toBe("'C:\\temp'");
  });

  it("does not double backslashes for SQLite", () => {
    expect(quoteValue("sqlite", "C:\\temp")).toBe("'C:\\temp'");
  });

  it("still doubles single quotes for every driver", () => {
    expect(quoteValue("mysql", "O'Brien")).toBe("'O''Brien'");
    expect(quoteValue("postgres", "O'Brien")).toBe("'O''Brien'");
    expect(quoteValue("sqlite", "O'Brien")).toBe("'O''Brien'");
  });

  it("keeps existing NULL / numeric / boolean special-casing", () => {
    expect(quoteValue("mysql", "")).toBe("''");
    expect(quoteValue("mysql", "null")).toBe("NULL");
    expect(quoteValue("mysql", "42")).toBe("42");
    expect(quoteValue("mysql", "true")).toBe("TRUE");
    expect(quoteValue("sqlite", "true")).toBe("1");
    expect(quoteValue("sqlite", "false")).toBe("0");
  });
});
