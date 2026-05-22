import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  api,
  CellValue,
  Column,
  ConnectionProfile,
  DriverKind,
  PreviewResult,
  QueryResult,
  TableColumnInfo,
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
import { QueryEditor, type SchemaTable } from "./components/QueryEditor";
import { ResultGrid } from "./components/ResultGrid";
import { PreviewGrid } from "./components/PreviewGrid";
import { TabBar } from "./components/TabBar";
import { SettingsView } from "./components/SettingsView";
import { Splitter } from "./components/Splitter";
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
  /**
   * Base SQL (no LIMIT/OFFSET) used to fetch additional pages when the user
   * scrolls past the bottom of `result.rows`. Set only when the current
   * result was produced by an auto-generated "open table" query — custom
   * user SQL is not paginatable because we don't know its row identity.
   */
  paginatable: string | null;
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
    paginatable: null,
    loadingMore: false,
    canLoadMore: false,
    tableColumns: null,
    pendingEdits: {},
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
    root.style.setProperty("--preview-highlight", settings.previewHighlight[theme]);
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

  // Keep the active profile pointer in sync when the profile is edited or
  // when the saved list is refreshed for any other reason.
  useEffect(() => {
    if (!selectedProfile) return;
    const fresh = profiles.find((p) => p.id === selectedProfile.id);
    if (fresh && fresh !== selectedProfile) setSelectedProfile(fresh);
  }, [profiles, selectedProfile]);

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
  }, [sessionId, closeAllTabs, settings.confirmProductionConnect]);

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
          tableColumns: cols,
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

  const runQueryInTab = useCallback(async (
    tabId: string,
    sql: string,
    paginatableBase: string | null = null,
  ) => {
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
    updateTab(tabId, {
      result: emptyResult([]),
      preview: null,
      streaming: true,
      paginatable: paginatableBase,
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
      onDone: ({ totalRows, rowsAffected, elapsedMs, hasColumns }) => {
        patchTab(tabId, (tt) => {
          if (!hasColumns) {
            return {
              ...tt,
              result: { columns: [], rows: [], rows_affected: rowsAffected, elapsed_ms: elapsedMs },
              streaming: false,
              canLoadMore: false,
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
    runQueryInTab(activeTab.id, sql);
  }, [activeTab, runQueryInTab]);

  const handleLoadMore = useCallback(() => {
    if (!activeTab) return;
    loadMoreInTab(activeTab.id);
  }, [activeTab, loadMoreInTab]);

  const handlePreviewQuery = useCallback((sql: string) => {
    if (!activeTab) return;
    previewQueryInTab(activeTab.id, sql);
  }, [activeTab, previewQueryInTab]);

  const handleEditorChange = useCallback((sql: string) => {
    if (!activeTab) return;
    updateTab(activeTab.id, { sql });
  }, [activeTab, updateTab]);

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
    // We can't wrap multiple statements in a server-side transaction
    // through the prepared-statement path, so a mid-batch failure leaves
    // earlier statements committed. Track applied/failed counts so the
    // status line can tell the user what stuck.
    let totalAffected = 0;
    let applied = 0;
    let failure: string | null = null;
    for (const sql of stmts) {
      try {
        const res = await api.runQuery(sessionId, sql, database);
        totalAffected += Number(res.rows_affected ?? 0);
        applied += 1;
      } catch (e) {
        failure = String(e);
        break;
      }
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
        vars: { applied, total: stmts.length, error: failure },
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
      result: null,
      preview: null,
      schemaTable: null,
      streaming: false,
      previewRowLimit: limit,
      paginatable: base,
      loadingMore: false,
      canLoadMore: false,
      tableColumns: null,
      pendingEdits: {},
    };
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(tab.id);
    runQueryInTab(tab.id, sql, base);
  }, [tabs, runQueryInTab, settings.defaultDisplayCount, selectedProfile?.driver]);

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

  const pendingEditsSummary = useMemo(() => {
    const edits = activeTab?.pendingEdits ?? {};
    return { cells: countEditedCells(edits), rows: countEditedRows(edits) };
  }, [activeTab?.pendingEdits]);

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
      </aside>

      <main className="main">
        {showSettings ? (
          <SettingsView theme={theme} onClose={() => setShowSettings(false)} />
        ) : showForm ? (
          <ConnectionForm
            initial={editing}
            profiles={profiles}
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
                      <PreviewGrid
                        result={activeTab.preview}
                        rowLimit={activeTab.previewRowLimit}
                        streaming={activeTab.streaming}
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
                        result={activeTab.result}
                        streaming={activeTab.streaming}
                        loadingMore={activeTab.loadingMore}
                        canLoadMore={activeTab.canLoadMore}
                        onLoadMore={handleLoadMore}
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
