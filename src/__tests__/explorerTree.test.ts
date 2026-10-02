import { describe, expect, it } from "vitest";
import type { IndexInfo, SchemaObject, TableColumnInfo } from "../api/tauri";
import {
  buildExplorerRows,
  explorerRowExpansion,
  explorerRowLabel,
  isFocusableExplorerRow,
  type ExplorerRowsInput,
  explorerContainerKind,
  foreignKeysOf,
  foreignKeyTargetLabel,
  partitionDatabaseNodes,
  showTablesHeader,
  tableChildGroups,
} from "../components/explorerTree";

/**
 * Database Explorer の階層整理 (#1112)。`list_tables` は全ドライバでビューも返すため、
 * 以前はビューが「テーブル一覧」と「ビュー」グループの 2 箇所に別物として出ていた。
 * 1 箇所へ振り分ける規則と、テーブル配下の列 / インデックス / 外部キーの組み立てを固定する。
 */

const col = (name: string, over: Partial<TableColumnInfo> = {}): TableColumnInfo => ({
  name,
  data_type: "int",
  nullable: true,
  key: "",
  default: null,
  extra: "",
  referenced_table: null,
  referenced_column: null,
  ...over,
});

const obj = (kind: SchemaObject["kind"], name: string, id: string | null = null): SchemaObject => ({
  kind,
  name,
  id,
});

const idx = (name: string, columns: string[], over: Partial<IndexInfo> = {}): IndexInfo => ({
  name,
  columns,
  unique: false,
  primary: false,
  method: null,
  ...over,
});

describe("partitionDatabaseNodes", () => {
  it("list_tables に含まれるビューをテーブルから外して「ビュー」へ移す (順は list_tables)", () => {
    const g = partitionDatabaseNodes(
      ["orders", "v_sales", "users", "mv_daily"],
      [obj("materialized_view", "mv_daily", "9"), obj("view", "v_sales", "7"), obj("function", "f1")],
    );
    expect(g.tables).toEqual(["orders", "users"]);
    expect(g.views).toEqual([
      { name: "v_sales", kind: "view", id: "7" },
      { name: "mv_daily", kind: "materialized_view", id: "9" },
    ]);
    expect(g.objects).toEqual([obj("function", "f1")]);
  });

  it("オブジェクト未取得の間はすべてテーブルとして扱う", () => {
    const g = partitionDatabaseNodes(["a", "b"], undefined);
    expect(g).toEqual({ tables: ["a", "b"], views: [], objects: [] });
  });

  it("list_tables と名前が突き合わないビューは定義だけのオブジェクトとして残す (消さない)", () => {
    const g = partitionDatabaseNodes(["t"], [obj("view", "dbo.v_other")]);
    expect(g.tables).toEqual(["t"]);
    expect(g.views).toEqual([]);
    expect(g.objects).toEqual([obj("view", "dbo.v_other")]);
  });

  it("残りのオブジェクトは ビュー → マテビュー → プロシージャ → 関数 → トリガー の順 (同種内は元の順)", () => {
    const g = partitionDatabaseNodes(
      [],
      [
        obj("trigger", "tr1"),
        obj("function", "f2"),
        obj("procedure", "p1"),
        obj("function", "f1"),
        obj("view", "v1"),
        obj("materialized_view", "m1"),
      ],
    );
    expect(g.objects.map((o) => o.name)).toEqual(["v1", "m1", "p1", "f2", "f1", "tr1"]);
  });
});

describe("showTablesHeader", () => {
  it("テーブルしか無いデータベースでは見出しを出さない", () => {
    expect(showTablesHeader(partitionDatabaseNodes(["a"], []))).toBe(false);
  });

  it("ビューやルーチンと並ぶときだけ見出しを出す", () => {
    expect(showTablesHeader(partitionDatabaseNodes(["a", "v"], [obj("view", "v")]))).toBe(true);
    expect(showTablesHeader(partitionDatabaseNodes(["a"], [obj("trigger", "tr")]))).toBe(true);
  });

  it("テーブルが 0 件なら見出しを出さない", () => {
    expect(showTablesHeader(partitionDatabaseNodes(["v"], [obj("view", "v")]))).toBe(false);
  });
});

describe("foreignKeysOf / foreignKeyTargetLabel", () => {
  it("参照先を持つ列だけを列順で取り出す", () => {
    const fks = foreignKeysOf([
      col("id", { key: "PRI" }),
      col("user_id", { referenced_table: "users", referenced_column: "id" }),
      col("note"),
      col("org_id", { referenced_table: "orgs", referenced_column: null }),
    ]);
    expect(fks).toEqual([
      { column: "user_id", referencedTable: "users", referencedColumn: "id" },
      { column: "org_id", referencedTable: "orgs", referencedColumn: null },
    ]);
    expect(fks.map(foreignKeyTargetLabel)).toEqual(["users.id", "orgs"]);
  });
});

describe("tableChildGroups", () => {
  const pk: IndexInfo = { name: "PRIMARY", columns: ["id"], unique: true, primary: true, method: null };

  it("列だけのテーブルでは「列」見出しを出さない", () => {
    expect(tableChildGroups([col("id")], [])).toEqual({
      showColumnsHeader: false,
      indexes: [],
      foreignKeys: [],
    });
  });

  it("インデックスか外部キーと並ぶときは見出しを出す", () => {
    expect(tableChildGroups([col("id")], [pk]).showColumnsHeader).toBe(true);
    expect(
      tableChildGroups([col("u", { referenced_table: "users" })], undefined).showColumnsHeader,
    ).toBe(true);
  });

  it("インデックス未取得 (undefined) は空として扱う", () => {
    expect(tableChildGroups([col("id")], undefined).indexes).toEqual([]);
  });
});

describe("explorerContainerKind", () => {
  it("PostgreSQL のデータベース階層はスキーマ", () => {
    expect(explorerContainerKind("postgres")).toBe("schema");
  });

  it("それ以外はデータベース", () => {
    for (const d of ["mysql", "sqlite", "unknown"]) {
      expect(explorerContainerKind(d)).toBe("database");
    }
  });
});

describe("buildExplorerRows: 見えている行のフラット配列 (#1315)", () => {
  const base = (over: Partial<ExplorerRowsInput> = {}): ExplorerRowsInput => ({
    databases: ["db1", "db2"],
    tables: {},
    schemaObjects: {},
    tableColumns: {},
    tableIndexes: {},
    expandedDbs: {},
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
  const keys = (input: ExplorerRowsInput) => buildExplorerRows(input).map((r) => r.key);

  it("閉じている DB の子は配列に入らない", () => {
    expect(keys(base({ tables: { db1: ["a", "b"] } }))).toEqual(["db:db1", "db:db2"]);
  });

  it("開いた DB の下にテーブルが並び、テーブルの子は閉じていれば入らない", () => {
    const rows = buildExplorerRows(base({ expandedDbs: { db1: true }, tables: { db1: ["a", "b"] } }));
    expect(rows.map((r) => [r.key, r.depth])).toEqual([
      ["db:db1", 0],
      ["tbl:db1::a", 1],
      ["tbl:db1::b", 1],
      ["db:db2", 0],
    ]);
  });

  it("テーブルを開くと列 → インデックス → 外部キーの順に、見出し付きで並ぶ", () => {
    const rows = buildExplorerRows(
      base({
        databases: ["db1"],
        expandedDbs: { db1: true },
        expandedTables: { "db1::a": true },
        tables: { db1: ["a"] },
        tableColumns: { "db1::a": [col("id"), col("ref", { referenced_table: "b", referenced_column: "id" })] },
        tableIndexes: { "db1::a": [idx("PRIMARY", ["id"], { primary: true })] },
      }),
    );
    expect(rows.map((r) => r.key)).toEqual([
      "db:db1",
      "tbl:db1::a",
      "hdr:cols:db1::a",
      "col:db1::a:id",
      "col:db1::a:ref",
      "hdr:idx:db1::a",
      "idx:db1::a:PRIMARY",
      "hdr:fk:db1::a",
      "fk:db1::a:ref",
    ]);
    expect(rows.filter((r) => r.kind === "column").every((r) => r.depth === 2)).toBe(true);
  });

  it("列しか無いテーブルでは「列」見出しを出さない", () => {
    const rows = buildExplorerRows(
      base({
        databases: ["db1"],
        expandedDbs: { db1: true },
        expandedTables: { "db1::a": true },
        tables: { db1: ["a"] },
        tableColumns: { "db1::a": [col("id")] },
      }),
    );
    expect(rows.map((r) => r.kind)).toEqual(["db", "table", "column"]);
  });

  it("未取得はローディング行、取得済みで空なら空表示の行になる", () => {
    const loading = buildExplorerRows(base({ databases: ["db1"], expandedDbs: { db1: true } }));
    expect(loading.map((r) => r.kind)).toEqual(["db", "loading"]);
    const empty = buildExplorerRows(base({ databases: ["db1"], expandedDbs: { db1: true }, tables: { db1: [] } }));
    expect(empty.map((r) => r.kind)).toEqual(["db", "empty"]);
    const colsLoading = buildExplorerRows(
      base({
        databases: ["db1"],
        expandedDbs: { db1: true },
        expandedTables: { "db1::a": true },
        tables: { db1: ["a"] },
      }),
    );
    expect(colsLoading.map((r) => r.kind)).toEqual(["db", "table", "loading"]);
    expect(buildExplorerRows(base({ databases: null })).map((r) => r.kind)).toEqual(["loading"]);
    expect(buildExplorerRows(base({ databases: [] })).map((r) => r.kind)).toEqual(["empty"]);
  });

  it("テーブルとビューとルーチンが並ぶときは見出しが付き、ビューはテーブルと同じ行になる", () => {
    const rows = buildExplorerRows(
      base({
        databases: ["db1"],
        expandedDbs: { db1: true },
        tables: { db1: ["t", "v"] },
        schemaObjects: { db1: [obj("view", "v"), obj("procedure", "p")] },
      }),
    );
    expect(rows.map((r) => r.key)).toEqual([
      "db:db1",
      "hdr:tables:db1",
      "tbl:db1::t",
      "hdr:views:db1",
      "tbl:db1::v",
      "hdr:obj:db1:procedure",
      "so:db1:procedure:p:",
    ]);
    const header = rows.find((r) => r.key === "hdr:tables:db1");
    expect(header && header.kind === "header" && header.count).toBe(1);
  });

  it("定義を開けない (showObjects=false) ときはルーチンの行を出さない", () => {
    const rows = buildExplorerRows(
      base({
        databases: ["db1"],
        expandedDbs: { db1: true },
        tables: { db1: ["t"] },
        schemaObjects: { db1: [obj("procedure", "p")] },
        showObjects: false,
      }),
    );
    expect(rows.some((r) => r.kind === "object")).toBe(false);
  });

  it("クイックアクセスは DB の前に、お気に入り → 最近の順で並ぶ", () => {
    const rows = buildExplorerRows(
      base({
        databases: ["db1"],
        favorites: [{ database: "db1", table: "a" }],
        recent: [{ database: "db1", table: "b" }],
      }),
    );
    expect(rows.map((r) => r.key)).toEqual([
      "hdr:favorites",
      "qa:favorite:db1::a",
      "hdr:recent",
      "qa:recent:db1::b",
      "db:db1",
    ]);
  });

  describe("スキーマ検索 (schemaFiltered) の強制展開", () => {
    const matchers = (dbs: string[], tables: string[], colTables: string[]) => ({
      db: (db: string) => dbs.includes(db),
      table: (db: string, tbl: string) => tables.includes(`${db}::${tbl}`),
      column: (db: string, tbl: string) => colTables.includes(`${db}::${tbl}`),
    });

    it("ヒットしない DB は出さず、ヒットした DB は閉じていても開く", () => {
      const rows = buildExplorerRows(
        base({
          query: "orders",
          schemaFiltered: true,
          tables: { db1: ["orders", "users"], db2: ["x"] },
          matchers: matchers(["db1"], ["db1::orders"], []),
        }),
      );
      // users は名前がヒットしないので出ない。db2 は丸ごと出ない。
      expect(rows.map((r) => r.key)).toEqual(["db:db1", "tbl:db1::orders"]);
    });

    it("DB 名自体がヒットしていれば、その DB のテーブルは全部出す", () => {
      const rows = buildExplorerRows(
        base({
          databases: ["shop"],
          query: "shop",
          schemaFiltered: true,
          tables: { shop: ["a", "b"] },
          matchers: matchers(["shop"], [], []),
        }),
      );
      expect(rows.map((r) => r.key)).toEqual(["db:shop", "tbl:shop::a", "tbl:shop::b"]);
    });

    it("列名がヒットしたテーブルは強制的に開き、ヒットした列だけを出す (インデックス・外部キーは出さない)", () => {
      const rows = buildExplorerRows(
        base({
          databases: ["db1"],
          query: "email",
          schemaFiltered: true,
          tables: { db1: ["users"] },
          tableColumns: { "db1::users": [col("id"), col("email")] },
          tableIndexes: { "db1::users": [idx("i", ["email"])] },
          matchers: matchers(["db1"], ["db1::users"], ["db1::users"]),
        }),
      );
      expect(rows.map((r) => r.key)).toEqual(["db:db1", "tbl:db1::users", "col:db1::users:email"]);
    });

    it("テーブル名がヒットしたテーブルは、開いていれば列を全部出す", () => {
      const rows = buildExplorerRows(
        base({
          databases: ["db1"],
          query: "users",
          schemaFiltered: true,
          expandedTables: { "db1::users": true },
          tables: { db1: ["users"] },
          tableColumns: { "db1::users": [col("id"), col("email")] },
          matchers: matchers(["db1"], ["db1::users"], []),
        }),
      );
      expect(rows.map((r) => r.key)).toEqual(["db:db1", "tbl:db1::users", "col:db1::users:id", "col:db1::users:email"]);
    });

    it("絞り込み中はルーチン / トリガーの行を出さない", () => {
      const rows = buildExplorerRows(
        base({
          databases: ["db1"],
          query: "t",
          schemaFiltered: true,
          tables: { db1: ["t"] },
          schemaObjects: { db1: [obj("procedure", "t_proc")] },
          matchers: matchers(["db1"], ["db1::t"], []),
        }),
      );
      expect(rows.some((r) => r.kind === "object")).toBe(false);
    });

    it("プロファイル自身がヒットした検索 (schemaFiltered=false) は展開状態どおりに全部出す", () => {
      const rows = buildExplorerRows(
        base({ databases: ["db1"], query: "alpha", tables: { db1: ["a"] }, expandedDbs: { db1: true } }),
      );
      expect(rows.map((r) => r.key)).toEqual(["db:db1", "tbl:db1::a"]);
    });
  });

  it("フォーカスできる行にだけ、同じ親の中での位置と総数を振る", () => {
    const rows = buildExplorerRows(
      base({
        expandedDbs: { db1: true },
        tables: { db1: ["a", "b", "c"] },
        favorites: [{ database: "db1", table: "a" }],
      }),
    );
    const byKey = new Map(rows.map((r) => [r.key, r]));
    // ルート直下 (お気に入り 1 件 + DB 2 件) は 3 件。
    expect(byKey.get("qa:favorite:db1::a")).toMatchObject({ posInSet: 1, setSize: 3 });
    expect(byKey.get("db:db1")).toMatchObject({ posInSet: 2, setSize: 3 });
    expect(byKey.get("db:db2")).toMatchObject({ posInSet: 3, setSize: 3 });
    expect(byKey.get("tbl:db1::b")).toMatchObject({ posInSet: 2, setSize: 3 });
    expect(byKey.get("hdr:favorites")?.posInSet).toBeUndefined();
  });

  it("同じ列配列のあいだは外部キーのオブジェクトが同一参照になる (行の memo を保つ)", () => {
    const cols = [col("ref", { referenced_table: "b", referenced_column: "id" })];
    const input = base({
      databases: ["db1"],
      expandedDbs: { db1: true },
      expandedTables: { "db1::a": true },
      tables: { db1: ["a"] },
      tableColumns: { "db1::a": cols },
    });
    const fk = (rows: ReturnType<typeof buildExplorerRows>) => rows.find((r) => r.kind === "foreignKey");
    const a = fk(buildExplorerRows(input));
    const b = fk(buildExplorerRows(input));
    expect(a && a.kind === "foreignKey" && a.fk).toBe(b && b.kind === "foreignKey" ? b.fk : null);
  });

  it("行のラベル・展開状態・フォーカス可否を返す", () => {
    const rows = buildExplorerRows(
      base({
        databases: ["db1"],
        expandedDbs: { db1: true },
        tables: { db1: ["a"] },
      }),
    );
    const [db, tbl] = rows;
    expect(explorerRowLabel(db)).toBe("db1");
    expect(explorerRowLabel(tbl)).toBe("a");
    expect(explorerRowExpansion(db)).toEqual({ expandable: true, open: true });
    expect(explorerRowExpansion(tbl)).toEqual({ expandable: true, open: false });
    const loading = buildExplorerRows(base({ databases: null }))[0];
    expect(isFocusableExplorerRow(loading)).toBe(false);
    expect(isFocusableExplorerRow(db)).toBe(true);
  });
});
