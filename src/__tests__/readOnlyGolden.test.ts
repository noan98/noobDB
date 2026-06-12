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

interface VectorCase {
  sql: string;
  readOnly: boolean;
  note: string;
}

const cases = vectors.cases as VectorCase[];

describe("read-only 判定ゴールデン (フロント isReadOnlySql)", () => {
  it("ベクタが十分なケース数を持つ (取りこぼし防止)", () => {
    expect(cases.length).toBeGreaterThanOrEqual(30);
  });

  for (const c of cases) {
    it(`${c.readOnly ? "read-only" : "write"}: ${c.note} — ${JSON.stringify(c.sql)}`, () => {
      expect(isReadOnlySql(c.sql)).toBe(c.readOnly);
    });
  }
});
