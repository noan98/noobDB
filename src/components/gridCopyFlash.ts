/**
 * 結果グリッドのコピー操作 (`ResultGrid.tsx` の `runCopy`) が対象範囲を一瞬
 * フラッシュさせる (#1159) ための純ロジック。演出自体は `App.css` の
 * `@keyframes copy-flash` (`apply-flash` / `find-current-pulse` と同方式) で、
 * ここでは「単一セル / 行 / 矩形選択」のコピー対象を行・列インデックスの集合に
 * 正規化し、実際に DOM 上に存在する (= 仮想スクロールで可視な) セルだけへ
 * クラスを付与する対象を絞り込む。
 *
 * 巨大な選択範囲をコピーしても全セルぶんの React state を撒かないよう、
 * `ResultGrid` 側は `cellRefs` (可視セルの `"rowIdx:colIdx"` → 要素の Map) を
 * そのまま辿って `collectCopyFlashKeys` に渡す。计算量は「可視セル数」に
 * 比例し、選択範囲そのものの大きさには依存しない。
 */

/** コピー対象範囲。元データの行インデックス / 列インデックスの集合。 */
export interface CopyFlashRange {
  readonly rowIndices: ReadonlySet<number>;
  readonly colIndices: ReadonlySet<number>;
}

/** 行・列インデックスの配列 (呼び出し側がコピー本文の生成に使うのと同じもの) から範囲を作る。 */
export function buildCopyFlashRange(
  rowIndices: readonly number[],
  colIndices: readonly number[],
): CopyFlashRange {
  return { rowIndices: new Set(rowIndices), colIndices: new Set(colIndices) };
}

/** 指定したセルがコピー対象範囲に含まれるか。 */
export function isCellInCopyFlashRange(
  range: CopyFlashRange | null | undefined,
  rowIdx: number,
  colIdx: number,
): boolean {
  if (!range) return false;
  return range.rowIndices.has(rowIdx) && range.colIndices.has(colIdx);
}

/**
 * `cellRefs` のキー ("rowIdx:colIdx"、`ResultGrid` の cell ref と同じ形式) の
 * うち、コピー対象範囲に含まれるものだけを返す。可視セルのみを走査するため、
 * 選択範囲がどれだけ大きくても実際に DOM に存在する分だけ処理する。
 */
export function collectCopyFlashKeys(
  cellKeys: Iterable<string>,
  range: CopyFlashRange,
): string[] {
  const out: string[] = [];
  for (const key of cellKeys) {
    const sep = key.indexOf(":");
    if (sep < 0) continue;
    const rowIdx = Number(key.slice(0, sep));
    const colIdx = Number(key.slice(sep + 1));
    if (range.rowIndices.has(rowIdx) && range.colIndices.has(colIdx)) out.push(key);
  }
  return out;
}
