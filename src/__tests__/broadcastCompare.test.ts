import { describe, it, expect } from "vitest";
import type { BroadcastDiff, Column } from "../api/tauri";
import {
  diffToRowDiff,
  resolveKeyIndicesByName,
  MAX_BROADCAST_COMPARE_ROWS,
} from "../broadcastCompare";

// 比較ロジック本体 (PK ペアリング / 行ハッシュ降格 / 打ち切り) は #1257 でバックエンド
// (`db/broadcast_diff.rs`) へ移り、同等の境界ケースは Rust 側のユニットテストが固定する。
// ここではフロントに残る純関数 (キー列名の解決と、差分サマリ → グリッド用差分の変換) を検証する。

function col(name: string): Column {
  return { name, type_name: "text" };
}

const COLS: Column[] = [col("id"), col("name"), col("amount")];

describe("resolveKeyIndicesByName", () => {
  it("returns [] when no key column names are given (PK 不明の既定)", () => {
    expect(resolveKeyIndicesByName(COLS, [])).toEqual([]);
  });

  it("resolves a single key column to its index", () => {
    expect(resolveKeyIndicesByName(COLS, ["name"])).toEqual([1]);
  });

  it("resolves a composite key preserving the given order", () => {
    expect(resolveKeyIndicesByName(COLS, ["amount", "id"])).toEqual([2, 0]);
  });

  it("falls back to [] (not partial) when any name is unresolvable", () => {
    expect(resolveKeyIndicesByName(COLS, ["id", "does_not_exist"])).toEqual([]);
  });
});

function pkDiff(partial: Partial<BroadcastDiff>): BroadcastDiff {
  return {
    comparable: true,
    mode: "pk",
    changedCells: [],
    changedCellCount: 0,
    addedRowIndices: [],
    removedCount: 0,
    truncated: false,
    hasDiff: false,
    ...partial,
  };
}

describe("diffToRowDiff", () => {
  it("疎な変化セルを boolean[][] に展開し、変化の無い行は共有配列を指す", () => {
    const d = diffToRowDiff(
      pkDiff({
        changedCells: [{ row: 1, cols: [2] }],
        changedCellCount: 1,
        addedRowIndices: [2],
        removedCount: 1,
        hasDiff: true,
      }),
      3,
      3,
    );
    expect(d.changedCells).toEqual([
      [false, false, false],
      [false, false, true],
      [false, false, false],
    ]);
    expect(d.changedCells[0]).toBe(d.changedCells[2]);
    expect([...d.addedRows]).toEqual([2]);
    expect(d.removedCount).toBe(1);
    expect(d.hasChanges).toBe(true);
  });

  it("範囲外の添字は無視する", () => {
    const d = diffToRowDiff(
      pkDiff({
        changedCells: [
          { row: 9, cols: [0] },
          { row: 0, cols: [5, 1] },
        ],
        addedRowIndices: [7, 0],
        hasDiff: true,
      }),
      2,
      2,
    );
    expect(d.changedCells[0]).toEqual([false, true]);
    expect([...d.addedRows]).toEqual([0]);
  });

  it("差分なしなら hasChanges は false", () => {
    const d = diffToRowDiff(pkDiff({}), 0, 0);
    expect(d.hasChanges).toBe(false);
    expect(d.changedCells).toEqual([]);
  });
});

describe("定数", () => {
  it("MAX_BROADCAST_COMPARE_ROWS は 5000 (バックエンドの上限と同値)", () => {
    expect(MAX_BROADCAST_COMPARE_ROWS).toBe(5000);
  });
});
