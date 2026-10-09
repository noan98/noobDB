import { describe, expect, it } from "vitest";
import {
  CLOSED_TAB_HISTORY_LIMIT,
  closedTabCount,
  insertTabIdAt,
  orderForRestore,
  popClosedGroup,
  pushClosedGroup,
  resolveRestorePaneId,
  sanitizeClosedTabSnapshot,
  shouldRememberClosedTab,
  summarizeClosedGroup,
  type ClosedTabGroup,
} from "../closedTabHistory";

const group = (id: string, n: number, paneId = "p1"): ClosedTabGroup<string> => ({
  id,
  entries: Array.from({ length: n }, (_, i) => ({ snapshot: `${id}-${i}`, paneId, index: i })),
});

describe("pushClosedGroup / popClosedGroup", () => {
  it("新しいグループが先頭に積まれ、pop は最新から返す", () => {
    let h = pushClosedGroup([], group("a", 1));
    h = pushClosedGroup(h, group("b", 1));
    expect(h.map((g) => g.id)).toEqual(["b", "a"]);
    const r = popClosedGroup(h);
    expect(r.group?.id).toBe("b");
    expect(r.history.map((g) => g.id)).toEqual(["a"]);
  });

  it("空グループは積まない", () => {
    expect(pushClosedGroup([], group("a", 0))).toEqual([]);
  });

  it("合計が上限を超えたら古いグループから捨てる", () => {
    let h = pushClosedGroup([], group("a", 10), 20);
    h = pushClosedGroup(h, group("b", 10), 20);
    expect(closedTabCount(h)).toBe(20);
    h = pushClosedGroup(h, group("c", 1), 20);
    expect(h.map((g) => g.id)).toEqual(["c", "b"]);
    expect(closedTabCount(h)).toBe(11);
  });

  it("最新グループ単体が上限を超えるときは先頭の上限件数だけ残す", () => {
    const h = pushClosedGroup([], group("a", 5), 3);
    expect(h).toHaveLength(1);
    expect(h[0].entries.map((e) => e.snapshot)).toEqual(["a-0", "a-1", "a-2"]);
  });

  it("既定の上限は定数に従う", () => {
    let h = pushClosedGroup([], group("a", 1));
    for (let i = 0; i < CLOSED_TAB_HISTORY_LIMIT + 5; i++) h = pushClosedGroup(h, group(`g${i}`, 1));
    expect(closedTabCount(h)).toBe(CLOSED_TAB_HISTORY_LIMIT);
  });

  it("id 指定で途中のグループを取り出せる。無い id では何も変えない", () => {
    let h = pushClosedGroup([], group("a", 1));
    h = pushClosedGroup(h, group("b", 1));
    h = pushClosedGroup(h, group("c", 1));
    const r = popClosedGroup(h, "b");
    expect(r.group?.id).toBe("b");
    expect(r.history.map((g) => g.id)).toEqual(["c", "a"]);
    const miss = popClosedGroup(h, "zzz");
    expect(miss.group).toBeNull();
    expect(miss.history).toBe(h);
    expect(popClosedGroup([]).group).toBeNull();
  });

  it("元の履歴は破壊しない", () => {
    const h = pushClosedGroup([], group("a", 1));
    pushClosedGroup(h, group("b", 1));
    popClosedGroup(h);
    expect(h.map((g) => g.id)).toEqual(["a"]);
  });
});

describe("orderForRestore", () => {
  it("位置の昇順に並べ、同位置は元の順を保つ", () => {
    const entries = [
      { snapshot: "x", paneId: "p", index: 3 },
      { snapshot: "y", paneId: "p", index: 1 },
      { snapshot: "z", paneId: "p", index: 1 },
    ];
    expect(orderForRestore(entries).map((e) => e.snapshot)).toEqual(["y", "z", "x"]);
  });
});

describe("resolveRestorePaneId", () => {
  it("元のペインが残っていればそこ", () => {
    expect(resolveRestorePaneId(["a", "b"], "b", "a")).toBe("b");
  });
  it("元のペインが無ければアクティブペイン", () => {
    expect(resolveRestorePaneId(["a", "b"], "gone", "b")).toBe("b");
  });
  it("どちらも無ければ先頭、ペインが無ければ null", () => {
    expect(resolveRestorePaneId(["a", "b"], "gone", null)).toBe("a");
    expect(resolveRestorePaneId(["a", "b"], "gone", "also-gone")).toBe("a");
    expect(resolveRestorePaneId([], "gone", null)).toBeNull();
  });
});

describe("insertTabIdAt", () => {
  it("指定位置に挿入する", () => {
    expect(insertTabIdAt(["a", "b", "c"], 1, "x")).toEqual(["a", "x", "b", "c"]);
  });
  it("範囲外・不正値は端に丸める", () => {
    expect(insertTabIdAt(["a"], 99, "x")).toEqual(["a", "x"]);
    expect(insertTabIdAt(["a"], -3, "x")).toEqual(["x", "a"]);
    expect(insertTabIdAt(["a"], Number.NaN, "x")).toEqual(["x", "a"]);
    expect(insertTabIdAt([], 0, "x")).toEqual(["x"]);
  });
  it("一括クローズを位置昇順で戻すと元の並びになる", () => {
    const original = ["a", "b", "c", "d"];
    let ids = ["a"]; // b,c,d を閉じた後
    for (const [idx, id] of [[1, "b"], [2, "c"], [3, "d"]] as const) ids = insertTabIdAt(ids, idx, id);
    expect(ids).toEqual(original);
  });
});

describe("shouldRememberClosedTab", () => {
  it("空のクエリ/EXPLAIN タブは積まない", () => {
    expect(shouldRememberClosedTab({ kind: "query", sql: "" })).toBe(false);
    expect(shouldRememberClosedTab({ kind: "query", sql: " \n\t" })).toBe(false);
    expect(shouldRememberClosedTab({ kind: "explain", sql: "" })).toBe(false);
  });
  it("SQL があるタブとテーブルタブは積む", () => {
    expect(shouldRememberClosedTab({ kind: "query", sql: "SELECT 1" })).toBe(true);
    expect(shouldRememberClosedTab({ kind: "table", sql: "" })).toBe(true);
  });
});

describe("summarizeClosedGroup", () => {
  it("先頭タブのタイトルと残り枚数", () => {
    const g = group("a", 3);
    expect(summarizeClosedGroup(g, (s) => s.toUpperCase())).toEqual({ title: "A-0", extra: 2 });
    expect(summarizeClosedGroup(group("e", 0), (s) => s)).toEqual({ title: "", extra: 0 });
  });
});

describe("sanitizeClosedTabSnapshot", () => {
  const dirty = {
    id: "t1",
    title: "my query",
    titleManual: true,
    sql: "SELECT 1",
    result: { rows: [[1]] },
    preview: { rows: [] },
    streaming: true,
    previewStreaming: true,
    loadingMore: true,
    canLoadMore: true,
    autoLimitApplied: 100,
    autoLimitSql: "SELECT 1",
    queryError: "boom",
    pendingEdits: { 0: { 1: "x" } },
    editUndoStack: [{}],
    editRedoStack: [{}],
    pendingDeletes: ["a"],
    pendingInserts: [{}],
    batchRunning: true,
    batchResults: [{}],
    batchScript: "SELECT 1;",
    applyingEdits: true,
    autoRefreshSecs: 5,
    prevResultRows: [[1]],
    prevResultSql: "SELECT 1",
    diffHighlight: true,
    partialResult: { reason: "timeout", rows: 3 },
  };

  it("実行中フラグ・結果・未確定編集・前回結果を既定値へ戻す", () => {
    const s = sanitizeClosedTabSnapshot(dirty);
    expect(s.batchRunning).toBe(false);
    expect(s.streaming).toBe(false);
    expect(s.previewStreaming).toBe(false);
    expect(s.applyingEdits).toBe(false);
    expect(s.result).toBeNull();
    expect(s.preview).toBeNull();
    expect(s.prevResultRows).toBeNull();
    expect(s.prevResultSql).toBeNull();
    expect(s.partialResult).toBeNull();
    expect(s.diffHighlight).toBe(false);
    expect(s.batchResults).toBeUndefined();
    expect(s.pendingDeletes).toBeUndefined();
    expect(s.pendingInserts).toBeUndefined();
    expect(s.pendingEdits).toEqual({});
    expect(s.editUndoStack).toEqual([]);
    expect(s.autoRefreshSecs).toBeNull();
    expect(s.queryError).toBeNull();
  });

  it("タイトル・手動命名フラグ・SQL など結果でない項目は引き継ぎ、元は破壊しない", () => {
    const s = sanitizeClosedTabSnapshot(dirty);
    expect(s.title).toBe("my query");
    expect(s.titleManual).toBe(true);
    expect(s.sql).toBe("SELECT 1");
    expect(dirty.batchRunning).toBe(true);
  });
});
