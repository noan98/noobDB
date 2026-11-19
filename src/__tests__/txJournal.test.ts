import { describe, expect, it } from "vitest";
import {
  TX_JOURNAL_MAX_ENTRIES,
  TX_WARN_AFTER_MS,
  appendTxEntry,
  formatTxElapsed,
  isTxStale,
  makeTxEntry,
  oneLineSql,
  shouldReviewBeforeCommit,
  summarizeTxJournal,
  supportsTxBlockingCount,
  txWarnThresholdMs,
} from "../txJournal";

const ok = (sql: string, rows: number, driver = "mysql") =>
  makeTxEntry(sql, driver, { ok: true, returnedRows: rows, affectedRows: rows, elapsedMs: 5 }, 1000);

describe("formatTxElapsed", () => {
  it("formats m:ss and h:mm:ss", () => {
    expect(formatTxElapsed(0)).toBe("0:00");
    expect(formatTxElapsed(59_999)).toBe("0:59");
    expect(formatTxElapsed(754_000)).toBe("12:34");
    expect(formatTxElapsed(3_600_000)).toBe("1:00:00");
    expect(formatTxElapsed(3_723_000)).toBe("1:02:03");
  });
  it("clamps negatives", () => {
    expect(formatTxElapsed(-5000)).toBe("0:00");
  });
});

describe("stale threshold", () => {
  it("production is shorter than other", () => {
    expect(TX_WARN_AFTER_MS.production).toBeLessThan(TX_WARN_AFTER_MS.other);
    expect(txWarnThresholdMs(true)).toBe(TX_WARN_AFTER_MS.production);
    expect(txWarnThresholdMs(false)).toBe(TX_WARN_AFTER_MS.other);
  });
  it("warns exactly at the threshold", () => {
    const p = TX_WARN_AFTER_MS.production;
    expect(isTxStale(p - 1, true)).toBe(false);
    expect(isTxStale(p, true)).toBe(true);
    expect(isTxStale(p, false)).toBe(false);
    expect(isTxStale(TX_WARN_AFTER_MS.other, false)).toBe(true);
  });
});

describe("supportsTxBlockingCount", () => {
  it("is MySQL / PostgreSQL only", () => {
    expect(supportsTxBlockingCount("mysql")).toBe(true);
    expect(supportsTxBlockingCount("postgres")).toBe(true);
    expect(supportsTxBlockingCount("sqlite")).toBe(false);
    expect(supportsTxBlockingCount(undefined)).toBe(false);
  });
});

describe("journal entries", () => {
  it("classifies writes and reads", () => {
    expect(ok("UPDATE t SET a = 1", 3).write).toBe(true);
    expect(ok("SELECT * FROM t", 3).write).toBe(false);
    expect(makeTxEntry("DELETE FROM t", "postgres", { ok: false }, 1)).toMatchObject({
      ok: false,
      write: true,
      rows: null,
    });
  });

  it("uses affected rows for writes and returned rows for reads", () => {
    const w = makeTxEntry(
      "UPDATE t SET a = 1 RETURNING id",
      "postgres",
      {
        ok: true,
        returnedRows: 7,
        affectedRows: 2,
        elapsedMs: 1,
      },
      1,
    );
    expect(w.rows).toBe(2);
    const r = makeTxEntry(
      "SELECT 1",
      "postgres",
      { ok: true, returnedRows: 7, affectedRows: 0, elapsedMs: 1 },
      1,
    );
    expect(r.rows).toBe(7);
  });

  it("summarizes only successful writes", () => {
    const entries = [
      ok("UPDATE t SET a = 1", 3),
      ok("SELECT * FROM t", 100),
      ok("DELETE FROM t WHERE id = 1", 1),
      makeTxEntry("INSERT INTO t VALUES (1)", "mysql", { ok: false }, 2),
    ];
    expect(summarizeTxJournal(entries)).toEqual({ statements: 2, rows: 4, failed: 1 });
    expect(summarizeTxJournal([])).toEqual({ statements: 0, rows: 0, failed: 0 });
  });

  it("caps the journal, dropping the oldest", () => {
    let entries: ReturnType<typeof appendTxEntry> = [];
    for (let i = 0; i < TX_JOURNAL_MAX_ENTRIES + 5; i += 1) {
      entries = appendTxEntry(entries, ok(`UPDATE t SET a = ${i}`, 1));
    }
    expect(entries).toHaveLength(TX_JOURNAL_MAX_ENTRIES);
    expect(entries[0]?.sql).toBe("UPDATE t SET a = 5");
  });
});

describe("shouldReviewBeforeCommit", () => {
  it("requires production + confirm_writes and not read-only", () => {
    expect(shouldReviewBeforeCommit({ is_production: true, confirm_writes: true })).toBe(true);
    expect(shouldReviewBeforeCommit({ is_production: true, confirm_writes: false })).toBe(false);
    expect(shouldReviewBeforeCommit({ is_production: false, confirm_writes: true })).toBe(false);
    expect(shouldReviewBeforeCommit({ is_production: true, confirm_writes: true, read_only: true })).toBe(
      false,
    );
  });
});

describe("oneLineSql", () => {
  it("collapses whitespace and truncates", () => {
    expect(oneLineSql("UPDATE  t\n SET a = 1")).toBe("UPDATE t SET a = 1");
    expect(oneLineSql("x".repeat(10), 5)).toBe("xxxx…");
  });
});
