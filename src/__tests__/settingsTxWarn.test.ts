import { beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_TX_WARN_MINUTES_OTHER,
  DEFAULT_TX_WARN_MINUTES_PRODUCTION,
  MAX_TX_WARN_MINUTES,
  getSettings,
  setTxWarnMinutesOther,
  setTxWarnMinutesProduction,
} from "../settings";

describe("放置警告のしきい値の設定 (#2447)", () => {
  beforeEach(() => {
    setTxWarnMinutesProduction(DEFAULT_TX_WARN_MINUTES_PRODUCTION);
    setTxWarnMinutesOther(DEFAULT_TX_WARN_MINUTES_OTHER);
  });

  it("本番は非本番より短い既定値を持つ", () => {
    expect(DEFAULT_TX_WARN_MINUTES_PRODUCTION).toBeLessThan(DEFAULT_TX_WARN_MINUTES_OTHER);
    expect(getSettings().txWarnMinutesProduction).toBe(DEFAULT_TX_WARN_MINUTES_PRODUCTION);
    expect(getSettings().txWarnMinutesOther).toBe(DEFAULT_TX_WARN_MINUTES_OTHER);
  });

  it("本番 / 非本番を別々に変更できる", () => {
    setTxWarnMinutesProduction(5);
    expect(getSettings().txWarnMinutesProduction).toBe(5);
    expect(getSettings().txWarnMinutesOther).toBe(DEFAULT_TX_WARN_MINUTES_OTHER);
    setTxWarnMinutesOther(30);
    expect(getSettings().txWarnMinutesOther).toBe(30);
  });

  it("範囲外は丸め、数でない値は直前の値を保つ", () => {
    setTxWarnMinutesProduction(0);
    expect(getSettings().txWarnMinutesProduction).toBe(1);
    setTxWarnMinutesOther(MAX_TX_WARN_MINUTES + 100);
    expect(getSettings().txWarnMinutesOther).toBe(MAX_TX_WARN_MINUTES);
    setTxWarnMinutesOther(Number.NaN);
    expect(getSettings().txWarnMinutesOther).toBe(MAX_TX_WARN_MINUTES);
  });
});
