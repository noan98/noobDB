import { durations, easings, firstBatchReveal } from "../motion";
import { firstBatchRevealDelayMs } from "./firstBatchReveal";

/**
 * JSON ツリーの展開リビール (#1863) の純ロジック。再生は `useJsonTreeReveal.ts`。
 *
 * 展開 / 一括展開で新しく DOM に現れた行のうち、**スクロール領域の可視範囲に入るものだけ**を
 * 抽出する。行は文書順 = 画面上の並び順なので、上端がビューポート下端に達した時点で打ち切る
 * (画面外の行は計測もアニメーションもしない)。
 */
export interface RevealRect {
  top: number;
  bottom: number;
}

/**
 * `items` (文書順) のうち `viewport` と縦に重なるものを返す。`rectOf` は呼ばれた行しか
 * 読まないので、計測 (レイアウト読み取り) はビューポート下端までの行 + 1 回で済む。
 * `viewport` が未計測 (非有限 / 高さ 0 以下) なら先頭 `fallbackMax` 行だけ返す。
 */
export function visibleRevealTargets<T>(
  items: readonly T[],
  rectOf: (item: T) => RevealRect,
  viewport: RevealRect,
  fallbackMax: number,
): T[] {
  if (
    !Number.isFinite(viewport.top) ||
    !Number.isFinite(viewport.bottom) ||
    viewport.bottom - viewport.top <= 0
  ) {
    return items.slice(0, fallbackMax);
  }
  const out: T[] = [];
  for (const item of items) {
    const r = rectOf(item);
    if (r.top >= viewport.bottom) break;
    if (r.bottom <= viewport.top) continue;
    out.push(item);
  }
  return out;
}

/** `index` 番目 (0 始まり) の行に付ける WAAPI のキーフレームとオプション。遅延は 12 段で頭打ち。 */
export function jsonTreeRevealAnimation(index: number): {
  keyframes: Keyframe[];
  options: KeyframeAnimationOptions;
} {
  return {
    keyframes: [
      { opacity: 0, transform: `translateY(${firstBatchReveal.offsetY}px)` },
      { opacity: 1, transform: "translateY(0)" },
    ],
    options: {
      duration: durations.quick * 1000,
      delay: firstBatchRevealDelayMs(index),
      easing: `cubic-bezier(${easings.out.join(", ")})`,
      // 遅延中も初期フレーム (透明) を保つ。終了後は inline style を残さない。
      fill: "backwards",
    },
  };
}
