import { firstBatchRevealCount } from "./firstBatchReveal";

/**
 * 読み取り専用メタデータパネル (構造 / 統計 / アドバイザ / サーバ情報 / インスペクタ) の
 * 「初回ロード行リビール」(#1886) の純ロジック。再生は `RevealTbody.tsx`。
 *
 * 段数の上限・遅延・可視行の数え方は結果グリッドの初回バッチ着弾リビール (#1579) と同じ
 * `firstBatchReveal.ts` を共有する。ここはスクロール領域の下端を求める部分だけを持つ。
 */

/** 行の見える範囲の下端。最も近いスクロール可能な祖先 (無ければ window) の下端座標。 */
export function revealViewportBottom(
  start: Element,
  overflowYOf: (el: Element) => string,
  windowHeight: number,
): number {
  for (let el: Element | null = start.parentElement; el; el = el.parentElement) {
    const o = overflowYOf(el);
    if (o === "auto" || o === "scroll" || o === "overlay") return el.getBoundingClientRect().bottom;
  }
  return windowHeight;
}

/** リビール対象の行数 (画面内の行だけ)。`topAt(i)` は i 行目の上端座標。 */
export function rowsMountRevealCount(
  total: number,
  topAt: (index: number) => number,
  viewportBottom: number,
): number {
  return firstBatchRevealCount(total, topAt, viewportBottom);
}
