import { useId } from "react";
import { Box, chakra } from "@chakra-ui/react";
import { AnimatePresence, motion } from "motion/react";
import { useT } from "../i18n";
import { Icon } from "./Icon";

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
                layout="position"
                role="tab"
                aria-selected={isActive}
                title={title}
                initial={{ opacity: 0, width: 0 }}
                animate={{ opacity: 1, width: "auto" }}
                exit={{ opacity: 0, width: 0 }}
                transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
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
                    transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
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
