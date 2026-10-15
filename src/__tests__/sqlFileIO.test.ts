import { describe, expect, it } from "vitest";
import {
  parseTextEncodingId,
  convertLineEnding,
  detectLineEnding,
  parseLineEnding,
  planSaveAll,
  sqlSaveFileName,
  TEXT_ENCODING_OPTIONS,
  textEncodingLabel,
} from "../sqlFileIO";

describe("sqlSaveFileName", () => {
  it("appends .sql when the title has no recognized extension", () => {
    expect(sqlSaveFileName("Untitled Query")).toBe("Untitled Query.sql");
  });

  it("keeps an existing .sql extension as-is", () => {
    expect(sqlSaveFileName("report.sql")).toBe("report.sql");
  });

  it("keeps an existing .txt extension as-is (drag & drop of a .txt tab)", () => {
    expect(sqlSaveFileName("notes.txt")).toBe("notes.txt");
  });

  it("is case-insensitive when detecting an existing extension", () => {
    expect(sqlSaveFileName("REPORT.SQL")).toBe("REPORT.SQL");
  });

  it("trims surrounding whitespace before checking the extension", () => {
    expect(sqlSaveFileName("  report.sql  ")).toBe("report.sql");
  });

  it("falls back to query.sql for an empty or whitespace-only title", () => {
    expect(sqlSaveFileName("")).toBe("query.sql");
    expect(sqlSaveFileName("   ")).toBe("query.sql");
  });

  it("replaces path separators so the name stays a plain filename", () => {
    expect(sqlSaveFileName("a/b\\c")).toBe("a_b_c.sql");
  });

  it("does not treat an unrelated dotted title as already having an extension", () => {
    expect(sqlSaveFileName("v1.2 migration")).toBe("v1.2 migration.sql");
  });
});

describe("text encoding options (#1535)", () => {
  it("offers UTF-8 first and the Japanese legacy encodings", () => {
    expect(TEXT_ENCODING_OPTIONS[0].id).toBe("utf-8");
    const ids = TEXT_ENCODING_OPTIONS.map((o) => o.id);
    expect(ids).toEqual(expect.arrayContaining(["shift_jis", "euc-jp", "utf-16le", "utf-16be", "utf-8-bom"]));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("labels and parses identifiers", () => {
    expect(textEncodingLabel("shift_jis")).toBe("Shift_JIS");
    expect(textEncodingLabel("utf-8-bom")).toBe("UTF-8 (BOM)");
    expect(parseTextEncodingId("euc-jp")).toBe("euc-jp");
    expect(parseTextEncodingId("")).toBeNull();
    expect(parseTextEncodingId("latin1")).toBeNull();
  });
});

describe("planSaveAll (#1631)", () => {
  const sqls: Record<string, string> = {
    a: "SELECT 1",
    b: "  ",
    c: "SELECT 2",
    d: "SELECT 3",
    e: "SELECT 4",
  };
  const tabs = [
    { id: "a", kind: "query", title: "Report" },
    { id: "b", kind: "query", title: "Blank" },
    { id: "c", kind: "query", title: "Report" },
    { id: "d", kind: "table", title: "users" },
    { id: "e", kind: "query", title: "x.sql", fileEncoding: "shift_jis" as const },
  ];
  it("空・クエリ以外を除き、同名は連番にし、文字コードを維持する", () => {
    const plan = planSaveAll(tabs, (id) => sqls[id] ?? "");
    expect(plan.map((p) => p.fileName)).toEqual(["Report.sql", "Report (2).sql", "x.sql"]);
    expect(plan.map((p) => p.encoding)).toEqual(["utf-8", "utf-8", "shift_jis"]);
  });
  it("対象が無ければ空", () => {
    expect(planSaveAll([], () => "")).toEqual([]);
  });
});

describe("改行コード (#1627)", () => {
  it("convertLineEnding は LF / CRLF / CR の混在を正規化してから変換する", () => {
    expect(convertLineEnding("a\nb\r\nc\rd", "lf")).toBe("a\nb\nc\nd");
    expect(convertLineEnding("a\nb\r\nc\rd", "crlf")).toBe("a\r\nb\r\nc\r\nd");
    // 二重化しない。
    expect(convertLineEnding("a\r\nb", "crlf")).toBe("a\r\nb");
    expect(convertLineEnding("", "crlf")).toBe("");
    expect(convertLineEnding("no newline", "crlf")).toBe("no newline");
  });

  it("detectLineEnding は CRLF が LF 単独より多いときだけ crlf", () => {
    expect(detectLineEnding("a\r\nb\r\nc")).toBe("crlf");
    expect(detectLineEnding("a\nb\nc")).toBe("lf");
    expect(detectLineEnding("a\r\nb\nc\nd")).toBe("lf");
    expect(detectLineEnding("single line")).toBe("lf");
  });

  it("parseLineEnding は未知の値を null にする", () => {
    expect(parseLineEnding("crlf")).toBe("crlf");
    expect(parseLineEnding("lf")).toBe("lf");
    expect(parseLineEnding("cr")).toBeNull();
  });

  it("planSaveAll はタブが覚えている改行コードで変換する", () => {
    const plan = planSaveAll(
      [
        { id: "a", kind: "query", title: "a", fileLineEnding: "crlf" },
        { id: "b", kind: "query", title: "b" },
      ],
      () => "x\ny",
    );
    expect(plan.map((p) => p.sql)).toEqual(["x\r\ny", "x\ny"]);
    expect(plan.map((p) => p.lineEnding)).toEqual(["crlf", "lf"]);
  });
});
