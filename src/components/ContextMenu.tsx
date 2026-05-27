import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Box, chakra } from "@chakra-ui/react";

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

  // Roving focus between enabled items with the arrow keys.
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const el = menuRef.current;
    if (!el) return;
    const buttons = Array.from(el.querySelectorAll<HTMLButtonElement>(ENABLED_ITEM));
    if (buttons.length === 0) return;
    const idx = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      e.key === "ArrowDown"
        ? buttons[(idx + 1) % buttons.length]
        : buttons[(idx - 1 + buttons.length) % buttons.length];
    next.focus();
  };

  return createPortal(
    <Box
      position="fixed"
      inset={0}
      zIndex={1000}
      onMouseDown={onClose}
      onContextMenu={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <Box
        ref={menuRef}
        position="fixed"
        zIndex={1000}
        minW="180px"
        bg="app.surface"
        border="1px solid"
        borderColor="app.borderStrong"
        borderRadius="md"
        boxShadow="md"
        p="var(--space-1)"
        display="flex"
        flexDirection="column"
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
              my="4px"
              mx="6px"
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
              px="10px"
              py="6px"
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
      </Box>
    </Box>,
    document.body,
  );
}
