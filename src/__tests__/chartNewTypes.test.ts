// @vitest-environment jsdom (sanitizeChartConfig 周りは localStorage 非依存だが、既存の chartData テストと環境を揃える)
import { describe, expect, it } from "vitest";
import type { CellValue, Column } from "../api/tauri";
import {
  applyChartType,
  buildChartModel,
  canAggregateInDb,
  chartNotices,
  comboLineIndex,
  histogramBins,
  MAX_POINTS,
  paddedExtent,
  sanitizeChartConfig,
  splitComboSeries,
  stackLayout,
  valueExtent,
  type ChartConfig,
  type ChartModel,
} from "../components/chartData";

const cols = (...names: string[]): Column[] => names.map((name) => ({ name, type_name: "TEXT" }) as Column);
const cfg = (over: Partial<ChartConfig>): ChartConfig => ({
  type: "bar",
  xCol: 0,
  yCols: [1],
  aggregation: "none",
  ...over,
});

describe("histogramBins (#1941)", () => {
  it("等幅のビンに分け、最後のビンは最大値を含む", () => {
    const { edges, counts } = histogramBins([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5);
    expect(edges).toEqual([0, 2, 4, 6, 8, 10]);
    // [0,2) [2,4) [4,6) [6,8) [8,10]
    expect(counts).toEqual([2, 2, 2, 2, 3]);
  });

  it("境界ちょうどの値は上側のビンに入る", () => {
    const { counts } = histogramBins([0, 5, 10], 2);
    expect(counts).toEqual([1, 2]);
  });

  it("件数の合計は入力の個数に一致する (浮動小数の境界でも欠けない)", () => {
    const values = Array.from({ length: 1000 }, (_, i) => i * 0.1);
    for (const bins of [5, 10, 20, 30, 50]) {
      const { counts } = histogramBins(values, bins);
      expect(counts.reduce((a, b) => a + b, 0)).toBe(1000);
    }
  });

  it("空は空、全値が同じなら幅 0 の 1 ビン", () => {
    expect(histogramBins([], 10)).toEqual({ edges: [], counts: [] });
    expect(histogramBins([3, 3, 3], 10)).toEqual({ edges: [3, 3], counts: [3] });
  });

  it("単一値は 1 ビン、負の値も扱える", () => {
    expect(histogramBins([7], 10)).toEqual({ edges: [7, 7], counts: [1] });
    const { edges, counts } = histogramBins([-10, -5, 0], 2);
    expect(edges).toEqual([-10, -5, 0]);
    expect(counts).toEqual([1, 2]);
  });
});

describe("ヒストグラムのモデル (#1941)", () => {
  const columns = cols("n");
  it("非数値・NULL は除外して droppedRows に数える", () => {
    const rows: CellValue[][] = [[1], [2], [null], ["abc"], ["3"], [10]];
    const m = buildChartModel(columns, rows, cfg({ type: "histogram", xCol: 0, yCols: [], bins: 5 }));
    expect(m.series).toHaveLength(1);
    expect(m.series[0].name).toBe("COUNT(n)");
    expect(m.series[0].values.reduce((a, b) => a + b, 0)).toBe(4);
    expect(m.histEdges).toHaveLength(6);
    expect(m.labels).toHaveLength(5);
    expect(m.droppedRows).toBe(2);
    expect(chartNotices(m)).toContain("rowsDropped");
  });

  it("ビン数の既定は 10、全値同じなら単一ラベル", () => {
    const m = buildChartModel(columns, [[1], [2], [3]], cfg({ type: "histogram", yCols: [] }));
    expect(m.labels).toHaveLength(10);
    const same = buildChartModel(columns, [[4], [4]], cfg({ type: "histogram", yCols: [] }));
    expect(same.labels).toEqual(["4"]);
    expect(same.series[0].values).toEqual([2]);
  });

  it("数値が 1 つも無ければ空モデル", () => {
    const m = buildChartModel(columns, [["a"], [null]], cfg({ type: "histogram", yCols: [] }));
    expect(m.labels).toEqual([]);
    expect(m.droppedRows).toBe(2);
  });

  it("件数が揃っていても flatValues の注記は出さない", () => {
    const m = buildChartModel(columns, [[0], [10]], cfg({ type: "histogram", yCols: [], bins: 2 }));
    expect(m.series[0].values).toEqual([1, 1]);
    expect(chartNotices(m)).not.toContain("flatValues");
  });

  it("値に比べてビン幅が細かくても、境界のラベルが同じ表記に潰れない", () => {
    const m = buildChartModel(
      columns,
      [[1000000], [1000001]],
      cfg({ type: "histogram", yCols: [], bins: 10 }),
    );
    expect(new Set(m.labels).size).toBe(10);
    expect(m.labels[0]).toBe("1000000 – 1000000.1");
  });

  it("通常の値では有効桁 6 桁のまま (末尾の誤差を出さない)", () => {
    const m = buildChartModel(columns, [[0], [1]], cfg({ type: "histogram", yCols: [], bins: 10 }));
    expect(m.labels[2]).toBe("0.2 – 0.3");
  });
});

describe("散布図のモデル (#1941)", () => {
  const columns = cols("x", "y", "z");
  it("X と Y が数値の行だけを点にし、他は droppedRows に数える", () => {
    const rows: CellValue[][] = [
      [1, 2, 9],
      [2, null, 9],
      ["a", 3, 9],
      ["4", "5", 9],
    ];
    const m = buildChartModel(columns, rows, cfg({ type: "scatter", xCol: 0, yCols: [1] }));
    expect(m.scatterX).toEqual([1, 4]);
    expect(m.series[0].values).toEqual([2, 5]);
    expect(m.droppedRows).toBe(2);
    expect(m.excludedNonNumeric).toBe(0);
  });

  it("複数の Y は系列になる (どれかが非数値の行は点にしない)", () => {
    const rows: CellValue[][] = [
      [1, 2, 3],
      [2, 3, null],
    ];
    const m = buildChartModel(columns, rows, cfg({ type: "scatter", xCol: 0, yCols: [1, 2] }));
    expect(m.series.map((s) => s.name)).toEqual(["y", "z"]);
    expect(m.scatterX).toEqual([1]);
  });

  it("集計設定があっても生の値のまま (集計しない)", () => {
    const rows: CellValue[][] = [
      [1, 1, 0],
      [1, 2, 0],
    ];
    const m = buildChartModel(columns, rows, cfg({ type: "scatter", yCols: [1], aggregation: "sum" }));
    expect(m.scatterX).toEqual([1, 1]);
    expect(m.series[0].values).toEqual([1, 2]);
  });

  it("MAX_POINTS を超えたら間引く", () => {
    const rows: CellValue[][] = Array.from({ length: MAX_POINTS + 500 }, (_, i) => [i, i, 0]);
    const m = buildChartModel(columns, rows, cfg({ type: "scatter", yCols: [1] }));
    expect(m.labels).toHaveLength(MAX_POINTS);
    expect(m.sampledFrom).toBe(MAX_POINTS + 500);
  });

  it("空・単一点・全点が同じ値でも軸範囲は退化しない", () => {
    expect(buildChartModel(columns, [], cfg({ type: "scatter" })).labels).toEqual([]);
    expect(paddedExtent([])).toEqual({ min: 0, max: 1 });
    expect(paddedExtent([5])).toEqual({ min: 4, max: 6 });
    const e = paddedExtent([0, 100]);
    expect(e.min).toBeLessThan(0);
    expect(e.max).toBeGreaterThan(100);
  });

  it("DB 側集計の対象にならない", () => {
    expect(canAggregateInDb(columns, cfg({ type: "scatter", aggregation: "sum" }), "select 1")).toBe(false);
    expect(canAggregateInDb(columns, cfg({ type: "histogram", aggregation: "sum" }), "select 1")).toBe(false);
    expect(canAggregateInDb(columns, cfg({ type: "stackedBar", aggregation: "sum" }), "select 1")).toBe(true);
  });
});

describe("積み上げ棒 (#1941)", () => {
  const model: ChartModel = {
    labels: ["a", "b"],
    series: [
      { name: "s1", values: [3, -2] },
      { name: "s2", values: [4, 5] },
      { name: "s3", values: [-1, -1] },
    ],
    sampledFrom: null,
  };
  it("正は基線の上、負は下へ系列順に積む", () => {
    const l = stackLayout(model);
    expect(l[0][0]).toEqual({ from: 0, to: 3 });
    expect(l[1][0]).toEqual({ from: 3, to: 7 });
    expect(l[2][0]).toEqual({ from: 0, to: -1 });
    expect(l[0][1]).toEqual({ from: 0, to: -2 });
    expect(l[1][1]).toEqual({ from: 0, to: 5 });
    expect(l[2][1]).toEqual({ from: -2, to: -3 });
  });
  it("軸範囲は積み上げた合計 (0 基線を含む)", () => {
    expect(valueExtent(model, "stackedBar")).toEqual({ min: -3, max: 7 });
    // 通常の棒は系列ごとの最大・最小のまま。
    expect(valueExtent(model, "bar")).toEqual({ min: -2, max: 5 });
  });
  it("空モデルは 0..0、非有限は 0 扱い", () => {
    expect(valueExtent({ labels: [], series: [], sampledFrom: null }, "stackedBar")).toEqual({
      min: 0,
      max: 0,
    });
    const l = stackLayout({
      labels: ["a"],
      series: [{ name: "s", values: [Number.NaN] }],
      sampledFrom: null,
    });
    expect(l[0][0]).toEqual({ from: 0, to: 0 });
  });
  it("並び順 (barSort) は積み上げ棒にも効く (合計で並べる)", () => {
    const m = buildChartModel(
      cols("k", "a", "b"),
      [
        ["x", 1, 1],
        ["y", 5, 5],
      ],
      cfg({ type: "stackedBar", yCols: [1, 2], barSort: "desc" }),
    );
    expect(m.labels).toEqual(["y", "x"]);
  });
});

describe("複合 (棒 + 折れ線) (#1941)", () => {
  const model: ChartModel = {
    labels: ["a", "b"],
    series: [
      { name: "sales", values: [100, 200] },
      { name: "rate", values: [0.1, 0.2] },
    ],
    sampledFrom: null,
  };
  it("折れ線列の位置: 指定が有効ならそれ、無効・未指定なら最後の Y", () => {
    expect(comboLineIndex({ yCols: [1, 2], comboLineCol: 1 })).toBe(0);
    expect(comboLineIndex({ yCols: [1, 2], comboLineCol: 2 })).toBe(1);
    expect(comboLineIndex({ yCols: [1, 2], comboLineCol: 9 })).toBe(1);
    expect(comboLineIndex({ yCols: [1, 2] })).toBe(1);
    expect(comboLineIndex({ yCols: [] })).toBe(-1);
  });
  it("系列を棒と折れ線に分ける (名前不明・未指定は全て棒)", () => {
    const { bars, line } = splitComboSeries(model, "rate");
    expect(bars.map((s) => s.name)).toEqual(["sales"]);
    expect(line?.name).toBe("rate");
    expect(splitComboSeries(model, "none").line).toBeNull();
    expect(splitComboSeries(model, undefined).bars).toHaveLength(2);
  });
});

describe("種類の切替で設定を整える (#1941)", () => {
  const numeric = [false, true, true, false];
  it("散布図: 非数値の X は最初の数値列に、Y は数値列だけに寄せる", () => {
    const c = applyChartType(cfg({ xCol: 0, yCols: [3] }), "scatter", numeric);
    expect(c.type).toBe("scatter");
    expect(c.xCol).toBe(1);
    expect(c.yCols).toEqual([2]);
  });
  it("ヒストグラム: 非数値の X は数値列へ、Y に X を含めない", () => {
    const c = applyChartType(cfg({ xCol: 0, yCols: [1, 2] }), "histogram", numeric);
    expect(c.xCol).toBe(1);
    expect(c.yCols).toEqual([2]);
  });
  it("複合: Y が 1 本なら数値列をもう 1 本足す。足せなければそのまま", () => {
    expect(applyChartType(cfg({ xCol: 0, yCols: [1] }), "combo", numeric).yCols).toEqual([1, 2]);
    expect(applyChartType(cfg({ xCol: 0, yCols: [1] }), "combo", [false, true]).yCols).toEqual([1]);
  });
  it("ヒストグラムから戻すとき Y が空なら数値の Y を 1 本補う", () => {
    const c = applyChartType(cfg({ type: "histogram", xCol: 1, yCols: [] }), "bar", numeric);
    expect(c.yCols).toEqual([2]);
  });
  it("ヒストグラムで全値が同じでも singlePoint の注記は出さない", () => {
    const m = buildChartModel(cols("n"), [[4], [4]], cfg({ type: "histogram", yCols: [] }));
    expect(chartNotices(m)).toEqual([]);
  });
  it("数値列が無くても例外にならない", () => {
    const c = applyChartType(cfg({ xCol: 0, yCols: [1] }), "scatter", [false, false]);
    expect(c.type).toBe("scatter");
  });
});

describe("保存した設定の復元 (#1941)", () => {
  const columns = cols("a", "b", "c");
  const base = { type: "combo", xCol: 0, yCols: [1, 2], aggregation: "sum" };
  it("新しい種類と bins / comboLineCol を引き継ぐ", () => {
    for (const type of ["scatter", "histogram", "stackedBar", "combo"]) {
      expect(sanitizeChartConfig({ ...base, type }, columns)?.type).toBe(type);
    }
    const c = sanitizeChartConfig({ ...base, bins: 20, comboLineCol: 2 }, columns);
    expect(c?.bins).toBe(20);
    expect(c?.comboLineCol).toBe(2);
  });
  it("不正な bins / comboLineCol は捨てる (設定自体は残る)", () => {
    for (const bins of [7, -1, "10", 1.5, null]) {
      expect(sanitizeChartConfig({ ...base, bins }, columns)?.bins).toBeUndefined();
    }
    for (const comboLineCol of [0, 5, -1, 1.5, "1"]) {
      const c = sanitizeChartConfig({ ...base, comboLineCol }, columns);
      expect(c).not.toBeNull();
      expect(c?.comboLineCol).toBeUndefined();
    }
  });
  it("未知の種類は破棄する", () => {
    expect(sanitizeChartConfig({ ...base, type: "radar" }, columns)).toBeNull();
  });
});
