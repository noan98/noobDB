import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, ConnectionProfile, TableColumnInfo } from "../api/tauri";
import { useT } from "../i18n";

const tableKey = (db: string, tbl: string) => `${db}::${tbl}`;

interface Props {
  profiles: ConnectionProfile[];
  activeProfileId: string | null;
  sessionId: string | null;
  connectingId: string | null;
  errorProfileId: string | null;
  onConnect: (profile: ConnectionProfile) => void;
  onEdit: (profile: ConnectionProfile) => void;
  onDuplicate: (profile: ConnectionProfile) => void;
  onDelete: (id: string) => void;
  onPickTable: (database: string, table: string) => void;
  onImportTable: (database: string, table: string) => void;
  onDumpDatabase: (database: string) => void;
}

interface ContextMenuState {
  profile: ConnectionProfile;
  x: number;
  y: number;
}

interface TableMenuState {
  database: string;
  table: string;
  x: number;
  y: number;
}

interface DbMenuState {
  database: string;
  x: number;
  y: number;
}

export function ConnectionList({
  profiles,
  activeProfileId,
  sessionId,
  connectingId,
  errorProfileId,
  onConnect,
  onEdit,
  onDuplicate,
  onDelete,
  onPickTable,
  onImportTable,
  onDumpDatabase,
}: Props) {
  const t = useT();
  const [expandedProfiles, setExpandedProfiles] = useState<Record<string, boolean>>({});
  const [expandedDbs, setExpandedDbs] = useState<Record<string, boolean>>({});
  const [expandedTables, setExpandedTables] = useState<Record<string, boolean>>({});
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const [tableColumns, setTableColumns] = useState<Record<string, TableColumnInfo[]>>({});
  const [databases, setDatabases] = useState<string[] | null>(null);
  const [tables, setTables] = useState<Record<string, string[]>>({});
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [tableMenu, setTableMenu] = useState<TableMenuState | null>(null);
  const [dbMenu, setDbMenu] = useState<DbMenuState | null>(null);
  const [hoveredColumn, setHoveredColumn] = useState<{ col: TableColumnInfo; rect: DOMRect } | null>(
    null,
  );
  const menuRef = useRef<HTMLDivElement | null>(null);

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
    setExpandedTables({});
    setTableColumns({});
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
    }
  }, [activeProfileId]);

  // Dismiss context menu on outside click / Escape / scroll.
  useEffect(() => {
    if (!contextMenu && !tableMenu && !dbMenu) return;
    const close = () => {
      setContextMenu(null);
      setTableMenu(null);
      setDbMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && menuRef.current.contains(e.target as Node)) return;
      close();
    };
    window.addEventListener("mousedown", onClick);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("mousedown", onClick);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [contextMenu, tableMenu, dbMenu]);

  // The column tooltip is anchored to a snapshot of the row's position, so it
  // would detach if the tree scrolls or the window resizes under the pointer.
  useEffect(() => {
    if (!hoveredColumn) return;
    const clear = () => setHoveredColumn(null);
    window.addEventListener("scroll", clear, true);
    window.addEventListener("resize", clear);
    return () => {
      window.removeEventListener("scroll", clear, true);
      window.removeEventListener("resize", clear);
    };
  }, [hoveredColumn]);

  const handleProfileClick = (p: ConnectionProfile) => {
    if (p.id === activeProfileId) {
      setExpandedProfiles((prev) => ({ ...prev, [p.id]: !prev[p.id] }));
      return;
    }
    if (connectingId) return;
    onConnect(p);
  };

  const handleProfileContextMenu = (e: React.MouseEvent, p: ConnectionProfile) => {
    e.preventDefault();
    e.stopPropagation();
    setTableMenu(null);
    setDbMenu(null);
    setContextMenu({ profile: p, x: e.clientX, y: e.clientY });
  };

  const handleTableContextMenu = (e: React.MouseEvent, db: string, tbl: string) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu(null);
    setDbMenu(null);
    setTableMenu({ database: db, table: tbl, x: e.clientX, y: e.clientY });
  };

  const handleDbContextMenu = (e: React.MouseEvent, db: string) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu(null);
    setTableMenu(null);
    setDbMenu({ database: db, x: e.clientX, y: e.clientY });
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

  const toggleTable = async (db: string, tbl: string) => {
    if (!sessionId) return;
    const key = tableKey(db, tbl);
    const isOpen = expandedTables[key];
    if (isOpen) {
      setExpandedTables((prev) => ({ ...prev, [key]: false }));
      return;
    }
    setExpandedTables((prev) => ({ ...prev, [key]: true }));
    if (tableColumns[key]) return;
    try {
      const cols = await api.describeTable(sessionId, db, tbl);
      setTableColumns((prev) => ({ ...prev, [key]: cols }));
    } catch (e) {
      setError(String(e));
    }
  };

  const visibleProfiles = profiles.filter((p) => {
    if (!filter.trim()) return true;
    const q = filter.trim().toLowerCase();
    if (p.name.toLowerCase().includes(q)) return true;
    if (p.host.toLowerCase().includes(q)) return true;
    if (p.database?.toLowerCase().includes(q)) return true;
    if (p.group?.toLowerCase().includes(q)) return true;
    return false;
  });

  /** Profiles grouped by their `group` field. `null` key = ungrouped. */
  const grouped = useMemo(() => {
    const anyGrouped = profiles.some((p) => p.group);
    if (!anyGrouped) return null;
    const map = new Map<string | null, ConnectionProfile[]>();
    for (const p of visibleProfiles) {
      const key = p.group ?? null;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(p);
    }
    const groups: { name: string | null; profiles: ConnectionProfile[] }[] = [];
    const names = Array.from(map.keys())
      .filter((k): k is string => k !== null)
      .sort((a, b) => a.localeCompare(b));
    for (const name of names) groups.push({ name, profiles: map.get(name)! });
    const ungrouped = map.get(null);
    if (ungrouped && ungrouped.length > 0) groups.push({ name: null, profiles: ungrouped });
    return groups;
  }, [profiles, visibleProfiles]);

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

  const renderProfile = (p: ConnectionProfile) => {
    const isActive = p.id === activeProfileId;
    const isOpen = !!expandedProfiles[p.id];
    const status = profileStatus(p);
    const accent = p.color ?? undefined;
    const rowStyle = accent
      ? ({ borderLeftColor: accent } as React.CSSProperties)
      : undefined;

    return (
      <div
        key={p.id}
        className={`tree-node profile ${isActive ? "active" : ""} ${p.is_production ? "is-production" : ""}`}
      >
        <div
          className="tree-row profile-row"
          style={rowStyle}
          onClick={() => handleProfileClick(p)}
          onContextMenu={(e) => handleProfileContextMenu(e, p)}
          role="treeitem"
          aria-expanded={isOpen}
          title={
            p.driver === "sqlite"
              ? p.file_path ?? p.name
              : `${p.user}@${p.host}:${p.port}${p.database ? "/" + p.database : ""}${p.ssh ? " " + t("listVia", { host: p.ssh.host }) : ""}`
          }
        >
          <span className="tree-chevron" aria-hidden>{isOpen ? "▾" : "▸"}</span>
          {accent ? (
            <span
              className="profile-color-chip"
              style={{ background: accent }}
              aria-hidden
            />
          ) : (
            <span className="tree-icon profile-icon" aria-hidden>⛁</span>
          )}
          <span className="tree-label">{p.name}</span>
          {p.is_production && (
            <span
              className="tree-badge production-badge"
              style={accent ? { background: accent, color: "#fff", borderColor: accent } : undefined}
              title={t("listProduction")}
            >
              {t("listProduction")}
            </span>
          )}
          {p.read_only && (
            <span
              className="tree-badge read-only-badge"
              title={t("listReadOnlyTitle")}
            >
              {t("listReadOnly")}
            </span>
          )}
          <span className={`status-dot status-${status}`} aria-label={statusLabel(status)} title={statusLabel(status)} />
          <span className="tree-badge driver">{p.driver}</span>
        </div>

        {isOpen && isActive && sessionId && (
          <div className="tree-children">
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
                      onContextMenu={(e) => handleDbContextMenu(e, db)}
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
                          dbTables.map((tbl) => {
                            const tKey = tableKey(db, tbl);
                            const tOpen = !!expandedTables[tKey];
                            const cols = tableColumns[tKey];
                            return (
                              <div key={tbl} className="tree-node table">
                                <div
                                  className="tree-row table-row"
                                  role="treeitem"
                                  aria-expanded={tOpen}
                                  onClick={() => toggleTable(db, tbl)}
                                  onDoubleClick={() => onPickTable(db, tbl)}
                                  onContextMenu={(e) => handleTableContextMenu(e, db, tbl)}
                                  title={t("treeTableTitle")}
                                >
                                  <span className="tree-chevron" aria-hidden>{tOpen ? "▾" : "▸"}</span>
                                  <span className="tree-icon table-icon" aria-hidden>▤</span>
                                  <span className="tree-label">{tbl}</span>
                                </div>
                                {tOpen && (
                                  <div className="tree-children">
                                    {cols === undefined ? (
                                      <div className="tree-empty">{t("treeLoading")}</div>
                                    ) : cols.length === 0 ? (
                                      <div className="tree-empty">{t("treeNoColumns")}</div>
                                    ) : (
                                      cols.map((col) => {
                                        const isPk = col.key === "PRI";
                                        const isFk = col.referenced_table !== null;
                                        return (
                                          <div
                                            key={col.name}
                                            className="tree-row column-row"
                                            role="treeitem"
                                            onMouseEnter={(e) =>
                                              setHoveredColumn({
                                                col,
                                                rect: e.currentTarget.getBoundingClientRect(),
                                              })
                                            }
                                            onMouseLeave={() =>
                                              setHoveredColumn((cur) => (cur?.col === col ? null : cur))
                                            }
                                          >
                                            <span className="tree-chevron empty" aria-hidden />
                                            <span
                                              className={`tree-icon column-icon ${isPk ? "is-pk" : ""} ${isFk ? "is-fk" : ""}`}
                                              title={isPk ? t("colPkTitle") : isFk ? t("colFkTitle") : undefined}
                                              aria-hidden
                                            >
                                              {isPk ? "🔑" : isFk ? "🔗" : "·"}
                                            </span>
                                            <span className="tree-label column-name">{col.name}</span>
                                            <span className="tree-badge column-type" title={col.data_type}>{col.data_type}</span>
                                          </div>
                                        );
                                      })
                                    )}
                                  </div>
                                )}
                              </div>
                            );
                          })
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>
    );
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
          {grouped === null
            ? visibleProfiles.map(renderProfile)
            : grouped.map((g) => {
                const key = g.name ?? "__ungrouped__";
                const groupOpen = expandedGroups[key] !== false;
                const label = g.name ?? t("listGroupUngrouped");
                return (
                  <div key={key} className="tree-node profile-group">
                    <div
                      className="tree-row group-row"
                      onClick={() =>
                        setExpandedGroups((prev) => ({ ...prev, [key]: prev[key] === false ? true : false }))
                      }
                      role="treeitem"
                      aria-expanded={groupOpen}
                    >
                      <span className="tree-chevron" aria-hidden>{groupOpen ? "▾" : "▸"}</span>
                      <span className="group-label">{label}</span>
                      <span className="tree-badge group-count">{g.profiles.length}</span>
                    </div>
                    {groupOpen && (
                      <div className="tree-children">
                        {g.profiles.map(renderProfile)}
                      </div>
                    )}
                  </div>
                );
              })}
        </div>
      )}

      {contextMenu && (
        <div
          ref={menuRef}
          className="context-menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          role="menu"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="context-menu-item"
            onClick={() => {
              const p = contextMenu.profile;
              setContextMenu(null);
              onEdit(p);
            }}
          >
            {t("contextMenuEdit")}
          </button>
          <button
            type="button"
            className="context-menu-item"
            onClick={() => {
              const p = contextMenu.profile;
              setContextMenu(null);
              onDuplicate(p);
            }}
          >
            {t("contextMenuDuplicate")}
          </button>
          <button
            type="button"
            className="context-menu-item danger"
            onClick={() => {
              const p = contextMenu.profile;
              setContextMenu(null);
              if (confirm(t("listDeleteConfirm", { name: p.name }))) onDelete(p.id);
            }}
          >
            {t("contextMenuDelete")}
          </button>
        </div>
      )}

      {tableMenu && (
        <div
          ref={menuRef}
          className="context-menu"
          style={{ top: tableMenu.y, left: tableMenu.x }}
          role="menu"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="context-menu-item"
            onClick={() => {
              const { database, table } = tableMenu;
              setTableMenu(null);
              onImportTable(database, table);
            }}
          >
            {t("contextMenuImportCsv")}
          </button>
        </div>
      )}

      {dbMenu && (
        <div
          ref={menuRef}
          className="context-menu"
          style={{ top: dbMenu.y, left: dbMenu.x }}
          role="menu"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="context-menu-item"
            onClick={() => {
              const { database } = dbMenu;
              setDbMenu(null);
              onDumpDatabase(database);
            }}
          >
            {t("contextMenuDump")}
          </button>
        </div>
      )}

      {hoveredColumn && <ColumnTooltip col={hoveredColumn.col} anchor={hoveredColumn.rect} />}
    </div>
  );
}

/**
 * Hover card for a schema-browser column. Shows type, NULL-ability, default,
 * key kind and (for foreign keys) the referenced table/column. Positioned with
 * `position: fixed` against a snapshot of the row's rectangle, flipping to the
 * left / clamping to the viewport when it would overflow. Rendered invisibly on
 * the first frame so it can measure itself before committing a position.
 */
function ColumnTooltip({ col, anchor }: { col: TableColumnInfo; anchor: DOMRect }) {
  const t = useT();
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const margin = 8;
    let left = anchor.right + margin;
    if (left + width + margin > window.innerWidth) {
      left = anchor.left - margin - width;
    }
    left = Math.max(margin, left);
    let top = anchor.top;
    if (top + height + margin > window.innerHeight) {
      top = window.innerHeight - margin - height;
    }
    top = Math.max(margin, top);
    setPos({ left, top });
  }, [col, anchor]);

  const keyLabel =
    col.key === "PRI"
      ? t("colTipKeyPrimary")
      : col.key === "UNI"
        ? t("colTipKeyUnique")
        : col.key === "MUL"
          ? t("colTipKeyIndex")
          : col.key;

  const reference =
    col.referenced_table === null
      ? null
      : col.referenced_column
        ? `${col.referenced_table}.${col.referenced_column}`
        : col.referenced_table;

  return (
    <div
      ref={ref}
      className="column-tooltip"
      role="tooltip"
      style={{
        left: pos ? pos.left : anchor.right + 8,
        top: pos ? pos.top : anchor.top,
        visibility: pos ? "visible" : "hidden",
      }}
    >
      <div className="column-tooltip-name">{col.name}</div>
      <dl className="column-tooltip-rows">
        <dt>{t("colTipType")}</dt>
        <dd>{col.data_type}</dd>
        <dt>{t("colTipNullable")}</dt>
        <dd>{col.nullable ? t("colTipYes") : t("colTipNo")}</dd>
        {col.default !== null && (
          <>
            <dt>{t("colTipDefault")}</dt>
            <dd>{col.default}</dd>
          </>
        )}
        {col.key && (
          <>
            <dt>{t("colTipKey")}</dt>
            <dd>{keyLabel}</dd>
          </>
        )}
        {reference && (
          <>
            <dt>{t("colTipReferences")}</dt>
            <dd>{reference}</dd>
          </>
        )}
        {col.extra && (
          <>
            <dt>{t("colTipExtra")}</dt>
            <dd>{col.extra}</dd>
          </>
        )}
      </dl>
    </div>
  );
}
