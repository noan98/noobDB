import { chakra } from "@chakra-ui/react";
import { useReducedMotionConfig } from "motion/react";
import { useLayoutEffect, useRef, type ComponentProps } from "react";

import { durations, easings, firstBatchReveal } from "../motion";
import {
  FIRST_BATCH_REVEAL_FALLBACK_ROWS,
  firstBatchRevealCount,
  firstBatchRevealDelayMs,
} from "./firstBatchReveal";
import { prefersStaticMotion } from "./revealOrigin";
import { revealViewportBottom } from "./rowsMountReveal";

/**
 * 読み取り専用メタデータパネルの `<tbody>` (#1886)。マウントされたコミットの 1 回だけ、
 * 画面内の行 (遅延は `FIRST_BATCH_REVEAL_MAX_STEPS` 段で頭打ち) をスタッガーでフェード / slide-up する。
 *
 * スケルトン (`SkeletonTableRows`) の `<tbody>` とは要素の型が違う (`RevealTbody` と素の `tbody`)
 * ので、React が作り直して「スケルトン → 実データ」の差し替えでだけ再生される。再フェッチ・フィルタ・ソートは同じ
 * 要素の再レンダーなので即時のまま (新規パターンは持たない)。再生は結果グリッドの
 * `useFirstBatchReveal` (#1579) と同じ Web Animations API で、行ごとの計測は上端座標の読み取りのみ、
 * `fill: "backwards"` で終了後に inline style を残さない。reduced-motion (`useReducedMotionConfig`) と
 * ハイコントラストは何も再生しない。`Element.animate` が無い環境 (jsdom) でも何もしない。
 */
export function RevealTbody(props: ComponentProps<typeof chakra.tbody>) {
  const ref = useRef<HTMLTableSectionElement>(null);
  const reduced = useReducedMotionConfig();
  // マウント時の 1 回だけ。reduced の変化では再生し直さない。
  // biome-ignore lint/correctness/useExhaustiveDependencies: マウント 1 回の再生
  useLayoutEffect(() => {
    const tbody = ref.current;
    if (!tbody || reduced || prefersStaticMotion() || typeof tbody.animate !== "function") return;
    const trs = Array.from(tbody.querySelectorAll<HTMLElement>(":scope > tr")).filter(
      (tr) => tr.getAttribute("aria-hidden") !== "true",
    );
    if (trs.length === 0) return;
    const bottom = revealViewportBottom(tbody, (el) => getComputedStyle(el).overflowY, window.innerHeight);
    // 高さ無制限の祖先しか無い場合の保険として、行数にも上限をかける。
    const count = Math.min(
      firstBatchRevealCount(trs.length, (i) => trs[i].getBoundingClientRect().top, bottom),
      FIRST_BATCH_REVEAL_FALLBACK_ROWS,
    );
    const started = trs.slice(0, count).map((tr, i) =>
      tr.animate(
        [
          { opacity: 0, transform: `translateY(${firstBatchReveal.offsetY}px)` },
          { opacity: 1, transform: "translateY(0)" },
        ],
        {
          duration: durations.base * 1000,
          delay: firstBatchRevealDelayMs(i),
          easing: `cubic-bezier(${easings.out.join(", ")})`,
          fill: "backwards",
        },
      ),
    );
    return () => {
      for (const a of started) a.cancel();
    };
  }, []);
  return <chakra.tbody ref={ref} {...props} />;
}
