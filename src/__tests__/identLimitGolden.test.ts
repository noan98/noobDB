import { describe, expect, it } from "vitest";
import { identLimit, identTooLong } from "../components/sqlDialect";
import { tooLongColumnNames } from "../components/alterTable";
import vectors from "./fixtures/identLimitVectors.json";

// 識別子の長さ上限のフロント側ゴールデン (#2384)。Rust `db/create_table.rs::max_ident_len` の
// テストが同じ JSON を `include_str!` で検証する。

describe("識別子長さ上限ゴールデン (#2384)", () => {
  const KNOWN = ["mysql", "postgres", "sqlite"];
  it("ゴールデンのドライバ名は既知のものだけ", () => {
    expect(Object.keys(vectors.limits).sort()).toEqual([...KNOWN].sort());
    for (const c of vectors.cases) expect(KNOWN).toContain(c.driver);
  });

  for (const [driver, lim] of Object.entries(vectors.limits)) {
    it(`上限: ${driver}`, () => {
      expect(identLimit(driver)).toEqual(lim);
    });
  }

  for (const c of vectors.cases) {
    it(`${c.note}`, () => {
      expect(identTooLong(c.driver, c.name)).toBe(c.tooLong);
    });
  }

  it("列変更: 追加・名前変更だけを検査し、触らない既存列は対象外", () => {
    const long = "あ".repeat(22);
    const form = {
      existing: [
        { original: long, name: long, drop: false },
        { original: "a", name: long, drop: false },
        { original: "b", name: long, drop: true },
      ],
      added: [{ name: ` ${"x".repeat(64)} ` }, { name: "ok" }],
    } as unknown as Parameters<typeof tooLongColumnNames>[1];
    expect(tooLongColumnNames("postgres", form)).toEqual([long, "x".repeat(64)]);
    expect(tooLongColumnNames("sqlite", form)).toEqual([]);
  });
});
