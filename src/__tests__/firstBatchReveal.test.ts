import { describe, expect, it } from "vitest";
import {
  FIRST_BATCH_REVEAL_MAX_ROWS,
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
  it("ビューポート内の行だけ数える (overscan の画面外は除く)", () => {
    expect(firstBatchRevealCount(tops, 100)).toBe(4); // 0,30,60,90
    expect(firstBatchRevealCount(tops, 0)).toBe(FIRST_BATCH_REVEAL_MAX_ROWS); // 未計測は上限のみ
    expect(firstBatchRevealCount(tops, Number.NaN, 5)).toBe(5);
  });
  it("上限でキャップする", () => {
    expect(firstBatchRevealCount(tops, 10_000)).toBe(FIRST_BATCH_REVEAL_MAX_ROWS);
    expect(firstBatchRevealCount(tops, 10_000, 3)).toBe(3);
  });
  it("行が少なければその数、空なら 0", () => {
    expect(firstBatchRevealCount([0, 30], 10_000)).toBe(2);
    expect(firstBatchRevealCount([], 10_000)).toBe(0);
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
    expect(firstBatchRevealDelayMs(FIRST_BATCH_REVEAL_MAX_ROWS - 1)).toBe(385);
  });
  it("総所要時間は最終行の遅延 + 再生時間。0 行は 0", () => {
    expect(firstBatchRevealTotalMs(0)).toBe(0);
    expect(firstBatchRevealTotalMs(1)).toBe(180);
    expect(firstBatchRevealTotalMs(FIRST_BATCH_REVEAL_MAX_ROWS)).toBe(385 + 180);
  });
});
