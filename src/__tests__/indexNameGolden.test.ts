import { describe, expect, it } from "vitest";
import { createIndexName } from "../components/tableMaintenance";
import { identTooLong, storedIndexName } from "../components/sqlDialect";
import vectors from "./fixtures/indexNameVectors.json";

// インデックス名生成のフロント側ゴールデン (#2360)。自動生成名の規則は
// `src-tauri/src/db/advisor.rs::auto_index_name` と同じで、同じ JSON を Rust 側の
// `advisor.rs` のテストが `include_str!` で検証する。

describe("インデックス名ゴールデン (#2360)", () => {
  for (const c of vectors.auto) {
    it(`自動生成: ${c.note} (${c.driver})`, () => {
      const name = createIndexName(c.driver, c.table, c.columns);
      expect(name).toBe(c.expected);
      if (c.driver === "mysql") expect(name.length).toBeLessThanOrEqual(64);
      if (c.driver === "postgres") expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(63);
    });
  }

  it("自動生成名は日本語の別列で衝突しない", () => {
    const a = createIndexName("mysql", "注文", ["氏名"]);
    const b = createIndexName("mysql", "注文", ["住所"]);
    expect(a).not.toBe(b);
  });

  for (const c of vectors.user) {
    it(`入力名: ${JSON.stringify(c.name)} (${c.driver})`, () => {
      expect(createIndexName(c.driver, "t", ["a"], { name: c.name })).toBe(c.expected);
      expect(identTooLong(c.driver, c.expected)).toBe(c.tooLong);
      expect(storedIndexName(c.driver, c.expected)).toBe(c.stored);
    });
  }
});
