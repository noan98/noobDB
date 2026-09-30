import { describe, expect, it } from "vitest";
import vectors from "./fixtures/streamStatsVectors.json";
import { toNumber } from "../components/cellConditionalFormat";

/**
 * ストリーミング逐次統計 (#1257) の数値判定の共有ゴールデン — フロント側。
 * Rust の `db/stream_batch.rs::js_number` は `toNumber` と同じ結果にならなければ
 * ならない (ストリーム統計と JS 再計算で min/max がズレると、編集の前後でデータ
 * バーの基準が変わってしまう)。同じベクタを Rust 側でも検証している。
 */
describe("streamStatsVectors (#1257)", () => {
  it("toNumber: Rust の js_number と同じ結果になる", () => {
    expect(vectors.toNumber.length).toBeGreaterThan(0);
    for (const c of vectors.toNumber) {
      expect(toNumber(c.input), JSON.stringify(c.input)).toBe(c.expected);
    }
  });
});
