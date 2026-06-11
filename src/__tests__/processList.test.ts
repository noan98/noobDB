import { describe, it, expect } from "vitest";

import type { ProcessInfo } from "../api/tauri";
import {
  formatProcessTime,
  pruneSelection,
  summarizeQuery,
} from "../components/processList";

function proc(id: number, overrides: Partial<ProcessInfo> = {}): ProcessInfo {
  return {
    id,
    user: "app",
    host: "127.0.0.1:50000",
    database: "testdb",
    command: "Query",
    state: null,
    time_secs: 0,
    query: null,
    is_self: false,
    ...overrides,
  };
}

describe("formatProcessTime", () => {
  it("shows a dash for unknown durations", () => {
    expect(formatProcessTime(null)).toBe("–");
    expect(formatProcessTime(-1)).toBe("–");
  });

  it("formats sub-minute durations as seconds", () => {
    expect(formatProcessTime(0)).toBe("0s");
    expect(formatProcessTime(59)).toBe("59s");
  });

  it("formats sub-hour durations as minutes and zero-padded seconds", () => {
    expect(formatProcessTime(60)).toBe("1m 00s");
    expect(formatProcessTime(125)).toBe("2m 05s");
    expect(formatProcessTime(3599)).toBe("59m 59s");
  });

  it("formats long durations as hours and zero-padded minutes", () => {
    expect(formatProcessTime(3600)).toBe("1h 00m");
    expect(formatProcessTime(3660)).toBe("1h 01m");
    expect(formatProcessTime(7325)).toBe("2h 02m");
  });
});

describe("pruneSelection", () => {
  it("keeps only ids that are still present after a refresh", () => {
    const selected = new Set([1, 2, 3]);
    const next = pruneSelection(selected, [proc(2), proc(3), proc(4)]);
    expect([...next].sort()).toEqual([2, 3]);
  });

  it("returns an empty set when nothing survives", () => {
    expect(pruneSelection(new Set([7]), []).size).toBe(0);
  });

  it("does not mutate the input set", () => {
    const selected = new Set([1]);
    pruneSelection(selected, []);
    expect(selected.has(1)).toBe(true);
  });
});

describe("summarizeQuery", () => {
  it("shows a dash for empty or null queries", () => {
    expect(summarizeQuery(null)).toBe("–");
    expect(summarizeQuery("")).toBe("–");
    expect(summarizeQuery("   \n  ")).toBe("–");
  });

  it("collapses whitespace and newlines into one line", () => {
    expect(summarizeQuery("SELECT *\n  FROM   users\nWHERE id = 1")).toBe(
      "SELECT * FROM users WHERE id = 1",
    );
  });

  it("truncates long queries with an ellipsis", () => {
    const long = `SELECT ${"x".repeat(300)}`;
    const out = summarizeQuery(long, 50);
    expect(out.length).toBe(51); // 50 chars + ellipsis
    expect(out.endsWith("…")).toBe(true);
  });
});
