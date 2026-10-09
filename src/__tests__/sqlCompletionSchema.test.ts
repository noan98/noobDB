// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { ForeignKey, TableColumnInfo } from "../api/tauri";
import { buildColumnInfoDom } from "../components/sqlCompletionInfo";
import {
  buildCompletionNamespace,
  completionIconName,
  completionKind,
  describeColumn,
  findForeignKey,
} from "../components/sqlCompletionSchema";

const meta = (over: Partial<TableColumnInfo> = {}): TableColumnInfo => ({
  name: "id",
  data_type: "int",
  nullable: false,
  key: "",
  default: null,
  extra: "",
  referenced_table: null,
  referenced_column: null,
  ...over,
});
const fk = (over: Partial<ForeignKey> = {}): ForeignKey => ({
  table: "orders",
  column: "customer_id",
  referenced_table: "customers",
  referenced_column: "id",
  constraint_name: null,
  ...over,
});

describe("completionKind / completionIconName", () => {
  it("CodeMirror の型を 4 種別に写し、種別ごとに別アイコンになる", () => {
    expect(completionKind("type")).toBe("table");
    expect(completionKind("property")).toBe("column");
    expect(completionKind("keyword")).toBe("keyword");
    expect(completionKind("function")).toBe("function");
    expect(completionKind("constant")).toBeNull();
    expect(completionKind(undefined)).toBeNull();
    const icons = (["table", "column", "keyword", "function"] as const).map(completionIconName);
    expect(new Set(icons).size).toBe(4);
  });
});

describe("describeColumn", () => {
  it("メタも FK も無ければ null", () => {
    expect(describeColumn(undefined, undefined)).toBeNull();
  });
  it("型・NULL 可否・主キー・FK 参照先を返す", () => {
    expect(describeColumn(meta({ key: "PRI", nullable: true }), fk())).toEqual({
      dataType: "int",
      nullable: true,
      primaryKey: true,
      references: "customers.id",
    });
  });
  it("メタ未取得でも FK だけに縮退する", () => {
    expect(describeColumn(undefined, fk())).toEqual({
      dataType: null,
      nullable: null,
      primaryKey: false,
      references: "customers.id",
    });
  });
  it("参照列が不明ならテーブル名のみ", () => {
    expect(describeColumn(undefined, fk({ referenced_column: null }))?.references).toBe("customers");
  });
  it("FK 一覧が無くてもメタの参照先を使う", () => {
    const v = describeColumn(meta({ referenced_table: "t", referenced_column: "c" }), undefined);
    expect(v?.references).toBe("t.c");
  });
});

describe("findForeignKey", () => {
  it("テーブルと列で引く", () => {
    const fks = [fk(), fk({ table: "x", column: "y" })];
    expect(findForeignKey(fks, "orders", "customer_id")).toBe(fks[0]);
    expect(findForeignKey(fks, "orders", "nope")).toBeUndefined();
  });
});

describe("buildCompletionNamespace", () => {
  const tableColumns = { orders: ["id", "customer_id"], customers: ["id"] };
  it("テーブルが無ければ null", () => {
    expect(buildCompletionNamespace({ driver: "mysql", tableColumns: {} })).toBeNull();
  });
  it("MySQL は裸と DB 修飾の両方で公開し、既定テーブル/スキーマを返す", () => {
    const r = buildCompletionNamespace({
      driver: "mysql",
      tableColumns,
      activeTable: { database: "app", name: "orders" },
    });
    const schema = r?.schema as Record<string, unknown>;
    expect(Object.keys(schema).sort()).toEqual(["app", "customers", "orders"]);
    expect(Object.keys(schema.app as object).sort()).toEqual(["customers", "orders"]);
    expect(r?.defaultTable).toBe("orders");
    expect(r?.defaultSchema).toBe("app");
  });
  it("SQLite は DB 修飾しない", () => {
    const r = buildCompletionNamespace({ driver: "sqlite", tableColumns, defaultDatabase: "main" });
    expect(Object.keys(r?.schema as object).sort()).toEqual(["customers", "orders"]);
  });
  it("列候補は property 型で、columnInfo があれば info が付く", () => {
    const calls: string[] = [];
    const r = buildCompletionNamespace({
      driver: "sqlite",
      tableColumns,
      columnInfo: (t, c) => {
        calls.push(`${t}.${c}`);
        return () => null;
      },
    });
    const cols = (r?.schema as Record<string, { label: string; type: string; info: unknown }[]>).orders;
    expect(cols.map((c) => c.label)).toEqual(["id", "customer_id"]);
    expect(cols.every((c) => c.type === "property" && typeof c.info === "function")).toBe(true);
    expect(calls).toContain("orders.customer_id");
  });
  it("columnInfo が無ければ info を持たない", () => {
    const r = buildCompletionNamespace({ driver: "sqlite", tableColumns });
    const cols = (r?.schema as Record<string, object[]>).orders;
    expect("info" in cols[0]).toBe(false);
  });
});

describe("buildColumnInfoDom", () => {
  const labels = {
    nullable: "NULL 可",
    notNull: "NOT NULL",
    primaryKey: "主キー",
    foreignKey: (t: string) => `FK → ${t}`,
  };
  it("型・NULL 可否・主キー・FK を行で出す", () => {
    const el = buildColumnInfoDom(
      { dataType: "int", nullable: false, primaryKey: true, references: "customers.id" },
      labels,
    );
    expect(el.querySelector(".cm-completionInfoType")?.textContent).toBe("int");
    expect(el.querySelector(".cm-completionInfoFlags")?.textContent).toBe("NOT NULL · 主キー");
    expect(el.querySelector(".cm-completionInfoFk")?.textContent).toBe("FK → customers.id");
  });
  it("メタ未取得なら FK 行だけ", () => {
    const el = buildColumnInfoDom(
      { dataType: null, nullable: null, primaryKey: false, references: "t.c" },
      labels,
    );
    expect(el.children).toHaveLength(1);
  });
});
