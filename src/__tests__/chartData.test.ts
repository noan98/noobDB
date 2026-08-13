import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CellValue, Column } from "../api/tauri";
import { CATEGORICAL, DIVERGING_RAMPS, SEQUENTIAL_RAMPS, sampleRamp } from "../colorScale";
import {
  buildChartModel,
  chartConfigKeyFrom,
  chartNotices,
  chartPalette,
  chartRampGradient,
  chartSeriesColors,
  chartValueColors,
  DEFAULT_CHART_PALETTE,
  defaultChartConfig,
  inferNumericColumns,
  MAX_POINTS,
  niceTicks,
  readStoredChartConfig,
  sanitizeChartConfig,
  toNumber,
  valueExtent,
  writeStoredChartConfig,
  type ChartConfig,
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
      palette: "categorical",
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

describe("chartConfigKeyFrom (#909)", () => {
  it("derives a stable key from the executed SQL text", () => {
    const key = chartConfigKeyFrom("SELECT * FROM users");
    expect(key).toBeDefined();
    expect(key).toBe(chartConfigKeyFrom("SELECT * FROM users"));
    // Leading/trailing whitespace differences don't matter.
    expect(key).toBe(chartConfigKeyFrom("  SELECT * FROM users  "));
  });

  it("differs for different SQL text", () => {
    expect(chartConfigKeyFrom("SELECT 1")).not.toBe(chartConfigKeyFrom("SELECT 2"));
  });

  it("returns undefined when there is no SQL (unexecuted / empty)", () => {
    expect(chartConfigKeyFrom(undefined)).toBeUndefined();
    expect(chartConfigKeyFrom("")).toBeUndefined();
    expect(chartConfigKeyFrom("   ")).toBeUndefined();
  });
});

describe("sanitizeChartConfig (#909, corruption resistance)", () => {
  const columns = [col("name"), col("amount"), col("qty")];

  it("accepts a well-formed config referencing valid columns", () => {
    const cfg: ChartConfig = { type: "line", xCol: 0, yCols: [1, 2], aggregation: "sum", palette: "teal" };
    expect(sanitizeChartConfig(cfg, columns)).toEqual(cfg);
  });

  it("rejects non-object / null input", () => {
    expect(sanitizeChartConfig(null, columns)).toBeNull();
    expect(sanitizeChartConfig("bogus", columns)).toBeNull();
    expect(sanitizeChartConfig(42, columns)).toBeNull();
  });

  it("rejects an unknown chart type or aggregation", () => {
    expect(sanitizeChartConfig({ type: "scatter", xCol: 0, yCols: [1], aggregation: "sum" }, columns)).toBeNull();
    expect(sanitizeChartConfig({ type: "bar", xCol: 0, yCols: [1], aggregation: "median" }, columns)).toBeNull();
  });

  it("falls back to null when xCol is out of range (column set changed)", () => {
    expect(sanitizeChartConfig({ type: "bar", xCol: 9, yCols: [1], aggregation: "none" }, columns)).toBeNull();
  });

  it("drops out-of-range / duplicate Y columns but keeps the rest", () => {
    const result = sanitizeChartConfig(
      { type: "bar", xCol: 0, yCols: [1, 1, 9, 1], aggregation: "none" },
      columns,
    );
    expect(result).toEqual({ type: "bar", xCol: 0, yCols: [1], aggregation: "none", palette: "categorical" });
  });

  it("falls back to null when every saved Y column disappeared (schema drift)", () => {
    expect(sanitizeChartConfig({ type: "bar", xCol: 0, yCols: [9, 10], aggregation: "none" }, columns)).toBeNull();
  });

  it("respects an intentionally empty Y selection", () => {
    const cfg: ChartConfig = { type: "bar", xCol: 0, yCols: [], aggregation: "none" };
    expect(sanitizeChartConfig(cfg, columns)).toEqual({ ...cfg, palette: "categorical" });
  });

  it("excludes a saved Y column that now equals xCol", () => {
    const result = sanitizeChartConfig({ type: "bar", xCol: 1, yCols: [1, 2], aggregation: "none" }, columns);
    expect(result).toEqual({ type: "bar", xCol: 1, yCols: [2], aggregation: "none", palette: "categorical" });
  });
});

describe("readStoredChartConfig / writeStoredChartConfig (#909)", () => {
  const KEY = "noobdb.chartconfig.v1::test";
  const columns = [col("name"), col("amount")];

  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it("round-trips a config through localStorage", () => {
    const cfg: ChartConfig = { type: "pie", xCol: 0, yCols: [1], aggregation: "count", palette: "blue" };
    writeStoredChartConfig(KEY, cfg);
    expect(readStoredChartConfig(KEY, columns)).toEqual(cfg);
  });

  it("returns null when no key is given (unexecuted SQL)", () => {
    expect(readStoredChartConfig(undefined, columns)).toBeNull();
    // Writing with no key is a silent no-op, not a throw.
    expect(() => writeStoredChartConfig(undefined, { type: "bar", xCol: 0, yCols: [1], aggregation: "none" })).not.toThrow();
  });

  it("returns null for missing or corrupt JSON instead of throwing", () => {
    expect(readStoredChartConfig(KEY, columns)).toBeNull();
    localStorage.setItem(KEY, "{not json");
    expect(readStoredChartConfig(KEY, columns)).toBeNull();
  });

  it("falls back to null when the stored config no longer fits the current columns", () => {
    const cfg: ChartConfig = { type: "bar", xCol: 5, yCols: [6], aggregation: "none" };
    writeStoredChartConfig(KEY, cfg);
    expect(readStoredChartConfig(KEY, columns)).toBeNull();
  });
});

// --- 配色 (#916) ------------------------------------------------------------
//
// グリッドの条件付き書式が使う共有カラースケール (`colorScale.ts`) の連続/発散
// ランプを、チャートの系列色/値着色にも開放したもの。色そのものの正しさは
// `colorScale.test.ts` が固定するので、ここでは「どの位置をサンプリングするか」
// と「離散パレットのときに従来挙動へ落ちるか」を固定する。

describe("chartPalette (#916)", () => {
  it("falls back to the categorical default for unknown / missing keys", () => {
    expect(chartPalette(undefined).key).toBe(DEFAULT_CHART_PALETTE);
    expect(chartPalette("nope").key).toBe(DEFAULT_CHART_PALETTE);
    expect(chartPalette(null).key).toBe(DEFAULT_CHART_PALETTE);
  });

  it("exposes the shared ramps and their colour-blind safety", () => {
    expect(chartPalette("categorical").ramp).toBeNull();
    expect(chartPalette("blue").ramp?.stops).toEqual(SEQUENTIAL_RAMPS.blue.stops);
    expect(chartPalette("blue").colorBlindSafe).toBe(true);
    // coolWarm は直感的だが赤緑色弱に不利 (colorScale.ts の定義と揃っている)。
    expect(chartPalette("coolWarm").colorBlindSafe).toBe(false);
    expect(chartPalette("blueOrange").colorBlindSafe).toBe(true);
  });
});

describe("chartSeriesColors (#916)", () => {
  it("keeps the previous categorical cycling as the default", () => {
    const colors = chartSeriesColors("categorical", 10);
    expect(colors).toHaveLength(10);
    expect(colors[0]).toBe(CATEGORICAL[0]);
    // パレット長を超えたら循環する (従来の `% length` と同じ)。
    expect(colors[CATEGORICAL.length]).toBe(CATEGORICAL[0]);
  });

  it("returns an empty array for a degenerate count", () => {
    expect(chartSeriesColors("blue", 0)).toEqual([]);
    expect(chartSeriesColors("blue", -3)).toEqual([]);
    expect(chartSeriesColors("blue", Number.NaN)).toEqual([]);
  });

  it("samples a ramp across its usable span for multiple series", () => {
    const colors = chartSeriesColors("blue", 3);
    expect(colors).toHaveLength(3);
    expect(new Set(colors).size).toBe(3);
    // 連続ランプの下端 (ほぼ白) は背景に沈むので使わない。
    expect(colors[0]).not.toBe(sampleRamp(0, SEQUENTIAL_RAMPS.blue.stops));
    expect(colors[2]).toBe(sampleRamp(1, SEQUENTIAL_RAMPS.blue.stops));
  });

  it("uses a single readable mid-dark colour when there is only one series", () => {
    const [only] = chartSeriesColors("teal", 1);
    expect(only).toBe(sampleRamp(0.75, SEQUENTIAL_RAMPS.teal.stops));
  });
});

describe("chartValueColors (#916)", () => {
  it("returns null for the categorical palette (no value encoding)", () => {
    expect(chartValueColors([1, 2, 3], "categorical")).toBeNull();
    expect(chartValueColors([1, 2, 3], undefined)).toBeNull();
  });

  it("maps the smallest value to the light end and the largest to the dark end", () => {
    const colors = chartValueColors([10, 0, 5], "blue");
    expect(colors).not.toBeNull();
    const [high, low, mid] = colors!;
    expect(high).toBe(sampleRamp(1, SEQUENTIAL_RAMPS.blue.stops));
    expect(low).toBe(sampleRamp(0.2, SEQUENTIAL_RAMPS.blue.stops));
    expect(mid).not.toBe(high);
    expect(mid).not.toBe(low);
  });

  it("uses the whole diverging ramp so its pale centre lands on the mid value", () => {
    const colors = chartValueColors([0, 50, 100], "blueOrange");
    expect(colors![0]).toBe(sampleRamp(0, DIVERGING_RAMPS.blueOrange.stops));
    expect(colors![1]).toBe(sampleRamp(0.5, DIVERGING_RAMPS.blueOrange.stops));
    expect(colors![2]).toBe(sampleRamp(1, DIVERGING_RAMPS.blueOrange.stops));
  });

  it("falls back to one solid colour when the range is degenerate", () => {
    const flat = chartValueColors([7, 7, 7], "blue")!;
    expect(new Set(flat).size).toBe(1);
    expect(chartValueColors([], "blue")).toEqual([]);
    // 非有限値だけの系列も「大小を表せない」ので単色に倒す (NaN を色にしない)。
    const nonFinite = chartValueColors([Number.NaN, Number.POSITIVE_INFINITY], "blue")!;
    expect(new Set(nonFinite).size).toBe(1);
    expect(nonFinite[0]).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
  });

  it("keeps non-finite entries readable inside an otherwise valid range", () => {
    const colors = chartValueColors([0, Number.NaN, 10], "blue")!;
    expect(colors[1]).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
  });
});

describe("chartRampGradient (#916)", () => {
  it("returns null for the categorical palette (no gradient to show)", () => {
    expect(chartRampGradient("categorical")).toBeNull();
  });

  it("builds a CSS gradient from the shared ramp", () => {
    const css = chartRampGradient("blue");
    expect(css).toMatch(/^linear-gradient\(90deg, rgb\(/);
    expect(css).toContain("0%");
    expect(css).toContain("100%");
  });
});
