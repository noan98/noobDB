import { describe, expect, it } from "vitest";
import { sqlSaveFileName } from "../sqlFileIO";

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
