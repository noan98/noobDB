import { describe, it, expect } from "vitest";
import { CellValue } from "../api/tauri";
import { diffResultRows, removedPrevRows, changedRowIndexSet } from "../resultDiff";

// Helper: a single-PK table where column 0 is the key.
const PK = [0];

describe("diffResultRows", () => {
  it("returns an empty diff when there is no resolvable PK", () => {
    const prev: CellValue[][] = [[1, "a"]];
    const next: CellValue[][] = [[1, "b"]];
    const d = diffResultRows(prev, next, [], 2);
    expect(d.hasChanges).toBe(false);
    expect(d.addedRows.size).toBe(0);
    expect(d.removedCount).toBe(0);
    // changedCells is shaped to the new result but all-false.
    expect(d.changedCells).toEqual([[false, false]]);
  });

  it("flags changed cells against the PK-paired previous row", () => {
    const prev: CellValue[][] = [
      [1, "alice", 10],
      [2, "bob", 20],
    ];
    const next: CellValue[][] = [
      [1, "alice", 11], // col 2 changed
      [2, "BOB", 20], // col 1 changed
    ];
    const d = diffResultRows(prev, next, PK, 3);
    expect(d.changedCells[0]).toEqual([false, false, true]);
    expect(d.changedCells[1]).toEqual([false, true, false]);
    expect(d.hasChanges).toBe(true);
    expect(d.addedRows.size).toBe(0);
    expect(d.removedCount).toBe(0);
  });

  it("pairs by PK regardless of row order", () => {
    const prev: CellValue[][] = [
      [1, "a"],
      [2, "b"],
    ];
    // Same rows but reordered, with row 2 changed.
    const next: CellValue[][] = [
      [2, "B"],
      [1, "a"],
    ];
    const d = diffResultRows(prev, next, PK, 2);
    expect(d.changedCells[0]).toEqual([false, true]); // next row 0 is pk=2
    expect(d.changedCells[1]).toEqual([false, false]); // next row 1 is pk=1
    expect(d.addedRows.size).toBe(0);
    expect(d.removedCount).toBe(0);
  });

  it("marks new-only rows as added and counts removed rows", () => {
    const prev: CellValue[][] = [
      [1, "a"],
      [2, "b"],
      [3, "c"],
    ];
    const next: CellValue[][] = [
      [1, "a"],
      [4, "d"], // added
    ];
    const d = diffResultRows(prev, next, PK, 2);
    expect(d.addedRows.has(1)).toBe(true);
    expect(d.addedRows.has(0)).toBe(false);
    // pk 2 and 3 disappeared.
    expect(d.removedCount).toBe(2);
    expect(d.hasChanges).toBe(true);
    // An added row has no previous pair, so its change flags stay false.
    expect(d.changedCells[1]).toEqual([false, false]);
  });

  it("treats NULL and undefined as equal, and NULL vs value as changed", () => {
    const prev: CellValue[][] = [[1, null]];
    const nextSame: CellValue[][] = [[1, null]];
    expect(diffResultRows(prev, nextSame, PK, 2).hasChanges).toBe(false);

    const nextChanged: CellValue[][] = [[1, "x"]];
    const d = diffResultRows(prev, nextChanged, PK, 2);
    expect(d.changedCells[0]).toEqual([false, true]);
  });

  it("compares across types via string form (no spurious diff)", () => {
    // BIGINT kept as string "100" vs numeric 100 must not show as changed.
    const prev: CellValue[][] = [[1, "100"]];
    const next: CellValue[][] = [[1, 100]];
    const d = diffResultRows(prev, next, PK, 2);
    expect(d.hasChanges).toBe(false);
  });

  it("reports no changes when prev and next are identical", () => {
    const rows: CellValue[][] = [
      [1, "a"],
      [2, "b"],
    ];
    const d = diffResultRows(rows, rows, PK, 2);
    expect(d.hasChanges).toBe(false);
    expect(d.addedRows.size).toBe(0);
    expect(d.removedCount).toBe(0);
  });

  it("handles a composite primary key", () => {
    const pk = [0, 1];
    const prev: CellValue[][] = [
      [1, "x", "old"],
      [1, "y", "keep"],
    ];
    const next: CellValue[][] = [
      [1, "x", "new"], // changed
      [1, "y", "keep"], // same
    ];
    const d = diffResultRows(prev, next, pk, 3);
    expect(d.changedCells[0]).toEqual([false, false, true]);
    expect(d.changedCells[1]).toEqual([false, false, false]);
    expect(d.removedCount).toBe(0);
  });

  it("counts a removal even when every surviving row is unchanged", () => {
    const prev: CellValue[][] = [
      [1, "a"],
      [2, "b"],
    ];
    const next: CellValue[][] = [[1, "a"]];
    const d = diffResultRows(prev, next, PK, 2);
    expect(d.hasChanges).toBe(true);
    expect(d.removedCount).toBe(1);
    expect(d.addedRows.size).toBe(0);
  });
});

describe("diffResultRows の配列確保 (出力は変えない)", () => {
  it("変化の無い行は共有配列を使い、変化した行だけ個別の配列を持つ", () => {
    const prev: CellValue[][] = [
      [1, "a", 1],
      [2, "b", 2],
      [3, "c", 3],
    ];
    const next: CellValue[][] = [
      [1, "a", 1],
      [2, "B", 2],
      [3, "c", 3],
    ];
    const d = diffResultRows(prev, next, PK, 3);
    expect(d.changedCells).toEqual([
      [false, false, false],
      [false, true, false],
      [false, false, false],
    ]);
    expect(d.changedCells[0]).toBe(d.changedCells[2]);
    expect(d.changedCells[1]).not.toBe(d.changedCells[0]);
    // 共有配列を書き換えていない。
    expect(d.changedCells[0]).toEqual([false, false, false]);
    expect(d.hasChanges).toBe(true);
  });

  it("PK が無いときは全行が全 false で、差分なし", () => {
    const d = diffResultRows(
      [[1, "a"]],
      [
        [1, "b"],
        [2, "c"],
      ],
      [],
      2,
    );
    expect(d.changedCells).toEqual([
      [false, false],
      [false, false],
    ]);
    expect(d.hasChanges).toBe(false);
    expect(d.addedRows.size).toBe(0);
  });

  it("追加行は全 false、削除は件数", () => {
    const d = diffResultRows(
      [
        [1, "a"],
        [2, "b"],
      ],
      [
        [1, "a"],
        [3, "c"],
      ],
      PK,
      2,
    );
    expect(d.changedCells).toEqual([
      [false, false],
      [false, false],
    ]);
    expect([...d.addedRows]).toEqual([1]);
    expect(d.removedCount).toBe(1);
  });
});

describe("removedPrevRows / changedRowIndexSet (#1628)", () => {
  const prev: CellValue[][] = [
    [1, "a"],
    [2, "b"],
    [3, "c"],
  ];
  it("今回に無い PK の前回行を前回の順で返す", () => {
    const next: CellValue[][] = [
      [2, "b"],
      [4, "d"],
    ];
    expect(removedPrevRows(prev, next, [0])).toEqual([
      [1, "a"],
      [3, "c"],
    ]);
  });
  it("PK が無ければ空、limit で打ち切る", () => {
    expect(removedPrevRows(prev, [], [])).toEqual([]);
    expect(removedPrevRows(prev, [], [0], 2)).toHaveLength(2);
  });
  it("複合 PK でも曖昧にならない", () => {
    const p: CellValue[][] = [
      [1, 2, "x"],
      [12, null, "y"],
    ];
    expect(removedPrevRows(p, [[1, 2, "x"]], [0, 1])).toEqual([[12, null, "y"]]);
  });
  it("変化行と追加行の行位置集合を返す", () => {
    const next: CellValue[][] = [
      [1, "a"],
      [2, "B"],
      [5, "e"],
    ];
    const diff = diffResultRows(prev, next, [0], 2);
    expect([...changedRowIndexSet(diff, next.length)].sort()).toEqual([1, 2]);
  });
});
