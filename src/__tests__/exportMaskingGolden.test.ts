import { describe, expect, it } from "vitest";
import vectors from "./fixtures/exportMaskingVectors.json";
import { sanitizeMaskRule } from "../components/exportMasking";

/**
 * エクスポート時のデータマスキング (#733) の共有ゴールデン — フロント側。
 *
 * 値の変換 (伏せ字 / 部分マスク / 仮名化 / NULL 化) はバックエンドの
 * `db/masking.rs` だけが行い (仮名化の秘密ソルトをフロントへ出さないため)、
 * `cases` の期待値はバック側のテストが検証する。フロントとバックで二重に持つのは
 * **ルールの正規化** (設定から読み戻した値・入力欄の値を上限と既定値へ揃える) で、
 * ここでは同じベクタの `normalize` を `sanitizeMaskRule` に通して、バックの
 * `MaskRule::normalized` と同じ正規形になることを固定する。
 */
describe("exportMaskingVectors (#733)", () => {
  it("normalize: バックエンドの MaskRule::normalized と同じ正規形になる", () => {
    expect(vectors.normalize.length).toBeGreaterThan(0);
    for (const c of vectors.normalize) {
      expect(sanitizeMaskRule(c.rule), c.name).toEqual(c.normalized);
    }
  });

  it("cases: フロントが送る形のルールがそのまま正規形 (バックの入力形と一致)", () => {
    expect(vectors.cases.length).toBeGreaterThan(0);
    for (const c of vectors.cases) {
      expect(sanitizeMaskRule(c.rule), c.name).toEqual(c.rule);
    }
  });

  it("境界ケース (マルチバイト・NULL・BLOB) を含む", () => {
    const names = vectors.cases.map((c) => c.name);
    expect(names.some((n) => n.includes("multibyte"))).toBe(true);
    expect(names.some((n) => n.includes("null"))).toBe(true);
    expect(names.some((n) => n.includes("bytes"))).toBe(true);
  });
});
