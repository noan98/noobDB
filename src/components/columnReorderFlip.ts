/**
 * 結果グリッドの列ドラッグ並べ替え (#1021) の純ロジック。
 *
 * - `reorderColumnIds`: ドロップ確定時の新しい列順を求める (ドラッグ元を取り除き、
 *   ドロップ先の列の **手前** に差し込む。ドロップ先ヘッダ左端のアクセント線と一致)。
 * - `computeFlipOffsets`: FLIP (First / Last / Invert / Play) の Invert 量を求める。
 *   並べ替え前後の各列ヘッダの左端 x 座標から「新しい位置から見て、元の位置まで
 *   どれだけ戻せばよいか」(= before − after) を列 id ごとに返す。動かない列は含めない
 *   (アニメーション対象を最小にしてコストを抑える)。
 *
 * DOM の計測・アニメーションの再生は `ResultGrid.tsx` 側が行い、ここは値の計算だけを
 * 受け持つ。
 */

/**
 * `base` (現在の列 id 順) で `fromId` の列を `toId` の列の手前へ動かした新しい順序を
 * 返す。動かない (同じ列 / どちらかが見つからない) ときは `null`。
 */
export function reorderColumnIds(base: readonly string[], fromId: string, toId: string): string[] | null {
  if (fromId === toId) return null;
  const next = base.slice();
  const fromIdx = next.indexOf(fromId);
  if (fromIdx < 0) return null;
  const [moved] = next.splice(fromIdx, 1);
  const insertAt = next.indexOf(toId);
  if (insertAt < 0) return null;
  next.splice(insertAt, 0, moved);
  return next;
}

/**
 * 並べ替え前後の列位置 (列 id → 左端 x 座標, px) から、各列を元の位置へ戻すための
 * 横オフセット (before − after) を求める。
 *
 * - 前後どちらかにしか無い列 (列仮想化で出入りした列など) は対象外。
 * - `|offset| < minDelta` の列は動いていないとみなして含めない (サブピクセルの
 *   丸め誤差でアニメーションを起こさない)。
 * - 有限でない値 (NaN など) は無視する。
 */
export function computeFlipOffsets(
  before: ReadonlyMap<string, number>,
  after: ReadonlyMap<string, number>,
  minDelta = 0.5,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const [id, prev] of before) {
    const next = after.get(id);
    if (next === undefined || !Number.isFinite(prev) || !Number.isFinite(next)) continue;
    const dx = prev - next;
    if (Math.abs(dx) >= minDelta) out.set(id, dx);
  }
  return out;
}

/** セル参照キー (`"<行 index>:<列 index>"`) から列 id (`String(列 index)`) を取り出す。 */
export function columnIdFromCellKey(key: string): string | null {
  const sep = key.lastIndexOf(":");
  if (sep < 0 || sep === key.length - 1) return null;
  return key.slice(sep + 1);
}
