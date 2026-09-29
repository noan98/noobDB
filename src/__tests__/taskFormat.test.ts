import { describe, expect, it } from "vitest";

import {
  buildAssertionTrends,
  previewOutputPath,
  relativeNextRun,
  sortTasksForDisplay,
  summarizeAction,
  summarizeSchedule,
} from "../taskFormat";
import type { TaskAction, TaskSchedule } from "../api/tauri";

describe("summarizeSchedule (#730)", () => {
  it("summarizes an interval schedule", () => {
    expect(summarizeSchedule({ kind: "interval", minutes: 30 })).toBe("30 min");
  });

  it("clamps a zero/negative interval to at least 1 minute", () => {
    expect(summarizeSchedule({ kind: "interval", minutes: 0 })).toBe("1 min");
  });

  it("summarizes a daily schedule with zero-padded UTC time", () => {
    expect(summarizeSchedule({ kind: "daily", hour: 9, minute: 5 })).toBe("daily 09:05 UTC");
  });

  it("clamps out-of-range daily hour/minute", () => {
    const sched: TaskSchedule = { kind: "daily", hour: 30, minute: 90 };
    expect(summarizeSchedule(sched)).toBe("daily 23:59 UTC");
  });
});

describe("summarizeAction (#730)", () => {
  it("summarizes an export action by format", () => {
    const action: TaskAction = {
      kind: "export_query",
      sql: "SELECT 1",
      database: null,
      format: "csv",
      output_path: "out.csv",
    };
    expect(summarizeAction(action)).toBe("export (csv)");
  });

  it("summarizes a dump action by database name", () => {
    const action: TaskAction = {
      kind: "dump",
      database: "sales",
      output_path: "out.sql",
      options: {
        singleTransaction: true,
        routines: false,
        events: false,
        triggers: true,
        addDropTable: true,
        extendedInsert: true,
        completeInsert: false,
        noData: false,
        noCreateInfo: false,
      },
    };
    expect(summarizeAction(action)).toBe("dump (sales)");
  });
});

describe("relativeNextRun (#730)", () => {
  const now = new Date("2026-01-01T12:00:00Z");

  it("returns empty string for null", () => {
    expect(relativeNextRun(null, now)).toBe("");
  });

  it("returns empty string for an unparseable value", () => {
    expect(relativeNextRun("not-a-date", now)).toBe("");
  });

  it("returns 'due' for a time at or before now", () => {
    expect(relativeNextRun(now.toISOString(), now)).toBe("due");
    expect(relativeNextRun("2026-01-01T11:00:00Z", now)).toBe("due");
  });

  it("formats minutes/hours/days for future times", () => {
    expect(relativeNextRun("2026-01-01T12:30:00Z", now)).toBe("30 min");
    expect(relativeNextRun("2026-01-01T15:00:00Z", now)).toBe("3 h");
    expect(relativeNextRun("2026-01-04T12:00:00Z", now)).toBe("3 d");
  });

  it("rounds sub-minute gaps to '<1 min'", () => {
    expect(relativeNextRun("2026-01-01T12:00:30Z", now)).toBe("<1 min");
  });
});

describe("previewOutputPath (#730)", () => {
  const now = new Date("2026-03-04T05:06:07Z");

  it("expands {date}", () => {
    expect(previewOutputPath("sales-{date}.csv", now)).toBe("sales-2026-03-04.csv");
  });

  it("expands {datetime}", () => {
    expect(previewOutputPath("dump-{datetime}.sql", now)).toBe("dump-20260304-050607.sql");
  });

  it("expands both, repeated", () => {
    expect(previewOutputPath("{date}/{date}-{datetime}.csv", now)).toBe(
      "2026-03-04/2026-03-04-20260304-050607.csv",
    );
  });

  it("leaves a template without placeholders untouched", () => {
    expect(previewOutputPath("plain.csv", now)).toBe("plain.csv");
  });
});

describe("sortTasksForDisplay (#730)", () => {
  it("puts enabled tasks first, ordered by soonest next run, then name", () => {
    const tasks = [
      { name: "b-later", enabled: true, next_run_at: "2026-01-02T00:00:00Z" },
      { name: "a-soon", enabled: true, next_run_at: "2026-01-01T00:00:00Z" },
      { name: "z-disabled", enabled: false, next_run_at: null },
      { name: "a-disabled", enabled: false, next_run_at: null },
    ];
    const order = sortTasksForDisplay(tasks).map((t) => t.name);
    expect(order).toEqual(["a-soon", "b-later", "a-disabled", "z-disabled"]);
  });

  it("sorts enabled tasks without a next_run_at last among enabled tasks", () => {
    const tasks = [
      { name: "no-schedule", enabled: true, next_run_at: null },
      { name: "scheduled", enabled: true, next_run_at: "2026-01-01T00:00:00Z" },
    ];
    const order = sortTasksForDisplay(tasks).map((t) => t.name);
    expect(order).toEqual(["scheduled", "no-schedule"]);
  });
});

describe("summarizeAction for run_assertions (#1170)", () => {
  it("shows all-in-scope when no ids are chosen", () => {
    expect(summarizeAction({ kind: "run_assertions", assertion_ids: [] })).toBe(
      "assertions (all in scope)",
    );
  });

  it("shows the count of chosen assertions", () => {
    expect(
      summarizeAction({ kind: "run_assertions", database: null, assertion_ids: ["a", "b"] }),
    ).toBe("assertions (2)");
  });
});

describe("buildAssertionTrends (#1170)", () => {
  const rec = (
    id: string,
    name: string,
    passed: boolean,
    observed: number | null,
    error: string | null = null,
  ) => ({
    assertion_id: id,
    assertion_name: name,
    passed,
    observed,
    error,
  });

  it("returns nothing for no records", () => {
    expect(buildAssertionTrends([])).toEqual([]);
  });

  it("groups newest-first records per assertion and orders dots oldest to newest", () => {
    const trends = buildAssertionTrends([
      rec("a1", "A1", false, 5),
      rec("a1", "A1", true, 0),
      rec("a1", "A1", true, 0),
    ]);
    expect(trends).toHaveLength(1);
    expect(trends[0].dots).toEqual([true, true, false]);
    expect(trends[0].lastObserved).toBe(5);
    expect(trends[0].passRate).toBeCloseTo(2 / 3);
  });

  it("lists currently failing assertions first, then by name", () => {
    const trends = buildAssertionTrends([
      rec("b", "Beta", true, 0),
      rec("a", "Alpha", true, 0),
      rec("z", "Zed", false, null, "timeout"),
    ]);
    expect(trends.map((t) => t.name)).toEqual(["Zed", "Alpha", "Beta"]);
    expect(trends[0].lastError).toBe("timeout");
    expect(trends[0].lastObserved).toBeNull();
  });

  it("caps the number of dots per assertion to the most recent maxDots", () => {
    const records = Array.from({ length: 5 }, (_, i) => rec("a", "A", i !== 0, 0));
    const [t] = buildAssertionTrends(records, 3);
    expect(t.dots).toEqual([true, true, false]);
  });
});
