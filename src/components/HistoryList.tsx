import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Box, chakra } from "@chakra-ui/react";
import { api, ConnectionProfile, HistoryEntry } from "../api/tauri";
import { I18nKey, useT } from "../i18n";
import { transitions, variants } from "../motion";
import { Icon, ICON_SIZES } from "./Icon";
import { EmptyState } from "./EmptyState";
import { FlightRecorderPanel } from "./FlightRecorderPanel";
import { Checkbox, Input, PressableButton } from "./ui";
import {
  MotionTreeNode,
  ScopeToggle,
  Tree,
  TreeBadge,
  TreeChevron,
  TreeIcon,
  TreeLabel,
  TreePane,
  TreeRow,
  TreeSearch,
} from "./tree";
import { copyToClipboard } from "./clipboard";
import { useConfirm } from "./ConfirmDialog";
import { useToast } from "./Toast";
import {
  HISTORY_PERIOD_FILTERS,
  HISTORY_STATUS_FILTERS,
  historyPeriodRange,
  HistoryPeriodFilter,
  historyStatusParam,
  HistoryStatusFilter,
} from "./historyFilters";
import { Tooltip } from "./Tooltip";

// ステータス/期間の 2 択セグメント。SettingsView の SettingsSegment と同じ
// 見た目のローカル版 (この 1 画面でしか使わないため共有コンポーネント化はしない)。
const FilterSegment = chakra("div", {
  base: {
    display: "inline-flex",
    border: "1px solid",
    borderColor: "app.borderStrong",
    borderRadius: "md",
    overflow: "hidden",
    flexShrink: 0,
  },
});

const FilterSegmentButton = chakra("button", {
  base: {
    px: "2.5",
    py: "3px",
    fontSize: "xs",
    fontWeight: 500,
    border: "none",
    borderRadius: 0,
    background: "app.surface",
    color: "app.text",
    cursor: "pointer",
    transitionProperty: "background, color",
    transitionDuration: "var(--dur-fast)",
    transitionTimingFunction: "var(--ease)",
    _hover: { background: "app.hover" },
    "&[aria-pressed=true]": {
      background: "app.accent",
      color: "app.accentText",
    },
    "&[aria-pressed=true]:hover": { background: "app.accentHover" },
    "& + &": { borderLeft: "1px solid var(--border-strong)" },
  },
});

const STATUS_FILTER_LABEL_KEYS: Record<HistoryStatusFilter, I18nKey> = {
  all: "historyStatusFilterAll",
  ok: "historyStatusFilterOk",
  error: "historyStatusFilterError",
};

const PERIOD_FILTER_LABEL_KEYS: Record<HistoryPeriodFilter, I18nKey> = {
  all: "historyPeriodFilterAll",
  today: "historyPeriodFilterToday",
  "7d": "historyPeriodFilterWeek",
};

interface Props {
  activeProfile: ConnectionProfile | null;
  /** アクティブなセッション。DML フライトレコーダの巻き戻し (#735) の適用先。 */
  sessionId: string | null;
  /** Bumped by the parent to force a reload (e.g. after a query runs). */
  reloadKey: number;
  onRestore: (sql: string) => void;
  /** Open the entry's SQL in a brand-new query tab (never overwrites the editor). */
  onOpenInNewTab: (sql: string) => void;
  /**
   * Promote a history entry's SQL to a saved snippet (#878). Opens the shared
   * `SnippetForm` with the SQL prefilled — the actual `save_snippet` IPC call
   * happens there, so this handler is just the "open the form" step. Omitted
   * entirely hides the row action (kept optional for callers/tests that don't
   * wire snippets, mirroring the existing optional `onNewQuery`).
   */
  onSaveAsSnippet?: (sql: string) => void;
  /**
   * Empty-state CTA: open a fresh query tab so a first-time user has an
   * obvious next step ("run something and it'll show up here"). Omitted while
   * disconnected, since there is nothing to run yet (#599).
   */
  onNewQuery?: () => void;
}

function oneLine(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

// memo 化して App.tsx の高頻度な再レンダリングから切り離す。props は親で
// useCallback 安定化済み。i18n は内部の useT 購読で追従する。
export const HistoryList = memo(function HistoryList({ activeProfile, sessionId, reloadKey, onRestore, onOpenInNewTab, onSaveAsSnippet, onNewQuery }: Props) {
  const t = useT();
  const toast = useToast();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const [flightRecorderOpen, setFlightRecorderOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [statusFilter, setStatusFilter] = useState<HistoryStatusFilter>("all");
  const [periodFilter, setPeriodFilter] = useState<HistoryPeriodFilter>("all");
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const copiedTimer = useRef<number | null>(null);

  useEffect(() => () => {
    if (copiedTimer.current) window.clearTimeout(copiedTimer.current);
  }, []);

  const handleCopy = async (id: number, sql: string) => {
    const ok = await copyToClipboard(sql);
    if (!ok) {
      toast.error(t("clipboardCopyFailed"));
      return;
    }
    setCopiedId(id);
    if (copiedTimer.current) window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => setCopiedId(null), 1500);
  };

  // Debounce the search box so each keystroke doesn't hit the backend.
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(search), 200);
    return () => window.clearTimeout(id);
  }, [search]);

  // Scope to the active profile unless "show all" is on. When disconnected
  // there is no active profile, so everything is shown.
  const scopeId = showAll ? null : activeProfile?.id ?? null;
  const statusParam = historyStatusParam(statusFilter);
  // Memoized so re-renders unrelated to the period filter (e.g. the copy-icon
  // timer) don't recompute `now` and spuriously re-trigger the fetch effect
  // below with a millisecond-shifted `from` bound.
  const { from, to } = useMemo(() => historyPeriodRange(periodFilter), [periodFilter]);
  const hasActiveFilter = Boolean(debounced) || statusFilter !== "all" || periodFilter !== "all";

  useEffect(() => {
    let cancelled = false;
    api
      .listHistory({ profileId: scopeId, search: debounced || null, status: statusParam, from, to })
      .then((rows) => {
        if (!cancelled) {
          setEntries(rows);
          setError(null);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [scopeId, debounced, statusParam, from, to, reloadKey]);

  const handleClear = async () => {
    const msg = scopeId
      ? t("historyClearConfirmProfile", { name: activeProfile?.name ?? "" })
      : t("historyClearConfirmAll");
    const ok = await confirm({
      title: t("historyClear"),
      message: msg,
      confirmLabel: t("historyClear"),
      tone: "danger",
    });
    if (!ok) return;
    try {
      await api.clearHistory(scopeId);
      const rows = await api.listHistory({
        profileId: scopeId,
        search: debounced || null,
        status: statusParam,
        from,
        to,
      });
      setEntries(rows);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <TreePane>
      <TreeSearch>
        <Input
          type="search"
          placeholder={t("historySearchPlaceholder")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {activeProfile && (
          <ScopeToggle>
            <Checkbox
              checked={showAll}
              onChange={(e) => setShowAll(e.target.checked)}
            />
            {t("historyShowAll")}
          </ScopeToggle>
        )}
      </TreeSearch>

      <TreeSearch borderTop="none" pt={0} display="flex" flexWrap="wrap" alignItems="center" gap="2">
        <FilterSegment role="group" aria-label={t("historyStatusFilterLabel")}>
          {HISTORY_STATUS_FILTERS.map((s) => (
            <FilterSegmentButton
              key={s}
              type="button"
              aria-pressed={statusFilter === s}
              onClick={() => setStatusFilter(s)}
            >
              {t(STATUS_FILTER_LABEL_KEYS[s])}
            </FilterSegmentButton>
          ))}
        </FilterSegment>
        <FilterSegment role="group" aria-label={t("historyPeriodFilterLabel")}>
          {HISTORY_PERIOD_FILTERS.map((p) => (
            <FilterSegmentButton
              key={p}
              type="button"
              aria-pressed={periodFilter === p}
              onClick={() => setPeriodFilter(p)}
            >
              {t(PERIOD_FILTER_LABEL_KEYS[p])}
            </FilterSegmentButton>
          ))}
        </FilterSegment>
      </TreeSearch>

      <TreeSearch borderTop="none" pt={0} display="flex" gap="1.5">
        <PressableButton type="button" variant="secondary" onClick={() => setFlightRecorderOpen(true)}>
          <Icon name="undo" size={ICON_SIZES.sm} /> {t("flightRecorderTitle")}
        </PressableButton>
        {entries.length > 0 && (
          <PressableButton type="button" variant="danger" onClick={handleClear}>
            {t("historyClear")}
          </PressableButton>
        )}
      </TreeSearch>
      {flightRecorderOpen && (
        <FlightRecorderPanel
          profileId={activeProfile?.id ?? null}
          sessionId={sessionId}
          onClose={() => setFlightRecorderOpen(false)}
        />
      )}

      {error ? (
        <chakra.p color="app.textError" p="3">{error}</chakra.p>
      ) : entries.length === 0 ? (
        hasActiveFilter ? (
          <chakra.p color="app.textMuted" p="3">{t("historyNoMatches")}</chakra.p>
        ) : (
          <EmptyState
            icon="clock"
            title={t("historyEmptyTitle")}
            description={t("historyEmpty")}
            action={onNewQuery ? { label: t("tabsNewQuery"), onClick: onNewQuery } : undefined}
          />
        )
      ) : (
        <Tree role="tree">
          {/* 履歴は検索/スコープ変更のたびに丸ごと入れ替わり、件数も多くなりうる。
              enter/exit の AnimatePresence で全件を出入りさせると重く・うるさく
              なるため、ここは「控えめ」方針に従い、マウント時の
              opacity フェードイン (enter のみ・height 補間なし) に留める。新しい
              クエリ実行で先頭に積まれた項目が軽く出現し、削除は即時。 */}
          {entries.map((h) => {
            const failed = h.status === "error";
            const meta =
              h.rows != null
                ? t("historyRowsMeta", { rows: h.rows })
                : h.rows_affected != null
                  ? t("historyAffectedMeta", { rows: h.rows_affected })
                  : "";
            return (
              <MotionTreeNode
                key={h.id}
                initial={variants.fade.initial}
                animate={variants.fade.animate}
                transition={transitions.crossfade}
              >
                <Tooltip label={`${t("historyRestoreHint")}\n\n${h.sql}`}>
                  <TreeRow
                    position="relative"
                    role="treeitem"
                    tabIndex={0}
                    onClick={() => onRestore(h.sql)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onRestore(h.sql);
                      }
                    }}
                    css={{
                      "&:hover [data-row-actions], &:focus-within [data-row-actions]": {
                        opacity: 1,
                        pointerEvents: "auto",
                      },
                    }}
                  >
                    <TreeChevron visibility="hidden" aria-hidden />
                    <TreeIcon color="app.accent" aria-hidden>
                      <Icon name={failed ? "close" : "refresh"} />
                    </TreeIcon>
                    <TreeLabel fontFamily="mono">{oneLine(h.sql)}</TreeLabel>
                    {failed && (
                      <TreeBadge
                        bg="var(--status-info, var(--bg-muted))"
                        color="app.text"
                        borderColor="app.borderStrong"
                        fontWeight={700}
                      >
                        {t("historyStatusError")}
                      </TreeBadge>
                    )}
                    {!failed && meta && <TreeBadge>{meta}</TreeBadge>}
                    {h.elapsed_ms != null && <TreeBadge>{h.elapsed_ms} ms</TreeBadge>}
                    <chakra.span
                      data-row-actions=""
                      position="absolute"
                      top="0"
                      right="0"
                      bottom="0"
                      display="flex"
                      alignItems="center"
                      gap="0.5"
                      pl="4"
                      pr="1.5"
                      background="linear-gradient(to right, transparent, var(--bg-hover) 28%)"
                      opacity={0}
                      pointerEvents="none"
                      transitionProperty="opacity"
                      transitionDuration="var(--dur-fast)"
                      transitionTimingFunction="var(--ease)"
                    >
                      <Tooltip label={copiedId === h.id ? t("historyCopied") : t("historyCopySql")}>
                        <chakra.button
                          type="button"
                          minW="0"
                          w="24px"
                          h="24px"
                          p="0"
                          display="inline-flex"
                          alignItems="center"
                          justifyContent="center"
                          color="app.textSecondary"
                          _hover={{ color: "app.text" }}
                          aria-label={t("historyCopySql")}
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleCopy(h.id, h.sql);
                          }}
                        >
                          <Icon name={copiedId === h.id ? "check" : "copy"} size={ICON_SIZES.md} />
                        </chakra.button>
                      </Tooltip>
                      <Tooltip label={t("historyOpenInNewTab")}>
                        <chakra.button
                          type="button"
                          minW="0"
                          w="24px"
                          h="24px"
                          p="0"
                          display="inline-flex"
                          alignItems="center"
                          justifyContent="center"
                          color="app.textSecondary"
                          _hover={{ color: "app.text" }}
                          aria-label={t("historyOpenInNewTab")}
                          onClick={(e) => {
                            e.stopPropagation();
                            onOpenInNewTab(h.sql);
                          }}
                        >
                          <Icon name="query" size={ICON_SIZES.md} />
                        </chakra.button>
                      </Tooltip>
                      {onSaveAsSnippet && (
                        <Tooltip label={t("historySaveAsSnippet")}>
                          <chakra.button
                            type="button"
                            minW="0"
                            w="24px"
                            h="24px"
                            p="0"
                            display="inline-flex"
                            alignItems="center"
                            justifyContent="center"
                            color="app.textSecondary"
                            _hover={{ color: "app.text" }}
                            aria-label={t("historySaveAsSnippet")}
                            onClick={(e) => {
                              e.stopPropagation();
                              onSaveAsSnippet(h.sql);
                            }}
                          >
                            <Icon name="snippet" size={ICON_SIZES.md} />
                          </chakra.button>
                        </Tooltip>
                      )}
                    </chakra.span>
                  </TreeRow>
                </Tooltip>
                <Box pt="0" pr="1.5" pb="1" pl="28px" fontSize="2xs" color="app.textMuted">
                  {formatTime(h.executed_at)}
                </Box>
              </MotionTreeNode>
            );
          })}
        </Tree>
      )}
      {confirmDialog}
    </TreePane>
  );
});
