import { useEffect, useRef, useState } from "react";
import { Box, chakra } from "@chakra-ui/react";
import { api, ConnectionProfile, HistoryEntry } from "../api/tauri";
import { useT } from "../i18n";
import { Icon } from "./Icon";
import { EmptyState } from "./EmptyState";
import { Button, Checkbox, Input } from "./ui";
import {
  ScopeToggle,
  Tree,
  TreeBadge,
  TreeChevron,
  TreeIcon,
  TreeLabel,
  TreeNode,
  TreePane,
  TreeRow,
  TreeSearch,
} from "./tree";
import { copyToClipboard } from "./clipboard";

interface Props {
  activeProfile: ConnectionProfile | null;
  /** Bumped by the parent to force a reload (e.g. after a query runs). */
  reloadKey: number;
  onRestore: (sql: string) => void;
  /** Open the entry's SQL in a brand-new query tab (never overwrites the editor). */
  onOpenInNewTab: (sql: string) => void;
}

function oneLine(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

export function HistoryList({ activeProfile, reloadKey, onRestore, onOpenInNewTab }: Props) {
  const t = useT();
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const copiedTimer = useRef<number | null>(null);

  useEffect(() => () => {
    if (copiedTimer.current) window.clearTimeout(copiedTimer.current);
  }, []);

  const handleCopy = (id: number, sql: string) => {
    void copyToClipboard(sql);
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

  useEffect(() => {
    let cancelled = false;
    api
      .listHistory({ profileId: scopeId, search: debounced || null })
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
  }, [scopeId, debounced, reloadKey]);

  const handleClear = async () => {
    const msg = scopeId
      ? t("historyClearConfirmProfile", { name: activeProfile?.name ?? "" })
      : t("historyClearConfirmAll");
    if (!window.confirm(msg)) return;
    try {
      await api.clearHistory(scopeId);
      const rows = await api.listHistory({ profileId: scopeId, search: debounced || null });
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

      {entries.length > 0 && (
        <TreeSearch borderTop="none" pt={0}>
          <Button type="button" variant="danger" onClick={handleClear}>
            {t("historyClear")}
          </Button>
        </TreeSearch>
      )}

      {error ? (
        <chakra.p color="app.textError" p="12px">{error}</chakra.p>
      ) : entries.length === 0 ? (
        debounced ? (
          <chakra.p color="app.textMuted" p="12px">{t("historyNoMatches")}</chakra.p>
        ) : (
          <EmptyState icon="clock" title={t("historyEmptyTitle")} description={t("historyEmpty")} />
        )
      ) : (
        <Tree role="tree">
          {entries.map((h) => {
            const failed = h.status === "error";
            const meta =
              h.rows != null
                ? t("historyRowsMeta", { rows: h.rows })
                : h.rows_affected != null
                  ? t("historyAffectedMeta", { rows: h.rows_affected })
                  : "";
            return (
              <TreeNode key={h.id}>
                <TreeRow
                  position="relative"
                  role="treeitem"
                  onClick={() => onRestore(h.sql)}
                  title={`${t("historyRestoreHint")}\n\n${h.sql}`}
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
                      letterSpacing="0.05em"
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
                    gap="2px"
                    pl="16px"
                    pr="6px"
                    background="linear-gradient(to right, transparent, var(--bg-hover) 28%)"
                    opacity={0}
                    pointerEvents="none"
                    transitionProperty="opacity"
                    transitionDuration="var(--dur-fast)"
                    transitionTimingFunction="var(--ease)"
                  >
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
                      title={copiedId === h.id ? t("historyCopied") : t("historyCopySql")}
                      aria-label={t("historyCopySql")}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleCopy(h.id, h.sql);
                      }}
                    >
                      <Icon name={copiedId === h.id ? "check" : "copy"} size={15} />
                    </chakra.button>
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
                      title={t("historyOpenInNewTab")}
                      aria-label={t("historyOpenInNewTab")}
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenInNewTab(h.sql);
                      }}
                    >
                      <Icon name="query" size={15} />
                    </chakra.button>
                  </chakra.span>
                </TreeRow>
                <Box pt="0" pr="6px" pb="4px" pl="28px" fontSize="2xs" color="app.textMuted">
                  {formatTime(h.executed_at)}
                </Box>
              </TreeNode>
            );
          })}
        </Tree>
      )}
    </TreePane>
  );
}
