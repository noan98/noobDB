import { useLayoutEffect, useRef, type RefObject } from "react";
import { useReducedMotionConfig } from "motion/react";
import { durations, easings } from "../motion";

/**
 * 結果グリッドのクライアント側ソート / フィルタ適用時の軽量な着地クロスフェード (#1416)。
 *
 * `key` (ソート / フィルタ状態、`rowCrossfadeKey`) が変わったコミット直後に、`<tbody>`
 * 要素へ opacity だけを 1 回アニメーションする。
 *
 * ## この書き方にした理由
 *
 * - **Motion の `motion.tbody` / `AnimatePresence` を使わない**: グリッドは行仮想化で
 *   頻繁に再レンダーされる。Motion のコンポーネントを常駐させると projection node が
 *   残り続けるため、再生の瞬間だけ Web Animations API で `animate()` する
 *   (`useColumnReorderFlip` と同じ流儀)。常駐するのは ref と前回キーだけ。
 * - **key で `<tbody>` を作り直さない**: 再マウントすると全行のセル DOM が破棄され、
 *   スクロール位置・選択・インライン編集中の入力が失われ、仮想化の再計測も走る。
 *   既存 DOM に animate を 1 回かけるだけなので状態は一切失われない。
 * - per-row の計測 / アニメーションは行わない (`<tbody>` 1 要素のみ)。
 * - 値は `transitions.crossfade` と同じ `durations.quick` と `easings.standard`。
 *   `fill` なしなので終了後に inline style を残さない。
 * - `prefers-reduced-motion` / `motionPreference="reduced"` はルートの `MotionConfig` に
 *   追従する `useReducedMotionConfig` で見て再生しない。`Element.animate` が無い環境
 *   (jsdom) では何もしない。
 * - 初回マウントでは再生しない (新しい結果の到着は対象外)。
 */
export function useRowCrossfade(tbodyRef: RefObject<HTMLTableSectionElement | null>, key: string): void {
  const reduced = useReducedMotionConfig();
  const prevKeyRef = useRef(key);
  const runningRef = useRef<Animation | null>(null);

  useLayoutEffect(() => {
    if (prevKeyRef.current === key) return;
    prevKeyRef.current = key;
    if (reduced) return;
    const el = tbodyRef.current;
    if (!el || typeof el.animate !== "function") return;
    // 連続操作では前回の再生を打ち切って最初から 1 回だけ再生し直す。
    runningRef.current?.cancel();
    runningRef.current = el.animate([{ opacity: 0.35 }, { opacity: 1 }], {
      duration: durations.quick * 1000,
      easing: `cubic-bezier(${easings.standard.join(", ")})`,
    });
  }, [key, reduced, tbodyRef]);
}
