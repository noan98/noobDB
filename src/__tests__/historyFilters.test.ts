import { describe, expect, it } from "vitest";
import {
  applyHistorySpeedFilter,
  historyPeriodRange,
  historyStatusParam,
} from "../components/historyFilters";

describe("historyStatusParam", () => {
  it("maps 'all' to null (no filter)", () => {
    expect(historyStatusParam("all")).toBeNull();
  });

  it("passes 'ok'/'error' through unchanged", () => {
    expect(historyStatusParam("ok")).toBe("ok");
    expect(historyStatusParam("error")).toBe("error");
  });
});

describe("historyPeriodRange", () => {
  const now = new Date("2026-07-28T15:30:00.000Z");

  it("'all' has no bounds", () => {
    expect(historyPeriodRange("all", now)).toEqual({ from: null, to: null });
  });

  it("'today' starts at local midnight with no upper bound", () => {
    const { from, to } = historyPeriodRange("today", now);
    expect(to).toBeNull();
    expect(from).not.toBeNull();
    const start = new Date(from as string);
    expect(start.getHours()).toBe(0);
    expect(start.getMinutes()).toBe(0);
    expect(start.getSeconds()).toBe(0);
    expect(start.getMilliseconds()).toBe(0);
    // Same calendar day as `now`.
    expect(start.getFullYear()).toBe(now.getFullYear());
    expect(start.getMonth()).toBe(now.getMonth());
    expect(start.getDate()).toBe(now.getDate());
  });

  it("'7d' is a rolling 7*24h window with no upper bound", () => {
    const { from, to } = historyPeriodRange("7d", now);
    expect(to).toBeNull();
    expect(from).not.toBeNull();
    const start = new Date(from as string);
    const diffMs = now.getTime() - start.getTime();
    expect(diffMs).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

describe("applyHistorySpeedFilter (#1541)", () => {
  const rows = [
    { id: 1, elapsed_ms: 50 },
    { id: 2, elapsed_ms: null },
    { id: 3, elapsed_ms: 1000 },
    { id: 4, elapsed_ms: 2500 },
    { id: 5, elapsed_ms: 999 },
    { id: 6, elapsed_ms: 1000 },
  ];
  const ids = (xs: { id: number }[]) => xs.map((x) => x.id);

  it("recent は元の並びのまま", () => {
    expect(ids(applyHistorySpeedFilter(rows, "recent"))).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("slowest は長い順で、null は末尾、同値は元の順を保つ", () => {
    expect(ids(applyHistorySpeedFilter(rows, "slowest"))).toEqual([4, 3, 6, 5, 1, 2]);
  });

  it("slow は 1 秒以上だけ (境界 1000 ms を含み 999 ms は除く)、長い順", () => {
    expect(ids(applyHistorySpeedFilter(rows, "slow"))).toEqual([4, 3, 6]);
  });

  it("元の配列を変更しない", () => {
    const copy = rows.map((r) => ({ ...r }));
    applyHistorySpeedFilter(rows, "slowest");
    expect(rows).toEqual(copy);
  });
});
