import { describe, expect, it } from "vitest";
import {
  approxKb,
  buildNl2SqlPrompt,
  buildNl2SqlSystem,
  buildSchemaText,
  identifierQuoteRule,
  NL2SQL_FORMAT,
  NL2SQL_LARGE_SCHEMA_TABLES,
  parseNl2SqlResponse,
  resolveNl2SqlDatabase,
  summarizeSchemaSend,
  type Nl2SqlSystemInput,
} from "../ai/nl2sql";

const base: Nl2SqlSystemInput = {
  driver: "mysql",
  database: "shop",
  locale: "ja",
  readOnly: false,
  tables: [
    { name: "orders", columns: ["id", "customer_id", "amount", "created_at"] },
    { name: "customers", columns: ["id", "name"] },
  ],
  foreignKeys: [
    { table: "orders", column: "customer_id", referenced_table: "customers", referenced_column: "id" },
  ],
};

describe("buildNl2SqlSystem (#691)", () => {
  it.each([
    ["mysql", "MySQL", "backticks"],
    ["postgres", "PostgreSQL", "double quotes"],
    ["sqlite", "SQLite", "double quotes"],
  ])("%s は方言名と識別子クオート規則を含む", (driver, label, quote) => {
    const sys = buildNl2SqlSystem({ ...base, driver });
    expect(sys).toContain(`Target dialect: ${label}`);
    expect(sys).toContain(identifierQuoteRule(driver));
    expect(identifierQuoteRule(driver)).toContain(quote);
  });

  it("スキーマ (テーブル・列・外部キー) を含み、DB 名を明示する", () => {
    const sys = buildNl2SqlSystem(base);
    expect(sys).toContain("Database: shop");
    expect(sys).toContain("- orders(id, customer_id, amount, created_at)");
    expect(sys).toContain("- orders.customer_id -> customers.id");
  });

  it("読み取り専用のときだけ SELECT 制約が入る", () => {
    expect(buildNl2SqlSystem({ ...base, readOnly: true })).toContain("READ-ONLY");
    expect(buildNl2SqlSystem({ ...base, readOnly: true })).toContain("Never generate INSERT, UPDATE, DELETE");
    expect(buildNl2SqlSystem({ ...base, readOnly: false })).not.toContain("READ-ONLY");
  });

  it("出力言語をロケールに合わせ、行データを推測しないよう指示する", () => {
    expect(buildNl2SqlSystem({ ...base, locale: "ja" })).toContain("in Japanese");
    expect(buildNl2SqlSystem({ ...base, locale: "en" })).toContain("in English");
    expect(buildNl2SqlSystem(base)).toContain("Never assume row contents");
  });

  it("ユーザプロンプトは依頼文だけ (前後の空白は除く)", () => {
    expect(buildNl2SqlPrompt("  先月の注文を集計  \n")).toBe("先月の注文を集計");
  });
});

describe("スキーマの送信サマリ", () => {
  it("件数と大きいスキーマ判定", () => {
    const small = summarizeSchemaSend(base.tables, base.foreignKeys);
    expect(small).toMatchObject({ tableCount: 2, columnCount: 6, large: false });
    expect(small.approxChars).toBe(buildSchemaText(base.tables, base.foreignKeys).length);
    const many = Array.from({ length: NL2SQL_LARGE_SCHEMA_TABLES + 1 }, (_, i) => ({ name: `t${i}`, columns: ["id"] }));
    expect(summarizeSchemaSend(many, []).large).toBe(true);
    expect(summarizeSchemaSend(many.slice(0, NL2SQL_LARGE_SCHEMA_TABLES), []).large).toBe(false);
  });

  it("approxKb は切り上げで最小 1", () => {
    expect(approxKb(0)).toBe(1);
    expect(approxKb(1025)).toBe(2);
  });

  it("SQLite はデータベース未指定でも main", () => {
    expect(resolveNl2SqlDatabase(null, "sqlite")).toBe("main");
    expect(resolveNl2SqlDatabase(null, "mysql")).toBeNull();
    expect(resolveNl2SqlDatabase("app", "postgres")).toBe("app");
  });
});

describe("parseNl2SqlResponse", () => {
  const ok = { sql: " SELECT 1 ", explanation: "E", warnings: ["W"], tables_used: ["t"] };

  it("正しい JSON を検証して SQL を trim する", () => {
    const r = parseNl2SqlResponse(JSON.stringify(ok));
    expect(r).toEqual({ ok: true, value: { ...ok, sql: "SELECT 1" } });
  });

  it("コードフェンス付きも受け付ける", () => {
    expect(parseNl2SqlResponse("```json\n" + JSON.stringify(ok) + "\n```").ok).toBe(true);
  });

  it("壊れた JSON・欠けたフィールド・空 SQL は本文をそのまま返す", () => {
    expect(parseNl2SqlResponse("plain")).toEqual({ ok: false, raw: "plain" });
    const missing = JSON.stringify({ sql: "SELECT 1" });
    expect(parseNl2SqlResponse(missing)).toEqual({ ok: false, raw: missing });
    const empty = JSON.stringify({ ...ok, sql: "  " });
    expect(parseNl2SqlResponse(empty).ok).toBe(false);
  });

  it("format は全オブジェクトで additionalProperties:false", () => {
    expect(NL2SQL_FORMAT.type).toBe("json_schema");
    expect(NL2SQL_FORMAT.schema.additionalProperties).toBe(false);
    expect(NL2SQL_FORMAT.schema.required).toEqual(["sql", "explanation", "warnings", "tables_used"]);
  });
});
