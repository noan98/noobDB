import { useLayoutEffect, useRef, type RefObject } from "react";
import { useReducedMotionConfig } from "motion/react";
import { durations, easings, firstBatchReveal } from "../motion";
import { firstBatchRevealCount, firstBatchRevealDelayMs, isFirstBatchArrival } from "./firstBatchReveal";

/** ハイコントラスト (テーマ hc-* / forced-colors) か。装飾的な動きは出さない。 */
function prefersStaticMotion(): boolean {
  if (typeof document === "undefined") return false;
  if (document.documentElement.getAttribute("data-theme")?.startsWith("hc-")) return true;
  return typeof window.matchMedia === "function" && window.matchMedia("(forced-colors: active)").matches;
}

/**
 * 結果グリッドの初回バッチ着弾リビール (#1579)。ストリーミング中のスケルトン
 * (`skeleton && rowCount === 0`) の次のコミットで行が現れたとき、`<tbody>` 直下の
 * 見えている行 (上限 `FIRST_BATCH_REVEAL_MAX_ROWS`、遅延は `FIRST_BATCH_REVEAL_MAX_STEPS` 段で頭打ち) の `<tr>` だけを Web Animations API で
 * 1 回 stagger フェード / slide-up する。先頭行は遅延 0 で始まるのでスケルトンの消失と
 * ほぼ同時に立ち上がり、控えめなクロスフェードに見える。
 *
 * ## `motion.ts` の「per-row FLIP は重いので避ける」との関係
 * 本件は FLIP (行ごとの位置計測 → 差分アニメ) ではない。(1) 入場 1 回限り
 * (追加バッチ・スクロール・ソートでは再生しない)、(2) 対象は最大 24 行 (仮想化されたグリッドで
 * 描画済みの行のうち画面内のものだけ)、(3) 計測は上端座標の 1 回読み取りのみで
 * `Element.animate` に委ねる (motion コンポーネントを行に常駐させない)。仮想スクロール中の
 * 再レンダーには一切関与せず、`fill` を残さないので終了後に inline style も残らない。
 *
 * reduced-motion (OS / `data-motion="reduced"` は `useReducedMotionConfig` に反映) とハイコントラストは
 * 即時表示 (何も再生しない)。`Element.animate` が無い環境 (jsdom) でも何もしない。
 */
export function useFirstBatchReveal(
  tbodyRef: RefObject<HTMLTableSectionElement | null>,
  scrollRef: RefObject<HTMLElement | null> | undefined,
  skeleton: boolean,
  rowCount: number,
): void {
  const reduced = useReducedMotionConfig();
  const prevSkeletonRef = useRef(false);
  const runningRef = useRef<Animation[]>([]);

  // 依存配列なし: 毎コミット走るが、真偽値の比較だけ (再生は着弾の 1 コミットのみ)。
  useLayoutEffect(() => {
    const prevSkeleton = prevSkeletonRef.current;
    prevSkeletonRef.current = skeleton && rowCount === 0;
    if (!isFirstBatchArrival(prevSkeleton, rowCount)) return;
    if (reduced || prefersStaticMotion()) return;
    const tbody = tbodyRef.current;
    if (!tbody || typeof tbody.animate !== "function") return;
    const trs = Array.from(tbody.querySelectorAll<HTMLElement>(":scope > tr[role='row']"));
    if (trs.length === 0) return;
    const viewportBottom = (scrollRef?.current ?? tbody).getBoundingClientRect().bottom;
    const count = firstBatchRevealCount(
      trs.map((tr) => tr.getBoundingClientRect().top),
      viewportBottom,
    );
    for (const a of runningRef.current) a.cancel();
    runningRef.current = trs.slice(0, count).map((tr, i) =>
      tr.animate(
        [
          { opacity: 0, transform: `translateY(${firstBatchReveal.offsetY}px)` },
          { opacity: 1, transform: "translateY(0)" },
        ],
        {
          duration: durations.base * 1000,
          delay: firstBatchRevealDelayMs(i),
          easing: `cubic-bezier(${easings.out.join(", ")})`,
          // 遅延中も初期フレーム (透明) を保つ。終了後は何も残さない。
          fill: "backwards",
        },
      ),
    );
  });

  // アンマウント時に再生中のものを止める。
  useLayoutEffect(
    () => () => {
      for (const a of runningRef.current) a.cancel();
    },
    [],
  );
}
