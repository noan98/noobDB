import { describe, expect, it } from "vitest";
import { quoteIdentFor } from "../components/sqlDialect";
import { quoteSqlIdent, sqlLiteral } from "../components/exportPreview";
import { buildRowWhere, literalFromCellValue, quoteString, whereEqualsClause } from "../components/cellEdit";
import type { CellValue, Column } from "../api/tauri";
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

type Driver = "mysql" | "postgres" | "sqlite";
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
  /** フロント側 (`exportPreview.sqlLiteral`) の期待値。省略時は `expected` と同じ。 */
  frontend?: ByDriver;
  /** `cellEdit.literalFromCellValue` の期待値。省略時は `frontend ?? expected` (#1510)。 */
  cellEdit?: ByDriver;
}

interface WherePredicateCase {
  kind: "null" | "bool" | "int" | "float" | "float4" | "string" | "bytes";
  value?: string | number | boolean;
  column?: string;
  typeName: string;
  note: string;
  /** 検査するドライバ。省略時は全ドライバ。 */
  drivers?: Driver[];
  expected: Partial<ByDriver>;
  /** フロント側の期待値。省略時は `expected` と同じ。 */
  frontend?: Partial<ByDriver>;
}

const drivers = vectors.drivers as Driver[];
const identifiers = vectors.identifiers as IdentifierCase[];
const literals = vectors.literals as LiteralCase[];
const wherePredicates = vectors.wherePredicates as WherePredicateCase[];

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
    expect(drivers).toEqual(["mysql", "postgres", "sqlite"]);
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

  describe("実働リテラルエスケーパ cellEdit.ts (#1510)", () => {
    // インライン編集の DELETE / INSERT / WHERE・検索・クエリパラメータなど、実際に DB へ発行される
    // SQL を作る `literalFromCellValue` / `quoteString` を、エクスポートプレビューの `sqlLiteral` と
    // Rust の `sql_literal` と同じベクタに通す。真偽値だけは全方言 TRUE/FALSE (cellEdit 上書き)。
    for (const c of literals) {
      const expected = c.cellEdit ?? c.frontend ?? c.expected;
      for (const driver of drivers) {
        it(`${driver}: literalFromCellValue — ${c.note} — ${c.kind} ${JSON.stringify(c.value ?? null)}`, () => {
          expect(literalFromCellValue(driver, toCellValue(c))).toBe(expected[driver]);
        });
        if (c.kind === "string") {
          it(`${driver}: quoteString — ${c.note} — ${JSON.stringify(c.value)}`, () => {
            expect(quoteString(driver, c.value as string)).toBe(c.expected[driver]);
            // 文字列に関しては 3 実装 (Rust sql_literal / sqlLiteral / quoteString) が完全一致する。
            expect(quoteString(driver, c.value as string)).toBe(sqlLiteral(driver, c.value as string));
          });
        }
      }
    }

    it("cellEdit の上書きが 1 件以上ある (真偽値の既知の差分が明記されている)", () => {
      expect(literals.some((c) => c.cellEdit !== undefined)).toBe(true);
    });
  });

  it("フロント/バックの既知の食い違い (BLOB) がベクタに明記されている", () => {
    // `frontend` の上書きが 1 件も無くなったら、BLOB がフロントで文字列リテラルに
    // なるという既知の差分が暗黙化している (= 明記の意図が失われている)。
    expect(literals.some((c) => c.frontend !== undefined)).toBe(true);
  });

  describe("行同定 WHERE の述語形 (#1870)", () => {
    // リテラル表記ではなく述語の形 (`IS NULL` / `<> 0` / 許容差) を、Rust の `old_predicate` /
    // `row_condition` と同じベクタで固定する。コピー as SQL・生成スクリプト経路の
    // `whereEqualsClause` / `buildRowWhere` が、バックエンドと違う述語を吐かないようにする。
    for (const c of wherePredicates) {
      const column = c.column ?? "c";
      const col: Column = { name: column, type_name: c.typeName };
      const value = (c.kind === "null" ? null : c.value) as CellValue;
      const expected = c.frontend ?? c.expected;
      for (const driver of c.drivers ?? drivers) {
        it(`${driver}: whereEqualsClause — ${c.note}`, () => {
          expect(whereEqualsClause(driver, col, value)).toBe(expected[driver]);
        });
        it(`${driver}: buildRowWhere — ${c.note}`, () => {
          expect(buildRowWhere(driver, [col], [value], [0])).toBe(expected[driver]);
        });
      }
    }

    it("真偽値 (MySQL/SQLite は 0 比較・PostgreSQL は TRUE/FALSE)・NULL・float4・BLOB の境界が含まれる", () => {
      const bools = wherePredicates.filter((c) => c.kind === "bool");
      expect(bools.length).toBeGreaterThanOrEqual(2);
      for (const c of bools) {
        expect(c.expected.mysql).toMatch(/ (<>|=) 0$/);
        expect(c.expected.sqlite).toMatch(/ (<>|=) 0$/);
        expect(c.expected.postgres).toMatch(/ = (TRUE|FALSE)$/);
      }
      expect(wherePredicates.some((c) => c.kind === "null")).toBe(true);
      expect(wherePredicates.some((c) => c.kind === "float4")).toBe(true);
      expect(wherePredicates.some((c) => c.kind === "bytes")).toBe(true);
    });
  });
});
