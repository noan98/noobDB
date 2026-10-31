import { describe, expect, it } from "vitest";
import vectors from "./fixtures/jsNumberVectors.json";

// js_compat::js_number_to_string / js_to_number の実装横断ゴールデンテスト — フロント側 (#1959)。
//
// バックエンドの `db/js_compat.rs` は、フロントの素の `String(x)` / `Number(s)` を Rust で
// 再現する (結果グリッドのソート/フィルタ・値検索・マスキングの仮名決定性が「JS と同一表記」に
// 乗る)。ここでは実物の `String` / `Number` を共有ベクタ (`fixtures/jsNumberVectors.json`) へ
// 通し、ベクタ自体が JS の実挙動と一致していることを固定する。バック側は同じ JSON を
// `src-tauri/tests/js_number_golden.rs` が `include_str!` で読み込み、Rust 実装に通す。

interface Case {
  input: string;
  expected: string;
  note: string;
}

const numberToString = vectors.numberToString as Case[];
const toNumber = vectors.toNumber as Case[];

describe("js number golden (frontend side)", () => {
  it("has vectors covering the exponent boundaries", () => {
    const inputs = numberToString.map((c) => c.input);
    for (const must of ["1e21", "999999999999999900000", "0.000001", "1e-7", "5e-324", "-0"]) {
      expect(inputs).toContain(must);
    }
  });

  it.each(numberToString)("String(Number($input)) === $expected ($note)", ({ input, expected }) => {
    expect(String(Number(input))).toBe(expected);
  });

  it.each(toNumber)("Number($input) is $expected ($note)", ({ input, expected }) => {
    const got = Number(input);
    const want = Number(expected);
    if (Number.isNaN(want)) {
      expect(got).toBeNaN();
    } else {
      // -0 と 0 も区別する (Object.is)。
      expect(Object.is(got, want)).toBe(true);
    }
  });
});
