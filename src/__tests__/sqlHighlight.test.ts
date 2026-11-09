import { describe, expect, it } from "vitest";
import { sqlHighlightLines, sqlHighlightSegments } from "../components/sqlHighlight";

describe("sqlHighlightSegments", () => {
  it("連結すると元の SQL に戻り、改行も保つ", () => {
    const sql = "SELECT\n  id, 'a' -- c\nFROM t\nWHERE n = 1";
    for (const driver of ["mysql", "postgres", "sqlite"]) {
      expect(
        sqlHighlightSegments(sql, driver)
          .map((s) => s.text)
          .join(""),
      ).toBe(sql);
    }
  });

  it("キーワード・文字列・数値・コメントを分類する", () => {
    const segs = sqlHighlightSegments("SELECT 'x', 42 -- note\nFROM t", "mysql");
    const kindOf = (text: string) => segs.find((s) => s.text.trim() === text)?.kind;
    expect(kindOf("SELECT")).toBe("keyword");
    expect(kindOf("FROM")).toBe("keyword");
    expect(kindOf("'x'")).toBe("string");
    expect(kindOf("42")).toBe("number");
    expect(kindOf("-- note")).toBe("comment");
    expect(kindOf("t")).toBeNull();
  });
});

describe("sqlHighlightLines (#2178)", () => {
  it("行ごとに分け、連結すると元の各行に戻る", () => {
    const lines = ["SELECT 1", "", "  FROM t -- c"];
    const out = sqlHighlightLines(lines, "mysql");
    expect(out).not.toBeNull();
    expect(out?.map((segs) => segs.map((s) => s.text).join(""))).toEqual(lines);
    expect(out?.[0]?.some((s) => s.kind === "keyword")).toBe(true);
  });

  it("行内に改行がある / 大きすぎるときは null (単色フォールバック)", () => {
    expect(sqlHighlightLines(["a\nb"], "mysql")).toBeNull();
    expect(
      sqlHighlightLines(
        Array.from({ length: 10_001 }, () => "x"),
        "mysql",
      ),
    ).toBeNull();
  });
});
