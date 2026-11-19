// ノートブックの「すべて実行」で、実行中のセルへ画面を追従させる判定 (#2449)。
// 追従スクロールそのものは `scrollIntoView` だが、利用者が手でスクロールしたら止めたい。
// 「手でスクロールした」入力の判定と、スクロールの出し方 (reduced-motion / hc-* で
// スムーズにしない) を純関数に出し、フックはイベントの購読だけを担う。

import { useEffect, useRef, type RefObject } from "react";

/** スクロール位置を動かす操作として扱うキー。ArrowUp / Down は編集欄・選択欄の外だけ。 */
const SCROLL_KEYS: ReadonlySet<string> = new Set([
  "PageUp",
  "PageDown",
  "Home",
  "End",
  "ArrowUp",
  "ArrowDown",
]);
const SPACE_KEYS: ReadonlySet<string> = new Set([" ", "Spacebar"]);

export interface ScrollInput {
  type: string;
  key?: string;
  /** イベントの発生源が入力欄 / エディタ / 選択欄など、キー操作を自分で使う要素か。 */
  editable?: boolean;
  /** イベントの発生源が button / [role=button] か (Space は押下であってスクロールではない)。 */
  onButton?: boolean;
  /** wheel / touchmove: 発生源からコンテナまでの間に、自分でスクロールする内側の領域 (エディタ・結果表) があるか。 */
  innerScroller?: boolean;
  /** pointerdown: コンテナ自身のスクロールバー上か (余白のクリックは含めない)。 */
  onScrollbar?: boolean;
}

/** 利用者が手でコンテナをスクロールしたと見なせる入力か。 */
export function isManualScrollInput(e: ScrollInput): boolean {
  switch (e.type) {
    case "wheel":
    case "touchmove":
      // 内側の領域 (CodeMirror・結果グリッド) のスクロールは、コンテナを動かさない。
      return e.innerScroller !== true;
    case "pointerdown":
      return e.onScrollbar === true;
    case "keydown":
      if (e.editable || e.key === undefined) return false;
      if (SPACE_KEYS.has(e.key)) return !e.onButton;
      return SCROLL_KEYS.has(e.key);
    default:
      return false;
  }
}

/** 追従の `scrollIntoView` の引数。`still` (reduced-motion / hc-*) ではスムーズにしない。 */
export function followScrollOptions(still: boolean): ScrollIntoViewOptions {
  return { block: "nearest", behavior: still ? "auto" : "smooth" };
}

const KEY_OWNER_SELECTOR =
  "input, textarea, select, [contenteditable], [role=textbox], [role=listbox], [role=combobox], [role=option], [role=menu], [role=slider]";

function isEditable(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement && (target.isContentEditable || target.closest(KEY_OWNER_SELECTOR) !== null)
  );
}

function isButton(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.closest("button, [role=button]") !== null;
}

/** `target` からコンテナ (含まない) までに、縦に溢れて自分でスクロールする祖先があるか。 */
function hasInnerScroller(target: EventTarget | null, container: HTMLElement): boolean {
  let node = target instanceof HTMLElement ? target : null;
  while (node && node !== container) {
    if (node.scrollHeight > node.clientHeight) {
      const overflowY = getComputedStyle(node).overflowY;
      if (overflowY === "auto" || overflowY === "scroll") return true;
    }
    node = node.parentElement;
  }
  return false;
}

/** コンテナ自身のスクロールバー (右端の clientWidth より外側) への押下か。 */
function isOnScrollbar(ev: Event, container: HTMLElement): boolean {
  if (ev.target !== container || !(ev instanceof MouseEvent)) return false;
  if (container.offsetWidth <= container.clientWidth) return false;
  return ev.clientX >= container.getBoundingClientRect().left + container.clientLeft + container.clientWidth;
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
          onButton: isButton(ev.target),
          innerScroller: hasInnerScroller(ev.target, el),
          onScrollbar: isOnScrollbar(ev, el),
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
