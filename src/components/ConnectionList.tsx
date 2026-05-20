import { useCallback, useEffect, useState } from "react";
import { api, ConnectionProfile } from "../api/tauri";
import { useT } from "../i18n";

interface Props {
  profiles: ConnectionProfile[];
  activeProfileId: string | null;
  sessionId: string | null;
  connectingId: string | null;
  errorProfileId: string | null;
  onConnect: (profile: ConnectionProfile, password: string, passphrase: string) => void;
  onEdit: (profile: ConnectionProfile) => void;
  onDelete: (id: string) => void;
  onPickTable: (database: string, table: string) => void;
}

type FormState = { password: string; passphrase: string };

export function ConnectionList({
  profiles,
  activeProfileId,
  sessionId,
  connectingId,
  errorProfileId,
  onConnect,
  onEdit,
  onDelete,
  onPickTable,
}: Props) {
  const t = useT();
  const [expandedProfiles, setExpandedProfiles] = useState<Record<string, boolean>>({});
  const [expandedDbs, setExpandedDbs] = useState<Record<string, boolean>>({});
  const [forms, setForms] = useState<Record<string, FormState>>({});
  const [showForm, setShowForm] = useState<Record<string, boolean>>({});
  const [databases, setDatabases] = useState<string[] | null>(null);
  const [tables, setTables] = useState<Record<string, string[]>>({});
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);

  const loadDatabases = useCallback(async () => {
    if (!sessionId) {
      setDatabases(null);
      return;
    }
    try {
      const dbs = await api.listDatabases(sessionId);
      setDatabases(dbs);
    } catch (e) {
      setError(String(e));
    }
  }, [sessionId]);

  useEffect(() => {
    setTables({});
    setExpandedDbs({});
    if (sessionId) {
      setDatabases(null);
      loadDatabases();
    } else {
      setDatabases(null);
    }
  }, [sessionId, loadDatabases]);

  // Auto-expand the active connection.
  useEffect(() => {
    if (activeProfileId) {
      setExpandedProfiles((prev) => ({ ...prev, [activeProfileId]: true }));
      setShowForm((prev) => ({ ...prev, [activeProfileId]: false }));
    }
  }, [activeProfileId]);

  const toggleProfile = (p: ConnectionProfile) => {
    const isActive = p.id === activeProfileId;
    const isOpen = expandedProfiles[p.id];
    if (isActive) {
      setExpandedProfiles({ ...expandedProfiles, [p.id]: !isOpen });
      return;
    }
    // Not connected: open inline connect form.
    if (isOpen && showForm[p.id]) {
      setShowForm({ ...showForm, [p.id]: false });
      setExpandedProfiles({ ...expandedProfiles, [p.id]: false });
    } else {
      setExpandedProfiles({ ...expandedProfiles, [p.id]: true });
      setShowForm({ ...showForm, [p.id]: true });
    }
  };

  const toggleDb = async (db: string) => {
    if (!sessionId) return;
    const isOpen = expandedDbs[db];
    if (isOpen) {
      setExpandedDbs({ ...expandedDbs, [db]: false });
      return;
    }
    setExpandedDbs({ ...expandedDbs, [db]: true });
    if (tables[db]) return;
    try {
      const list = await api.listTables(sessionId, db);
      setTables((prev) => ({ ...prev, [db]: list }));
    } catch (e) {
      setError(String(e));
    }
  };

  const updateForm = (id: string, patch: Partial<FormState>) => {
    setForms((prev) => {
      const current = prev[id] ?? { password: "", passphrase: "" };
      return { ...prev, [id]: { ...current, ...patch } };
    });
  };

  const submitConnect = (p: ConnectionProfile) => {
    const f = forms[p.id] ?? { password: "", passphrase: "" };
    onConnect(p, f.password, f.passphrase);
    setForms((prev) => ({ ...prev, [p.id]: { password: "", passphrase: "" } }));
  };

  const visibleProfiles = profiles.filter((p) => {
    if (!filter.trim()) return true;
    const q = filter.trim().toLowerCase();
    if (p.name.toLowerCase().includes(q)) return true;
    if (p.host.toLowerCase().includes(q)) return true;
    if (p.database?.toLowerCase().includes(q)) return true;
    return false;
  });

  const profileStatus = (p: ConnectionProfile): "connected" | "connecting" | "error" | "idle" => {
    if (connectingId === p.id) return "connecting";
    if (errorProfileId === p.id && activeProfileId !== p.id) return "error";
    if (activeProfileId === p.id && sessionId) return "connected";
    return "idle";
  };

  const statusLabel = (s: "connected" | "connecting" | "error" | "idle") => {
    switch (s) {
      case "connected": return t("statusBadge_connected");
      case "connecting": return t("statusBadge_connecting");
      case "error": return t("statusBadge_error");
      case "idle": return t("statusBadge_idle");
    }
  };

  return (
    <div className="tree-pane">
      <div className="tree-search">
        <input
          type="search"
          placeholder={t("listSearchPlaceholder")}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>

      {error && <div className="tree-error">{error}</div>}

      {profiles.length === 0 ? (
        <p className="muted" style={{ padding: 12 }}>{t("listEmpty")}</p>
      ) : visibleProfiles.length === 0 ? (
        <p className="muted" style={{ padding: 12 }}>{t("listNoMatches")}</p>
      ) : (
        <div className="tree" role="tree">
          {visibleProfiles.map((p) => {
            const isActive = p.id === activeProfileId;
            const isOpen = !!expandedProfiles[p.id];
            const showInlineForm = !!showForm[p.id] && !isActive;
            const status = profileStatus(p);

            return (
              <div key={p.id} className={`tree-node profile ${isActive ? "active" : ""}`}>
                <div
                  className="tree-row profile-row"
                  onClick={() => toggleProfile(p)}
                  role="treeitem"
                  aria-expanded={isOpen}
                  title={`${p.user}@${p.host}:${p.port}${p.database ? "/" + p.database : ""}${p.ssh ? " " + t("listVia", { host: p.ssh.host }) : ""}`}
                >
                  <span className="tree-chevron" aria-hidden>{isOpen ? "▾" : "▸"}</span>
                  <span className="tree-icon profile-icon" aria-hidden>⛁</span>
                  <span className="tree-label">{p.name}</span>
                  <span className={`status-dot status-${status}`} aria-label={statusLabel(status)} title={statusLabel(status)} />
                  <span className="tree-badge driver">{p.driver}</span>
                </div>

                {isOpen && (
                  <div className="tree-children">
                    {showInlineForm && (
                      <div className="tree-form" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="password"
                          placeholder={t("listDbPasswordPlaceholder")}
                          value={forms[p.id]?.password ?? ""}
                          onChange={(e) => updateForm(p.id, { password: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") submitConnect(p);
                          }}
                        />
                        {p.ssh && (
                          <input
                            type="password"
                            placeholder={t("listSshPassphrasePlaceholder")}
                            value={forms[p.id]?.passphrase ?? ""}
                            onChange={(e) => updateForm(p.id, { passphrase: e.target.value })}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") submitConnect(p);
                            }}
                          />
                        )}
                        <div className="tree-form-actions">
                          <button
                            className="primary"
                            disabled={connectingId === p.id}
                            onClick={() => submitConnect(p)}
                          >
                            {connectingId === p.id ? t("listConnecting") : t("listConnect")}
                          </button>
                          <button onClick={() => onEdit(p)}>{t("listEdit")}</button>
                          <button
                            onClick={() => {
                              if (confirm(t("listDeleteConfirm", { name: p.name }))) onDelete(p.id);
                            }}
                          >
                            {t("listDelete")}
                          </button>
                        </div>
                      </div>
                    )}

                    {isActive && sessionId && (
                      <>
                        {databases === null ? (
                          <div className="tree-empty">{t("treeLoading")}</div>
                        ) : databases.length === 0 ? (
                          <div className="tree-empty">{t("treeNoDatabases")}</div>
                        ) : (
                          databases.map((db) => {
                            const dbOpen = !!expandedDbs[db];
                            const dbTables = tables[db];
                            return (
                              <div key={db} className="tree-node db">
                                <div
                                  className="tree-row db-row"
                                  onClick={() => toggleDb(db)}
                                  role="treeitem"
                                  aria-expanded={dbOpen}
                                  title={db}
                                >
                                  <span className="tree-chevron" aria-hidden>{dbOpen ? "▾" : "▸"}</span>
                                  <span className="tree-icon db-icon" aria-hidden>▣</span>
                                  <span className="tree-label">{db}</span>
                                </div>
                                {dbOpen && (
                                  <div className="tree-children">
                                    {dbTables === undefined ? (
                                      <div className="tree-empty">{t("treeLoading")}</div>
                                    ) : dbTables.length === 0 ? (
                                      <div className="tree-empty">{t("treeNoTables")}</div>
                                    ) : (
                                      dbTables.map((tbl) => (
                                        <div
                                          key={tbl}
                                          className="tree-row table-row"
                                          role="treeitem"
                                          onDoubleClick={() => onPickTable(db, tbl)}
                                          title={t("treeTableTitle")}
                                        >
                                          <span className="tree-chevron empty" aria-hidden />
                                          <span className="tree-icon table-icon" aria-hidden>▤</span>
                                          <span className="tree-label">{tbl}</span>
                                        </div>
                                      ))
                                    )}
                                  </div>
                                )}
                              </div>
                            );
                          })
                        )}
                        <div className="tree-row-actions">
                          <button onClick={() => onEdit(p)}>{t("listEdit")}</button>
                          <button
                            onClick={() => {
                              if (confirm(t("listDeleteConfirm", { name: p.name }))) onDelete(p.id);
                            }}
                          >
                            {t("listDelete")}
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
