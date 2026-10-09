// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { ForeignKey, TableColumnInfo } from "../api/tauri";
import { buildColumnInfoDom } from "../components/sqlCompletionInfo";
import {
  buildCompletionNamespace,
  completionIconName,
  completionKind,
  functionCompletions,
  dialectWords,
  identApply,
  keywordCompletionBuilder,
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
    expect(completionKind("table")).toBe("table");
    expect(completionKind("type")).toBe("keyword"); // INT などのデータ型名
    expect(completionKind("variable")).toBe("keyword");
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
    const app = schema.app as { self: { type: string }; children: object };
    expect(app.self.type).toBe("namespace");
    expect(Object.keys(app.children).sort()).toEqual(["customers", "orders"]);
    expect((schema.orders as { self: unknown }).self).toEqual({ label: "orders", type: "table" });
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
    const cols = (r?.schema as Record<string, { children: { label: string; type: string; info: unknown }[] }>)
      .orders.children;
    expect(cols.map((c) => c.label)).toEqual(["id", "customer_id"]);
    expect(cols.every((c) => c.type === "property" && typeof c.info === "function")).toBe(true);
    expect(calls).toContain("orders.customer_id");
  });
  it("PostgreSQL は DB 修飾し、大文字・空白・日本語の名前は二重引用符で apply する", () => {
    const r = buildCompletionNamespace({
      driver: "postgres",
      tableColumns: { Users: ["UserId", "order date", "名前", "snake_case"] },
      defaultDatabase: "app",
    });
    const schema = r?.schema as unknown as Record<string, { self: { apply?: string }; children: { label: string; apply?: string }[] }>;
    expect(Object.keys(schema).sort()).toEqual(["Users", "app"]);
    expect(schema.Users.self.apply).toBe('"Users"');
    expect(schema.Users.children.map((c) => c.apply)).toEqual(['"UserId"', '"order date"', '"名前"', undefined]);
  });
  it("columnInfo が無ければ info を持たない", () => {
    const r = buildCompletionNamespace({ driver: "sqlite", tableColumns });
    const cols = (r?.schema as Record<string, { children: object[] }>).orders.children;
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

describe("identApply", () => {
  it("snake_case は apply なし、大文字・空白・日本語・数字始まりは方言のクォートで apply", () => {
    expect(identApply("mysql", "order_id")).toEqual({});
    expect(identApply("mysql", "UserId")).toEqual({ apply: "`UserId`" });
    expect(identApply("mysql", "order date")).toEqual({ apply: "`order date`" });
    expect(identApply("postgres", "名前")).toEqual({ apply: '"名前"' });
    expect(identApply("sqlite", "1col")).toEqual({ apply: '"1col"' });
    expect(identApply("postgres", 'a"b')).toEqual({ apply: '"a""b"' });
  });
});

describe("functionCompletions / keywordCompletionBuilder", () => {
  const all = (d: string) => {
    const words = dialectWords(d);
    const build = keywordCompletionBuilder(d);
    const kws = Object.keys(words).map((k) => build(k.toUpperCase(), "keyword"));
    const fns = functionCompletions(d, (l) => l in words);
    return { kws, fns, all: [...kws, ...fns] };
  };
  it("方言語彙が取得できる", () => {
    expect(Object.keys(dialectWords("mysql")).length).toBeGreaterThan(100);
  });
  it("キーワード ∪ 関数でラベルが一意 (全ドライバ)", () => {
    for (const d of ["mysql", "postgres", "sqlite"]) {
      const labels = all(d).all.map((c) => c.label);
      expect(new Set(labels).size, d).toBe(labels.length);
    }
  });
  it("関数名は function 型で、共通関数と方言固有関数が揃う", () => {
    for (const d of ["mysql", "postgres", "sqlite"]) {
      const fnLabels = all(d).all.filter((c) => c.type === "function").map((c) => c.label);
      expect(fnLabels, d).toEqual(expect.arrayContaining(["COUNT", "SUM", "COALESCE", "CAST"]));
    }
    expect(all("postgres").all.filter((c) => c.type === "function").map((c) => c.label)).toContain("NOW");
    expect(all("sqlite").all.map((c) => c.label)).not.toContain("NOW");
    expect(all("sqlite").fns.map((c) => c.label)).toContain("STRFTIME");
    expect(all("mysql").fns.map((c) => c.label)).toContain("IFNULL");
  });
  it("CURRENT_DATE は括弧付き関数にしない", () => {
    const cur = all("postgres").all.find((c) => c.label === "CURRENT_DATE");
    expect(cur?.type).not.toBe("function");
  });
  it("構文キーワードを兼ねる IF / REPLACE / DATE は関数スニペットにしない", () => {
    expect(keywordCompletionBuilder("mysql")("IF", "keyword")).toEqual({ label: "IF", type: "keyword", boost: -1 });
    expect(keywordCompletionBuilder("mysql")("REPLACE", "keyword").type).toBe("keyword");
    expect(keywordCompletionBuilder("postgres")("REPLACE", "keyword").type).toBe("keyword");
    expect(keywordCompletionBuilder("sqlite")("DATE", "type").type).toBe("type");
  });
  it("通常キーワードはそのまま", () => {
    expect(keywordCompletionBuilder("mysql")("SELECT", "keyword")).toEqual({
      label: "SELECT",
      type: "keyword",
      boost: -1,
    });
  });
});
