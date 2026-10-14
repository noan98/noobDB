import { describe, it, expect } from "vitest";

import type { ProcessInfo } from "../api/tauri";
import {
  distinctProcessValues,
  EMPTY_PROCESS_FILTER,
  filterProcesses,
  formatProcessTime,
  isProcessFilterActive,
  pruneSelection,
  reconcileKillTargets,
  sortProcesses,
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
    query_summary: null,
    query_truncated: false,
    is_self: false,
    blocked_by: [],
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

describe("reconcileKillTargets (pid 再利用)", () => {
  it("同じプロセスのままの id だけを残す", () => {
    const shown = [proc(1), proc(2)];
    const out = reconcileKillTargets([1, 2], shown, [proc(1), proc(2), proc(3)]);
    expect(out).toEqual({ keep: [1, 2], dropped: [] });
  });

  it("確認中に消えた id・別接続に再利用された id は外す", () => {
    const shown = [proc(1), proc(2, { host: "10.0.0.1:1111" })];
    const fresh = [proc(2, { host: "10.0.0.9:2222" })];
    expect(reconcileKillTargets([1, 2], shown, fresh)).toEqual({ keep: [], dropped: [1, 2] });
  });

  it("確認時点の一覧に無かった id は fail-closed で外す", () => {
    expect(reconcileKillTargets([9], [proc(1)], [proc(9)])).toEqual({ keep: [], dropped: [9] });
  });
});

describe("filterProcesses / sortProcesses (#1538)", () => {
  const rows = [
    proc(1, {
      user: "app",
      database: "shop",
      command: "Query",
      time_secs: 5,
      query_summary: "SELECT * FROM Orders",
    }),
    proc(2, { user: "batch", database: "shop", command: "Sleep", time_secs: 300 }),
    proc(3, { user: "app", database: "log", command: "Query", time_secs: null, state: "Sending data" }),
    proc(4, { user: null, database: null, command: null, time_secs: 60, host: "10.0.0.7:5000" }),
  ];
  const ids = (xs: readonly ProcessInfo[]) => xs.map((p) => p.id);

  it("条件なしなら入力をそのまま返す", () => {
    expect(isProcessFilterActive(EMPTY_PROCESS_FILTER)).toBe(false);
    expect(filterProcesses(rows, EMPTY_PROCESS_FILTER)).toBe(rows);
    expect(isProcessFilterActive({ ...EMPTY_PROCESS_FILTER, text: "  " })).toBe(false);
  });

  it("ユーザ・DB・状態は完全一致で絞る (null は空文字扱い)", () => {
    expect(ids(filterProcesses(rows, { ...EMPTY_PROCESS_FILTER, user: "app" }))).toEqual([1, 3]);
    expect(ids(filterProcesses(rows, { ...EMPTY_PROCESS_FILTER, database: "shop" }))).toEqual([1, 2]);
    expect(ids(filterProcesses(rows, { ...EMPTY_PROCESS_FILTER, command: "Query" }))).toEqual([1, 3]);
    expect(ids(filterProcesses(rows, { ...EMPTY_PROCESS_FILTER, user: "app", database: "log" }))).toEqual([
      3,
    ]);
  });

  it("経過秒は以上で絞り、境界値を含み、不明 (null) は除外する", () => {
    expect(ids(filterProcesses(rows, { ...EMPTY_PROCESS_FILTER, minSecs: 60 }))).toEqual([2, 4]);
    expect(ids(filterProcesses(rows, { ...EMPTY_PROCESS_FILTER, minSecs: 61 }))).toEqual([2]);
    expect(ids(filterProcesses(rows, { ...EMPTY_PROCESS_FILTER, minSecs: 1 }))).toEqual([1, 2, 4]);
  });

  it("テキスト検索は id・ホスト・状態・クエリ要約を大文字小文字無視で部分一致する", () => {
    expect(ids(filterProcesses(rows, { ...EMPTY_PROCESS_FILTER, text: "orders" }))).toEqual([1]);
    expect(ids(filterProcesses(rows, { ...EMPTY_PROCESS_FILTER, text: "SENDING" }))).toEqual([3]);
    expect(ids(filterProcesses(rows, { ...EMPTY_PROCESS_FILTER, text: "10.0.0.7" }))).toEqual([4]);
    expect(ids(filterProcesses(rows, { ...EMPTY_PROCESS_FILTER, text: "2" }))).toContain(2);
    expect(filterProcesses(rows, { ...EMPTY_PROCESS_FILTER, text: "nothing-matches" })).toEqual([]);
  });

  it("条件は AND で組み合わさる", () => {
    expect(
      ids(filterProcesses(rows, { ...EMPTY_PROCESS_FILTER, user: "app", minSecs: 1, text: "orders" })),
    ).toEqual([1]);
  });

  it("501 件目以降も絞り込み後に先頭側へ現れる (描画上限の前に適用する)", () => {
    const many = Array.from({ length: 800 }, (_, i) => proc(i + 1, { time_secs: i === 799 ? 9999 : 1 }));
    const top = sortProcesses(filterProcesses(many, { ...EMPTY_PROCESS_FILTER, minSecs: 100 }), "timeDesc");
    expect(ids(top)).toEqual([800]);
  });

  it("経過時間の降順 / 昇順で並べ、不明は常に末尾、同値は id 昇順、入力は変更しない", () => {
    const before = ids(rows);
    expect(ids(sortProcesses(rows, "timeDesc"))).toEqual([2, 4, 1, 3]);
    expect(ids(sortProcesses(rows, "timeAsc"))).toEqual([1, 4, 2, 3]);
    expect(ids(rows)).toEqual(before);
    const ties = [proc(9, { time_secs: 5 }), proc(3, { time_secs: 5 }), proc(5, { time_secs: -1 })];
    expect(ids(sortProcesses(ties, "timeDesc"))).toEqual([3, 9, 5]);
  });

  it("default はそのまま、id は昇順", () => {
    expect(sortProcesses(rows, "default")).toBe(rows);
    expect(ids(sortProcesses([proc(3), proc(1), proc(2)], "id"))).toEqual([1, 2, 3]);
  });

  it("distinctProcessValues は null / 空を除き重複なしの昇順で返す", () => {
    expect(distinctProcessValues(rows, "user")).toEqual(["app", "batch"]);
    expect(distinctProcessValues(rows, "database")).toEqual(["log", "shop"]);
    expect(distinctProcessValues([proc(1, { command: "" })], "command")).toEqual([]);
  });
});
