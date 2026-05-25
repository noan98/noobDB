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
}

export function TabBar({ tabs, activeTabId, onSelect, onClose, onNew, disabled }: Props) {
  const t = useT();

  return (
    <div className="tabbar" role="tablist">
      <div className="tabbar-tabs">
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          const title =
            tab.kind === "table" && tab.database && tab.table
              ? `${tab.database}.${tab.table}`
              : tab.title;
          return (
            <div
              key={tab.id}
              className={`tab ${isActive ? "active" : ""}`}
              role="tab"
              aria-selected={isActive}
              title={title}
              onClick={() => onSelect(tab.id)}
              onMouseDown={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  onClose(tab.id);
                }
              }}
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
            </div>
          );
        })}
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
    </div>
  );
}
