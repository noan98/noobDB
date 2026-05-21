import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  api,
  CellValue,
  Column,
  ConnectionProfile,
  PreviewResult,
  QueryResult,
  listenPreviewStream,
  listenQueryStream,
} from "./api/tauri";
import { ConnectionList } from "./components/ConnectionList";
import { ConnectionForm } from "./components/ConnectionForm";
import { QueryEditor, type SchemaTable } from "./components/QueryEditor";
import { ResultGrid } from "./components/ResultGrid";
import { PreviewGrid } from "./components/PreviewGrid";
import { TabBar } from "./components/TabBar";
import { LanguageSwitcher } from "./components/LanguageSwitcher";
import { SettingsView } from "./components/SettingsView";
import { t as translate, useT } from "./i18n";
import { useSettings } from "./settings";

type Theme = "light" | "dark";

const THEME_STORAGE_KEY = "tablex.theme";

function readInitialTheme(): Theme {
  const saved = localStorage.getItem(THEME_STORAGE_KEY);
  if (saved === "light" || saved === "dark") return saved;
  if (typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches) {
    return "dark";
  }
  return "light";
}

type Status =
  | { kind: "literal"; text: string; error?: boolean }
  | { kind: "key"; key: Parameters<ReturnType<typeof useT>>[0]; vars?: Record<string, string | number>; error?: boolean };

type TabKind = "table" | "query";

interface Tab {
  id: string;
  kind: TabKind;
  title: string;
  database?: string;
  table?: string;
  sql: string;
  result: QueryResult | null;
  preview: PreviewResult | null;
  schemaTable: SchemaTable | null;
  /** True while a streaming command is feeding rows into `result`/`preview`. */
  streaming: boolean;
  /** Snapshot row cap used for the active preview stream. */
  previewRowLimit: number;
}

let tabSeq = 0;
function newTabId(): string {
  tabSeq += 1;
  return `tab_${Date.now().toString(36)}_${tabSeq.toString(36)}`;
}

function newStreamId(tabId: string): string {
  return `${tabId}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function makeQueryTab(): Tab {
  return {
    id: newTabId(),
    kind: "query",
    title: translate("tabUntitledQuery"),
    sql: "SELECT 1;",
    result: null,
    preview: null,
    schemaTable: null,
    streaming: false,
    previewRowLimit: 100,
  };
}

function emptyResult(columns: Column[]): QueryResult {
  return { columns, rows: [], rows_affected: 0, elapsed_ms: 0 };
}

function emptyPreview(): PreviewResult {
  return {
    target_table: null,
    columns: [],
    primary_key: [],
    before_rows: [],
    after_rows: [],
    rows_affected: 0,
    elapsed_ms: 0,
    truncated: false,
  };
}

export default function App() {
  const t = useT();
  const [theme, setTheme] = useState<Theme>(readInitialTheme);
  const settings = useSettings();
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  useEffect(() => {
    const colors = settings.syntaxColors[theme];
    const root = document.documentElement;
    for (const [key, val] of Object.entries(colors)) {
      root.style.setProperty(`--syntax-${key}`, val);
    }
  }, [settings, theme]);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => (prev === "dark" ? "light" : "dark"));
  }, []);

  const [profiles, setProfiles] = useState<ConnectionProfile[]>([]);
  const [selectedProfile, setSelectedProfile] = useState<ConnectionProfile | null>(null);
  const [editing, setEditing] = useState<ConnectionProfile | null>(null);
  const [showForm, setShowForm] = useState(false);

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [errorProfileId, setErrorProfileId] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "key", key: "appDisconnected" });

  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);

  const activeTab = useMemo(
    () => tabs.find((tt) => tt.id === activeTabId) ?? null,
    [tabs, activeTabId],
  );

  // Per-tab stream bookkeeping. Listener cleanup and the active stream id
  // are held in refs so we don't trigger re-renders on every batch and so
  // we can synchronously cancel from anywhere (tab close, disconnect).
  const streamUnlistenRef = useRef<Map<string, UnlistenFn>>(new Map());
  const streamIdRef = useRef<Map<string, string>>(new Map());

  const updateTab = useCallback((id: string, patch: Partial<Tab>) => {
    setTabs((prev) => prev.map((tt) => (tt.id === id ? { ...tt, ...patch } : tt)));
  }, []);

  const patchTab = useCallback((id: string, patcher: (tab: Tab) => Tab) => {
    setTabs((prev) => prev.map((tt) => (tt.id === id ? patcher(tt) : tt)));
  }, []);

  const detachStreamListener = useCallback((tabId: string) => {
    const un = streamUnlistenRef.current.get(tabId);
    if (un) {
      un();
      streamUnlistenRef.current.delete(tabId);
    }
    streamIdRef.current.delete(tabId);
  }, []);

  const cancelStreamForTab = useCallback(
    async (tabId: string) => {
      const sid = streamIdRef.current.get(tabId);
      detachStreamListener(tabId);
      if (sid) {
        try { await api.cancelStream(sid); } catch { /* best-effort */ }
      }
    },
    [detachStreamListener],
  );

  const refreshProfiles = useCallback(async () => {
    try {
      const list = await api.listProfiles();
      setProfiles(list);
    } catch (e) {
      setStatus({ kind: "key", key: "statusFailedLoadProfiles", vars: { error: String(e) }, error: true });
    }
  }, []);

  useEffect(() => {
    refreshProfiles();
  }, [refreshProfiles]);

  const closeAllTabs = useCallback(async () => {
    // Cancel any in-flight streams before tearing down tabs.
    const ids = Array.from(streamIdRef.current.keys());
    await Promise.all(ids.map((tid) => cancelStreamForTab(tid)));
    setTabs([]);
    setActiveTabId(null);
  }, [cancelStreamForTab]);

  const handleConnect = useCallback(async (profile: ConnectionProfile, password: string, passphrase: string) => {
    setConnectingId(profile.id);
    setErrorProfileId(null);
    setStatus({ kind: "key", key: "statusConnecting", vars: { name: profile.name } });
    if (sessionId) {
      try { await api.disconnect(sessionId); } catch (e) { console.warn(e); }
      setSessionId(null);
      await closeAllTabs();
    }
    try {
      const res = await api.connect({
        profile_id: profile.id,
        driver: "mysql",
        host: profile.host,
        port: profile.port,
        user: profile.user,
        password,
        database: profile.database,
        ssh: profile.ssh ? { ...profile.ssh, passphrase } : null,
      });
      setSessionId(res.session_id);
      setSelectedProfile(profile);
      const tab = makeQueryTab();
      setTabs([tab]);
      setActiveTabId(tab.id);
      setStatus({ kind: "key", key: "statusConnected", vars: { name: profile.name, id: res.session_id } });
    } catch (e) {
      setErrorProfileId(profile.id);
      setStatus({ kind: "key", key: "statusConnectionFailed", vars: { error: String(e) }, error: true });
    } finally {
      setConnectingId(null);
    }
  }, [sessionId, closeAllTabs]);

  const handleDisconnect = useCallback(async () => {
    if (!sessionId) return;
    await closeAllTabs();
    try {
      await api.disconnect(sessionId);
    } catch (e) {
      console.warn(e);
    }
    setSessionId(null);
    setSelectedProfile(null);
    setStatus({ kind: "key", key: "appDisconnected" });
  }, [sessionId, closeAllTabs]);

  // Fetch schema for the active table tab so the editor can autocomplete columns.
  useEffect(() => {
    if (!sessionId || !activeTab) return;
    if (activeTab.kind !== "table" || !activeTab.database || !activeTab.table) return;
    if (activeTab.schemaTable) return;
    let cancelled = false;
    const { id, database, table } = activeTab;
    api.describeTable(sessionId, database, table)
      .then((cols) => {
        if (cancelled) return;
        updateTab(id, {
          schemaTable: { database, name: table, columns: cols.map((c) => c.name) },
        });
      })
      .catch(() => { /* ignore */ });
    return () => { cancelled = true; };
  }, [sessionId, activeTab, updateTab]);

  // Tabs ref kept in sync so streaming callbacks below can read the latest
  // committed tab state without re-creating themselves on every batch.
  const tabsRef = useRef<Tab[]>(tabs);
  useEffect(() => { tabsRef.current = tabs; }, [tabs]);

  const nextRowCount = useCallback((tabId: string, justAdded: number) => {
    const tt = tabsRef.current.find((x) => x.id === tabId);
    if (tt?.result) return tt.result.rows.length;
    return justAdded;
  }, []);

  const runQueryInTab = useCallback(async (tabId: string, sql: string) => {
    if (!sessionId) {
      setStatus({ kind: "key", key: "statusNotConnected", error: true });
      return;
    }
    const tab = tabs.find((tt) => tt.id === tabId);
    await cancelStreamForTab(tabId);

    const streamId = newStreamId(tabId);
    streamIdRef.current.set(tabId, streamId);
    const startedAt = Date.now();
    setStatus({ kind: "key", key: "statusRunningQuery" });
    updateTab(tabId, { result: emptyResult([]), preview: null, streaming: true });

    const finalize = () => {
      const un = streamUnlistenRef.current.get(tabId);
      if (un) {
        un();
        streamUnlistenRef.current.delete(tabId);
      }
      streamIdRef.current.delete(tabId);
    };

    const unlisten = await listenQueryStream(streamId, {
      onColumns: ({ columns }) => {
        patchTab(tabId, (tt) => ({
          ...tt,
          result: { columns, rows: [], rows_affected: 0, elapsed_ms: Date.now() - startedAt },
        }));
      },
      onRows: ({ rows }) => {
        patchTab(tabId, (tt) => {
          if (!tt.result) return tt;
          return {
            ...tt,
            result: {
              ...tt.result,
              rows: [...tt.result.rows, ...rows as CellValue[][]],
              rows_affected: tt.result.rows.length + rows.length,
              elapsed_ms: Date.now() - startedAt,
            },
          };
        });
        // Update live status with current row count.
        setStatus((prev) => {
          // Only override the "running" / "streaming" status — avoid clobbering
          // an error a user is reading.
          if (prev.kind === "key" && prev.error) return prev;
          return {
            kind: "key",
            key: "statusStreaming",
            vars: { rows: nextRowCount(tabId, rows.length), ms: Date.now() - startedAt },
          };
        });
      },
      onDone: ({ totalRows, rowsAffected, elapsedMs, hasColumns }) => {
        patchTab(tabId, (tt) => {
          if (!hasColumns) {
            return {
              ...tt,
              result: { columns: [], rows: [], rows_affected: rowsAffected, elapsed_ms: elapsedMs },
              streaming: false,
            };
          }
          return {
            ...tt,
            result: tt.result
              ? { ...tt.result, elapsed_ms: elapsedMs, rows_affected: totalRows }
              : tt.result,
            streaming: false,
          };
        });
        if (hasColumns) {
          setStatus({ kind: "key", key: "statusStreamingDone", vars: { rows: totalRows, ms: elapsedMs } });
        } else {
          setStatus({ kind: "key", key: "statusRowsAffected", vars: { rows: rowsAffected, ms: elapsedMs } });
        }
        finalize();
      },
      onError: ({ error }) => {
        patchTab(tabId, (tt) => ({ ...tt, streaming: false }));
        setStatus({ kind: "key", key: "statusQueryError", vars: { error }, error: true });
        finalize();
      },
    });
    streamUnlistenRef.current.set(tabId, unlisten);

    try {
      await api.runQueryStream({
        sessionId,
        streamId,
        sql,
        database: tab?.database ?? null,
        initialBatch: settings.defaultDisplayCount,
        chunkSize: settings.streamPrefetchSize,
      });
    } catch (e) {
      patchTab(tabId, (tt) => ({ ...tt, streaming: false }));
      setStatus({ kind: "key", key: "statusQueryError", vars: { error: String(e) }, error: true });
      finalize();
    }
  }, [
    sessionId,
    tabs,
    updateTab,
    patchTab,
    cancelStreamForTab,
    settings.defaultDisplayCount,
    settings.streamPrefetchSize,
  ]);

  const previewQueryInTab = useCallback(async (tabId: string, sql: string) => {
    if (!sessionId) {
      setStatus({ kind: "key", key: "statusNotConnected", error: true });
      return;
    }
    const tab = tabs.find((tt) => tt.id === tabId);
    await cancelStreamForTab(tabId);

    const streamId = newStreamId(tabId);
    streamIdRef.current.set(tabId, streamId);
    const startedAt = Date.now();
    setStatus({ kind: "key", key: "statusRunningPreview" });
    const rowLimit = settings.defaultDisplayCount;
    updateTab(tabId, {
      result: null,
      preview: emptyPreview(),
      streaming: true,
      previewRowLimit: rowLimit,
    });

    const finalize = () => {
      const un = streamUnlistenRef.current.get(tabId);
      if (un) {
        un();
        streamUnlistenRef.current.delete(tabId);
      }
      streamIdRef.current.delete(tabId);
    };

    const unlisten = await listenPreviewStream(streamId, {
      onMeta: ({ targetTable, columns, primaryKey, rowsAffected, elapsedMs, truncated }) => {
        patchTab(tabId, (tt) => ({
          ...tt,
          preview: {
            target_table: targetTable,
            columns,
            primary_key: primaryKey,
            before_rows: [],
            after_rows: [],
            rows_affected: rowsAffected,
            elapsed_ms: elapsedMs,
            truncated,
          },
        }));
      },
      onBeforeRows: ({ rows }) => {
        patchTab(tabId, (tt) => {
          if (!tt.preview) return tt;
          return {
            ...tt,
            preview: { ...tt.preview, before_rows: [...tt.preview.before_rows, ...rows as CellValue[][]] },
          };
        });
        setStatus((prev) => {
          if (prev.kind === "key" && prev.error) return prev;
          return { kind: "key", key: "statusPreviewStreaming", vars: { ms: Date.now() - startedAt } };
        });
      },
      onAfterRows: ({ rows }) => {
        patchTab(tabId, (tt) => {
          if (!tt.preview) return tt;
          return {
            ...tt,
            preview: { ...tt.preview, after_rows: [...tt.preview.after_rows, ...rows as CellValue[][]] },
          };
        });
      },
      onDone: () => {
        patchTab(tabId, (tt) => ({ ...tt, streaming: false }));
        const tt = tabsRef.current.find((x) => x.id === tabId);
        const rowsAffected = tt?.preview?.rows_affected ?? 0;
        const elapsedMs = tt?.preview?.elapsed_ms ?? Date.now() - startedAt;
        setStatus({
          kind: "key",
          key: "statusPreviewDone",
          vars: { rows: rowsAffected, ms: elapsedMs },
        });
        finalize();
      },
      onError: ({ error }) => {
        patchTab(tabId, (tt) => ({ ...tt, streaming: false }));
        setStatus({ kind: "key", key: "statusPreviewError", vars: { error }, error: true });
        finalize();
      },
    });
    streamUnlistenRef.current.set(tabId, unlisten);

    try {
      await api.previewQueryStream({
        sessionId,
        streamId,
        sql,
        database: tab?.database ?? null,
        rowLimit,
        chunkSize: settings.streamPrefetchSize,
      });
    } catch (e) {
      patchTab(tabId, (tt) => ({ ...tt, streaming: false }));
      setStatus({ kind: "key", key: "statusPreviewError", vars: { error: String(e) }, error: true });
      finalize();
    }
  }, [
    sessionId,
    tabs,
    updateTab,
    patchTab,
    cancelStreamForTab,
    settings.defaultDisplayCount,
    settings.streamPrefetchSize,
  ]);

  const handleRunQuery = useCallback((sql: string) => {
    if (!activeTab) return;
    runQueryInTab(activeTab.id, sql);
  }, [activeTab, runQueryInTab]);

  const handlePreviewQuery = useCallback((sql: string) => {
    if (!activeTab) return;
    previewQueryInTab(activeTab.id, sql);
  }, [activeTab, previewQueryInTab]);

  const handleEditorChange = useCallback((sql: string) => {
    if (!activeTab) return;
    updateTab(activeTab.id, { sql });
  }, [activeTab, updateTab]);

  const handleOpenTable = useCallback((database: string, table: string) => {
    const existing = tabs.find(
      (tt) => tt.kind === "table" && tt.database === database && tt.table === table,
    );
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }
    const limit = Math.max(1, settings.defaultDisplayCount);
    const sql = `SELECT * FROM \`${database}\`.\`${table}\` LIMIT ${limit}`;
    const tab: Tab = {
      id: newTabId(),
      kind: "table",
      title: table,
      database,
      table,
      sql,
      result: null,
      preview: null,
      schemaTable: null,
      streaming: false,
      previewRowLimit: limit,
    };
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(tab.id);
    runQueryInTab(tab.id, sql);
  }, [tabs, runQueryInTab, settings.defaultDisplayCount]);

  const handleNewTab = useCallback(() => {
    const tab = makeQueryTab();
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(tab.id);
  }, []);

  const handleCloseTab = useCallback((id: string) => {
    cancelStreamForTab(id);
    setTabs((prev) => {
      const idx = prev.findIndex((tt) => tt.id === id);
      if (idx === -1) return prev;
      const next = prev.filter((tt) => tt.id !== id);
      if (id === activeTabId) {
        const neighbor = next[idx] ?? next[idx - 1] ?? null;
        setActiveTabId(neighbor ? neighbor.id : null);
      }
      return next;
    });
  }, [activeTabId, cancelStreamForTab]);

  // Clean up any active listeners when the app unmounts.
  useEffect(() => {
    return () => {
      for (const un of streamUnlistenRef.current.values()) {
        try { un(); } catch { /* ignore */ }
      }
      streamUnlistenRef.current.clear();
      streamIdRef.current.clear();
    };
  }, []);

  const statusText = status.kind === "literal" ? status.text : t(status.key, status.vars);

  return (
    <div className="app">
      <aside className="sidebar">
        <header>
          <span className="sidebar-title">{t("appConnections")}</span>
          <div className="header-actions">
            <button
              className="icon"
              onClick={toggleTheme}
              title={theme === "dark" ? t("appThemeToLight") : t("appThemeToDark")}
              aria-label={t("appThemeToggle")}
            >
              {theme === "dark" ? "☀" : "☾"}
            </button>
            <button
              className="icon"
              onClick={() => { setShowForm(false); setShowSettings(true); }}
              title={t("appSettings")}
              aria-label={t("appSettings")}
            >
              ⚙
            </button>
            <button
              className="icon"
              onClick={() => { setEditing(null); setShowSettings(false); setShowForm(true); }}
              title={t("appNew")}
              aria-label={t("appNew")}
            >
              +
            </button>
          </div>
        </header>
        <ConnectionList
          profiles={profiles}
          activeProfileId={selectedProfile?.id ?? null}
          sessionId={sessionId}
          connectingId={connectingId}
          errorProfileId={errorProfileId}
          onConnect={handleConnect}
          onEdit={(p) => { setEditing(p); setShowForm(true); }}
          onDelete={async (id) => {
            await api.deleteProfile(id);
            await refreshProfiles();
          }}
          onPickTable={handleOpenTable}
        />
        <div className="sidebar-footer">
          <LanguageSwitcher />
        </div>
      </aside>

      <main className="main">
        {showSettings ? (
          <SettingsView theme={theme} onClose={() => setShowSettings(false)} />
        ) : showForm ? (
          <ConnectionForm
            initial={editing}
            onSaved={async () => {
              setShowForm(false);
              await refreshProfiles();
            }}
            onCancel={() => setShowForm(false)}
          />
        ) : (
          <>
            <div className="topbar">
              <div className="topbar-info">
                {selectedProfile ? (
                  <>
                    <span className="status-dot status-connected" aria-hidden />
                    <span className="topbar-name">{selectedProfile.name}</span>
                    <span className="topbar-meta">
                      {selectedProfile.user}@{selectedProfile.host}:{selectedProfile.port}
                      {selectedProfile.database ? `/${selectedProfile.database}` : ""}
                    </span>
                  </>
                ) : (
                  <>
                    <span className="status-dot status-idle" aria-hidden />
                    <span className="topbar-meta">{t("appDisconnected")}</span>
                  </>
                )}
              </div>
              <div style={{ flex: 1 }} />
              {sessionId && <button onClick={handleDisconnect}>{t("appDisconnect")}</button>}
            </div>

            {sessionId && (
              <TabBar
                tabs={tabs.map((tt) => ({
                  id: tt.id,
                  kind: tt.kind,
                  title: tt.title,
                  database: tt.database,
                  table: tt.table,
                }))}
                activeTabId={activeTabId}
                onSelect={setActiveTabId}
                onClose={handleCloseTab}
                onNew={handleNewTab}
              />
            )}

            <div className="pane">
              {activeTab ? (
                <>
                  <QueryEditor
                    key={activeTab.id}
                    initialSql={activeTab.sql}
                    onRun={handleRunQuery}
                    onPreview={handlePreviewQuery}
                    onChange={handleEditorChange}
                    disabled={!sessionId}
                    schemaTable={activeTab.schemaTable}
                    activeTable={
                      activeTab.kind === "table" && activeTab.database && activeTab.table
                        ? { database: activeTab.database, name: activeTab.table }
                        : null
                    }
                  />
                  {activeTab.preview ? (
                    <PreviewGrid
                      result={activeTab.preview}
                      rowLimit={activeTab.previewRowLimit}
                      streaming={activeTab.streaming}
                    />
                  ) : (
                    <ResultGrid result={activeTab.result} streaming={activeTab.streaming} />
                  )}
                </>
              ) : (
                <div className="pane-empty">
                  {sessionId ? t("tabsEmpty") : t("editorHintDisabled")}
                </div>
              )}
            </div>
          </>
        )}

        <div className={`status ${status.error ? "error" : ""}`}>{statusText}</div>
      </main>
    </div>
  );
}
