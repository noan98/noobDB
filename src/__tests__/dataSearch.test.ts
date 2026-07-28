import { describe, expect, it } from "vitest";
import {
  buildColumnJumpSql,
  buildColumnPredicate,
  buildTableJumpSql,
  buildTableScanSql,
  DEFAULT_SCAN_ROW_THRESHOLD,
  escapeLikeWildcards,
  isNumericTerm,
  parseScanRow,
  searchTargetForDataType,
  searchTargetForKind,
  shouldSkipTableForScan,
  type ScanColumn,
} from "../components/dataSearch";

describe("searchTargetForKind / searchTargetForDataType (#748)", () => {
  it("classifies text-like kinds as text", () => {
    expect(searchTargetForKind("string")).toBe("text");
    expect(searchTargetForKind("enum")).toBe("text");
    expect(searchTargetForKind("json")).toBe("text");
  });

  it("classifies numeric kinds as numeric", () => {
    expect(searchTargetForKind("number")).toBe("numeric");
    expect(searchTargetForKind("decimal")).toBe("numeric");
  });

  it("excludes bool/date/time/binary by default", () => {
    expect(searchTargetForKind("bool")).toBe("excluded");
    expect(searchTargetForKind("date")).toBe("excluded");
    expect(searchTargetForKind("time")).toBe("excluded");
    expect(searchTargetForKind("binary")).toBe("excluded");
  });

  it("resolves directly from a raw data_type string", () => {
    expect(searchTargetForDataType("VARCHAR")).toBe("text");
    expect(searchTargetForDataType("INT")).toBe("numeric");
    expect(searchTargetForDataType("BLOB")).toBe("excluded");
  });
});

describe("isNumericTerm", () => {
  it("accepts integers, decimals and exponents", () => {
    expect(isNumericTerm("42")).toBe(true);
    expect(isNumericTerm("-3.14")).toBe(true);
    expect(isNumericTerm("1e10")).toBe(true);
    expect(isNumericTerm(" 7 ")).toBe(true);
  });

  it("rejects non-numeric text", () => {
    expect(isNumericTerm("abc")).toBe(false);
    expect(isNumericTerm("42abc")).toBe(false);
    expect(isNumericTerm("")).toBe(false);
  });
});

describe("escapeLikeWildcards", () => {
  it("escapes %, _ and backslash itself", () => {
    expect(escapeLikeWildcards("50%_off")).toBe("50\\%\\_off");
    expect(escapeLikeWildcards("a\\b")).toBe("a\\\\b");
  });

  it("leaves ordinary text unchanged", () => {
    expect(escapeLikeWildcards("hello world")).toBe("hello world");
  });
});

describe("buildColumnPredicate", () => {
  it("builds an equality predicate for exact mode (text column)", () => {
    expect(buildColumnPredicate("mysql", "name", "string", "Alice", "exact")).toBe(
      "`name` = 'Alice'",
    );
  });

  it("builds a contains LIKE predicate with an explicit ESCAPE clause", () => {
    expect(buildColumnPredicate("mysql", "name", "string", "ali", "contains")).toBe(
      "`name` LIKE '%ali%' ESCAPE '\\\\'",
    );
  });

  it("builds a prefix LIKE predicate", () => {
    expect(buildColumnPredicate("postgres", "name", "string", "ali", "prefix")).toBe(
      '"name" LIKE \'ali%\' ESCAPE \'\\\'',
    );
  });

  it("escapes wildcards in the search term before quoting", () => {
    expect(buildColumnPredicate("mysql", "code", "string", "50%_off", "contains")).toBe(
      "`code` LIKE '%50\\\\%\\\\_off%' ESCAPE '\\\\'",
    );
  });

  it("uses equality for numeric columns when the term is numeric, ignoring match mode", () => {
    expect(buildColumnPredicate("mysql", "age", "number", "42", "contains")).toBe("`age` = 42");
    expect(buildColumnPredicate("mysql", "age", "decimal", "42", "prefix")).toBe("`age` = 42");
  });

  it("returns null for numeric columns when the term isn't numeric", () => {
    expect(buildColumnPredicate("mysql", "age", "number", "abc", "exact")).toBeNull();
  });

  it("returns null for excluded kinds regardless of term", () => {
    expect(buildColumnPredicate("mysql", "photo", "binary", "abc", "exact")).toBeNull();
    expect(buildColumnPredicate("mysql", "active", "bool", "1", "exact")).toBeNull();
    expect(buildColumnPredicate("mysql", "created_at", "date", "2024", "contains")).toBeNull();
  });

  it("does not double backslashes for postgres/sqlite string literals", () => {
    expect(buildColumnPredicate("postgres", "name", "string", "a\\b", "exact")).toBe(
      "\"name\" = 'a\\b'",
    );
    expect(buildColumnPredicate("sqlite", "name", "string", "a\\b", "exact")).toBe(
      '"name" = \'a\\b\'',
    );
  });
});

describe("buildTableScanSql", () => {
  const columns: ScanColumn[] = [
    { name: "name", dataType: "VARCHAR" },
    { name: "age", dataType: "INT" },
    { name: "photo", dataType: "BLOB" },
  ];

  it("builds a single-query SUM(CASE) scan over searchable columns only", () => {
    const result = buildTableScanSql("mysql", "shop", "users", columns, "ali", "contains");
    expect(result).not.toBeNull();
    expect(result?.columns).toEqual(["name"]);
    expect(result?.sql).toBe(
      "SELECT SUM(CASE WHEN `name` LIKE '%ali%' ESCAPE '\\\\' THEN 1 ELSE 0 END) AS `name` FROM `shop`.`users`",
    );
  });

  it("includes the numeric column too when the term is numeric", () => {
    const result = buildTableScanSql("mysql", "shop", "users", columns, "42", "contains");
    expect(result?.columns).toEqual(["name", "age"]);
  });

  it("returns null when no column qualifies (e.g. all-BLOB table + non-numeric term)", () => {
    const blobOnly: ScanColumn[] = [{ name: "photo", dataType: "BLOB" }];
    expect(buildTableScanSql("mysql", "shop", "assets", blobOnly, "abc", "contains")).toBeNull();
  });

  it("omits the database qualifier for SQLite", () => {
    const result = buildTableScanSql("sqlite", "main", "users", columns, "ali", "contains");
    expect(result?.sql).toContain('FROM "users"');
  });
});

describe("buildColumnJumpSql", () => {
  it("builds a single-column filtered SELECT for the clicked hit", () => {
    expect(
      buildColumnJumpSql("mysql", "shop", "users", "name", "VARCHAR", "ali", "contains"),
    ).toBe("SELECT * FROM `shop`.`users` WHERE `name` LIKE '%ali%' ESCAPE '\\\\'");
  });

  it("returns null when the column/term combination doesn't qualify", () => {
    expect(
      buildColumnJumpSql("mysql", "shop", "users", "age", "INT", "abc", "exact"),
    ).toBeNull();
  });
});

describe("buildTableJumpSql", () => {
  const columns: ScanColumn[] = [
    { name: "name", dataType: "VARCHAR" },
    { name: "email", dataType: "VARCHAR" },
    { name: "age", dataType: "INT" },
  ];

  it("ORs together the predicates for every hit column", () => {
    expect(
      buildTableJumpSql("mysql", "shop", "users", columns, ["name", "email"], "ali", "contains"),
    ).toBe(
      "SELECT * FROM `shop`.`users` WHERE (`name` LIKE '%ali%' ESCAPE '\\\\' OR `email` LIKE '%ali%' ESCAPE '\\\\')",
    );
  });

  it("returns null when hitColumns doesn't intersect any searchable column", () => {
    expect(
      buildTableJumpSql("mysql", "shop", "users", columns, ["age"], "abc", "contains"),
    ).toBeNull();
  });
});

describe("shouldSkipTableForScan", () => {
  it("skips tables whose estimate exceeds the threshold", () => {
    expect(shouldSkipTableForScan(1_000_000, DEFAULT_SCAN_ROW_THRESHOLD)).toBe(true);
  });

  it("does not skip tables at or under the threshold", () => {
    expect(shouldSkipTableForScan(DEFAULT_SCAN_ROW_THRESHOLD, DEFAULT_SCAN_ROW_THRESHOLD)).toBe(
      false,
    );
    expect(shouldSkipTableForScan(10, DEFAULT_SCAN_ROW_THRESHOLD)).toBe(false);
  });

  it("never skips when the estimate is unknown (null)", () => {
    expect(shouldSkipTableForScan(null, 1)).toBe(false);
  });
});

describe("parseScanRow", () => {
  it("pairs column names with their positional counts, dropping zero hits", () => {
    expect(parseScanRow(["name", "age"], [3, 0])).toEqual([{ column: "name", count: 3 }]);
  });

  it("treats NULL (no rows scanned) as zero", () => {
    expect(parseScanRow(["name"], [null])).toEqual([]);
  });

  it("coerces string-encoded counts (some drivers return SUM as text)", () => {
    expect(parseScanRow(["name"], ["5"])).toEqual([{ column: "name", count: 5 }]);
  });
});
