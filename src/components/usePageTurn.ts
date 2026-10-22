import { useLayoutEffect, useRef, type RefObject } from "react";
import { useReducedMotionConfig } from "motion/react";
import { durations, easings, rowCrossfadeFrom, slideOffsets } from "../motion";
import { pageTurnDirection } from "./pageTurn";

/**
 * 結果グリッドのページ送りの方向付きスライド (#1752)。
 *
 * `page` が変わったコミット直後に、`<tbody>` 要素へ opacity + translateX を
 * Web Animations API で 1 回だけ再生する。隣接ページ (±1) は送り方向から入り、
 * 先頭 / 末尾 / 任意ページへの大ジャンプは方向なしのクロスフェード。
 * 同じコミットでスクロール位置を先頭へ戻す (reduced-motion でも戻す)。
 *
 * - `useRowCrossfade` (#1416) と同じ流儀: `<tbody>` を key で作り直さない
 *   (選択・編集中バッファ・仮想化の計測を保つ) / per-row の計測や FLIP をしない /
 *   Motion のコンポーネントを常駐させず再生の瞬間だけ `Element.animate`。
 * - `scope` (タブ ID 等) が変わったコミットは別の結果への切り替えなので再生もスクロール
 *   リセットもせず、前回値だけ更新する。
 * - 新しい行は到着済みの 1 回の置換なので、旧ページが抜ける演出はなく「入る側」のみ。
 * - reduced-motion (`motionPreference:"reduced"` / ハイコントラスト含む) は再生しない。
 *   `Element.animate` が無い環境 (jsdom) では何もしない。
 */
export function usePageTurn(
  tbodyRef: RefObject<HTMLTableSectionElement | null>,
  scrollRef: RefObject<HTMLElement | null> | undefined,
  page: number | undefined,
  scope: string,
): void {
  const reduced = useReducedMotionConfig();
  const prevRef = useRef({ page, scope });
  const runningRef = useRef<Animation | null>(null);

  // 毎コミット走るが、ページ比較だけの軽い処理 (依存配列なし)。
  useLayoutEffect(() => {
    const prev = prevRef.current;
    prevRef.current = { page, scope };
    if (page === undefined || prev.page === undefined || prev.scope !== scope) return;
    const dir = pageTurnDirection(prev.page, page);
    if (dir === null) return;
    const scroller = scrollRef?.current;
    if (scroller) scroller.scrollTop = 0;
    if (reduced) return;
    const el = tbodyRef.current;
    if (!el || typeof el.animate !== "function") return;
    runningRef.current?.cancel();
    // 向きの規約は `directionalSlide` (#1234) と同じ (正 = 右から入る)。移動量だけページ用。
    // 大ジャンプ (dir 0) は x 移動なしなので、暗転は行クロスフェードと同じ控えめな値にする。
    const x = dir * slideOffsets.page;
    const opacityFrom = dir === 0 ? rowCrossfadeFrom : 0;
    runningRef.current = el.animate(
      [
        { opacity: opacityFrom, transform: `translateX(${x}px)` },
        { opacity: 1, transform: "translateX(0)" },
      ],
      {
        duration: durations.med * 1000,
        easing: `cubic-bezier(${easings.out.join(", ")})`,
      },
    );
  });
}
