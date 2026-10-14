import { describe, expect, it } from "vitest";
import { formatTokens, summarizeUsage, type AiUsageEventLike } from "../ai/aiUsage";

const ev = (over: Partial<AiUsageEventLike> = {}): AiUsageEventLike => ({
  model: "claude-opus-5-5",
  requestedModel: "claude-opus-5-5",
  fallbackUsed: false,
  usage: { inputTokens: 3200, outputTokens: 800, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
  ...over,
});

describe("summarizeUsage キャッシュ作成", () => {
  it("キャッシュ書き込みは 0 より大きいときだけ併記する", () => {
    const s = summarizeUsage(
      ev({
        usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 1500 },
      }),
    );
    expect(s.cacheWrite).toBe("1.5k");
    expect(s.cacheRead).toBeNull();
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
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadInputTokens: 2000,
          cacheCreationInputTokens: 0,
        },
      }),
    );
    expect(s).toEqual({
      model: "Claude Sonnet 5.5",
      fallbackFrom: "Claude Opus 5.5",
      input: "100",
      output: "50",
      cacheWrite: null,
      cacheRead: "2k",
    });
    expect(s.cacheWrite).toBeNull();
    expect(summarizeUsage(ev()).fallbackFrom).toBeNull();
    expect(summarizeUsage(ev()).cacheRead).toBeNull();
  });
});
