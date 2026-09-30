import { describe, expect, it } from "vitest";
import { comparePlans, opsFromSnapshot, planFingerprint, type PlanPayloadKind } from "../components/planDiff";
import vectors from "./fixtures/planWatchVectors.json";

// 実行計画ウォッチ (#743 / #1260) のフロント/バック整合性ゴールデンテスト — フロント側。
// 計画の正規化・フィンガープリント・2 世代の比較は、フロント (`planDiff.ts`) と
// バック (`src-tauri/src/plan_watch`) で独立に二重実装されている。両者が同一の共有ベクタ
// を読み、期待値 (フロントの実出力から生成) と一致することを検証する。バック側の
// 対になるテストは `src-tauri/tests/plan_watch_golden.rs`。

interface Snap {
  driver: string;
  payloadKind: string;
  payload: string;
}

const snapshot = (s: Snap) => ({
  driver: s.driver,
  payloadKind: s.payloadKind as PlanPayloadKind,
  payload: s.payload,
});

describe("plan watch shared vectors (frontend side)", () => {
  it("has a non-trivial number of vectors", () => {
    expect(vectors.ops.length).toBeGreaterThanOrEqual(30);
    expect(vectors.compare.length).toBeGreaterThanOrEqual(20);
  });

  it.each(vectors.ops.map((c) => [c.name, c] as const))("normalizes %s", (_name, c) => {
    const ops = opsFromSnapshot(snapshot(c));
    expect(ops).toEqual(c.ops);
    expect(planFingerprint(ops)).toBe(c.fingerprint);
  });

  it.each(vectors.compare.map((c) => [c.name, c] as const))("compares %s", (_name, c) => {
    const { changes } = comparePlans(opsFromSnapshot(snapshot(c.prev)), opsFromSnapshot(snapshot(c.next)));
    expect(changes).toEqual(c.changes);
  });
});
