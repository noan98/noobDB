import { describe, expect, it } from "vitest";
import {
  buildPivotModel,
  buildPivotSql,
  defaultPivotConfig,
  firstNumericColumnIndex,
  pivotValueLabel,
  MAX_PIVOT_ROWS,
  type PivotConfig,
} from "../components/pivotData";
import type { CellValue, Column } from "../api/tauri";

function cols(...names: string[]): Column[] {
  return names.map((name) => ({ name, type_name: "TEXT" }));
}

// region: coltype does not matter for pure logic; value inference is data-driven.
const COLUMNS = cols("region", "quarter", "amount");
const ROWS: CellValue[][] = [
  ["west", "Q1", 100],
  ["west", "Q1", 50],
  ["west", "Q2", 200],
  ["east", "Q1", 10],
  ["east", "Q2", 20],
];

describe("defaultPivotConfig", () => {
  it("picks first non-numeric as row, next as col, first numeric as value with sum", () => {
    const cfg = defaultPivotConfig(COLUMNS, ROWS);
    expect(cfg).toEqual({ rowField: 0, colField: 1, valueField: 2, agg: "sum" });
  });

  it("falls back to COUNT(*) when there is no numeric column", () => {
    const c = cols("a", "b");
    const rows: CellValue[][] = [["x", "y"]];
    const cfg = defaultPivotConfig(c, rows);
    expect(cfg).toEqual({ rowField: 0, colField: 1, valueField: null, agg: "count" });
  });

  it("returns null for no columns", () => {
    expect(defaultPivotConfig([], [])).toBeNull();
  });
});

describe("buildPivotModel", () => {
  it("cross-tabulates sum with row/col subtotals and grand total", () => {
    const cfg: PivotConfig = { rowField: 0, colField: 1, valueField: 2, agg: "sum" };
    const m = buildPivotModel(COLUMNS, ROWS, cfg);
    expect(m.rowKeys).toEqual(["west", "east"]);
    expect(m.colKeys).toEqual(["Q1", "Q2"]);
    // west: Q1 = 150, Q2 = 200 ; east: Q1 = 10, Q2 = 20
    expect(m.cells).toEqual([
      [150, 200],
      [10, 20],
    ]);
    expect(m.rowTotals).toEqual([350, 30]);
    expect(m.colTotals).toEqual([160, 220]);
    expect(m.grandTotal).toBe(380);
    expect(m.valueLabel).toBe("SUM(amount)");
    expect(m.truncated).toBe(false);
  });

  it("computes avg from raw data, not by re-averaging cells", () => {
    const cfg: PivotConfig = { rowField: 0, colField: 1, valueField: 2, agg: "avg" };
    const m = buildPivotModel(COLUMNS, ROWS, cfg);
    // west Q1 avg = (100+50)/2 = 75
    expect(m.cells[0][0]).toBe(75);
    // west row total avg = (100+50+200)/3 = 116.666...
    expect(m.rowTotals[0]).toBeCloseTo(350 / 3, 6);
    // grand avg = 380/5 = 76
    expect(m.grandTotal).toBe(76);
  });

  it("supports min/max", () => {
    const min = buildPivotModel(COLUMNS, ROWS, { rowField: 0, colField: 1, valueField: 2, agg: "min" });
    expect(min.cells[0][0]).toBe(50);
    const max = buildPivotModel(COLUMNS, ROWS, { rowField: 0, colField: 1, valueField: 2, agg: "max" });
    expect(max.cells[0][0]).toBe(100);
  });

  it("counts rows (COUNT(*)) when value field is null", () => {
    const cfg: PivotConfig = { rowField: 0, colField: 1, valueField: null, agg: "count" };
    const m = buildPivotModel(COLUMNS, ROWS, cfg);
    expect(m.cells).toEqual([
      [2, 1], // west Q1 has 2 rows, Q2 has 1
      [1, 1],
    ]);
    expect(m.grandTotal).toBe(5);
    expect(m.valueLabel).toBe("COUNT(*)");
  });

  it("counts non-null values for COUNT(col)", () => {
    const c = cols("g", "v");
    const rows: CellValue[][] = [
      ["a", 1],
      ["a", null],
      ["a", 3],
    ];
    const m = buildPivotModel(c, rows, { rowField: 0, colField: null, valueField: 1, agg: "count" });
    // 2 non-null values out of 3 rows
    expect(m.cells[0][0]).toBe(2);
    expect(m.valueLabel).toBe("COUNT(v)");
  });

  it("leaves missing row/col combinations blank (null)", () => {
    const c = cols("r", "col", "v");
    const rows: CellValue[][] = [
      ["a", "x", 1],
      ["b", "y", 2],
    ];
    const m = buildPivotModel(c, rows, { rowField: 0, colField: 1, valueField: 2, agg: "sum" });
    expect(m.rowKeys).toEqual(["a", "b"]);
    expect(m.colKeys).toEqual(["x", "y"]);
    expect(m.cells).toEqual([
      [1, null],
      [null, 2],
    ]);
  });

  it("with no column field produces a single value column", () => {
    const cfg: PivotConfig = { rowField: 0, colField: null, valueField: 2, agg: "sum" };
    const m = buildPivotModel(COLUMNS, ROWS, cfg);
    expect(m.colKeys).toEqual([]);
    expect(m.cells).toEqual([[350], [30]]);
    expect(m.colFieldName).toBeNull();
  });

  it("returns null for a group whose numeric values are all non-numeric text (sum)", () => {
    const c = cols("g", "v");
    const rows: CellValue[][] = [["a", "hello"]];
    const m = buildPivotModel(c, rows, { rowField: 0, colField: null, valueField: 1, agg: "sum" });
    expect(m.cells[0][0]).toBeNull();
  });

  it("yields all-null cells for a non-count aggregation with no value field", () => {
    // PivotView.setAgg guards against this by auto-selecting a numeric column,
    // but lock the pure-logic behavior in case the invalid config still arrives.
    const cfg: PivotConfig = { rowField: 0, colField: 1, valueField: null, agg: "sum" };
    const m = buildPivotModel(COLUMNS, ROWS, cfg);
    expect(m.cells.every((row) => row.every((v) => v === null))).toBe(true);
    expect(m.rowTotals.every((v) => v === null)).toBe(true);
    expect(m.grandTotal).toBeNull();
  });

  it("marks truncated when distinct row keys exceed the cap", () => {
    const c = cols("g", "v");
    const rows: CellValue[][] = [];
    for (let i = 0; i < MAX_PIVOT_ROWS + 5; i++) rows.push([`g${i}`, 1]);
    const m = buildPivotModel(c, rows, { rowField: 0, colField: null, valueField: 1, agg: "sum" });
    expect(m.rowKeys.length).toBe(MAX_PIVOT_ROWS);
    expect(m.truncated).toBe(true);
  });
});

describe("firstNumericColumnIndex", () => {
  it("returns the first numeric column index or null", () => {
    expect(firstNumericColumnIndex(COLUMNS, ROWS)).toBe(2);
    expect(firstNumericColumnIndex(cols("a", "b"), [["x", "y"]])).toBeNull();
  });
});

describe("pivotValueLabel", () => {
  it("labels COUNT(*) vs aggregate of a value column", () => {
    expect(pivotValueLabel(COLUMNS, { rowField: 0, colField: 1, valueField: null, agg: "count" })).toBe(
      "COUNT(*)",
    );
    expect(pivotValueLabel(COLUMNS, { rowField: 0, colField: 1, valueField: 2, agg: "avg" })).toBe(
      "AVG(amount)",
    );
  });
});

describe("buildPivotSql", () => {
  it("wraps the source query and groups by row+col with MySQL backticks", () => {
    const sql = buildPivotSql({
      driver: "mysql",
      sourceSql: "SELECT region, quarter, amount FROM sales;",
      rowColumn: "region",
      colColumn: "quarter",
      valueColumn: "amount",
      agg: "sum",
    });
    expect(sql).toBe(
      "SELECT `region`, `quarter`, SUM(`amount`) AS `sum_amount`\n" +
        "FROM (SELECT region, quarter, amount FROM sales) AS `pivot_src`\n" +
        "GROUP BY `region`, `quarter`\n" +
        "ORDER BY `region`, `quarter`",
    );
  });

  it("uses double quotes for Postgres and omits the column axis when null", () => {
    const sql = buildPivotSql({
      driver: "postgres",
      sourceSql: "SELECT region, amount FROM sales",
      rowColumn: "region",
      colColumn: null,
      valueColumn: "amount",
      agg: "avg",
    });
    expect(sql).toBe(
      'SELECT "region", AVG("amount") AS "avg_amount"\n' +
        'FROM (SELECT region, amount FROM sales) AS "pivot_src"\n' +
        'GROUP BY "region"\n' +
        'ORDER BY "region"',
    );
  });

  it("emits COUNT(*) when counting without a value column", () => {
    const sql = buildPivotSql({
      driver: "sqlite",
      sourceSql: "SELECT region, quarter FROM sales",
      rowColumn: "region",
      colColumn: "quarter",
      valueColumn: null,
      agg: "count",
    });
    expect(sql).toBe(
      'SELECT "region", "quarter", COUNT(*) AS "count_all"\n' +
        'FROM (SELECT region, quarter FROM sales) AS "pivot_src"\n' +
        'GROUP BY "region", "quarter"\n' +
        'ORDER BY "region", "quarter"',
    );
  });

  it("escapes identifier quotes", () => {
    const sql = buildPivotSql({
      driver: "mysql",
      sourceSql: "SELECT * FROM t",
      rowColumn: "we`ird",
      colColumn: null,
      valueColumn: "v",
      agg: "sum",
    });
    expect(sql).toContain("`we``ird`");
  });
});
