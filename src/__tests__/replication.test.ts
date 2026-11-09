import { describe, expect, it } from "vitest";
import type { ReplicationLink, ReplicationSlot } from "../api/tauri";
import {
  formatLagSecs,
  isLagWarning,
  LAG_METER_MAX_SECS,
  LAG_WARN_SECS,
  lagMeterPercent,
  lagWarnPercent,
  linkNeedsAttention,
  SLOT_WAL_WARN_BYTES,
  slotsHoldingWal,
  sortLinks,
} from "../components/replication";

const slot = (over: Partial<ReplicationSlot>): ReplicationSlot => ({
  name: "s",
  slot_type: "logical",
  plugin: null,
  active: false,
  retained_bytes: 0,
  wal_status: null,
  ...over,
});

const link = (over: Partial<ReplicationLink>): ReplicationLink => ({
  direction: "downstream",
  name: "r",
  address: null,
  state: null,
  sync_state: null,
  lag_secs: null,
  write_lag_secs: null,
  flush_lag_secs: null,
  lag_bytes: null,
  io_running: null,
  sql_running: null,
  last_error: null,
  ...over,
});

describe("slotsHoldingWal (#2180)", () => {
  it("警告の閾値は 1 GiB", () => {
    expect(SLOT_WAL_WARN_BYTES).toBe(1024 ** 3);
  });

  it("非アクティブで閾値以上を保持するスロットだけを、保持量の多い順に返す", () => {
    const got = slotsHoldingWal([
      slot({ name: "small", retained_bytes: SLOT_WAL_WARN_BYTES - 1 }),
      slot({ name: "edge", retained_bytes: SLOT_WAL_WARN_BYTES }),
      slot({ name: "big", retained_bytes: SLOT_WAL_WARN_BYTES * 5 }),
      slot({ name: "busy", active: true, retained_bytes: SLOT_WAL_WARN_BYTES * 9 }),
      slot({ name: "unknown", retained_bytes: null }),
    ]);
    expect(got.map((s) => s.name)).toEqual(["big", "edge"]);
  });

  it("閾値は引数で変えられる", () => {
    expect(slotsHoldingWal([slot({ name: "a", retained_bytes: 10 })], 10)).toHaveLength(1);
    expect(slotsHoldingWal([slot({ name: "a", retained_bytes: 9 })], 10)).toHaveLength(0);
  });
});

describe("遅延メーター (#2180)", () => {
  it("0〜100% に収め、未報告・負値・非有限値は 0", () => {
    expect(lagMeterPercent(null)).toBe(0);
    expect(lagMeterPercent(undefined)).toBe(0);
    expect(lagMeterPercent(-3)).toBe(0);
    expect(lagMeterPercent(Number.NaN)).toBe(0);
    expect(lagMeterPercent(LAG_METER_MAX_SECS / 2)).toBe(50);
    expect(lagMeterPercent(LAG_METER_MAX_SECS * 10)).toBe(100);
  });

  it("警告マーカーの位置は閾値 / 目盛り上限", () => {
    expect(lagWarnPercent()).toBe((LAG_WARN_SECS / LAG_METER_MAX_SECS) * 100);
  });

  it("警告は閾値ちょうどから", () => {
    expect(isLagWarning(LAG_WARN_SECS - 0.1)).toBe(false);
    expect(isLagWarning(LAG_WARN_SECS)).toBe(true);
    expect(isLagWarning(null)).toBe(false);
  });
});

describe("formatLagSecs", () => {
  it("秒・分秒・時分に整形する", () => {
    expect(formatLagSecs(0)).toBe("0.0 s");
    expect(formatLagSecs(1.25)).toBe("1.3 s");
    expect(formatLagSecs(42)).toBe("42 s");
    expect(formatLagSecs(125)).toBe("2m 5s");
    expect(formatLagSecs(3 * 3600 + 120)).toBe("3h 2m");
    expect(formatLagSecs(-1)).toBe("—");
  });
});

describe("接続先の注意判定と並び", () => {
  it("停止中のスレッド・エラー・遅延超過があれば注意", () => {
    expect(linkNeedsAttention(link({}))).toBe(false);
    expect(linkNeedsAttention(link({ io_running: true, sql_running: true }))).toBe(false);
    expect(linkNeedsAttention(link({ io_running: false }))).toBe(true);
    expect(linkNeedsAttention(link({ sql_running: false }))).toBe(true);
    expect(linkNeedsAttention(link({ last_error: "boom" }))).toBe(true);
    expect(linkNeedsAttention(link({ lag_secs: LAG_WARN_SECS }))).toBe(true);
  });

  it("注意が要る行を先頭に、あとは名前順", () => {
    const got = sortLinks([link({ name: "b" }), link({ name: "z", last_error: "x" }), link({ name: "a" })]);
    expect(got.map((l) => l.name)).toEqual(["z", "a", "b"]);
  });
});
