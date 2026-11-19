// ノートブックの「すべて実行」で、実行中のセルへ画面を追従させる判定 (#2449)。
// 追従スクロールそのものは `scrollIntoView` だが、利用者が手でスクロールしたら止めたい。
// 「手でスクロールした」入力の判定と、スクロールの出し方 (reduced-motion / hc-* で
// スムーズにしない) を純関数に出し、フックはイベントの購読だけを担う。

import { useEffect, useRef, type RefObject } from "react";

/** スクロール位置を動かす操作として扱うキー (編集中の要素では無視する)。 */
const SCROLL_KEYS: ReadonlySet<string> = new Set(["PageUp", "PageDown", "Home", "End", " ", "Spacebar"]);

export interface ScrollInput {
  type: string;
  key?: string;
  /** イベントの発生源が入力欄 / エディタなど編集可能な要素か (キー入力はスクロール操作ではない)。 */
  editable?: boolean;
  /** イベントの発生源がスクロールコンテナ自身か (スクロールバーのドラッグ)。 */
  onContainer?: boolean;
}

/** 利用者が手でスクロールしたと見なせる入力か。 */
export function isManualScrollInput(e: ScrollInput): boolean {
  switch (e.type) {
    case "wheel":
    case "touchmove":
      return true;
    case "pointerdown":
      // コンテナ自身への押下はスクロールバーのつかみ。セル内のクリックは含めない。
      return e.onContainer === true;
    case "keydown":
      return !e.editable && e.key !== undefined && SCROLL_KEYS.has(e.key);
    default:
      return false;
  }
}

/** 追従の `scrollIntoView` の引数。`still` (reduced-motion / hc-*) ではスムーズにしない。 */
export function followScrollOptions(still: boolean): ScrollIntoViewOptions {
  return { block: "nearest", behavior: still ? "auto" : "smooth" };
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.matches("input, textarea, select");
}

/**
 * `active` の間、コンテナ上の手動スクロールを見張る。戻り値の ref は追従してよい間 true。
 * `active` が false → true になるたびに追従へ戻す (次の実行は追従から始まる)。
 */
export function useFollowLatch(containerRef: RefObject<HTMLElement | null>, active: boolean) {
  const following = useRef(true);
  useEffect(() => {
    if (!active) return;
    following.current = true;
    const el = containerRef.current;
    if (!el) return;
    const onInput = (ev: Event) => {
      if (
        isManualScrollInput({
          type: ev.type,
          key: ev instanceof KeyboardEvent ? ev.key : undefined,
          editable: isEditable(ev.target),
          onContainer: ev.target === el,
        })
      ) {
        following.current = false;
      }
    };
    const types = ["wheel", "touchmove", "pointerdown", "keydown"] as const;
    for (const type of types) el.addEventListener(type, onInput, { passive: true });
    return () => {
      for (const type of types) el.removeEventListener(type, onInput);
    };
  }, [active, containerRef]);
  return following;
}
