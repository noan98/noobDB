import { describe, it, expect } from "vitest";
import { estimateEtaMs, formatDuration, progressRatio, waitSecondsLeft } from "../progressEta";

describe("progressEta (#2092)", () => {
  it("progressRatio: 総数不明・0 は null、範囲外はクランプ", () => {
    expect(progressRatio(5, null)).toBeNull();
    expect(progressRatio(5, undefined)).toBeNull();
    expect(progressRatio(5, 0)).toBeNull();
    expect(progressRatio(0, 10)).toBe(0);
    expect(progressRatio(-3, 10)).toBe(0);
    expect(progressRatio(5, 10)).toBe(0.5);
    expect(progressRatio(15, 10)).toBe(1);
    expect(progressRatio(Number.NaN, 10)).toBe(0);
  });

  it("estimateEtaMs: 速度 0・総数不明は null、完了済みは 0", () => {
    expect(estimateEtaMs(0, 100, 5000)).toBeNull();
    expect(estimateEtaMs(10, 100, 0)).toBeNull();
    expect(estimateEtaMs(10, null, 5000)).toBeNull();
    expect(estimateEtaMs(10, 0, 5000)).toBeNull();
    expect(estimateEtaMs(100, 100, 5000)).toBe(0);
    expect(estimateEtaMs(120, 100, 5000)).toBe(0);
    expect(estimateEtaMs(Number.NaN, 100, 5000)).toBeNull();
  });

  it("estimateEtaMs: 平均速度から残り時間を見積もる", () => {
    expect(estimateEtaMs(25, 100, 10_000)).toBe(30_000);
    expect(estimateEtaMs(1, 3, 1000)).toBe(2000);
  });

  it("formatDuration: m:ss / h:mm:ss、不正値は 0:00", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(-5)).toBe("0:00");
    expect(formatDuration(Number.NaN)).toBe("0:00");
    expect(formatDuration(59_999)).toBe("0:59");
    expect(formatDuration(61_000)).toBe("1:01");
    expect(formatDuration(3_661_000)).toBe("1:01:01");
  });

  it("waitSecondsLeft: 待機中でなければ null、切り上げ、期限超過は 0", () => {
    expect(waitSecondsLeft(null, 1000)).toBeNull();
    expect(waitSecondsLeft(2500, 1000)).toBe(2);
    expect(waitSecondsLeft(2000, 1000)).toBe(1);
    expect(waitSecondsLeft(1000, 2000)).toBe(0);
  });
});
