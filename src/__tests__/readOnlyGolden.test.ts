import { describe, expect, it } from "vitest";
import { isReadOnlySql } from "../dangerousSql";
import vectors from "./fixtures/readOnlySqlVectors.json";

// 読み取り専用判定のフロント/バック整合性ゴールデンテスト。
//
// フロント (`isReadOnlySql`) とバック (`is_read_only_sql`) は読み取り専用ガードを
// 独立に二重実装している。ここでは両者が参照する共有ベクタ
// (`fixtures/readOnlySqlVectors.json`) をフロント側で読み、各 SQL に対する判定が
// 期待値と一致することを検証する。バック側は同じ JSON を
// `src-tauri/tests/read_only_golden.rs` が `include_str!` で読み込み、対になる
// 検証を行う。片方の実装だけ変えてズレが生じると、どちらかのテストが落ちる。
//
// ベクタは **ドライバ次元**を持つ (#852)。`readOnly` はバックスラッシュを文字列
// エスケープと見なさない標準解釈 (PostgreSQL / SQLite / MSSQL、および
// ドライバを渡さない呼び出し) での期待値で、MySQL だけ判定が変わるケースは
// `readOnlyMysql` に書く。DuckDB は文字列エスケープこそ標準組だが、#1005 で
// FROM 先頭構文・SUMMARIZE・照会形 PRAGMA という DuckDB 固有の読み取り許可を
// 追加したため、これらを使うケースだけ `readOnlyDuckdb` に書く。

interface VectorCase {
  sql: string;
  readOnly: boolean;
  /** MySQL のバックスラッシュエスケープ解釈での期待値 (省略時は `readOnly`)。 */
  readOnlyMysql?: boolean;
  /** DuckDB 固有の許可拡張 (#1005) を踏まえた期待値 (省略時は `readOnly`)。 */
  readOnlyDuckdb?: boolean;
  note: string;
}

const cases = vectors.cases as VectorCase[];

/** 標準的な文字列リテラル解釈を採り、DuckDB 固有拡張の対象外なドライバ。 */
const STANDARD_DRIVERS = ["postgres", "sqlite", "mssql"] as const;

describe("read-only 判定ゴールデン (フロント isReadOnlySql)", () => {
  it("ベクタが十分なケース数を持つ (取りこぼし防止)", () => {
    expect(cases.length).toBeGreaterThanOrEqual(30);
  });

  it("ドライバ次元が実際に使われている (#852 の回帰防止)", () => {
    // MySQL だけ判定が分かれるケースが 1 件も無くなると、ドライバ次元が
    // 形骸化していることに気付けない。
    expect(cases.some((c) => c.readOnlyMysql !== undefined)).toBe(true);
  });

  it("DuckDB 次元が実際に使われている (#1005 の回帰防止)", () => {
    // FROM/SUMMARIZE/照会形 PRAGMA など DuckDB だけ判定が分かれるケースが
    // 1 件も無くなると、この次元が形骸化していることに気付けない。
    expect(cases.some((c) => c.readOnlyDuckdb !== undefined)).toBe(true);
  });

  for (const c of cases) {
    const mysqlExpected = c.readOnlyMysql ?? c.readOnly;
    const duckdbExpected = c.readOnlyDuckdb ?? c.readOnly;
    it(`${c.readOnly ? "read-only" : "write"}: ${c.note} — ${JSON.stringify(c.sql)}`, () => {
      // ドライバ非依存の呼び出し口は保守的 (標準解釈、DuckDB 拡張なし) 側に倒れる。
      expect(isReadOnlySql(c.sql)).toBe(c.readOnly);
      for (const driver of STANDARD_DRIVERS) {
        expect(isReadOnlySql(c.sql, driver)).toBe(c.readOnly);
      }
      expect(isReadOnlySql(c.sql, "mysql")).toBe(mysqlExpected);
      expect(isReadOnlySql(c.sql, "duckdb")).toBe(duckdbExpected);
    });
  }
});
