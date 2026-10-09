import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { useReducedMotionConfig } from "motion/react";
import { durations, easings, rowCrossfadeFrom } from "../motion";
import type { RowCrossfadeKeys } from "./rowCrossfade";

/**
 * 結果グリッドのクライアント側ソート / フィルタ適用時の軽量な着地クロスフェード (#1416)。
 *
 * `keys` (`rowCrossfadeKeys`) が変わったコミット直後に、`<tbody>` 要素へ opacity だけを
 * 1 回アニメーションする。
 *
 * - `keys.sort` の変化 (ヘッダのクリック) は即時に再生する。
 * - `keys.filter` の変化 (検索・列フィルタ) は 1 文字ごとに変わるので、最後の変化から
 *   `durations.med` 待って (入力が落ち着いてから) 1 回だけ再生する。入力中に何度も
 *   cancel → 暗転し直して明滅するのを防ぐ。
 * - `scope` (結果のシェイプ = gridViewKey) が変わったコミットは「新しい結果の到着」
 *   なので再生せず、前回キーだけ更新する (保存済みソートの復元で鳴らさない)。
 *
 * ## この書き方にした理由
 *
 * - **Motion の `motion.tbody` / `AnimatePresence` を使わない**: グリッドは行仮想化で
 *   頻繁に再レンダーされる。Motion のコンポーネントを常駐させると projection node が
 *   残り続けるため、再生の瞬間だけ Web Animations API で `animate()` する
 *   (`useColumnReorderFlip` と同じ流儀)。常駐するのは ref と前回キーだけ。
 * - **key で `<tbody>` を作り直さない**: 再マウントすると全行のセル DOM が破棄され、
 *   スクロール位置・選択・インライン編集中の入力が失われ、仮想化の再計測も走る。
 * - per-row の計測 / アニメーションは行わない (`<tbody>` 1 要素のみ)。
 * - 値は `durations.quick` (= `transitions.crossfade`) と `easings.standard`。
 *   `fill` なしなので終了後に inline style を残さない。
 * - reduced-motion は `useReducedMotionConfig` で見て再生しない。`Element.animate` が
 *   無い環境 (jsdom) では何もしない。
 */
export function useRowCrossfade(
  tbodyRef: RefObject<HTMLTableSectionElement | null>,
  keys: RowCrossfadeKeys,
  scope: string,
): void {
  const reduced = useReducedMotionConfig();
  const prevRef = useRef({ sort: keys.sort, filter: keys.filter, scope });
  const runningRef = useRef<Animation | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settlingRef = useRef(false);
  const reducedRef = useRef(reduced);
  reducedRef.current = reduced;

  const clearTimer = () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };
  const play = () => {
    clearTimer();
    if (reducedRef.current) return;
    const el = tbodyRef.current;
    if (!el || typeof el.animate !== "function") return;
    runningRef.current?.cancel();
    runningRef.current = el.animate([{ opacity: rowCrossfadeFrom }, { opacity: 1 }], {
      duration: durations.quick * 1000,
      easing: `cubic-bezier(${easings.standard.join(", ")})`,
    });
  };

  // 毎コミット走るが、キー比較だけの軽い処理 (依存配列なし)。保存済みソートの復元は
  // scope 変更の「次の」コミットで入る (useReloadOnChange が effect で state を更新する) ため、
  // scope が変わったら次の 1 コミットもキー変化を再生せずに取り込む。
  useLayoutEffect(() => {
    const prev = prevRef.current;
    prevRef.current = { sort: keys.sort, filter: keys.filter, scope };
    if (prev.scope !== scope) {
      // 新しい結果 (別シェイプ) の到着は対象外。
      settlingRef.current = true;
      clearTimer();
      return;
    }
    if (settlingRef.current) {
      settlingRef.current = false;
      return;
    }
    if (prev.sort !== keys.sort) play();
    else if (prev.filter !== keys.filter) {
      clearTimer();
      timerRef.current = setTimeout(play, durations.med * 1000);
    }
  });

  // アンマウント時に保留中のタイマーを捨てる (timerRef は ref なので依存不要)。
  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );
}
