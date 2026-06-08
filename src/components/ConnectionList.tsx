import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Box, chakra, Flex, Text } from "@chakra-ui/react";
import { AnimatePresence } from "motion/react";
import { api, ConnectionProfile, TableColumnInfo } from "../api/tauri";
import { formatRowEstimate } from "./rowEstimate";
import { useT } from "../i18n";
import { springs, transitions, variants } from "../motion";
import { Icon, type IconName } from "./Icon";
import { EmptyState } from "./EmptyState";
import { Spinner } from "./Spinner";
import { ContextMenu, type ContextMenuEntry } from "./ContextMenu";
import { Input } from "./ui";
import {
  MotionTreeNode,
  MotionTreeRow,
  TreeBadge,
  TreeChevron,
  TreeCollapse,
  TreeIcon,
  TreeLabel,
  TreeNode,
  TreeRow,
} from "./tree";

const tableKey = (db: string, tbl: string) => `${db}::${tbl}`;

/** サイドバーフィルタで公開するハンドル型。App.tsx が Cmd/Ctrl+P でフォーカスを当てるために使う。 */
export interface ConnectionListHandle {
  focusFilter: () => void;
}

/** 検索クエリ `query` にマッチする部分をハイライト表示するシンプルなコンポーネント。
 *  大小無視の部分一致で最初のマッチのみ強調し、マッチがなければそのまま返す。 */
function HighlightText({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const lowerText = text.toLowerCase();
  const idx = lowerText.indexOf(query);
  if (idx === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <chakra.mark
        bg="color-mix(in srgb, var(--accent) 35%, transparent)"
        color="inherit"
        borderRadius="2px"
        px="1px"
      >
        {text.slice(idx, idx + query.length)}
      </chakra.mark>
      {text.slice(idx + query.length)}
    </>
  );
}

/** ドライバ名 (プロファイルの自由文字列) を Icon のブランドロゴ名へ正規化する。
 *  未知のドライバは null を返し、呼び出し側で汎用アイコンへフォールバックする。 */
function driverIconName(driver: string): IconName | null {
  switch (driver.toLowerCase()) {
    case "mysql":
    case "mariadb":
      return "mysql";
    case "postgres":
    case "postgresql":
      return "postgres";
    case "sqlite":
    case "sqlite3":
      return "sqlite";
    default:
      return null;
  }
}

/** ドライバごとのブランドアクセント色。ライト/ダーク両テーマで視認できる中間色を
 *  選んでいる (暗い純正色だとダークテーマで沈むため)。 */
function driverColor(driver: string): string {
  switch (driverIconName(driver)) {
    case "mysql":
      return "#00758f";
    case "postgres":
      return "#3b82c4";
    case "sqlite":
      return "#0f9bdc";
    default:
      return "var(--accent)";
  }
}

/** 接続リストのグループ折りたたみ状態を永続化する localStorage キー (#350)。
 *  既定はすべて展開なので、明示的に「閉じている」グループ key の配列だけを保存する。 */
const COLLAPSED_GROUPS_KEY = "noobdb.connlist.collapsedGroups";

/** localStorage から閉じているグループ集合を復元し、`expandedGroups` の初期値
 *  ({ key: false } の Record) に変換する。SSR/未対応環境やパース失敗時は空。 */
function readCollapsedGroups(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(COLLAPSED_GROUPS_KEY);
    if (!raw) return {};
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return {};
    const out: Record<string, boolean> = {};
    for (const k of arr) if (typeof k === "string") out[k] = false;
    return out;
  } catch {
    return {};
  }
}

/** ネストした子ノードを包む破線インデント (旧 .tree-children)。 */
const TreeChildren = chakra("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    pl: "12px",
    ml: "14px",
    borderLeft: "1px dashed",
    borderColor: "app.border",
  },
});

/** ローディング / 空表示のプレースホルダ行 (旧 .tree-empty)。 */
const TreeEmpty = chakra("div", {
  base: {
    pt: "4px",
    pb: "4px",
    pr: "10px",
    pl: "22px",
    fontSize: "xs",
    color: "app.textMuted",
    fontStyle: "italic",
  },
});

/** 接続状態ドットの状態別 style (旧 .status-dot.status-*)。色は動的トークンの
 *  ため CSS 変数を直接参照する。`connecting` の脈動は App.css の @keyframes pulse。 */
const STATUS_DOT_STYLE = {
  idle: {
    bg: "var(--status-idle)",
    boxShadow: "0 0 0 2px color-mix(in srgb, var(--status-idle) 18%, transparent)",
  },
  connected: {
    bg: "var(--status-connected)",
    boxShadow: "0 0 0 2px color-mix(in srgb, var(--status-connected) 25%, transparent)",
  },
  connecting: {
    bg: "var(--status-connecting)",
    boxShadow: "0 0 0 2px color-mix(in srgb, var(--status-connecting) 25%, transparent)",
    animation: "pulse 1.2s ease-in-out infinite",
  },
  error: {
    bg: "var(--status-error)",
    boxShadow: "0 0 0 2px color-mix(in srgb, var(--status-error) 25%, transparent)",
  },
} as const;

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

// React.memo + forwardRef でラップし、App.tsx の再レンダリング (クエリ入力や
// ストリーミングのたびに発生する) でツリー全体が無駄に再描画されるのを防ぐ (#403)。
// forwardRef は App.tsx から focusFilter() を呼ぶための ConnectionListHandle を
// 公開するために必要。親から渡るコールバックは App 側で useCallback 安定化済みの
// ため、接続状態が変わらない限り memo がスキップする。
export const ConnectionList = memo(forwardRef<ConnectionListHandle, Props>(function ConnectionList({
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
}, ref) {
  const t = useT();
  const [expandedProfiles, setExpandedProfiles] = useState<Record<string, boolean>>({});
  const [expandedDbs, setExpandedDbs] = useState<Record<string, boolean>>({});
  const [expandedTables, setExpandedTables] = useState<Record<string, boolean>>({});
  // グループ折りたたみ状態は localStorage に永続化し、再起動後も維持する (#350)。
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>(readCollapsedGroups);
  const [tableColumns, setTableColumns] = useState<Record<string, TableColumnInfo[]>>({});
  const [databases, setDatabases] = useState<string[] | null>(null);
  const [tables, setTables] = useState<Record<string, string[]>>({});
  // Approximate row counts per database, keyed `db -> table -> estimate`. Read
  // from engine statistics (no COUNT(*) scan); a table with no cheap estimate
  // (views, SQLite, stats not yet gathered) simply has no entry and shows no
  // badge. Loaded alongside the table list when a database is expanded.
  const [rowEstimates, setRowEstimates] = useState<
    Record<string, Record<string, number | null>>
  >({});
  const [filter, setFilter] = useState("");
  const filterInputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [hoveredColumn, setHoveredColumn] = useState<{ col: TableColumnInfo; rect: DOMRect } | null>(
    null,
  );
  // Databases whose table list is currently being fetched, either by manual
  // expand (toggleDb) or by eager schema-search loading. Shared so that rapid
  // collapse / re-expand during an in-flight fetch can't re-issue the same
  // request — and so the schema search and manual paths don't race.
  const tablesInFlightRef = useRef<Set<string>>(new Set());
  // Table keys (db::tbl) whose column list is currently being fetched. Same
  // role as `tablesInFlightRef` but for the column-level expand.
  const columnsInFlightRef = useRef<Set<string>>(new Set());
  // Databases whose row-count estimates are currently being fetched. Mirrors
  // `tablesInFlightRef` so overlapping expands don't re-issue the estimate query.
  const estimatesInFlightRef = useRef<Set<string>>(new Set());

  useImperativeHandle(ref, () => ({
    focusFilter: () => {
      filterInputRef.current?.focus();
      filterInputRef.current?.select();
    },
  }));

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
      const nextEstimates: Record<string, Record<string, number | null>> = {};
      await Promise.all(
        openDbs.map(async (db) => {
          try {
            nextTables[db] = await api.listTables(targetSessionId, db);
          } catch {
            // Skip a database that failed to list; re-expanding retries it.
          }
          try {
            const est = await api.tableRowEstimates(targetSessionId, db);
            const map: Record<string, number | null> = {};
            for (const e of est) map[e.name] = e.estimate;
            nextEstimates[db] = map;
          } catch {
            // Estimates are decorative; a failure just drops the badges.
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
      setRowEstimates(nextEstimates);
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
    setRowEstimates({});
    setExpandedDbs({});
    setExpandedTables({});
    setTableColumns({});
    tablesInFlightRef.current.clear();
    estimatesInFlightRef.current.clear();
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

  // 閉じているグループだけを localStorage に保存する (#350)。展開が既定なので
  // false のキーのみを書き出し、ストレージを最小限に保つ。
  useEffect(() => {
    const collapsed = Object.entries(expandedGroups)
      .filter(([, open]) => open === false)
      .map(([key]) => key);
    try {
      if (collapsed.length > 0) {
        localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify(collapsed));
      } else {
        localStorage.removeItem(COLLAPSED_GROUPS_KEY);
      }
    } catch {
      // ストレージ不可環境では永続化を諦める (セッション内の動作には影響しない)。
    }
  }, [expandedGroups]);

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

  // Fetch approximate row counts for a database and merge them into state. Best
  // effort: failures (e.g. a driver that doesn't support it) are swallowed so
  // the tree still renders without badges. Guarded by an in-flight set and a
  // session check so a stale connection's result can't clobber the new one.
  const loadRowEstimates = async (sid: string, db: string) => {
    if (estimatesInFlightRef.current.has(db)) return;
    estimatesInFlightRef.current.add(db);
    try {
      const list = await api.tableRowEstimates(sid, db);
      if (sessionIdRef.current !== sid) return;
      const map: Record<string, number | null> = {};
      for (const e of list) map[e.name] = e.estimate;
      setRowEstimates((prev) => ({ ...prev, [db]: map }));
    } catch {
      // Estimates are decorative; never block the tree on them.
    } finally {
      estimatesInFlightRef.current.delete(db);
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
    // Skip if a fetch is already in flight for this database — covers both
    // rapid collapse / re-expand and overlap with the schema-search eager loader.
    if (tablesInFlightRef.current.has(db)) return;
    tablesInFlightRef.current.add(db);
    try {
      const list = await api.listTables(sessionId, db);
      setTables((prev) => ({ ...prev, [db]: list }));
      void loadRowEstimates(sessionId, db);
    } catch (e) {
      setError(String(e));
    } finally {
      tablesInFlightRef.current.delete(db);
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
    // Same in-flight guard as toggleDb: rapid collapse / re-expand mid-fetch
    // must not re-issue describeTable for the same table.
    if (columnsInFlightRef.current.has(key)) return;
    columnsInFlightRef.current.add(key);
    try {
      const cols = await api.describeTable(sessionId, db, tbl);
      setTableColumns((prev) => ({ ...prev, [key]: cols }));
    } catch (e) {
      setError(String(e));
    } finally {
      columnsInFlightRef.current.delete(key);
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

  const renderLoadingRow = () => (
    <TreeEmpty display="flex" alignItems="center" gap="6px" fontStyle="normal">
      <Spinner size={13} />
      <span>{t("treeLoading")}</span>
    </TreeEmpty>
  );

  const renderProfile = (p: ConnectionProfile) => {
    const isActive = p.id === activeProfileId;
    const isOpen = !!expandedProfiles[p.id];
    // When the query matches the connection's own metadata, show its full tree;
    // otherwise treat the query as a schema search and filter the tree to
    // matching databases / tables / columns.
    const schemaFiltered = searching && !profileMetaMatches(p);
    const status = profileStatus(p);
    const accent = p.color ?? undefined;
    const refreshing = refreshingSession === sessionId;
    // Left stripe + tint priority: production (red, always wins) > custom color >
    // active accent > none. A custom color also overrides the active accent
    // stripe, matching the previous inline-style behaviour.
    let borderLeftColor: string;
    let rowBg: string | undefined;
    if (p.is_production) {
      borderLeftColor = "var(--status-error)";
      rowBg = isActive
        ? "color-mix(in srgb, var(--status-error) 12%, var(--bg-active))"
        : "color-mix(in srgb, var(--status-error) 6%, transparent)";
    } else if (accent) {
      borderLeftColor = accent;
      rowBg = isActive ? "var(--bg-active)" : undefined;
    } else if (isActive) {
      borderLeftColor = "var(--accent)";
      rowBg = "var(--bg-active)";
    } else {
      borderLeftColor = "transparent";
      rowBg = undefined;
    }
    const subtitle =
      p.driver === "sqlite"
        ? p.file_path
          ? p.file_path.split(/[/\\]/).pop() || p.file_path
          : "SQLite"
        : `${p.host}:${p.port}${p.database ? ` / ${p.database}` : ""}`;

    const driverIcon = driverIconName(p.driver);

    return (
      <MotionTreeNode key={p.id} {...variants.fade} transition={transitions.crossfade}>
        <MotionTreeRow
          pt="5px"
          pb="5px"
          pr="10px"
          pl="5px"
          // プロファイルカラー / 本番 / アクティブを左端のアクセントバーで示す。
          // 識別性を上げるため 4px に。全行で同一幅 (色なしは transparent) にして
          // 行頭テキストの揃えを保つ (#350)。
          borderLeftWidth="4px"
          borderLeftColor={borderLeftColor}
          bg={rowBg}
          _hover={{ bg: rowBg ?? "app.hover" }}
          // ホバーで控えめに拡大 + 影を出すモーション (#386, Epic #370 準拠)。
          // prefers-reduced-motion はルートの MotionConfig が自動抑制する。
          whileHover={{ scale: 1.01, boxShadow: "0 2px 8px rgba(0, 0, 0, 0.12)" }}
          transition={springs.gentle}
          style={{ transformOrigin: "center left" }}
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
          <TreeChevron transform={isOpen ? "rotate(90deg)" : undefined} aria-hidden>▸</TreeChevron>
          {/* ドライバ別ブランドアイコン (MySQL/PostgreSQL/SQLite) でひと目で種別が
              分かるようにする (#386)。ユーザ設定のカスタム色があればそれで着色して
              個別識別性も残し、無ければドライバのブランド色を使う。プロファイルカラーは
              左端のアクセントバーにも出る。未知ドライバは汎用 server アイコン。 */}
          <TreeIcon color={accent ?? (driverIcon ? driverColor(p.driver) : "app.accent")} aria-hidden>
            <Icon name={driverIcon ?? "server"} />
          </TreeIcon>
          <chakra.span
            display="flex"
            flexDirection="column"
            justifyContent="center"
            gap="1px"
            minWidth={0}
            lineHeight="1.25"
          >
            <chakra.span
              overflow="hidden"
              textOverflow="ellipsis"
              whiteSpace="nowrap"
              fontWeight={isActive ? 700 : 600}
              fontSize="md"
              color={isActive ? "app.text" : undefined}
            >
              <HighlightText text={p.name} query={q} />
            </chakra.span>
            <chakra.span
              overflow="hidden"
              textOverflow="ellipsis"
              whiteSpace="nowrap"
              fontSize="2xs"
              fontFamily="mono"
              color={isActive ? "app.textSecondary" : "app.textMuted"}
              title={subtitle}
            >
              {subtitle}
            </chakra.span>
          </chakra.span>
          {p.is_production && (
            <TreeBadge
              display="inline-flex"
              alignItems="center"
              gap="4px"
              bg="app.status.error"
              color="#fff"
              borderColor="app.status.error"
              fontSize="xs"
              fontWeight={700}
              letterSpacing="0.06em"
              px="8px"
              py="2px"
              title={t("listProductionTitle")}
            >
              <Icon name="warning" size={12} />
              {t("listProduction")}
            </TreeBadge>
          )}
          {p.read_only && (
            <TreeBadge
              display="inline-flex"
              alignItems="center"
              gap="4px"
              bg="var(--status-info, var(--bg-muted))"
              color="app.text"
              borderColor="app.borderStrong"
              fontSize="xs"
              fontWeight={700}
              letterSpacing="0.06em"
              px="8px"
              py="2px"
              title={t("listReadOnlyTitle")}
            >
              <Icon name="key" size={12} />
              {t("listReadOnly")}
            </TreeBadge>
          )}
          {p.ssh && (
            <TreeBadge
              display="inline-flex"
              alignItems="center"
              gap="4px"
              bg="app.surfaceMuted"
              color="app.textSecondary"
              borderColor="app.borderStrong"
              fontSize="xs"
              fontWeight={700}
              letterSpacing="0.06em"
              px="8px"
              py="2px"
              title={t("listSshTitle")}
            >
              <Icon name="lock" size={12} />
              {t("listSsh")}
            </TreeBadge>
          )}
          {status === "connected" && (
            <chakra.button
              type="button"
              flexShrink={0}
              display="inline-flex"
              alignItems="center"
              justifyContent="center"
              p="2px"
              color="app.textMuted"
              bg="transparent"
              border="none"
              borderRadius="sm"
              cursor="pointer"
              _hover={refreshing ? undefined : { color: "app.text", bg: "var(--bg-hover, var(--bg-muted))" }}
              _disabled={{ cursor: "default" }}
              onClick={(e) => {
                e.stopPropagation();
                void refreshSchema();
              }}
              disabled={refreshing}
              title={t("treeRefreshTitle")}
              aria-label={t("treeRefresh")}
            >
              <chakra.span
                display="inline-flex"
                animation={refreshing ? "spinner-rotate 0.7s linear infinite" : undefined}
              >
                <Icon name="refresh" size={13} />
              </chakra.span>
            </chakra.button>
          )}
          <chakra.span
            display="inline-block"
            width="8px"
            height="8px"
            borderRadius="50%"
            flexShrink={0}
            transitionProperty="background, box-shadow"
            transitionDuration="var(--dur-med)"
            transitionTimingFunction="var(--ease)"
            {...STATUS_DOT_STYLE[status]}
            aria-label={statusLabel(status)}
            title={statusLabel(status)}
          />
          <TreeBadge
            color={driverIcon ? driverColor(p.driver) : undefined}
            borderColor={driverIcon ? "color-mix(in srgb, currentColor 40%, transparent)" : undefined}
          >
            {p.driver}
          </TreeBadge>
        </MotionTreeRow>

        <TreeCollapse open={!!(isOpen && isActive && sessionId)}>
          <TreeChildren>
            {databases === null ? (
              renderLoadingRow()
            ) : databases.length === 0 ? (
              <TreeEmpty>{t("treeNoDatabases")}</TreeEmpty>
            ) : (
              databases
                .filter((db) => !schemaFiltered || dbNodeMatches(db))
                .map((db) => {
                const dbNameHit = searching && db.toLowerCase().includes(q);
                const dbOpen = !!expandedDbs[db] || (schemaFiltered && dbNodeMatches(db));
                const dbTables = tables[db];
                return (
                  <TreeNode key={db}>
                    <TreeRow
                      pl="4px"
                      onClick={() => toggleDb(db)}
                      onContextMenu={(e) => handleDbContextMenu(e, db)}
                      role="treeitem"
                      aria-expanded={dbOpen}
                      title={db}
                    >
                      <TreeChevron transform={dbOpen ? "rotate(90deg)" : undefined} aria-hidden>▸</TreeChevron>
                      <TreeIcon color="#0ea5e9" aria-hidden><Icon name="database" /></TreeIcon>
                      <TreeLabel fontWeight={400}><HighlightText text={db} query={q} /></TreeLabel>
                    </TreeRow>
                    <TreeCollapse open={dbOpen}>
                      <TreeChildren>
                        {dbTables === undefined ? (
                          renderLoadingRow()
                        ) : dbTables.length === 0 ? (
                          <TreeEmpty>{t("treeNoTables")}</TreeEmpty>
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
                            const rowEst = rowEstimates[db]?.[tbl];
                            const rowEstLabel =
                              typeof rowEst === "number" ? formatRowEstimate(rowEst) : "";
                            return (
                              <TreeNode key={tbl}>
                                <TreeRow
                                  pl="4px"
                                  role="treeitem"
                                  aria-expanded={tOpen}
                                  onClick={() => toggleTable(db, tbl)}
                                  onDoubleClick={() => onPickTable(db, tbl)}
                                  onContextMenu={(e) => handleTableContextMenu(e, db, tbl)}
                                  title={t("treeTableTitle")}
                                  _hover={{ bg: "app.rowHover" }}
                                >
                                  <TreeChevron transform={tOpen ? "rotate(90deg)" : undefined} aria-hidden>▸</TreeChevron>
                                  <TreeIcon color="app.textSecondary" aria-hidden><Icon name="table" /></TreeIcon>
                                  <TreeLabel fontWeight={400}><HighlightText text={tbl} query={q} /></TreeLabel>
                                  {rowEstLabel && (
                                    <TreeBadge
                                      fontFamily="mono"
                                      fontSize="2xs"
                                      textTransform="none"
                                      letterSpacing="0"
                                      title={`${rowEst!.toLocaleString()} — ${t("treeRowEstimateTitle")}`}
                                    >
                                      {rowEstLabel}
                                    </TreeBadge>
                                  )}
                                </TreeRow>
                                <TreeCollapse open={tOpen}>
                                  <TreeChildren>
                                    {cols === undefined ? (
                                      renderLoadingRow()
                                    ) : cols.length === 0 ? (
                                      <TreeEmpty>{t("treeNoColumns")}</TreeEmpty>
                                    ) : (
                                      cols
                                        .filter((col) => showAllCols || col.name.toLowerCase().includes(q))
                                        .map((col) => {
                                        const isPk = col.key === "PRI";
                                        const isFk = col.referenced_table !== null;
                                        return (
                                          <TreeRow
                                            key={col.name}
                                            pt="3px"
                                            pb="3px"
                                            cursor="default"
                                            fontSize="sm"
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
                                            <TreeChevron visibility="hidden" aria-hidden />
                                            <TreeIcon
                                              fontSize="xs"
                                              color={isPk ? "app.cell.date" : isFk ? "#f59e0b" : "app.textMuted"}
                                              title={isPk ? t("colPkTitle") : isFk ? t("colFkTitle") : undefined}
                                              aria-hidden
                                            >
                                              {isPk ? <Icon name="key" /> : isFk ? <Icon name="link" /> : "·"}
                                            </TreeIcon>
                                            <TreeLabel fontFamily="mono" color="app.text"><HighlightText text={col.name} query={q} /></TreeLabel>
                                            <TreeBadge
                                              fontFamily="mono"
                                              textTransform="lowercase"
                                              fontSize="2xs"
                                              title={col.data_type}
                                            >
                                              {col.data_type}
                                            </TreeBadge>
                                          </TreeRow>
                                        );
                                      })
                                    )}
                                  </TreeChildren>
                                </TreeCollapse>
                              </TreeNode>
                            );
                          })
                        )}
                      </TreeChildren>
                    </TreeCollapse>
                  </TreeNode>
                );
              })
            )}
          </TreeChildren>
        </TreeCollapse>
      </MotionTreeNode>
    );
  };

  return (
    <Flex direction="column" overflow="hidden" flex="1">
      <Box px="10px" py="8px" borderBottom="1px solid" borderColor="app.borderSubtle">
        <Input
          ref={filterInputRef}
          type="search"
          py="5px"
          fontSize="sm"
          placeholder={t("listSearchPlaceholder")}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </Box>

      {error && (
        <Box
          px="12px"
          py="6px"
          fontSize="xs"
          color="app.textError"
          bg="app.bgError"
          borderBottom="1px solid"
          borderColor="app.borderSubtle"
        >
          {error}
        </Box>
      )}

      {profiles.length === 0 ? (
        <EmptyState
          icon="server"
          title={t("listEmptyTitle")}
          description={t("listEmptyDesc")}
          action={{ label: t("listCreateFirst"), onClick: onCreate }}
        />
      ) : visibleProfiles.length === 0 ? (
        <Text color="app.textMuted" p="12px">{t("listNoMatches")}</Text>
      ) : (
        <Box flex="1" overflowY="auto" py="4px" fontSize="md" color="app.text" role="tree">
          {grouped === null
            ? <AnimatePresence initial={false}>{visibleProfiles.map(renderProfile)}</AnimatePresence>
            : grouped.map((g) => {
                const key = g.name ?? "__ungrouped__";
                const groupOpen = expandedGroups[key] !== false;
                const label = g.name ?? t("listGroupUngrouped");
                return (
                  <TreeNode key={key}>
                    <Box
                      display="flex"
                      alignItems="center"
                      gap="var(--space-1)"
                      whiteSpace="nowrap"
                      overflow="hidden"
                      userSelect="none"
                      cursor="pointer"
                      pt="6px"
                      pr="10px"
                      pb="6px"
                      pl="6px"
                      fontSize="xs"
                      textTransform="uppercase"
                      letterSpacing="0.06em"
                      color="app.textMuted"
                      bg="app.surfaceMuted"
                      borderTop="1px solid"
                      borderTopColor="app.borderSubtle"
                      borderBottom="1px solid"
                      borderBottomColor="app.borderSubtle"
                      borderLeft="2px solid transparent"
                      transitionProperty="background, color, border-color, box-shadow"
                      transitionDuration="var(--dur-fast)"
                      transitionTimingFunction="var(--ease)"
                      _hover={{ bg: "app.hover", color: "app.text" }}
                      onClick={() =>
                        setExpandedGroups((prev) => ({ ...prev, [key]: prev[key] === false ? true : false }))
                      }
                      role="treeitem"
                      aria-expanded={groupOpen}
                    >
                      <TreeChevron transform={groupOpen ? "rotate(90deg)" : undefined} aria-hidden>▸</TreeChevron>
                      <chakra.span flex="1" fontWeight={600} overflow="hidden" textOverflow="ellipsis">
                        {label}
                      </chakra.span>
                      <TreeBadge textTransform="none" letterSpacing="0">{g.profiles.length}</TreeBadge>
                    </Box>
                    <TreeCollapse open={groupOpen}>
                      <Box display="flex" flexDirection="column">
                        <AnimatePresence initial={false}>
                          {g.profiles.map(renderProfile)}
                        </AnimatePresence>
                      </Box>
                    </TreeCollapse>
                  </TreeNode>
                );
              })}
        </Box>
      )}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      )}

      {hoveredColumn && <ColumnTooltip col={hoveredColumn.col} anchor={hoveredColumn.rect} />}
    </Flex>
  );
}));

const TooltipDt = chakra("dt", { base: { color: "app.textMuted", whiteSpace: "nowrap" } });
const TooltipDd = chakra("dd", { base: { m: 0, fontFamily: "mono", wordBreak: "break-all" } });

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
    <Box
      ref={ref}
      role="tooltip"
      position="fixed"
      zIndex="popover"
      maxWidth="280px"
      bg="app.surface"
      border="1px solid"
      borderColor="app.borderStrong"
      borderRadius="md"
      boxShadow="md"
      p="8px 10px"
      fontSize="sm"
      color="app.text"
      pointerEvents="none"
      left={`${pos ? pos.left : anchor.right + 8}px`}
      top={`${pos ? pos.top : anchor.top}px`}
      visibility={pos ? "visible" : "hidden"}
    >
      <chakra.div fontFamily="mono" fontWeight={600} mb="6px" wordBreak="break-all">
        {col.name}
      </chakra.div>
      <chakra.dl display="grid" gridTemplateColumns="auto 1fr" gap="2px 10px" m={0}>
        <TooltipDt>{t("colTipType")}</TooltipDt>
        <TooltipDd>{col.data_type}</TooltipDd>
        <TooltipDt>{t("colTipNullable")}</TooltipDt>
        <TooltipDd>{col.nullable ? t("colTipYes") : t("colTipNo")}</TooltipDd>
        {col.default !== null && (
          <>
            <TooltipDt>{t("colTipDefault")}</TooltipDt>
            <TooltipDd>{col.default}</TooltipDd>
          </>
        )}
        {col.key && (
          <>
            <TooltipDt>{t("colTipKey")}</TooltipDt>
            <TooltipDd>{keyLabel}</TooltipDd>
          </>
        )}
        {reference && (
          <>
            <TooltipDt>{t("colTipReferences")}</TooltipDt>
            <TooltipDd>{reference}</TooltipDd>
          </>
        )}
        {col.extra && (
          <>
            <TooltipDt>{t("colTipExtra")}</TooltipDt>
            <TooltipDd>{col.extra}</TooltipDd>
          </>
        )}
      </chakra.dl>
    </Box>
  );
}
