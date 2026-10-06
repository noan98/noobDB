import { describe, expect, it } from "vitest";
import {
  applyTableSelectClick,
  EMPTY_TABLE_SELECTION,
  resolveTableSelection,
  tableKey,
  type ExplorerRow,
  type TableSelection,
} from "../components/explorerTree";

/** テーブル選択 (#1399) の純ロジック。 */

const tbl = (db: string, name: string, view = false): ExplorerRow => ({
  key: `tbl:${tableKey(db, name)}`,
  depth: 1,
  parent: `db:${db}`,
  kind: "table",
  db,
  tbl: name,
  view: view ? { name, kind: "view", id: null } : null,
  open: false,
  rowEst: undefined,
  comment: undefined,
  isActive: false,
});

const rows: ExplorerRow[] = [
  tbl("a", "t1"),
  tbl("a", "t2"),
  tbl("a", "v1", true),
  tbl("a", "t3"),
  tbl("b", "u1"),
  tbl("b", "u2"),
];

const click = (sel: TableSelection, db: string, t: string, mode: "single" | "toggle" | "range") =>
  applyTableSelectClick(sel, rows, db, t, mode);
const names = (sel: TableSelection) => resolveTableSelection(sel, rows)?.tables;

describe("applyTableSelectClick", () => {
  it("Ctrl クリックで追加・解除する", () => {
    let s = click(EMPTY_TABLE_SELECTION, "a", "t1", "toggle");
    s = click(s, "a", "t3", "toggle");
    expect(names(s)).toEqual(["t1", "t3"]);
    s = click(s, "a", "t1", "toggle");
    expect(names(s)).toEqual(["t3"]);
  });

  it("Shift クリックはアンカーからの範囲を選び、ビューは含めない", () => {
    let s = click(EMPTY_TABLE_SELECTION, "a", "t1", "single");
    s = click(s, "a", "t3", "range");
    expect(names(s)).toEqual(["t1", "t2", "t3"]);
    // アンカーは保たれ、逆方向にも伸ばせる
    s = click(s, "a", "t2", "range");
    expect(names(s)).toEqual(["t1", "t2"]);
  });

  it("アンカーが無い Shift クリックはその 1 件だけ", () => {
    expect(names(click(EMPTY_TABLE_SELECTION, "a", "t2", "range"))).toEqual(["t2"]);
  });

  it("別 DB の行を Ctrl / Shift クリックしたら選び直す", () => {
    let s = click(EMPTY_TABLE_SELECTION, "a", "t1", "toggle");
    s = click(s, "b", "u1", "toggle");
    expect(resolveTableSelection(s, rows)).toEqual({ db: "b", tables: ["u1"] });
    s = click(s, "a", "t1", "single");
    s = click(s, "b", "u2", "range");
    expect(resolveTableSelection(s, rows)).toEqual({ db: "b", tables: ["u2"] });
  });

  it("修飾キー無しのクリックは選択を解除する", () => {
    const s = click(click(EMPTY_TABLE_SELECTION, "a", "t1", "toggle"), "a", "t2", "single");
    expect(resolveTableSelection(s, rows)).toBeNull();
  });
});

describe("resolveTableSelection", () => {
  it("見えていない行 (折りたたみ・検索) の選択は無視し、行順で返す", () => {
    const s = click(click(EMPTY_TABLE_SELECTION, "a", "t3", "toggle"), "a", "t1", "toggle");
    expect(resolveTableSelection(s, rows)?.tables).toEqual(["t1", "t3"]);
    expect(resolveTableSelection(s, rows.filter((r) => r.kind !== "table" || r.tbl !== "t3"))?.tables).toEqual(["t1"]);
    expect(resolveTableSelection(s, [])).toBeNull();
  });
});
