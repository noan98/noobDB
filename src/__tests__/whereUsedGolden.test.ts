import { describe, expect, it } from "vitest";
import vectors from "./fixtures/whereUsedVectors.json";
import type { WhereUsedTarget } from "../api/tauri";
import { analyzeDefinition, prepareForReferenceScan } from "./oracles/whereUsedOracle";

/**
 * Where-used の参照検出の共有ゴールデン (フロント側、#1261)。
 *
 * 参照検出本体は Rust (`db::where_used`) に移り、製品コードの TS にこの実装は無い。期待値は
 * 移植前の TS 実装 (オラクル) の出力で、ここでは「ベクタがオラクルの出力と一致し続けて
 * いること」を固定する。Rust 側 (`tests/where_used_golden.rs`) が同じベクタに Rust 実装を
 * 通すので、オラクルとベクタを守ることが移植前後の検出結果の同一性の保証になる。
 */
describe("where-used golden vectors", () => {
  it("has cases", () => {
    expect(vectors.cases.length).toBeGreaterThan(40);
  });

  for (const c of vectors.cases) {
    it(c.name, () => {
      const target = c.target as WhereUsedTarget;
      expect(analyzeDefinition(c.sql, target, c.driver)).toEqual(c.expected);
    });
  }

  for (const p of vectors.prepare) {
    it(`mask (${p.driver}): ${JSON.stringify(p.sql).slice(0, 50)}`, () => {
      expect(prepareForReferenceScan(p.sql, p.driver)).toBe(p.expected);
    });
  }
});
