import { useEffect, useRef, useState } from "react";
import { Box, chakra } from "@chakra-ui/react";
import { api, ConnectionProfile, HistoryEntry } from "../api/tauri";
import { useT } from "../i18n";
import { Icon } from "./Icon";
import { EmptyState } from "./EmptyState";
import { Button, Checkbox, Input } from "./ui";
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
    <Box className="tree-pane">
      <Box className="tree-search">
        <Input
          type="search"
          placeholder={t("historySearchPlaceholder")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {activeProfile && (
          <chakra.label className="snippet-scope-toggle">
            <Checkbox
              checked={showAll}
              onChange={(e) => setShowAll(e.target.checked)}
            />
            {t("historyShowAll")}
          </chakra.label>
        )}
      </Box>

      {entries.length > 0 && (
        <Box className="tree-search" borderTop="none" pt={0}>
          <Button type="button" variant="danger" onClick={handleClear}>
            {t("historyClear")}
          </Button>
        </Box>
      )}

      {error ? (
        <chakra.p className="muted text-error" p="12px">{error}</chakra.p>
      ) : entries.length === 0 ? (
        debounced ? (
          <chakra.p className="muted" p="12px">{t("historyNoMatches")}</chakra.p>
        ) : (
          <EmptyState icon="clock" title={t("historyEmptyTitle")} description={t("historyEmpty")} />
        )
      ) : (
        <Box className="tree" role="tree">
          {entries.map((h) => {
            const failed = h.status === "error";
            const meta =
              h.rows != null
                ? t("historyRowsMeta", { rows: h.rows })
                : h.rows_affected != null
                  ? t("historyAffectedMeta", { rows: h.rows_affected })
                  : "";
            return (
              <Box key={h.id} className="tree-node snippet history">
                <Box
                  className="tree-row snippet-row"
                  role="treeitem"
                  onClick={() => onRestore(h.sql)}
                  title={`${t("historyRestoreHint")}\n\n${h.sql}`}
                >
                  <chakra.span className="tree-chevron empty" aria-hidden />
                  <chakra.span className="tree-icon snippet-icon" aria-hidden>
                    <Icon name={failed ? "close" : "refresh"} />
                  </chakra.span>
                  <chakra.span className="tree-label">{oneLine(h.sql)}</chakra.span>
                  {failed && (
                    <chakra.span className="tree-badge read-only-badge">
                      {t("historyStatusError")}
                    </chakra.span>
                  )}
                  {!failed && meta && <chakra.span className="tree-badge">{meta}</chakra.span>}
                  {h.elapsed_ms != null && (
                    <chakra.span className="tree-badge driver">{h.elapsed_ms} ms</chakra.span>
                  )}
                  <chakra.span className="history-row-actions">
                    <chakra.button
                      type="button"
                      className="icon history-action"
                      title={copiedId === h.id ? t("historyCopied") : t("historyCopySql")}
                      aria-label={t("historyCopySql")}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleCopy(h.id, h.sql);
                      }}
                    >
                      <Icon name={copiedId === h.id ? "check" : "copy"} />
                    </chakra.button>
                    <chakra.button
                      type="button"
                      className="icon history-action"
                      title={t("historyOpenInNewTab")}
                      aria-label={t("historyOpenInNewTab")}
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenInNewTab(h.sql);
                      }}
                    >
                      <Icon name="query" />
                    </chakra.button>
                  </chakra.span>
                </Box>
                <Box className="history-time muted">{formatTime(h.executed_at)}</Box>
              </Box>
            );
          })}
        </Box>
      )}
    </Box>
  );
}
