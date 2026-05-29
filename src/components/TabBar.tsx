import { useCallback, useId, useRef } from "react";
import { Box, chakra } from "@chakra-ui/react";
import { AnimatePresence, motion } from "motion/react";
import { useT } from "../i18n";
import { Icon } from "./Icon";
import { transitions } from "../motion";

// キーボードフォーカスリング (App.css のフォーカス表現と一致、動的アクセントへ追従)。
const focusRing = "0 0 0 2px color-mix(in srgb, var(--accent) 25%, transparent)";

// motion 要素を Chakra style props で装飾できるようにラップする。motion の
// `transition` プロップは Chakra のスタイルプロップ名と衝突するため明示的に転送する
// (それ以外の motion プロップ — layout / initial / animate / exit / layoutId — は
// スタイルプロップではないので既定で転送される)。CSS のホバー遷移は
// transitionProperty/Duration/TimingFunction の個別指定で表現する。
const MotionTab = chakra(motion.div, {}, { forwardProps: ["transition"] });
const MotionIndicator = chakra(motion.span, {}, { forwardProps: ["transition"] });

export interface TabInfo {
  id: string;
  kind: "table" | "query" | "explain";
  title: string;
  database?: string;
  table?: string;
  dirty?: boolean;
}

interface Props {
  tabs: TabInfo[];
  activeTabId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  disabled?: boolean;
  /** Right-click on a tab (viewport coords) — opens the move/close menu. */
  onTabContextMenu?: (id: string, x: number, y: number) => void;
  /**
   * Split control. With `splitMode === "split"` the button opens a second pane;
   * with `"close"` it closes this pane (merging its tabs into the other one).
   * Omitted entirely when splitting isn't available.
   */
  onSplit?: () => void;
  splitMode?: "split" | "close";
}

export function TabBar({
  tabs,
  activeTabId,
  onSelect,
  onClose,
  onNew,
  disabled,
  onTabContextMenu,
  onSplit,
  splitMode = "split",
}: Props) {
  const t = useT();
  // Scope the sliding indicator's layoutId to this TabBar so a split view's two
  // bars don't share one indicator (which would fly between panes on select).
  const indicatorId = `tab-active-indicator-${useId()}`;
  // Roving tabindex 用のタブ要素参照 (#307)。配列ではなく Map にすることで、
  // タブの追加・削除でインデックスがずれても安全に参照できる。
  const tabRefs = useRef<Map<string, HTMLElement | null>>(new Map());

  /** ArrowLeft/Right/Home/End でフォーカスとアクティブタブを同時に移動する。
   *  Enter/Space は role="tab" の div 要素では既定で click が走らないため、
   *  明示的に onSelect する。Delete はタブを閉じる (Mac の慣習に合わせ Backspace
   *  も同じ動作)。 */
  const handleTabKeyDown = useCallback(
    (currentId: string) => (e: React.KeyboardEvent<HTMLElement>) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onSelect(currentId);
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        onClose(currentId);
        return;
      }
      const idx = tabs.findIndex((tt) => tt.id === currentId);
      if (idx < 0) return;
      let nextIdx: number | null = null;
      if (e.key === "ArrowRight") nextIdx = (idx + 1) % tabs.length;
      else if (e.key === "ArrowLeft") nextIdx = (idx - 1 + tabs.length) % tabs.length;
      else if (e.key === "Home") nextIdx = 0;
      else if (e.key === "End") nextIdx = tabs.length - 1;
      if (nextIdx !== null && nextIdx !== idx) {
        const next = tabs[nextIdx];
        if (next) {
          e.preventDefault();
          onSelect(next.id);
          // setState 直後はまだ DOM が更新されていないため、次フレームでフォーカス。
          const nextId = next.id;
          requestAnimationFrame(() => tabRefs.current.get(nextId)?.focus());
        }
      }
    },
    [tabs, onSelect, onClose],
  );

  return (
    <Box
      role="tablist"
      display="flex"
      alignItems="stretch"
      borderBottom="1px solid"
      borderColor="app.border"
      bg="app.surfaceMuted"
      minH="34px"
      overflow="hidden"
    >
      <Box
        display="flex"
        flex="1"
        overflowX="auto"
        overflowY="hidden"
        css={{ scrollbarWidth: "thin" }}
      >
        <AnimatePresence initial={false}>
          {tabs.map((tab) => {
            const isActive = tab.id === activeTabId;
            const title =
              tab.kind === "table" && tab.database && tab.table
                ? `${tab.database}.${tab.table}`
                : tab.title;
            return (
              <MotionTab
                key={tab.id}
                ref={(el: HTMLElement | null) => {
                  if (el) tabRefs.current.set(tab.id, el);
                  else tabRefs.current.delete(tab.id);
                }}
                layout="position"
                role="tab"
                aria-selected={isActive}
                tabIndex={isActive ? 0 : -1}
                onKeyDown={handleTabKeyDown(tab.id)}
                title={title}
                initial={{ opacity: 0, width: 0 }}
                animate={{ opacity: 1, width: "auto" }}
                exit={{ opacity: 0, width: 0 }}
                transition={transitions.enter}
                position="relative"
                display="inline-flex"
                alignItems="center"
                gap="6px"
                pl="10px"
                pr="8px"
                py="6px"
                borderRight="1px solid"
                borderRightColor="app.border"
                borderTop="2px solid transparent"
                bg={isActive ? "app.surface" : "app.surfaceMuted"}
                color={isActive ? "app.text" : "app.textMuted"}
                cursor="pointer"
                userSelect="none"
                fontSize="sm"
                whiteSpace="nowrap"
                maxW="240px"
                flexShrink={0}
                transitionProperty="background, color, border-color, box-shadow"
                transitionDuration="var(--dur-fast)"
                transitionTimingFunction="var(--ease)"
                _hover={isActive ? undefined : { bg: "app.hover", color: "app.text" }}
                _focusVisible={{ outline: "none", boxShadow: focusRing }}
                onClick={() => onSelect(tab.id)}
                onMouseDown={(e) => {
                  if (e.button === 1) {
                    e.preventDefault();
                    onClose(tab.id);
                  }
                }}
                onContextMenu={
                  onTabContextMenu
                    ? (e) => {
                        e.preventDefault();
                        onTabContextMenu(tab.id, e.clientX, e.clientY);
                      }
                    : undefined
                }
              >
                <chakra.span
                  display="inline-block"
                  w="14px"
                  textAlign="center"
                  fontSize="sm"
                  color={isActive ? "var(--ws-accent)" : "app.textMuted"}
                  flexShrink={0}
                  aria-hidden
                >
                  <Icon name={tab.kind === "table" ? "table" : tab.kind === "explain" ? "explain" : "query"} />
                </chakra.span>
                <chakra.span overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap" maxW="180px">
                  {tab.title}
                </chakra.span>
                {tab.dirty && (
                  <chakra.span
                    display="inline-flex"
                    alignItems="center"
                    justifyContent="center"
                    w="12px"
                    fontSize="2xs"
                    lineHeight="1"
                    color="app.accent"
                    flexShrink={0}
                    title={t("tabDirty")}
                    aria-label={t("tabDirty")}
                  >
                    ●
                  </chakra.span>
                )}
                <chakra.button
                  display="inline-flex"
                  alignItems="center"
                  justifyContent="center"
                  w="18px"
                  h="18px"
                  p="0"
                  border="none"
                  bg="transparent"
                  color="app.textMuted"
                  borderRadius="sm"
                  fontSize="xs"
                  lineHeight="1"
                  cursor="pointer"
                  flexShrink={0}
                  transitionProperty="background, color, border-color, box-shadow"
                  transitionDuration="var(--dur-fast)"
                  transitionTimingFunction="var(--ease)"
                  _hover={{ bg: isActive ? "app.active" : "app.hover", color: "app.text" }}
                  aria-label={t("tabClose")}
                  title={t("tabClose")}
                  onClick={(e) => {
                    e.stopPropagation();
                    onClose(tab.id);
                  }}
                >
                  <Icon name="close" size={13} />
                </chakra.button>
                {isActive && (
                  <MotionIndicator
                    layoutId={indicatorId}
                    transition={transitions.emphasized}
                    position="absolute"
                    left="0"
                    right="0"
                    top="-2px"
                    h="2px"
                    bg="var(--ws-accent, var(--accent))"
                    aria-hidden
                  />
                )}
              </MotionTab>
            );
          })}
        </AnimatePresence>
      </Box>
      <chakra.button
        display="inline-flex"
        alignItems="center"
        justifyContent="center"
        w="30px"
        border="none"
        borderLeft="1px solid"
        borderLeftColor="app.border"
        bg="app.surfaceMuted"
        color="app.textMuted"
        fontSize="lg"
        lineHeight="1"
        cursor="pointer"
        borderRadius="0"
        flexShrink={0}
        transitionProperty="background, color, border-color, box-shadow"
        transitionDuration="var(--dur-fast)"
        transitionTimingFunction="var(--ease)"
        _hover={{ bg: "app.hover", color: "app.text" }}
        _disabled={{ opacity: 0.5, cursor: "not-allowed" }}
        onClick={onNew}
        disabled={disabled}
        title={t("tabNew")}
        aria-label={t("tabNew")}
      >
        <Icon name="plus" size={16} />
      </chakra.button>
      {onSplit && (
        <chakra.button
          display="inline-flex"
          alignItems="center"
          justifyContent="center"
          w="30px"
          border="none"
          borderLeft="1px solid"
          borderLeftColor="app.border"
          bg="app.surfaceMuted"
          color="app.textMuted"
          lineHeight="1"
          cursor="pointer"
          borderRadius="0"
          flexShrink={0}
          _hover={{ bg: "app.hover", color: "app.text" }}
          onClick={onSplit}
          title={splitMode === "close" ? t("tabClosePane") : t("tabSplit")}
          aria-label={splitMode === "close" ? t("tabClosePane") : t("tabSplit")}
        >
          <Icon name={splitMode === "close" ? "close" : "columns"} size={15} />
        </chakra.button>
      )}
    </Box>
  );
}
