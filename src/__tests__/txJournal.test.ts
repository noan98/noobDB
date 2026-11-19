import { describe, expect, it } from "vitest";
import {
  TX_JOURNAL_MAX_ENTRIES,
  appendTxEntry,
  isIdleInTxTimeoutError,
  isIdleTxDisconnect,
  txLastActivityAt,
  newTxMeta,
  recordTxMeta,
  batchResultToTxOutcome,
  createBatchTxRecorder,
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
  const warn = { production: 3, other: 10 };
  it("uses minutes per environment", () => {
    expect(txWarnThresholdMs(true, warn)).toBe(180_000);
    expect(txWarnThresholdMs(false, warn)).toBe(600_000);
  });
  it("warns exactly at the threshold", () => {
    expect(isTxStale(179_999, true, warn)).toBe(false);
    expect(isTxStale(180_000, true, warn)).toBe(true);
    expect(isTxStale(180_000, false, warn)).toBe(false);
    expect(isTxStale(600_000, false, warn)).toBe(true);
    expect(isTxStale(60_000, true, { production: 1, other: 1 })).toBe(true);
  });
});

describe("batchResultToTxOutcome", () => {
  it("skips skipped statements and maps errors", () => {
    expect(batchResultToTxOutcome({ status: "skipped" })).toBeNull();
    expect(batchResultToTxOutcome({ status: "error" })).toEqual({ ok: false });
  });
  it("maps a result set and an affected count", () => {
    expect(
      batchResultToTxOutcome({ status: "ok", columns: [{}], rows: [[1], [2]], totalRows: 50, elapsedMs: 3 }),
    ).toEqual({ ok: true, returnedRows: 50, affectedRows: 0, elapsedMs: 3 });
    expect(batchResultToTxOutcome({ status: "ok", rowsAffected: 4, elapsedMs: 2 })).toEqual({
      ok: true,
      returnedRows: 0,
      affectedRows: 4,
      elapsedMs: 2,
    });
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

describe("createBatchTxRecorder", () => {
  const collect = (inTx: boolean) => {
    const got: string[] = [];
    const rec = createBatchTxRecorder(inTx, (sql) => got.push(sql));
    return { got, rec };
  };
  const okRes = (sql: string) => ({ sql, status: "ok" as const, rowsAffected: 1, elapsedMs: 1 });

  it("TX 外のバッチは記録しない", () => {
    const { got, rec } = collect(false);
    rec(okRes("UPDATE t SET a = 1"));
    expect(got).toEqual([]);
  });

  it("skipped は記録しない", () => {
    const { got, rec } = collect(true);
    rec({ sql: "UPDATE t SET a = 1", status: "skipped" });
    rec(okRes("UPDATE t SET a = 2"));
    expect(got).toEqual(["UPDATE t SET a = 2"]);
  });

  it("COMMIT などの制御文以降は記録しない", () => {
    const { got, rec } = collect(true);
    rec(okRes("UPDATE t SET a = 1"));
    rec(okRes("COMMIT"));
    rec(okRes("UPDATE t SET a = 2"));
    expect(got).toEqual(["UPDATE t SET a = 1"]);
  });
});

describe("batchResultToTxOutcome truncated", () => {
  it("切り詰められて総数が不明なら行数は null", () => {
    expect(
      batchResultToTxOutcome({ status: "ok", columns: [{}], rows: [[1]], truncated: true }),
    ).toMatchObject({
      returnedRows: null,
    });
  });
});

describe("recordTxMeta (一覧の上限と累計)", () => {
  it("UPDATE のあと SELECT を 201 文流しても、累計は UPDATE を保つ", () => {
    let m = newTxMeta(0);
    m = recordTxMeta(m, ok("UPDATE t SET a = 1", 5));
    for (let i = 0; i < 201; i += 1) m = recordTxMeta(m, ok("SELECT 1", 1));
    expect(m.entries).toHaveLength(TX_JOURNAL_MAX_ENTRIES);
    expect(m.omitted).toBe(2);
    expect(m.entries.some((e) => e.write)).toBe(false);
    expect(m.totals).toEqual({ statements: 1, rows: 5, failed: 0 });
  });

  it("上限未満なら省略なし、失敗も累計に数える", () => {
    let m = newTxMeta(0);
    m = recordTxMeta(m, ok("UPDATE t SET a = 1", 2));
    m = recordTxMeta(m, makeTxEntry("DELETE FROM t", "mysql", { ok: false }, 1));
    expect(m.omitted).toBe(0);
    expect(m.totals).toEqual({ statements: 1, rows: 2, failed: 1 });
  });
});

describe("放置トランザクションの自動切断 (#2464)", () => {
  it("idle-in-transaction timeout / 25P03 のエラー文を判定する", () => {
    expect(
      isIdleInTxTimeoutError(
        "error returned from database: terminating connection due to idle-in-transaction timeout",
      ),
    ).toBe(true);
    expect(isIdleInTxTimeoutError("FATAL 25P03")).toBe(true);
    expect(isIdleInTxTimeoutError("connection reset by peer")).toBe(false);
    expect(isIdleInTxTimeoutError(null)).toBe(false);
    expect(isIdleInTxTimeoutError(undefined)).toBe(false);
  });

  it("最後の動きは最後の文の時刻、文が無ければ BEGIN の時刻", () => {
    expect(txLastActivityAt(newTxMeta(500))).toBe(500);
    expect(txLastActivityAt(recordTxMeta(newTxMeta(500), ok("UPDATE t SET a = 1", 1)))).toBe(1000);
  });

  const base = { inTransaction: true, timeoutMin: 10, lastActivityAt: 0, now: 0 };
  it("エラー文が自動切断を示せば、設定や経過に関係なく該当する", () => {
    expect(
      isIdleTxDisconnect({
        ...base,
        timeoutMin: null,
        error: "terminating connection due to idle-in-transaction timeout",
      }),
    ).toBe(true);
  });

  it("接続断だけのときは、設定済みで最後の動きから設定分が過ぎていれば推定する (境界は 10 分ちょうど)", () => {
    expect(isIdleTxDisconnect({ ...base, now: 10 * 60_000 - 1 })).toBe(false);
    expect(isIdleTxDisconnect({ ...base, now: 10 * 60_000 })).toBe(true);
  });

  it("設定が無い・TX 中でない・時刻不明なら推定しない", () => {
    const now = 99 * 60_000;
    expect(isIdleTxDisconnect({ ...base, now, timeoutMin: null })).toBe(false);
    expect(isIdleTxDisconnect({ ...base, now, timeoutMin: 0 })).toBe(false);
    expect(isIdleTxDisconnect({ ...base, now, inTransaction: false })).toBe(false);
    expect(isIdleTxDisconnect({ ...base, now, lastActivityAt: null })).toBe(false);
  });
});
