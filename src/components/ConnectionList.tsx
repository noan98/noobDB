import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, ConnectionProfile, TableColumnInfo } from "../api/tauri";
import { useT } from "../i18n";
import { Icon } from "./Icon";
import { EmptyState } from "./EmptyState";
import { Spinner } from "./Spinner";
import { ContextMenu, type ContextMenuEntry } from "./ContextMenu";

const tableKey = (db: string, tbl: string) => `${db}::${tbl}`;

interface Props {
  profiles: ConnectionProfile[];
  activeProfileId: string | null;
  sessionId: string | null;
  connectingId: string | null;
  errorProfileId: string | null;
  onConnect: (profile: ConnectionProfile) => void;
  onCreate: () => void;
  onEdit: (profile: ConnectionProfile) => void;
  onDuplicate: (profile: ConnectionProfile) => void;
  onDelete: (id: string) => void;
  onPickTable: (database: string, table: string) => void;
  onImportTable: (database: string, table: string) => void;
  onDumpDatabase: (database: string) => void;
  onRunTableSelect: (database: string, table: string) => void;
  onInsertTableSelect: (database: string, table: string) => void;
  /** Provided only for drivers with a single-statement definition (MySQL/SQLite). */
  onShowCreateTable?: (database: string, table: string) => void;
  /** Row cap shown in the "Run SELECT *" menu label. */
  selectLimit: number;
}

interface MenuState {
  x: number;
  y: number;
  items: ContextMenuEntry[];
}

export function ConnectionList({
  profiles,
  activeProfileId,
  sessionId,
  connectingId,
  errorProfileId,
  onConnect,
  onCreate,
  onEdit,
  onDuplicate,
  onDelete,
  onPickTable,
  onImportTable,
  onDumpDatabase,
  onRunTableSelect,
  onInsertTableSelect,
  onShowCreateTable,
  selectLimit,
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
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [hoveredColumn, setHoveredColumn] = useState<{ col: TableColumnInfo; rect: DOMRect } | null>(
    null,
  );
  // Databases whose table list is being eagerly loaded for schema search, so
  // the loader effect doesn't fire duplicate requests for the same database.
  const tablesInFlightRef = useRef<Set<string>>(new Set());

  // Id of the session whose schema is currently being re-fetched, or null.
  // Keyed by session (not a shared boolean) so a refresh only disables/​spins
  // the button on its own connection row, leaving other connections usable.
  const [refreshingSession, setRefreshingSession] = useState<string | null>(null);

  // Latest session id, read after awaits to drop stale schema results when the
  // user switches connections mid-refresh (otherwise the old session's tree
  // could overwrite the new one).
  const sessionIdRef = useRef(sessionId);
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

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

  // Re-query the schema for the active session without disconnecting, so
  // server-side changes (new/dropped tables or columns) show up. Currently
  // expanded databases/tables are re-fetched in place to preserve the tree's
  // open state; collapsed nodes reload lazily on next expand as usual.
  const refreshSchema = useCallback(async () => {
    if (!sessionId || refreshingSession === sessionId) return;
    const targetSessionId = sessionId;
    setRefreshingSession(targetSessionId);
    setError(null);
    try {
      const dbs = await api.listDatabases(targetSessionId);
      const openDbs = Object.keys(expandedDbs).filter(
        (db) => expandedDbs[db] && dbs.includes(db),
      );
      const nextTables: Record<string, string[]> = {};
      await Promise.all(
        openDbs.map(async (db) => {
          try {
            nextTables[db] = await api.listTables(targetSessionId, db);
          } catch {
            // Skip a database that failed to list; re-expanding retries it.
          }
        }),
      );
      const nextCols: Record<string, TableColumnInfo[]> = {};
      await Promise.all(
        Object.keys(expandedTables)
          .filter((key) => expandedTables[key])
          .map(async (key) => {
            const sep = key.indexOf("::");
            const db = key.slice(0, sep);
            const tbl = key.slice(sep + 2);
            if (!nextTables[db]?.includes(tbl)) return;
            try {
              nextCols[key] = await api.describeTable(targetSessionId, db, tbl);
            } catch {
              // Skip a table that failed; re-expanding retries it.
            }
          }),
      );
      // The session may have changed while we awaited — don't clobber the new
      // connection's tree with results fetched for the old one.
      if (sessionIdRef.current !== targetSessionId) return;
      tablesInFlightRef.current.clear();
      setDatabases(dbs);
      setTables(nextTables);
      setTableColumns(nextCols);
    } catch (e) {
      // Suppress a stale session's error so it can't surface on the new one.
      if (sessionIdRef.current === targetSessionId) setError(String(e));
    } finally {
      // Clear only if it's still this session being tracked, so a connection
      // switch mid-refresh can't wipe a newer session's in-flight flag.
      setRefreshingSession((cur) => (cur === targetSessionId ? null : cur));
    }
  }, [sessionId, refreshingSession, expandedDbs, expandedTables]);

  useEffect(() => {
    setTables({});
    setExpandedDbs({});
    setExpandedTables({});
    setTableColumns({});
    tablesInFlightRef.current.clear();
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
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: t("contextMenuEdit"), onSelect: () => onEdit(p) },
        { label: t("contextMenuDuplicate"), onSelect: () => onDuplicate(p) },
        {
          label: t("contextMenuDelete"),
          danger: true,
          onSelect: () => {
            if (confirm(t("listDeleteConfirm", { name: p.name }))) onDelete(p.id);
          },
        },
      ],
    });
  };

  const handleTableContextMenu = (e: React.MouseEvent, db: string, tbl: string) => {
    e.preventDefault();
    e.stopPropagation();
    const items: ContextMenuEntry[] = [
      { label: t("contextMenuRunSelect", { limit: selectLimit }), onSelect: () => onRunTableSelect(db, tbl) },
      { label: t("contextMenuInsertSelect"), onSelect: () => onInsertTableSelect(db, tbl) },
    ];
    if (onShowCreateTable) {
      items.push({ label: t("contextMenuShowCreate"), onSelect: () => onShowCreateTable(db, tbl) });
    }
    items.push({ separator: true });
    // Import writes to the table, so it's rejected on a read-only session;
    // disable it up front rather than letting the backend fail later.
    items.push({
      label: t("contextMenuImportCsv"),
      onSelect: () => onImportTable(db, tbl),
      disabled: activeReadOnly,
      title: activeReadOnly ? t("listReadOnlyTitle") : undefined,
    });
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  const handleDbContextMenu = (e: React.MouseEvent, db: string) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [{ label: t("contextMenuDump"), onSelect: () => onDumpDatabase(db) }],
    });
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

  const q = filter.trim().toLowerCase();
  const searching = q.length > 0;
  const activeExpanded = activeProfileId ? !!expandedProfiles[activeProfileId] : false;
  // The schema tree only shows the active connection, so its read-only flag
  // governs whether write-y table actions (Import CSV) are offered.
  const activeReadOnly = !!profiles.find((p) => p.id === activeProfileId)?.read_only;

  const profileMetaMatches = useCallback(
    (p: ConnectionProfile) =>
      p.name.toLowerCase().includes(q) ||
      p.host.toLowerCase().includes(q) ||
      !!p.database?.toLowerCase().includes(q) ||
      !!p.group?.toLowerCase().includes(q),
    [q],
  );

  // Schema-match helpers operate purely on the already-cached tree data
  // (`tables` / `tableColumns`); column matching only sees columns whose table
  // has been expanded at least once.
  const columnNameMatches = useCallback(
    (db: string, tbl: string) => {
      const cols = tableColumns[tableKey(db, tbl)];
      return !!cols && cols.some((c) => c.name.toLowerCase().includes(q));
    },
    [tableColumns, q],
  );
  const tableNodeMatches = useCallback(
    (db: string, tbl: string) => tbl.toLowerCase().includes(q) || columnNameMatches(db, tbl),
    [q, columnNameMatches],
  );
  const dbNodeMatches = useCallback(
    (db: string) => {
      if (db.toLowerCase().includes(q)) return true;
      const tbls = tables[db];
      return !!tbls && tbls.some((tbl) => tableNodeMatches(db, tbl));
    },
    [q, tables, tableNodeMatches],
  );

  // The active connection's schema has a hit, so keep its profile visible even
  // when the query doesn't match the profile's own metadata.
  const activeSchemaMatches =
    searching && !!sessionId && databases !== null && databases.some(dbNodeMatches);

  // Eagerly load every database's table list while a schema search is active so
  // table-name matches surface without the user expanding each database first.
  // Gated on the active connection being expanded to avoid loading on a plain
  // profile-name filter. Columns stay lazy (loaded on table expand).
  useEffect(() => {
    if (!searching || !sessionId || databases === null || !activeExpanded) return;
    for (const db of databases) {
      if (tables[db] !== undefined || tablesInFlightRef.current.has(db)) continue;
      tablesInFlightRef.current.add(db);
      api
        .listTables(sessionId, db)
        .then((list) => setTables((prev) => ({ ...prev, [db]: list })))
        .catch(() => {})
        .finally(() => tablesInFlightRef.current.delete(db));
    }
  }, [searching, sessionId, databases, activeExpanded, tables]);

  const visibleProfiles = profiles.filter((p) => {
    if (!searching) return true;
    if (profileMetaMatches(p)) return true;
    if (p.id === activeProfileId && activeSchemaMatches) return true;
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
    // When the query matches the connection's own metadata, show its full tree;
    // otherwise treat the query as a schema search and filter the tree to
    // matching databases / tables / columns.
    const schemaFiltered = searching && !profileMetaMatches(p);
    const status = profileStatus(p);
    const accent = p.color ?? undefined;
    // Production rows always show a red left stripe (CSS); don't let a custom
    // color override it — the color chip still conveys the accent.
    const rowStyle =
      accent && !p.is_production
        ? ({ borderLeftColor: accent } as React.CSSProperties)
        : undefined;
    const subtitle =
      p.driver === "sqlite"
        ? p.file_path
          ? p.file_path.split(/[/\\]/).pop() || p.file_path
          : "SQLite"
        : `${p.host}:${p.port}${p.database ? ` / ${p.database}` : ""}`;

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
          <span className={`tree-chevron${isOpen ? " is-open" : ""}`} aria-hidden>▸</span>
          {accent ? (
            <span
              className="profile-color-chip"
              style={{ background: accent }}
              aria-hidden
            />
          ) : (
            <span className="tree-icon profile-icon" aria-hidden><Icon name="server" /></span>
          )}
          <span className="tree-label profile-label">
            <span className="profile-name">{p.name}</span>
            <span className="profile-sub" title={subtitle}>{subtitle}</span>
          </span>
          {p.is_production && (
            <span className="tree-badge production-badge" title={t("listProduction")}>
              <Icon name="warning" />
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
          {status === "connected" && (
            <button
              type="button"
              className={`schema-refresh-btn ${refreshingSession === sessionId ? "spinning" : ""}`}
              onClick={(e) => {
                e.stopPropagation();
                void refreshSchema();
              }}
              disabled={refreshingSession === sessionId}
              title={t("treeRefreshTitle")}
              aria-label={t("treeRefresh")}
            >
              <Icon name="refresh" />
            </button>
          )}
          <span className={`status-dot status-${status}`} aria-label={statusLabel(status)} title={statusLabel(status)} />
          <span className="tree-badge driver">{p.driver}</span>
        </div>

        {isOpen && isActive && sessionId && (
          <div className="tree-children">
            {databases === null ? (
              <div className="tree-empty tree-loading">
                <Spinner size={13} />
                <span>{t("treeLoading")}</span>
              </div>
            ) : databases.length === 0 ? (
              <div className="tree-empty">{t("treeNoDatabases")}</div>
            ) : (
              databases
                .filter((db) => !schemaFiltered || dbNodeMatches(db))
                .map((db) => {
                const dbNameHit = searching && db.toLowerCase().includes(q);
                const dbOpen = !!expandedDbs[db] || (schemaFiltered && dbNodeMatches(db));
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
                      <span className={`tree-chevron${dbOpen ? " is-open" : ""}`} aria-hidden>▸</span>
                      <span className="tree-icon db-icon" aria-hidden><Icon name="database" /></span>
                      <span className="tree-label">{db}</span>
                    </div>
                    {dbOpen && (
                      <div className="tree-children">
                        {dbTables === undefined ? (
                          <div className="tree-empty tree-loading">
                            <Spinner size={13} />
                            <span>{t("treeLoading")}</span>
                          </div>
                        ) : dbTables.length === 0 ? (
                          <div className="tree-empty">{t("treeNoTables")}</div>
                        ) : (
                          dbTables
                            .filter((tbl) => !schemaFiltered || dbNameHit || tableNodeMatches(db, tbl))
                            .map((tbl) => {
                            const tKey = tableKey(db, tbl);
                            const tableNameHit = searching && tbl.toLowerCase().includes(q);
                            const showAllCols = !schemaFiltered || dbNameHit || tableNameHit;
                            const tOpen =
                              !!expandedTables[tKey] || (schemaFiltered && columnNameMatches(db, tbl));
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
                                  <span className={`tree-chevron${tOpen ? " is-open" : ""}`} aria-hidden>▸</span>
                                  <span className="tree-icon table-icon" aria-hidden><Icon name="table" /></span>
                                  <span className="tree-label">{tbl}</span>
                                </div>
                                {tOpen && (
                                  <div className="tree-children">
                                    {cols === undefined ? (
                                      <div className="tree-empty tree-loading">
                                        <Spinner size={13} />
                                        <span>{t("treeLoading")}</span>
                                      </div>
                                    ) : cols.length === 0 ? (
                                      <div className="tree-empty">{t("treeNoColumns")}</div>
                                    ) : (
                                      cols
                                        .filter((col) => showAllCols || col.name.toLowerCase().includes(q))
                                        .map((col) => {
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
                                              {isPk ? <Icon name="key" /> : isFk ? <Icon name="link" /> : "·"}
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
        <EmptyState
          icon="server"
          title={t("listEmptyTitle")}
          description={t("listEmptyDesc")}
          action={{ label: t("listCreateFirst"), onClick: onCreate }}
        />
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
                      <span className={`tree-chevron${groupOpen ? " is-open" : ""}`} aria-hidden>▸</span>
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

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
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
