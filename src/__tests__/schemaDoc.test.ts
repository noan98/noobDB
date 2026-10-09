import { describe, expect, it } from "vitest";
import {
  assembleSchemaDoc,
  buildSchemaDocContextText,
  buildSchemaDocHeader,
  buildSchemaDocPrompt,
  buildSchemaDocSystem,
  defaultSchemaDocFilename,
  filterForeignKeysInScope,
  mapWithConcurrency,
  resolveSchemaDocScope,
  schemaDocConcurrency,
  selectDocObjects,
  summarizeSchemaDocSend,
  truncateDefinition,
  SCHEMA_DOC_DEFINITION_MAX_CHARS,
  SCHEMA_DOC_MAX_OBJECTS,
  type SchemaDocContext,
  type SchemaDocForeignKey,
  type SchemaDocTable,
} from "../ai/schemaDoc";

const fk = (table: string, ref: string): SchemaDocForeignKey => ({
  table,
  column: `${ref}_id`,
  referenced_table: ref,
  referenced_column: "id",
});

function table(name: string, over: Partial<SchemaDocTable> = {}): SchemaDocTable {
  return {
    name,
    isView: false,
    comment: null,
    columns: [
      { name: "id", data_type: "bigint", nullable: false, key: "PRI", comment: null },
      { name: "note", data_type: "text", nullable: true, key: "", comment: "メモ\n欄" },
    ],
    indexes: [{ name: "PRIMARY", columns: ["id"], unique: true, primary: true, method: "BTREE" }],
    ...over,
  };
}

describe("resolveSchemaDocScope", () => {
  const all = ["customers", "orders", "order_items", "products", "logs"];
  const fks = [fk("orders", "customers"), fk("order_items", "orders"), fk("order_items", "products")];

  it("all は全テーブルをそのまま返す", () => {
    expect(resolveSchemaDocScope({ allTables: all, selected: [], foreignKeys: fks, mode: "all" })).toEqual(all);
  });

  it("selected は選択テーブルと参照先を推移的に展開し、元の並び順で返す", () => {
    const r = resolveSchemaDocScope({ allTables: all, selected: ["order_items"], foreignKeys: fks, mode: "selected" });
    expect(r).toEqual(["customers", "orders", "order_items", "products"]);
  });

  it("参照元 (子) は含めない", () => {
    const r = resolveSchemaDocScope({ allTables: all, selected: ["customers"], foreignKeys: fks, mode: "selected" });
    expect(r).toEqual(["customers"]);
  });

  it("自己参照・循環・存在しない選択名でも止まり、存在しない名前は除く", () => {
    const cyc = [fk("a", "b"), fk("b", "a"), fk("a", "a")];
    expect(resolveSchemaDocScope({ allTables: ["a", "b"], selected: ["a", "ghost"], foreignKeys: cyc, mode: "selected" })).toEqual([
      "a",
      "b",
    ]);
  });

  it("filterForeignKeysInScope はスコープ内で閉じた FK だけ残す", () => {
    expect(filterForeignKeysInScope(fks, ["orders", "customers"])).toEqual([fk("orders", "customers")]);
  });
});

describe("selectDocObjects", () => {
  const objs = [
    { kind: "view", name: "v1" },
    { kind: "view", name: "v2" },
    { kind: "function", name: "f1" },
    { kind: "trigger", name: "tg" },
  ];
  it("全体ではビューとルーチンを選び、トリガーは除く", () => {
    expect(selectDocObjects(objs, null).map((o) => o.name)).toEqual(["v1", "v2", "f1"]);
  });
  it("選択スコープではスコープ内のビューだけ", () => {
    expect(selectDocObjects(objs, ["v2", "orders"]).map((o) => o.name)).toEqual(["v2"]);
  });
  it("件数に上限がある", () => {
    const many = Array.from({ length: SCHEMA_DOC_MAX_OBJECTS + 5 }, (_, i) => ({ kind: "view", name: `v${i}` }));
    expect(selectDocObjects(many, null)).toHaveLength(SCHEMA_DOC_MAX_OBJECTS);
  });
});

describe("並列度", () => {
  it("100 テーブル以下は 8、超えると 4", () => {
    expect(schemaDocConcurrency(100)).toBe(8);
    expect(schemaDocConcurrency(101)).toBe(4);
  });

  it("mapWithConcurrency は上限を超えて同時実行せず、順序を保つ", async () => {
    let running = 0;
    let peak = 0;
    const out = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8, 9], 4, async (n) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 2));
      running -= 1;
      return n * 2;
    });
    expect(peak).toBeLessThanOrEqual(4);
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18]);
  });

  it("空配列でも解決する", async () => {
    expect(await mapWithConcurrency([], 4, async (n: number) => n)).toEqual([]);
  });
});

describe("コンテキストとプロンプト", () => {
  const ctx: SchemaDocContext = {
    tables: [table("orders", { comment: "注文" }), table("v_sales", { isView: true, indexes: [] })],
    foreignKeys: [fk("orders", "customers")],
    objects: [{ kind: "view", name: "v_sales", definition: "SELECT 1" }],
  };

  it("名前・型・NULL 可・キー・コメント・インデックス・FK・定義を含め、コメントは 1 行に畳む", () => {
    const text = buildSchemaDocContextText(ctx);
    expect(text).toContain("### orders");
    expect(text).toContain("Comment: 注文");
    expect(text).toContain("- id | bigint | NOT NULL | PRI");
    expect(text).toContain("- note | text | NULL | - | メモ 欄");
    expect(text).toContain("- PRIMARY (id) PRIMARY UNIQUE BTREE");
    expect(text).toContain("### v_sales (view)");
    expect(text).toContain("- orders.customers_id -> customers.id");
    expect(text).toContain("### view v_sales");
    expect(text).toContain("SELECT 1");
  });

  it("デフォルト値は型に存在せず、本文にも出ない", () => {
    const withDefault = { ...table("t"), columns: [{ name: "c", data_type: "int", nullable: true, key: "", comment: null, default: "SECRET" }] };
    expect(buildSchemaDocContextText({ tables: [withDefault], foreignKeys: [], objects: [] })).not.toContain("SECRET");
  });

  it("長い定義は切り詰める", () => {
    const long = "x".repeat(SCHEMA_DOC_DEFINITION_MAX_CHARS + 100);
    const cut = truncateDefinition(long);
    expect(cut.length).toBeLessThan(long.length);
    expect(cut).toContain("(truncated)");
    expect(truncateDefinition("  SELECT 1  ")).toBe("SELECT 1");
  });

  it.each([
    ["mysql", "MySQL"],
    ["postgres", "PostgreSQL"],
    ["sqlite", "SQLite"],
  ])("%s は方言名・言語・ルールを system に含む", (driver, dialect) => {
    const sys = buildSchemaDocSystem({ driver, database: "app", locale: "ja", context: ctx });
    expect(sys).toContain(dialect);
    expect(sys).toContain("Japanese");
    expect(sys).toContain("Database: app");
    expect(sys).toContain("Views and routines");
    expect(sys).toContain("Never invent names");
    expect(sys).toContain("Do not write the generation date");
  });

  it("定義が無ければビュー / ルーチンの節を求めない。英語ロケールは English", () => {
    const sys = buildSchemaDocSystem({
      driver: "sqlite",
      database: null,
      locale: "en",
      context: { ...ctx, objects: [] },
    });
    expect(sys).not.toContain("5. Views and routines");
    expect(sys).toContain("in English");
    expect(sys).toContain("Database: (default)");
  });

  it("ユーザプロンプトは固定文で、行データを含まない", () => {
    expect(buildSchemaDocPrompt("ja")).toContain("Markdown");
    expect(buildSchemaDocPrompt("en")).toContain("Markdown");
  });
});

describe("送信サイズ", () => {
  const mk = (n: number): SchemaDocContext => ({
    tables: Array.from({ length: n }, (_, i) => table(`t${i}`)),
    foreignKeys: [fk("t1", "t0")],
    objects: [],
  });
  it("件数とサイズの目安を返す", () => {
    const s = summarizeSchemaDocSend(mk(3));
    expect(s.tableCount).toBe(3);
    expect(s.columnCount).toBe(6);
    expect(s.fkCount).toBe(1);
    expect(s.approxChars).toBeGreaterThan(0);
    expect(s.level).toBe("ok");
  });
  it("100 超は large、300 超は tooLarge", () => {
    expect(summarizeSchemaDocSend(mk(100)).level).toBe("ok");
    expect(summarizeSchemaDocSend(mk(101)).level).toBe("large");
    expect(summarizeSchemaDocSend(mk(300)).level).toBe("large");
    expect(summarizeSchemaDocSend(mk(301)).level).toBe("tooLarge");
  });
});

describe("冒頭注記 (フロント側で付与)", () => {
  const at = new Date(2026, 9, 9, 7, 5);
  it("日本語: 生成日時・プロファイル名と DB 名・方言・AI 推定の注記を含む", () => {
    const h = buildSchemaDocHeader({ generatedAt: at, profileName: "本番DB", database: "shop", driver: "postgres", locale: "ja" });
    expect(h).toContain("生成日時: 2026-10-09 07:05");
    expect(h).toContain("対象接続: 本番DB / shop (PostgreSQL)");
    expect(h).toContain("AI による推定を含みます");
  });
  it("英語: 注記も英語", () => {
    const h = buildSchemaDocHeader({ generatedAt: at, profileName: "p", database: "d", driver: "mysql", locale: "en" });
    expect(h).toContain("Generated at: 2026-10-09 07:05");
    expect(h).toContain("Connection: p / d (MySQL)");
    expect(h).toContain("AI-generated inferences");
  });
  it("assembleSchemaDoc は注記を本文の前に置き、末尾に改行を 1 つ付ける", () => {
    expect(assembleSchemaDoc("> note", "\n# Title\n\nbody\n\n")).toBe("> note\n\n# Title\n\nbody\n");
  });
  it("既定ファイル名は DB 名をサニタイズした .md", () => {
    expect(defaultSchemaDocFilename("my db/1", at)).toBe("schema_doc_my_db_1_20261009.md");
    expect(defaultSchemaDocFilename(null, at)).toBe("schema_doc_database_20261009.md");
  });
});
