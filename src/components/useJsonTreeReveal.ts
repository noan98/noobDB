import { useCallback, useLayoutEffect, useRef, type DependencyList, type RefObject } from "react";
import { useReducedMotionConfig } from "motion/react";
import { FIRST_BATCH_REVEAL_FALLBACK_ROWS } from "./firstBatchReveal";
import { jsonTreeRevealAnimation, visibleRevealTargets } from "./jsonTreeReveal";
import { prefersStaticMotion } from "./revealOrigin";

/**
 * JSON ツリーの展開 / 一括展開で露出した行を、opacity クロスフェード + 微小な slide-up で
 * 現す (#1863)。`mark()` を状態変更の直前に呼ぶと、その時点の行を記録する。状態が反映された
 * 後に `flush()` を呼ぶと、記録に無かった (= 新しく現れた) 行のうち可視範囲のものだけを
 * Web Animations API で 1 回再生する。
 *
 * - 行はネスト DOM だが per-node の height 補間はしない (大量の一括展開で重くなる)。
 *   再生は新規行の `Element.animate` のみ。スクロール・選択・検索状態には触れない。
 * - 遅延は `firstBatchRevealDelayMs` (12 段で頭打ち)。対象は可視範囲の行だけ。
 * - reduced-motion / ハイコントラスト (`prefersStaticMotion`) と `Element.animate` が無い環境
 *   (jsdom) では何もしない。畳む操作は新規行が無いので再生しない。
 */
export function useJsonTreeReveal(treeRef: RefObject<HTMLElement | null>, deps: DependencyList) {
  const reduced = useReducedMotionConfig();
  const reducedRef = useRef(reduced);
  reducedRef.current = reduced;
  const beforeRef = useRef<Set<Element> | null>(null);
  const runningRef = useRef<Animation[]>([]);

  const mark = useCallback(() => {
    // 静止モードでは記録しない (全行の走査を避け、flush も何もしない)。
    if (reducedRef.current || prefersStaticMotion()) {
      beforeRef.current = null;
      return;
    }
    const tree = treeRef.current;
    beforeRef.current = tree ? new Set(tree.querySelectorAll("[role='treeitem']")) : null;
  }, [treeRef]);

  const flush = useCallback(() => {
    const before = beforeRef.current;
    beforeRef.current = null;
    const tree = treeRef.current;
    if (!before || !tree) return;
    if (reducedRef.current || prefersStaticMotion()) return;
    const fresh = Array.from(tree.querySelectorAll<HTMLElement>("[role='treeitem']")).filter(
      (el) => !before.has(el),
    );
    if (fresh.length === 0 || typeof fresh[0].animate !== "function") return;
    const view = tree.getBoundingClientRect();
    const targets = visibleRevealTargets(
      fresh,
      (el) => el.getBoundingClientRect(),
      { top: view.top, bottom: view.bottom },
      FIRST_BATCH_REVEAL_FALLBACK_ROWS,
    );
    for (const a of runningRef.current) a.cancel();
    runningRef.current = targets.map((el, i) => {
      const { keyframes, options } = jsonTreeRevealAnimation(i);
      return el.animate(keyframes, options);
    });
  }, [treeRef]);

  // アンマウント時に再生中のものを止める。
  useLayoutEffect(
    () => () => {
      for (const a of runningRef.current) a.cancel();
    },
    [],
  );

  // `deps` (展開状態) の反映後に再生する。行は `useSyncExternalStore` で購読しており、親の
  // layout effect でストアを更新すると同期レーン (SyncLane) で再レンダーが同じタスク内に
  // 完了するため、マイクロタスクの時点で新規行が DOM に載っている (描画前) ことに依存する。
  useLayoutEffect(() => {
    if (beforeRef.current) queueMicrotask(flush);
  }, [...deps, flush]);

  return { mark };
}
