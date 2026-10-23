/** サイドバータブ切替の中身スライドの向き (純ロジック、#1830)。 */

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
