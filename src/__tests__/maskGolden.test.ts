import { describe, expect, it } from "vitest";
import { maskLiterals } from "../dangerousSql";
import vectors from "./fixtures/maskVectors.json";

// コメント/リテラル・マスキングのフロント/バック整合性ゴールデンテスト (#988)。
//
// read-only 判定・auto-limit・stacked 検出・危険 SQL 検出・preflight の COUNT
// プローブ・flight recorder といった全安全網は「まずコメント/リテラルをマスクして
// からキーワード走査する」という同一の土台の上に立つ。フロント (`maskLiterals`、
// `src/dangerousSql.ts`) とバック (`mask_for_analysis_conservative` /
// `mask_for_driver`、`src-tauri/src/db/mod.rs`) はこの土台を独立に二重実装して
// いる。ここでは両者が参照する共有ベクタ (`fixtures/maskVectors.json`) をフロント
// 側で読み、各 SQL のマスク後の文字列が期待値と一致することを検証する。バック側は
// 同じ JSON を `src-tauri/tests/mask_golden.rs` が `include_str!` で読み込み、対に
// なる検証を行う。片方の実装だけ変えてもう片方とズレると、どちらかのテストが落ちる。
//
// ベクタは**ドライバ次元**を持つ (#852)。`masked` はバックスラッシュを文字列
// エスケープと見なさない標準解釈 (PostgreSQL / SQLite / DuckDB / MSSQL、および
// ドライバを渡さない呼び出し = `mask_for_analysis_conservative` 相当) での期待値で、
// MySQL だけ判定が変わるケースのみ `maskedMysql` を持つ。

interface VectorCase {
  sql: string;
  note: string;
  masked: string;
  /** MySQL のバックスラッシュエスケープ解釈での期待値 (省略時は `masked`)。 */
  maskedMysql?: string;
}

const drivers = vectors.drivers as string[];
const cases = vectors.cases as VectorCase[];

/** 標準的な文字列リテラル解釈を採るドライバ (= `masked` がそのまま期待値)。 */
const STANDARD_DRIVERS = ["postgres", "sqlite", "duckdb", "mssql"] as const;

describe("マスキング ゴールデン (フロント maskLiterals)", () => {
  it("ベクタが 5 ドライバすべてを覆う", () => {
    expect(drivers).toEqual(["mysql", "postgres", "sqlite", "duckdb", "mssql"]);
  });

  it("ベクタが十分なケース数を持つ (取りこぼし防止)", () => {
    expect(cases.length).toBeGreaterThanOrEqual(15);
  });

  it("ドライバ次元が実際に使われている (#852 の回帰防止)", () => {
    // MySQL だけマスク結果が分かれるケースが 1 件も無くなると、ドライバ次元が
    // 形骸化していることに気付けない。
    expect(cases.some((c) => c.maskedMysql !== undefined)).toBe(true);
  });

  for (const c of cases) {
    const mysqlExpected = c.maskedMysql ?? c.masked;
    it(`${c.note} — ${JSON.stringify(c.sql)}`, () => {
      // マスク後も長さは常に元の SQL と同じ (キーワードのオフセットが保たれる)。
      expect(c.masked.length).toBe(c.sql.length);
      expect(mysqlExpected.length).toBe(c.sql.length);

      // ドライバ非依存の呼び出し口は保守的 (標準解釈) 側に倒れる。
      expect(maskLiterals(c.sql)).toBe(c.masked);
      for (const driver of STANDARD_DRIVERS) {
        expect(maskLiterals(c.sql, driver)).toBe(c.masked);
      }
      expect(maskLiterals(c.sql, "mysql")).toBe(mysqlExpected);
    });
  }
});
