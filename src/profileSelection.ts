// 接続プロファイル行の複数選択 (#1630)。テーブルの複数選択 (#1399, `tableSelection.ts`) と同じ操作
// モデル: Ctrl/Cmd+クリックで出し入れ、Shift+クリックで範囲、修飾なしは選択の解除。純関数のみで、
// 状態の保持は `ConnectionList` が行う。

export interface ProfileSelection {
  /** 選択中のプロファイル id。 */
  readonly ids: ReadonlySet<string>;
  /** Shift 範囲選択の起点 (最後に出し入れした行)。 */
  readonly anchor: string | null;
}

export const EMPTY_PROFILE_SELECTION: ProfileSelection = { ids: new Set(), anchor: null };

export function profileSelectionSize(sel: ProfileSelection): number {
  return sel.ids.size;
}

export function isProfileSelected(sel: ProfileSelection, id: string): boolean {
  return sel.ids.has(id);
}

/** Ctrl/Cmd+クリック: `id` を選択に出し入れし、起点にする。 */
export function toggleProfileSelection(sel: ProfileSelection, id: string): ProfileSelection {
  const ids = new Set(sel.ids);
  if (ids.has(id)) ids.delete(id);
  else ids.add(id);
  return { ids, anchor: id };
}

/**
 * Shift+クリック: 起点から `id` までを (表示順 `orderedIds` で) 選択する。起点が無い / 表示に無いときは
 * `id` 単独を選んで起点にする。`additive` (Ctrl 併用) なら既存の選択に加え、そうでなければ置き換える。
 */
export function rangeProfileSelection(
  sel: ProfileSelection,
  orderedIds: readonly string[],
  id: string,
  additive = false,
): ProfileSelection {
  const to = orderedIds.indexOf(id);
  const from = sel.anchor === null ? -1 : orderedIds.indexOf(sel.anchor);
  if (to < 0) return sel;
  if (from < 0) return { ids: new Set([id]), anchor: id };
  const [lo, hi] = from <= to ? [from, to] : [to, from];
  const ids = new Set(additive ? sel.ids : []);
  for (let i = lo; i <= hi; i++) ids.add(orderedIds[i]);
  // 起点は動かさない (続けて Shift+クリックしても同じ起点から範囲を取り直せる)。
  return { ids, anchor: sel.anchor };
}

/** 存在しなくなったプロファイル (削除・絞り込みで消えた行) を選択から外す。 */
export function pruneProfileSelection(
  sel: ProfileSelection,
  existingIds: Iterable<string>,
): ProfileSelection {
  if (sel.ids.size === 0) return sel;
  const live = new Set(existingIds);
  const ids = new Set([...sel.ids].filter((id) => live.has(id)));
  if (ids.size === sel.ids.size) return sel;
  return { ids, anchor: sel.anchor !== null && live.has(sel.anchor) ? sel.anchor : null };
}

/** 表示順に並べた選択中の id。 */
export function orderedSelectedProfileIds(sel: ProfileSelection, orderedIds: readonly string[]): string[] {
  return orderedIds.filter((id) => sel.ids.has(id));
}
