/**
 * トーストのスタック上限 (#1501)。連続発火で画面を覆わないよう、同時に見せる数に上限を設け、
 * 超過分は「他 N 件」へ畳む。履歴は `pushActivity` でアクティビティセンターに全件残るので
 * 情報は欠落しない。Toast.tsx から切り出した純ロジック。
 */

/** 同時に表示するトースト数の上限。 */
export const MAX_VISIBLE_TOASTS = 4;

export interface StackSplit<T> {
  /** 表示するトースト (元の並び順を保つ)。 */
  visible: T[];
  /** 畳んだトーストの件数。 */
  hiddenCount: number;
}

/**
 * `items` (古い順) を表示分と畳む分に分ける。新しいものを優先して残す。ただしアクション付き
 * (Undo など、#676) は押す機会を奪わないよう、通常のトーストより先に枠を確保する。
 * アクション付きだけで上限を超える場合は古い方から畳む。
 */
export function splitToastStack<T extends { action?: unknown }>(
  items: readonly T[],
  max: number = MAX_VISIBLE_TOASTS,
): StackSplit<T> {
  const limit = Math.max(1, Math.floor(max));
  if (items.length <= limit) return { visible: [...items], hiddenCount: 0 };
  const keep = new Set<number>();
  for (let i = items.length - 1; i >= 0 && keep.size < limit; i--) {
    if (items[i].action) keep.add(i);
  }
  for (let i = items.length - 1; i >= 0 && keep.size < limit; i--) {
    if (!keep.has(i)) keep.add(i);
  }
  const visible = items.filter((_, i) => keep.has(i));
  return { visible, hiddenCount: items.length - visible.length };
}
