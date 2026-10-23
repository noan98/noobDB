import { useCallback, useEffect, useRef, type RefObject } from "react";
import { useReducedMotionConfig } from "motion/react";
import { durations, easings } from "../motion";
import { computeFlipOffsets } from "./columnReorderFlip";

/** ハイコントラスト (テーマ hc-* / forced-colors) か。装飾的な動きは出さない。 */
function prefersStaticMotion(): boolean {
  if (typeof document === "undefined") return false;
  if (document.documentElement.getAttribute("data-theme")?.startsWith("hc-")) return true;
  return typeof window.matchMedia === "function" && window.matchMedia("(forced-colors: active)").matches;
}

function measureLefts(tabs: ReadonlyMap<string, HTMLElement | null>): Map<string, number> {
  const out = new Map<string, number>();
  for (const [id, el] of tabs) {
    if (el?.isConnected) out.set(id, el.getBoundingClientRect().left);
  }
  return out;
}

/**
 * タブを閉じたあとの隣接タブの詰め直しを滑らせる FLIP (#1765)。
 *
 * 閉じたタブは `AnimatePresence` の退場 (opacity + scaleX, transform のみ) の間も DOM に
 * 残るのでレイアウトは動かず、退場が終わって DOM から外れた瞬間に右側のタブが詰め位置へ
 * 瞬間移動する。その 1 回のレイアウト変化だけを、`TabBar` の `AnimatePresence` の
 * `onExitComplete` (= 外れる直前) で位置を測り、外れた直後 (MutationObserver、ペイント前) に
 * 測り直して、動いたタブを元の位置から滑らせる。
 *
 * ## Motion の `layout` を使わない理由
 *
 * `layout="position"` を各タブに付けると、`TabBar` が再レンダーされる (ストリーミング・
 * 入力のたび) たびに全タブの bounding box を測り直して重い (#658)。ここでは
 * **退場完了の 1 回だけ** 計測し、通常の再レンダーでは何も走らない (ref と一時的な
 * MutationObserver だけ)。ドラッグ並べ替え (`Reorder`) の経路には触れない。
 *
 * - `translate` (個別 transform プロパティ) を Web Animations API で動かすので、Reorder が
 *   inline で持つ `transform` や開閉の scaleX とは干渉せず、`fill` なしで終了後に何も残らない。
 * - 値は `durations.base` と `easings.out` (CSS の `--ease-out` と同じ)。
 * - reduced-motion (OS / `motionPreference="reduced"`) とハイコントラストは測りもしない。
 *   `Element.animate` が無い環境 (jsdom) でも何もしない。
 */
export function useTabCloseGlide(
  groupRef: RefObject<HTMLElement | null>,
  tabRefs: RefObject<Map<string, HTMLElement | null>>,
): { onExitComplete: () => void } {
  const reduced = useReducedMotionConfig();
  const observerRef = useRef<MutationObserver | null>(null);
  const runningRef = useRef<Animation[]>([]);

  const stop = useCallback(() => {
    observerRef.current?.disconnect();
    observerRef.current = null;
  }, []);

  useEffect(() => {
    return () => {
      stop();
      for (const a of runningRef.current) a.cancel();
    };
  }, [stop]);

  const onExitComplete = useCallback(() => {
    const group = groupRef.current;
    if (reduced || !group || typeof MutationObserver === "undefined" || prefersStaticMotion()) return;
    stop();
    const before = measureLefts(tabRefs.current);
    const observer = new MutationObserver(() => {
      stop();
      // 連続で閉じたときは前回の再生を打ち切ってから測る (再生中の translate を混ぜない)。
      for (const a of runningRef.current) a.cancel();
      runningRef.current = [];
      const offsets = computeFlipOffsets(before, measureLefts(tabRefs.current));
      const timing: KeyframeAnimationOptions = {
        duration: durations.base * 1000,
        easing: `cubic-bezier(${easings.out.join(", ")})`,
      };
      for (const [id, dx] of offsets) {
        const el = tabRefs.current.get(id);
        if (!el || typeof el.animate !== "function") continue;
        runningRef.current.push(el.animate([{ translate: `${dx}px 0` }, { translate: "0 0" }], timing));
      }
    });
    observer.observe(group, { childList: true });
    observerRef.current = observer;
    // 外れなかった (別経路の再レンダー等) 場合に古い「前」の位置が残らないよう破棄する。
    window.setTimeout(() => {
      if (observerRef.current === observer) stop();
    }, 250);
  }, [reduced, groupRef, tabRefs, stop]);

  return { onExitComplete };
}
