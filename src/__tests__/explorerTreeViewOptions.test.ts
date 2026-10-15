// @vitest-environment jsdom (localStorage に触れるため)
import { describe, expect, it } from "vitest";
import type { SchemaObject } from "../api/tauri";
import {
  buildExplorerRows,
  type ExplorerRowsInput,
  parseExplorerTableSort,
  partitionDatabaseNodes,
  sortByRowEstimate,
} from "../components/explorerTree";
import { normalizeSchemaTree, saveSchemaTree, loadSchemaTree } from "../schemaTreeState";

/** スキーマツリーの種別絞り込みと並べ替え (#1629)。 */

const obj = (kind: SchemaObject["kind"], name: string, id: string | null = null): SchemaObject => ({
  kind,
  name,
  id,
});

const base = (over: Partial<ExplorerRowsInput> = {}): ExplorerRowsInput => ({
  databases: ["db1"],
  tables: { db1: ["a", "b", "v1", "c"] },
  schemaObjects: { db1: [obj("view", "v1", "1"), obj("procedure", "p1"), obj("trigger", "t1")] },
  tableColumns: {},
  tableIndexes: {},
  expandedDbs: { db1: true },
  expandedTables: {},
  query: "",
  schemaFiltered: false,
  matchers: null,
  partition: (_db, tables, objects) => partitionDatabaseNodes(tables, objects),
  showObjects: true,
  favorites: [],
  recent: [],
  rowEstimate: () => undefined,
  comment: () => undefined,
  isActiveTable: () => false,
  ...over,
});
const keys = (i: ExplorerRowsInput) => buildExplorerRows(i).map((r) => r.key);

describe("種別の絞り込み", () => {
  it("all は従来どおり全グループを出す", () => {
    expect(keys(base({ kindFilter: "all" }))).toEqual(keys(base()));
    expect(keys(base())).toContain("hdr:tables:db1");
    expect(keys(base())).toContain("so:db1:procedure:p1:");
  });

  it("tables はテーブルだけ (見出しも出さない)", () => {
    expect(keys(base({ kindFilter: "tables" }))).toEqual([
      "db:db1",
      "tbl:db1::a",
      "tbl:db1::b",
      "tbl:db1::c",
    ]);
  });

  it("views はビューだけ", () => {
    expect(keys(base({ kindFilter: "views" }))).toEqual(["db:db1", "hdr:views:db1", "tbl:db1::v1"]);
  });

  it("views は list_tables に載らないビュー (objects に残る分) も出す", () => {
    const k = keys(
      base({
        tables: { db1: ["a"] },
        schemaObjects: { db1: [obj("view", "ghost", "9"), obj("function", "f1")] },
        kindFilter: "views",
      }),
    );
    expect(k).toEqual(["db:db1", "hdr:obj:db1:view", "so:db1:view:ghost:9"]);
  });

  it("routines はプロシージャ / 関数 / トリガーだけ", () => {
    expect(keys(base({ kindFilter: "routines" }))).toEqual([
      "db:db1",
      "hdr:obj:db1:procedure",
      "so:db1:procedure:p1:",
      "hdr:obj:db1:trigger",
      "so:db1:trigger:t1:",
    ]);
  });

  it("該当が無い DB には空の行を出す", () => {
    const rows = buildExplorerRows(
      base({ tables: { db1: ["a"] }, schemaObjects: { db1: [] }, kindFilter: "routines" }),
    );
    expect(rows.map((r) => r.key)).toEqual(["db:db1", "ph:filtered:db1"]);
    expect(rows[1]).toMatchObject({ kind: "empty", message: "filtered" });
  });

  it("検索 (matchers) とは独立で、両方が効く", () => {
    const k = keys(
      base({
        query: "a",
        schemaFiltered: true,
        matchers: { db: () => true, table: (_d, t) => t === "a" || t === "v1", column: () => false },
        kindFilter: "tables",
      }),
    );
    expect(k).toEqual(["db:db1", "tbl:db1::a"]);
  });
});

describe("並べ替え", () => {
  const est: Record<string, number | null | undefined> = { a: 10, b: 5000, c: null, v1: 70 };
  it("rows は推定行数の多い順、推定なしは末尾、同数は取得順", () => {
    const k = keys(base({ tableSort: "rows", rowEstimate: (_d, t) => est[t] }));
    expect(k).toEqual([
      "db:db1",
      "hdr:tables:db1",
      "tbl:db1::b",
      "tbl:db1::a",
      "tbl:db1::c",
      "hdr:views:db1",
      "tbl:db1::v1",
      "hdr:obj:db1:procedure",
      "so:db1:procedure:p1:",
      "hdr:obj:db1:trigger",
      "so:db1:trigger:t1:",
    ]);
  });

  it("name は取得順のまま", () => {
    const k = keys(base({ tableSort: "name", rowEstimate: (_d, t) => est[t] }));
    expect(k.slice(2, 5)).toEqual(["tbl:db1::a", "tbl:db1::b", "tbl:db1::c"]);
  });

  it("sortByRowEstimate は同数なら元の順を保つ", () => {
    expect(
      sortByRowEstimate(
        ["x", "y", "z"],
        "rows",
        (s) => s,
        () => 1,
      ),
    ).toEqual(["x", "y", "z"]);
    expect(
      sortByRowEstimate(
        ["x", "y"],
        "name",
        (s) => s,
        () => 1,
      ),
    ).toEqual(["x", "y"]);
  });
});

describe("並べ替えの永続化", () => {
  it("parseExplorerTableSort は不正値を name にする", () => {
    expect(parseExplorerTableSort("rows")).toBe("rows");
    expect(parseExplorerTableSort("updated")).toBe("name");
    expect(parseExplorerTableSort(undefined)).toBe("name");
  });

  it("normalizeSchemaTree は既定の name を載せない", () => {
    expect(normalizeSchemaTree({ dbs: ["a"], tables: [] })).toEqual({ dbs: { a: true }, tables: {} });
    expect(normalizeSchemaTree({ dbs: [], tables: [], sort: "rows" })).toEqual({
      dbs: {},
      tables: {},
      sort: "rows",
    });
  });

  it("開いたノードが無くても並べ替えが既定でなければ保存する", () => {
    saveSchemaTree("p-sort", { dbs: {}, tables: {}, sort: "rows" });
    expect(loadSchemaTree("p-sort").sort).toBe("rows");
    saveSchemaTree("p-sort", { dbs: {}, tables: {}, sort: "name" });
    expect(localStorage.getItem("noobdb.schematree.p-sort")).toBeNull();
  });
});
