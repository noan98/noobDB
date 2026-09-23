import { describe, expect, it } from "vitest";
import {
  classifyScriptDone,
  DEFAULT_SCRIPT_OPTIONS,
  describeScriptError,
  makeScriptStreamId,
  omittedFailureCount,
  scriptProgressPercent,
  scriptProgressRatio,
  toggleScriptOption,
} from "../scriptRun";

describe("toggleScriptOption", () => {
  it("continueOnError と wrapInTransaction は排他", () => {
    const a = toggleScriptOption(DEFAULT_SCRIPT_OPTIONS, "wrapInTransaction");
    expect(a).toEqual({ continueOnError: false, wrapInTransaction: true });
    const b = toggleScriptOption(a, "continueOnError");
    expect(b).toEqual({ continueOnError: true, wrapInTransaction: false });
    const c = toggleScriptOption(b, "wrapInTransaction");
    expect(c).toEqual({ continueOnError: false, wrapInTransaction: true });
  });

  it("OFF にするときはもう片方に触れない", () => {
    const a = toggleScriptOption({ continueOnError: true, wrapInTransaction: false }, "continueOnError");
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
    ).toEqual({ message: "boom", line: 3, sql: "INSERT", rolledBack: true });
    expect(
      describeScriptError({ streamId: "s", error: "no file", failure: null, executed: 0, rolledBack: false }),
    ).toEqual({ message: "no file", line: null, sql: null, rolledBack: false });
  });

  it("stream id は毎回異なる", () => {
    expect(makeScriptStreamId(1)).not.toBe(makeScriptStreamId(1));
  });
});
