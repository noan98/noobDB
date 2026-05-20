import { useCallback, useEffect, useState } from "react";
import { api, ConnectionProfile, QueryResult } from "./api/tauri";
import { ConnectionList } from "./components/ConnectionList";
import { ConnectionForm } from "./components/ConnectionForm";
import { QueryEditor } from "./components/QueryEditor";
import { ResultGrid } from "./components/ResultGrid";
import { LanguageSwitcher } from "./components/LanguageSwitcher";
import { useT } from "./i18n";

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

export default function App() {
  const t = useT();
  const [theme, setTheme] = useState<Theme>(readInitialTheme);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

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
  const [result, setResult] = useState<QueryResult | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "key", key: "appDisconnected" });

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

  const handleConnect = useCallback(async (profile: ConnectionProfile, password: string, passphrase: string) => {
    setConnectingId(profile.id);
    setErrorProfileId(null);
    setStatus({ kind: "key", key: "statusConnecting", vars: { name: profile.name } });
    // Disconnect any previous session before connecting to a new one.
    if (sessionId) {
      try { await api.disconnect(sessionId); } catch (e) { console.warn(e); }
      setSessionId(null);
      setResult(null);
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
      setStatus({ kind: "key", key: "statusConnected", vars: { name: profile.name, id: res.session_id } });
    } catch (e) {
      setErrorProfileId(profile.id);
      setStatus({ kind: "key", key: "statusConnectionFailed", vars: { error: String(e) }, error: true });
    } finally {
      setConnectingId(null);
    }
  }, [sessionId]);

  const handleDisconnect = useCallback(async () => {
    if (!sessionId) return;
    try {
      await api.disconnect(sessionId);
    } catch (e) {
      console.warn(e);
    }
    setSessionId(null);
    setSelectedProfile(null);
    setResult(null);
    setStatus({ kind: "key", key: "appDisconnected" });
  }, [sessionId]);

  const handleRunQuery = useCallback(async (sql: string) => {
    if (!sessionId) {
      setStatus({ kind: "key", key: "statusNotConnected", error: true });
      return;
    }
    setStatus({ kind: "key", key: "statusRunningQuery" });
    try {
      const r = await api.runQuery(sessionId, sql);
      setResult(r);
      if (r.columns.length > 0) {
        setStatus({ kind: "key", key: "statusRowsIn", vars: { rows: r.rows.length, ms: r.elapsed_ms } });
      } else {
        setStatus({ kind: "key", key: "statusRowsAffected", vars: { rows: r.rows_affected, ms: r.elapsed_ms } });
      }
    } catch (e) {
      setStatus({ kind: "key", key: "statusQueryError", vars: { error: String(e) }, error: true });
    }
  }, [sessionId]);

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
              onClick={() => { setEditing(null); setShowForm(true); }}
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
          onPickTable={(db, tbl) => {
            handleRunQuery(`SELECT * FROM \`${db}\`.\`${tbl}\` LIMIT 100`);
          }}
        />
        <div className="sidebar-footer">
          <LanguageSwitcher />
        </div>
      </aside>

      <main className="main">
        {showForm ? (
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

            <div className="pane">
              <QueryEditor onRun={handleRunQuery} disabled={!sessionId} />
              <ResultGrid result={result} />
            </div>
          </>
        )}

        <div className={`status ${status.error ? "error" : ""}`}>{statusText}</div>
      </main>
    </div>
  );
}
