import { describe, expect, it } from "vitest";
import type { CellValue, QueryStreamPatchMessage } from "../api/tauri";
import { applyRefreshPatch, attachSnapshotId, snapshotIdFor } from "../refreshPatch";
import { attachRowDiff, diffResultRows, rowDiffFor } from "../resultDiff";

const row = (id: number, v: string): CellValue[] => [id, v];

describe("applyRefreshPatch (#1257)", () => {
  it("unchanged は前回の配列をそのまま返す", () => {
    const prev = [row(1, "a"), row(2, "b")];
    const patch: QueryStreamPatchMessage = { totalRows: 2, unchanged: true, removedCount: 0, runs: [] };
    const out = applyRefreshPatch(prev, patch, 2, true);
    expect(out.rows).toBe(prev);
    expect(out.diff?.hasChanges).toBe(false);
  });

  it("keep / rows 区間から今回の行を再構成し、diffResultRows と同じ差分を作る", () => {
    const prev = [row(1, "a"), row(2, "b"), row(3, "c"), row(4, "d")];
    // 3 を削除、2 を変更、5 を追加。順序は 1,2,4,5。
    const next = [row(1, "a"), row(2, "B"), row(4, "d"), row(5, "e")];
    const patch: QueryStreamPatchMessage = {
      totalRows: 4,
      unchanged: false,
      removedCount: 1,
      runs: [
        { type: "keep", from: 0, count: 1 },
        { type: "rows", prev: [1], rows: [row(2, "B")] },
        { type: "keep", from: 3, count: 1 },
        { type: "rows", prev: [null], rows: [row(5, "e")] },
      ],
    };
    const out = applyRefreshPatch(prev, patch, 2, true);
    expect(out.rows).toEqual(next);
    const expected = diffResultRows(prev, next, [0], 2);
    expect(out.diff?.changedCells).toEqual(expected.changedCells);
    expect([...(out.diff?.addedRows ?? [])]).toEqual([...expected.addedRows]);
    expect(out.diff?.removedCount).toBe(expected.removedCount);
    expect(out.diff?.hasChanges).toBe(true);
    // keep した行は前回の行オブジェクトをそのまま再利用する。
    expect(out.rows[0]).toBe(prev[0]);
  });

  it("サーバが変化と判定しても型違いだけのセルは変化扱いにしない (valuesEqual)", () => {
    const prev: CellValue[][] = [[1, "1"]];
    const patch: QueryStreamPatchMessage = {
      totalRows: 1,
      unchanged: false,
      removedCount: 0,
      runs: [{ type: "rows", prev: [0], rows: [[1, 1]] }],
    };
    const out = applyRefreshPatch(prev, patch, 2, true);
    expect(out.diff?.hasChanges).toBe(false);
  });

  it("buildDiff=false では差分を作らない", () => {
    const patch: QueryStreamPatchMessage = {
      totalRows: 1,
      unchanged: false,
      removedCount: 0,
      runs: [{ type: "rows", prev: [null], rows: [row(1, "a")] }],
    };
    const out = applyRefreshPatch([], patch, 2, false);
    expect(out.diff).toBeNull();
    expect(out.rows).toEqual([row(1, "a")]);
  });
});

describe("スナップショット ID / 事前計算済み差分は行配列の同一性に紐づく", () => {
  it("別の配列に置き換わると外れる", () => {
    const rows = [row(1, "a")];
    attachSnapshotId(rows, 7);
    expect(snapshotIdFor(rows)).toBe(7);
    expect(snapshotIdFor([...rows])).toBeNull();
    expect(snapshotIdFor(null)).toBeNull();
    attachSnapshotId(rows, null);
    expect(snapshotIdFor(rows)).toBe(7);

    const diff = { changedCells: [], addedRows: new Set<number>(), removedCount: 0, hasChanges: false };
    attachRowDiff(rows, diff);
    expect(rowDiffFor(rows)).toBe(diff);
    expect(rowDiffFor([...rows])).toBeNull();
  });
});
