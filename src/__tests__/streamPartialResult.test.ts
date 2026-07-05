import { describe, expect, it } from "vitest";
import {
  cancelledPartialResult,
  resolveCancelledRows,
  timeoutPartialResult,
} from "../streamPartialResult";

describe("resolveCancelledRows", () => {
  it("prefers the backend-reported delivered row count when present", () => {
    expect(resolveCancelledRows(42, 999)).toBe(42);
  });

  it("prefers a reported count of exactly 0 over the fallback", () => {
    // 0 is falsy but a legitimate answer (the cancel raced the very first
    // batch) — must not be treated the same as "no report".
    expect(resolveCancelledRows(0, 999)).toBe(0);
  });

  it("falls back to the grid's accumulated row count when the backend has no report", () => {
    expect(resolveCancelledRows(null, 17)).toBe(17);
  });
});

describe("cancelledPartialResult", () => {
  it("tags the reason as cancelled and carries the resolved row count", () => {
    expect(cancelledPartialResult(5, 100)).toEqual({ reason: "cancelled", rows: 5 });
    expect(cancelledPartialResult(null, 100)).toEqual({ reason: "cancelled", rows: 100 });
  });
});

describe("timeoutPartialResult", () => {
  it("tags the reason as timeout and carries the delivered row count verbatim", () => {
    expect(timeoutPartialResult(9)).toEqual({ reason: "timeout", rows: 9 });
    expect(timeoutPartialResult(0)).toEqual({ reason: "timeout", rows: 0 });
  });
});
