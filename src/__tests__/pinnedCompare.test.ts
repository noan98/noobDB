import { describe, expect, it } from "vitest";
import type { Column } from "../api/tauri";
import {
  addPinned,
  addPinnedWithEvicted,
  alignResultsByName,
  defaultKeyColumn,
  keyUniqueness,
  mapColumnsByName,
  resultsComparableByName,
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

describe("mapColumnsByName (#1625)", () => {
  it("同じ列が同じ順なら exact", () => {
    const m = mapColumnsByName({ columns: cols("id", "name") }, { columns: cols("id", "name") });
    expect(m.exact).toBe(true);
    expect(m.shared).toEqual(["id", "name"]);
  });

  it("列順が違っても列名で対応づける (左の列順)", () => {
    const m = mapColumnsByName(
      { columns: cols("id", "name", "age") },
      { columns: cols("age", "id", "name") },
    );
    expect(m.exact).toBe(false);
    expect(m.shared).toEqual(["id", "name", "age"]);
    expect(m.leftIndices).toEqual([0, 1, 2]);
    expect(m.rightIndices).toEqual([1, 2, 0]);
    expect(m.leftOnly).toEqual([]);
    expect(m.rightOnly).toEqual([]);
  });

  it("片方にだけある列は対象外として分けて返す", () => {
    const m = mapColumnsByName({ columns: cols("id", "a") }, { columns: cols("b", "id") });
    expect(m.shared).toEqual(["id"]);
    expect(m.leftOnly).toEqual(["a"]);
    expect(m.rightOnly).toEqual(["b"]);
    expect(m.exact).toBe(false);
  });

  it("片側に同名の列が複数あれば曖昧として外す (誤って組まない)", () => {
    const m = mapColumnsByName({ columns: cols("id", "id", "x") }, { columns: cols("id", "x") });
    expect(m.shared).toEqual(["x"]);
    expect(m.ambiguous).toEqual(["id"]);
    expect(m.exact).toBe(false);
  });
});

describe("resultsComparableByName (#1625)", () => {
  it("共通の列が 1 つでもあれば true、無ければ false", () => {
    expect(resultsComparableByName({ columns: cols("a", "b") }, { columns: cols("b", "c") })).toBe(true);
    expect(resultsComparableByName({ columns: cols("a") }, { columns: cols("b") })).toBe(false);
    expect(resultsComparableByName({ columns: [] }, { columns: [] })).toBe(false);
  });
});

describe("alignResultsByName (#1625)", () => {
  const mk = (names: string[], rows: (string | number | null)[][]) => ({ columns: cols(...names), rows });

  it("共通の列だけを左の列順にそろえて射影する", () => {
    const left = mk(["id", "name", "only_l"], [[1, "a", "x"]]);
    const right = mk(["name", "only_r", "id"], [["a", "y", 1]]);
    const m = mapColumnsByName(left, right);
    const out = alignResultsByName(left, right, m);
    expect(out.left.columns.map((c) => c.name)).toEqual(["id", "name"]);
    expect(out.right.columns.map((c) => c.name)).toEqual(["id", "name"]);
    expect(out.left.rows).toEqual([[1, "a"]]);
    expect(out.right.rows).toEqual([[1, "a"]]);
  });

  it("完全一致なら元のオブジェクトをそのまま返す", () => {
    const left = mk(["id"], [[1]]);
    const right = mk(["id"], [[2]]);
    const out = alignResultsByName(left, right, mapColumnsByName(left, right));
    expect(out.left).toBe(left);
    expect(out.right).toBe(right);
  });
});

describe("keyUniqueness (#1625)", () => {
  it("重複したキーの行数と NULL キーの行数を数える", () => {
    const rows = [
      [1, "a"],
      [1, "b"],
      [2, "c"],
      [null, "d"],
    ];
    expect(keyUniqueness(rows, [0])).toEqual({ duplicateRows: 2, nullKeyRows: 1 });
  });

  it("複合キーなら組で見る (片方だけ同じでも重複ではない)", () => {
    const rows = [
      [1, "a"],
      [1, "b"],
    ];
    expect(keyUniqueness(rows, [0, 1])).toEqual({ duplicateRows: 0, nullKeyRows: 0 });
    expect(keyUniqueness(rows, [0])).toEqual({ duplicateRows: 2, nullKeyRows: 0 });
  });

  it("キー列が無ければ 0", () => {
    expect(keyUniqueness([[1]], [])).toEqual({ duplicateRows: 0, nullKeyRows: 0 });
  });

  it("数値 1 と文字列 '1' は同じキーとして数える (差分描画と同じ文字列化)", () => {
    expect(keyUniqueness([[1], ["1"]], [0]).duplicateRows).toBe(2);
  });
});
