import { describe, expect, it } from "vitest";
import type { z } from "zod";
import fixtures from "./fixtures/serdeResponseFixtures.json";
import * as schemas from "../api/schemas";

// zod ⇔ serde フィールド整合の共有ゴールデン (フロント側、#625)。
//
// 主要レスポンス型について、Rust の serde が実際に吐いた JSON
// (`fixtures/serdeResponseFixtures.json`、`src-tauri/tests/serde_schema_parity.rs`
// が生成・固定) を `api/schemas.ts` の zod スキーマで検証する。バック側の対テスト
// (`serde_schema_parity.rs`) がフィクスチャ = 実 serde 出力を保証するので、ここでは:
//
//   1. 各フィクスチャが対応する zod スキーマを **通る** (Rust → zod 互換。必須フィールド
//      欠落・型不一致を検出)。
//   2. フィクスチャのキー集合が zod スキーマの `shape` のキー集合と **一致する**
//      (フィールドの追加/削除ドリフトを双方向に検出。zod は既定で未知キーを黙って
//      捨てるため、parse だけではバック側のフィールド追加に気付けない — キー集合の
//      突き合わせで塞ぐ)。
//
// Rust 側でフィールドを足すとバックの対テストがまず落ち、フィクスチャを再生成すると
// 今度はこのキー集合比較が落ちて zod 側の追随漏れに気付ける、という二段構え。

type AnyObjectSchema = z.ZodObject<z.ZodRawShape>;

// フィクスチャのキー ⇔ エクスポート済み zod スキーマの対応。`column` / `serverVariable`
// は非公開の入れ子スキーマなので、それらを内包する上位型 (queryResult / serverInfo) の
// parse で間接的にカバーする (主要レスポンス型のキー整合をここで固定)。
const cases: Array<[keyof typeof fixtures, AnyObjectSchema]> = [
  ["queryResult", schemas.queryResult],
  ["tableColumnInfo", schemas.tableColumnInfo],
  ["tableSchema", schemas.tableSchema],
  ["foreignKey", schemas.foreignKey],
  ["indexInfo", schemas.indexInfo],
  ["schemaObject", schemas.schemaObject],
  ["tableRowEstimate", schemas.tableRowEstimate],
  ["tableSizeInfo", schemas.tableSizeInfo],
  ["serverInfo", schemas.serverInfo],
  ["processInfo", schemas.processInfo],
  ["queryStatsSupport", schemas.queryStatsSupport],
  ["liveQuery", schemas.liveQuery],
  ["statementStat", schemas.statementStat],
  ["previewResult", schemas.previewResult],
];

describe("zod ⇔ serde フィールドパリティ (主要レスポンス型)", () => {
  for (const [name, schema] of cases) {
    describe(name, () => {
      const fixture = fixtures[name];

      it("Rust serde 出力が zod スキーマを通る", () => {
        const result = schema.safeParse(fixture);
        expect(
          result.success,
          result.success
            ? ""
            : `zod parse failed for ${name}: ${JSON.stringify(result.error.issues, null, 2)}`,
        ).toBe(true);
      });

      it("フィクスチャのキー集合が zod スキーマの shape と一致する", () => {
        const fixtureKeys = Object.keys(fixture as Record<string, unknown>).sort();
        const schemaKeys = Object.keys(schema.shape).sort();
        // ズレたら「どちらに / 何が」余分かをメッセージで示す。
        expect(fixtureKeys).toEqual(schemaKeys);
      });
    });
  }

  it("全フィクスチャ型がテスト対象に含まれる (取りこぼし防止)", () => {
    // フィクスチャに型を足したのにここへ追加し忘れると素通りするのを防ぐ。
    // 非公開スキーマ (column / serverVariable) は上位型経由でカバーするため除外。
    const nestedOnly = new Set(["column", "serverVariable"]);
    const covered = new Set(cases.map(([n]) => n));
    const missing = Object.keys(fixtures).filter(
      (k) => !covered.has(k as keyof typeof fixtures) && !nestedOnly.has(k),
    );
    expect(missing).toEqual([]);
  });
});
