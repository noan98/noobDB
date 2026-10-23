/** サイドバータブ切替の中身スライドの向き (純ロジック、#1830)。 */

import { directionalSlide } from "../motion";

/** スライドの向き。`directionalSlide` の `custom` と同じ符号 (正 = 右から入る)。 */
export type SlideDirection = -1 | 0 | 1;

/**
 * タブの並び順から、滑るインジケータと同じ向きを返す。右のタブへ移るとインジケータは
 * 右へ滑るので、中身は右から入る (+1)。左へ移るなら左から入る (-1)。同じタブ・並びに
 * 無いタブは 0 (x 移動なしのフェード)。
 */
export function sidebarSlideDirection<T>(order: readonly T[], from: T, to: T): SlideDirection {
  const a = order.indexOf(from);
  const b = order.indexOf(to);
  if (a < 0 || b < 0 || a === b) return 0;
  return b > a ? 1 : -1;
}

/**
 * アクティブ化時のアニメーション目標。キーフレームで開始値を明示するので、直前に
 * 非表示だった間の値 (前回の向き) に依らず、今回の向きから入る。
 */
export function sidebarSlideAnimate(dir: SlideDirection) {
  const from = directionalSlide.initial(dir);
  return { opacity: [from.opacity, 1], x: [from.x, 0] };
}

/** 入場前の見た目 (新規マウント時の initial、非アクティブ時の目標)。 */
export function sidebarSlideHidden(dir: SlideDirection) {
  return directionalSlide.initial(dir);
}
