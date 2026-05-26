import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  api,
  CellValue,
  Column,
  ConnectionProfile,
  DriverKind,
  PreviewResult,
  QueryResult,
  Snippet,
  TableColumnInfo,
  TableSchema,
  listenPreviewStream,
  listenQueryStream,
} from "./api/tauri";
import {
  buildUpdateStatements,
  countEditedCells,
  countEditedRows,
  resolvePkIndices,
  type PendingEdits,
} from "./components/cellEdit";
import { ConnectionList } from "./components/ConnectionList";
import { ConnectionForm } from "./components/ConnectionForm";
import { EmptyState } from "./components/EmptyState";
import { Spinner } from "./components/Spinner";
import { SnippetList } from "./components/SnippetList";
import { SnippetForm } from "./components/SnippetForm";
import { HistoryList } from "./components/HistoryList";
import { QueryEditor, type QueryEditorHandle, type SchemaTable } from "./components/QueryEditor";
import type { QueryBuilderSnapshot } from "./components/QueryBuilder";
import { ResultGrid, type ResultGridHandle } from "./components/ResultGrid";
import { PreviewGrid } from "./components/PreviewGrid";
import { ExplainViewer } from "./components/ExplainViewer";
import { TabBar } from "./components/TabBar";
import { TitleBar } from "./components/TitleBar";
import { ImportModal } from "./components/ImportModal";
import { DumpModal } from "./components/DumpModal";
import { HelpView } from "./components/HelpView";
import { SettingsView } from "./components/SettingsView";
import { DangerousQueryDialog } from "./components/DangerousQueryDialog";
import { Splitter } from "./components/Splitter";
import { Icon } from "./components/Icon";
import { analyzeDangerousSql, type DangerFinding } from "./dangerousSql";
import { matchErrorHint } from "./errorHints";
import { t as translate, useT } from "./i18n";
import { useSettings, type TabRestoreMode } from "./settings";
import {
  clearPersistedTabs,
  loadPersistedTabs,
  savePersistedTabs,
  type PersistedTab,
} from "./tabPersistence";

type Theme = "light" | "dark";

const THEME_STORAGE_KEY = "noobdb.theme";

function readInitialTheme(): Theme {
  const saved = localStorage.getItem(THEME_STORAGE_KEY);
  if (saved === "light" || saved === "dark") return saved;
  if (typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches) {
    return "dark";
  }
  return "light";
}

const SIDEBAR_WIDTH_KEY = "noobdb.sidebarWidth";
const SIDEBAR_COLLAPSED_KEY = "noobdb.sidebarCollapsed";
const SIDEBAR_MIN_WIDTH = 200;
const SIDEBAR_MAX_WIDTH = 560;
const SIDEBAR_DEFAULT_WIDTH = 300;
// Below this window width the sidebar auto-collapses to give the main area room;
// the user can still open it on demand (it then overlays the editor, see CSS).
const NARROW_BREAKPOINT = 760;

const clampSidebarWidth = (w: number) =>
  Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, w));

function readInitialSidebarWidth(): number {
  const saved = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
  return Number.isFinite(saved) && saved > 0 ? clampSidebarWidth(saved) : SIDEBAR_DEFAULT_WIDTH;
}

type Status =
  | { kind: "literal"; text: string; error?: boolean }
  | { kind: "key"; key: Parameters<ReturnType<typeof useT>>[0]; vars?: Record<string, string | number>; error?: boolean };

type StatusTone = "running" | "success" | "error" | "info";

// Status keys that represent an in-progress operation (spinner + accent border).
const RUNNING_STATUS_KEYS = new Set([
  "statusConnecting",
  "statusRunningQuery",
  "statusRunningPreview",
  "statusApplyingEdits",
]);

// Maps a status to a tone for the footer's icon + colored left border (#131).
// Derived from the existing `error` flag and known keys, so call sites don't
// each have to declare a severity.
function statusTone(s: Status): StatusTone {
  if (s.error) return "error";
  if (s.kind === "key") {
    if (RUNNING_STATUS_KEYS.has(s.key)) return "running";
    if (s.key === "appDisconnected") return "info";
    return "success";
  }
  return "info";
}

type TabKind = "table" | "query" | "explain";

const EXPLAIN_PREFIX = "EXPLAIN FORMAT=JSON ";

interface Tab {
  id: string;
  kind: TabKind;
  title: string;
  database?: string;
  table?: string;
  sql: string;
  /**
   * The SQL last executed in this tab. Drives the unsaved-edit ("dirty")
   * indicator: a query tab is dirty when `sql` diverges from this. Updated on
   * every run; in-memory only (not persisted).
   */
  lastExecutedSql: string;
  result: QueryResult | null;
  preview: PreviewResult | null;
  schemaTable: SchemaTable | null;
  /** True while a streaming command is feeding rows into `result`/`preview`. */
  streaming: boolean;
  /** Snapshot row cap used for the active preview stream. */
  previewRowLimit: number;
  /**
   * Base SQL (no LIMIT/OFFSET) used to fetch additional pages when the user
   * scrolls past the bottom of `result.rows`. Set only when the current
   * result was produced by an auto-generated "open table" query — custom
   * user SQL is not paginatable because we don't know its row identity.
   */
  paginatable: string | null;
  /**
   * Row cap that was auto-injected into the last run (from the stream's done
   * event), or null when no auto LIMIT was applied. Drives the "auto LIMIT N
   * applied" badge near the result grid.
   */
  autoLimitApplied: number | null;
  /**
   * The exact SQL that was run with an auto LIMIT, so the badge's "fetch all"
   * action can re-run it uncapped even after the editor text has changed.
   */
  autoLimitSql: string | null;
  /** True while a load-more request for this tab is in flight. */
  loadingMore: boolean;
  /** True when another scroll-triggered page may yield more rows. */
  canLoadMore: boolean;
  /**
   * Column metadata for the underlying table (only table tabs). Used to
   * detect the primary key for inline cell edits and to decide which
   * columns can be edited (e.g. BLOB columns are excluded).
   */
  tableColumns: TableColumnInfo[] | null;
  /**
   * Inline cell edits awaiting Preview/Apply. Keyed by the row index in
   * `result.rows` (the canonical "original" position) then by the column
   * index in `result.columns`. Cleared on Apply success or Cancel.
   */
  pendingEdits: PendingEdits;
  /**
   * Most recent Query Builder inputs captured on its Run / Dry Run, restored
   * when the builder is reopened in this tab. In-memory only (not persisted),
   * so it is discarded when the tab closes, the connection drops, or the app
   * exits. Holds the latest single snapshot — no history.
   */
  builderSnapshot: QueryBuilderSnapshot | null;
}

let tabSeq = 0;
function newTabId(): string {
  tabSeq += 1;
  return `tab_${Date.now().toString(36)}_${tabSeq.toString(36)}`;
}

function newStreamId(tabId: string): string {
  return `${tabId}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function quoteIdent(driver: string, ident: string): string {
  if (driver === "postgres" || driver === "sqlite") {
    return `"${ident.replace(/"/g, '""')}"`;
  }
  return `\`${ident.replace(/`/g, "``")}\``;
}

function qualifiedTableSql(driver: string, database: string, table: string): string {
  // SQLite has a single attached namespace ("main"); leaving the
  // db.table qualification off keeps the generated SELECT portable.
  if (driver === "sqlite") return `SELECT * FROM ${quoteIdent(driver, table)}`;
  return `SELECT * FROM ${quoteIdent(driver, database)}.${quoteIdent(driver, table)}`;
}

// SQL that returns a table's definition, or null for drivers without a
// single-statement form (Postgres). MySQL uses SHOW CREATE TABLE; SQLite reads
// the original DDL out of sqlite_master.
function tableDefinitionSql(driver: string, database: string, table: string): string | null {
  if (driver === "mysql") {
    return `SHOW CREATE TABLE ${quoteIdent(driver, database)}.${quoteIdent(driver, table)}`;
  }
  if (driver === "sqlite") {
    return `SELECT sql FROM sqlite_master WHERE type IN ('table', 'view') AND name = '${table.replace(/'/g, "''")}'`;
  }
  return null;
}

// Cache key for a database's whole-schema autocomplete snapshot. The NUL
// separator can't appear in a session id or database name, so it can't
// collide across (session, database) pairs.
function schemaCacheKey(sessionId: string, database: string): string {
  return `${sessionId}\0${database}`;
}

// True when `sql` is DDL that can add/rename/remove tables or columns, so the
// cached schema for autocomplete must be refreshed afterwards. Best-effort: a
// false positive only triggers a cheap re-fetch.
function isSchemaMutatingSql(sql: string): boolean {
  const head = sql.trimStart().replace(/^\(+\s*/, "").toLowerCase();
  return /^(create|alter|drop|rename|truncate)\b/.test(head);
}

function makeQueryTab(): Tab {
  const sql = "SELECT 1;";
  return {
    id: newTabId(),
    kind: "query",
    title: translate("tabUntitledQuery"),
    sql,
    lastExecutedSql: sql,
    result: null,
    preview: null,
    schemaTable: null,
    streaming: false,
    previewRowLimit: 100,
    paginatable: null,
    autoLimitApplied: null,
    autoLimitSql: null,
    loadingMore: false,
    canLoadMore: false,
    tableColumns: null,
    pendingEdits: {},
    builderSnapshot: null,
  };
}

function explainTabTitle(sql: string): string {
  const oneLine = sql.replace(/\s+/g, " ").trim();
  const base = translate("tabExplainTitle");
  if (!oneLine) return base;
  const snippet = oneLine.length > 28 ? `${oneLine.slice(0, 28)}…` : oneLine;
  return `${base}: ${snippet}`;
}

function makeExplainTab(sql: string): Tab {
  return {
    id: newTabId(),
    kind: "explain",
    title: explainTabTitle(sql),
    sql,
    lastExecutedSql: sql,
    result: null,
    preview: null,
    schemaTable: null,
    streaming: false,
    previewRowLimit: 100,
    paginatable: null,
    autoLimitApplied: null,
    autoLimitSql: null,
    loadingMore: false,
    canLoadMore: false,
    tableColumns: null,
    pendingEdits: {},
    builderSnapshot: null,
  };
}

function toPersistedTab(tab: Tab): PersistedTab {
  const out: PersistedTab = { kind: tab.kind, title: tab.title, sql: tab.sql };
  if (tab.database) out.database = tab.database;
  if (tab.table) out.table = tab.table;
  return out;
}

function shouldRestoreSavedTabs(mode: TabRestoreMode, count: number): boolean {
  if (mode === "always") return true;
  if (mode === "never") return false;
  return window.confirm(translate("tabRestoreConfirm", { count }));
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
  const [showHelp, setShowHelp] = useState(false);

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
    root.style.setProperty("--preview-highlight", settings.previewHighlight[theme]);
  }, [settings, theme]);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => (prev === "dark" ? "light" : "dark"));
  }, []);

  // Sidebar width is drag-resizable and persisted in px. Collapsing is split
  // into a persisted user preference (wide screens) and a transient open state
  // for narrow screens, where the sidebar auto-collapses to free up space.
  const [sidebarWidth, setSidebarWidth] = useState<number>(readInitialSidebarWidth);
  const [sidebarUserCollapsed, setSidebarUserCollapsed] = useState<boolean>(
    () => localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1",
  );
  const [narrow, setNarrow] = useState<boolean>(() => window.innerWidth < NARROW_BREAKPOINT);
  const [narrowSidebarOpen, setNarrowSidebarOpen] = useState(false);
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const sidebarResizingRef = useRef(false);

  const sidebarCollapsed = narrow ? !narrowSidebarOpen : sidebarUserCollapsed;

  useEffect(() => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
  }, [sidebarWidth]);

  useEffect(() => {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, sidebarUserCollapsed ? "1" : "0");
  }, [sidebarUserCollapsed]);

  useEffect(() => {
    const onResize = () => {
      const isNarrow = window.innerWidth < NARROW_BREAKPOINT;
      setNarrow((prev) => {
        // Leaving narrow mode drops the transient open state so it doesn't
        // linger as a stuck overlay on the next narrowing.
        if (prev && !isNarrow) setNarrowSidebarOpen(false);
        return isNarrow;
      });
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const toggleSidebar = useCallback(() => {
    if (window.innerWidth < NARROW_BREAKPOINT) setNarrowSidebarOpen((v) => !v);
    else setSidebarUserCollapsed((v) => !v);
  }, []);

  // Lock the cursor while dragging so it doesn't flicker off the thin handle.
  useEffect(() => {
    if (!sidebarResizing) return;
    const prev = document.body.style.cursor;
    document.body.style.cursor = "ew-resize";
    return () => {
      document.body.style.cursor = prev;
    };
  }, [sidebarResizing]);

  const onSidebarResizePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    sidebarResizingRef.current = true;
    setSidebarResizing(true);
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  }, []);

  const onSidebarResizePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!sidebarResizingRef.current) return;
    setSidebarWidth(clampSidebarWidth(e.clientX));
  }, []);

  const onSidebarResizePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    sidebarResizingRef.current = false;
    setSidebarResizing(false);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  }, []);

  const [profiles, setProfiles] = useState<ConnectionProfile[]>([]);
  const [selectedProfile, setSelectedProfile] = useState<ConnectionProfile | null>(null);
  const [editing, setEditing] = useState<ConnectionProfile | null>(null);
  const [showForm, setShowForm] = useState(false);

  const [sidebarTab, setSidebarTab] = useState<"connections" | "snippets" | "history">("connections");
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [historyReloadKey, setHistoryReloadKey] = useState(0);
  const [editingSnippet, setEditingSnippet] = useState<Snippet | null>(null);
  const [snippetFormSql, setSnippetFormSql] = useState<string>("");
  const [showSnippetForm, setShowSnippetForm] = useState(false);
  // Bumped every time a form is opened so the form is keyed by this counter and
  // remounts on each open. The forms initialise their fields from `initial` via
  // useState (evaluated only at mount), so without a fresh key, switching the
  // edit target while the form stays open would leave stale field values.
  const [formInstanceId, setFormInstanceId] = useState(0);
  const editorRef = useRef<QueryEditorHandle>(null);
  const resultGridRef = useRef<ResultGridHandle>(null);

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [errorProfileId, setErrorProfileId] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "key", key: "appDisconnected" });
  // Lets the user dismiss the error-hint banner. Reset whenever the status
  // changes (a new query result, connect/disconnect, connection switch, etc.)
  // so a fresh error still shows its hint.
  const [hintDismissed, setHintDismissed] = useState(false);

  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [importTarget, setImportTarget] = useState<{ database: string; table: string } | null>(null);
  const [dumpTarget, setDumpTarget] = useState<string | null>(null);
  // Whole-schema autocomplete snapshots, keyed by schemaCacheKey(session, db).
  // Fetched lazily per database and reused across tabs; invalidated after DDL
  // and dropped wholesale when the session changes.
  const [schemaCache, setSchemaCache] = useState<Record<string, TableSchema[]>>({});
  // Keys with a schemaOverview request in flight, so the fetch effect doesn't
  // fire a duplicate while one is pending.
  const schemaInFlightRef = useRef<Set<string>>(new Set());
  // Set while a destructive query awaits confirmation; holds everything needed
  // to run it once the user accepts the warning dialog.
  const [pendingDangerous, setPendingDangerous] = useState<{
    tabId: string;
    sql: string;
    findings: DangerFinding[];
    isProduction: boolean;
    autoLimit: number | null;
  } | null>(null);

  const activeTab = useMemo(
    () => tabs.find((tt) => tt.id === activeTabId) ?? null,
    [tabs, activeTabId],
  );

  // Database the editor queries against — the active tab's, else the profile
  // default. Drives both which schema snapshot to fetch and which to feed the
  // editor for autocomplete.
  const editorDatabase = activeTab?.database ?? selectedProfile?.database ?? null;
  const editorSchema = useMemo<TableSchema[] | null>(() => {
    if (!sessionId || !editorDatabase) return null;
    return schemaCache[schemaCacheKey(sessionId, editorDatabase)] ?? null;
  }, [sessionId, editorDatabase, schemaCache]);

  // Per-tab stream bookkeeping. Listener cleanup and the active stream id
  // are held in refs so we don't trigger re-renders on every batch and so
  // we can synchronously cancel from anywhere (tab close, disconnect).
  const streamUnlistenRef = useRef<Map<string, UnlistenFn>>(new Map());
  const streamIdRef = useRef<Map<string, string>>(new Map());

  // restoreSavedTabs is declared after runQueryInTab; the ref breaks the
  // ordering cycle so handleConnect (declared above) can still call it.
  const restoreSavedTabsRef = useRef<
    | ((sid: string, profile: ConnectionProfile, saved: PersistedTab[]) => Promise<void>)
    | null
  >(null);

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

  const refreshSnippets = useCallback(async () => {
    try {
      const list = await api.listSnippets();
      setSnippets(list);
    } catch (e) {
      setStatus({ kind: "key", key: "statusFailedLoadSnippets", vars: { error: String(e) }, error: true });
    }
  }, []);

  useEffect(() => {
    refreshSnippets();
  }, [refreshSnippets]);

  // Keep the active profile pointer in sync when the profile is edited or
  // when the saved list is refreshed for any other reason.
  useEffect(() => {
    if (!selectedProfile) return;
    const fresh = profiles.find((p) => p.id === selectedProfile.id);
    if (fresh && fresh !== selectedProfile) setSelectedProfile(fresh);
  }, [profiles, selectedProfile]);

  // Snapshot the current tab list (from a ref so we don't depend on the
  // stale closure copy) into localStorage under the given profile id.
  const persistTabsForProfile = useCallback((profileId: string) => {
    const snapshot = tabsRef.current.map(toPersistedTab);
    savePersistedTabs(profileId, snapshot);
  }, []);

  const closeAllTabs = useCallback(async () => {
    // Cancel any in-flight streams before tearing down tabs.
    const ids = Array.from(streamIdRef.current.keys());
    await Promise.all(ids.map((tid) => cancelStreamForTab(tid)));
    setTabs([]);
    setActiveTabId(null);
  }, [cancelStreamForTab]);

  const handleConnect = useCallback(async (profile: ConnectionProfile) => {
    if (profile.is_production && settings.confirmProductionConnect) {
      const ok = window.confirm(translate("productionConfirm", { name: profile.name }));
      if (!ok) return;
    }
    setConnectingId(profile.id);
    setErrorProfileId(null);
    setStatus({ kind: "key", key: "statusConnecting", vars: { name: profile.name } });
    if (sessionId) {
      // Persist the outgoing profile's tabs before we tear them down.
      if (selectedProfile) persistTabsForProfile(selectedProfile.id);
      try { await api.disconnect(sessionId); } catch (e) { console.warn(e); }
      setSessionId(null);
      await closeAllTabs();
    }
    try {
      const driver: DriverKind =
        profile.driver === "postgres" || profile.driver === "sqlite" || profile.driver === "mysql"
          ? profile.driver
          : "mysql";
      const res = await api.connect({
        profile_id: profile.id,
        driver,
        host: profile.host,
        port: profile.port,
        user: profile.user,
        password: "",
        database: profile.database,
        ssh: profile.ssh ? { ...profile.ssh, passphrase: "" } : null,
        file_path: profile.file_path,
        read_only: profile.read_only,
        skip_history: profile.skip_history,
      });
      setSessionId(res.session_id);
      setSelectedProfile(profile);

      const saved = loadPersistedTabs(profile.id);
      const restore =
        saved.length > 0 && shouldRestoreSavedTabs(settings.tabRestoreMode, saved.length);
      if (restore && restoreSavedTabsRef.current) {
        await restoreSavedTabsRef.current(res.session_id, profile, saved);
      } else {
        if (saved.length > 0 && !restore) clearPersistedTabs(profile.id);
        const tab = makeQueryTab();
        setTabs([tab]);
        setActiveTabId(tab.id);
      }
      setStatus({ kind: "key", key: "statusConnected", vars: { name: profile.name, id: res.session_id } });
    } catch (e) {
      setErrorProfileId(profile.id);
      setStatus({ kind: "key", key: "statusConnectionFailed", vars: { error: String(e) }, error: true });
    } finally {
      setConnectingId(null);
    }
  }, [
    sessionId,
    selectedProfile,
    closeAllTabs,
    persistTabsForProfile,
    settings.confirmProductionConnect,
    settings.tabRestoreMode,
  ]);

  const handleDisconnect = useCallback(async () => {
    if (!sessionId) return;
    // Persist before tearing down — closeAllTabs clears the in-memory list.
    if (selectedProfile) persistTabsForProfile(selectedProfile.id);
    await closeAllTabs();
    try {
      await api.disconnect(sessionId);
    } catch (e) {
      console.warn(e);
    }
    setSessionId(null);
    setSelectedProfile(null);
    setImportTarget(null);
    setDumpTarget(null);
    setStatus({ kind: "key", key: "appDisconnected" });
  }, [sessionId, selectedProfile, closeAllTabs, persistTabsForProfile]);

  // A query or preview failed because the connection dropped (server idle
  // timeout, network or VPN loss). Tear the now-dead session down the same way
  // an explicit Disconnect would — close tabs and release the backend session
  // and its SSH tunnel — then surface a clear reconnect message. The dropped
  // profile is flagged in the connection list so reconnecting is one click.
  const handleConnectionLost = useCallback(async () => {
    if (!sessionId) return;
    const lostProfileId = selectedProfile?.id ?? null;
    if (selectedProfile) persistTabsForProfile(selectedProfile.id);
    await closeAllTabs();
    try {
      await api.disconnect(sessionId);
    } catch (e) {
      console.warn(e);
    }
    setSessionId(null);
    setSelectedProfile(null);
    setImportTarget(null);
    setDumpTarget(null);
    setErrorProfileId(lostProfileId);
    setStatus({ kind: "key", key: "statusConnectionLost", error: true });
  }, [sessionId, selectedProfile, closeAllTabs, persistTabsForProfile]);

  // Held in a ref so the streaming callbacks below (created before this
  // handler) can invoke the latest version without re-subscribing on every
  // connection change.
  const handleConnectionLostRef = useRef(handleConnectionLost);
  handleConnectionLostRef.current = handleConnectionLost;

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
          tableColumns: cols,
        });
      })
      .catch(() => { /* ignore */ });
    return () => { cancelled = true; };
  }, [sessionId, activeTab, updateTab]);

  // Drop every cached schema when the session changes so a new connection
  // never autocompletes against the previous database's tables.
  useEffect(() => {
    setSchemaCache({});
    schemaInFlightRef.current.clear();
  }, [sessionId]);

  // Fetch the whole-schema snapshot for the editor's database on demand and
  // cache it. Runs on connect (first tab's database), when the editor moves to
  // another database, and again after an invalidation drops the cache entry.
  useEffect(() => {
    if (!sessionId || !editorDatabase) return;
    const key = schemaCacheKey(sessionId, editorDatabase);
    if (key in schemaCache || schemaInFlightRef.current.has(key)) return;
    schemaInFlightRef.current.add(key);
    let cancelled = false;
    api.schemaOverview(sessionId, editorDatabase)
      .then((schema) => {
        if (!cancelled) setSchemaCache((prev) => ({ ...prev, [key]: schema }));
      })
      .catch(() => { /* autocomplete is best-effort; ignore failures */ })
      .finally(() => { schemaInFlightRef.current.delete(key); });
    return () => { cancelled = true; };
  }, [sessionId, editorDatabase, schemaCache]);

  // Forget cached schemas so the fetch effect re-pulls fresh tables/columns —
  // called after DDL. Clearing the whole map is fine: entries are cheap to
  // rebuild and only the active database's snapshot is fetched eagerly.
  const invalidateSchemaCache = useCallback(() => {
    schemaInFlightRef.current.clear();
    setSchemaCache({});
  }, []);

  // Tabs ref kept in sync so streaming callbacks below can read the latest
  // committed tab state without re-creating themselves on every batch.
  const tabsRef = useRef<Tab[]>(tabs);
  useEffect(() => { tabsRef.current = tabs; }, [tabs]);
  const activeTabIdRef = useRef<string | null>(activeTabId);
  useEffect(() => { activeTabIdRef.current = activeTabId; }, [activeTabId]);

  const nextRowCount = useCallback((tabId: string, justAdded: number) => {
    const tt = tabsRef.current.find((x) => x.id === tabId);
    if (tt?.result) return tt.result.rows.length;
    return justAdded;
  }, []);

  const runQueryInTab = useCallback(async (
    tabId: string,
    sql: string,
    paginatableBase: string | null = null,
    autoLimit: number | null = null,
  ) => {
    if (!sessionId) {
      setStatus({ kind: "key", key: "statusNotConnected", error: true });
      return;
    }
    const tab = tabs.find((tt) => tt.id === tabId);
    await cancelStreamForTab(tabId);

    const timeoutSecs = settings.queryTimeoutSecs;
    const streamId = newStreamId(tabId);
    streamIdRef.current.set(tabId, streamId);
    const startedAt = Date.now();
    setStatus({ kind: "key", key: "statusRunningQuery" });
    updateTab(tabId, {
      lastExecutedSql: sql,
      result: emptyResult([]),
      preview: null,
      streaming: true,
      paginatable: paginatableBase,
      autoLimitApplied: null,
      autoLimitSql: autoLimit !== null ? sql : null,
      loadingMore: false,
      canLoadMore: false,
      // Drop any in-flight cell edits: their row indices reference the
      // previous result set and would no longer line up with the new rows.
      pendingEdits: {},
    });

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
      onDone: ({ totalRows, rowsAffected, elapsedMs, hasColumns, appliedAutoLimit }) => {
        patchTab(tabId, (tt) => {
          if (!hasColumns) {
            return {
              ...tt,
              result: { columns: [], rows: [], rows_affected: rowsAffected, elapsed_ms: elapsedMs },
              streaming: false,
              canLoadMore: false,
              autoLimitApplied: null,
            };
          }
          // Optimistically enable scroll-triggered pagination for table-shaped
          // tabs. The first `loadMore` request will turn this off when it sees
          // a short page, so we don't need to compare totalRows against the
          // exact LIMIT here.
          return {
            ...tt,
            result: tt.result
              ? { ...tt.result, elapsed_ms: elapsedMs, rows_affected: totalRows }
              : tt.result,
            streaming: false,
            canLoadMore: tt.paginatable !== null,
            autoLimitApplied: appliedAutoLimit,
          };
        });
        if (hasColumns) {
          setStatus({ kind: "key", key: "statusStreamingDone", vars: { rows: totalRows, ms: elapsedMs } });
        } else {
          setStatus({ kind: "key", key: "statusRowsAffected", vars: { rows: rowsAffected, ms: elapsedMs } });
        }
        // A new entry was just written to history; refresh the panel.
        setHistoryReloadKey((k) => k + 1);
        // DDL may have added/renamed tables or columns — refresh autocomplete.
        if (isSchemaMutatingSql(sql)) invalidateSchemaCache();
        finalize();
      },
      onError: ({ error, timedOut, connectionLost }) => {
        patchTab(tabId, (tt) => ({ ...tt, streaming: false }));
        setHistoryReloadKey((k) => k + 1);
        finalize();
        // A dropped connection leaves the session unusable: tear it down and
        // prompt a reconnect rather than showing the raw transport error.
        if (connectionLost) {
          void handleConnectionLostRef.current();
          return;
        }
        if (timedOut) {
          setStatus({
            kind: "key",
            key: "statusQueryTimeout",
            vars: { secs: timeoutSecs },
            error: true,
          });
        } else {
          setStatus({ kind: "key", key: "statusQueryError", vars: { error }, error: true });
        }
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
        autoLimit,
        queryTimeoutSecs: timeoutSecs,
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
    invalidateSchemaCache,
    settings.defaultDisplayCount,
    settings.streamPrefetchSize,
    settings.queryTimeoutSecs,
  ]);

  // Build fresh Tab objects from a snapshot and replace the live tab list.
  // Table tabs are verified via describeTable; entries pointing at tables
  // that no longer exist are demoted to query tabs holding the saved SQL.
  const restoreSavedTabs = useCallback(
    async (sid: string, profile: ConnectionProfile, saved: PersistedTab[]) => {
      const limit = Math.max(1, settings.defaultDisplayCount);
      const built = await Promise.all(
        saved.map(async (s): Promise<Tab> => {
          if (s.kind === "table" && s.database && s.table) {
            try {
              await api.describeTable(sid, s.database, s.table);
              const base = qualifiedTableSql(profile.driver, s.database, s.table);
              const sql = `${base} LIMIT ${limit}`;
              return {
                id: newTabId(),
                kind: "table",
                title: s.title || s.table,
                database: s.database,
                table: s.table,
                sql,
                lastExecutedSql: sql,
                result: null,
                preview: null,
                schemaTable: null,
                streaming: false,
                previewRowLimit: limit,
                paginatable: base,
                autoLimitApplied: null,
                autoLimitSql: null,
                loadingMore: false,
                canLoadMore: false,
                tableColumns: null,
                pendingEdits: {},
                builderSnapshot: null,
              };
            } catch {
              // Table is gone — fall through to a query tab using the saved SQL.
            }
          }
          if (s.kind === "explain") {
            const tab = makeExplainTab(s.sql);
            return { ...tab, title: s.title || tab.title, previewRowLimit: limit };
          }
          return {
            id: newTabId(),
            kind: "query",
            title: s.kind === "query" ? s.title : translate("tabUntitledQuery"),
            sql: s.sql,
            lastExecutedSql: s.sql,
            result: null,
            preview: null,
            schemaTable: null,
            streaming: false,
            previewRowLimit: limit,
            paginatable: null,
            autoLimitApplied: null,
            autoLimitSql: null,
            loadingMore: false,
            canLoadMore: false,
            tableColumns: null,
            pendingEdits: {},
            builderSnapshot: null,
          };
        }),
      );

      if (built.length === 0) {
        const tab = makeQueryTab();
        setTabs([tab]);
        setActiveTabId(tab.id);
        return;
      }
      setTabs(built);
      setActiveTabId(built[0].id);
      // Re-run the initial table query for restored table tabs so the user
      // immediately sees data instead of an empty grid.
      for (const tab of built) {
        if (tab.kind === "table" && tab.paginatable) {
          runQueryInTab(tab.id, tab.sql, tab.paginatable);
        }
      }
    },
    [runQueryInTab, settings.defaultDisplayCount],
  );

  useEffect(() => {
    restoreSavedTabsRef.current = restoreSavedTabs;
  }, [restoreSavedTabs]);

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
    // Preview is non-destructive — keep the previous `result` and any
    // pending cell edits intact so the user can come back and Apply
    // them after sanity-checking the diff. (Earlier versions cleared
    // `result` here, which made the post-preview Apply path unable to
    // locate the row to update.)
    updateTab(tabId, {
      preview: emptyPreview(),
      streaming: true,
      previewRowLimit: rowLimit,
      paginatable: null,
      loadingMore: false,
      canLoadMore: false,
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
      onError: ({ error, connectionLost }) => {
        patchTab(tabId, (tt) => ({ ...tt, streaming: false }));
        finalize();
        if (connectionLost) {
          void handleConnectionLostRef.current();
          return;
        }
        setStatus({ kind: "key", key: "statusPreviewError", vars: { error }, error: true });
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

  const loadMoreInTab = useCallback(async (tabId: string) => {
    if (!sessionId) return;
    const tab = tabsRef.current.find((tt) => tt.id === tabId);
    if (
      !tab ||
      !tab.paginatable ||
      !tab.canLoadMore ||
      tab.loadingMore ||
      tab.streaming ||
      !tab.result
    ) {
      return;
    }
    const offset = tab.result.rows.length;
    const chunkSize = Math.max(1, settings.streamPrefetchSize);
    const sql = `${tab.paginatable} LIMIT ${chunkSize} OFFSET ${offset}`;
    patchTab(tabId, (tt) => ({ ...tt, loadingMore: true }));
    setStatus({
      kind: "key",
      key: "statusLoadingMore",
      vars: { rows: offset },
    });
    try {
      const more = await api.runQuery(sessionId, sql, tab.database ?? null);
      patchTab(tabId, (tt) => {
        if (!tt.result) return { ...tt, loadingMore: false };
        const nextRows = [...tt.result.rows, ...more.rows];
        return {
          ...tt,
          result: {
            ...tt.result,
            rows: nextRows,
            rows_affected: nextRows.length,
          },
          loadingMore: false,
          canLoadMore: more.rows.length >= chunkSize,
        };
      });
      setStatus({
        kind: "key",
        key: "statusStreamingDone",
        vars: { rows: offset + more.rows.length, ms: tab.result.elapsed_ms },
      });
    } catch (e) {
      patchTab(tabId, (tt) => ({ ...tt, loadingMore: false }));
      setStatus({
        kind: "key",
        key: "statusQueryError",
        vars: { error: String(e) },
        error: true,
      });
    }
  }, [sessionId, settings.streamPrefetchSize, patchTab]);

  const handleRunQuery = useCallback((sql: string) => {
    if (!activeTab) return;
    // On an explain tab the primary action re-runs EXPLAIN so the viewer keeps
    // getting plan JSON instead of a raw result set. EXPLAIN is read-only, so
    // it never trips the destructive-query gate or auto LIMIT.
    if (activeTab.kind === "explain") {
      runQueryInTab(activeTab.id, `${EXPLAIN_PREFIX}${sql}`);
      return;
    }
    // Auto LIMIT only guards free-form editor queries; table tabs carry their
    // own LIMIT. Writes pass through here too but the backend parser leaves
    // them untouched.
    const autoLimit =
      activeTab.kind === "query" && settings.autoLimitEnabled
        ? settings.autoLimitCount
        : null;
    const isProduction = selectedProfile?.is_production ?? false;
    if (isProduction || settings.confirmDangerousQueries) {
      const findings = analyzeDangerousSql(sql);
      if (findings.length > 0) {
        setPendingDangerous({ tabId: activeTab.id, sql, findings, isProduction, autoLimit });
        return;
      }
    }
    runQueryInTab(activeTab.id, sql, null, autoLimit);
  }, [
    activeTab,
    runQueryInTab,
    selectedProfile?.is_production,
    settings.confirmDangerousQueries,
    settings.autoLimitEnabled,
    settings.autoLimitCount,
  ]);

  const handleConfirmDangerous = useCallback(() => {
    if (!pendingDangerous) return;
    const { tabId, sql, autoLimit } = pendingDangerous;
    setPendingDangerous(null);
    runQueryInTab(tabId, sql, null, autoLimit);
  }, [pendingDangerous, runQueryInTab]);

  const handleCancelDangerous = useCallback(() => setPendingDangerous(null), []);

  // Badge action: re-run the auto-limited query without the cap so the user
  // sees the full result set.
  const handleFetchAllRows = useCallback(() => {
    if (!activeTab || activeTab.autoLimitSql === null) return;
    runQueryInTab(activeTab.id, activeTab.autoLimitSql, null, null);
  }, [activeTab, runQueryInTab]);

  const handleExplainQuery = useCallback((sql: string) => {
    // Re-explain in place when already on an explain tab; otherwise open a
    // dedicated explain tab so the source query/result is left untouched.
    if (activeTab?.kind === "explain") {
      runQueryInTab(activeTab.id, `${EXPLAIN_PREFIX}${sql}`);
      return;
    }
    const tab = makeExplainTab(sql);
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(tab.id);
    runQueryInTab(tab.id, `${EXPLAIN_PREFIX}${sql}`);
  }, [activeTab, runQueryInTab]);

  const handleLoadMore = useCallback(() => {
    if (!activeTab) return;
    loadMoreInTab(activeTab.id);
  }, [activeTab, loadMoreInTab]);

  // User-driven stop: cancel the active tab's in-flight stream, drop the
  // streaming flag, and keep whatever rows have already arrived. The backend
  // `cancelStream` tears down the cursor while leaving the connection open.
  const handleStopStreaming = useCallback(async () => {
    if (!activeTab || !activeTab.streaming) return;
    await cancelStreamForTab(activeTab.id);
    patchTab(activeTab.id, (tt) => ({ ...tt, streaming: false }));
    setStatus({ kind: "key", key: "statusQueryCancelled" });
  }, [activeTab, cancelStreamForTab, patchTab]);

  const handlePreviewQuery = useCallback((sql: string) => {
    if (!activeTab) return;
    previewQueryInTab(activeTab.id, sql);
  }, [activeTab, previewQueryInTab]);

  const handleEditorChange = useCallback((sql: string) => {
    if (!activeTab) return;
    updateTab(activeTab.id, { sql });
  }, [activeTab, updateTab]);

  // Insert a snippet into the active editor, or open a fresh query tab
  // holding the snippet when there is no active tab yet.
  const handleInsertSnippet = useCallback((snippet: Snippet) => {
    if (activeTab) {
      editorRef.current?.insertText(snippet.sql);
    } else if (sessionId) {
      const tab = { ...makeQueryTab(), sql: snippet.sql, lastExecutedSql: snippet.sql };
      setTabs((prev) => [...prev, tab]);
      setActiveTabId(tab.id);
    }
  }, [activeTab, sessionId]);

  // Restore a history entry's SQL. Into the active query/explain editor when
  // there is one, otherwise into a fresh query tab so we don't clobber a
  // table tab's auto-generated SELECT.
  const handleRestoreHistory = useCallback((sql: string) => {
    if (activeTab && (activeTab.kind === "query" || activeTab.kind === "explain")) {
      editorRef.current?.setText(sql);
    } else if (sessionId) {
      const tab = { ...makeQueryTab(), sql, lastExecutedSql: sql };
      setTabs((prev) => [...prev, tab]);
      setActiveTabId(tab.id);
    }
  }, [activeTab, sessionId]);

  // Always open history SQL in a fresh query tab, never overwriting the editor.
  const handleOpenHistoryInNewTab = useCallback((sql: string) => {
    const tab = { ...makeQueryTab(), sql, lastExecutedSql: sql };
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(tab.id);
  }, []);

  const handleSaveSnippetFromEditor = useCallback((sql: string) => {
    setEditingSnippet(null);
    setSnippetFormSql(sql);
    setShowForm(false);
    setShowSettings(false);
    setShowHelp(false);
    setShowSnippetForm(true);
    setFormInstanceId((n) => n + 1);
  }, []);

  const handleEditSnippet = useCallback((snippet: Snippet) => {
    setEditingSnippet(snippet);
    setSnippetFormSql("");
    setShowForm(false);
    setShowSettings(false);
    setShowHelp(false);
    setShowSnippetForm(true);
    setFormInstanceId((n) => n + 1);
  }, []);

  const handleDeleteSnippet = useCallback(async (id: string) => {
    await api.deleteSnippet(id);
    await refreshSnippets();
  }, [refreshSnippets]);

  const handleSetCellEdit = useCallback(
    (rowIdx: number, colIdx: number, value: string | null) => {
      if (!activeTab) return;
      patchTab(activeTab.id, (tt) => {
        const next = { ...tt.pendingEdits };
        const row = { ...(next[rowIdx] ?? {}) };
        if (value === null) {
          delete row[colIdx];
        } else {
          row[colIdx] = value;
        }
        if (Object.keys(row).length === 0) {
          delete next[rowIdx];
        } else {
          next[rowIdx] = row;
        }
        return { ...tt, pendingEdits: next };
      });
    },
    [activeTab, patchTab],
  );

  const handleClearEdits = useCallback(() => {
    if (!activeTab) return;
    patchTab(activeTab.id, (tt) => ({ ...tt, pendingEdits: {} }));
  }, [activeTab, patchTab]);

  // Discard from inside the preview pane: clear the edits AND dismiss the
  // preview view (otherwise the user is stuck on a preview of edits that
  // no longer exist). Also cancels any in-flight preview stream so a
  // late-arriving onMeta event doesn't re-populate `preview` after we've
  // cleared it.
  const handleDiscardEditsAndPreview = useCallback(() => {
    if (!activeTab) return;
    const tabId = activeTab.id;
    void cancelStreamForTab(tabId);
    patchTab(tabId, (tt) => ({ ...tt, pendingEdits: {}, preview: null }));
  }, [activeTab, patchTab, cancelStreamForTab]);

  const handlePreviewEdits = useCallback(() => {
    if (!activeTab || !sessionId) return;
    const { result, tableColumns, database, table, pendingEdits } = activeTab;
    if (!result || !tableColumns || !database || !table) return;
    const pkIndices = resolvePkIndices(result.columns, tableColumns);
    const stmts = buildUpdateStatements({
      driver: selectedProfile?.driver ?? "mysql",
      database,
      table,
      columns: result.columns,
      rows: result.rows,
      pkIndices,
      edits: pendingEdits,
    });
    if (stmts.length === 0) return;
    // Preview only handles one statement at a time; we surface the first
    // edited row so the user can sanity-check shape. Multi-row callers gate
    // the button so this branch is single-row in practice.
    previewQueryInTab(activeTab.id, stmts[0]);
  }, [activeTab, sessionId, previewQueryInTab, selectedProfile?.driver]);

  const handleApplyEdits = useCallback(async () => {
    if (!activeTab || !sessionId) return;
    const { result, tableColumns, database, table, pendingEdits, paginatable } =
      activeTab;
    if (!result || !tableColumns || !database || !table) return;
    const pkIndices = resolvePkIndices(result.columns, tableColumns);
    const stmts = buildUpdateStatements({
      driver: selectedProfile?.driver ?? "mysql",
      database,
      table,
      columns: result.columns,
      rows: result.rows,
      pkIndices,
      edits: pendingEdits,
    });
    if (stmts.length === 0) return;
    const tabId = activeTab.id;
    setStatus({ kind: "key", key: "statusApplyingEdits", vars: { count: stmts.length } });
    // All statements run in a single backend transaction: either every
    // UPDATE commits or, on any failure, the whole batch rolls back so the
    // table is never left in a half-applied state.
    let totalAffected = 0;
    let failure: string | null = null;
    try {
      const res = await api.runQueryTransaction(sessionId, stmts, database);
      totalAffected = Number(res.rows_affected ?? 0);
    } catch (e) {
      failure = String(e);
    }
    // Always refresh & drop edits afterwards: the result indices no
    // longer line up with whatever the user had buffered.
    if (paginatable) {
      const limit = Math.max(1, settings.defaultDisplayCount);
      const refresh = `${paginatable} LIMIT ${limit}`;
      runQueryInTab(tabId, refresh, paginatable);
    } else {
      patchTab(tabId, (tt) => ({ ...tt, pendingEdits: {}, preview: null }));
    }
    if (failure) {
      setStatus({
        kind: "key",
        key: "statusApplyEditsPartial",
        vars: { total: stmts.length, error: failure },
        error: true,
      });
    } else {
      setStatus({
        kind: "key",
        key: "statusAppliedEdits",
        vars: { rows: totalAffected, count: stmts.length },
      });
    }
  }, [
    activeTab,
    sessionId,
    patchTab,
    runQueryInTab,
    settings.defaultDisplayCount,
    selectedProfile?.driver,
  ]);

  const handleOpenTable = useCallback((database: string, table: string) => {
    const existing = tabs.find(
      (tt) => tt.kind === "table" && tt.database === database && tt.table === table,
    );
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }
    const limit = Math.max(1, settings.defaultDisplayCount);
    const base = qualifiedTableSql(selectedProfile?.driver ?? "mysql", database, table);
    const sql = `${base} LIMIT ${limit}`;
    const tab: Tab = {
      id: newTabId(),
      kind: "table",
      title: table,
      database,
      table,
      sql,
      lastExecutedSql: sql,
      result: null,
      preview: null,
      schemaTable: null,
      streaming: false,
      previewRowLimit: limit,
      paginatable: base,
      autoLimitApplied: null,
      autoLimitSql: null,
      loadingMore: false,
      canLoadMore: false,
      tableColumns: null,
      pendingEdits: {},
      builderSnapshot: null,
    };
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(tab.id);
    runQueryInTab(tab.id, sql, base);
  }, [tabs, runQueryInTab, settings.defaultDisplayCount, selectedProfile?.driver]);

  const handleImportTable = useCallback((database: string, table: string) => {
    setImportTarget({ database, table });
  }, []);

  const handleDumpDatabase = useCallback((database: string) => {
    setDumpTarget(database);
  }, []);

  // Open a fresh query tab holding `sql` and run it immediately. Shared by the
  // schema-tree table context-menu actions (run SELECT, show definition).
  const openAndRunQuery = useCallback((sql: string, title?: string) => {
    if (!sessionId) return;
    const tab: Tab = { ...makeQueryTab(), sql, lastExecutedSql: sql };
    if (title) tab.title = title;
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(tab.id);
    runQueryInTab(tab.id, sql);
  }, [sessionId, runQueryInTab]);

  const handleRunTableSelect = useCallback((database: string, table: string) => {
    const limit = Math.max(1, settings.defaultDisplayCount);
    const base = qualifiedTableSql(selectedProfile?.driver ?? "mysql", database, table);
    openAndRunQuery(`${base} LIMIT ${limit}`, table);
  }, [openAndRunQuery, settings.defaultDisplayCount, selectedProfile?.driver]);

  // Insert SELECT * into the active editor, or open a fresh query tab when the
  // active tab has no editor (e.g. a table tab) — mirrors handleRestoreHistory.
  const handleInsertTableSelect = useCallback((database: string, table: string) => {
    const sql = qualifiedTableSql(selectedProfile?.driver ?? "mysql", database, table);
    if (activeTab && (activeTab.kind === "query" || activeTab.kind === "explain")) {
      editorRef.current?.insertText(sql);
    } else if (sessionId) {
      const tab = { ...makeQueryTab(), sql, lastExecutedSql: sql };
      setTabs((prev) => [...prev, tab]);
      setActiveTabId(tab.id);
    }
  }, [activeTab, sessionId, selectedProfile?.driver]);

  const handleShowCreateTable = useCallback((database: string, table: string) => {
    const sql = tableDefinitionSql(selectedProfile?.driver ?? "mysql", database, table);
    if (sql) openAndRunQuery(sql, table);
  }, [openAndRunQuery, selectedProfile?.driver]);

  // After a CSV import, refresh the matching open table tab so the new rows
  // show up without the user reopening the table.
  const handleImported = useCallback((database: string, table: string) => {
    const tab = tabsRef.current.find(
      (tt) => tt.kind === "table" && tt.database === database && tt.table === table,
    );
    if (tab && tab.paginatable) {
      const limit = Math.max(1, tab.previewRowLimit || settings.defaultDisplayCount);
      runQueryInTab(tab.id, `${tab.paginatable} LIMIT ${limit}`, tab.paginatable);
    }
  }, [runQueryInTab, settings.defaultDisplayCount]);

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

  // Latest handlers held in a ref so the global keydown listener below can
  // call them without re-attaching on every tab change.
  const handleCloseTabRef = useRef(handleCloseTab);
  handleCloseTabRef.current = handleCloseTab;

  // App-wide keyboard shortcuts for the tabbed workspace: tab management
  // (#121) and focusing the result search (#120). Editor-scoped shortcuts
  // (run/preview/format) live in QueryEditor's CodeMirror keymap so they only
  // fire while the editor has focus. These are gated to the tabbed view so
  // they never fire over the Help/Settings/Form panels.
  useEffect(() => {
    if (!sessionId || showForm || showSettings || showHelp || showSnippetForm) return;
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      // Cmd/Ctrl+F → focus the cross-column result search (no Shift so the
      // editor's Cmd/Ctrl+Shift+F format shortcut is left alone).
      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "f") {
        const grid = resultGridRef.current;
        if (grid) {
          e.preventDefault();
          grid.focusSearch();
        }
        return;
      }
      // Ctrl+Tab / Ctrl+Shift+Tab → next / previous tab (wraps around). Uses
      // Ctrl on every platform; Cmd+Tab is the macOS app switcher.
      if (e.ctrlKey && !e.metaKey && !e.altKey && e.key === "Tab") {
        const list = tabsRef.current;
        if (list.length === 0) return;
        e.preventDefault();
        const cur = list.findIndex((tt) => tt.id === activeTabIdRef.current);
        const delta = e.shiftKey ? -1 : 1;
        const nextIdx = (cur + delta + list.length) % list.length;
        setActiveTabId(list[nextIdx].id);
        return;
      }
      if (!mod || e.altKey || e.shiftKey) return;
      const key = e.key.toLowerCase();
      if (key === "t") {
        e.preventDefault();
        handleNewTab();
        return;
      }
      if (key === "w") {
        // Always suppress the webview's default "close window" on Ctrl/Cmd+W
        // while in the tabbed workspace.
        e.preventDefault();
        const active = activeTabIdRef.current;
        if (active) handleCloseTabRef.current(active);
        return;
      }
      if (e.key >= "1" && e.key <= "9") {
        const list = tabsRef.current;
        const idx = Number(e.key) - 1;
        if (idx < list.length) {
          e.preventDefault();
          setActiveTabId(list[idx].id);
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [sessionId, showForm, showSettings, showHelp, showSnippetForm, handleNewTab]);

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

  const statusHintKey = useMemo(() => {
    if (!status.error) return null;
    const raw = status.kind === "literal" ? status.text : status.vars?.error;
    return raw != null ? matchErrorHint(String(raw)) : null;
  }, [status]);

  // Any new status (new query, connect/disconnect, connection switch) re-enables
  // the hint banner so it is never permanently suppressed by a prior dismissal.
  useEffect(() => {
    setHintDismissed(false);
  }, [status]);

  const pendingEditsSummary = useMemo(() => {
    const edits = activeTab?.pendingEdits ?? {};
    return { cells: countEditedCells(edits), rows: countEditedRows(edits) };
  }, [activeTab?.pendingEdits]);

  return (
    <div className="app-shell">
      <TitleBar />
      <div
        className={`app${sidebarCollapsed ? " sidebar-collapsed" : ""}${narrow && narrowSidebarOpen ? " sidebar-overlay" : ""}`}
        style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}
      >
      <aside className="sidebar">
        <header>
          <button
            className="icon sidebar-collapse-btn"
            onClick={toggleSidebar}
            title={t("sidebarCollapse")}
            aria-label={t("sidebarCollapse")}
          >
            <Icon name="chevron-left" />
          </button>
          <span className="sidebar-title">
            {sidebarTab === "snippets"
              ? t("appSnippets")
              : sidebarTab === "history"
                ? t("appHistory")
                : t("appConnections")}
          </span>
          <div className="header-actions">
            <button
              className="icon"
              onClick={toggleTheme}
              title={theme === "dark" ? t("appThemeToLight") : t("appThemeToDark")}
              aria-label={t("appThemeToggle")}
            >
              <Icon name={theme === "dark" ? "sun" : "moon"} />
            </button>
            <button
              className="icon"
              onClick={() => { setShowForm(false); setShowSnippetForm(false); setShowSettings(false); setShowHelp(true); }}
              title={t("appHelp")}
              aria-label={t("appHelp")}
            >
              <Icon name="help" />
            </button>
            <button
              className="icon"
              onClick={() => { setShowForm(false); setShowSnippetForm(false); setShowHelp(false); setShowSettings(true); }}
              title={t("appSettings")}
              aria-label={t("appSettings")}
            >
              <Icon name="settings" />
            </button>
            {sidebarTab === "snippets" ? (
              <button
                className="icon"
                onClick={() => {
                  setEditingSnippet(null);
                  setSnippetFormSql("");
                  setShowSettings(false);
                  setShowHelp(false);
                  setShowForm(false);
                  setShowSnippetForm(true);
                  setFormInstanceId((n) => n + 1);
                }}
                title={t("appNewSnippet")}
                aria-label={t("appNewSnippet")}
              >
                <Icon name="plus" />
              </button>
            ) : sidebarTab === "connections" ? (
              <button
                className="icon"
                onClick={() => { setEditing(null); setShowSettings(false); setShowHelp(false); setShowSnippetForm(false); setShowForm(true); setFormInstanceId((n) => n + 1); }}
                title={t("appNew")}
                aria-label={t("appNew")}
              >
                <Icon name="plus" />
              </button>
            ) : null}
          </div>
        </header>
        <div className="sidebar-tabs" role="tablist">
          <button
            role="tab"
            aria-selected={sidebarTab === "connections"}
            className={`sidebar-tab ${sidebarTab === "connections" ? "active" : ""}`}
            onClick={() => setSidebarTab("connections")}
          >
            {t("sidebarTabConnections")}
          </button>
          <button
            role="tab"
            aria-selected={sidebarTab === "snippets"}
            className={`sidebar-tab ${sidebarTab === "snippets" ? "active" : ""}`}
            onClick={() => setSidebarTab("snippets")}
          >
            {t("sidebarTabSnippets")}
          </button>
          <button
            role="tab"
            aria-selected={sidebarTab === "history"}
            className={`sidebar-tab ${sidebarTab === "history" ? "active" : ""}`}
            onClick={() => setSidebarTab("history")}
          >
            {t("sidebarTabHistory")}
          </button>
        </div>
        {sidebarTab === "connections" ? (
          <ConnectionList
            profiles={profiles}
            activeProfileId={selectedProfile?.id ?? null}
            sessionId={sessionId}
            connectingId={connectingId}
            errorProfileId={errorProfileId}
            onConnect={handleConnect}
            onCreate={() => { setEditing(null); setShowSettings(false); setShowHelp(false); setShowSnippetForm(false); setShowForm(true); setFormInstanceId((n) => n + 1); }}
            onEdit={(p) => { setEditing(p); setShowSnippetForm(false); setShowSettings(false); setShowHelp(false); setShowForm(true); setFormInstanceId((n) => n + 1); }}
            onDuplicate={(p) => {
              // Open the form pre-filled with the source profile's non-secret
              // settings as a brand-new entry: blank id forces save_profile to
              // mint a fresh id, and secrets (password/passphrase) are never
              // carried over from the keyring.
              setEditing({ ...p, id: "", name: `${p.name}${t("listDuplicateSuffix")}` });
              setShowSnippetForm(false);
              setShowSettings(false);
              setShowHelp(false);
              setShowForm(true);
              setFormInstanceId((n) => n + 1);
            }}
            onDelete={async (id) => {
              await api.deleteProfile(id);
              await refreshProfiles();
            }}
            onPickTable={handleOpenTable}
            onImportTable={handleImportTable}
            onDumpDatabase={handleDumpDatabase}
            onRunTableSelect={handleRunTableSelect}
            onInsertTableSelect={handleInsertTableSelect}
            onShowCreateTable={
              selectedProfile && (selectedProfile.driver === "mysql" || selectedProfile.driver === "sqlite")
                ? handleShowCreateTable
                : undefined
            }
            selectLimit={Math.max(1, settings.defaultDisplayCount)}
          />
        ) : sidebarTab === "snippets" ? (
          <SnippetList
            snippets={snippets}
            activeProfile={selectedProfile}
            onInsert={handleInsertSnippet}
            onEdit={handleEditSnippet}
            onDelete={handleDeleteSnippet}
          />
        ) : (
          <HistoryList
            activeProfile={selectedProfile}
            reloadKey={historyReloadKey}
            onRestore={handleRestoreHistory}
            onOpenInNewTab={handleOpenHistoryInNewTab}
          />
        )}
      </aside>

      {!sidebarCollapsed && (
        <div
          className={`sidebar-resizer${sidebarResizing ? " is-dragging" : ""}`}
          role="separator"
          aria-orientation="vertical"
          aria-label={t("sidebarCollapse")}
          onPointerDown={onSidebarResizePointerDown}
          onPointerMove={onSidebarResizePointerMove}
          onPointerUp={onSidebarResizePointerUp}
          onPointerCancel={onSidebarResizePointerUp}
          onDoubleClick={() => setSidebarWidth(SIDEBAR_DEFAULT_WIDTH)}
        />
      )}

      {sidebarCollapsed && (
        <button
          className="sidebar-expand-btn"
          onClick={toggleSidebar}
          title={t("sidebarExpand")}
          aria-label={t("sidebarExpand")}
        >
          <Icon name="chevron-right" />
        </button>
      )}

      {narrow && narrowSidebarOpen && (
        <div className="sidebar-backdrop" onClick={() => setNarrowSidebarOpen(false)} aria-hidden />
      )}

      <main
        className="main"
        style={
          selectedProfile?.color
            ? ({ "--ws-accent": selectedProfile.color } as CSSProperties)
            : undefined
        }
      >
        {showHelp ? (
          <HelpView onClose={() => setShowHelp(false)} />
        ) : showSettings ? (
          <SettingsView theme={theme} onClose={() => setShowSettings(false)} />
        ) : showForm ? (
          <ConnectionForm
            key={formInstanceId}
            initial={editing}
            profiles={profiles}
            onSaved={async () => {
              setShowForm(false);
              setEditing(null);
              await refreshProfiles();
            }}
            onCancel={() => { setShowForm(false); setEditing(null); }}
          />
        ) : showSnippetForm ? (
          <SnippetForm
            key={formInstanceId}
            initial={editingSnippet}
            snippets={snippets}
            profiles={profiles}
            activeProfile={selectedProfile}
            initialSql={snippetFormSql}
            onSaved={async () => {
              setShowSnippetForm(false);
              setEditingSnippet(null);
              setSnippetFormSql("");
              setSidebarTab("snippets");
              await refreshSnippets();
            }}
            onCancel={() => { setShowSnippetForm(false); setEditingSnippet(null); setSnippetFormSql(""); }}
          />
        ) : (
          <>
            <div className={`topbar ${selectedProfile?.is_production ? "is-production" : ""}`}>
              <div className="topbar-info">
                {selectedProfile ? (
                  <>
                    <span className="status-dot status-connected" aria-hidden />
                    <span className="topbar-name">{selectedProfile.name}</span>
                    {selectedProfile.read_only && (
                      <span
                        className="tree-badge read-only-badge"
                        title={t("listReadOnlyTitle")}
                      >
                        {t("listReadOnly")}
                      </span>
                    )}
                    <span className="topbar-meta">
                      {selectedProfile.driver === "sqlite"
                        ? selectedProfile.file_path ?? ""
                        : `${selectedProfile.user}@${selectedProfile.host}:${selectedProfile.port}${selectedProfile.database ? `/${selectedProfile.database}` : ""}`}
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
              {sessionId && <button className="danger" onClick={handleDisconnect}>{t("appDisconnect")}</button>}
            </div>

            {sessionId && (
              <TabBar
                tabs={tabs.map((tt) => ({
                  id: tt.id,
                  kind: tt.kind,
                  title: tt.title,
                  database: tt.database,
                  table: tt.table,
                  dirty: tt.kind === "query" && tt.sql !== tt.lastExecutedSql,
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
                  storageKey="noobdb.split.editor"
                  defaultFraction={0.4}
                  minSize={120}
                  ariaLabel={t("splitterEditorAria")}
                  first={
                    <QueryEditor
                      key={activeTab.id}
                      ref={editorRef}
                      initialSql={activeTab.sql}
                      onRun={handleRunQuery}
                      onPreview={activeTab.kind === "explain" ? undefined : handlePreviewQuery}
                      onExplain={activeTab.kind === "explain" ? undefined : handleExplainQuery}
                      explainMode={activeTab.kind === "explain"}
                      onChange={handleEditorChange}
                      onSaveSnippet={handleSaveSnippetFromEditor}
                      onFormatError={(error) =>
                        setStatus({
                          kind: "key",
                          key: "statusFormatError",
                          vars: { error },
                          error: true,
                        })
                      }
                      disabled={!sessionId}
                      schemaTable={activeTab.schemaTable}
                      databaseSchema={editorSchema}
                      activeTable={
                        activeTab.kind === "table" && activeTab.database && activeTab.table
                          ? { database: activeTab.database, name: activeTab.table }
                          : null
                      }
                      sessionId={sessionId}
                      defaultDatabase={activeTab.database ?? selectedProfile?.database ?? null}
                      driver={selectedProfile?.driver ?? "mysql"}
                      builderSnapshot={activeTab.builderSnapshot}
                      onBuilderPersist={(snapshot) => updateTab(activeTab.id, { builderSnapshot: snapshot })}
                    />
                  }
                  second={
                    activeTab.kind === "explain" ? (
                      <ExplainViewer
                        result={activeTab.result}
                        streaming={activeTab.streaming}
                      />
                    ) : activeTab.preview ? (
                      <PreviewGrid
                        result={activeTab.preview}
                        rowLimit={activeTab.previewRowLimit}
                        streaming={activeTab.streaming}
                        onStop={handleStopStreaming}
                        pendingEditsSummary={
                          activeTab.kind === "table" && pendingEditsSummary.cells > 0
                            ? pendingEditsSummary
                            : undefined
                        }
                        onApplyEdits={
                          activeTab.kind === "table" && pendingEditsSummary.cells > 0
                            ? handleApplyEdits
                            : undefined
                        }
                        onDiscardEdits={
                          activeTab.kind === "table" && pendingEditsSummary.cells > 0
                            ? handleDiscardEditsAndPreview
                            : undefined
                        }
                      />
                    ) : (
                      <ResultGrid
                        ref={resultGridRef}
                        result={activeTab.result}
                        streaming={activeTab.streaming}
                        onStopStreaming={handleStopStreaming}
                        loadingMore={activeTab.loadingMore}
                        canLoadMore={activeTab.canLoadMore}
                        onLoadMore={handleLoadMore}
                        autoLimitApplied={activeTab.autoLimitApplied}
                        onFetchAllRows={handleFetchAllRows}
                        database={activeTab.database ?? selectedProfile?.database ?? null}
                        table={activeTab.table ?? null}
                        editable={activeTab.kind === "table"}
                        tableColumns={activeTab.tableColumns}
                        pendingEdits={activeTab.pendingEdits}
                        onSetCellEdit={handleSetCellEdit}
                        onClearEdits={handleClearEdits}
                        onPreviewEdits={handlePreviewEdits}
                        onApplyEdits={handleApplyEdits}
                      />
                    )
                  }
                />


              ) : (
                <div className="pane-empty">
                  {sessionId ? (
                    <EmptyState
                      icon="query"
                      title={t("tabsEmptyTitle")}
                      description={t("tabsEmpty")}
                      action={{ label: t("tabsNewQuery"), onClick: handleNewTab }}
                    />
                  ) : (
                    <EmptyState
                      icon="database"
                      title={t("notConnectedTitle")}
                      description={t("editorHintDisabled")}
                    />
                  )}
                </div>
              )}
            </div>
          </>
        )}

        <div className={`status status-${statusTone(status)}`}>
          <span className="status-icon" aria-hidden>
            {statusTone(status) === "running" ? (
              <Spinner size={13} />
            ) : statusTone(status) === "success" ? (
              <Icon name="check" />
            ) : statusTone(status) === "error" ? (
              <Icon name="warning" />
            ) : null}
          </span>
          <div className="status-content">
            {statusHintKey && !hintDismissed ? (
              <div className="status-hint">
                <div className="status-hint-body">
                  <span className="status-hint-label">{t("errorHintLabel")}</span>
                  <span className="status-hint-text">{t(statusHintKey)}</span>
                  <button
                    type="button"
                    className="status-hint-dismiss"
                    onClick={() => setHintDismissed(true)}
                    title={t("errorHintDismiss")}
                    aria-label={t("errorHintDismiss")}
                  >
                    <Icon name="close" />
                  </button>
                </div>
                <details className="status-hint-details">
                  <summary>{t("errorHintShowOriginal")}</summary>
                  <span className="status-hint-raw">{statusText}</span>
                </details>
              </div>
            ) : (
              statusText
            )}
          </div>
        </div>
      </main>

      {importTarget && sessionId && (
        <ImportModal
          sessionId={sessionId}
          database={importTarget.database}
          table={importTarget.table}
          onClose={() => setImportTarget(null)}
          onImported={() => handleImported(importTarget.database, importTarget.table)}
        />
      )}

      {dumpTarget && sessionId && (
        <DumpModal
          sessionId={sessionId}
          database={dumpTarget}
          onClose={() => setDumpTarget(null)}
        />
      )}

      {pendingDangerous && (
        <DangerousQueryDialog
          findings={pendingDangerous.findings}
          isProduction={pendingDangerous.isProduction}
          onConfirm={handleConfirmDangerous}
          onCancel={handleCancelDangerous}
        />
      )}
      </div>
    </div>
  );
}
