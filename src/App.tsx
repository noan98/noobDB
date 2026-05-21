import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ConnectionProfile, PreviewResult, QueryResult } from "./api/tauri";
import { ConnectionList } from "./components/ConnectionList";
import { ConnectionForm } from "./components/ConnectionForm";
import { QueryEditor, type SchemaTable } from "./components/QueryEditor";
import { ResultGrid } from "./components/ResultGrid";
import { PreviewGrid } from "./components/PreviewGrid";
import { TabBar } from "./components/TabBar";
import { LanguageSwitcher } from "./components/LanguageSwitcher";
import { SettingsView } from "./components/SettingsView";
import { Splitter } from "./components/Splitter";
import { t as translate, useT } from "./i18n";
import { useSettings } from "./settings";

const PREVIEW_ROW_LIMIT = 100;

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
}

let tabSeq = 0;
function newTabId(): string {
  tabSeq += 1;
  return `tab_${Date.now().toString(36)}_${tabSeq.toString(36)}`;
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

  const updateTab = useCallback((id: string, patch: Partial<Tab>) => {
    setTabs((prev) => prev.map((tt) => (tt.id === id ? { ...tt, ...patch } : tt)));
  }, []);

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

  const closeAllTabs = useCallback(() => {
    setTabs([]);
    setActiveTabId(null);
  }, []);

  const handleConnect = useCallback(async (profile: ConnectionProfile, password: string, passphrase: string) => {
    setConnectingId(profile.id);
    setErrorProfileId(null);
    setStatus({ kind: "key", key: "statusConnecting", vars: { name: profile.name } });
    if (sessionId) {
      try { await api.disconnect(sessionId); } catch (e) { console.warn(e); }
      setSessionId(null);
      closeAllTabs();
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
    try {
      await api.disconnect(sessionId);
    } catch (e) {
      console.warn(e);
    }
    setSessionId(null);
    setSelectedProfile(null);
    closeAllTabs();
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

  const runQueryInTab = useCallback(async (tabId: string, sql: string) => {
    if (!sessionId) {
      setStatus({ kind: "key", key: "statusNotConnected", error: true });
      return;
    }
    const tab = tabs.find((tt) => tt.id === tabId);
    setStatus({ kind: "key", key: "statusRunningQuery" });
    try {
      const r = await api.runQuery(sessionId, sql, tab?.database ?? null);
      updateTab(tabId, { result: r, preview: null });
      if (r.columns.length > 0) {
        setStatus({ kind: "key", key: "statusRowsIn", vars: { rows: r.rows.length, ms: r.elapsed_ms } });
      } else {
        setStatus({ kind: "key", key: "statusRowsAffected", vars: { rows: r.rows_affected, ms: r.elapsed_ms } });
      }
    } catch (e) {
      setStatus({ kind: "key", key: "statusQueryError", vars: { error: String(e) }, error: true });
    }
  }, [sessionId, updateTab, tabs]);

  const previewQueryInTab = useCallback(async (tabId: string, sql: string) => {
    if (!sessionId) {
      setStatus({ kind: "key", key: "statusNotConnected", error: true });
      return;
    }
    const tab = tabs.find((tt) => tt.id === tabId);
    setStatus({ kind: "key", key: "statusRunningPreview" });
    try {
      const p = await api.previewQuery(sessionId, sql, tab?.database ?? null);
      updateTab(tabId, { preview: p, result: null });
      setStatus({
        kind: "key",
        key: "statusPreviewDone",
        vars: { rows: p.rows_affected, ms: p.elapsed_ms },
      });
    } catch (e) {
      setStatus({ kind: "key", key: "statusPreviewError", vars: { error: String(e) }, error: true });
    }
  }, [sessionId, updateTab, tabs]);

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
    const sql = `SELECT * FROM \`${database}\`.\`${table}\` LIMIT 100`;
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
    };
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(tab.id);
    runQueryInTab(tab.id, sql);
  }, [tabs, runQueryInTab]);

  const handleNewTab = useCallback(() => {
    const tab = makeQueryTab();
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(tab.id);
  }, []);

  const handleCloseTab = useCallback((id: string) => {
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
  }, [activeTabId]);

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
                <Splitter
                  direction="column"
                  storageKey="tablex.split.editor"
                  defaultFraction={0.4}
                  minSize={120}
                  ariaLabel={t("splitterEditorAria")}
                  first={
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
                      sessionId={sessionId}
                      defaultDatabase={activeTab.database ?? selectedProfile?.database ?? null}
                    />
                  }
                  second={
                    activeTab.preview ? (
                      <PreviewGrid result={activeTab.preview} rowLimit={PREVIEW_ROW_LIMIT} />
                    ) : (
                      <ResultGrid result={activeTab.result} />
                    )
                  }
                />

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
