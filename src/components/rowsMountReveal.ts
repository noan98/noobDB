/**
 * 読み取り専用メタデータパネル (構造 / 統計 / アドバイザ / サーバ情報 / インスペクタ) の
 * 「初回ロード行リビール」(#1886) の純ロジック。再生は `RevealTbody.tsx`。
 *
 * 段数の上限・遅延・可視行の数え方は結果グリッドの初回バッチ着弾リビール (#1579) と同じ
 * `firstBatchReveal.ts` を共有する。ここはスクロール領域の下端を求める部分だけを持つ。
 */

/**
 * 行の見える範囲の下端。overflowY が visible 以外の祖先すべての下端と window の高さの最小値。
 * 横スクロール専用の `overflowX="auto"` ラッパーは CSS 仕様で overflowY も auto になり、
 * 高さ無制限のため最も近い祖先だけを見ると全行が対象になってしまうので、最後まで辿る。
 */
export function revealViewportBottom(
  start: Element,
  overflowYOf: (el: Element) => string,
  windowHeight: number,
): number {
  let bottom = windowHeight;
  for (let el: Element | null = start.parentElement; el; el = el.parentElement) {
    if (overflowYOf(el) === "visible") continue;
    bottom = Math.min(bottom, el.getBoundingClientRect().bottom);
  }
  return bottom;
}
