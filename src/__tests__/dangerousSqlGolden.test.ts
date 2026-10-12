import { describe, expect, it } from "vitest";
import { analyzeDangerousSql } from "../dangerousSql";
import vectors from "./fixtures/dangerousSqlVectors.json";

// 危険文検出のフロント/バック整合性ゴールデンテスト (#1535)。
//
// フロント (`analyzeDangerousSql`) と、スクリプト事前確認 (ドライラン) が使うバック
// (`db::script_analysis::classify_dangerous`) は独立に二重実装されている。両者が同一の
// 共有ベクタ (`fixtures/dangerousSqlVectors.json`) を読み、各文の判定が期待値と一致する
// ことを検証する。バック側は `src-tauri/tests/dangerous_sql_golden.rs`。片方だけ変えると
// どちらかが落ちる。ベクタは 1 文ずつ (`;` で区切らない)。`kind` は標準解釈
// (PostgreSQL / SQLite / ドライバ不明)、MySQL だけ判定が変わるケースは `kindMysql`。

interface VectorCase {
  sql: string;
  kind: string | null;
  kindMysql?: string | null;
  note: string;
}

const cases = vectors.cases as VectorCase[];
const STANDARD_DRIVERS = ["postgres", "sqlite"] as const;

function kindOf(sql: string, driver?: string): string | null {
  return analyzeDangerousSql(sql, driver)[0]?.kind ?? null;
}

describe("危険文検出ゴールデン (フロント analyzeDangerousSql)", () => {
  it("ベクタが十分なケース数を持つ (取りこぼし防止)", () => {
    expect(cases.length).toBeGreaterThanOrEqual(30);
    expect(cases.some((c) => c.kind !== null)).toBe(true);
    expect(cases.some((c) => c.kind === null)).toBe(true);
    expect(cases.some((c) => c.kindMysql !== undefined)).toBe(true);
    for (const kind of ["deleteNoWhere", "updateNoWhere", "drop", "truncate"]) {
      expect(cases.some((c) => c.kind === kind)).toBe(true);
    }
  });

  for (const c of cases) {
    const mysqlExpected = c.kindMysql === undefined ? c.kind : c.kindMysql;
    it(`${c.kind ?? "safe"}: ${c.note} — ${JSON.stringify(c.sql)}`, () => {
      expect(kindOf(c.sql)).toBe(c.kind);
      for (const driver of STANDARD_DRIVERS) {
        expect(kindOf(c.sql, driver)).toBe(c.kind);
      }
      expect(kindOf(c.sql, "mysql")).toBe(mysqlExpected);
    });
  }
});
