/**
 * タブの並べ替え (#658) が共有する純ロジック。副作用なし (DOM / localStorage に
 * 触れない) なので Vitest で単体テストできる。`TabBar` のキーボード並べ替えと
 * `App` のドラッグ並べ替えコールバック (`reorderTabsInPane`) が同じ移動規則・
 * 順列ガードを使い、実装間で挙動がズレないようにする。永続化は順序を保持する
 * (`persistTabsForProfile` が `tabIds` を順序どおりに保存する) ため、ここで返した
 * 新しい順序がそのまま復元される。
 */

/**
 * `proposed` が `current` の**真の順列**かを検証し、順列なら `proposed` を、
 * そうでなければ `null` を返す。ドラッグ/外部コールバック由来の並び (Motion の
 * `Reorder.Group` の `onReorder` など) が、要素の欠落・重複・混入を起こしていない
 * ことを保証する。例えば `["a","a","b"]` のような壊れた列は、タブを 1 つ落として
 * 到達不能にするので拒否する。
 */
export function reorderIfPermutation(current: string[], proposed: string[]): string[] | null {
  if (proposed.length !== current.length) return null;
  const cur = new Set(current);
  const next = new Set(proposed);
  // 重複が無い (Set 化で長さが縮まない) かつ両集合が一致することを確認する。
  if (next.size !== current.length) return null;
  if (!proposed.every((id) => cur.has(id))) return null;
  if (!current.every((id) => next.has(id))) return null;
  return proposed;
}

/**
 * `id` を絶対インデックス `targetIndex` へ移動した新しい配列を返す。`id` が無い
 * ときは入力をそのまま返し、`targetIndex` は [0, len-1] にクランプする。元の
 * 配列は破壊しない。
 */
export function moveTabToIndex(order: string[], id: string, targetIndex: number): string[] {
  const from = order.indexOf(id);
  if (from < 0) return order;
  const to = Math.max(0, Math.min(order.length - 1, Math.trunc(targetIndex)));
  if (to === from) return order;
  const next = order.slice();
  next.splice(from, 1);
  next.splice(to, 0, id);
  return next;
}

/**
 * `id` を `delta` 個ずらした新しい配列を返す (キーボード並べ替え用)。移動先が
 * 範囲外になる場合は入力をそのまま返す (端で止まる)。`id` が無いときも入力を
 * そのまま返す。
 */
export function moveTabBy(order: string[], id: string, delta: number): string[] {
  const from = order.indexOf(id);
  if (from < 0) return order;
  const to = from + Math.trunc(delta);
  if (to < 0 || to >= order.length) return order;
  return moveTabToIndex(order, id, to);
}

/**
 * ピン留めタブ (#1486) を左端に固定した並びを返す。ピン済み同士・未ピン同士の相対順は
 * 保つ (安定パーティション)。すでに条件を満たしていれば入力の参照をそのまま返すので、
 * 呼び出し側は `next !== order` で変更有無を判定できる。
 */
export function pinnedFirst(order: string[], isPinned: (id: string) => boolean): string[] {
  const pinned = order.filter(isPinned);
  if (pinned.length === 0 || pinned.length === order.length) return order;
  const next = [...pinned, ...order.filter((id) => !isPinned(id))];
  return next.every((id, i) => id === order[i]) ? order : next;
}

/**
 * `id` のピン状態を切り替えた直後の並びを返す。ピン留めしたタブはピン群の末尾へ、解除した
 * タブは未ピン群の先頭へ移す。どちらも「`id` 以外のピン済みタブの直後」になるので、ピン留め
 * 境界のすぐ隣に置いて位置を大きく飛ばさない。`isPinned` は**切り替え前**の状態を返す関数。
 * `id` が無いときは入力をそのまま返す。
 */
export function orderAfterPinChange(
  order: string[],
  id: string,
  isPinned: (id: string) => boolean,
): string[] {
  if (!order.includes(id)) return order;
  const rest = order.filter((x) => x !== id);
  return [...rest.filter(isPinned), id, ...rest.filter((x) => !isPinned(x))];
}
