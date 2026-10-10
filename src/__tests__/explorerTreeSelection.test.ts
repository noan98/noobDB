import { describe, expect, it } from "vitest";
import {
  anchorTableSelection,
  buildExplorerRows,
  EMPTY_TABLE_SELECTION,
  extendTableSelection,
  isTableSelected,
  orderedSelectedTables,
  partitionDatabaseNodes,
  pruneTableSelection,
  rangeTableSelection,
  selectedTableCount,
  toggleTableSelection,
  type ExplorerRow,
  type TableSelection,
} from "../components/explorerTree";

/** テーブルの複数選択モデル (#1399)。 */

function rowsFor(tables: Record<string, string[]>, views: Record<string, string[]> = {}): ExplorerRow[] {
  const dbs = Object.keys(tables);
  return buildExplorerRows({
    databases: dbs,
    tables: Object.fromEntries(dbs.map((d) => [d, [...tables[d], ...(views[d] ?? [])]])),
    schemaObjects: Object.fromEntries(
      dbs.map((d) => [d, (views[d] ?? []).map((name) => ({ kind: "view" as const, name, id: null }))]),
    ),
    tableColumns: {},
    tableIndexes: {},
    expandedDbs: Object.fromEntries(dbs.map((d) => [d, true])),
    expandedTables: {},
    query: "",
    schemaFiltered: false,
    matchers: null,
    partition: (_db, t, o) => partitionDatabaseNodes(t, o),
    showObjects: true,
    favorites: [],
    recent: [],
    rowEstimate: () => undefined,
    comment: () => undefined,
    isActiveTable: () => false,
  });
}

const names = (sel: TableSelection, db: string, all: string[]) => orderedSelectedTables({ ...sel, db }, all);

describe("toggleTableSelection (Ctrl/Cmd クリック)", () => {
  it("出し入れでき、起点が更新される", () => {
    let sel = toggleTableSelection(EMPTY_TABLE_SELECTION, "d", "a");
    sel = toggleTableSelection(sel, "d", "c");
    expect(isTableSelected(sel, "d", "a")).toBe(true);
    expect(isTableSelected(sel, "d", "c")).toBe(true);
    expect(selectedTableCount(sel)).toBe(2);
    expect(sel.anchor).toBe("d::c");
    sel = toggleTableSelection(sel, "d", "a");
    expect(isTableSelected(sel, "d", "a")).toBe(false);
    expect(selectedTableCount(sel)).toBe(1);
  });

  it("別のデータベースのテーブルを選ぶと選択を取り直す", () => {
    let sel = toggleTableSelection(EMPTY_TABLE_SELECTION, "d1", "a");
    sel = toggleTableSelection(sel, "d1", "b");
    sel = toggleTableSelection(sel, "d2", "x");
    expect(sel.db).toBe("d2");
    expect([...sel.keys]).toEqual(["d2::x"]);
    // 別 DB の同名テーブルは選択扱いにならない。
    expect(isTableSelected(sel, "d1", "a")).toBe(false);
  });
});

describe("anchorTableSelection (通常クリック)", () => {
  it("選択を解除して起点だけを残す。同じ状態なら同一参照", () => {
    const sel = toggleTableSelection(toggleTableSelection(EMPTY_TABLE_SELECTION, "d", "a"), "d", "b");
    const next = anchorTableSelection(sel, "d", "c");
    expect(selectedTableCount(next)).toBe(0);
    expect(next.anchor).toBe("d::c");
    expect(anchorTableSelection(next, "d", "c")).toBe(next);
  });
});

describe("rangeTableSelection (Shift クリック)", () => {
  const rows = rowsFor({ d: ["a", "b", "c", "d", "e"], e: ["x", "y"] }, { d: ["v1"] });

  it("起点から対象までを選ぶ (順方向・逆方向)", () => {
    const start = anchorTableSelection(EMPTY_TABLE_SELECTION, "d", "b");
    expect(names(rangeTableSelection(start, rows, "d", "d"), "d", ["a", "b", "c", "d", "e"])).toEqual(["b", "c", "d"]);
    expect(names(rangeTableSelection(start, rows, "d", "a"), "d", ["a", "b", "c", "d", "e"])).toEqual(["a", "b"]);
  });

  it("起点は動かさず、続けて Shift クリックすると範囲が伸び縮みする", () => {
    const start = anchorTableSelection(EMPTY_TABLE_SELECTION, "d", "b");
    const r1 = rangeTableSelection(start, rows, "d", "e");
    const r2 = rangeTableSelection(r1, rows, "d", "c");
    expect(r2.anchor).toBe("d::b");
    expect(names(r2, "d", ["a", "b", "c", "d", "e"])).toEqual(["b", "c"]);
  });

  it("起点が無い / 別 DB のときは対象だけを選んで起点にする", () => {
    const none = rangeTableSelection(EMPTY_TABLE_SELECTION, rows, "d", "c");
    expect([...none.keys]).toEqual(["d::c"]);
    expect(none.anchor).toBe("d::c");
    const other = rangeTableSelection(anchorTableSelection(EMPTY_TABLE_SELECTION, "e", "x"), rows, "d", "c");
    expect([...other.keys]).toEqual(["d::c"]);
  });

  it("ビューは範囲に含めない", () => {
    const start = anchorTableSelection(EMPTY_TABLE_SELECTION, "d", "a");
    const sel = rangeTableSelection(start, rows, "d", "e");
    expect(sel.keys.has("d::v1")).toBe(false);
    expect(selectedTableCount(sel)).toBe(5);
  });

  it("additive なら既存の選択に足す", () => {
    let sel = toggleTableSelection(EMPTY_TABLE_SELECTION, "d", "a");
    sel = anchorTableSelection(sel, "d", "c");
    sel = rangeTableSelection({ ...sel, keys: new Set(["d::a"]) }, rows, "d", "d", true);
    expect(names(sel, "d", ["a", "b", "c", "d", "e"])).toEqual(["a", "c", "d"]);
  });
});

describe("extendTableSelection (Shift+矢印)", () => {
  const rows = rowsFor({ d: ["a", "b", "c"] }, { d: ["v1"] });

  it("起点が無ければ現在行を起点に、隣のテーブル行へ伸ばす", () => {
    const r = extendTableSelection(EMPTY_TABLE_SELECTION, rows, "d", "a", 1);
    expect(r?.focusKey).toBe("tbl:d::b");
    expect(names(r!.selection, "d", ["a", "b", "c"])).toEqual(["a", "b"]);
    const r2 = extendTableSelection(r!.selection, rows, "d", "b", 1);
    expect(names(r2!.selection, "d", ["a", "b", "c"])).toEqual(["a", "b", "c"]);
    // 戻ると縮む。
    const r3 = extendTableSelection(r2!.selection, rows, "d", "c", -1);
    expect(names(r3!.selection, "d", ["a", "b", "c"])).toEqual(["a", "b"]);
  });

  it("隣がテーブル行でない (ビュー見出し・端) ときは null", () => {
    expect(extendTableSelection(EMPTY_TABLE_SELECTION, rows, "d", "c", 1)).toBeNull();
    expect(extendTableSelection(EMPTY_TABLE_SELECTION, rows, "d", "a", -1)).toBeNull();
  });
});

describe("pruneTableSelection", () => {
  it("消えたテーブルを外し、変化が無ければ同一参照", () => {
    const sel = toggleTableSelection(toggleTableSelection(EMPTY_TABLE_SELECTION, "d", "a"), "d", "b");
    expect(pruneTableSelection(sel, { d: ["a", "b", "c"] })).toBe(sel);
    const pruned = pruneTableSelection(sel, { d: ["b"] });
    expect([...pruned.keys]).toEqual(["d::b"]);
    expect(pruned.anchor).toBe("d::b");
  });

  it("データベースの一覧が無くなったら空にする", () => {
    const sel = toggleTableSelection(EMPTY_TABLE_SELECTION, "d", "a");
    expect(pruneTableSelection(sel, {})).toBe(EMPTY_TABLE_SELECTION);
    expect(pruneTableSelection(sel, { d: [] }).keys.size).toBe(0);
  });
});

describe("orderedSelectedTables", () => {
  it("データベース内の並びで返す", () => {
    let sel = toggleTableSelection(EMPTY_TABLE_SELECTION, "d", "c");
    sel = toggleTableSelection(sel, "d", "a");
    expect(orderedSelectedTables(sel, ["a", "b", "c"])).toEqual(["a", "c"]);
    expect(orderedSelectedTables(EMPTY_TABLE_SELECTION, ["a"])).toEqual([]);
  });
});
