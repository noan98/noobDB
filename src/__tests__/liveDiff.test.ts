import { describe, expect, it } from "vitest";

import type { ProcessInfo } from "../api/tauri";
import { diffLiveRows, uniqueByKey, type LiveField } from "../components/liveDiff";
import { PROCESS_LIVE_FIELDS, processKey } from "../components/processList";
import {
  PLAN_WATCH_LIVE_FIELDS,
  watchedRowKey,
  type PlanGeneration,
  type WatchedRowSnapshot,
} from "../planWatch";

/**
 * ライブ監視パネルの値変化検出 (#1022)。前回スナップショットとの差分を
 * 行 ID で突き合わせる純関数と、プロセス監視 / 計画ウォッチそれぞれの
 * 「変化とみなす」規則を固定する。
 */

interface Row {
  id: number;
  v: string;
  n: number;
}
const FIELDS: readonly LiveField<Row, "v" | "n">[] = [
  { name: "v", changed: (a, b) => a.v !== b.v },
  { name: "n", changed: (a, b) => a.n !== b.n },
];
const key = (r: Row) => r.id;

describe("diffLiveRows (#1022)", () => {
  it("初回 (prev=null) は何もフラッシュしない", () => {
    expect(diffLiveRows(null, [{ id: 1, v: "a", n: 0 }], key, FIELDS).size).toBe(0);
  });

  it("前回が空 (セッション切替直後など) でも何もフラッシュしない", () => {
    expect(diffLiveRows([], [{ id: 1, v: "a", n: 0 }], key, FIELDS).size).toBe(0);
  });

  it("両方に存在する行の、変化したフィールドだけを返す", () => {
    const prev = [
      { id: 1, v: "a", n: 0 },
      { id: 2, v: "b", n: 0 },
    ];
    const next = [
      { id: 1, v: "a", n: 5 },
      { id: 2, v: "b", n: 0 },
    ];
    const d = diffLiveRows(prev, next, key, FIELDS);
    expect([...d.keys()]).toEqual([1]);
    expect([...(d.get(1) ?? [])]).toEqual(["n"]);
  });

  it("複数フィールドの同時変化をまとめて返す", () => {
    const d = diffLiveRows([{ id: 1, v: "a", n: 0 }], [{ id: 1, v: "z", n: 9 }], key, FIELDS);
    expect(d.get(1)).toEqual(new Set(["v", "n"]));
  });

  it("新規行・消えた行は含めない (行の enter / exit が担当)", () => {
    const d = diffLiveRows(
      [{ id: 1, v: "a", n: 0 }],
      [{ id: 2, v: "x", n: 1 }],
      key,
      FIELDS,
    );
    expect(d.size).toBe(0);
  });

  it("並べ替わっただけなら変化なし (ID で突き合わせる)", () => {
    const a = { id: 1, v: "a", n: 0 };
    const b = { id: 2, v: "b", n: 1 };
    expect(diffLiveRows([a, b], [b, a], key, FIELDS).size).toBe(0);
  });

  it("ID が重複したら先勝ちで比較する", () => {
    const d = diffLiveRows(
      [{ id: 1, v: "a", n: 0 }, { id: 1, v: "zzz", n: 0 }],
      [{ id: 1, v: "a", n: 0 }, { id: 1, v: "other", n: 0 }],
      key,
      FIELDS,
    );
    expect(d.size).toBe(0);
  });
});

describe("uniqueByKey (#1022)", () => {
  it("重複が無ければ同じ参照を返す (再描画を誘発しない)", () => {
    const rows = [{ id: 1, v: "a", n: 0 }, { id: 2, v: "b", n: 0 }];
    expect(uniqueByKey(rows, key)).toBe(rows);
  });

  it("重複 ID は先勝ちで取り除く (React key の衝突防止)", () => {
    const rows = [
      { id: 1, v: "a", n: 0 },
      { id: 2, v: "b", n: 0 },
      { id: 1, v: "dup", n: 0 },
    ];
    expect(uniqueByKey(rows, key).map((r) => r.v)).toEqual(["a", "b"]);
  });
});

function proc(id: number, overrides: Partial<ProcessInfo> = {}): ProcessInfo {
  return {
    id,
    user: "app",
    host: "127.0.0.1",
    database: "db",
    command: "Query",
    state: "executing",
    time_secs: 10,
    query: "SELECT 1",
    is_self: false,
    ...overrides,
  };
}

function processDiff(prev: ProcessInfo, next: ProcessInfo): string[] {
  const d = diffLiveRows([prev], [next], processKey, PROCESS_LIVE_FIELDS);
  return [...(d.get(prev.id) ?? [])].sort();
}

describe("PROCESS_LIVE_FIELDS (#1022)", () => {
  it("state / command / query の変化をフラッシュ対象にする", () => {
    expect(processDiff(proc(1), proc(1, { state: "Sending data" }))).toEqual(["state"]);
    expect(processDiff(proc(1), proc(1, { command: "Sleep" }))).toEqual(["command"]);
    expect(processDiff(proc(1), proc(1, { query: "SELECT 2" }))).toEqual(["query"]);
  });

  it("null ⇔ undefined の揺れは変化とみなさない", () => {
    expect(
      processDiff(proc(1, { state: null }), proc(1, { state: undefined as unknown as null })),
    ).toEqual([]);
  });

  it("経過時間の単調な増加はフラッシュしない (CountUp が担当)", () => {
    expect(processDiff(proc(1, { time_secs: 10 }), proc(1, { time_secs: 15 }))).toEqual([]);
    expect(processDiff(proc(1, { time_secs: 10 }), proc(1, { time_secs: 10 }))).toEqual([]);
  });

  it("経過時間が巻き戻った (新しい文が始まった) ときはフラッシュする", () => {
    expect(processDiff(proc(1, { time_secs: 120 }), proc(1, { time_secs: 0 }))).toEqual(["time"]);
  });

  it("経過時間の報告有無が切り替わったらフラッシュする", () => {
    expect(processDiff(proc(1, { time_secs: 5 }), proc(1, { time_secs: null }))).toEqual(["time"]);
    expect(processDiff(proc(1, { time_secs: null }), proc(1, { time_secs: 5 }))).toEqual(["time"]);
    expect(processDiff(proc(1, { time_secs: null }), proc(1, { time_secs: null }))).toEqual([]);
  });

  it("フラッシュ対象外の列 (user / host / database) は無視する", () => {
    expect(processDiff(proc(1), proc(1, { user: "root", host: "h", database: "x" }))).toEqual([]);
  });
});

function gen(id: string): PlanGeneration {
  return {
    id,
    capturedAt: "2026-01-01T00:00:00Z",
    driver: "mysql",
    payloadKind: "json",
    payload: "{}",
  } as PlanGeneration;
}

function watchDiff(prev: WatchedRowSnapshot, next: WatchedRowSnapshot): boolean {
  return diffLiveRows([prev], [next], watchedRowKey, PLAN_WATCH_LIVE_FIELDS).has(prev.id);
}

describe("PLAN_WATCH_LIVE_FIELDS (#1022)", () => {
  it("新しい世代が先頭に記録されたら変化とみなす", () => {
    expect(
      watchDiff(
        { id: "s1", generations: [gen("g1")] },
        { id: "s1", generations: [gen("g2"), gen("g1")] },
      ),
    ).toBe(true);
  });

  it("上限で世代数が頭打ちでも、先頭世代が入れ替われば変化とみなす", () => {
    expect(
      watchDiff(
        { id: "s1", generations: [gen("g2"), gen("g1")] },
        { id: "s1", generations: [gen("g3"), gen("g2")] },
      ),
    ).toBe(true);
  });

  it("同じ世代のままなら変化なし (スニペット名の変更などでは光らない)", () => {
    expect(
      watchDiff(
        { id: "s1", generations: [gen("g2"), gen("g1")] },
        { id: "s1", generations: [gen("g2"), gen("g1")] },
      ),
    ).toBe(false);
  });
});
