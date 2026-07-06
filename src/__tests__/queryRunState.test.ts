import { describe, expect, it } from "vitest";
import { accumulateRowCount, deriveQueryPhase, formatElapsed } from "../queryRunState";

describe("deriveQueryPhase", () => {
  it("returns idle for an empty input", () => {
    expect(deriveQueryPhase({})).toBe("idle");
  });

  it("returns done when a result is present and nothing else is active", () => {
    expect(deriveQueryPhase({ hasResult: true })).toBe("done");
  });

  it("returns connecting before a stream starts", () => {
    expect(deriveQueryPhase({ connecting: true })).toBe("connecting");
  });

  it("returns streaming while rows flow in", () => {
    expect(deriveQueryPhase({ streaming: true, hasResult: true })).toBe("streaming");
  });

  it("returns canceled when cut off (even with a partial result)", () => {
    expect(deriveQueryPhase({ canceled: true, hasResult: true })).toBe("canceled");
  });

  it("prioritises error over every other flag", () => {
    expect(
      deriveQueryPhase({ error: true, streaming: true, connecting: true, hasResult: true }),
    ).toBe("error");
  });

  it("prioritises connecting over streaming", () => {
    expect(deriveQueryPhase({ connecting: true, streaming: true })).toBe("connecting");
  });

  it("prioritises streaming over canceled/done", () => {
    expect(deriveQueryPhase({ streaming: true, canceled: true, hasResult: true })).toBe("streaming");
  });
});

describe("formatElapsed", () => {
  it("formats sub-minute times as mm:ss", () => {
    expect(formatElapsed(0)).toBe("00:00");
    expect(formatElapsed(999)).toBe("00:00");
    expect(formatElapsed(1000)).toBe("00:01");
    expect(formatElapsed(9000)).toBe("00:09");
    expect(formatElapsed(59_000)).toBe("00:59");
  });

  it("rolls into minutes", () => {
    expect(formatElapsed(60_000)).toBe("01:00");
    expect(formatElapsed(90_000)).toBe("01:30");
    expect(formatElapsed(599_000)).toBe("09:59");
  });

  it("adds an hours field past 60 minutes", () => {
    expect(formatElapsed(3_600_000)).toBe("1:00:00");
    expect(formatElapsed(3_661_000)).toBe("1:01:01");
  });

  it("clamps negatives and NaN to 00:00", () => {
    expect(formatElapsed(-5000)).toBe("00:00");
    expect(formatElapsed(NaN)).toBe("00:00");
  });
});

describe("accumulateRowCount", () => {
  it("adds a batch length to the running total", () => {
    expect(accumulateRowCount(0, 50)).toBe(50);
    expect(accumulateRowCount(50, 30)).toBe(80);
  });

  it("treats negative / non-finite inputs as zero", () => {
    expect(accumulateRowCount(-10, 5)).toBe(5);
    expect(accumulateRowCount(10, -5)).toBe(10);
    expect(accumulateRowCount(NaN, 5)).toBe(5);
    expect(accumulateRowCount(10, NaN)).toBe(10);
  });
});
