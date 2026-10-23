// キーボード / プログラム駆動の「選択への追従スクロール」を滑らかにする (#1832)。
// 矢印キーや Ctrl+Tab で画面外の候補・タブへ選択が飛ぶと、`scrollIntoView` の既定
// (instant) ではビューポートがテレポートし「隣へ移った」空間的手がかりが失われる。
// 手動の矢印送り (`scrollBy({ behavior: "smooth" })`) と動きを揃えるため smooth にし、
// reduced-motion (OS / アプリ設定 #787) のときだけ即時に落とす。

import { reducedMotionActive } from "./focusLandingPulse";

/** 追従スクロールの behavior。reduced-motion では "auto" (即時)。 */
export function followScrollBehavior(): ScrollBehavior {
  return reducedMotionActive() ? "auto" : "smooth";
}

/**
 * `el` を可視範囲へ追従スクロールする。既定は最小移動 (`nearest`)。
 * ドラッグ中・ページ全体など即時であるべきスクロールには使わない。
 */
export function scrollFollowIntoView(
  el: Element | null | undefined,
  options: Pick<ScrollIntoViewOptions, "block" | "inline"> = { block: "nearest" },
): void {
  el?.scrollIntoView?.({ ...options, behavior: followScrollBehavior() });
}
