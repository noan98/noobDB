import { describe, it, expect } from "vitest";
import {
  backoffDelayMs,
  reconnectSchedule,
  shouldAutoReconnect,
  RECONNECT_BASE_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
} from "../reconnect";

/**
 * 自動再接続 (#600) の純ロジックを固定する。バックオフが指数で伸びて上限で
 * 頭打ちになること、トランザクション中やリトライ上限超過では再接続を弾くことを
 * 検証する。
 */
describe("backoffDelayMs", () => {
  it("doubles each attempt starting from the base delay", () => {
    expect(backoffDelayMs(0)).toBe(RECONNECT_BASE_DELAY_MS);
    expect(backoffDelayMs(1)).toBe(RECONNECT_BASE_DELAY_MS * 2);
    expect(backoffDelayMs(2)).toBe(RECONNECT_BASE_DELAY_MS * 4);
    expect(backoffDelayMs(3)).toBe(RECONNECT_BASE_DELAY_MS * 8);
  });

  it("caps at the maximum delay for large attempts", () => {
    expect(backoffDelayMs(100)).toBe(RECONNECT_MAX_DELAY_MS);
    // 2**attempt が Infinity になる領域でも max で頭打ち。
    expect(backoffDelayMs(1000)).toBe(RECONNECT_MAX_DELAY_MS);
  });

  it("treats negative / non-finite attempts as the first attempt", () => {
    expect(backoffDelayMs(-5)).toBe(RECONNECT_BASE_DELAY_MS);
    expect(backoffDelayMs(Number.NaN)).toBe(RECONNECT_BASE_DELAY_MS);
  });

  it("honors custom base / max options", () => {
    expect(backoffDelayMs(0, { baseMs: 500, maxMs: 4000 })).toBe(500);
    expect(backoffDelayMs(1, { baseMs: 500, maxMs: 4000 })).toBe(1000);
    expect(backoffDelayMs(3, { baseMs: 500, maxMs: 4000 })).toBe(4000);
    expect(backoffDelayMs(10, { baseMs: 500, maxMs: 4000 })).toBe(4000);
  });
});

describe("reconnectSchedule", () => {
  it("lists one delay per retry, monotonically non-decreasing", () => {
    const schedule = reconnectSchedule(5);
    expect(schedule).toHaveLength(5);
    expect(schedule[0]).toBe(RECONNECT_BASE_DELAY_MS);
    for (let i = 1; i < schedule.length; i++) {
      expect(schedule[i]).toBeGreaterThanOrEqual(schedule[i - 1]);
    }
  });

  it("is empty for zero / negative retry counts", () => {
    expect(reconnectSchedule(0)).toEqual([]);
    expect(reconnectSchedule(-3)).toEqual([]);
  });
});

describe("shouldAutoReconnect", () => {
  const base = { enabled: true, inTransaction: false, attempt: 0, maxRetries: 5 };

  it("allows reconnect while enabled, not in a transaction, and under the cap", () => {
    expect(shouldAutoReconnect(base)).toBe(true);
    expect(shouldAutoReconnect({ ...base, attempt: 4 })).toBe(true);
  });

  it("refuses when auto-reconnect is disabled", () => {
    expect(shouldAutoReconnect({ ...base, enabled: false })).toBe(false);
  });

  it("refuses mid-transaction to avoid implicit commit / inconsistency", () => {
    expect(shouldAutoReconnect({ ...base, inTransaction: true })).toBe(false);
  });

  it("refuses once the retry cap is reached", () => {
    expect(shouldAutoReconnect({ ...base, attempt: 5 })).toBe(false);
    expect(shouldAutoReconnect({ ...base, attempt: 6 })).toBe(false);
  });

  it("refuses zero / negative max retries", () => {
    expect(shouldAutoReconnect({ ...base, maxRetries: 0 })).toBe(false);
  });

  it("refuses production profiles so they never auto-retry (#712)", () => {
    // Even when everything else would allow it, a production connection must
    // fall back to the manual reconnect button.
    expect(shouldAutoReconnect({ ...base, isProduction: true })).toBe(false);
    // Omitted / false keeps the default (non-production) behavior.
    expect(shouldAutoReconnect({ ...base, isProduction: false })).toBe(true);
  });
});
