import { describe, expect, it } from "vitest";
import type { ServerMetrics } from "../api/tauri";
import {
  counterRate,
  deriveSeries,
  extractSeries,
  formatCount,
  formatRate,
  hasSeriesData,
  pushSample,
  throughputUnitKey,
  type MetricSample,
} from "../components/serverMetrics";

function metrics(over: Partial<ServerMetrics> = {}): ServerMetrics {
  return {
    connections: null,
    active: null,
    idle_in_transaction: null,
    lock_waiting: null,
    questions: null,
    slow_queries: null,
    lock_waits: null,
    ...over,
  };
}

function sample(atMs: number, over: Partial<ServerMetrics> = {}): MetricSample {
  return { atMs, metrics: metrics(over) };
}

describe("counterRate", () => {
  it("累積差分を毎秒レートに換算する", () => {
    // 1000 件増 / 2 秒 = 500/s
    expect(counterRate(1000, 3000, 2000)).toBe(1000);
    expect(counterRate(0, 500, 1000)).toBe(500);
  });

  it("どちらかが null なら null", () => {
    expect(counterRate(null, 100, 1000)).toBeNull();
    expect(counterRate(100, null, 1000)).toBeNull();
  });

  it("経過時間が 0 以下なら null (最初のサンプル/同時刻)", () => {
    expect(counterRate(100, 200, 0)).toBeNull();
    expect(counterRate(100, 200, -5)).toBeNull();
  });

  it("カウンタが逆行 (統計リセット) したら負値でなく null を返す", () => {
    expect(counterRate(5000, 10, 1000)).toBeNull();
  });
});

describe("pushSample", () => {
  it("入力を変更せず新しい配列を返す", () => {
    const buf: MetricSample[] = [sample(1000)];
    const next = pushSample(buf, sample(2000), 60_000);
    expect(buf).toHaveLength(1);
    expect(next).toHaveLength(2);
  });

  it("時間窓より古いサンプルを落とす", () => {
    const buf = [sample(1000), sample(2000), sample(3000)];
    // 窓 = 1500ms、新サンプル 4000 → cutoff 2500。1000/2000 は窓外。
    const next = pushSample(buf, sample(4000), 1500);
    expect(next.map((s) => s.atMs)).toEqual([3000, 4000]);
  });

  it("maxSamples を超えたら古い方から切り詰める", () => {
    const buf = [sample(1000), sample(2000), sample(3000)];
    const next = pushSample(buf, sample(4000), 1_000_000, 2);
    expect(next.map((s) => s.atMs)).toEqual([3000, 4000]);
  });
});

describe("deriveSeries", () => {
  it("ゲージはそのまま、レートは直前サンプルとの差分から算出する", () => {
    const samples = [
      sample(1000, { connections: 10, questions: 100, lock_waiting: 0 }),
      sample(2000, { connections: 12, questions: 700, lock_waiting: 2 }),
    ];
    const points = deriveSeries(samples);
    expect(points).toHaveLength(2);
    // 先頭点は直前が無いのでレートは null、ゲージは値。
    expect(points[0]).toMatchObject({ connections: 10, lockWaiting: 0, queryRate: null });
    // 2 点目: (700-100)/1s = 600 QPS。
    expect(points[1]).toMatchObject({ connections: 12, lockWaiting: 2, queryRate: 600 });
  });

  it("reset したカウンタ区間のレートは null になる", () => {
    const samples = [
      sample(1000, { questions: 5000 }),
      sample(2000, { questions: 10 }),
    ];
    const points = deriveSeries(samples);
    expect(points[1].queryRate).toBeNull();
  });
});

describe("extractSeries / hasSeriesData", () => {
  it("null/非有限値を落として {atMs,value} 列にする", () => {
    const points = deriveSeries([
      sample(1000, { connections: 10 }),
      sample(2000, { connections: null }),
      sample(3000, { connections: 15 }),
    ]);
    expect(extractSeries(points, "connections")).toEqual([
      { atMs: 1000, value: 10 },
      { atMs: 3000, value: 15 },
    ]);
  });

  it("どのキーにもデータが無ければ hasSeriesData は false", () => {
    const points = deriveSeries([sample(1000), sample(2000)]);
    expect(hasSeriesData(points, ["connections", "queryRate"])).toBe(false);
  });

  it("1 点でもデータがあれば true", () => {
    const points = deriveSeries([
      sample(1000, { connections: 3 }),
      sample(2000, { connections: 4 }),
    ]);
    expect(hasSeriesData(points, ["connections"])).toBe(true);
  });
});

describe("throughputUnitKey", () => {
  it("PostgreSQL は TPS、それ以外は QPS ラベルを使う", () => {
    expect(throughputUnitKey("postgres")).toBe("metricsTpsUnit");
    expect(throughputUnitKey("mysql")).toBe("metricsQpsUnit");
    expect(throughputUnitKey("sqlite")).toBe("metricsQpsUnit");
  });
});

describe("formatRate / formatCount", () => {
  it("レートを桁に応じて丸める", () => {
    expect(formatRate(1.234)).toBe("1.23");
    expect(formatRate(12.34)).toBe("12.3");
    expect(formatRate(340.6)).toBe("341");
    expect(formatRate(15_000)).toBe("15.0k");
  });

  it("null/負値/非有限は '–'", () => {
    expect(formatRate(null)).toBe("–");
    expect(formatRate(-1)).toBe("–");
    expect(formatRate(Infinity)).toBe("–");
    expect(formatCount(null)).toBe("–");
    expect(formatCount(NaN)).toBe("–");
  });

  it("カウントは整数に丸める", () => {
    expect(formatCount(42)).toBe("42");
    expect(formatCount(42.7)).toBe("43");
  });
});
