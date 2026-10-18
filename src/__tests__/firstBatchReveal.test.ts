import { describe, expect, it } from "vitest";
import {
  FIRST_BATCH_REVEAL_FALLBACK_ROWS,
  FIRST_BATCH_REVEAL_MAX_STEPS,
  firstBatchRevealCount,
  firstBatchRevealDelayMs,
  firstBatchRevealTotalMs,
  isFirstBatchArrival,
} from "../components/firstBatchReveal";

describe("isFirstBatchArrival (#1579)", () => {
  it("スケルトン表示中 → 行が現れたときだけ true", () => {
    expect(isFirstBatchArrival(true, 1)).toBe(true);
    expect(isFirstBatchArrival(true, 500)).toBe(true);
  });
  it("行がまだ 0 件・スケルトン無し (追加バッチ / 通常表示) は false", () => {
    expect(isFirstBatchArrival(true, 0)).toBe(false);
    expect(isFirstBatchArrival(false, 10)).toBe(false);
    expect(isFirstBatchArrival(false, 0)).toBe(false);
  });
});

describe("firstBatchRevealCount (#1579)", () => {
  const tops = Array.from({ length: 40 }, (_, i) => i * 30);
  const at = (i: number) => tops[i];
  it("ビューポート内の行だけ数える (overscan の画面外は除く)", () => {
    expect(firstBatchRevealCount(40, at, 100)).toBe(4); // 0,30,60,90
  });
  it("上限は設けず、背の高い画面でも画面内の全行が対象", () => {
    expect(firstBatchRevealCount(40, at, 10_000)).toBe(40);
    expect(firstBatchRevealCount(40, at, 30 * 30 + 1)).toBe(31);
  });
  it("画面外に達した時点で計測を打ち切る (読み取りは対象行 + 1 回)", () => {
    let reads = 0;
    firstBatchRevealCount(40, (i) => (reads++, tops[i]), 100);
    expect(reads).toBe(5);
  });
  it("未計測 (0 / NaN) は上限内で全行、空なら 0", () => {
    expect(firstBatchRevealCount(5000, at, 0)).toBe(FIRST_BATCH_REVEAL_FALLBACK_ROWS);
    expect(firstBatchRevealCount(7, at, 0)).toBe(7);
    expect(firstBatchRevealCount(7, at, Number.NaN)).toBe(7);
    expect(firstBatchRevealCount(0, at, 100)).toBe(0);
  });
});

describe("firstBatchRevealDelayMs / TotalMs (#1579)", () => {
  it("先頭行は待たず、以降は stagger 間隔刻みで単調増加", () => {
    expect(firstBatchRevealDelayMs(0)).toBe(0);
    expect(firstBatchRevealDelayMs(1)).toBe(35);
    expect(firstBatchRevealDelayMs(11)).toBe(385);
  });
  it("段数の上限を超えた行は最終段と同じ遅延で頭打ち", () => {
    expect(firstBatchRevealDelayMs(FIRST_BATCH_REVEAL_MAX_STEPS)).toBe(385);
    expect(firstBatchRevealDelayMs(40)).toBe(385);
  });
  it("総所要時間は最終行の遅延 + 再生時間。0 行は 0", () => {
    expect(firstBatchRevealTotalMs(0)).toBe(0);
    expect(firstBatchRevealTotalMs(1)).toBe(180);
    expect(firstBatchRevealTotalMs(40)).toBe(385 + 180);
  });
});
