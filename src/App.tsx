import { useCallback, useEffect, useState } from "react";
import { api, ConnectionProfile, QueryResult } from "./api/tauri";
import { ConnectionList } from "./components/ConnectionList";
import { ConnectionForm } from "./components/ConnectionForm";
import { QueryEditor } from "./components/QueryEditor";
import { ResultGrid } from "./components/ResultGrid";
import { SchemaTree } from "./components/SchemaTree";
import { LanguageSwitcher } from "./components/LanguageSwitcher";
import { useT } from "./i18n";

type Tab = "query" | "schema";

type Status =
  | { kind: "literal"; text: string; error?: boolean }
  | { kind: "key"; key: Parameters<ReturnType<typeof useT>>[0]; vars?: Record<string, string | number>; error?: boolean };

export default function App() {
  const t = useT();
  const [profiles, setProfiles] = useState<ConnectionProfile[]>([]);
  const [selectedProfile, setSelectedProfile] = useState<ConnectionProfile | null>(null);
  const [editing, setEditing] = useState<ConnectionProfile | null>(null);
  const [showForm, setShowForm] = useState(false);

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("query");
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
    setStatus({ kind: "key", key: "statusConnecting", vars: { name: profile.name } });
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
      setStatus({ kind: "key", key: "statusConnectionFailed", vars: { error: String(e) }, error: true });
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
          <span>{t("appConnections")}</span>
          <button onClick={() => { setEditing(null); setShowForm(true); }}>{t("appNew")}</button>
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
            <div className="tabs">
              <button className={`tab ${tab === "query" ? "active" : ""}`} onClick={() => setTab("query")}>{t("appTabQuery")}</button>
              <button className={`tab ${tab === "schema" ? "active" : ""}`} onClick={() => setTab("schema")}>{t("appTabSchema")}</button>
              <div style={{ flex: 1 }} />
              {sessionId && <button onClick={handleDisconnect}>{t("appDisconnect")}</button>}
            </div>

            <div className="pane">
              {tab === "query" ? (
                <>
                  <QueryEditor onRun={handleRunQuery} disabled={!sessionId} />
                  <ResultGrid result={result} />
                </>
              ) : (
                <SchemaTree sessionId={sessionId} onPickTable={(db, tbl) => {
                  setTab("query");
                  handleRunQuery(`SELECT * FROM \`${db}\`.\`${tbl}\` LIMIT 100`);
                }} />
              )}
            </div>
          </>
        )}

        <div className={`status ${status.error ? "error" : ""}`}>{statusText}</div>
      </main>
    </div>
  );
}
