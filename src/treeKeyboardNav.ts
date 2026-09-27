/**
 * スキーマツリー (`ConnectionList`) の矢印キー左右 (展開/折りたたみ ⇔ 親/子移動) を
 * 判定する純関数 (#1184)。DOM を持たないので Vitest (jsdom 無し) でも検証できる。
 *
 * WAI-ARIA Authoring Practices の Tree パターンにならい、ArrowRight/ArrowLeft は
 * 「展開できるノードでの開閉」と「フォーカス移動」の 2 通りの結果を持つ:
 *
 * - ArrowRight: 折りたたみ中の展開可能ノードなら開く (`toggle`)。既に開いていれば
 *   最初の子へフォーカスを移す (`move`)。子が無い/展開不可なノードでは何もしない。
 * - ArrowLeft: 展開中の展開可能ノードなら閉じる (`toggle`)。折りたたみ中または
 *   展開不可 (葉) のノードでは、直近の祖先 (自分より `level` が小さい直前の行) へ
 *   フォーカスを移す (`move`)。ルート直下の項目のように祖先が無ければ何もしない。
 *
 * `rows` は「現在 DOM 上に見えている treeitem を上から並べた配列」を渡す。折りたたみ
 * 済みのノードの子は `TreeCollapse` がそもそもマウントしないため、呼び出し側は
 * `[role=treeitem]` を `querySelectorAll` した結果をそのまま渡せばよい (非表示行が
 * 混ざる心配をしなくてよい)。
 */

/** 1 行ぶんの、矢印キー判定に必要な最小限の情報。 */
export interface TreeNavRow {
  /** WAI-ARIA の `aria-level` に対応する深さ (ルート直下が 1)。 */
  level: number;
  /** 展開/折りたたみを持つノードか (`aria-expanded` を持つか)。 */
  expandable: boolean;
  /** `expandable` なノードが現在展開中か。 */
  open: boolean;
}

/** 矢印キーの判定結果。 */
export type TreeArrowResult =
  | { type: "toggle" }
  | { type: "move"; index: number }
  | null;

/** ArrowRight の判定 (`index` は `rows`内での現在フォーカス行の位置)。 */
export function resolveTreeArrowRight(rows: readonly TreeNavRow[], index: number): TreeArrowResult {
  const row = rows[index];
  if (!row || !row.expandable) return null;
  if (!row.open) return { type: "toggle" };
  const next = rows[index + 1];
  if (next && next.level > row.level) return { type: "move", index: index + 1 };
  return null;
}

/** ArrowLeft の判定 (`index` は `rows`内での現在フォーカス行の位置)。 */
export function resolveTreeArrowLeft(rows: readonly TreeNavRow[], index: number): TreeArrowResult {
  const row = rows[index];
  if (!row) return null;
  if (row.expandable && row.open) return { type: "toggle" };
  for (let i = index - 1; i >= 0; i--) {
    if (rows[i].level < row.level) return { type: "move", index: i };
  }
  return null;
}
