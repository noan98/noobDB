/**
 * 履歴一覧の複数選択 (#1627) の純ロジック。Shift クリックで範囲、Ctrl / Cmd クリックで 1 行の
 * 追加・解除を行い、選んだ行をまとめて削除する。通常のクリック (復元) とは修飾キーで分ける。
 */

export interface HistorySelection {
  selected: ReadonlySet<number>;
  /** 範囲選択の起点になる行 (最後に修飾キー付きで押した行)。 */
  anchor: number | null;
}

export const EMPTY_HISTORY_SELECTION: HistorySelection = { selected: new Set(), anchor: null };

/**
 * `id` の行を押したときの次の選択。`order` は画面に出ている行の id (表示順)。
 * - `toggle` (Ctrl / Cmd): その行の選択を入れ替え、起点にする。
 * - `range` (Shift): 起点から `id` までを選択に加える。起点が無い・画面に無いときは `id` だけを選んで起点にする。
 */
export function selectHistoryRow(
  order: readonly number[],
  state: HistorySelection,
  id: number,
  mode: "range" | "toggle",
): HistorySelection {
  const next = new Set(state.selected);
  if (mode === "toggle") {
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return { selected: next, anchor: id };
  }
  const a = state.anchor === null ? -1 : order.indexOf(state.anchor);
  const b = order.indexOf(id);
  if (a < 0 || b < 0) {
    next.add(id);
    return { selected: next, anchor: id };
  }
  const [lo, hi] = a < b ? [a, b] : [b, a];
  for (let i = lo; i <= hi; i += 1) next.add(order[i]);
  return { selected: next, anchor: state.anchor };
}

/** 画面から消えた行 (絞り込みの変更・再読み込み) を選択から外す。変化が無ければ同じ参照を返す。 */
export function pruneHistorySelection(state: HistorySelection, order: readonly number[]): HistorySelection {
  if (state.selected.size === 0) return state;
  const visible = new Set(order);
  const kept = [...state.selected].filter((id) => visible.has(id));
  if (kept.length === state.selected.size) return state;
  return {
    selected: new Set(kept),
    anchor: state.anchor !== null && visible.has(state.anchor) ? state.anchor : null,
  };
}
