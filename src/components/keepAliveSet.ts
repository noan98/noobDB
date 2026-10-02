/**
 * keep-alive (非アクティブな中身を破棄せず `hidden` で保持する) の保持集合の純ロジック
 * (#1311)。描画は `KeepAlive.tsx` が担い、ここは「どのキーを何個まで残すか」だけを決める。
 *
 * 保持するキーは**最近使った順** (末尾が最新) の配列で持つ。上限を超えたら先頭
 * (= 最も長く使われていないもの) から捨てる。アクティブなキーは常に末尾へ来るので
 * 捨てられない。
 */

/**
 * `active` を最新として保持集合を更新する。変化が無ければ同じ配列を返す
 * (レンダー中の `setState` が無限ループにならないよう、参照で比較できるようにする)。
 *
 * - `active` が null なら何も変えない (全部非アクティブ = 保持だけ続ける)。
 * - `limit` は 1 以上に丸める。
 */
export function touchKeepAlive(
  keys: readonly string[],
  active: string | null,
  limit: number,
): readonly string[] {
  if (active === null) return keys;
  const max = Math.max(1, Math.floor(limit));
  if (keys[keys.length - 1] === active && keys.length <= max) return keys;
  const next = keys.filter((k) => k !== active);
  next.push(active);
  return next.length > max ? next.slice(next.length - max) : next;
}

/** 結果グリッド (ResultGrid) を非表示のまま保持するタブ数の上限 (MRU, #1309)。 */
export const GRID_KEEP_ALIVE_LIMIT = 4;
