import { describe, it, expect } from "vitest";
import type { BroadcastDiff, Column } from "../api/tauri";
import {
  diffToRowDiff,
  removedRowSamples,
  resolveKeyIndicesByName,
  syncSqlBlockReason,
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

  it("returns [] when the key name matches multiple columns (JOIN の同名列)", () => {
    const joined = [col("id"), col("name"), col("id")];
    expect(resolveKeyIndicesByName(joined, ["id"])).toEqual([]);
    expect(resolveKeyIndicesByName(joined, ["name"])).toEqual([1]);
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
    removedRowIndices: [],
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

describe("removedRowSamples (#1625)", () => {
  const rows = [
    [1, "a", null],
    [2, "b", "x"],
    [3, "c", "y"],
  ];

  it("基準の欠落行を 列名=値 の 1 行に整形する (NULL は NULL と書く)", () => {
    const r = removedRowSamples(pkDiff({ removedRowIndices: [0, 2], removedCount: 2 }), rows, COLS);
    expect(r.samples).toEqual(["id=1, name=a, amount=NULL", "id=3, name=c, amount=y"]);
    expect(r.hiddenCount).toBe(0);
  });

  it("上限を超えた分は hiddenCount に数える", () => {
    const r = removedRowSamples(pkDiff({ removedRowIndices: [0, 1, 2], removedCount: 3 }), rows, COLS, 2);
    expect(r.samples).toHaveLength(2);
    expect(r.hiddenCount).toBe(1);
  });

  it("範囲外の添字は読み飛ばし、長いセルは省略する", () => {
    const long = [[1, "x".repeat(100), "z"]];
    const r = removedRowSamples(pkDiff({ removedRowIndices: [5, 0], removedCount: 2 }), long, COLS);
    expect(r.samples).toHaveLength(1);
    expect(r.samples[0]).toContain("…");
    expect(r.hiddenCount).toBe(1);
  });

  it("欠落が無ければ空", () => {
    expect(removedRowSamples(pkDiff({}), rows, COLS)).toEqual({ samples: [], hiddenCount: 0 });
  });
});

describe("syncSqlBlockReason (#1625)", () => {
  it("差分があり表名が分かり打ち切りが無ければ作れる (null)", () => {
    expect(syncSqlBlockReason(pkDiff({ hasDiff: true }), "users")).toBeNull();
  });

  it("表名が無ければ no-table、差分なしや比較不能は null", () => {
    expect(syncSqlBlockReason(pkDiff({ hasDiff: true }), null)).toBe("no-table");
    expect(syncSqlBlockReason(pkDiff({ hasDiff: false }), null)).toBeNull();
    expect(syncSqlBlockReason(pkDiff({ comparable: false, hasDiff: true }), "t")).toBeNull();
    expect(syncSqlBlockReason(null, "t")).toBeNull();
  });

  it("打ち切られた比較は差分なしでも truncated (全件比較を案内する)", () => {
    expect(syncSqlBlockReason(pkDiff({ truncated: true, hasDiff: false }), "t")).toBe("truncated");
    expect(syncSqlBlockReason(pkDiff({ truncated: true, hasDiff: true }), null)).toBe("truncated");
  });
});
