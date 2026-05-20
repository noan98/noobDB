import { useCallback, useEffect, useState } from "react";
import { api, ConnectionProfile, QueryResult } from "./api/tauri";
import { ConnectionList } from "./components/ConnectionList";
import { ConnectionForm } from "./components/ConnectionForm";
import { QueryEditor } from "./components/QueryEditor";
import { ResultGrid } from "./components/ResultGrid";
import { SchemaTree } from "./components/SchemaTree";

type Tab = "query" | "schema";
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

export default function App() {
  const [theme, setTheme] = useState<Theme>(readInitialTheme);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((t) => (t === "dark" ? "light" : "dark"));
  }, []);

  const [profiles, setProfiles] = useState<ConnectionProfile[]>([]);
  const [selectedProfile, setSelectedProfile] = useState<ConnectionProfile | null>(null);
  const [editing, setEditing] = useState<ConnectionProfile | null>(null);
  const [showForm, setShowForm] = useState(false);

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("query");
  const [result, setResult] = useState<QueryResult | null>(null);
  const [status, setStatus] = useState<{ text: string; error?: boolean }>({ text: "Disconnected" });

  const refreshProfiles = useCallback(async () => {
    try {
      const list = await api.listProfiles();
      setProfiles(list);
    } catch (e) {
      setStatus({ text: `Failed to load profiles: ${e}`, error: true });
    }
  }, []);

  useEffect(() => {
    refreshProfiles();
  }, [refreshProfiles]);

  const handleConnect = useCallback(async (profile: ConnectionProfile, password: string, passphrase: string) => {
    setStatus({ text: `Connecting to ${profile.name}...` });
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
      setStatus({ text: `Connected to ${profile.name} (session ${res.session_id})` });
    } catch (e) {
      setStatus({ text: `Connection failed: ${e}`, error: true });
    }
  }, []);

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
    setStatus({ text: "Disconnected" });
  }, [sessionId]);

  const handleRunQuery = useCallback(async (sql: string) => {
    if (!sessionId) {
      setStatus({ text: "Not connected", error: true });
      return;
    }
    setStatus({ text: "Running query..." });
    try {
      const r = await api.runQuery(sessionId, sql);
      setResult(r);
      if (r.columns.length > 0) {
        setStatus({ text: `${r.rows.length} rows in ${r.elapsed_ms} ms` });
      } else {
        setStatus({ text: `${r.rows_affected} rows affected (${r.elapsed_ms} ms)` });
      }
    } catch (e) {
      setStatus({ text: `Query error: ${e}`, error: true });
    }
  }, [sessionId]);

  return (
    <div className="app">
      <aside className="sidebar">
        <header>
          <span>Connections</span>
          <div className="header-actions">
            <button
              className="icon"
              onClick={toggleTheme}
              title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
              aria-label="Toggle theme"
            >
              {theme === "dark" ? "☀" : "☾"}
            </button>
            <button onClick={() => { setEditing(null); setShowForm(true); }}>+ New</button>
          </div>
        </header>
        <ConnectionList
          profiles={profiles}
          activeId={selectedProfile?.id ?? null}
          onConnect={handleConnect}
          onEdit={(p) => { setEditing(p); setShowForm(true); }}
          onDelete={async (id) => {
            await api.deleteProfile(id);
            await refreshProfiles();
          }}
        />
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
            <div className="tabs">
              <button className={`tab ${tab === "query" ? "active" : ""}`} onClick={() => setTab("query")}>Query</button>
              <button className={`tab ${tab === "schema" ? "active" : ""}`} onClick={() => setTab("schema")}>Schema</button>
              <div style={{ flex: 1 }} />
              {sessionId && <button onClick={handleDisconnect}>Disconnect</button>}
            </div>

            <div className="pane">
              {tab === "query" ? (
                <>
                  <QueryEditor onRun={handleRunQuery} disabled={!sessionId} />
                  <ResultGrid result={result} />
                </>
              ) : (
                <SchemaTree sessionId={sessionId} onPickTable={(db, t) => {
                  setTab("query");
                  handleRunQuery(`SELECT * FROM \`${db}\`.\`${t}\` LIMIT 100`);
                }} />
              )}
            </div>
          </>
        )}

        <div className={`status ${status.error ? "error" : ""}`}>{status.text}</div>
      </main>
    </div>
  );
}
