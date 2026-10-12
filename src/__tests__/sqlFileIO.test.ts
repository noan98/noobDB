import { describe, expect, it } from "vitest";
import { parseTextEncodingId, sqlSaveFileName, TEXT_ENCODING_OPTIONS, textEncodingLabel } from "../sqlFileIO";

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
