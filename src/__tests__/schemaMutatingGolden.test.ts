import { describe, expect, it } from "vitest";
import { isSchemaMutatingSql } from "../dangerousSql";
import vectors from "./fixtures/schemaMutatingVectors.json";

// スキーマ変更検出のフロント/バック整合性ゴールデンテスト (#1221)。
//
// フロント (`isSchemaMutatingSql`) とバック (`sql_may_change_schema`、Schema Cache の
// invalidate 判定) は独立に二重実装されている。両者が参照する共有ベクタ
// (`fixtures/schemaMutatingVectors.json`) をフロント側で読み、各 SQL の判定が期待値と
// 一致することを検証する。バック側は同じ JSON を `src-tauri/tests/schema_mutating_golden.rs`
// が `include_str!` で読み込んで対になる検証を行う。片方だけ変えるとどちらかが落ちる。
//
// ベクタは **ドライバ次元**を持つ (#852): `schemaMutates` はバックスラッシュを文字列
// エスケープと見なさない標準解釈 (PostgreSQL / SQLite、およびドライバ不明) での期待値で、
// MySQL だけ判定が変わるケースは `schemaMutatesMysql` に書く。

interface VectorCase {
  sql: string;
  schemaMutates: boolean;
  /** MySQL のバックスラッシュエスケープ解釈での期待値 (省略時は `schemaMutates`)。 */
  schemaMutatesMysql?: boolean;
  note: string;
}

const cases = vectors.cases as VectorCase[];

/** 標準的な文字列リテラル解釈を採るドライバ。 */
const STANDARD_DRIVERS = ["postgres", "sqlite"] as const;

describe("スキーマ変更検出ゴールデン (フロント isSchemaMutatingSql)", () => {
  it("ベクタが十分なケース数を持つ (取りこぼし防止)", () => {
    expect(cases.length).toBeGreaterThanOrEqual(40);
    expect(cases.some((c) => c.schemaMutates)).toBe(true);
    expect(cases.some((c) => !c.schemaMutates)).toBe(true);
  });

  it("ドライバ次元が実際に使われている (#852 の回帰防止)", () => {
    expect(cases.some((c) => c.schemaMutatesMysql !== undefined)).toBe(true);
  });

  for (const c of cases) {
    const mysqlExpected = c.schemaMutatesMysql ?? c.schemaMutates;
    it(`${c.schemaMutates ? "mutates" : "keeps"}: ${c.note} — ${JSON.stringify(c.sql)}`, () => {
      // ドライバ不明の呼び出し口は標準解釈側に倒れる。
      expect(isSchemaMutatingSql(c.sql)).toBe(c.schemaMutates);
      for (const driver of STANDARD_DRIVERS) {
        expect(isSchemaMutatingSql(c.sql, driver)).toBe(c.schemaMutates);
      }
      expect(isSchemaMutatingSql(c.sql, "mysql")).toBe(mysqlExpected);
    });
  }
});
