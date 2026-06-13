import { describe, expect, it } from "vitest";
import {
  selectionSummary,
  columnStats,
  buildColumnStatsSql,
  parseFullColumnStats,
  isNumericStatsKind,
} from "../components/gridStats";
import type { CellValue } from "../api/tauri";

describe("selectionSummary (#523)", () => {
  it("aggregates numeric cells", () => {
    const s = selectionSummary([1, 2, 3, 4]);
    expect(s.count).toBe(4);
    expect(s.nonNullCount).toBe(4);
    expect(s.numericCount).toBe(4);
    expect(s.sum).toBe(10);
    expect(s.avg).toBe(2.5);
    expect(s.min).toBe(1);
    expect(s.max).toBe(4);
  });

  it("skips NULL but still counts them, and aggregates only numerics", () => {
    const cells: CellValue[] = [10, null, 20, null, 30];
    const s = selectionSummary(cells);
    expect(s.count).toBe(5);
    expect(s.nonNullCount).toBe(3);
    expect(s.numericCount).toBe(3);
    expect(s.sum).toBe(60);
    expect(s.avg).toBe(20);
    expect(s.min).toBe(10);
    expect(s.max).toBe(30);
  });

  it("picks up numeric string literals but ignores non-numeric text", () => {
    const cells: CellValue[] = ["5", "abc", "  7  ", "x"];
    const s = selectionSummary(cells);
    expect(s.count).toBe(4);
    expect(s.nonNullCount).toBe(4);
    expect(s.numericCount).toBe(2);
    expect(s.sum).toBe(12);
    expect(s.avg).toBe(6);
  });

  it("returns null numeric stats when nothing is numeric", () => {
    const s = selectionSummary(["a", "b", null]);
    expect(s.count).toBe(3);
    expect(s.nonNullCount).toBe(2);
    expect(s.numericCount).toBe(0);
    expect(s.sum).toBeNull();
    expect(s.avg).toBeNull();
    expect(s.min).toBeNull();
    expect(s.max).toBeNull();
  });

  it("handles negatives and floats", () => {
    const s = selectionSummary([-1.5, 2.5, -3]);
    expect(s.sum).toBeCloseTo(-2);
    expect(s.min).toBe(-3);
    expect(s.max).toBe(2.5);
    expect(s.avg).toBeCloseTo(-2 / 3);
  });

  it("empty selection yields zero counts and null stats", () => {
    const s = selectionSummary([]);
    expect(s.count).toBe(0);
    expect(s.numericCount).toBe(0);
    expect(s.sum).toBeNull();
  });
});

describe("columnStats (#524, in-memory)", () => {
  it("computes count / null / distinct and numeric range for a number column", () => {
    const values: CellValue[] = [1, 2, 2, 3, null];
    const s = columnStats(values, "number");
    expect(s.count).toBe(5);
    expect(s.nullCount).toBe(1);
    expect(s.nonNullCount).toBe(4);
    expect(s.distinctCount).toBe(3); // 1, 2, 3
    expect(s.numericCount).toBe(4);
    expect(s.sum).toBe(8);
    expect(s.avg).toBe(2);
    expect(s.min).toBe(1);
    expect(s.max).toBe(3);
  });

  it("computes string length facets and mode for a string column", () => {
    const values: CellValue[] = ["aa", "bbb", "aa", "c", null];
    const s = columnStats(values, "string");
    expect(s.nonNullCount).toBe(4);
    expect(s.distinctCount).toBe(3); // aa, bbb, c
    expect(s.minLen).toBe(1); // "c"
    expect(s.maxLen).toBe(3); // "bbb"
    expect(s.mode).toEqual({ value: "aa", count: 2 });
    // a pure string column has no numeric aggregates
    expect(s.numericCount).toBe(0);
    expect(s.avg).toBeNull();
  });

  it("treats numeric and string forms of the same value as one distinct key", () => {
    const values: CellValue[] = [1, "1", 2];
    const s = columnStats(values, "number");
    expect(s.distinctCount).toBe(2); // "1" and "2"
    expect(s.numericCount).toBe(3);
  });

  it("all-null column reports null facets", () => {
    const s = columnStats([null, null], "string");
    expect(s.count).toBe(2);
    expect(s.nullCount).toBe(2);
    expect(s.nonNullCount).toBe(0);
    expect(s.distinctCount).toBe(0);
    expect(s.minLen).toBeNull();
    expect(s.maxLen).toBeNull();
    expect(s.mode).toBeNull();
  });

  it("empty column is well-defined", () => {
    const s = columnStats([], "number");
    expect(s.count).toBe(0);
    expect(s.distinctCount).toBe(0);
    expect(s.min).toBeNull();
  });
});

describe("buildColumnStatsSql (#524)", () => {
  it("quotes identifiers with backticks and qualifies db.table for MySQL numeric", () => {
    const sql = buildColumnStatsSql({
      driver: "mysql",
      database: "shop",
      table: "orders",
      column: "amount",
      kind: "decimal",
    });
    expect(sql).toBe(
      "SELECT COUNT(*) AS total_count, COUNT(`amount`) AS non_null_count, " +
        "COUNT(DISTINCT `amount`) AS distinct_count, MIN(`amount`) AS min_value, " +
        "MAX(`amount`) AS max_value, AVG(`amount`) AS avg_value, SUM(`amount`) AS sum_value " +
        "FROM `shop`.`orders`",
    );
  });

  it("uses double quotes for Postgres and omits AVG/SUM for non-numeric", () => {
    const sql = buildColumnStatsSql({
      driver: "postgres",
      database: "public",
      table: "users",
      column: "name",
      kind: "string",
    });
    expect(sql).toBe(
      'SELECT COUNT(*) AS total_count, COUNT("name") AS non_null_count, ' +
        'COUNT(DISTINCT "name") AS distinct_count, MIN("name") AS min_value, ' +
        'MAX("name") AS max_value FROM "public"."users"',
    );
    expect(sql).not.toContain("AVG");
    expect(sql).not.toContain("SUM");
  });

  it("does not qualify with a database for SQLite", () => {
    const sql = buildColumnStatsSql({
      driver: "sqlite",
      database: "main",
      table: "t",
      column: "v",
      kind: "number",
    });
    expect(sql).toContain('FROM "t"');
    expect(sql).not.toContain('"main"');
  });

  it("escapes embedded quote characters in identifiers", () => {
    const sql = buildColumnStatsSql({
      driver: "mysql",
      database: null,
      table: "we`ird",
      column: "c`ol",
      kind: "string",
    });
    expect(sql).toContain("`c``ol`");
    expect(sql).toContain("FROM `we``ird`");
  });
});

describe("parseFullColumnStats (#524)", () => {
  it("reads numeric aggregate rows by position", () => {
    const row: CellValue[] = [100, 90, 42, 1, 999, 50.5, 4545];
    const s = parseFullColumnStats(row, true);
    expect(s.total).toBe(100);
    expect(s.nonNull).toBe(90);
    expect(s.nullCount).toBe(10);
    expect(s.distinct).toBe(42);
    expect(s.min).toBe(1);
    expect(s.max).toBe(999);
    expect(s.avg).toBe(50.5);
    expect(s.sum).toBe(4545);
  });

  it("leaves avg/sum null for non-numeric columns", () => {
    const row: CellValue[] = [10, 8, 5, "apple", "pear"];
    const s = parseFullColumnStats(row, false);
    expect(s.nullCount).toBe(2);
    expect(s.distinct).toBe(5);
    expect(s.min).toBe("apple");
    expect(s.max).toBe("pear");
    expect(s.avg).toBeNull();
    expect(s.sum).toBeNull();
  });

  it("coerces string-encoded counts (drivers may return BIGINT as text)", () => {
    const row: CellValue[] = ["100", "90", "42", "1", "999", "50.5", "4545"];
    const s = parseFullColumnStats(row, true);
    expect(s.total).toBe(100);
    expect(s.avg).toBe(50.5);
  });
});

describe("isNumericStatsKind", () => {
  it("treats number and decimal as numeric", () => {
    expect(isNumericStatsKind("number")).toBe(true);
    expect(isNumericStatsKind("decimal")).toBe(true);
    expect(isNumericStatsKind("string")).toBe(false);
    expect(isNumericStatsKind("date")).toBe(false);
  });
});
