import { describe, expect, it } from "vitest";
import { firstLineForNotification, shouldNotifyQueryCompletion } from "../queryNotify";

describe("shouldNotifyQueryCompletion (#707)", () => {
  const base = { enabled: true, elapsedMs: 20_000, thresholdSecs: 10, windowFocused: false };

  it("notifies when unfocused and over the threshold", () => {
    expect(shouldNotifyQueryCompletion(base)).toBe(true);
  });

  it("does not notify when the window is focused", () => {
    expect(shouldNotifyQueryCompletion({ ...base, windowFocused: true })).toBe(false);
  });

  it("does not notify when disabled in settings", () => {
    expect(shouldNotifyQueryCompletion({ ...base, enabled: false })).toBe(false);
  });

  it("does not notify below the threshold", () => {
    expect(shouldNotifyQueryCompletion({ ...base, elapsedMs: 5_000 })).toBe(false);
  });

  it("notifies exactly at the threshold boundary", () => {
    expect(shouldNotifyQueryCompletion({ ...base, elapsedMs: 10_000, thresholdSecs: 10 })).toBe(
      true,
    );
  });

  it("treats a zero threshold as always eligible once unfocused", () => {
    expect(shouldNotifyQueryCompletion({ ...base, elapsedMs: 0, thresholdSecs: 0 })).toBe(true);
  });

  it("clamps a negative threshold to zero instead of rejecting", () => {
    expect(shouldNotifyQueryCompletion({ ...base, elapsedMs: 0, thresholdSecs: -5 })).toBe(true);
  });

  it("rejects NaN/Infinity inputs defensively", () => {
    expect(shouldNotifyQueryCompletion({ ...base, elapsedMs: Number.NaN })).toBe(false);
    expect(shouldNotifyQueryCompletion({ ...base, thresholdSecs: Number.POSITIVE_INFINITY })).toBe(
      false,
    );
  });
});

describe("firstLineForNotification (#707)", () => {
  it("returns the whole string when short and single-line", () => {
    expect(firstLineForNotification("syntax error near SELECT")).toBe(
      "syntax error near SELECT",
    );
  });

  it("keeps only the first line of a multi-line error", () => {
    expect(firstLineForNotification("line one\nline two\nline three")).toBe("line one");
  });

  it("handles CRLF line endings", () => {
    expect(firstLineForNotification("line one\r\nline two")).toBe("line one");
  });

  it("truncates an overly long single line with an ellipsis", () => {
    const long = "x".repeat(250);
    const result = firstLineForNotification(long, 200);
    expect(result.length).toBe(201); // 200 chars + ellipsis
    expect(result.endsWith("…")).toBe(true);
  });
});
