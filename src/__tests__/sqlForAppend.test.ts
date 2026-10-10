import { describe, expect, it } from "vitest";
import { sqlForAppend } from "../ai/errorExplain";
import { splitSqlStatements } from "../sqlScript";

function apply(doc: string, sql: string): string {
  const { from, text } = sqlForAppend(doc, sql);
  return doc.slice(0, from) + text;
}

describe("sqlForAppend (#1476)", () => {
  it("空のエディタには文だけを入れる", () => {
    expect(apply("", "SELECT 1")).toBe("SELECT 1;");
    expect(apply("  \n", "SELECT 1;")).toBe("  \nSELECT 1;");
  });

  it("末尾に ; が無い本文は ; で閉じてから足す", () => {
    expect(apply("SELECT 1", "SELECT 2")).toBe("SELECT 1;\n\nSELECT 2;");
  });

  it("末尾が ; ならそのまま足す", () => {
    expect(apply("SELECT 1;\n", "SELECT 2")).toBe("SELECT 1;\n\n\nSELECT 2;");
  });

  it("末尾が行コメントでも ; はコメントの手前に入る", () => {
    const out = apply("SELECT 1 -- memo", "SELECT 2");
    expect(out).toBe("SELECT 1; -- memo\n\nSELECT 2;");
  });

  it("2 件続けて挿入しても 2 文 + 元の 1 文になる", () => {
    let doc = "SELECT 0";
    doc = apply(doc, "SELECT 1");
    doc = apply(doc, "SELECT 2;");
    expect(splitSqlStatements(doc)).toHaveLength(3);
  });
});
