import { describe, expect, it } from "vitest";
import type { Column } from "../api/tauri";
import {
  addPinned,
  addPinnedWithEvicted,
  defaultKeyColumn,
  pinToastPlan,
  resultsComparable,
  type PinnedResult,
} from "../pinnedCompare";

function cols(...names: string[]): Column[] {
  return names.map((name) => ({ name, type_name: "text" }));
}

function pin(id: string, pinnedAt: number): PinnedResult {
  return {
    id,
    title: id,
    sql: "select 1",
    columns: cols("a"),
    rows: [],
    rowsAffected: 0,
    elapsedMs: 0,
    pinnedAt,
  };
}

describe("resultsComparable", () => {
  it("is true for identical column names in the same order", () => {
    expect(resultsComparable({ columns: cols("id", "name") }, { columns: cols("id", "name") })).toBe(true);
  });

  it("is false when column counts differ", () => {
    expect(resultsComparable({ columns: cols("id") }, { columns: cols("id", "name") })).toBe(false);
  });

  it("is false when names differ or order differs", () => {
    expect(resultsComparable({ columns: cols("id", "name") }, { columns: cols("name", "id") })).toBe(false);
  });

  it("is false for empty column sets", () => {
    expect(resultsComparable({ columns: [] }, { columns: [] })).toBe(false);
  });
});

describe("addPinned", () => {
  it("appends to the end", () => {
    const next = addPinned([pin("a", 1)], pin("b", 2));
    expect(next.map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("does not mutate the input list", () => {
    const list = [pin("a", 1)];
    addPinned(list, pin("b", 2));
    expect(list.map((p) => p.id)).toEqual(["a"]);
  });

  it("evicts the oldest entries beyond the cap", () => {
    let list: PinnedResult[] = [];
    for (let i = 0; i < 5; i++) list = addPinned(list, pin(`p${i}`, i), 3);
    expect(list.map((p) => p.id)).toEqual(["p2", "p3", "p4"]);
  });
});

describe("addPinnedWithEvicted (#1532)", () => {
  it("上限内なら何も外れない", () => {
    const r = addPinnedWithEvicted([pin("a", 1)], pin("b", 2), 3);
    expect(r.list.map((p) => p.id)).toEqual(["a", "b"]);
    expect(r.evicted).toEqual([]);
  });

  it("上限を超えると外れた最古の項目を返す", () => {
    const r = addPinnedWithEvicted([pin("a", 1), pin("b", 2)], pin("c", 3), 2);
    expect(r.list.map((p) => p.id)).toEqual(["b", "c"]);
    expect(r.evicted.map((p) => p.id)).toEqual(["a"]);
  });
});

describe("pinToastPlan (#1277)", () => {
  it("2 件未満は案内のみでアクションを出さない", () => {
    for (const n of [0, 1]) {
      expect(pinToastPlan(n)).toEqual({ messageKey: "pinToastNeedOneMore", showOpenAction: false });
    }
  });
  it("2 件以上は「比較を開く」アクションを出す", () => {
    for (const n of [2, 6]) {
      expect(pinToastPlan(n)).toEqual({ messageKey: "pinToastCompare", showOpenAction: true });
    }
  });
});

describe("defaultKeyColumn", () => {
  it("先頭列が非一意なら、両側で一意な次の列を選ぶ", () => {
    const rows = [
      ["open", 1],
      ["open", 2],
    ];
    expect(defaultKeyColumn({ columns: cols("status", "id"), rows }, { rows })).toBe("id");
  });

  it("右側で重複する列は選ばない", () => {
    const left = [
      ["a", 1],
      ["b", 2],
    ];
    const right = [
      ["a", 1],
      ["a", 2],
    ];
    expect(defaultKeyColumn({ columns: cols("k", "id"), rows: left }, { rows: right })).toBe("id");
  });

  it("一意な列が無ければ先頭列", () => {
    const rows = [
      ["x", null],
      ["x", null],
    ];
    expect(defaultKeyColumn({ columns: cols("a", "b"), rows }, { rows })).toBe("a");
  });
});
