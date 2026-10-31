import { describe, expect, it } from "vitest";
import { compareStringCells } from "../components/gridSortFilter";
import vectors from "./fixtures/collationKeyVectors.json";

// `js_compat::collation_key` (照合順) のフロント↔バック共有ゴールデン — フロント側 (#1944)。
// `compareStringCells` (= `new Intl.Collator(undefined, { numeric: true })`、判定の正) が
// 共有ベクタ (`fixtures/collationKeyVectors.json`) の期待値 (比較符号) と一致することを固定する。
// バック側は同じ JSON を `src-tauri/tests/collation_key_golden.rs` が `include_str!` で読み、
// `collation_key` の近似キーと突き合わせる。JS のソートを変えるとこちらが、Rust の近似を
// ずらすと Rust 側が赤くなる。
//
// 期待値は en-US / ICU 77 (Node 22) 前提。実行環境の既定ロケール (ja-JP の「あ」「ア」、全角、
// sv-SE の ä/ö/å など) で結果が変わるケースは `localeSensitive: true` を付け、そのケースだけ
// `Intl.Collator("en-US")` で検証する (それ以外は実装そのものの `compareStringCells`)。
//
// `knownDifferences` は Rust の近似が ICU と食い違う既知の差で、ここ (JS 側) だけが検証する。

interface Case {
  a: string;
  b: string;
  expected: number;
  localeSensitive?: boolean;
}

const groups = vectors.groups as { name: string; cases: Case[] }[];
const known = vectors.knownDifferences as (Case & { group: string })[];

const enCollator = new Intl.Collator("en-US", { numeric: true });
const actual = (c: Case) =>
  Math.sign(c.localeSensitive ? enCollator.compare(c.a, c.b) : compareStringCells(c.a, c.b));

const label = (c: Case) => `${JSON.stringify(c.a)} vs ${JSON.stringify(c.b)}`;

describe("collation_key 共有ゴールデン (JS 側, #1944)", () => {
  it("ベクタが空でない", () => {
    expect(groups.length).toBeGreaterThan(0);
  });

  describe.each(groups.map((g) => [g.name, g.cases] as const))("%s", (_name, cases) => {
    it.each(cases.map((c) => [label(c), c] as const))("%s", (_l, c) => {
      expect(actual(c)).toBe(c.expected);
    });
  });

  it.each(known.map((c) => [`${c.group}: ${label(c)}`, c] as const))(
    "既知の差 %s は JS の期待値のまま",
    (_l, c) => {
      expect(actual(c)).toBe(c.expected);
    },
  );
});
