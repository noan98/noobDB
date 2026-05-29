import { describe, expect, it } from "vitest";

import {
  AUTO_REFRESH_INTERVAL_OPTIONS,
  AUTO_REFRESH_MIN_SECS,
  DEFAULT_AUTO_REFRESH_SECS,
  sanitizeAutoRefreshSecs,
} from "../settings";

describe("sanitizeAutoRefreshSecs", () => {
  it("keeps valid in-range cadences", () => {
    for (const secs of AUTO_REFRESH_INTERVAL_OPTIONS) {
      expect(sanitizeAutoRefreshSecs(secs, DEFAULT_AUTO_REFRESH_SECS)).toBe(secs);
    }
  });

  it("clamps cadences below the minimum up to the floor", () => {
    expect(sanitizeAutoRefreshSecs(1, DEFAULT_AUTO_REFRESH_SECS)).toBe(AUTO_REFRESH_MIN_SECS);
    expect(sanitizeAutoRefreshSecs(0, DEFAULT_AUTO_REFRESH_SECS)).toBe(AUTO_REFRESH_MIN_SECS);
    expect(sanitizeAutoRefreshSecs(-30, DEFAULT_AUTO_REFRESH_SECS)).toBe(AUTO_REFRESH_MIN_SECS);
  });

  it("clamps cadences above the ceiling down to the cap", () => {
    expect(sanitizeAutoRefreshSecs(999_999, DEFAULT_AUTO_REFRESH_SECS)).toBe(3_600);
  });

  it("floors fractional values", () => {
    expect(sanitizeAutoRefreshSecs(10.9, DEFAULT_AUTO_REFRESH_SECS)).toBe(10);
  });

  it("falls back when the input is not a finite number", () => {
    expect(sanitizeAutoRefreshSecs("30", DEFAULT_AUTO_REFRESH_SECS)).toBe(DEFAULT_AUTO_REFRESH_SECS);
    expect(sanitizeAutoRefreshSecs(NaN, DEFAULT_AUTO_REFRESH_SECS)).toBe(DEFAULT_AUTO_REFRESH_SECS);
    expect(sanitizeAutoRefreshSecs(undefined, DEFAULT_AUTO_REFRESH_SECS)).toBe(
      DEFAULT_AUTO_REFRESH_SECS,
    );
  });
});
