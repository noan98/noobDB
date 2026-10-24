// キーボード / プログラム駆動の「選択への追従スクロール」を滑らかにする (#1832)。
// 矢印キーや Ctrl+Tab で画面外の候補・タブへ選択が飛ぶと、`scrollIntoView` の既定
// (instant) ではビューポートがテレポートし「隣へ移った」空間的手がかりが失われる。
// 手動の矢印送り (`scrollBy({ behavior: "smooth" })`) と動きを揃えるため smooth にし、
// 次の場合は即時 (auto) に落とす。
// - reduced-motion (OS / アプリ設定 #787)
// - 連続入力中 (キー押しっぱなし・連打): smooth が追いつかず選択行が画面外へ出るため、
//   前回呼び出しから RAPID_MS 以内の再呼び出しは即時にする (最初の 1 回だけ smooth)。
// - 呼び出し側が `instant` を指定したとき (開いた直後の初期位置合わせ、マウント直後など)。

import { reducedMotionActive } from "../motion";

/** この時間以内の再呼び出しは連続入力とみなして即時にする (ms)。 */
const RAPID_MS = 200;

let lastCall = Number.NEGATIVE_INFINITY;

/** 追従スクロールの behavior。reduced-motion・連続入力では "auto" (即時)。呼ぶたびに連続入力判定を更新する。 */
export function followScrollBehavior(instant = false): ScrollBehavior {
  const now = performance.now();
  const rapid = now - lastCall < RAPID_MS;
  lastCall = now;
  return instant || rapid || reducedMotionActive() ? "auto" : "smooth";
}

/**
 * `el` を可視範囲へ追従スクロールする。既定は最小移動 (`nearest`)。
 * ドラッグ中・ページ全体など即時であるべきスクロールには使わない。
 */
export function scrollFollowIntoView(
  el: Element | null | undefined,
  options: Pick<ScrollIntoViewOptions, "block" | "inline"> & { instant?: boolean } = { block: "nearest" },
): void {
  if (!el) return;
  const { instant, ...rest } = options;
  el.scrollIntoView?.({ ...rest, behavior: followScrollBehavior(instant) });
}
