import { afterEach, describe, it, expect } from "vitest";

import type { ProcessInfo } from "../api/tauri";
import {
  distinctProcessValues,
  estimateProcessProgress,
  trackProgress,
  type ProgressObservation,
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

import {
  failedKillReasons,
  groupProcessesByQuery,
  PROCESS_PROGRESS_LABEL_KEYS,
  processProgressPercent,
} from "../components/processList";
import { setLocale, t } from "../i18n";

describe("groupProcessesByQuery / processProgressPercent / failedKillReasons (#1622)", () => {
  const p = (id: number, query_summary: string | null, is_self = false): ProcessInfo => ({
    id,
    user: null,
    host: null,
    database: null,
    command: null,
    state: null,
    time_secs: null,
    query_summary,
    query_truncated: false,
    is_self,
    blocked_by: [],
  });

  it("同じ要約が 2 件以上のものを件数順にまとめ、自接続・空要約・単独は除く", () => {
    const groups = groupProcessesByQuery([
      p(5, "SELECT 1"),
      p(3, "SELECT 1"),
      p(9, "SELECT 1", true),
      p(1, "UPDATE t"),
      p(2, "UPDATE t"),
      p(4, "UPDATE t"),
      p(6, "alone"),
      p(7, null),
      p(8, "  "),
      p(10, null),
    ]);
    expect(groups).toEqual([
      { summary: "UPDATE t", ids: [1, 2, 4] },
      { summary: "SELECT 1", ids: [3, 5] },
    ]);
  });

  it("自接続を除いて 1 件になるグループは出ない", () => {
    expect(groupProcessesByQuery([p(1, "x"), p(2, "x", true)])).toEqual([]);
  });

  it("進捗の割合は total が 0 以下なら null、範囲外は丸める", () => {
    expect(processProgressPercent(null)).toBeNull();
    expect(processProgressPercent({ done: 5, total: 0 })).toBeNull();
    expect(processProgressPercent({ done: 1, total: 3 })).toBe(33);
    expect(processProgressPercent({ done: 200, total: 100 })).toBe(100);
    expect(processProgressPercent({ done: -5, total: 100 })).toBe(0);
  });

  it("失敗した id だけ理由を取り出す", () => {
    const m = failedKillReasons([
      { id: 1, status: "killed", error: null },
      { id: 2, status: "failed", error: "permission denied" },
      { id: 3, status: "skipped", error: null },
      { id: 4, status: "failed", error: null },
    ]);
    expect([...m]).toEqual([
      [2, "permission denied"],
      [4, ""],
    ]);
  });
});

describe("進捗の kind ラベル / 進捗順の並べ替え (#2269)", () => {
  afterEach(() => setLocale("en"));

  it("全 kind が en / ja の文言を持つ", () => {
    const kinds = ["vacuum", "create_index", "alter_table", "cluster", "analyze", "copy"];
    expect(Object.keys(PROCESS_PROGRESS_LABEL_KEYS).sort()).toEqual([...kinds].sort());
    for (const loc of ["en", "ja"] as const) {
      setLocale(loc);
      for (const key of Object.values(PROCESS_PROGRESS_LABEL_KEYS)) {
        expect(t(key)).toBeTruthy();
        expect(t(key)).not.toBe(key);
      }
    }
  });

  it("進捗率の高い順、割合なし・進捗なしは末尾", () => {
    const mk = (id: number, progress: ProcessInfo["progress"]): ProcessInfo => ({
      id,
      user: null,
      host: null,
      database: null,
      command: null,
      state: null,
      time_secs: 1,
      query_summary: null,
      query_truncated: false,
      is_self: false,
      blocked_by: [],
      progress,
    });
    const rows = [
      mk(1, null),
      mk(2, { kind: "alter_table", phase: "x", done: 10, total: 100 }),
      mk(3, { kind: "copy", phase: "COPY FROM (5 tuples)", done: 5, total: 0 }),
      mk(4, { kind: "cluster", phase: "y", done: 90, total: 100 }),
    ];
    expect(sortProcesses(rows, "progress").map((r) => r.id)).toEqual([4, 2, 3, 1]);
  });
});

describe("進捗の観測記録と ETA (#2291)", () => {
  const withProgress = (id: number, kind: "vacuum" | "copy", phase: string, done: number, total: number) =>
    proc(id, { progress: { kind, phase, done, total } });

  it("初回観測は起点になり、算出待ちになる", () => {
    const m = trackProgress(new Map(), [withProgress(1, "vacuum", "scanning heap", 10, 100)], 1000);
    const o = m.get(1) as ProgressObservation;
    expect(o).toMatchObject({ firstAt: 1000, firstDone: 10, lastAt: 1000 });
    expect(estimateProcessProgress(o)).toEqual({ kind: "pending" });
  });

  it("2 回目の観測で起点からの速度から ETA を出す", () => {
    const r1 = [withProgress(1, "vacuum", "scanning heap", 10, 100)];
    const m1 = trackProgress(new Map(), r1, 0);
    const m2 = trackProgress(m1, [withProgress(1, "vacuum", "scanning heap", 30, 100)], 10_000);
    const o = m2.get(1) as ProgressObservation;
    expect(o.firstAt).toBe(0);
    expect(o.firstDone).toBe(10);
    // 10 秒で 20 進んだ → 残り 70 は 35 秒。
    expect(estimateProcessProgress(o)).toEqual({ kind: "eta", etaMs: 35_000 });
  });

  it("進みがないと算出待ち、完了済みは ETA 0", () => {
    const m1 = trackProgress(new Map(), [withProgress(1, "vacuum", "a", 10, 100)], 0);
    const m2 = trackProgress(m1, [withProgress(1, "vacuum", "a", 10, 100)], 5000);
    expect(estimateProcessProgress(m2.get(1) as ProgressObservation)).toEqual({ kind: "pending" });
    const m3 = trackProgress(m2, [withProgress(1, "vacuum", "a", 100, 100)], 9000);
    expect(estimateProcessProgress(m3.get(1) as ProgressObservation)).toEqual({ kind: "eta", etaMs: 0 });
  });

  it("フェーズ変化・done の巻き戻りでは起点を取り直す", () => {
    const m1 = trackProgress(new Map(), [withProgress(1, "vacuum", "scanning heap", 50, 100)], 0);
    const phase = trackProgress(m1, [withProgress(1, "vacuum", "vacuuming indexes", 60, 100)], 4000);
    expect(phase.get(1)).toMatchObject({ firstAt: 4000, firstDone: 60 });
    const back = trackProgress(m1, [withProgress(1, "vacuum", "scanning heap", 5, 100)], 4000);
    expect(back.get(1)).toMatchObject({ firstAt: 4000, firstDone: 5 });
  });

  it("一覧から消えた pid・進捗のない行は捨て、戻ってきたら新規扱い", () => {
    const m1 = trackProgress(new Map(), [withProgress(1, "vacuum", "a", 10, 100)], 0);
    const gone = trackProgress(m1, [proc(1)], 1000);
    expect(gone.size).toBe(0);
    const back = trackProgress(gone, [withProgress(1, "vacuum", "a", 20, 100)], 2000);
    expect(back.get(1)).toMatchObject({ firstAt: 2000, firstDone: 20 });
    // 入力は変更しない。
    expect(m1.get(1)).toMatchObject({ firstAt: 0 });
  });

  it("総量不明の COPY は行/秒、1 秒未満は算出待ち", () => {
    const m1 = trackProgress(new Map(), [withProgress(2, "copy", "COPY FROM", 0, 0)], 0);
    const short = trackProgress(m1, [withProgress(2, "copy", "COPY FROM", 500, 0)], 500);
    expect(estimateProcessProgress(short.get(2) as ProgressObservation)).toEqual({ kind: "pending" });
    const m2 = trackProgress(m1, [withProgress(2, "copy", "COPY FROM", 5000, 0)], 2000);
    expect(estimateProcessProgress(m2.get(2) as ProgressObservation)).toEqual({ kind: "rate", perSec: 2500 });
  });
});
