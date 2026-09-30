import type { CellValue, QueryStreamPatchMessage } from "./api/tauri";
import { valuesEqual, type ResultRowDiff } from "./resultDiff";

/**
 * 自動リフレッシュの差分パッチ (#1257) をフロントで適用する純ロジック。
 *
 * バックエンド (`db/refresh_diff.rs`) は再実行のたびに全行を送る代わりに、前回結果の
 * 行位置を参照する区間 (`keep`) と、変化行・追加行の実データ (`rows`) だけを返す。
 * ここで前回の行配列から今回の行配列を再構成し、同時に `ResultGrid` の差分ハイライト
 * (`ResultRowDiff`) も作る — グリッドが全行を PK で突き合わせ直さずに済む。
 */

/**
 * スナップショット ID を行配列に紐づける。バックエンドの比較元 (前回結果の PK/行
 * ハッシュ) は「その行配列」に対してだけ正しいので、行配列の同一性をキーにする
 * (編集適用などで別配列になれば自動的に外れ、次の再実行は全行ストリームに戻る)。
 */
const snapshotIds = new WeakMap<object, number>();

export function attachSnapshotId(rows: CellValue[][], id: number | null | undefined): void {
  if (id !== null && id !== undefined) snapshotIds.set(rows, id);
}

export function snapshotIdFor(rows: CellValue[][] | null | undefined): number | null {
  return rows ? (snapshotIds.get(rows) ?? null) : null;
}

export interface AppliedPatch {
  /** 再構成した今回の行。`unchanged` のときは前回と同じ配列 (同一参照)。 */
  rows: CellValue[][];
  /** 差分 (変化セル・追加行・削除数)。`buildDiff` が false のときは null。 */
  diff: ResultRowDiff | null;
}

/**
 * `prev` にパッチを適用する。`prev` の行は再利用する (コピーしない) ので、行配列の
 * 構築は O(今回の行数) の参照コピーだけで済む。
 */
export function applyRefreshPatch(
  prev: CellValue[][],
  patch: QueryStreamPatchMessage,
  colCount: number,
  buildDiff: boolean,
): AppliedPatch {
  if (patch.unchanged) {
    return {
      rows: prev,
      diff: buildDiff
        ? { changedCells: [], addedRows: new Set(), removedCount: 0, hasChanges: false }
        : null,
    };
  }
  const rows: CellValue[][] = new Array<CellValue[]>(patch.totalRows);
  // 変化の無い行は全セル false の共有配列を指す (行数ぶんの配列を作らない)。
  const noChange = new Array<boolean>(colCount).fill(false);
  const changedCells: boolean[][] | null = buildDiff
    ? new Array<boolean[]>(patch.totalRows).fill(noChange)
    : null;
  const addedRows = new Set<number>();
  let anyCellChanged = false;
  let pos = 0;
  for (const run of patch.runs) {
    if (run.type === "keep") {
      for (let i = 0; i < run.count; i++) rows[pos++] = prev[run.from + i];
      continue;
    }
    for (let i = 0; i < run.rows.length; i++) {
      const row = run.rows[i];
      rows[pos] = row;
      const p = run.prev[i];
      if (p === null || p === undefined) {
        addedRows.add(pos);
      } else if (changedCells) {
        const prevRow = prev[p];
        let flags: boolean[] | null = null;
        if (prevRow) {
          for (let c = 0; c < colCount; c++) {
            if (!valuesEqual(prevRow[c], row[c])) {
              if (!flags) flags = new Array<boolean>(colCount).fill(false);
              flags[c] = true;
              anyCellChanged = true;
            }
          }
        }
        if (flags) changedCells[pos] = flags;
      }
      pos++;
    }
  }
  const diff: ResultRowDiff | null = changedCells
    ? {
        changedCells,
        addedRows,
        removedCount: patch.removedCount,
        hasChanges: anyCellChanged || addedRows.size > 0 || patch.removedCount > 0,
      }
    : null;
  return { rows, diff };
}
