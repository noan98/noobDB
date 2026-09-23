import { describe, expect, it } from "vitest";
import { statusLogClass, statusTone, type Status } from "../statusMessage";
import { appendMessage, MESSAGE_LIMIT, type MessageEntry } from "../messageLog";
import {
  appendOutput,
  countProblems,
  filterOutput,
  isProblemOutcome,
  outputSummary,
  sqlHeadline,
  type OutputEntry,
} from "../outputLog";

/**
 * Bottom Panel のログ系タブ (#1114) の純ロジック。
 *
 * - 出力 (`outputLog.ts`) — 実行した文ごとの結末
 * - メッセージ (`messageLog.ts` + `statusMessage.ts`) — ステータスバーの履歴
 *
 * どちらも「後から読み返す」ための置き場なので、**何を残し何を落とすか**
 * (途中経過を積まない・自動リフレッシュの tick で埋まらない・別のエラーを畳まない)
 * が壊れると役に立たなくなる。その規則をここで固定する。
 */

describe("statusTone (App.tsx から切り出した重大度判定)", () => {
  it("既知キーの重大度は error フラグより優先する", () => {
    expect(statusTone({ kind: "key", key: "statusConnectionLost", error: true })).toBe("critical");
    expect(statusTone({ kind: "key", key: "statusQueryTimeoutPartial", error: true })).toBe("warning");
    expect(statusTone({ kind: "key", key: "statusRunningQuery" })).toBe("running");
  });

  it("キーのステータスは既定で成功、error なら失敗、切断は情報", () => {
    expect(statusTone({ kind: "key", key: "statusStreamingDone" })).toBe("success");
    expect(statusTone({ kind: "key", key: "statusQueryError", error: true })).toBe("error");
    expect(statusTone({ kind: "key", key: "appDisconnected" })).toBe("info");
  });

  it("文字列のステータスは error の有無だけで決まる", () => {
    expect(statusTone({ kind: "literal", text: "x" })).toBe("info");
    expect(statusTone({ kind: "literal", text: "x", error: true })).toBe("error");
  });
});

describe("statusLogClass (メッセージ履歴に残すかどうか)", () => {
  it("idle と途中経過は残さない (ストリーミング中の行数更新で履歴が埋まらない)", () => {
    const skipped: Status[] = [
      { kind: "idle" },
      { kind: "key", key: "statusRunningQuery" },
      { kind: "key", key: "statusStreaming", vars: { rows: 10, elapsed: "1s" } },
      { kind: "key", key: "statusPreviewStreaming" },
      { kind: "key", key: "statusLoadingMore" },
      { kind: "key", key: "statusBatchRunning", vars: { total: 3 } },
      { kind: "key", key: "statusConnecting" },
      { kind: "key", key: "statusReconnectingAttempt" },
      { kind: "key", key: "statusApplyingEdits" },
    ];
    for (const s of skipped) expect(statusLogClass(s, "text")).toBeNull();
  });

  it("結果のメッセージは重大度付きで残す (critical は error に畳む)", () => {
    expect(statusLogClass({ kind: "key", key: "statusStreamingDone" }, "done")?.severity).toBe("success");
    expect(statusLogClass({ kind: "key", key: "statusQueryError", error: true }, "boom")?.severity).toBe("error");
    expect(statusLogClass({ kind: "key", key: "statusConnectionLost" }, "lost")?.severity).toBe("error");
    expect(statusLogClass({ kind: "key", key: "statusQueryTimeout" }, "slow")?.severity).toBe("warning");
    expect(statusLogClass({ kind: "literal", text: "hello" }, "hello")?.severity).toBe("info");
  });

  it("成功はキー単位、エラーは本文単位で同一視する", () => {
    // 自動リフレッシュの「取得完了」は件数・時間が毎回違っても同じ行に畳む。
    const a = statusLogClass({ kind: "key", key: "statusStreamingDone", vars: { rows: 1, ms: 2 } }, "1 rows 2 ms");
    const b = statusLogClass({ kind: "key", key: "statusStreamingDone", vars: { rows: 5, ms: 9 } }, "5 rows 9 ms");
    expect(a?.dedupeKey).toBe(b?.dedupeKey);
    // 同じキーでもエラー本文が違えば別の出来事。
    const e1 = statusLogClass({ kind: "key", key: "statusQueryError", error: true }, "syntax error at 1");
    const e2 = statusLogClass({ kind: "key", key: "statusQueryError", error: true }, "duplicate key");
    expect(e1?.dedupeKey).not.toBe(e2?.dedupeKey);
  });
});

describe("appendMessage", () => {
  const entry = (id: number, dedupeKey: string, severity: MessageEntry["severity"] = "success") => ({
    id,
    at: id * 1000,
    severity,
    message: `m${id}`,
    dedupeKey,
  });

  it("新しいものを先頭に積む", () => {
    const list = appendMessage(appendMessage([], entry(1, "a")), entry(2, "b"));
    expect(list.map((e) => e.message)).toEqual(["m2", "m1"]);
    expect(list.every((e) => e.repeat === 1)).toBe(true);
  });

  it("直前と同じ種類なら 1 行に畳んで回数を数える (id は据え置き、本文・時刻は新しい方)", () => {
    let list = appendMessage([], entry(1, "a"));
    list = appendMessage(list, entry(2, "a"));
    list = appendMessage(list, entry(3, "a"));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 1, repeat: 3, message: "m3", at: 3000 });
  });

  it("直前でなければ畳まない / 重大度が違えば畳まない", () => {
    let list = appendMessage([], entry(1, "a"));
    list = appendMessage(list, entry(2, "b"));
    list = appendMessage(list, entry(3, "a"));
    expect(list).toHaveLength(3);
    const mixed = appendMessage(appendMessage([], entry(1, "a", "success")), entry(2, "a", "error"));
    expect(mixed).toHaveLength(2);
  });

  it("上限を超えた古い分は捨てる。入力は変更しない", () => {
    let list: MessageEntry[] = [];
    for (let i = 1; i <= MESSAGE_LIMIT + 5; i++) list = appendMessage(list, entry(i, `k${i}`));
    expect(list).toHaveLength(MESSAGE_LIMIT);
    expect(list[0].id).toBe(MESSAGE_LIMIT + 5);
    const frozen = Object.freeze([...list]) as MessageEntry[];
    appendMessage(frozen, entry(999, "z"));
    expect(frozen).toHaveLength(MESSAGE_LIMIT);
    expect(appendMessage(list, entry(1000, "z"), 0)).toEqual([]);
  });
});

describe("outputLog", () => {
  const out = (id: number, outcome: OutputEntry["outcome"], extra: Partial<OutputEntry> = {}): OutputEntry => ({
    id,
    at: id,
    sql: `select ${id}`,
    outcome,
    rows: 1,
    elapsedMs: 5,
    error: null,
    connection: "local",
    database: "app",
    ...extra,
  });

  it("問題あり = エラー / タイムアウト / キャンセル / スキップ", () => {
    expect(isProblemOutcome("rows")).toBe(false);
    expect(isProblemOutcome("affected")).toBe(false);
    for (const o of ["error", "timeout", "cancelled", "skipped"] as const) {
      expect(isProblemOutcome(o)).toBe(true);
    }
  });

  it("絞り込みと件数", () => {
    const list = [out(1, "rows"), out(2, "error"), out(3, "affected"), out(4, "skipped")];
    expect(filterOutput(list, "all")).toHaveLength(4);
    expect(filterOutput(list, "problems").map((e) => e.id)).toEqual([2, 4]);
    expect(countProblems(list)).toBe(2);
  });

  it("先頭に積み、上限で古い方を捨てる", () => {
    const list = appendOutput(appendOutput([], out(1, "rows")), out(2, "rows"), 1);
    expect(list.map((e) => e.id)).toEqual([2]);
    expect(appendOutput([], out(1, "rows"), 0)).toEqual([]);
  });

  it("SQL の見出しは空白を潰して長すぎれば省略する", () => {
    expect(sqlHeadline("select\n  *\n\tfrom  t")).toBe("select * from t");
    const long = sqlHeadline("x".repeat(50), 10);
    expect(long).toHaveLength(10);
    expect(long.endsWith("…")).toBe(true);
  });

  it("要約は結末ごとの i18n キー。エラーは 1 行目だけ", () => {
    expect(outputSummary(out(1, "rows", { rows: 3, elapsedMs: 7 }))).toEqual({
      key: "outputSummaryRows",
      vars: { rows: 3, ms: 7 },
    });
    expect(outputSummary(out(1, "affected")).key).toBe("outputSummaryAffected");
    expect(outputSummary(out(1, "timeout")).key).toBe("outputSummaryTimeout");
    expect(outputSummary(out(1, "cancelled")).key).toBe("outputSummaryCancelled");
    expect(outputSummary(out(1, "skipped")).key).toBe("outputSummarySkipped");
    expect(outputSummary(out(1, "error", { error: "line one\nline two" }))).toEqual({
      key: "outputSummaryError",
      vars: { error: "line one" },
    });
  });

});
