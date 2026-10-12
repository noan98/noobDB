import { describe, expect, it } from "vitest";

import {
  buildAssertionTrends,
  localToUtcClock,
  tzOffsetMinutes,
  utcToLocalClock,
  previewOutputPath,
  relativeNextRun,
  sortTasksForDisplay,
  summarizeAction,
  summarizeSchedule,
} from "../taskFormat";
import type { TaskAction, TaskSchedule } from "../api/tauri";
import { dictionaries, type I18nKey } from "../i18n";

const mk = (locale: "en" | "ja") => (key: I18nKey, vars?: Record<string, string | number>) => {
  let s: string = dictionaries[locale][key];
  for (const [k, v] of Object.entries(vars ?? {})) s = s.split(`{${k}}`).join(String(v));
  return s;
};
const en = mk("en");
const ja = mk("ja");
const JST = "Asia/Tokyo";

describe("summarizeSchedule (#730)", () => {
  it("summarizes an interval schedule", () => {
    expect(summarizeSchedule({ kind: "interval", minutes: 30 }, en)).toBe("every 30 min");
  });

  it("clamps a zero/negative interval to at least 1 minute", () => {
    expect(summarizeSchedule({ kind: "interval", minutes: 0 }, en)).toBe("every 1 min");
  });

  it("summarizes a daily schedule in local time (UTC 00:05 = JST 09:05)", () => {
    const opts = { now: new Date("2026-01-01T00:00:00Z"), timeZone: JST, locale: "ja" };
    expect(summarizeSchedule({ kind: "daily", hour: 0, minute: 5 }, ja, opts)).toBe("毎日 09:05 (JST)");
    expect(summarizeSchedule({ kind: "daily", hour: 0, minute: 5 }, en, opts)).toBe("daily 09:05 (JST)");
  });

  it("converts with the offset at the given reference date (DST: next run date)", () => {
    const ny = "America/New_York";
    const sched = { kind: "daily", hour: 13, minute: 0 } as const;
    expect(summarizeSchedule(sched, en, { now: new Date("2026-01-15T00:00:00Z"), timeZone: ny })).toContain("08:00");
    expect(summarizeSchedule(sched, en, { now: new Date("2026-07-15T00:00:00Z"), timeZone: ny })).toContain("09:00");
  });

  it("localizes the interval summary", () => {
    expect(summarizeSchedule({ kind: "interval", minutes: 30 }, ja)).toBe("30 分ごと");
  });

  it("clamps out-of-range daily hour/minute", () => {
    const sched: TaskSchedule = { kind: "daily", hour: 30, minute: 90 };
    const opts = { now: new Date("2026-01-01T00:00:00Z"), timeZone: "UTC", locale: "en" };
    expect(summarizeSchedule(sched, en, opts)).toBe("daily 23:59 (UTC)");
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
    expect(summarizeAction(action, en)).toBe("export (csv)");
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
    expect(summarizeAction(action, en)).toBe("dump (sales)");
  });
});

describe("relativeNextRun (#730)", () => {
  const now = new Date("2026-01-01T12:00:00Z");

  it("returns empty string for null", () => {
    expect(relativeNextRun(null, now, en)).toBe("");
  });

  it("returns empty string for an unparseable value", () => {
    expect(relativeNextRun("not-a-date", now, en)).toBe("");
  });

  it("returns 'due' for a time at or before now", () => {
    expect(relativeNextRun(now.toISOString(), now, en)).toBe("due");
    expect(relativeNextRun("2026-01-01T11:00:00Z", now, en)).toBe("due");
  });

  it("formats minutes/hours/days for future times", () => {
    expect(relativeNextRun("2026-01-01T12:30:00Z", now, en)).toBe("30 min");
    expect(relativeNextRun("2026-01-01T15:00:00Z", now, en)).toBe("3 h");
    expect(relativeNextRun("2026-01-04T12:00:00Z", now, en)).toBe("3 d");
  });

  it("rounds sub-minute gaps to '<1 min'", () => {
    expect(relativeNextRun("2026-01-01T12:00:30Z", now, en)).toBe("<1 min");
  });
});

describe("relativeNextRun / summarizeAction の日本語化 (#1533)", () => {
  const now = new Date("2026-01-01T12:00:00Z");
  it("単位と語を日本語で返す", () => {
    expect(relativeNextRun("2026-01-01T12:30:00Z", now, ja)).toBe("30 分後");
    expect(relativeNextRun("2026-01-01T15:00:00Z", now, ja)).toBe("3 時間後");
    expect(relativeNextRun("2026-01-04T12:00:00Z", now, ja)).toBe("3 日後");
    expect(relativeNextRun("2026-01-01T12:00:30Z", now, ja)).toBe("1 分未満");
    expect(relativeNextRun("2026-01-01T11:00:00Z", now, ja)).toBe("実行待ち");
    expect(summarizeAction({ kind: "run_assertions", assertion_ids: [] }, ja)).toBe("アサーション (対象すべて)");
  });
});

describe("daily 時刻のローカル <-> UTC 変換 (#1533)", () => {
  const winter = new Date("2026-01-15T00:00:00Z");
  const summer = new Date("2026-07-15T00:00:00Z");

  it("JST (UTC+9) では UTC 00:00 が 09:00、UTC 20:00 が翌日 05:00", () => {
    expect(utcToLocalClock(0, 0, winter, JST)).toEqual({ hour: 9, minute: 0, dayShift: 0 });
    expect(utcToLocalClock(20, 30, winter, JST)).toEqual({ hour: 5, minute: 30, dayShift: 1 });
  });

  it("JST の 9:00 入力は UTC 0:00、JST 8:00 は前日の UTC 23:00", () => {
    expect(localToUtcClock(9, 0, winter, JST)).toEqual({ hour: 0, minute: 0, dayShift: 0 });
    expect(localToUtcClock(8, 15, winter, JST)).toEqual({ hour: 23, minute: 15, dayShift: -1 });
  });

  it("DST のある地域は基準日でオフセットが変わる (America/New_York)", () => {
    const ny = "America/New_York";
    expect(tzOffsetMinutes(winter, ny)).toBe(-300);
    expect(tzOffsetMinutes(summer, ny)).toBe(-240);
    expect(utcToLocalClock(13, 0, winter, ny)).toEqual({ hour: 8, minute: 0, dayShift: 0 });
    expect(utcToLocalClock(13, 0, summer, ny)).toEqual({ hour: 9, minute: 0, dayShift: 0 });
    expect(utcToLocalClock(3, 0, summer, ny)).toEqual({ hour: 23, minute: 0, dayShift: -1 });
    expect(localToUtcClock(9, 0, summer, ny)).toEqual({ hour: 13, minute: 0, dayShift: 0 });
  });

  it("30 分オフセットの地域 (Asia/Kolkata, +5:30) も分まで往復で一致する", () => {
    const tz = "Asia/Kolkata";
    const local = utcToLocalClock(20, 45, winter, tz);
    expect(local).toEqual({ hour: 2, minute: 15, dayShift: 1 });
    const back = localToUtcClock(local.hour, local.minute, winter, tz);
    expect([back.hour, back.minute]).toEqual([20, 45]);
  });

  it("全時刻で往復変換が恒等 (JST / New_York / Auckland)", () => {
    for (const tz of [JST, "America/New_York", "Pacific/Auckland"]) {
      for (const at of [winter, summer]) {
        for (let h = 0; h < 24; h++) {
          const l = utcToLocalClock(h, 30, at, tz);
          const u = localToUtcClock(l.hour, l.minute, at, tz);
          expect([u.hour, u.minute]).toEqual([h, 30]);
        }
      }
    }
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
    expect(summarizeAction({ kind: "run_assertions", assertion_ids: [] }, en)).toBe(
      "assertions (all in scope)",
    );
  });

  it("shows the count of chosen assertions", () => {
    expect(
      summarizeAction({ kind: "run_assertions", database: null, assertion_ids: ["a", "b"] }, en),
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
