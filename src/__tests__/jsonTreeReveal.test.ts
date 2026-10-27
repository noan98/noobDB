import { describe, expect, it } from "vitest";
import { FIRST_BATCH_REVEAL_MAX_STEPS, firstBatchRevealDelayMs } from "../components/firstBatchReveal";
import { jsonTreeRevealAnimation, visibleRevealTargets } from "../components/jsonTreeReveal";

const rows = Array.from({ length: 100 }, (_, i) => ({ top: i * 10, bottom: i * 10 + 10 }));

describe("visibleRevealTargets (#1863)", () => {
  it("ビューポートと重なる行だけを返し、下端に達したら打ち切る", () => {
    const measured: number[] = [];
    const out = visibleRevealTargets(
      rows.map((_, i) => i),
      (i) => {
        measured.push(i);
        return rows[i];
      },
      { top: 0, bottom: 55 },
      50,
    );
    expect(out).toEqual([0, 1, 2, 3, 4, 5]);
    // 計測は対象行 + 打ち切りの 1 行だけ。
    expect(measured.length).toBe(7);
  });

  it("上にスクロールアウトした行は数えない", () => {
    const out = visibleRevealTargets(
      rows.map((_, i) => i),
      (i) => rows[i],
      { top: 100, bottom: 130 },
      50,
    );
    expect(out).toEqual([10, 11, 12]);
  });

  it("ビューポート未計測なら先頭 fallbackMax 行まで", () => {
    const items = rows.map((_, i) => i);
    expect(visibleRevealTargets(items, (i) => rows[i], { top: 0, bottom: 0 }, 5)).toEqual([0, 1, 2, 3, 4]);
    expect(visibleRevealTargets(items, (i) => rows[i], { top: Number.NaN, bottom: Number.NaN }, 3)).toEqual([
      0, 1, 2,
    ]);
  });
});

describe("jsonTreeRevealAnimation (#1863)", () => {
  it("先頭は待たず、遅延は段数上限で頭打ち、fill は backwards", () => {
    expect(jsonTreeRevealAnimation(0).options.delay).toBe(0);
    const cap = firstBatchRevealDelayMs(FIRST_BATCH_REVEAL_MAX_STEPS - 1);
    expect(jsonTreeRevealAnimation(500).options.delay).toBe(cap);
    expect(jsonTreeRevealAnimation(0).options.fill).toBe("backwards");
  });
});
