import { describe, expect, it } from "vitest";
import type { Column } from "../api/tauri";
import {
  blockerMessage,
  buildRowMergeTarget,
  duplicateGroupRowIndices,
  picksToRequest,
  rowMergeMenuDisabledReason,
} from "../components/rowMerge";

const columns: Column[] = [
  { name: "id", type_name: "INT" },
  { name: "email", type_name: "TEXT" },
];
const rows = [
  [1, "a@x"],
  [2, "a@x"],
  [3, "b@x"],
  [4, null],
  [5, null],
];

describe("rowMerge (#2303)", () => {
  it("選んだ行の主キー値を取り出し、同じキーは 1 つにまとめる", () => {
    const r = buildRowMergeTarget({ columns, rows, rowIndices: [0, 1, 1], pkIndices: [0] });
    expect(r).toEqual({ ok: true, target: { keyColumns: ["id"], keys: [[1], [2]] } });
  });

  it("1 行だけ・主キーなし・多すぎる選択は理由つきで失敗する", () => {
    expect(buildRowMergeTarget({ columns, rows, rowIndices: [0], pkIndices: [0] })).toEqual({
      ok: false,
      reason: "tooFew",
    });
    expect(buildRowMergeTarget({ columns, rows, rowIndices: [0, 1], pkIndices: [] })).toEqual({
      ok: false,
      reason: "noPk",
    });
    const many = Array.from({ length: 60 }, (_, i) => [i, "x"]);
    expect(
      buildRowMergeTarget({ columns, rows: many, rowIndices: many.map((_, i) => i), pkIndices: [0] }),
    ).toEqual({ ok: false, reason: "tooMany" });
  });

  it("メニューの無効理由: 表なし → 主キーなし → マスク → 行数の順", () => {
    const ok = buildRowMergeTarget({ columns, rows, rowIndices: [0, 1], pkIndices: [0] });
    const base = { hasTable: true, identityStrategy: "primary_key", pkMasked: false, built: ok };
    expect(rowMergeMenuDisabledReason(base)).toBeNull();
    expect(rowMergeMenuDisabledReason({ ...base, hasTable: false })).toBe("gridMergeRowsNoTable");
    expect(rowMergeMenuDisabledReason({ ...base, identityStrategy: "all_columns" })).toBe(
      "gridMergeRowsNoPk",
    );
    expect(rowMergeMenuDisabledReason({ ...base, pkMasked: true })).toBe("gridMergeRowsMasked");
    const few = buildRowMergeTarget({ columns, rows, rowIndices: [0], pkIndices: [0] });
    expect(rowMergeMenuDisabledReason({ ...base, built: few })).toBe("gridMergeRowsTooFew");
  });

  it("重複グループの行は、先頭行と同じキー値の行 (NULL キーは対象外)", () => {
    expect(duplicateGroupRowIndices(rows, [1], 0)).toEqual([0, 1]);
    expect(duplicateGroupRowIndices(rows, [1], 3)).toEqual([]);
  });

  it("採用元のリクエストは残す行 (0) の列を省く", () => {
    expect(
      picksToRequest({
        columns: [
          { name: "id", typeName: "int", locked: true },
          { name: "phone", typeName: "text", locked: false },
        ],
        picks: [0, 1],
      }),
    ).toEqual([{ column: "phone", fromRow: 1 }]);
  });

  it("実行できない理由は文言キーと埋め込み値に対応する", () => {
    expect(blockerMessage({ kind: "rowNotFound", index: 1 })).toEqual({
      key: "rowMergeBlockRowNotFound",
      params: { n: 2 },
    });
    expect(blockerMessage({ kind: "uniqueConflict", table: "t", index: "i", groups: 3 }).key).toBe(
      "rowMergeBlockConflict",
    );
    expect(blockerMessage({ kind: "crossDatabaseCascade", schema: "d", table: "t" })).toEqual({
      key: "rowMergeBlockCrossDb",
      params: { table: "d.t" },
    });
    expect(blockerMessage({ kind: "deletedChildReferenced", table: "a", referencing: "b" }).key).toBe(
      "rowMergeBlockGrandchild",
    );
    expect(blockerMessage({ kind: "crossChildrenUnreadable", table: "a" }).key).toBe(
      "rowMergeBlockCrossChildrenUnreadable",
    );
    expect(blockerMessage({ kind: "skipWithoutForeignKeys", table: "a" }).key).toBe("rowMergeBlockSkipNoFk");
  });
});
