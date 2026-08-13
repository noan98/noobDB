import { describe, expect, it } from "vitest";
import { quoteIdentFor } from "../components/sqlDialect";
import { quoteSqlIdent, sqlLiteral } from "../components/exportPreview";
import type { CellValue } from "../api/tauri";
import vectors from "./fixtures/sqlQuotingVectors.json";

// SQL 識別子引用 / リテラルエスケープの実装横断ゴールデンテスト — フロント側 (#880)。
//
// 識別子引用は `components/sqlDialect.ts::quoteIdentFor` と
// `components/exportPreview.ts::quoteSqlIdent` の 2 実装に重複し、さらにバック
// エンドの `db::sync::quote_ident` がある。リテラルエスケープは
// `exportPreview.ts::sqlLiteral` がバックの `db::data_diff::sql_literal` を
// ミラーする。いずれもインジェクション隣接の安全性ロジックなので、read-only 判定
// (#444) と同格の共有ベクタ (`fixtures/sqlQuotingVectors.json`) で全実装を固定する。
// バック側は同じ JSON を `src-tauri/tests/sql_quoting_golden.rs` が `include_str!`
// で読み込み、対になる検証を行う。

type Driver = "mysql" | "postgres" | "sqlite" | "duckdb" | "mssql";
type ByDriver = Record<Driver, string>;

interface IdentifierCase {
  input: string;
  note: string;
  expected: ByDriver;
}

interface LiteralCase {
  kind: "null" | "bool" | "int" | "float" | "string" | "bytes";
  value?: string | number | boolean;
  note: string;
  expected: ByDriver;
  /** フロント側の期待値。省略時は `expected` と同じ。 */
  frontend?: ByDriver;
}

const drivers = vectors.drivers as Driver[];
const identifiers = vectors.identifiers as IdentifierCase[];
const literals = vectors.literals as LiteralCase[];

/**
 * ベクタの 1 ケースをフロントの `CellValue` へ変換する。フロントは JSON 化された
 * 値しか持たないため、`bytes` は 16 進文字列 (= ただの文字列) になる。
 */
function toCellValue(c: LiteralCase): CellValue {
  if (c.kind === "null") return null;
  return c.value as CellValue;
}

describe("SQL 引用/エスケープ ゴールデン (フロント実装)", () => {
  it("ベクタが 5 ドライバすべてを覆う", () => {
    expect(drivers).toEqual(["mysql", "postgres", "sqlite", "duckdb", "mssql"]);
    expect(identifiers.length).toBeGreaterThanOrEqual(10);
    expect(literals.length).toBeGreaterThanOrEqual(12);
  });

  describe("識別子引用", () => {
    for (const c of identifiers) {
      for (const driver of drivers) {
        it(`${driver}: ${c.note} — ${JSON.stringify(c.input)}`, () => {
          // フロントの 2 実装は互いにも、バックの quote_ident とも一致する。
          expect(quoteIdentFor(driver, c.input)).toBe(c.expected[driver]);
          expect(quoteSqlIdent(driver, c.input)).toBe(c.expected[driver]);
        });
      }
    }
  });

  describe("リテラルエスケープ", () => {
    for (const c of literals) {
      const expected = c.frontend ?? c.expected;
      for (const driver of drivers) {
        it(`${driver}: ${c.note} — ${c.kind} ${JSON.stringify(c.value ?? null)}`, () => {
          expect(sqlLiteral(driver, toCellValue(c))).toBe(expected[driver]);
        });
      }
    }
  });

  it("フロント/バックの既知の食い違い (BLOB) がベクタに明記されている", () => {
    // `frontend` の上書きが 1 件も無くなったら、BLOB がフロントで文字列リテラルに
    // なるという既知の差分が暗黙化している (= 明記の意図が失われている)。
    expect(literals.some((c) => c.frontend !== undefined)).toBe(true);
  });
});
