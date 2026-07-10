import { describe, expect, it } from "vitest";
import type { CellValue, Column } from "../api/tauri";
import {
  buildChartModel,
  chartNotices,
  defaultChartConfig,
  inferNumericColumns,
  MAX_POINTS,
  niceTicks,
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

  it("count は数値化できない非 NULL 値も COUNT(col) と同じく数える", () => {
    // "a" グループの 2 件目は数値変換できない文字列だが、SQL の COUNT(col) は
    // NULL でない限り数えるため、count 集計もこれを含めなければならない。
    const withText: CellValue[][] = [
      ["a", 10],
      ["a", "not-a-number"],
      ["a", null],
      ["b", 5],
    ];
    const count = buildChartModel(columns, withText, {
      type: "bar",
      xCol: 0,
      yCols: [1],
      aggregation: "count",
    });
    // グループ "a" は 3 行中 NULL の 1 件を除いた 2 件が COUNT 対象。
    expect(count.series[0].values).toEqual([2, 1]);
    // 一方 sum/avg は数値変換できた行のみを対象にする (非数値・NULL を除外)。
    const avg = buildChartModel(columns, withText, {
      type: "bar",
      xCol: 0,
      yCols: [1],
      aggregation: "avg",
    });
    expect(avg.series[0].values).toEqual([10, 5]);
  });

  it("samples down very large unaggregated result sets", () => {
    const big: CellValue[][] = Array.from({ length: MAX_POINTS + 500 }, (_, i) => ["x", i]);
    const model = buildChartModel(columns, big, { type: "line", xCol: 0, yCols: [1], aggregation: "none" });
    expect(model.labels).toHaveLength(MAX_POINTS);
    expect(model.sampledFrom).toBe(MAX_POINTS + 500);
  });

  it("#646: 集計なしで NULL/非数値を 0 として読み替えた件数を数える", () => {
    const withGaps: CellValue[][] = [
      ["a", 10],
      ["b", null],
      ["c", "n/a"],
      ["d", 20],
    ];
    const model = buildChartModel(columns, withGaps, {
      type: "bar",
      xCol: 0,
      yCols: [1],
      aggregation: "none",
    });
    expect(model.series[0].values).toEqual([10, 0, 0, 20]);
    expect(model.excludedNonNumeric).toBe(2);
  });

  it("#646: 集計あり (sum/avg/count) は非数値を最初から除外するため読み替えは発生しない", () => {
    const withGaps: CellValue[][] = [
      ["a", 10],
      ["a", null],
    ];
    const model = buildChartModel(columns, withGaps, {
      type: "bar",
      xCol: 0,
      yCols: [1],
      aggregation: "sum",
    });
    expect(model.excludedNonNumeric).toBe(0);
  });
});

describe("chartNotices (#646)", () => {
  it("flags a lone data point", () => {
    const model = { labels: ["a"], series: [{ name: "v", values: [10] }], sampledFrom: null };
    expect(chartNotices(model)).toEqual(["singlePoint"]);
  });

  it("flags identical values across every point/series as flat", () => {
    const model = {
      labels: ["a", "b", "c"],
      series: [{ name: "v", values: [5, 5, 5] }],
      sampledFrom: null,
    };
    expect(chartNotices(model)).toEqual(["flatValues"]);
  });

  it("does not flag flat when values differ", () => {
    const model = {
      labels: ["a", "b"],
      series: [{ name: "v", values: [5, 6] }],
      sampledFrom: null,
    };
    expect(chartNotices(model)).toEqual([]);
  });

  it("flags non-numeric exclusions from excludedNonNumeric", () => {
    const model = {
      labels: ["a", "b"],
      series: [{ name: "v", values: [1, 0] }],
      sampledFrom: null,
      excludedNonNumeric: 1,
    };
    expect(chartNotices(model)).toEqual(["nonNumericExcluded"]);
  });

  it("can report multiple notices at once", () => {
    const model = {
      labels: ["a"],
      series: [{ name: "v", values: [0] }],
      sampledFrom: null,
      excludedNonNumeric: 1,
    };
    expect(chartNotices(model)).toEqual(["singlePoint", "nonNumericExcluded"]);
  });

  it("reports nothing for an empty model or a model without excludedNonNumeric", () => {
    expect(chartNotices({ labels: [], series: [], sampledFrom: null })).toEqual([]);
    const healthy = {
      labels: ["a", "b"],
      series: [{ name: "v", values: [1, 2] }],
      sampledFrom: null,
    };
    expect(chartNotices(healthy)).toEqual([]);
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

  it("bar/area では明示的に指定しても 0 基線を含める", () => {
    const model = { labels: [], series: [{ name: "s", values: [5, 8, 3] }], sampledFrom: null };
    expect(valueExtent(model, "bar")).toEqual({ min: 0, max: 8 });
    expect(valueExtent(model, "area")).toEqual({ min: 0, max: 8 });
  });

  it("line では 0 基線を含めず実データのレンジを返す", () => {
    // 値が密集しているケース (0 起点だと変動がつぶれる想定)。
    const model = { labels: [], series: [{ name: "s", values: [100, 108, 103] }], sampledFrom: null };
    expect(valueExtent(model, "line")).toEqual({ min: 100, max: 108 });
  });
});

describe("niceTicks", () => {
  it("produces evenly spaced round ticks covering the range", () => {
    expect(niceTicks(0, 100)).toEqual([0, 20, 40, 60, 80, 100]);
    expect(niceTicks(0, 5)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("includes the zero baseline for ranges spanning zero", () => {
    const ticks = niceTicks(-50, 100);
    expect(ticks).toContain(0);
    expect(ticks[0]).toBeLessThanOrEqual(0);
    expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(99);
  });

  it("keeps all ticks within the requested range", () => {
    for (const v of niceTicks(3, 27)) {
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThanOrEqual(27);
    }
  });

  it("avoids floating point drift on fractional steps", () => {
    expect(niceTicks(0, 1)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
  });

  it("returns a single tick for degenerate ranges", () => {
    expect(niceTicks(0, 0)).toEqual([0]);
    expect(niceTicks(7, 7)).toEqual([7]);
  });
});
