import { describe, expect, it } from "vitest";
import vectors from "./fixtures/objectSearchVectors.json";
import { buildObjectIndex, searchObjects } from "./oracles/objectSearchOracle";

/**
 * グローバルオブジェクト検索の順位付けの共有ゴールデン (フロント側、#1261)。
 *
 * スコアリング本体は Rust (`db::object_search`) に移り、製品コードの TS にこの実装は無い。
 * 期待値は移植前の TS 実装 (オラクル) の出力で、ここでは「ベクタがオラクルの出力と一致し
 * 続けていること」を固定する。Rust 側 (`tests/object_search_golden.rs`) が同じベクタに
 * Rust 実装を通すので、オラクルとベクタを守ることが移植前後の順位同一性の保証になる。
 */
describe("object search golden vectors", () => {
  const index = buildObjectIndex(vectors.schemas);

  it("has cases", () => {
    expect(vectors.cases.length).toBeGreaterThan(20);
  });

  for (const c of vectors.cases) {
    it(`${JSON.stringify(c.query)} (limit ${c.limit}): ${c.note}`, () => {
      expect(searchObjects(index, c.query, c.limit)).toEqual(c.expected);
    });
  }
});
