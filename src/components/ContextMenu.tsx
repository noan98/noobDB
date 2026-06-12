import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Box, chakra } from "@chakra-ui/react";
import { motion } from "motion/react";
import { transitions } from "../motion";
import { useReturnFocus, useRovingFocus } from "../keyboardNav";

/**
 * メニュー本体を motion 化するラッパー。`transition` を Chakra のスタイルプロップに
 * 飲まれず motion へ渡すため `forwardProps` に含める (`TabBar` / `Modal` と同方式)。
 * 出現は enter のみ (軽い fade + scale) で、閉じるのは従来どおり親のアンマウントに
 * よる即時消去 — メニューは複数箇所から `{menu && }` で
 * 条件マウントされており、exit のために各所へ `AnimatePresence` を足すコストに
 * 見合わないため。reduced-motion 時は MotionConfig が
 * enter を即時化する。
 */
const MotionMenu = chakra(motion.div, {}, { forwardProps: ["transition"] });

/** Enabled items carry `role="menuitem"`; disabled ones get the `disabled`
 *  attribute. Keyboard navigation (focus-first + arrow roving) selects against
 *  this, decoupled from styling/classNames. */
const ENABLED_ITEM = "[role=menuitem]:not([disabled])";

export interface ContextMenuItem {
  label: string;
  onSelect: () => void;
  /** Renders in the destructive color. */
  danger?: boolean;
  disabled?: boolean;
  /** Tooltip — handy for explaining why an item is disabled. */
  title?: string;
}

export interface ContextMenuSeparator {
  separator: true;
}

export type ContextMenuEntry = ContextMenuItem | ContextMenuSeparator;

function isSeparator(entry: ContextMenuEntry): entry is ContextMenuSeparator {
  return "separator" in entry;
}

interface Props {
  /** Anchor point (viewport coords, typically the click position). */
  x: number;
  y: number;
  items: ContextMenuEntry[];
  onClose: () => void;
}

/**
 * Shared right-click menu. Renders via a portal to <body> behind a full-viewport
 * backdrop — this sidesteps a WebKitGTK quirk where a position:fixed menu nested
 * in a scroll/overflow container paints on top but doesn't capture clicks, and
 * gives one place for outside-click / Escape / scroll / resize dismissal and
 * viewport clamping. Activating an item closes the menu first, then runs it.
 */
export function ContextMenu({ x, y, items, onClose }: Props) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // メニューが閉じたとき、開く前にフォーカスしていた要素へ戻す。
  useReturnFocus();

  // Clamp into the viewport once the menu has measured itself, flipping back
  // from the anchor when it would overflow the right/bottom edge.
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const margin = 6;
    let left = x + width + margin > window.innerWidth ? x - width : x;
    let top = y + height + margin > window.innerHeight ? y - height : y;
    left = Math.min(Math.max(margin, left), window.innerWidth - width - margin);
    top = Math.min(Math.max(margin, top), window.innerHeight - height - margin);
    setPos({ left, top });
  }, [x, y, items]);

  // Outside clicks are absorbed by the backdrop; here we handle the rest.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onClose, true);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  // Focus the first enabled item so keyboard users can navigate immediately.
  useEffect(() => {
    menuRef.current?.querySelector<HTMLButtonElement>(ENABLED_ITEM)?.focus();
  }, [items]);

  const activate = (item: ContextMenuItem) => {
    if (item.disabled) return;
    onClose();
    item.onSelect();
  };

  // 共通 roving tabindex ヘルパーで ArrowUp/Down・Home/End のメニュー項目移動を実装。
  const { onKeyDown } = useRovingFocus(menuRef, ENABLED_ITEM, { orientation: "vertical" });

  return createPortal(
    <Box
      position="fixed"
      inset={0}
      zIndex="popover"
      onMouseDown={onClose}
      onContextMenu={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <MotionMenu
        ref={menuRef}
        position="fixed"
        zIndex="popover"
        minW="180px"
        bg="app.surface"
        border="1px solid"
        borderColor="app.borderStrong"
        borderRadius="md"
        boxShadow="elevationPopover"
        p="1"
        display="flex"
        flexDirection="column"
        // 出現位置 (クリック点) を起点に伸びるよう原点を左上に。scale は控えめ
        // (0.97) なので、測定 (getBoundingClientRect) によるクランプへの影響は無視できる。
        transformOrigin="top left"
        initial={{ opacity: 0, scale: 0.97 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={transitions.enter}
        style={{
          left: pos?.left ?? x,
          top: pos?.top ?? y,
          visibility: pos ? "visible" : "hidden",
        }}
        role="menu"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        {items.map((entry, i) =>
          isSeparator(entry) ? (
            <Box
              key={`sep-${i}`}
              role="separator"
              h="1px"
              my="1"
              mx="1.5"
              bg="app.borderSubtle"
            />
          ) : (
            <chakra.button
              key={`${entry.label}-${i}`}
              type="button"
              role="menuitem"
              display="block"
              textAlign="left"
              bg="transparent"
              border="none"
              px="2.5"
              py="1.5"
              fontSize="var(--text-md)"
              color={entry.danger ? "app.textError" : "app.text"}
              borderRadius="sm"
              cursor="pointer"
              disabled={entry.disabled}
              title={entry.title}
              transitionProperty="background, color"
              transitionDuration="var(--dur-fast)"
              transitionTimingFunction="var(--ease)"
              _focusVisible={{ outline: "none" }}
              _disabled={{ color: "app.textMuted", opacity: 0.6, cursor: "default" }}
              css={{
                "&:hover:not(:disabled), &:focus-visible": {
                  background: entry.danger
                    ? "color-mix(in srgb, var(--status-error) 12%, transparent)"
                    : "var(--bg-hover)",
                },
              }}
              onClick={() => activate(entry)}
            >
              {entry.label}
            </chakra.button>
          ),
        )}
      </MotionMenu>
    </Box>,
    document.body,
  );
}
