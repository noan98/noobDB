import { describe, expect, it } from "vitest";
import vectors from "./fixtures/scriptSplitVectors.json";
import { splitSqlStatements } from "../sqlScript";

// スクリプト文分割のフロント/バック整合性ゴールデン — フロント側 (#973)。
//
// エディタのバッチ実行 (`splitSqlStatements`) と、`.sql` ファイルをストリーミング
// 実行するバックエンドのスクリプトランナー (`src-tauri/src/db/script.rs` の
// `ScriptSplitter`) は独立した二重実装。同じ共有ベクタを読んで同じ分割結果になる
// ことを、ここと `src-tauri/tests/script_split_golden.rs` の両方で固定する。
// `statements` は MySQL 以外、`statementsMysql` は MySQL だけ結果が変わるケース。

interface VectorCase {
  sql: string;
  note: string;
  statements: string[];
  statementsMysql?: string[];
}

const cases = vectors.cases as VectorCase[];

describe("scriptSplitVectors.json (フロント splitSqlStatements)", () => {
  it("十分な数のベクタがある (抽出の保険)", () => {
    expect(cases.length).toBeGreaterThanOrEqual(15);
  });

  for (const driver of vectors.drivers) {
    for (const c of cases) {
      it(`${driver}: ${c.note}`, () => {
        const expected = driver === "mysql" ? (c.statementsMysql ?? c.statements) : c.statements;
        expect(splitSqlStatements(c.sql, driver)).toEqual(expected);
      });
    }
  }
});
