/**
 * 結果グリッドのツールバーを「幅に応じて副次操作を「…」メニューへ畳む」ための
 * 純ロジック (#1270)。
 *
 * ツールバーのボタンが増えて 1280px 幅で右端が切れていたため、頻度の低い操作から順に
 * オーバーフローメニューへ畳む。どこまで畳むかは実測幅 (`scrollWidth` / `clientWidth`)
 * から決める — 文言の長さ・フォント拡大・表示密度・他の要素 (編集バー / 検索欄) の
 * 幅は実行時にしか分からないため、固定のブレークポイントでは崩れる。
 *
 * DOM には触れない。コンポーネント側が測った数値を渡し、返ってきた「畳む個数」を
 * state に反映する。
 */

/**
 * 畳める操作の ID。**ツールバー上の並び順 = 畳みにくい順** で、右にあるものほど先に
 * 畳まれる (Export と表示切替は常時表示なのでここに含めない)。
 */
export const COLLAPSIBLE_TOOLBAR_ACTIONS = [
  "saveAsTable",
  "saveAsView",
  "registerLocal",
  "transfer",
  "aiSummary",
  "autoRefresh",
] as const;

export type CollapsibleToolbarAction = (typeof COLLAPSIBLE_TOOLBAR_ACTIONS)[number];

/** 実測誤差 (サブピクセル丸め) を無視する幅 (CSS px)。 */
const OVERFLOW_EPSILON = 1;
/** 展開に必要な余白の上乗せ。展開 ⇄ 折りたたみの往復 (ちらつき) を防ぐ。 */
const EXPAND_MARGIN = 8;

/** 表示中の操作 (ツールバー順) を、残す分と畳む分に分ける。畳むのは末尾から `count` 個。 */
export function splitCollapsed<T>(
  present: readonly T[],
  count: number,
): { visible: T[]; collapsed: T[] } {
  const n = Math.max(0, Math.min(present.length, Math.floor(count)));
  const cut = present.length - n;
  return { visible: present.slice(0, cut), collapsed: present.slice(cut) };
}

export interface OverflowMeasure {
  /** 現在畳んでいる個数。 */
  collapsed: number;
  /** 畳める操作の総数 (存在するもののみ)。 */
  total: number;
  /** ツールバーの `clientWidth`。 */
  clientWidth: number;
  /** ツールバーの `scrollWidth` (中身の全幅)。 */
  scrollWidth: number;
  /**
   * 次に展開する (畳んだ中で最も左の) 操作の、直近に表示されていたときの幅
   * (gap 込み)。未計測なら `null` で、その場合は展開しない。
   */
  nextExpandWidth: number | null;
}

/**
 * 測定結果から、次に畳む個数を返す。はみ出していれば 1 つ増やし、余白が十分
 * (次に展開する操作の幅 + 余裕) あれば 1 つ減らす。1 回の呼び出しで動くのは 1 段で、
 * 呼び出し側が再測定を繰り返すことで収束する。
 */
export function nextCollapsedCount(m: OverflowMeasure): number {
  const overflow = m.scrollWidth - m.clientWidth;
  if (overflow > OVERFLOW_EPSILON) {
    return Math.min(m.total, m.collapsed + 1);
  }
  if (
    m.collapsed > 0 &&
    m.nextExpandWidth != null &&
    -overflow >= m.nextExpandWidth + EXPAND_MARGIN
  ) {
    return m.collapsed - 1;
  }
  return m.collapsed;
}
