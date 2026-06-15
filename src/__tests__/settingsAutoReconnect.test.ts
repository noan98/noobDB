import { describe, expect, it } from "vitest";

import {
  DEFAULT_AUTO_RECONNECT_MAX_RETRIES,
  MAX_AUTO_RECONNECT_RETRIES,
  MIN_AUTO_RECONNECT_RETRIES,
  sanitizeAutoReconnectRetries,
} from "../settings";

describe("sanitizeAutoReconnectRetries (#600)", () => {
  it("keeps valid in-range retry counts", () => {
    expect(sanitizeAutoReconnectRetries(3, DEFAULT_AUTO_RECONNECT_MAX_RETRIES)).toBe(3);
    expect(
      sanitizeAutoReconnectRetries(MAX_AUTO_RECONNECT_RETRIES, DEFAULT_AUTO_RECONNECT_MAX_RETRIES),
    ).toBe(MAX_AUTO_RECONNECT_RETRIES);
  });

  it("clamps below the minimum and above the maximum", () => {
    expect(sanitizeAutoReconnectRetries(0, DEFAULT_AUTO_RECONNECT_MAX_RETRIES)).toBe(
      MIN_AUTO_RECONNECT_RETRIES,
    );
    expect(sanitizeAutoReconnectRetries(-5, DEFAULT_AUTO_RECONNECT_MAX_RETRIES)).toBe(
      MIN_AUTO_RECONNECT_RETRIES,
    );
    expect(sanitizeAutoReconnectRetries(999, DEFAULT_AUTO_RECONNECT_MAX_RETRIES)).toBe(
      MAX_AUTO_RECONNECT_RETRIES,
    );
  });

  it("floors fractional values", () => {
    expect(sanitizeAutoReconnectRetries(5.9, DEFAULT_AUTO_RECONNECT_MAX_RETRIES)).toBe(5);
  });

  it("falls back when the input is not a finite number", () => {
    expect(sanitizeAutoReconnectRetries("5", DEFAULT_AUTO_RECONNECT_MAX_RETRIES)).toBe(
      DEFAULT_AUTO_RECONNECT_MAX_RETRIES,
    );
    expect(sanitizeAutoReconnectRetries(NaN, DEFAULT_AUTO_RECONNECT_MAX_RETRIES)).toBe(
      DEFAULT_AUTO_RECONNECT_MAX_RETRIES,
    );
    expect(sanitizeAutoReconnectRetries(undefined, DEFAULT_AUTO_RECONNECT_MAX_RETRIES)).toBe(
      DEFAULT_AUTO_RECONNECT_MAX_RETRIES,
    );
  });
});
