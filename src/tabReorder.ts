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
