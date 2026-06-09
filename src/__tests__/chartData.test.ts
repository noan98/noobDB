import { describe, expect, it } from "vitest";
import type { CellValue, Column } from "../api/tauri";
import {
  buildChartModel,
  defaultChartConfig,
  inferNumericColumns,
  MAX_POINTS,
  toNumber,
  valueExtent,
} from "../components/chartData";

const col = (name: string): Column => ({ name, type_name: "x" });

describe("toNumber", () => {
  it("converts numbers, booleans, and numeric strings", () => {
    expect(toNumber(42)).toBe(42);
    expect(toNumber(true)).toBe(1);
    expect(toNumber(false)).toBe(0);
    expect(toNumber("3.5")).toBe(3.5);
    expect(toNumber("")).toBeNull();
    expect(toNumber("abc")).toBeNull();
    expect(toNumber(null)).toBeNull();
  });
});

describe("inferNumericColumns", () => {
  it("flags columns whose values are mostly numeric", () => {
    const columns = [col("name"), col("amount")];
    const rows: CellValue[][] = [
      ["a", 10],
      ["b", "20"],
      ["c", null],
    ];
    expect(inferNumericColumns(columns, rows)).toEqual([false, true]);
  });
});

describe("defaultChartConfig", () => {
  it("picks a category X and numeric Y", () => {
    const columns = [col("category"), col("total")];
    const rows: CellValue[][] = [
      ["a", 1],
      ["b", 2],
    ];
    expect(defaultChartConfig(columns, rows)).toEqual({
      type: "bar",
      xCol: 0,
      yCols: [1],
      aggregation: "none",
    });
  });

  it("returns null without any numeric column", () => {
    const columns = [col("a"), col("b")];
    const rows: CellValue[][] = [["x", "y"]];
    expect(defaultChartConfig(columns, rows)).toBeNull();
  });
});

describe("buildChartModel", () => {
  const columns = [col("cat"), col("v")];
  const rows: CellValue[][] = [
    ["a", 10],
    ["a", 20],
    ["b", 5],
  ];

  it("maps raw rows to labels and series with no aggregation", () => {
    const model = buildChartModel(columns, rows, {
      type: "bar",
      xCol: 0,
      yCols: [1],
      aggregation: "none",
    });
    expect(model.labels).toEqual(["a", "a", "b"]);
    expect(model.series[0].values).toEqual([10, 20, 5]);
    expect(model.sampledFrom).toBeNull();
  });

  it("groups and sums by X for the sum aggregation", () => {
    const model = buildChartModel(columns, rows, {
      type: "bar",
      xCol: 0,
      yCols: [1],
      aggregation: "sum",
    });
    expect(model.labels).toEqual(["a", "b"]);
    expect(model.series[0].values).toEqual([30, 5]);
    expect(model.series[0].name).toBe("SUM(v)");
  });

  it("averages and counts per group", () => {
    const avg = buildChartModel(columns, rows, { type: "bar", xCol: 0, yCols: [1], aggregation: "avg" });
    expect(avg.series[0].values).toEqual([15, 5]);
    const count = buildChartModel(columns, rows, { type: "bar", xCol: 0, yCols: [1], aggregation: "count" });
    expect(count.series[0].values).toEqual([2, 1]);
  });

  it("samples down very large unaggregated result sets", () => {
    const big: CellValue[][] = Array.from({ length: MAX_POINTS + 500 }, (_, i) => ["x", i]);
    const model = buildChartModel(columns, big, { type: "line", xCol: 0, yCols: [1], aggregation: "none" });
    expect(model.labels).toHaveLength(MAX_POINTS);
    expect(model.sampledFrom).toBe(MAX_POINTS + 500);
  });
});

describe("valueExtent", () => {
  it("includes the zero baseline", () => {
    const model = { labels: [], series: [{ name: "s", values: [5, 8, 3] }], sampledFrom: null };
    expect(valueExtent(model)).toEqual({ min: 0, max: 8 });
  });

  it("handles negative values", () => {
    const model = { labels: [], series: [{ name: "s", values: [-5, -2] }], sampledFrom: null };
    expect(valueExtent(model)).toEqual({ min: -5, max: 0 });
  });
});
