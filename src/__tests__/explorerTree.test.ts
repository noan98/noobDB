import { describe, expect, it } from "vitest";
import type { IndexInfo, SchemaObject, TableColumnInfo } from "../api/tauri";
import {
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
  it("PostgreSQL / DuckDB のデータベース階層はスキーマ", () => {
    expect(explorerContainerKind("postgres")).toBe("schema");
    expect(explorerContainerKind("duckdb")).toBe("schema");
  });

  it("それ以外はデータベース", () => {
    for (const d of ["mysql", "sqlite", "mssql", "unknown"]) {
      expect(explorerContainerKind(d)).toBe("database");
    }
  });
});
