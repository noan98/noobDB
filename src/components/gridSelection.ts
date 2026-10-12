/**
 * 結果グリッドの範囲選択を一括で作る純ロジック (#1529)。
 *
 * - Ctrl/Cmd+A: 表示順の先頭行・先頭列から末尾行・末尾列までの矩形。
 * - 行番号セルのクリック: その行の先頭列から末尾列まで。Shift+クリックは
 *   アンカー行からクリックした行まで (全列) に伸ばす。
 *
 * 行は元の行 index (`rows[i]` の i)、列は列 index。呼び出し側が表示順 (ソート・
 * フィルタ・並べ替え・非表示を反映済み) の配列を渡す。選択の実体 (`selectionRect`) は
 * `anchor` / `focus` から表示順で再計算されるので、ここでは 2 点だけを返す。
 */
export interface GridCellPos {
  rowIdx: number;
  colIdx: number;
}
export interface GridSelectionRange {
  anchor: GridCellPos;
  focus: GridCellPos;
}

/** 表示中の全セル。行か列が 0 なら null。 */
export function selectAllRange(
  visibleRowIdxs: readonly number[],
  visibleColIds: readonly number[],
): GridSelectionRange | null {
  if (visibleRowIdxs.length === 0 || visibleColIds.length === 0) return null;
  return {
    anchor: { rowIdx: visibleRowIdxs[0], colIdx: visibleColIds[0] },
    focus: {
      rowIdx: visibleRowIdxs[visibleRowIdxs.length - 1],
      colIdx: visibleColIds[visibleColIds.length - 1],
    },
  };
}

/**
 * 行番号クリックで選ぶ範囲。`anchorRowIdx` が非 null かつ `extend` のときは
 * アンカー行からクリック行までの全列、それ以外はクリック行の全列。
 */
export function rowSelectRange(
  rowIdx: number,
  visibleColIds: readonly number[],
  extend: boolean,
  anchorRowIdx: number | null,
): GridSelectionRange | null {
  if (visibleColIds.length === 0) return null;
  const first = visibleColIds[0];
  const last = visibleColIds[visibleColIds.length - 1];
  const anchorRow = extend && anchorRowIdx !== null ? anchorRowIdx : rowIdx;
  return {
    anchor: { rowIdx: anchorRow, colIdx: first },
    focus: { rowIdx, colIdx: last },
  };
}
