/**
 * キーボードナビゲーション共通ユーティリティ (#536)
 *
 * フォーカストラップ・戻り先フォーカス・roving tabindex の共通ロジックを
 * 提供するフック群。メニュー・モーダル・ポップオーバーで共有できるよう、
 * DOM 操作を最小限のインタフェースに閉じ込める。
 *
 * ## 設計方針
 * - `Modal` (`Chakra Dialog`) はフォーカストラップ + Esc を内包するため、
 *   このファイルのフォーカストラップフックは Modal 以外 (ContextMenu など)
 *   のポップオーバーに使う。
 * - `useReturnFocus` だけは Modal を含むすべての閉じる操作に適用できる
 *   汎用フックとして設計する (マウント時にフォーカスを記憶し、アンマウント時に返す)。
 * - `useRovingFocus` はリスト/ツリー内での ArrowUp/Down・ArrowLeft/Right ナビゲーションを
 *   WAI-ARIA Listbox/Tree パターンに揃えるヘルパー。ContextMenu の既存ロジックを
 *   共通化した形。
 */

import { useCallback, useEffect, useRef } from "react";

// ---------------------------------------------------------------------------
// useReturnFocus
// ---------------------------------------------------------------------------

/**
 * マウント時にフォーカスしていた要素を記憶し、アンマウント時に返す。
 *
 * ポップオーバー/ダイアログが閉じた後、トリガー要素 (右クリックしたセル・
 * ボタンなど) へフォーカスを戻すために使う。
 *
 * Modal (Chakra Dialog) は Ark/Chakra 本体がこれを内包しているため重複しないが、
 * ContextMenu のような独自ポータルでは明示的に使う必要がある。
 *
 * @example
 * ```tsx
 * function ContextMenu({ onClose }: { onClose: () => void }) {
 *   useReturnFocus();
 *   // ...
 * }
 * ```
 */
export function useReturnFocus(): void {
  // コンポーネントマウント時点でのアクティブ要素を保存する。
  // ref なので再レンダリングをトリガーしない。
  const returnTo = useRef<Element | null>(null);

  useEffect(() => {
    // マウント時に「今フォーカスがある要素」を記憶する。
    returnTo.current = document.activeElement;

    return () => {
      // アンマウント時に、記憶した要素がまだ DOM に存在すればフォーカスを返す。
      const el = returnTo.current;
      if (el && el instanceof HTMLElement && document.contains(el)) {
        el.focus();
      }
    };
  }, []);
}

// ---------------------------------------------------------------------------
// useFocusTrap
// ---------------------------------------------------------------------------

/**
 * 指定したコンテナ内でフォーカスをトラップし、Tab / Shift+Tab でコンテナ内を
 * 循環させる。Esc キーが押されたら `onEscape` を呼ぶ。
 *
 * Chakra の `Dialog` はフォーカストラップを内包しているため、このフックは
 * それを使わないカスタムポップオーバー (ContextMenu など) 向け。
 *
 * @param containerRef - トラップ対象コンテナの ref
 * @param onEscape - Esc が押されたときのコールバック (省略可)
 *
 * @example
 * ```tsx
 * const menuRef = useRef<HTMLDivElement>(null);
 * useFocusTrap(menuRef, onClose);
 * ```
 */
export function useFocusTrap(
  containerRef: React.RefObject<HTMLElement | null>,
  onEscape?: () => void,
): void {
  const onEscapeRef = useRef(onEscape);
  // 最新のコールバックを ref に保持して、クロージャの古い参照を防ぐ。
  useEffect(() => {
    onEscapeRef.current = onEscape;
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const FOCUSABLE =
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
      'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

    const getFocusable = (): HTMLElement[] =>
      Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => !el.closest('[aria-hidden="true"]'),
      );

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onEscapeRef.current?.();
        return;
      }

      if (e.key !== "Tab") return;

      const focusable = getFocusable();
      if (focusable.length === 0) {
        e.preventDefault();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;

      if (e.shiftKey) {
        // Shift+Tab: 先頭にいれば末尾へラップ。
        if (active === first || !container.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        // Tab: 末尾にいれば先頭へラップ。
        if (active === last || !container.contains(active)) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    container.addEventListener("keydown", onKeyDown);
    return () => {
      container.removeEventListener("keydown", onKeyDown);
    };
  }, [containerRef]);
}

// ---------------------------------------------------------------------------
// useRovingFocus
// ---------------------------------------------------------------------------

/**
 * WAI-ARIA の roving tabindex パターンを実装するフック。
 *
 * 対象コンテナ内の `itemSelector` に一致する要素を矢印キーで移動できるようにする。
 * ArrowDown/ArrowRight で次の要素へ、ArrowUp/ArrowLeft で前の要素へ移動し、
 * 先頭/末尾でラップする (wrap=true の場合)。
 *
 * Home/End キーで先頭/末尾へジャンプする。
 *
 * @param containerRef - ナビゲーション対象コンテナの ref
 * @param itemSelector - フォーカス可能な項目を選ぶ CSS セレクタ
 * @param options.wrap - 先頭/末尾でラップするか (既定 true)
 * @param options.orientation - "vertical" (上下) / "horizontal" (左右) / "both" (全4方向)
 *
 * @returns onKeyDown ハンドラ (コンテナへ `onKeyDown={onKeyDown}` として渡す)
 *
 * @example
 * ```tsx
 * const menuRef = useRef<HTMLDivElement>(null);
 * const { onKeyDown } = useRovingFocus(menuRef, "[role=menuitem]:not([disabled])");
 * return <div ref={menuRef} onKeyDown={onKeyDown}> ... </div>;
 * ```
 */
export function useRovingFocus(
  containerRef: React.RefObject<HTMLElement | null>,
  itemSelector: string,
  options: {
    wrap?: boolean;
    orientation?: "vertical" | "horizontal" | "both";
  } = {},
): { onKeyDown: (e: React.KeyboardEvent) => void } {
  const { wrap = true, orientation = "vertical" } = options;

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const isVertical = orientation === "vertical" || orientation === "both";
      const isHorizontal = orientation === "horizontal" || orientation === "both";

      const isNext =
        (isVertical && e.key === "ArrowDown") ||
        (isHorizontal && e.key === "ArrowRight");
      const isPrev =
        (isVertical && e.key === "ArrowUp") ||
        (isHorizontal && e.key === "ArrowLeft");
      const isHome = e.key === "Home";
      const isEnd = e.key === "End";

      if (!isNext && !isPrev && !isHome && !isEnd) return;

      const container = containerRef.current;
      if (!container) return;

      const items = Array.from(
        container.querySelectorAll<HTMLElement>(itemSelector),
      );
      if (items.length === 0) return;

      e.preventDefault();

      if (isHome) {
        items[0].focus();
        return;
      }
      if (isEnd) {
        items[items.length - 1].focus();
        return;
      }

      const idx = items.indexOf(document.activeElement as HTMLElement);

      if (isNext) {
        const next =
          idx < items.length - 1
            ? items[idx + 1]
            : wrap
              ? items[0]
              : items[items.length - 1];
        next.focus();
      } else {
        const prev =
          idx > 0
            ? items[idx - 1]
            : wrap
              ? items[items.length - 1]
              : items[0];
        prev.focus();
      }
    },
    [containerRef, itemSelector, wrap, orientation],
  );

  return { onKeyDown };
}
