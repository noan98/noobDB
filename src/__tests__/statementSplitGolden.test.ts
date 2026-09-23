import { describe, expect, it } from "vitest";
import { isMultiStatement, splitSqlStatementRanges, splitSqlStatements, statementAtOffset } from "../sqlScript";
import vectors from "./fixtures/statementSplitVectors.json";

// 文境界 (トップレベルの `;` による文分割) のフロント/バック整合性ゴールデン
// テスト (#1074)。
//
// 文分割器 (`splitSqlStatements` / `isMultiStatement` / `statementAtOffset`、
// `src/sqlScript.ts`) はバッチ実行の振り分け・カーソル位置の文実行 (#555)・
// フライトレコーダの文分割に使われる。以前はマスク処理を独自に再実装しており、
// `maskLiterals` (と `maskVectors.json` で一致を固定したバックエンドのマスク) と
// MySQL バージョンコメント `/*! … */`・未終端ドル引用の 2 点で乖離して文境界を
// 誤読していた。現在は `maskLiterals` の上に構築しているが、その前提が再び崩れても
// 検出できるよう、文境界そのものを共有ベクタ (`fixtures/statementSplitVectors.json`)
// で固定する。バック側は同じ JSON を `src-tauri/tests/statement_split_golden.rs` が
// `include_str!` で読み、バックエンドのマスクで同じ規則の分割をして一致を検証する。
//
// ベクタは**ドライバ次元**を持つ (#852 / #1004)。`statements` はバックスラッシュを
// 文字列エスケープと見なさない標準解釈 (PostgreSQL / SQLite / DuckDB / MSSQL、
// およびドライバ省略時) の期待値で、MySQL だけ結果が変わるケースのみ
// `statementsMysql` を持つ。

interface VectorCase {
  sql: string;
  note: string;
  statements: string[];
  /** MySQL のバックスラッシュエスケープ解釈での期待値 (省略時は `statements`)。 */
  statementsMysql?: string[];
}

const drivers = vectors.drivers as string[];
const cases = vectors.cases as VectorCase[];

/** 標準的な文字列リテラル解釈を採るドライバ (= `statements` がそのまま期待値)。 */
const STANDARD_DRIVERS = ["postgres", "sqlite", "duckdb", "mssql"] as const;

function expectSplit(sql: string, driver: string | undefined, expected: string[]) {
  expect(splitSqlStatements(sql, driver)).toEqual(expected);
  expect(isMultiStatement(sql, driver)).toBe(expected.length > 1);

  // 範囲 (#555 のハイライト / カーソル文実行) は本文と同じ位置を指す。
  const ranges = splitSqlStatementRanges(sql, driver);
  expect(ranges.map((r) => sql.slice(r.from, r.to))).toEqual(expected);
  // 各文の先頭にカーソルを置くと、その文が選ばれる。
  for (const r of ranges) {
    expect(statementAtOffset(sql, r.from, driver)).toEqual(r);
  }
  if (ranges.length === 0) expect(statementAtOffset(sql, 0, driver)).toBeNull();
}

describe("文境界ゴールデン (フロント splitSqlStatements)", () => {
  it("ベクタが 5 ドライバすべてを覆う", () => {
    expect(drivers).toEqual(["mysql", "postgres", "sqlite", "duckdb", "mssql"]);
  });

  it("ベクタが十分なケース数を持つ (取りこぼし防止)", () => {
    expect(cases.length).toBeGreaterThanOrEqual(20);
  });

  it("ドライバ次元が実際に使われている (#1004 の回帰防止)", () => {
    expect(cases.some((c) => c.statementsMysql !== undefined)).toBe(true);
  });

  it("#1074 の 2 つの乖離ケース (/*! */ と未終端ドル引用) を含む", () => {
    expect(cases.some((c) => c.sql.includes("/*!40000 ; DELETE"))).toBe(true);
    expect(cases.some((c) => c.sql === "SELECT $$ oops ; DROP TABLE users")).toBe(true);
  });

  for (const c of cases) {
    it(`${c.note} — ${JSON.stringify(c.sql)}`, () => {
      expectSplit(c.sql, undefined, c.statements);
      for (const driver of STANDARD_DRIVERS) expectSplit(c.sql, driver, c.statements);
      expectSplit(c.sql, "mysql", c.statementsMysql ?? c.statements);
    });
  }
});
