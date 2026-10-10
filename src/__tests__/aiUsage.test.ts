import { describe, expect, it } from "vitest";
import {
  addUsage,
  emptyUsageTotals,
  formatTokens,
  jstMonthKey,
  rollUsageMonth,
  sanitizeAiUsageTotals,
  sumUsage,
  summarizeUsage,
  type AiUsageEventLike,
} from "../ai/aiUsage";

const ev = (over: Partial<AiUsageEventLike> = {}): AiUsageEventLike => ({
  model: "claude-opus-5-5",
  requestedModel: "claude-opus-5-5",
  fallbackUsed: false,
  usage: { inputTokens: 3200, outputTokens: 800, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
  ...over,
});

describe("jstMonthKey", () => {
  it("UTC 月末 14:59 は JST でもまだ同じ月", () => {
    expect(jstMonthKey(new Date("2026-09-30T14:59:59Z"))).toBe("2026-09");
  });
  it("UTC 月末 15:00 は JST では翌月 1 日 0 時", () => {
    expect(jstMonthKey(new Date("2026-09-30T15:00:00Z"))).toBe("2026-10");
  });
  it("年またぎ", () => {
    expect(jstMonthKey(new Date("2026-12-31T15:00:00Z"))).toBe("2027-01");
    expect(jstMonthKey(new Date("2026-12-31T14:59:59Z"))).toBe("2026-12");
  });
});

describe("addUsage / rollUsageMonth", () => {
  const now = new Date("2026-10-10T00:00:00Z");
  it("応答モデル別に加算する", () => {
    let t = emptyUsageTotals(now);
    t = addUsage(t, ev(), now);
    t = addUsage(t, ev({ model: "claude-sonnet-5-5", fallbackUsed: true }), now);
    t = addUsage(t, ev(), now);
    expect(t.byModel["claude-opus-5-5"]).toMatchObject({ requests: 2, inputTokens: 6400, outputTokens: 1600 });
    expect(t.byModel["claude-sonnet-5-5"].requests).toBe(1);
    expect(sumUsage(t)).toMatchObject({ requests: 3, inputTokens: 9600 });
  });
  it("入力を破壊しない", () => {
    const t = emptyUsageTotals(now);
    addUsage(t, ev(), now);
    expect(t.byModel).toEqual({});
  });
  it("月が変わると数え直す (JST 境界)", () => {
    const sep = new Date("2026-09-30T14:59:59Z");
    const oct = new Date("2026-09-30T15:00:00Z");
    let t = addUsage(emptyUsageTotals(sep), ev(), sep);
    expect(t.month).toBe("2026-09");
    expect(rollUsageMonth(t, sep)).toBe(t);
    expect(rollUsageMonth(t, oct)).toEqual({ month: "2026-10", byModel: {} });
    t = addUsage(t, ev(), oct);
    expect(t.month).toBe("2026-10");
    expect(sumUsage(t).requests).toBe(1);
  });
});

describe("sanitizeAiUsageTotals", () => {
  const now = new Date("2026-10-10T00:00:00Z");
  it("壊れた値は空にする", () => {
    expect(sanitizeAiUsageTotals(null, now)).toEqual({ month: "2026-10", byModel: {} });
    expect(sanitizeAiUsageTotals({ month: "x" }, now).month).toBe("2026-10");
  });
  it("不正な数値は 0 に丸める", () => {
    const t = sanitizeAiUsageTotals({ month: "2026-09", byModel: { m: { requests: -1, inputTokens: "a", outputTokens: 5.9 } } }, now);
    expect(t.month).toBe("2026-09");
    expect(t.byModel.m).toEqual({
      requests: 0,
      inputTokens: 0,
      outputTokens: 5,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    });
  });
});

describe("formatTokens / summarizeUsage", () => {
  it("短縮表記", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(3200)).toBe("3.2k");
    expect(formatTokens(800)).toBe("800");
    expect(formatTokens(1_250_000)).toBe("1.3M");
    expect(formatTokens(999_999)).toBe("1M");
  });
  it("フォールバックとキャッシュ読み取り", () => {
    const s = summarizeUsage(
      ev({
        model: "claude-sonnet-5-5",
        fallbackUsed: true,
        usage: { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 2000, cacheCreationInputTokens: 0 },
      }),
    );
    expect(s).toEqual({
      model: "Claude Sonnet 5.5",
      fallbackFrom: "Claude Opus 5.5",
      input: "100",
      output: "50",
      cacheRead: "2k",
    });
    expect(summarizeUsage(ev()).fallbackFrom).toBeNull();
    expect(summarizeUsage(ev()).cacheRead).toBeNull();
  });
});
