import { describe, expect, it } from "vitest";
import {
  classifyScriptDone,
  DEFAULT_SCRIPT_OPTIONS,
  describeScriptError,
  makeScriptStreamId,
  analysisIsTruncated,
  dangerKindCounts,
  omittedFailureCount,
  parseStartAt,
  remainingDangerous,
  resumeStartAt,
  scriptProgressPercent,
  scriptProgressRatio,
  setDangerousExcluded,
  skipList,
  toggleExcluded,
  toggleScriptOption,
} from "../scriptRun";

describe("toggleScriptOption", () => {
  it("continueOnError と wrapInTransaction は排他", () => {
    const a = toggleScriptOption(DEFAULT_SCRIPT_OPTIONS, "wrapInTransaction");
    expect(a).toEqual({ ...DEFAULT_SCRIPT_OPTIONS, wrapInTransaction: true });
    const b = toggleScriptOption(a, "continueOnError");
    expect(b).toEqual({ ...DEFAULT_SCRIPT_OPTIONS, continueOnError: true });
    const c = toggleScriptOption(b, "wrapInTransaction");
    expect(c).toEqual({ ...DEFAULT_SCRIPT_OPTIONS, wrapInTransaction: true });
  });

  it("OFF にするときはもう片方に触れない", () => {
    const a = toggleScriptOption({ ...DEFAULT_SCRIPT_OPTIONS, continueOnError: true }, "continueOnError");
    expect(a).toEqual(DEFAULT_SCRIPT_OPTIONS);
  });
});

describe("scriptProgressRatio / Percent", () => {
  it("読み込み済みバイト数の割合を 0..1 に丸める", () => {
    expect(scriptProgressRatio({ bytesRead: 50, totalBytes: 200 })).toBe(0.25);
    expect(scriptProgressRatio({ bytesRead: 300, totalBytes: 200 })).toBe(1);
    expect(scriptProgressPercent({ bytesRead: 199, totalBytes: 200 })).toBe(99);
  });

  it("総バイト数が 0 (空ファイル・不明) なら null", () => {
    expect(scriptProgressRatio({ bytesRead: 0, totalBytes: 0 })).toBeNull();
    expect(scriptProgressPercent({ bytesRead: 10, totalBytes: 0 })).toBeNull();
  });
});

describe("完了/エラーの要約", () => {
  it("失敗件数で success / partial を分ける", () => {
    expect(classifyScriptDone({ failedCount: 0 })).toBe("success");
    expect(classifyScriptDone({ failedCount: 2 })).toBe("partial");
  });

  it("一覧から省かれた失敗の件数", () => {
    expect(
      omittedFailureCount({
        failedCount: 3,
        failures: [{ index: 1, line: 1, sql: "x", error: "e" }],
      }),
    ).toBe(2);
    expect(omittedFailureCount({ failedCount: 0, failures: [] })).toBe(0);
  });

  it("原因の文があれば行番号と SQL を返す", () => {
    expect(
      describeScriptError({
        streamId: "s",
        error: "line 3: boom",
        failure: { index: 2, line: 3, sql: "INSERT", error: "boom" },
        executed: 2,
        rolledBack: true,
      }),
    ).toEqual({ message: "boom", line: 3, index: 2, sql: "INSERT", rolledBack: true });
    expect(
      describeScriptError({ streamId: "s", error: "no file", failure: null, executed: 0, rolledBack: false }),
    ).toEqual({ message: "no file", line: null, index: null, sql: null, rolledBack: false });
  });

  it("stream id は毎回異なる", () => {
    expect(makeScriptStreamId(1)).not.toBe(makeScriptStreamId(1));
  });
});

describe("事前確認 (ドライラン) の補助 (#1535)", () => {
  const stmt = (index: number, danger?: "drop" | "deleteNoWhere") => ({
    index,
    line: index,
    sql: `S${index}`,
    category: "write" as const,
    danger,
    blocked: false,
  });
  const analysis = {
    totalStatements: 1000,
    categories: { read: 0, write: 998, ddl: 2, txControl: 0 },
    dangerCounts: { deleteNoWhere: 3, updateNoWhere: 0, drop: 2, truncate: 0 },
    dangerousTotal: 5,
    blockedTotal: 0,
    txControlTotal: 0,
    head: [stmt(1), stmt(2)],
    dangerous: [stmt(10, "drop"), stmt(20, "deleteNoWhere"), stmt(30, "deleteNoWhere")],
    txControls: [],
    headLimit: 300,
    listLimit: 200,
  };

  it("開始文番号の入力は 0 以上の整数だけを受け付ける", () => {
    expect(parseStartAt("")).toBe(0);
    expect(parseStartAt(" 42 ")).toBe(42);
    expect(parseStartAt("-3")).toBe(0);
    expect(parseStartAt("1.5")).toBe(0);
    expect(parseStartAt("abc")).toBe(0);
  });

  it("除外の切り替えは元の集合を壊さず、skipList は昇順", () => {
    const base = new Set([5]);
    const next = toggleExcluded(base, 2);
    expect([...base]).toEqual([5]);
    expect(skipList(next)).toEqual([2, 5]);
    expect(skipList(toggleExcluded(next, 5))).toEqual([2]);
  });

  it("一覧の危険文をまとめて除外・解除できる", () => {
    const all = setDangerousExcluded(new Set([1]), analysis, true);
    expect(skipList(all)).toEqual([1, 10, 20, 30]);
    expect(skipList(setDangerousExcluded(all, analysis, false))).toEqual([1]);
  });

  it("実行される危険文の数: 除外・開始位置より前を引き、一覧に載らない分は残す", () => {
    // 一覧外が 2 件 (5 - 3)。
    expect(remainingDangerous(analysis, new Set(), 0)).toBe(5);
    expect(remainingDangerous(analysis, new Set([10, 20, 30]), 0)).toBe(2);
    expect(remainingDangerous(analysis, new Set(), 25)).toBe(3);
    expect(remainingDangerous(analysis, new Set([30]), 25)).toBe(2);
    expect(remainingDangerous({ ...analysis, dangerousTotal: 0, dangerous: [] }, new Set(), 0)).toBe(0);
  });

  it("危険種別は件数のあるものだけ固定順で返す", () => {
    expect(dangerKindCounts(analysis)).toEqual([
      { kind: "drop", count: 2 },
      { kind: "deleteNoWhere", count: 3 },
    ]);
  });

  it("先頭の一覧が全文より短ければ打ち切りと判定する", () => {
    expect(analysisIsTruncated(analysis)).toBe(true);
    expect(analysisIsTruncated({ totalStatements: 2, head: analysis.head })).toBe(false);
  });
});

describe("resumeStartAt (#1535)", () => {
  const failure = { index: 7, line: 12, sql: "INSERT", error: "boom" };
  const noWrap = { wrapInTransaction: false };

  it("失敗した文の通し番号から、または次の文から再開できる", () => {
    expect(resumeStartAt({ failure, rolledBack: false }, noWrap)).toBe(7);
    expect(resumeStartAt({ failure, rolledBack: false }, noWrap, true)).toBe(8);
  });

  it("原因の文が無い・ロールバックされた・全体を包んでいた場合は再開できない", () => {
    expect(resumeStartAt({ failure: null, rolledBack: false }, noWrap)).toBeNull();
    expect(resumeStartAt({ failure, rolledBack: true }, noWrap)).toBeNull();
    expect(resumeStartAt({ failure, rolledBack: false }, { wrapInTransaction: true })).toBeNull();
  });
});
