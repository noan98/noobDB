import { describe, expect, it } from "vitest";
import {
  classifyColumnType,
  generateTypeDefs,
  toCamelCase,
  toPascalCase,
  toSnakeCase,
  type TypeDefColumn,
  type TypeDefLang,
  type TypeDefTable,
} from "../components/typeDefGen";

type Case = [driver: string, dataType: string, ts: string, go: string, rust: string, py: string];

// 3 ドライバの代表的な型 → 各言語の型 (対応表の固定)。
const MAP: Case[] = [
  ["mysql", "int(11)", "number", "int32", "i32", "int"],
  ["mysql", "int unsigned", "number", "uint32", "u32", "int"],
  ["mysql", "bigint(20)", "string", "int64", "i64", "int"],
  ["mysql", "bigint unsigned", "string", "uint64", "u64", "int"],
  ["mysql", "tinyint(1)", "boolean", "bool", "bool", "bool"],
  ["mysql", "tinyint(4)", "number", "int8", "i8", "int"],
  ["mysql", "decimal(10,2)", "string", "string", "rust_decimal::Decimal", "decimal.Decimal"],
  ["mysql", "double", "number", "float64", "f64", "float"],
  ["mysql", "float", "number", "float32", "f32", "float"],
  ["mysql", "varchar(255)", "string", "string", "String", "str"],
  ["mysql", "datetime(6)", "string", "time.Time", "chrono::NaiveDateTime", "datetime.datetime"],
  ["mysql", "timestamp", "string", "time.Time", "chrono::DateTime<chrono::Utc>", "datetime.datetime"],
  ["mysql", "date", "string", "time.Time", "chrono::NaiveDate", "datetime.date"],
  ["mysql", "json", "unknown", "json.RawMessage", "serde_json::Value", "Any"],
  ["mysql", "longblob", "string", "[]byte", "Vec<u8>", "bytes"],
  ["mysql", "enum('a','b')", '"a" | "b"', "string", "String", 'Literal["a", "b"]'],
  ["postgres", "integer", "number", "int32", "i32", "int"],
  ["postgres", "bigint", "string", "int64", "i64", "int"],
  ["postgres", "numeric(12,4)", "string", "string", "rust_decimal::Decimal", "decimal.Decimal"],
  ["postgres", "character varying(50)", "string", "string", "String", "str"],
  ["postgres", "boolean", "boolean", "bool", "bool", "bool"],
  ["postgres", "double precision", "number", "float64", "f64", "float"],
  [
    "postgres",
    "timestamp with time zone",
    "string",
    "time.Time",
    "chrono::DateTime<chrono::Utc>",
    "datetime.datetime",
  ],
  [
    "postgres",
    "timestamp without time zone",
    "string",
    "time.Time",
    "chrono::NaiveDateTime",
    "datetime.datetime",
  ],
  ["postgres", "uuid", "string", "string", "uuid::Uuid", "uuid.UUID"],
  ["postgres", "jsonb", "unknown", "json.RawMessage", "serde_json::Value", "Any"],
  ["postgres", "bytea", "string", "[]byte", "Vec<u8>", "bytes"],
  ["postgres", "integer[]", "number[]", "[]int32", "Vec<i32>", "list[int]"],
  ["postgres", "_text", "string[]", "[]string", "Vec<String>", "list[str]"],
  ["postgres", "ARRAY", "unknown[]", "[]any", "Vec<serde_json::Value>", "list[Any]"],
  ["sqlite", "INTEGER", "number", "int64", "i64", "int"],
  ["sqlite", "TEXT", "string", "string", "String", "str"],
  ["sqlite", "REAL", "number", "float64", "f64", "float"],
  ["sqlite", "BLOB", "string", "[]byte", "Vec<u8>", "bytes"],
  ["sqlite", "NUMERIC", "string", "string", "rust_decimal::Decimal", "decimal.Decimal"],
  ["sqlite", "DATETIME", "string", "time.Time", "chrono::NaiveDateTime", "datetime.datetime"],
  ["sqlite", "BOOLEAN", "boolean", "bool", "bool", "bool"],
];

function one(driver: string, lang: TypeDefLang, col: Partial<TypeDefColumn> & { data_type: string }): string {
  const table: TypeDefTable = { name: "t", columns: [{ name: "c", nullable: false, ...col }] };
  return generateTypeDefs([table], { driver, lang, naming: "snake" });
}

describe("型の対応表", () => {
  it.each(MAP)("%s %s", (driver, dt, ts, go, rust, py) => {
    expect(one(driver, "typescript", { data_type: dt })).toContain(`  c: ${ts};`);
    expect(one(driver, "go", { data_type: dt })).toMatch(
      new RegExp(`C\\s+${go.replace(/[[\]]/g, "\\$&")}\\s`),
    );
    expect(one(driver, "rust", { data_type: dt })).toContain(`pub c: ${rust},`);
    expect(one(driver, "python", { data_type: dt })).toContain(`    c: ${py}\n`);
  });

  it("PostgreSQL の USER-DEFINED は enumValues があるときだけ union", () => {
    expect(classifyColumnType("postgres", "USER-DEFINED", ["x"])).toEqual({ k: "enum", values: ["x"] });
    expect(classifyColumnType("postgres", "USER-DEFINED")).toEqual({ k: "string" });
    expect(one("postgres", "typescript", { data_type: "USER-DEFINED", enumValues: ["a", "b"] })).toContain(
      '"a" | "b"',
    );
  });
});

describe("nullable", () => {
  const dt = "varchar(10)";
  it("各言語の表現", () => {
    expect(one("mysql", "typescript", { data_type: dt, nullable: true })).toContain("c: string | null;");
    expect(one("mysql", "typescriptZod", { data_type: dt, nullable: true })).toContain(
      "c: z.string().nullable(),",
    );
    expect(one("mysql", "go", { data_type: dt, nullable: true })).toMatch(/C\s+\*string/);
    expect(one("mysql", "rust", { data_type: dt, nullable: true })).toContain("pub c: Option<String>,");
    expect(one("mysql", "python", { data_type: dt, nullable: true })).toContain("c: Optional[str]");
    expect(one("mysql", "pythonPydantic", { data_type: dt, nullable: true })).toContain(
      "c: Optional[str] = None",
    );
  });
  it("Go のスライス / RawMessage はポインタにしない", () => {
    expect(one("mysql", "go", { data_type: "blob", nullable: true })).toMatch(/C\s+\[\]byte/);
    expect(one("mysql", "go", { data_type: "json", nullable: true })).toMatch(/C\s+json\.RawMessage/);
  });
  it("enum union の配列は括弧で包む", () => {
    expect(one("postgres", "typescript", { data_type: "integer[]", nullable: true })).toContain(
      "c: number[] | null;",
    );
  });
});

describe("コメントと enum", () => {
  it("列コメントが doc コメントになる", () => {
    const c = { data_type: "int", comment: "ユーザ ID" };
    expect(one("mysql", "typescript", c)).toContain("/** ユーザ ID */");
    expect(one("mysql", "go", c)).toContain("// ユーザ ID");
    expect(one("mysql", "rust", c)).toContain("/// ユーザ ID");
    expect(one("mysql", "python", c)).toContain("#: ユーザ ID");
  });
  it("JSDoc を閉じる */ をエスケープ", () => {
    expect(one("mysql", "typescript", { data_type: "int", comment: "a */ b" })).toContain("a *\\/ b");
  });
  it("Go / Rust の enum は string + 値のコメント", () => {
    const c = { data_type: "enum('a','b')" };
    expect(one("mysql", "go", c)).toContain("// enum: a | b");
    expect(one("mysql", "rust", c)).toContain("/// enum: a | b");
  });
  it("zod の enum", () => {
    expect(one("mysql", "typescriptZod", { data_type: "enum('a','b')" })).toContain('z.enum(["a", "b"])');
  });
});

describe("識別子の変換", () => {
  it("ケース変換", () => {
    expect(toSnakeCase("userId")).toBe("user_id");
    expect(toCamelCase("user_id")).toBe("userId");
    expect(toPascalCase("order_items")).toBe("OrderItems");
    expect(toSnakeCase("HTTPServer")).toBe("http_server");
  });

  const table: TypeDefTable = {
    name: "order items",
    columns: [
      { name: "user id", data_type: "int", nullable: false },
      { name: "class", data_type: "int", nullable: false },
      { name: "1st", data_type: "int", nullable: false },
      { name: "***", data_type: "int", nullable: false },
      { name: "user_id", data_type: "int", nullable: false },
    ],
  };
  const gen = (lang: TypeDefLang, naming: "snake" | "camel" = "snake") =>
    generateTypeDefs([table], { driver: "mysql", lang, naming });

  it("TypeScript: 元の名前を @column に残し、重複は連番", () => {
    const s = gen("typescript", "camel");
    expect(s).toContain("export interface OrderItems {");
    expect(s).toContain("@column user id");
    expect(s).toContain("  userId: number;");
    expect(s).toContain("  _1st: number;");
    expect(s).toContain("  field: number;");
    expect(s).toContain("  userId_2: number;");
  });
  it("Go: db タグに元の名前、先頭数字は Col を付ける", () => {
    const s = gen("go");
    expect(s).toContain("type OrderItems struct {");
    expect(s).toContain('`db:"user id"`');
    expect(s).toContain("Class");
    expect(s).toContain("Col1st");
    expect(s).toContain('`db:"user_id"`');
    expect(s).toMatch(/UserID\s/);
  });
  it("Rust: 予約語は末尾 _ + sqlx(rename)", () => {
    const s = gen("rust");
    expect(s).toContain('#[sqlx(rename = "user id")]');
    expect(s).toContain("pub class: i32,");
    const kw = generateTypeDefs(
      [{ name: "t", columns: [{ name: "type", data_type: "int", nullable: false }] }],
      {
        driver: "mysql",
        lang: "rust",
        naming: "snake",
      },
    );
    expect(kw).toContain('#[sqlx(rename = "type")]');
    expect(kw).toContain("pub type_: i32,");
    expect(s).toContain("pub _1st: i32,");
  });
  it("Python: 予約語を避け、Pydantic は alias を付ける", () => {
    expect(gen("python")).toContain("    class_: int");
    const p = gen("pythonPydantic");
    expect(p).toContain('class_: int = Field(alias="class")');
    expect(p).toContain("model_config = ConfigDict(populate_by_name=True)");
    expect(p).toContain("from pydantic import BaseModel, ConfigDict, Field");
  });
});

describe("複数テーブル・import", () => {
  const tables: TypeDefTable[] = [
    {
      name: "users",
      comment: "利用者",
      columns: [{ name: "created_at", data_type: "datetime", nullable: false }],
    },
    { name: "docs", columns: [{ name: "body", data_type: "json", nullable: true }] },
  ];
  const run = (lang: TypeDefLang) => generateTypeDefs(tables, { driver: "mysql", lang, naming: "snake" });
  it("Go の import は 1 度だけ", () => {
    const s = run("go");
    expect(s.startsWith('import (\n\t"encoding/json"\n\t"time"\n)\n\n')).toBe(true);
    expect(s.match(/import \(/g)).toHaveLength(1);
    expect(s).toContain("// 利用者\ntype Users struct {");
  });
  it("zod は z の import を先頭に", () => {
    const s = run("typescriptZod");
    expect(s.startsWith('import { z } from "zod";')).toBe(true);
    expect(s).toContain("export type Users = z.infer<typeof UsersSchema>;");
  });
  it("Python の import を統合", () => {
    const s = run("python");
    expect(s).toContain(
      "import datetime\nfrom dataclasses import dataclass\nfrom typing import Any, Optional",
    );
  });
  it("テーブル 0 件は空文字、型名の衝突は連番", () => {
    expect(generateTypeDefs([], { driver: "mysql", lang: "go", naming: "snake" })).toBe("");
    const dup = generateTypeDefs(
      [
        { name: "a b", columns: [] },
        { name: "a_b", columns: [] },
      ],
      { driver: "mysql", lang: "rust", naming: "snake" },
    );
    expect(dup).toContain("pub struct AB {");
    expect(dup).toContain("pub struct AB2 {");
  });
});
