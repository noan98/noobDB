/**
 * 接続リスト (`ConnectionList`) のドラッグ & キーボード並べ替え (#786) が共有する
 * 純ロジック。副作用なし (DOM / localStorage / IPC に触れない) なので Vitest で
 * 単体テストできる。`TabBar` の並べ替え (`tabReorder.ts`) と同じ設計方針 — 真の
 * 順列だけを受け付ける permutation ガード + 端で止まる delta 移動 — を、接続
 * ツリーの 2 段構造 (グループ ⊇ プロファイル) 向けに拡張したもの。
 *
 * 永続化のレイヤ分け:
 * - **プロファイルの並び順**は `profiles.json` の配列順そのもの (バックエンドの
 *   `reorder_profiles` コマンドで書き換える)。フロントの `profiles` state の順序が
 *   そのまま真実になるので、ここでの計算結果はその配列の新しい順列として渡す。
 * - **グループ (見出し) の並び順**は、グループという実体がバックエンドに存在しない
 *   ため `ConnectionList` が localStorage へ永続化する (折りたたみ状態
 *   `COLLAPSED_GROUPS_KEY` と同じ方式)。触られていないグループ名は
 *   `applyGroupOrder` がアルファベット順 (= 変更前の既定挙動) に並べる。
 */

/**
 * `proposed` が `current` の**真の順列**かを検証し、順列なら `proposed` を、
 * そうでなければ `null` を返す。ドラッグ (Motion の `Reorder.Group` の
 * `onReorder`) が要素の欠落・重複・混入を起こしていないことを保証する
 * (`tabReorder.reorderIfPermutation` と同じ不変条件)。プロファイル ID 列にも
 * グループ名列にも使う。
 */
export function reorderIfPermutation(current: string[], proposed: string[]): string[] | null {
  if (proposed.length !== current.length) return null;
  const cur = new Set(current);
  const next = new Set(proposed);
  if (next.size !== current.length) return null;
  if (!proposed.every((id) => cur.has(id))) return null;
  if (!current.every((id) => next.has(id))) return null;
  return proposed;
}

/**
 * `id` を `delta` 個ずらした新しい配列を返す (キーボード並べ替え用)。移動先が
 * 範囲外になる場合は入力をそのまま (同じ参照で) 返す — 端で止まり、循環しない。
 * `id` が `order` に無いときも入力をそのまま返す。元の配列は破壊しない。
 */
export function moveItemBy(order: string[], id: string, delta: number): string[] {
  const from = order.indexOf(id);
  if (from < 0) return order;
  const to = from + Math.trunc(delta);
  if (to < 0 || to >= order.length) return order;
  const next = order.slice();
  next.splice(from, 1);
  next.splice(to, 0, id);
  return next;
}

/**
 * `order` のうち `subOrder` に含まれる id だけを、その相対順序を `subOrder` の
 * 並びに置き換える (それ以外の id は元の絶対位置のまま動かさない)。グループ 1 つ
 * 分の members だけで計算した新しい相対順序を、プロファイル全体のフラットな並び
 * 順へ埋め戻すのに使う (ドラッグ/キーボードいずれの経路でも共通)。
 *
 * `subOrder` が「`order` 内に現れる同じ id 集合の真の順列」でない場合 (重複・
 * 混入・`order` 側の該当件数と不一致) は、埋め戻さず `order` をそのまま
 * (同じ参照で) 返す。実際に位置が変わらない場合 (全員が既に `subOrder` の位置に
 * いる) も同じ参照を返す。
 */
export function applySubsequenceOrder(order: string[], subOrder: string[]): string[] {
  const subSet = new Set(subOrder);
  if (subSet.size !== subOrder.length) return order; // subOrder 内の重複
  let matched = 0;
  for (const id of order) if (subSet.has(id)) matched++;
  if (matched !== subOrder.length) return order; // 混入 or 件数不一致
  if (subOrder.length === 0) return order;
  let cursor = 0;
  let changed = false;
  const next = order.map((id) => {
    if (!subSet.has(id)) return id;
    const replacement = subOrder[cursor++];
    if (replacement !== id) changed = true;
    return replacement;
  });
  return changed ? next : order;
}

/**
 * グループの表示順序を計算する。永続化済みの `stored` を土台に、現在実在する
 * グループ名 `names` を並べる:
 * - `stored` に含まれる既知の名前は、その相対順序を保ったまま先頭側に並ぶ。
 * - `stored` に無い新規グループ名 (今まで触られていない = 常にアルファベット順
 *   という既存の既定挙動) はアルファベット順で末尾に追加する。
 * - `stored` にあるが `names` に無い名前 (グループが空になった等) は無視する。
 *
 * 返り値は常に `names` の真の順列 (件数・要素とも一致)。
 */
export function applyGroupOrder(names: string[], stored: string[]): string[] {
  const nameSet = new Set(names);
  const known = stored.filter((n) => nameSet.has(n));
  const knownSet = new Set(known);
  const rest = names.filter((n) => !knownSet.has(n)).sort((a, b) => a.localeCompare(b));
  return [...known, ...rest];
}
