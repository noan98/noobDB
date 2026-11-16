import { describe, expect, it } from "vitest";
import type { CellValue } from "../api/tauri";
import {
  binFilterBounds,
  binHeightRatios,
  binRangeLabel,
  binnedTotal,
  advanceDistribution,
  computeColumnDistribution,
  createDistributionAccumulator,
  finishDistribution,
  DIST_BIN_COUNT,
  distributionModeFor,
  parseDateMs,
  topWidthRatios,
} from "../components/gridColumnDistribution";

const col = (vals: CellValue[]): CellValue[][] => vals.map((v) => [v]);

describe("distributionModeFor", () => {
  it("型ごとに分布の種類を決める", () => {
    expect(distributionModeFor("number")).toBe("number");
    expect(distributionModeFor("decimal")).toBe("number");
    expect(distributionModeFor("date")).toBe("date");
    expect(distributionModeFor("string")).toBe("top");
    expect(distributionModeFor("bool")).toBe("top");
    expect(distributionModeFor("enum")).toBe("top");
    expect(distributionModeFor("json")).toBe("none");
    expect(distributionModeFor("binary")).toBe("none");
  });
});

describe("数値のヒストグラム", () => {
  it("値の種類が少ない整数は 1 値 1 ビンで、件数と境界が正確", () => {
    const d = computeColumnDistribution(col([1, 1, 2, 3, 3, 3, null]), 0, "number");
    expect(d.bins.map((b) => [b.lo, b.hi, b.count])).toEqual([
      [1, 1, 2],
      [2, 2, 1],
      [3, 3, 3],
    ]);
    expect(d.nulls).toBe(1);
    expect(d.integerBins).toBe(true);
    expect(binFilterBounds(d, 2)).toEqual({ lo: "3", hi: "3" });
  });

  it("広い整数は 16 ビン。隣のビンと境界が重ならず、合計が一致する", () => {
    const rows = col(Array.from({ length: 1000 }, (_, i) => i));
    const d = computeColumnDistribution(rows, 0, "number");
    expect(d.bins.length).toBeLessThanOrEqual(DIST_BIN_COUNT);
    expect(binnedTotal(d)).toBe(1000);
    for (let i = 1; i < d.bins.length; i++) expect(d.bins[i].lo).toBe(d.bins[i - 1].hi + 1);
    expect(d.bins[0].lo).toBe(0);
    expect(d.bins[d.bins.length - 1].hi).toBe(999);
    // 各ビンの範囲に含まれる行数が件数と一致する (フィルタで絞ったときの件数)。
    for (const b of d.bins) {
      const n = rows.filter((r) => (r[0] as number) >= b.lo && (r[0] as number) <= b.hi).length;
      expect(n).toBe(b.count);
    }
  });

  it("小数は連続ビン、文字列の数値 (DECIMAL) も数える。最大値は最後のビンに入る", () => {
    const d = computeColumnDistribution(col(["0.5", "1.5", "2.5", "10"]), 0, "decimal");
    expect(binnedTotal(d)).toBe(4);
    expect(d.integerBins).toBe(false);
    expect(d.bins[d.bins.length - 1].count).toBeGreaterThanOrEqual(1);
  });

  it("定数列は 1 ビン、解釈できない値はビンに入れない", () => {
    expect(computeColumnDistribution(col([5, 5, 5]), 0, "number").bins).toHaveLength(1);
    const d = computeColumnDistribution(col(["x", "y"]), 0, "number");
    expect(d.bins).toEqual([]);
    expect(d.filterable).toBe(false);
  });

  it("安全整数を超える値は範囲フィルタに使わない", () => {
    const d = computeColumnDistribution(col(["9223372036854775807", "1"]), 0, "number");
    expect(d.filterable).toBe(false);
    expect(binFilterBounds(d, 0)).toBeNull();
  });

  it("高さ比は最大ビンが 1", () => {
    const d = computeColumnDistribution(col([1, 1, 1, 2]), 0, "number");
    expect(binHeightRatios(d.bins)).toEqual([1, 1 / 3]);
  });

  it("ビンのラベル", () => {
    const d = computeColumnDistribution(col(Array.from({ length: 100 }, (_, i) => i * 1000)), 0, "number");
    expect(binRangeLabel(d, 0)).toMatch(/^0 – /);
  });
});

describe("日付のヒストグラム", () => {
  it("日付と日時を ms に直す", () => {
    expect(parseDateMs("2024-01-02")).toBe(Date.UTC(2024, 0, 2));
    expect(parseDateMs("2024-01-02 10:00:00")).toBe(Date.UTC(2024, 0, 2, 10));
    expect(parseDateMs("2024-01-02T10:00:00+09:00")).toBe(Date.UTC(2024, 0, 2, 1));
    expect(Number.isNaN(parseDateMs("abc"))).toBe(true);
    expect(Number.isNaN(parseDateMs(null))).toBe(true);
  });

  it("範囲を等分し、範囲フィルタは使わない", () => {
    const rows = col(
      Array.from({ length: 40 }, (_, i) => `2024-01-${String((i % 28) + 1).padStart(2, "0")}`),
    );
    const d = computeColumnDistribution(rows, 0, "date");
    expect(d.bins).toHaveLength(DIST_BIN_COUNT);
    expect(binnedTotal(d)).toBe(40);
    expect(d.filterable).toBe(false);
    expect(binRangeLabel(d, 0)).toMatch(/^2024-01-01 – 2024-01-/);
  });
});

describe("上位 3 値", () => {
  it("件数の多い順に 3 値と、その他の件数", () => {
    const d = computeColumnDistribution(col(["a", "b", "b", "c", "c", "c", "d", "e", null]), 0, "string");
    expect(d.top.map((t) => [t.label, t.count])).toEqual([
      ["c", 3],
      ["b", 2],
      ["a", 1],
    ]);
    expect(d.otherCount).toBe(2);
    const { parts, other } = topWidthRatios(d);
    expect(parts[0] + parts[1] + parts[2] + other).toBeCloseTo(1);
  });

  it("真偽値", () => {
    const d = computeColumnDistribution(col([true, false, true, null]), 0, "bool");
    expect(d.top[0]).toEqual({ label: "true", value: "true", count: 2 });
  });

  it("同数は値の昇順で安定、長い値は切り詰める", () => {
    const d = computeColumnDistribution(col(["b", "a", "x".repeat(100)]), 0, "string");
    expect(d.top[0].label).toBe("a");
    expect(d.top[2].label.endsWith("…")).toBe(true);
  });
});

describe("一意度と NULL", () => {
  it("全行が一意で NULL が無いときだけ unique", () => {
    expect(computeColumnDistribution(col([1, 2, 3]), 0, "number").unique).toBe(true);
    expect(computeColumnDistribution(col([1, 2, 2]), 0, "number").unique).toBe(false);
    expect(computeColumnDistribution(col([1, 2, null]), 0, "number").unique).toBe(false);
    expect(computeColumnDistribution(col(["a"]), 0, "string").unique).toBe(false);
  });

  it("JSON / BLOB は NULL 率だけ (分布も unique も無し)", () => {
    const d = computeColumnDistribution(col(["{}", null, "{}", null]), 0, "json");
    expect(d.mode).toBe("none");
    expect(d.nulls).toBe(2);
    expect(d.bins).toEqual([]);
    expect(d.top).toEqual([]);
    expect(d.unique).toBe(false);
  });

  it("全部 NULL の列でも落ちない", () => {
    const d = computeColumnDistribution(col([null, null]), 0, "number");
    expect(d.nulls).toBe(2);
    expect(d.bins).toEqual([]);
    expect(topWidthRatios(computeColumnDistribution(col([null]), 0, "string")).parts).toEqual([]);
  });
});

describe("再開型の計算", () => {
  it("分割して進めた結果が一括計算と一致する", () => {
    const rows = col(Array.from({ length: 1234 }, (_, i) => (i % 7 === 0 ? null : (i * 37) % 501)));
    const acc = createDistributionAccumulator(rows.length, 0, "number");
    let steps = 0;
    while (!advanceDistribution(acc, rows, 100)) steps++;
    expect(steps).toBeGreaterThan(5);
    expect(finishDistribution(acc)).toEqual(computeColumnDistribution(rows, 0, "number"));
  });

  it("10 万行でも 1 スライス (5,000 行) は短時間で終わる", () => {
    const n = 100_000;
    const rows: CellValue[][] = Array.from({ length: n }, (_, i) => [
      `2024-${String((i % 12) + 1).padStart(2, "0")}-15 10:20:30`,
      String(i * 1.5),
    ]);
    for (const [c, kind] of [
      [0, "date"],
      [1, "decimal"],
    ] as const) {
      const acc = createDistributionAccumulator(n, c, kind);
      let worst = 0;
      for (;;) {
        const t0 = performance.now();
        const done = advanceDistribution(acc, rows, 5000);
        worst = Math.max(worst, performance.now() - t0);
        if (done) break;
      }
      expect(worst).toBeLessThan(250);
    }
  });

  it("日時の速い経路が Date.parse と一致する", () => {
    for (const s of ["2024-02-29 23:59:59", "2024-02-29T00:00:00.123", "1999-12-31"]) {
      expect(parseDateMs(s)).toBe(
        Date.parse(
          s.includes("T") || s.length === 10
            ? `${s}${s.length === 10 ? "" : "Z"}`
            : `${s.replace(" ", "T")}Z`,
        ),
      );
    }
  });
});

describe("計算時間", () => {
  it("10 万行 x 4 列 (数値・日付・文字列・真偽値) が現実的な時間で終わる", () => {
    const n = 100_000;
    const rows: CellValue[][] = Array.from({ length: n }, (_, i) => [
      i,
      `2024-${String((i % 12) + 1).padStart(2, "0")}-15`,
      `v${i % 50}`,
      i % 3 === 0,
    ]);
    const kinds = ["number", "date", "string", "bool"] as const;
    const start = performance.now();
    for (let c = 0; c < kinds.length; c++) computeColumnDistribution(rows, c, kinds[c]);
    expect(performance.now() - start).toBeLessThan(5000);
  });
});
