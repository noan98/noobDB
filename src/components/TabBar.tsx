import { useId } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useT } from "../i18n";
import { Icon } from "./Icon";

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
    <div className="tabbar" role="tablist">
      <div className="tabbar-tabs">
        <AnimatePresence initial={false}>
          {tabs.map((tab) => {
            const isActive = tab.id === activeTabId;
            const title =
              tab.kind === "table" && tab.database && tab.table
                ? `${tab.database}.${tab.table}`
                : tab.title;
            return (
              <motion.div
                key={tab.id}
                layout="position"
                className={`tab ${isActive ? "active" : ""}`}
                role="tab"
                aria-selected={isActive}
                title={title}
                initial={{ opacity: 0, width: 0 }}
                animate={{ opacity: 1, width: "auto" }}
                exit={{ opacity: 0, width: 0 }}
                transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
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
                <span className="tab-icon" aria-hidden>
                  <Icon name={tab.kind === "table" ? "table" : tab.kind === "explain" ? "explain" : "query"} />
                </span>
                <span className="tab-label">{tab.title}</span>
                {tab.dirty && (
                  <span className="tab-dirty" title={t("tabDirty")} aria-label={t("tabDirty")}>
                    ●
                  </span>
                )}
                <button
                  className="tab-close"
                  aria-label={t("tabClose")}
                  title={t("tabClose")}
                  onClick={(e) => {
                    e.stopPropagation();
                    onClose(tab.id);
                  }}
                >
                  <Icon name="close" size={13} />
                </button>
                {isActive && (
                  <motion.span
                    className="tab-active-indicator"
                    layoutId={indicatorId}
                    transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
                    aria-hidden
                  />
                )}
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
      <button
        className="tab-new"
        onClick={onNew}
        disabled={disabled}
        title={t("tabNew")}
        aria-label={t("tabNew")}
      >
        <Icon name="plus" size={16} />
      </button>
      {onSplit && (
        <button
          className={`tab-split${splitMode === "close" ? " is-close" : ""}`}
          onClick={onSplit}
          title={splitMode === "close" ? t("tabClosePane") : t("tabSplit")}
          aria-label={splitMode === "close" ? t("tabClosePane") : t("tabSplit")}
        >
          <Icon name={splitMode === "close" ? "close" : "columns"} size={15} />
        </button>
      )}
    </div>
  );
}
