import { describe, it, expect } from "vitest";
import type { CellValue, Column } from "../api/tauri";
import {
  compareBroadcastEnvironment,
  countChangedCells,
  resolveKeyIndicesByName,
  MAX_BROADCAST_COMPARE_ROWS,
} from "../broadcastCompare";

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

describe("compareBroadcastEnvironment — column mismatch", () => {
  it("reports incomparable when column counts differ", () => {
    const baseline = { columns: COLS, rows: [[1, "a", 10]] };
    const target = { columns: [col("id"), col("name")], rows: [[1, "a"]] };
    const d = compareBroadcastEnvironment(baseline, target, [0]);
    expect(d.comparable).toBe(false);
    expect(d.mode).toBe("none");
    expect(d.hasDiff).toBe(false);
  });

  it("reports incomparable when column names differ (even same count)", () => {
    const baseline = { columns: COLS, rows: [[1, "a", 10]] };
    const target = { columns: [col("id"), col("label"), col("amount")], rows: [[1, "a", 10]] };
    const d = compareBroadcastEnvironment(baseline, target, [0]);
    expect(d.comparable).toBe(false);
    expect(d.mode).toBe("none");
  });
});

describe("compareBroadcastEnvironment — PK mode", () => {
  it("flags changed cells against the PK-paired baseline row (delegates to diffResultRows)", () => {
    const baseline = { columns: COLS, rows: [[1, "alice", 10], [2, "bob", 20]] };
    const target = { columns: COLS, rows: [[1, "alice", 11], [2, "bob", 20]] };
    const d = compareBroadcastEnvironment(baseline, target, [0]);
    expect(d.comparable).toBe(true);
    expect(d.mode).toBe("pk");
    expect(d.changedCells).toEqual([
      [false, false, true],
      [false, false, false],
    ]);
    expect(countChangedCells(d.changedCells)).toBe(1);
    expect(d.addedRowIndices.size).toBe(0);
    expect(d.removedCount).toBe(0);
    expect(d.hasDiff).toBe(true);
  });

  it("flags added and removed rows via PK pairing", () => {
    const baseline = { columns: COLS, rows: [[1, "a", 1], [2, "b", 2]] };
    const target = { columns: COLS, rows: [[1, "a", 1], [3, "c", 3]] };
    const d = compareBroadcastEnvironment(baseline, target, [0]);
    expect(d.mode).toBe("pk");
    expect(d.addedRowIndices.has(1)).toBe(true); // pk=3 only in target
    expect(d.removedCount).toBe(1); // pk=2 only in baseline
    expect(d.hasDiff).toBe(true);
  });

  it("supports a composite primary key", () => {
    const cols = [col("tenant"), col("id"), col("value")];
    const baseline = { columns: cols, rows: [[1, "x", "old"], [1, "y", "keep"]] };
    const target = { columns: cols, rows: [[1, "x", "new"], [1, "y", "keep"]] };
    const d = compareBroadcastEnvironment(baseline, target, [0, 1]);
    expect(d.mode).toBe("pk");
    expect(d.changedCells).toEqual([
      [false, false, true],
      [false, false, false],
    ]);
  });

  it("reports no diff when environments are identical", () => {
    const rows: CellValue[][] = [[1, "a", 1], [2, "b", 2]];
    const d = compareBroadcastEnvironment({ columns: COLS, rows }, { columns: COLS, rows }, [0]);
    expect(d.hasDiff).toBe(false);
    expect(d.addedRowIndices.size).toBe(0);
    expect(d.removedCount).toBe(0);
  });
});

describe("compareBroadcastEnvironment — hash degrade (PK 不明)", () => {
  it("degrades to hash-based added/removed only (no changedCells) when pkIndices is empty", () => {
    const baseline = { columns: COLS, rows: [[1, "a", 1], [2, "b", 2]] };
    const target = { columns: COLS, rows: [[1, "a", 1], [2, "b", 2]] };
    const d = compareBroadcastEnvironment(baseline, target, []);
    expect(d.mode).toBe("hash");
    expect(d.changedCells).toBeUndefined();
    expect(d.hasDiff).toBe(false);
  });

  it("flags a row present only in the target as added", () => {
    const baseline = { columns: COLS, rows: [[1, "a", 1]] };
    const target = { columns: COLS, rows: [[1, "a", 1], [9, "z", 9]] };
    const d = compareBroadcastEnvironment(baseline, target, []);
    expect(d.mode).toBe("hash");
    expect(d.addedRowIndices).toEqual(new Set([1]));
    expect(d.removedCount).toBe(0);
    expect(d.hasDiff).toBe(true);
  });

  it("counts a row present only in the baseline as removed (missing from target)", () => {
    const baseline = { columns: COLS, rows: [[1, "a", 1], [2, "b", 2]] };
    const target = { columns: COLS, rows: [[1, "a", 1]] };
    const d = compareBroadcastEnvironment(baseline, target, []);
    expect(d.mode).toBe("hash");
    expect(d.addedRowIndices.size).toBe(0);
    expect(d.removedCount).toBe(1);
    expect(d.hasDiff).toBe(true);
  });

  it("treats a changed non-key cell as remove-old + add-new (no per-cell diff without PK)", () => {
    const baseline = { columns: COLS, rows: [[1, "a", 1]] };
    const target = { columns: COLS, rows: [[1, "a", 2]] };
    const d = compareBroadcastEnvironment(baseline, target, []);
    expect(d.mode).toBe("hash");
    expect(d.addedRowIndices).toEqual(new Set([0]));
    expect(d.removedCount).toBe(1);
  });

  it("handles duplicate rows as a multiset (extra duplicate counts as added, missing duplicate as removed)", () => {
    // baseline has "A" twice and "B" once; target has "A" once and "B" twice.
    const baseline = { columns: COLS, rows: [[1, "A", 1], [1, "A", 1], [2, "B", 2]] };
    const target = { columns: COLS, rows: [[1, "A", 1], [2, "B", 2], [2, "B", 2]] };
    const d = compareBroadcastEnvironment(baseline, target, []);
    expect(d.mode).toBe("hash");
    // One extra "B" in target beyond baseline's single occurrence → added.
    expect(d.addedRowIndices).toEqual(new Set([2]));
    // One "A" missing from target relative to baseline's two occurrences → removed.
    expect(d.removedCount).toBe(1);
  });

  it("unifies NULL and undefined the same way diffResultRows/valuesEqual do", () => {
    const baseline = { columns: COLS, rows: [[1, null, 1]] };
    const target = { columns: COLS, rows: [[1, undefined as unknown as CellValue, 1]] };
    const d = compareBroadcastEnvironment(baseline, target, []);
    expect(d.hasDiff).toBe(false);
  });

  it("unifies cross-type equivalent values (number vs numeric string), matching valuesEqual's policy", () => {
    const baseline = { columns: COLS, rows: [[1, "a", "100"]] };
    const target = { columns: COLS, rows: [[1, "a", 100]] };
    const d = compareBroadcastEnvironment(baseline, target, []);
    expect(d.hasDiff).toBe(false);
  });

  it("reports no diff for two empty result sets", () => {
    const d = compareBroadcastEnvironment(
      { columns: COLS, rows: [] },
      { columns: COLS, rows: [] },
      [],
    );
    expect(d.mode).toBe("hash");
    expect(d.hasDiff).toBe(false);
    expect(d.truncated).toBe(false);
  });

  it("treats every row as added when the baseline is empty", () => {
    const target = { columns: COLS, rows: [[1, "a", 1], [2, "b", 2]] };
    const d = compareBroadcastEnvironment({ columns: COLS, rows: [] }, target, []);
    expect(d.addedRowIndices).toEqual(new Set([0, 1]));
    expect(d.removedCount).toBe(0);
  });

  it("counts every baseline row as removed when the target is empty", () => {
    const baseline = { columns: COLS, rows: [[1, "a", 1], [2, "b", 2]] };
    const d = compareBroadcastEnvironment(baseline, { columns: COLS, rows: [] }, []);
    expect(d.removedCount).toBe(2);
    expect(d.addedRowIndices.size).toBe(0);
  });
});

describe("compareBroadcastEnvironment — truncation", () => {
  it("truncates both sides at maxRows and reports truncated: true", () => {
    const baseline = { columns: COLS, rows: [[1, "a", 1], [2, "b", 2], [3, "c", 3]] };
    const target = { columns: COLS, rows: [[1, "a", 1], [2, "b", 2], [3, "c", 3]] };
    const d = compareBroadcastEnvironment(baseline, target, [0], 2);
    expect(d.truncated).toBe(true);
  });

  it("does not truncate when row counts are within the limit", () => {
    const baseline = { columns: COLS, rows: [[1, "a", 1]] };
    const target = { columns: COLS, rows: [[1, "a", 1]] };
    const d = compareBroadcastEnvironment(baseline, target, [0], 2);
    expect(d.truncated).toBe(false);
  });

  it("defaults maxRows to MAX_BROADCAST_COMPARE_ROWS (5000, matching diff.rs::MAX_DATA_ROWS)", () => {
    expect(MAX_BROADCAST_COMPARE_ROWS).toBe(5000);
  });
});

describe("countChangedCells", () => {
  it("returns 0 for undefined", () => {
    expect(countChangedCells(undefined)).toBe(0);
  });

  it("counts true flags across all rows", () => {
    expect(
      countChangedCells([
        [true, false, true],
        [false, false, false],
      ]),
    ).toBe(2);
  });
});
