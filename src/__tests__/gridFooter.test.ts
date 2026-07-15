import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  availableFooterFns,
  computeFooterCell,
  defaultFooterFn,
  footerCellForColumn,
  footerStateKeyFrom,
  readStoredFooterState,
  resolveFooterFn,
  writeStoredFooterState,
  type FooterAggFn,
} from "../components/gridFooter";
import { columnStats } from "../components/gridStats";
import type { CellValue } from "../api/tauri";

describe("availableFooterFns / defaultFooterFn (#645)", () => {
  it("offers numeric aggregates for numeric kinds", () => {
    const fns = availableFooterFns("number");
    expect(fns).toContain("sum");
    expect(fns).toContain("avg");
    expect(fns).toContain("min");
    expect(fns).toContain("max");
    expect(fns).toContain("count");
    expect(fns).toContain("none");
    expect(defaultFooterFn("number")).toBe("sum");
    expect(defaultFooterFn("decimal")).toBe("sum");
  });

  it("omits sum/avg/min/max for non-numeric kinds and defaults to count", () => {
    const fns = availableFooterFns("string");
    expect(fns).not.toContain("sum");
    expect(fns).not.toContain("avg");
    expect(fns).not.toContain("min");
    expect(fns).not.toContain("max");
    expect(fns).toEqual(["count", "distinct", "nullRate", "none"]);
    expect(defaultFooterFn("string")).toBe("count");
    expect(defaultFooterFn("date")).toBe("count");
  });
});

describe("resolveFooterFn (#645, corruption resistance)", () => {
  it("keeps a valid function for the kind", () => {
    expect(resolveFooterFn("avg", "number")).toBe("avg");
    expect(resolveFooterFn("distinct", "string")).toBe("distinct");
  });

  it("falls back to the default when the function is not applicable to the kind", () => {
    // sum on a string column is meaningless → default (count).
    expect(resolveFooterFn("sum", "string")).toBe("count");
    expect(resolveFooterFn("avg", "date")).toBe("count");
  });

  it("falls back to the default when undefined or unknown", () => {
    expect(resolveFooterFn(undefined, "number")).toBe("sum");
    expect(resolveFooterFn("bogus" as FooterAggFn, "number")).toBe("sum");
  });
});

describe("computeFooterCell (#645)", () => {
  const numericStats = columnStats([1, 2, 3, 4, null], "number");
  const textStats = columnStats(["a", "a", "b", null, null], "string");

  it("computes numeric aggregates from ColumnStats", () => {
    expect(computeFooterCell(numericStats, "sum")).toMatchObject({ numeric: 10, blank: false });
    expect(computeFooterCell(numericStats, "avg")).toMatchObject({ numeric: 2.5, blank: false });
    expect(computeFooterCell(numericStats, "min")).toMatchObject({ numeric: 1, blank: false });
    expect(computeFooterCell(numericStats, "max")).toMatchObject({ numeric: 4, blank: false });
  });

  it("computes count / distinct as non-null and unique counts", () => {
    expect(computeFooterCell(numericStats, "count").numeric).toBe(4);
    expect(computeFooterCell(textStats, "count").numeric).toBe(3);
    expect(computeFooterCell(textStats, "distinct").numeric).toBe(2);
  });

  it("computes nullRate as a percent of all rows", () => {
    // 1 of 5 numeric rows is null → 20%.
    expect(computeFooterCell(numericStats, "nullRate")).toMatchObject({ percent: 20, numeric: null });
    // 2 of 5 text rows are null → 40%.
    expect(computeFooterCell(textStats, "nullRate").percent).toBe(40);
  });

  it("blanks the cell for `none`", () => {
    expect(computeFooterCell(numericStats, "none")).toMatchObject({ blank: true, numeric: null, percent: null });
  });

  it("blanks numeric aggregates when the column has no numeric data", () => {
    const cell = computeFooterCell(textStats, "sum");
    expect(cell.blank).toBe(true);
    expect(cell.numeric).toBeNull();
  });

  it("nullRate is 0% for an empty column", () => {
    const empty = columnStats([], "number");
    expect(computeFooterCell(empty, "nullRate").percent).toBe(0);
  });

  it("footerCellForColumn matches compute over columnStats", () => {
    const values: CellValue[] = [10, 20, 30];
    expect(footerCellForColumn(values, "number", "sum")).toEqual(
      computeFooterCell(columnStats(values, "number"), "sum"),
    );
  });
});

describe("footerStateKeyFrom (#645)", () => {
  it("derives a parallel key namespace from the sizing key", () => {
    expect(footerStateKeyFrom("noobdb.colsizing.v1::db::tbl::sig")).toBe(
      "noobdb.gridfooter.v1::db::tbl::sig",
    );
  });

  it("returns undefined without a sizing key (preview panes do not persist)", () => {
    expect(footerStateKeyFrom(undefined)).toBeUndefined();
  });
});

describe("footer state persistence (#645 / #566)", () => {
  const KEY = "noobdb.gridfooter.v1::db::tbl::sig";
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it("round-trips enabled + per-column aggregates", () => {
    writeStoredFooterState(KEY, { enabled: true, aggs: { "0": "avg", "2": "distinct" } });
    expect(readStoredFooterState(KEY)).toEqual({ enabled: true, aggs: { "0": "avg", "2": "distinct" } });
  });

  it("removes the entry when effectively default (off, no columns)", () => {
    localStorage.setItem(KEY, JSON.stringify({ enabled: true }));
    writeStoredFooterState(KEY, { enabled: false, aggs: {} });
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(readStoredFooterState(KEY)).toEqual({});
  });

  it("keeps per-column aggregates even when the footer is off", () => {
    writeStoredFooterState(KEY, { enabled: false, aggs: { "1": "max" } });
    expect(readStoredFooterState(KEY)).toEqual({ enabled: false, aggs: { "1": "max" } });
  });

  it("ignores corrupt JSON", () => {
    localStorage.setItem(KEY, "{not json");
    expect(readStoredFooterState(KEY)).toEqual({});
  });

  it("drops unknown aggregate function values but keeps valid ones", () => {
    localStorage.setItem(KEY, JSON.stringify({ enabled: true, aggs: { "0": "avg", "1": "bogus", "2": 5 } }));
    expect(readStoredFooterState(KEY)).toEqual({ enabled: true, aggs: { "0": "avg" } });
  });

  it("ignores a non-boolean enabled and a non-object aggs", () => {
    localStorage.setItem(KEY, JSON.stringify({ enabled: "yes", aggs: [1, 2] }));
    expect(readStoredFooterState(KEY)).toEqual({});
  });

  it("returns {} for an absent key or undefined storage key", () => {
    expect(readStoredFooterState("noobdb.gridfooter.v1::absent")).toEqual({});
    expect(readStoredFooterState(undefined)).toEqual({});
  });

  it("no-ops writes when the storage key is undefined", () => {
    expect(() => writeStoredFooterState(undefined, { enabled: true })).not.toThrow();
  });
});
