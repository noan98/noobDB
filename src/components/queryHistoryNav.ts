// クエリエディタの ↑/↓ 履歴ナビゲーションの純粋ロジック。
//
// bash のコマンド履歴に倣い、「最新位置 (= ユーザが編集中の下書き)」を起点に、↑ で
// 古い履歴へ、↓ で新しい履歴へたどる。最新位置に戻ると下書きを復元する。CodeMirror
// など DOM に依存しないようここを純粋関数として切り出し、Vitest で挙動を固定する。

/** ナビゲーション状態。`index` は履歴配列 (最新が先頭) のインデックス。 */
export interface HistoryNavState {
  /** 履歴上の位置。0 = 最新の実行クエリ。-1 = ナビゲーションしていない (下書き表示中)。 */
  index: number;
  /**
   * ナビゲーション開始時にエディタにあったユーザの編集内容。最新位置 (`index === -1`)
   * へ戻ったときに復元する。ナビゲーション中でないときは null。
   */
  draft: string | null;
}

export const initialHistoryNav: HistoryNavState = { index: -1, draft: null };

export interface HistoryNavResult {
  /** 遷移後のナビゲーション状態。 */
  state: HistoryNavState;
  /** エディタに流し込むテキスト。 */
  text: string;
  /**
   * 流し込み後のカーソル位置。古い方向 (↑) は先頭に置き、続けて ↑ で 1 行目から
   * さらに古い履歴へたどれるようにする。新しい方向 (↓) は末尾に置き、続けて ↓ で
   * 末尾行から新しい履歴へたどれるようにする。
   */
  cursor: "start" | "end";
}

/**
 * ↑ (古い履歴へ)。`history` は最新が先頭の実行クエリ列、`currentText` はエディタの
 * 現在内容、`state` は現在のナビゲーション状態。ナビゲーションすべきでない場合
 * (履歴が空) は null を返し、呼び出し側はキーをそのまま通常のカーソル移動に委ねる。
 */
export function navigateOlder(
  history: string[],
  currentText: string,
  state: HistoryNavState,
): HistoryNavResult | null {
  if (history.length === 0) return null;

  // 未ナビゲーションなら、現在の編集内容を下書きとして退避してから最新へ。
  if (state.index === -1) {
    return {
      state: { index: 0, draft: currentText },
      text: history[0],
      cursor: "start",
    };
  }

  // 最古を超えない範囲で 1 つ古い方へ。最古で更に ↑ してもキーは消費し (text を
  // 再設定してカーソルを 1 行目に保つ)、カーソルがエディタ外へ逃げないようにする。
  const nextIndex = Math.min(state.index + 1, history.length - 1);
  return {
    state: { index: nextIndex, draft: state.draft },
    text: history[nextIndex],
    cursor: "start",
  };
}

/**
 * ↓ (新しい履歴へ)。未ナビゲーション (`index === -1`) のときは null を返し、通常の
 * カーソル移動に委ねる。最新位置を超えて戻るときは退避していた下書きを復元する。
 */
export function navigateNewer(
  history: string[],
  state: HistoryNavState,
): HistoryNavResult | null {
  if (state.index === -1) return null;

  const nextIndex = state.index - 1;
  // 最新位置へ復帰、または (navigateOlder と対称に) ナビゲーション中に履歴が縮んで
  // (履歴クリア等) 配列が空になった場合は、下書きを戻してナビゲーション状態をリセット
  // する。ここで history.length === 0 もガードしないと、後段の `history[nextIndex]`
  // が undefined になりエディタへ空/undefined テキストが流し込まれてしまう。
  if (nextIndex < 0 || history.length === 0) {
    return {
      state: initialHistoryNav,
      text: state.draft ?? "",
      cursor: "end",
    };
  }
  // 履歴が縮んでナビゲーション位置が範囲外になっていても安全なようクランプする
  // (navigateOlder の最古クランプと対称)。
  const clampedIndex = Math.min(nextIndex, history.length - 1);
  return {
    state: { index: clampedIndex, draft: state.draft },
    text: history[clampedIndex],
    cursor: "end",
  };
}
