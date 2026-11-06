import { describe, it, expect } from "vitest";
import type { TimelapseGenerationMeta } from "../api/tauri";
import { formatCaptured, nearestStep, scrubberTicks, spreadPositions } from "../timelapseScrubber";

const g = (id: number, at: string, rows: number, truncated = false): TimelapseGenerationMeta => ({
  id,
  captured_at: at,
  row_count: rows,
  truncated,
  bytes: 0,
});

// 世代は新しい順で届く。
const gens = [
  g(3, "2026-01-01T01:00:00Z", 300, true),
  g(2, "2026-01-01T00:10:00Z", 100),
  g(1, "2026-01-01T00:00:00Z", 100),
];

describe("scrubberTicks (#2095)", () => {
  it("時系列に並べ直し、取得時刻に比例した位置に置く (等間隔にしない)", () => {
    const ticks = scrubberTicks(gens);
    expect(ticks.map((t) => t.id)).toEqual([1, 2, 3]);
    expect(ticks[0].x).toBe(0);
    expect(ticks[1].x).toBeCloseTo(10 / 60);
    expect(ticks[2].x).toBe(1);
  });

  it("行数は最小 0 〜 最大 1 に正規化し、全世代同数なら 0.5", () => {
    expect(scrubberTicks(gens).map((t) => t.y)).toEqual([0, 0, 1]);
    expect(
      scrubberTicks([g(2, "2026-01-02T00:00:00Z", 5), g(1, "2026-01-01T00:00:00Z", 5)]).map((t) => t.y),
    ).toEqual([0.5, 0.5]);
  });

  it("同時刻・不正な時刻は等間隔に退避する", () => {
    const same = scrubberTicks([g(2, "2026-01-01T00:00:00Z", 1), g(1, "2026-01-01T00:00:00Z", 2)]);
    expect(same.map((t) => t.x)).toEqual([0, 1]);
    expect(scrubberTicks([g(1, "bad", 1), g(2, "bad", 1)]).map((t) => t.x)).toEqual([0, 1]);
    expect(scrubberTicks([])).toEqual([]);
  });
});

describe("nearestStep", () => {
  it("段 1 以上の最寄りの目盛りを返す (最古は選べない)", () => {
    const ticks = scrubberTicks(gens);
    expect(nearestStep(ticks, 0)).toBe(1);
    expect(nearestStep(ticks, 0.9)).toBe(2);
    expect(nearestStep(ticks, 0.1)).toBe(1);
    expect(nearestStep(scrubberTicks([g(1, "2026-01-01T00:00:00Z", 1)]), 0.5)).toBeNull();
  });
});

describe("formatCaptured", () => {
  it("UI ロケールに合わせる", () => {
    expect(formatCaptured("2026-11-03T18:00:00Z", "ja")).toBe(
      new Date("2026-11-03T18:00:00Z").toLocaleString("ja-JP"),
    );
    expect(formatCaptured("2026-11-03T18:00:00Z", "en")).toBe(
      new Date("2026-11-03T18:00:00Z").toLocaleString("en-US"),
    );
    expect(formatCaptured("bad", "ja")).toBe("bad");
  });
});

describe("目盛りの最小間隔と単調性", () => {
  it("連続取得した世代でも目盛りが重ならず、時刻が逆転しても位置は戻らない", () => {
    const close = scrubberTicks([
      g(3, "2026-01-01T01:00:00Z", 1),
      g(2, "2026-01-01T00:00:01Z", 1),
      g(1, "2026-01-01T00:00:00Z", 1),
    ]);
    expect(close[1].x - close[0].x).toBeGreaterThanOrEqual(0.02 - 1e-9);
    expect(close[2].x).toBeLessThanOrEqual(1);
    const rev = scrubberTicks([
      g(3, "2026-01-01T00:00:00Z", 1),
      g(2, "2026-01-01T02:00:00Z", 1),
      g(1, "2026-01-01T01:00:00Z", 1),
    ]);
    for (let i = 1; i < rev.length; i++) expect(rev[i].x).toBeGreaterThan(rev[i - 1].x);
  });

  it("最古の世代の時刻が最大でも潰れず、隣接差が最小間隔以上になる", () => {
    const check = (gs: TimelapseGenerationMeta[]) => {
      const xs = scrubberTicks(gs).map((t) => t.x);
      for (let i = 1; i < xs.length; i++) expect(xs[i] - xs[i - 1]).toBeGreaterThanOrEqual(0.02 - 1e-9);
      expect(xs[0]).toBeGreaterThanOrEqual(0);
      expect(xs[xs.length - 1]).toBeLessThanOrEqual(1 + 1e-9);
    };
    // 新しい順で届く: 時系列は id1@02:00, id2@00:00, id3@01:00。
    check([
      g(3, "2026-01-01T01:00:00Z", 1),
      g(2, "2026-01-01T00:00:00Z", 1),
      g(1, "2026-01-01T02:00:00Z", 1),
    ]);
  });

  it("spreadPositions は [0.99, 0, 1] でも単調で間隔を保つ", () => {
    const xs = spreadPositions([0.99, 0, 1]);
    for (let i = 1; i < xs.length; i++) expect(xs[i] - xs[i - 1]).toBeGreaterThanOrEqual(0.02 - 1e-9);
    expect(xs[2]).toBeLessThanOrEqual(1);
  });
});
