import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Box, chakra } from "@chakra-ui/react";
import { motion } from "motion/react";
import { transitions } from "../motion";
import { useReturnFocus, useRovingFocus } from "../keyboardNav";
import { semanticColorVar } from "../semanticColors";
import { Icon, ICON_SIZES, type IconName } from "./Icon";
import { Tooltip } from "./Tooltip";
import { Kbd } from "./Kbd";
import { computeMenuPosition, type MenuAnchor, type MenuRect } from "./menuPosition";

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
  /** Leading icon (#815). Reserve for primary/frequent actions — most items go without one. */
  icon?: IconName;
  /**
   * Right-aligned key hint (#815), e.g. `"Cmd/Ctrl+C"`. Callers resolve this from
   * `shortcuts.ts`'s `resolveShortcutBindings` + `shortcutKeys.ts`'s `formatCombo`
   * (the same pair `ShortcutCheatSheet` uses) so the hint tracks user rebinding —
   * `ContextMenu` itself stays display-only and doesn't know about shortcut ids.
   */
  shortcut?: string;
}

export interface ContextMenuSeparator {
  separator: true;
}

/**
 * 入れ子メニュー (#1018)。ホバー (またはキーボードの ArrowRight / Enter) で子項目を
 * 開く 1 項目で、`items` にはさらにセパレータや入れ子のサブメニューを置ける。
 *
 * 使いどころは「項目数が状況によって膨らむグループ」— 例えば結果グリッドの
 * 「参照元を表示」は子テーブルの数だけ項目が増え、実際に画面高いっぱいの
 * メニューになっていた。固定 2〜3 項目のグループをむやみに畳むと、ただ
 * 1 ホバー分の操作コストが増えるだけなので、判断は `submenuOrFlat` に寄せる。
 */
export interface ContextMenuSubmenu {
  label: string;
  /** 子項目。空の配列を渡してはいけない (開いても何も無いメニューになる)。 */
  items: ContextMenuEntry[];
  icon?: IconName;
  title?: string;
  disabled?: boolean;
}

export type ContextMenuEntry = ContextMenuItem | ContextMenuSeparator | ContextMenuSubmenu;

function isSeparator(entry: ContextMenuEntry): entry is ContextMenuSeparator {
  return "separator" in entry;
}

function isSubmenu(entry: ContextMenuEntry): entry is ContextMenuSubmenu {
  return "items" in entry;
}

/** `submenuOrFlat` が子項目をサブメニューへ畳み始める既定のしきい値。 */
export const SUBMENU_THRESHOLD = 2;

/**
 * 項目数に応じて「そのまま並べる」か「サブメニューへ畳む」かを選ぶ (#1018)。
 *
 * 呼び出し側は毎回このヘルパーを通すことで、メニューごとに畳む/畳まないの
 * 基準がばらつくのを防ぐ。項目が 0 件なら空配列 (呼び出し側はスプレッドで
 * 差し込むだけでよい)、`threshold` 未満ならフラットのまま、それ以上なら
 * 1 つのサブメニュー項目へまとめる。
 */
export function submenuOrFlat(
  label: string,
  items: ContextMenuEntry[],
  opts: { icon?: IconName; title?: string; threshold?: number } = {},
): ContextMenuEntry[] {
  const { icon, title, threshold = SUBMENU_THRESHOLD } = opts;
  if (items.length === 0) return [];
  if (items.length < threshold) return items;
  return [{ label, items, icon, title }];
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
  // メニューが閉じたとき、開く前にフォーカスしていた要素へ戻す。
  useReturnFocus();

  // Outside clicks are absorbed by the backdrop; here we handle the rest.
  // Escape はパネル側でも処理する (サブメニューが開いていればそれだけを閉じる)
  // ため、この window リスナーはフォーカスがメニュー外にある場合の保険。
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

  const anchor = useMemo<MenuAnchor>(() => ({ kind: "point", x, y }), [x, y]);

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
      <MenuPanel entries={items} anchor={anchor} onCloseAll={onClose} autoFocus />
    </Box>,
    document.body,
  );
}

interface PanelProps {
  entries: ContextMenuEntry[];
  anchor: MenuAnchor;
  /** メニュー全体を閉じる (項目の実行時・ルートの Escape)。 */
  onCloseAll: () => void;
  /** サブメニューのみ: 自分だけを閉じて親項目へフォーカスを戻す。 */
  onCloseSelf?: () => void;
  /** 開いた直後に先頭項目へフォーカスする (ルート、およびキーボードで開いた
   *  サブメニュー)。ホバーで開いたサブメニューはフォーカスを奪わない。 */
  autoFocus?: boolean;
}

/**
 * メニュー 1 枚ぶんの描画。ルートメニューもサブメニューも同じコンポーネントで、
 * サブメニューは自身をさらにポータルで body へ出す (親パネルの DOM に入れると
 * 親の roving focus のクエリ `[role=menuitem]` に子項目まで混ざり、矢印キーの
 * 移動が壊れるため)。
 */
function MenuPanel({ entries, anchor, onCloseAll, onCloseSelf, autoFocus }: PanelProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  /** 開いているサブメニュー。同一パネルで同時に開くのは高々 1 つ。`anchor` は
   *  開いた時点で 1 度だけ組み立てる — 毎レンダリングで作り直すと、位置決めの
   *  `useLayoutEffect` が依存の変化を検出し続けて再測定が止まらなくなる。 */
  const [open, setOpen] = useState<{
    index: number;
    anchor: MenuAnchor;
    viaKeyboard: boolean;
  } | null>(null);
  const triggerRefs = useRef(new Map<number, HTMLButtonElement>());

  // Clamp into the viewport once the menu has measured itself, flipping back
  // from the anchor when it would overflow the right/bottom edge.
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos(
      computeMenuPosition(
        anchor,
        { width, height },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
  }, [anchor, entries]);

  // Focus the first enabled item so keyboard users can navigate immediately.
  useEffect(() => {
    if (!autoFocus) return;
    menuRef.current?.querySelector<HTMLButtonElement>(ENABLED_ITEM)?.focus();
  }, [entries, autoFocus]);

  const closeSubmenu = useCallback((focusTrigger: boolean) => {
    setOpen((prev) => {
      if (prev && focusTrigger) triggerRefs.current.get(prev.index)?.focus();
      return null;
    });
  }, []);

  const activate = (item: ContextMenuItem) => {
    if (item.disabled) return;
    onCloseAll();
    item.onSelect();
  };

  const openSubmenu = (index: number, el: HTMLButtonElement, viaKeyboard: boolean) => {
    const r = el.getBoundingClientRect();
    const rect: MenuRect = {
      top: r.top,
      left: r.left,
      right: r.right,
      bottom: r.bottom,
      width: r.width,
      height: r.height,
    };
    setOpen({ index, anchor: { kind: "rect", rect }, viaKeyboard });
  };

  // 共通 roving tabindex ヘルパーで ArrowUp/Down・Home/End のメニュー項目移動を実装。
  const { onKeyDown: onRovingKeyDown } = useRovingFocus(menuRef, ENABLED_ITEM, {
    orientation: "vertical",
  });

  // サブメニューはポータルで body へ出るが React ツリー上は親パネルの子なので、
  // キーイベントは親の onKeyDown まで伝播する。子パネルが処理したキーで親の
  // roving まで動かないよう、パネル内で完結させたキーは伝播を止める。
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      e.preventDefault();
      // サブメニューなら自分だけ閉じ、ルートならメニュー全体を閉じる。
      if (onCloseSelf) onCloseSelf();
      else onCloseAll();
      return;
    }
    if (e.key === "ArrowLeft" && onCloseSelf) {
      e.stopPropagation();
      e.preventDefault();
      onCloseSelf();
      return;
    }
    e.stopPropagation();
    onRovingKeyDown(e);
  };

  const openEntry = open ? entries[open.index] : undefined;

  return (
    <>
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
          left: pos?.left ?? (anchor.kind === "point" ? anchor.x : anchor.rect.right),
          top: pos?.top ?? (anchor.kind === "point" ? anchor.y : anchor.rect.top),
          visibility: pos ? "visible" : "hidden",
        }}
        role="menu"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        {entries.map((entry, i) => {
          if (isSeparator(entry)) {
            return (
              <Box
                key={`sep-${i}`}
                role="separator"
                h="1px"
                my="1"
                mx="1.5"
                bg="app.borderSubtle"
              />
            );
          }
          const submenu = isSubmenu(entry);
          const expanded = submenu && open?.index === i;
          const button = (
            <chakra.button
              type="button"
              role="menuitem"
              ref={
                submenu
                  ? (el: HTMLButtonElement | null) => {
                      if (el) triggerRefs.current.set(i, el);
                      else triggerRefs.current.delete(i);
                    }
                  : undefined
              }
              aria-haspopup={submenu ? "menu" : undefined}
              aria-expanded={submenu ? expanded : undefined}
              display="flex"
              alignItems="center"
              gap="2"
              textAlign="left"
              width="100%"
              bg="transparent"
              border="none"
              px="2.5"
              py="1.5"
              fontSize="var(--text-md)"
              color={!submenu && entry.danger ? "app.textError" : "app.text"}
              borderRadius="sm"
              cursor="pointer"
              disabled={entry.disabled}
              transitionProperty="background, color"
              transitionDuration="var(--dur-fast)"
              transitionTimingFunction="var(--ease)"
              _focusVisible={{ outline: "none" }}
              _disabled={{ color: "app.textMuted", opacity: 0.6, cursor: "default" }}
              css={{
                "&:hover:not(:disabled), &:focus-visible": {
                  background:
                    !submenu && entry.danger
                      ? `color-mix(in srgb, ${semanticColorVar("danger", "solid")} 12%, transparent)`
                      : "var(--bg-hover)",
                },
              }}
              // 開いているサブメニューは、他のサブメニュー項目にホバーしたとき
              // だけ切り替える。通常項目を通過しただけで閉じないので、親項目から
              // 斜めにパネルへ移動しても取りこぼさない (閉じるのはクリック・
              // Escape・ArrowLeft・メニュー自体の終了時)。
              onMouseEnter={(e) => {
                if (!submenu || entry.disabled) return;
                openSubmenu(i, e.currentTarget, false);
              }}
              onClick={(e) => {
                if (!submenu) {
                  activate(entry);
                  return;
                }
                if (entry.disabled) return;
                if (expanded) closeSubmenu(false);
                else openSubmenu(i, e.currentTarget, true);
              }}
              onKeyDown={(e) => {
                if (!submenu || entry.disabled) return;
                if (e.key === "ArrowRight" || e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  openSubmenu(i, e.currentTarget, true);
                }
              }}
            >
              {entry.icon && (
                <Box flexShrink={0} opacity={entry.disabled ? 0.6 : 0.85} aria-hidden>
                  <Icon name={entry.icon} size={ICON_SIZES.sm} />
                </Box>
              )}
              <chakra.span flex="1" minW="0">
                {entry.label}
              </chakra.span>
              {!submenu && entry.shortcut && (
                <Kbd
                  tone="muted"
                  flexShrink={0}
                  ml="3"
                  color={entry.danger ? "inherit" : "app.textMuted"}
                  opacity={entry.disabled ? 0.6 : 0.85}
                >
                  {entry.shortcut}
                </Kbd>
              )}
              {submenu && (
                <Box flexShrink={0} ml="3" opacity={entry.disabled ? 0.6 : 0.7} aria-hidden>
                  <Icon name="chevron-right" size={ICON_SIZES.sm} />
                </Box>
              )}
            </chakra.button>
          );
          // `entry.title` は項目が無効な「理由」を説明する (有効な項目では単なる
          // 補足ヒント)。以前は native `title=` だったが、無効化されたボタンは
          // そもそもフォーカスを持てないため、キーボードフォーカスでは一切
          // 表示されないという実質的な a11y の穴があった。共有 `Tooltip`
          // (#814) はこれを両方まとめて解消する: 有効な項目では通常どおり
          // フォーカスで表示され、無効な項目は `focusableWrapper` によって
          // フォーカス可能な代役を用意するので、Tab でも理由まで到達できる。
          return (
            <Fragment key={`${entry.label}-${i}`}>
              {entry.title ? (
                <Tooltip label={entry.title} placement="right" focusableWrapper={entry.disabled}>
                  {button}
                </Tooltip>
              ) : (
                button
              )}
            </Fragment>
          );
        })}
      </MotionMenu>
      {open &&
        openEntry &&
        isSubmenu(openEntry) &&
        createPortal(
          <MenuPanel
            key={open.index}
            entries={openEntry.items}
            anchor={open.anchor}
            onCloseAll={onCloseAll}
            onCloseSelf={() => closeSubmenu(true)}
            autoFocus={open.viaKeyboard}
          />,
          document.body,
        )}
    </>
  );
}
