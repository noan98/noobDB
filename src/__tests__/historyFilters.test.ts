import { describe, expect, it } from "vitest";
import {
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
