import { describe, expect, it, vi } from "vitest";
import { buildSuggestionCountSql, checkSuggestionSql } from "../ai/suggestionCheck";

describe("buildSuggestionCountSql (#1536)", () => {
  it("SELECT をサブクエリに包んで COUNT する (末尾の ; は落とす)", () => {
    expect(buildSuggestionCountSql("SELECT * FROM orders WHERE amount < 0;", "mysql")).toBe(
      "SELECT COUNT(*) FROM (\nSELECT * FROM orders WHERE amount < 0\n) AS suggestion_check",
    );
    expect(buildSuggestionCountSql("  WITH a AS (SELECT 1) SELECT * FROM a ;; ", "postgres")).toContain(
      "WITH a AS (SELECT 1) SELECT * FROM a\n)",
    );
  });
  it("書き込み・DDL・空文は検証しない", () => {
    expect(buildSuggestionCountSql("DELETE FROM t", "mysql")).toBeNull();
    expect(buildSuggestionCountSql("UPDATE t SET a = 1", "sqlite")).toBeNull();
    expect(buildSuggestionCountSql("DROP TABLE t", "postgres")).toBeNull();
    expect(buildSuggestionCountSql("   ;  ", "mysql")).toBeNull();
    expect(buildSuggestionCountSql("SHOW TABLES", "mysql")).toBeNull();
  });
});

describe("checkSuggestionSql", () => {
  it("件数を返す / 実行エラーを error にする / 検証できない形は skipped", async () => {
    const ok = vi.fn().mockResolvedValue({ rows: [[3]] });
    expect(await checkSuggestionSql(ok, "SELECT 1", "mysql")).toEqual({ status: "ok", count: 3 });
    expect(ok).toHaveBeenCalledWith("SELECT COUNT(*) FROM (\nSELECT 1\n) AS suggestion_check");

    const bad = vi.fn().mockRejectedValue(new Error("Unknown column 'x'"));
    const r = await checkSuggestionSql(bad, "SELECT x FROM t", "mysql");
    expect(r.status).toBe("error");

    const never = vi.fn();
    expect(await checkSuggestionSql(never, "DELETE FROM t", "mysql")).toEqual({ status: "skipped" });
    expect(never).not.toHaveBeenCalled();
  });
});
