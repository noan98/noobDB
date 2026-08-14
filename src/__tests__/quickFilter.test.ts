import { describe, expect, it } from "vitest";
import {
  clientQuickFilter,
  isNullCell,
  quickFilterValueLabel,
  serverQuickFilter,
  QUICK_FILTER_LABEL_MAX,
} from "../components/quickFilter";
import { buildServerFilterClause } from "../components/serverBrowse";

// セル右クリックのクイックフィルタ (#914)。既存のフィルタモデルへセル値を流し込む
// 変換だけを担う純ロジックなので、ここでは「どちらの経路でも同じ意味になるか」
// (特に NULL と除外の扱い) を固定する。

describe("isNullCell", () => {
  it("treats both null and undefined (missing cell) as NULL", () => {
    expect(isNullCell(null)).toBe(true);
    expect(isNullCell(undefined)).toBe(true);
    expect(isNullCell("")).toBe(false);
    expect(isNullCell(0)).toBe(false);
    expect(isNullCell(false)).toBe(false);
  });
});

describe("quickFilterValueLabel", () => {
  it("shows short values as-is", () => {
    expect(quickFilterValueLabel("alice")).toBe("alice");
    expect(quickFilterValueLabel(42)).toBe("42");
    expect(quickFilterValueLabel(false)).toBe("false");
  });

  it("collapses whitespace so a menu item stays on one line", () => {
    expect(quickFilterValueLabel("a\nb\tc")).toBe("a b c");
    expect(quickFilterValueLabel("  padded  ")).toBe("padded");
  });

  it("truncates long values with an ellipsis", () => {
    const long = "x".repeat(QUICK_FILTER_LABEL_MAX + 10);
    const label = quickFilterValueLabel(long);
    expect(label).toHaveLength(QUICK_FILTER_LABEL_MAX);
    expect(label.endsWith("…")).toBe(true);
  });

  it("returns an empty string for NULL (callers use a dedicated label)", () => {
    expect(quickFilterValueLabel(null)).toBe("");
  });
});

describe("serverQuickFilter (table tab / server-side WHERE)", () => {
  it("maps a value to = / <> keeping the raw text for dialect-aware quoting", () => {
    expect(serverQuickFilter("o'brien", "eq", false)).toEqual({
      op: "eq",
      value: "o'brien",
      numeric: false,
    });
    expect(serverQuickFilter("o'brien", "ne", false)).toEqual({
      op: "ne",
      value: "o'brien",
      numeric: false,
    });
  });

  it("maps NULL cells onto the IS NULL / IS NOT NULL operators", () => {
    expect(serverQuickFilter(null, "eq", false).op).toBe("isNull");
    expect(serverQuickFilter(null, "ne", true).op).toBe("isNotNull");
  });

  it("keeps the numeric flag so integer keys stay unquoted", () => {
    const f = serverQuickFilter(1234, "eq", true);
    expect(buildServerFilterClause("mysql", { column: "id", ...f })).toBe("`id` = 1234");
  });

  it("produces valid SQL for the exclusion path (quoted, escaped)", () => {
    const f = serverQuickFilter("o'brien", "ne", false);
    expect(buildServerFilterClause("postgres", { column: "name", ...f })).toBe(
      `"name" <> 'o''brien'`,
    );
  });

  it("round-trips NULL cells into IS NULL / IS NOT NULL clauses", () => {
    expect(
      buildServerFilterClause("sqlite", { column: "note", ...serverQuickFilter(null, "eq", false) }),
    ).toBe(`"note" IS NULL`);
    expect(
      buildServerFilterClause("sqlite", { column: "note", ...serverQuickFilter(null, "ne", false) }),
    ).toBe(`"note" IS NOT NULL`);
  });
});

describe("clientQuickFilter (query result tab / in-memory ColumnFilter)", () => {
  it("uses text equality operators for non-numeric columns", () => {
    expect(clientQuickFilter("alice", "eq", false)).toEqual({
      op: "equals",
      value: "alice",
      value2: "",
      nullMode: "any",
    });
    expect(clientQuickFilter("alice", "ne", false).op).toBe("notEquals");
  });

  it("uses numeric comparison operators for numeric columns", () => {
    expect(clientQuickFilter(42, "eq", true)).toEqual({
      op: "eq",
      value: "42",
      value2: "",
      nullMode: "any",
    });
    expect(clientQuickFilter(42, "ne", true).op).toBe("ne");
  });

  it("expresses NULL cells through the NULL gate instead of a value operand", () => {
    const only = clientQuickFilter(null, "eq", false);
    expect(only.nullMode).toBe("only");
    expect(only.value).toBe("");
    const exclude = clientQuickFilter(null, "ne", true);
    expect(exclude.nullMode).toBe("exclude");
    expect(exclude.value).toBe("");
  });
});
