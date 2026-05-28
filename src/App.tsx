import { forwardRef, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ComponentProps, type CSSProperties, type ReactNode } from "react";
import { Box, Flex, Grid, chakra } from "@chakra-ui/react";
import { AnimatePresence, motion } from "motion/react";
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
import { EmptyState } from "./components/EmptyState";
import { Spinner } from "./components/Spinner";
import { useToast } from "./components/Toast";
import { SnippetList } from "./components/SnippetList";
import { HistoryList } from "./components/HistoryList";
import type { QueryEditorHandle, SchemaTable } from "./components/QueryEditor";
import type { QueryBuilderSnapshot } from "./components/QueryBuilder";
import type { ResultGridHandle } from "./components/ResultGrid";
import { TabBar } from "./components/TabBar";
import { TitleBar } from "./components/TitleBar";
import { Splitter } from "./components/Splitter";
import { Icon } from "./components/Icon";
import { Button } from "./components/ui";
import { useConfirm } from "./components/ConfirmDialog";
import { ContextMenu, type ContextMenuEntry } from "./components/ContextMenu";

// Heavy or rarely-immediately-needed views are code-split so the initial
// bundle the WebView parses and mounts on launch stays small. CodeMirror
// (QueryEditor), TanStack Table (ResultGrid / PreviewGrid), the formatter and
// the modal/full-screen views only load when first rendered.
const QueryEditor = lazy(() =>
  import("./components/QueryEditor").then((m) => ({ default: m.QueryEditor })),
);
const ResultGrid = lazy(() =>
  import("./components/ResultGrid").then((m) => ({ default: m.ResultGrid })),
);
const PreviewGrid = lazy(() =>
  import("./components/PreviewGrid").then((m) => ({ default: m.PreviewGrid })),
);
const ExplainViewer = lazy(() =>
  import("./components/ExplainViewer").then((m) => ({ default: m.ExplainViewer })),
);
const ConnectionForm = lazy(() =>
  import("./components/ConnectionForm").then((m) => ({ default: m.ConnectionForm })),
);
const SnippetForm = lazy(() =>
  import("./components/SnippetForm").then((m) => ({ default: m.SnippetForm })),
);
const ImportModal = lazy(() =>
  import("./components/ImportModal").then((m) => ({ default: m.ImportModal })),
);
const DumpModal = lazy(() =>
  import("./components/DumpModal").then((m) => ({ default: m.DumpModal })),
);
const HelpView = lazy(() =>
  import("./components/HelpView").then((m) => ({ default: m.HelpView })),
);
const SettingsView = lazy(() =>
  import("./components/SettingsView").then((m) => ({ default: m.SettingsView })),
);
const SchemaCompareView = lazy(() =>
  import("./components/SchemaCompareView").then((m) => ({ default: m.SchemaCompareView })),
);
const DangerousQueryDialog = lazy(() =>
  import("./components/DangerousQueryDialog").then((m) => ({ default: m.DangerousQueryDialog })),
);
import { analyzeDangerousSql, isReadOnlySql, type DangerFinding } from "./dangerousSql";
import { matchErrorHint } from "./errorHints";
import { t as translate, useT } from "./i18n";
import { useSettings, getSettings, BASE_FONT_SIZE_PX, type TabRestoreMode } from "./settings";
import {
  clearPersistedTabs,
  loadPersistedWorkspace,
  savePersistedWorkspace,
  type PersistedTab,
  type PersistedWorkspace,
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
  // No status to surface (e.g. freshly connected, no query run yet). The
  // footer bar is hidden entirely; one-shot confirmations like "connected"
  // live in the toast notifications instead.
  | { kind: "idle" }
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
  if (s.kind === "idle") return "info";
  if (s.error) return "error";
  if (s.kind === "key") {
    if (RUNNING_STATUS_KEYS.has(s.key)) return "running";
    if (s.key === "appDisconnected") return "info";
    return "success";
  }
  return "info";
}

/** 中央寄せの空状態プレースホルダ。ペインに何もない時 / 遅延読み込み中に使う。 */
function PaneEmpty({ children }: { children: ReactNode }) {
  return (
    <Flex
      flex="1"
      align="center"
      justify="center"
      color="app.textMuted"
      fontSize="md"
      p="24px"
      textAlign="center"
    >
      {children}
    </Flex>
  );
}

/** トップバーの密なアイコン専用ボタン。`Button` の既定 padding を詰めて
 *  正方形に近い当たり判定にし、アイコン文字のみを中央配置する。 */
function IconButton(props: ComponentProps<typeof Button>) {
  return <Button px="8px" py="4px" minW="28px" lineHeight="1" fontSize="base" {...props} />;
}

/** ステータスバー脇の小さな状態ドット。色付きの円 + ハロー (box-shadow) で
 *  接続状態を即時に示す。色は CSS 変数経由でテーマ切替へ追従する。 */
function StatusDot({ variant }: { variant: "connected" | "idle" }) {
  const color = variant === "connected" ? "var(--status-connected)" : "var(--status-idle)";
  const ringAlpha = variant === "connected" ? "25%" : "18%";
  return (
    <chakra.span
      aria-hidden
      display="inline-block"
      w="8px"
      h="8px"
      borderRadius="full"
      flexShrink={0}
      bg={color}
      boxShadow={`0 0 0 2px color-mix(in srgb, ${color} ${ringAlpha}, transparent)`}
      transition="background var(--dur-med) var(--ease), box-shadow var(--dur-med) var(--ease)"
    />
  );
}

/**
 * サイドバーの切替タブ key。Connections / Snippets / History の 3 種。
 * 配列順がタブの並び順 = 矢印キーでのフォーカス移動順になる。
 */
type SidebarTab = "connections" | "snippets" | "history";
const SIDEBAR_TAB_ORDER: readonly SidebarTab[] = ["connections", "snippets", "history"];
const sidebarTabId = (key: SidebarTab) => `sidebar-tab-${key}`;
const sidebarPanelId = (key: SidebarTab) => `sidebar-panel-${key}`;

/**
 * サイドバー上部の Connections / Snippets / History 切替タブ (#299)。
 *
 * WAI-ARIA tabs パターンを実装している:
 *   - 各タブに `role="tab"`、`aria-selected`、`aria-controls` (対応 panel の id)、
 *     `id` (panel から `aria-labelledby` で参照される)
 *   - ローピング tabindex: アクティブなタブのみ `tabIndex=0`、他は `-1`。
 *     Tab キーでタブ群に入ると 1 回でアクティブタブにフォーカスする
 *   - 矢印キー / Home / End でフォーカス移動 + 自動アクティベーション (サイドバー
 *     の表示切替は副作用が軽いため、フォーカスの移動と同時に選択も切り替える)
 */
const SidebarTabButton = forwardRef<
  HTMLButtonElement,
  {
    tabKey: SidebarTab;
    active: boolean;
    onActivate: () => void;
    onKeyDown: (e: React.KeyboardEvent<HTMLButtonElement>) => void;
    children: ReactNode;
  }
>(function SidebarTabButton({ tabKey, active, onActivate, onKeyDown, children }, ref) {
  return (
    <chakra.button
      ref={ref}
      role="tab"
      id={sidebarTabId(tabKey)}
      aria-controls={sidebarPanelId(tabKey)}
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      flex="1"
      bg="transparent"
      border="none"
      borderBottom="2px solid"
      borderBottomColor={active ? "app.accent" : "transparent"}
      borderRadius="0"
      px="8px"
      py="7px"
      fontSize="sm"
      fontWeight={600}
      color={active ? "app.text" : "app.textMuted"}
      cursor="pointer"
      transition="background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease), box-shadow var(--dur-fast) var(--ease)"
      _hover={{ bg: "app.hover", color: "app.text" }}
      _focusVisible={{
        outline: "none",
        boxShadow: "0 0 0 2px color-mix(in srgb, var(--accent) 25%, transparent)",
      }}
      onClick={onActivate}
      onKeyDown={onKeyDown}
    >
      {children}
    </chakra.button>
  );
});

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
   * when the builder is reopened in this tab. Persisted alongside the tab
   * (#287) so it survives reconnects and app restarts; cleared only when the
   * tab itself is closed. Holds the latest single snapshot — no history.
   */
  builderSnapshot: QueryBuilderSnapshot | null;
}

/**
 * One column of the split workspace. Tab *data* lives in the flat `tabs` array;
 * a pane only tracks which tab ids it holds (in display order) and which is
 * active. With a single pane the layout behaves exactly like the old single-tab
 * workspace; a second pane is added on demand for side-by-side viewing (#244).
 */
interface PaneState {
  id: string;
  tabIds: string[];
  activeTabId: string | null;
}

let tabSeq = 0;
function newTabId(): string {
  tabSeq += 1;
  return `tab_${Date.now().toString(36)}_${tabSeq.toString(36)}`;
}

let paneSeq = 0;
function newPaneId(): string {
  paneSeq += 1;
  return `pane_${Date.now().toString(36)}_${paneSeq.toString(36)}`;
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
    previewRowLimit: getSettings().defaultDisplayCount,
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
    previewRowLimit: getSettings().defaultDisplayCount,
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
  // #287: Carry the Query Builder snapshot through so the inputs come back on
  // the next reconnect — closing the tab still drops it because the tab is
  // removed from the persisted list before the next save.
  if (tab.builderSnapshot) out.builderSnapshot = tab.builderSnapshot;
  return out;
}

/**
 * Restore-tabs ゲート。`mode === "ask"` のときだけ呼び出し側から渡された
 * `askUser()` (Promise<boolean>) で確認する。同期的な `window.confirm` を
 * 排除するため Promise を返す形に変更している (#280)。
 */
async function shouldRestoreSavedTabs(
  mode: TabRestoreMode,
  askUser: () => Promise<boolean>,
): Promise<boolean> {
  if (mode === "always") return true;
  if (mode === "never") return false;
  return askUser();
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
  const toast = useToast();
  // テーマに追従するカスタム確認ダイアログ。`window.confirm()` の代替で、
  // `await confirm({...})` の形で同期感覚で呼べる (#280)。
  const { confirm, dialog: confirmDialogElement } = useConfirm();
  const [theme, setTheme] = useState<Theme>(readInitialTheme);
  const settings = useSettings();
  const [showSettings, setShowSettings] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showCompare, setShowCompare] = useState(false);

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
    root.style.setProperty("--font-scale", String(settings.fontSizePx / BASE_FONT_SIZE_PX));
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

  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("connections");
  // ローピング tabindex 用に各サイドバータブのボタン要素を保持する。矢印キーで
  // フォーカスを物理的に移動させるために必要 (`setState` だけでは tabIndex は
  // 変わるがフォーカスは移らない)。
  const sidebarTabRefs = useRef<Record<SidebarTab, HTMLButtonElement | null>>({
    connections: null,
    snippets: null,
    history: null,
  });
  const handleSidebarTabKeyDown = useCallback(
    (current: SidebarTab) => (e: React.KeyboardEvent<HTMLButtonElement>) => {
      const idx = SIDEBAR_TAB_ORDER.indexOf(current);
      let next: SidebarTab | null = null;
      if (e.key === "ArrowRight") {
        next = SIDEBAR_TAB_ORDER[(idx + 1) % SIDEBAR_TAB_ORDER.length];
      } else if (e.key === "ArrowLeft") {
        next = SIDEBAR_TAB_ORDER[(idx - 1 + SIDEBAR_TAB_ORDER.length) % SIDEBAR_TAB_ORDER.length];
      } else if (e.key === "Home") {
        next = SIDEBAR_TAB_ORDER[0];
      } else if (e.key === "End") {
        next = SIDEBAR_TAB_ORDER[SIDEBAR_TAB_ORDER.length - 1];
      }
      if (next && next !== current) {
        e.preventDefault();
        setSidebarTab(next);
        // setState 直後はまだ DOM が更新されていないため、次フレームでフォーカス。
        const target = next;
        requestAnimationFrame(() => sidebarTabRefs.current[target]?.focus());
      }
    },
    [],
  );
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
  // One editor/grid handle per pane, registered via stable per-pane callback
  // refs (so the ref isn't detached/reattached on every render). Sidebar
  // inserts and Cmd/Ctrl+F target the focused pane's handle.
  const editorRefs = useRef<Map<string, QueryEditorHandle>>(new Map());
  const resultGridRefs = useRef<Map<string, ResultGridHandle>>(new Map());
  const editorRefSetters = useRef<Map<string, (h: QueryEditorHandle | null) => void>>(new Map());
  const gridRefSetters = useRef<Map<string, (h: ResultGridHandle | null) => void>>(new Map());
  const getEditorRefSetter = useCallback((paneId: string) => {
    let fn = editorRefSetters.current.get(paneId);
    if (!fn) {
      fn = (h) => {
        if (h) editorRefs.current.set(paneId, h);
        else editorRefs.current.delete(paneId);
      };
      editorRefSetters.current.set(paneId, fn);
    }
    return fn;
  }, []);
  const getGridRefSetter = useCallback((paneId: string) => {
    let fn = gridRefSetters.current.get(paneId);
    if (!fn) {
      fn = (h) => {
        if (h) resultGridRefs.current.set(paneId, h);
        else resultGridRefs.current.delete(paneId);
      };
      gridRefSetters.current.set(paneId, fn);
    }
    return fn;
  }, []);
  const activeEditor = useCallback(
    () => editorRefs.current.get(activePaneIdRef.current ?? "") ?? null,
    [],
  );

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [errorProfileId, setErrorProfileId] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "key", key: "appDisconnected" });
  // Lets the user dismiss the error-hint banner. Reset whenever the status
  // changes (a new query result, connect/disconnect, connection switch, etc.)
  // so a fresh error still shows its hint.
  const [hintDismissed, setHintDismissed] = useState(false);
  // Lets the user close the whole error status bar (the red footer shown on a
  // failed connect, query error, etc.). Reset on every status change so a new
  // error is never silently hidden by a prior dismissal.
  const [statusDismissed, setStatusDismissed] = useState(false);

  const [tabs, setTabs] = useState<Tab[]>([]);
  const [panes, setPanes] = useState<PaneState[]>([]);
  const [activePaneId, setActivePaneId] = useState<string | null>(null);
  // Latest pane layout / focus, mirrored into refs so streaming callbacks,
  // keyboard handlers and the persist helper can read committed state without
  // re-subscribing on every change.
  const panesRef = useRef<PaneState[]>(panes);
  useEffect(() => { panesRef.current = panes; }, [panes]);
  const activePaneIdRef = useRef<string | null>(activePaneId);
  useEffect(() => { activePaneIdRef.current = activePaneId; }, [activePaneId]);
  // Right-click target for the tab move/close menu (viewport coords).
  const [tabMenu, setTabMenu] = useState<{ tabId: string; x: number; y: number } | null>(null);
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
    // True when the gate fired only because the production connection requires
    // approval for any write (no specific destructive pattern was detected).
    writeApproval: boolean;
    autoLimit: number | null;
  } | null>(null);

  // The focused pane drives all the "active tab" handlers (sidebar inserts,
  // keyboard shortcuts, the danger gate). Falls back to the first pane so a
  // stale/cleared activePaneId never leaves us without an active tab.
  const activePane = useMemo(
    () => panes.find((p) => p.id === activePaneId) ?? panes[0] ?? null,
    [panes, activePaneId],
  );
  const activeTabId = activePane?.activeTabId ?? null;
  const activeTab = useMemo(
    () => tabs.find((tt) => tt.id === activeTabId) ?? null,
    [tabs, activeTabId],
  );

  // The active tab of every pane, in pane order. Drives per-pane schema
  // prefetch and lets effects react to either pane changing tabs.
  const paneActiveTabs = useMemo(
    () => panes.map((p) => tabs.find((tt) => tt.id === p.activeTabId) ?? null),
    [panes, tabs],
  );

  // Databases the editors query against — every pane's active tab database,
  // else the profile default. Drives which schema snapshots to prefetch; each
  // pane reads its own snapshot out of `schemaCache` for autocomplete.
  const editorDatabases = useMemo(() => {
    const set = new Set<string>();
    for (const tt of paneActiveTabs) {
      const db = tt?.database ?? selectedProfile?.database ?? null;
      if (db) set.add(db);
    }
    return [...set];
  }, [paneActiveTabs, selectedProfile?.database]);
  // The active session rejects writes when read-only: drives both the Query
  // Builder's disabled Run button and whether inline cell editing is offered.
  const readOnly = selectedProfile?.read_only ?? false;
  // Per-pane autocomplete snapshot lookup against the shared cache.
  const schemaForDatabase = useCallback(
    (database: string | null | undefined): TableSchema[] | null => {
      if (!sessionId || !database) return null;
      return schemaCache[schemaCacheKey(sessionId, database)] ?? null;
    },
    [sessionId, schemaCache],
  );

  // Per-tab stream bookkeeping. Listener cleanup and the active stream id
  // are held in refs so we don't trigger re-renders on every batch and so
  // we can synchronously cancel from anywhere (tab close, disconnect).
  const streamUnlistenRef = useRef<Map<string, UnlistenFn>>(new Map());
  const streamIdRef = useRef<Map<string, string>>(new Map());

  // restoreSavedTabs is declared after runQueryInTab; the ref breaks the
  // ordering cycle so handleConnect (declared above) can still call it.
  const restoreSavedTabsRef = useRef<
    | ((sid: string, profile: ConnectionProfile, ws: PersistedWorkspace) => Promise<void>)
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

  // ---- Pane / tab layout helpers -------------------------------------------

  const focusPane = useCallback((paneId: string) => {
    setActivePaneId((prev) => (prev === paneId ? prev : paneId));
  }, []);

  // Activate a tab within a specific pane and focus that pane.
  const selectTab = useCallback((paneId: string, tabId: string) => {
    setActivePaneId(paneId);
    setPanes((prev) => prev.map((p) => (p.id === paneId ? { ...p, activeTabId: tabId } : p)));
  }, []);

  // Append a freshly built tab to a pane (the focused pane by default) and make
  // it active there. Used by every "open in a new tab" entry point.
  const addTab = useCallback((tab: Tab, paneId?: string) => {
    setTabs((prev) => [...prev, tab]);
    setPanes((prev) => {
      if (prev.length === 0) {
        return [{ id: newPaneId(), tabIds: [tab.id], activeTabId: tab.id }];
      }
      const target = paneId ?? activePaneIdRef.current ?? prev[0].id;
      const exists = prev.some((p) => p.id === target);
      const targetId = exists ? target : prev[0].id;
      return prev.map((p) =>
        p.id === targetId ? { ...p, tabIds: [...p.tabIds, tab.id], activeTabId: tab.id } : p,
      );
    });
    if (paneId) setActivePaneId(paneId);
  }, []);

  // Activate an already-open tab wherever it lives, focusing its pane.
  const activateTab = useCallback((tabId: string) => {
    const owner = panesRef.current.find((p) => p.tabIds.includes(tabId));
    if (!owner) return;
    setActivePaneId(owner.id);
    setPanes((prev) => prev.map((p) => (p.id === owner.id ? { ...p, activeTabId: tabId } : p)));
  }, []);

  // Open a second pane on demand. If the source pane has more than one tab the
  // active tab is moved into the new pane; otherwise a fresh query tab is
  // created there, so neither pane is ever left empty.
  const splitPane = useCallback(() => {
    const prev = panesRef.current;
    if (prev.length >= 2) return;
    const source = prev.find((p) => p.id === activePaneIdRef.current) ?? prev[0];
    if (!source) return;
    const newPid = newPaneId();
    if (source.tabIds.length > 1 && source.activeTabId) {
      const moved = source.activeTabId;
      const idx = source.tabIds.indexOf(moved);
      const remaining = source.tabIds.filter((id) => id !== moved);
      const nextActive = remaining[idx] ?? remaining[idx - 1] ?? remaining[0] ?? null;
      setPanes([
        ...prev.map((p) =>
          p.id === source.id ? { ...p, tabIds: remaining, activeTabId: nextActive } : p,
        ),
        { id: newPid, tabIds: [moved], activeTabId: moved },
      ]);
    } else {
      const tab = makeQueryTab();
      setTabs((cur) => [...cur, tab]);
      setPanes([...prev, { id: newPid, tabIds: [tab.id], activeTabId: tab.id }]);
    }
    setActivePaneId(newPid);
  }, []);

  // Close a pane, merging its open tabs (and their live streams) into the other
  // pane rather than discarding them. Only meaningful when two panes exist.
  const closePane = useCallback((paneId: string) => {
    const prev = panesRef.current;
    if (prev.length <= 1) return;
    const closing = prev.find((p) => p.id === paneId);
    const other = prev.find((p) => p.id !== paneId);
    if (!closing || !other) return;
    setPanes(
      prev
        .filter((p) => p.id !== paneId)
        .map((p) =>
          p.id === other.id
            ? {
                ...p,
                tabIds: [...p.tabIds, ...closing.tabIds],
                activeTabId: p.activeTabId ?? closing.activeTabId,
              }
            : p,
        ),
    );
    setActivePaneId(other.id);
  }, []);

  // Move a single tab to the other pane (creating it if needed). A source pane
  // emptied by the move is dropped, collapsing back to a single pane.
  const moveTabToOtherPane = useCallback((tabId: string) => {
    const prev = panesRef.current;
    const source = prev.find((p) => p.tabIds.includes(tabId));
    if (!source) return;
    const idx = source.tabIds.indexOf(tabId);
    const remaining = source.tabIds.filter((id) => id !== tabId);
    const sourceActive =
      source.activeTabId === tabId ? remaining[idx] ?? remaining[idx - 1] ?? null : source.activeTabId;
    if (prev.length >= 2) {
      const target = prev.find((p) => p.id !== source.id)!;
      let next = prev.map((p) => {
        if (p.id === source.id) return { ...p, tabIds: remaining, activeTabId: sourceActive };
        if (p.id === target.id) return { ...p, tabIds: [...p.tabIds, tabId], activeTabId: tabId };
        return p;
      });
      if (remaining.length === 0) next = next.filter((p) => p.id !== source.id);
      setPanes(next);
      setActivePaneId(target.id);
    } else {
      if (remaining.length === 0) return;
      const newPid = newPaneId();
      setPanes([
        ...prev.map((p) =>
          p.id === source.id ? { ...p, tabIds: remaining, activeTabId: sourceActive } : p,
        ),
        { id: newPid, tabIds: [tabId], activeTabId: tabId },
      ]);
      setActivePaneId(newPid);
    }
  }, []);

  const openTabMenu = useCallback((tabId: string, x: number, y: number) => {
    setTabMenu({ tabId, x, y });
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

  // Snapshot the current pane layout (from refs so we don't depend on stale
  // closure copies) into localStorage under the given profile id.
  const persistTabsForProfile = useCallback((profileId: string) => {
    const curTabs = tabsRef.current;
    const curPanes = panesRef.current;
    const ws: PersistedWorkspace = {
      panes: curPanes
        .map((p) => {
          const paneTabs = p.tabIds
            .map((id) => curTabs.find((tt) => tt.id === id))
            .filter((tt): tt is Tab => tt != null)
            .map(toPersistedTab);
          const activeIndex = Math.max(0, p.tabIds.indexOf(p.activeTabId ?? ""));
          return { tabs: paneTabs, activeIndex: Math.min(activeIndex, Math.max(0, paneTabs.length - 1)) };
        })
        .filter((p) => p.tabs.length > 0),
      activePane: Math.max(0, curPanes.findIndex((p) => p.id === activePaneIdRef.current)),
    };
    savePersistedWorkspace(profileId, ws);
  }, []);

  const closeAllTabs = useCallback(async () => {
    // Cancel any in-flight streams before tearing down tabs.
    const ids = Array.from(streamIdRef.current.keys());
    await Promise.all(ids.map((tid) => cancelStreamForTab(tid)));
    setTabs([]);
    setPanes([]);
    setActivePaneId(null);
  }, [cancelStreamForTab]);

  const handleConnect = useCallback(async (profile: ConnectionProfile) => {
    if (profile.is_production && settings.confirmProductionConnect) {
      const ok = await confirm({
        title: translate("productionConfirmTitle"),
        message: (
          <Flex direction="column" gap="var(--space-2)" color="app.text">
            <Flex align="center" gap="var(--space-2)">
              {profile.color && (
                <chakra.span
                  display="inline-block"
                  w="14px"
                  h="14px"
                  borderRadius="full"
                  flexShrink={0}
                  bg={profile.color}
                  borderWidth="1px"
                  borderStyle="solid"
                  borderColor="app.borderStrong"
                  aria-hidden
                />
              )}
              <chakra.span fontWeight={600} fontSize="md">{profile.name}</chakra.span>
              <chakra.span
                display="inline-flex"
                alignItems="center"
                gap="4px"
                fontSize="xs"
                textTransform="uppercase"
                letterSpacing="0.06em"
                fontWeight={700}
                px="8px"
                py="2px"
                borderRadius="pill"
                bg="app.status.error"
                color="#fff"
                flexShrink={0}
              >
                <Icon name="warning" size={12} />
                {translate("listProduction")}
              </chakra.span>
            </Flex>
            <chakra.span>{translate("productionConfirm", { name: profile.name })}</chakra.span>
            <chakra.span color="app.textMuted" fontSize="sm">
              {translate("productionConfirmHint")}
            </chakra.span>
          </Flex>
        ),
        confirmLabel: translate("productionConfirmAction"),
        tone: "warning",
      });
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

      const savedWs = loadPersistedWorkspace(profile.id);
      const savedCount = savedWs.panes.reduce((n, p) => n + p.tabs.length, 0);
      const restore =
        savedCount > 0 &&
        (await shouldRestoreSavedTabs(settings.tabRestoreMode, () =>
          confirm({
            title: translate("tabRestoreConfirmTitle"),
            message: translate("tabRestoreConfirm", { count: savedCount }),
            confirmLabel: translate("tabRestoreConfirmRestore"),
            cancelLabel: translate("tabRestoreConfirmDiscard"),
            tone: "primary",
          }),
        ));
      if (restore && restoreSavedTabsRef.current) {
        await restoreSavedTabsRef.current(res.session_id, profile, savedWs);
      } else {
        if (savedCount > 0 && !restore) clearPersistedTabs(profile.id);
        const tab = makeQueryTab();
        const paneId = newPaneId();
        setTabs([tab]);
        setPanes([{ id: paneId, tabIds: [tab.id], activeTabId: tab.id }]);
        setActivePaneId(paneId);
      }
      setStatus({ kind: "idle" });
      toast.success(translate("toastConnected", { name: profile.name }));
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
    toast,
    confirm,
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

  // Fetch schema for each pane's active table tab so its editor can
  // autocomplete columns. Covers both panes, not just the focused one.
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    for (const tt of paneActiveTabs) {
      if (!tt || tt.kind !== "table" || !tt.database || !tt.table || tt.schemaTable) continue;
      const { id, database, table } = tt;
      api.describeTable(sessionId, database, table)
        .then((cols) => {
          if (cancelled) return;
          updateTab(id, {
            schemaTable: { database, name: table, columns: cols.map((c) => c.name) },
            tableColumns: cols,
          });
        })
        .catch(() => { /* ignore */ });
    }
    return () => { cancelled = true; };
  }, [sessionId, paneActiveTabs, updateTab]);

  // Drop every cached schema when the session changes so a new connection
  // never autocompletes against the previous database's tables.
  useEffect(() => {
    setSchemaCache({});
    schemaInFlightRef.current.clear();
  }, [sessionId]);

  // Fetch the whole-schema snapshot for each pane's database on demand and
  // cache it. Runs on connect, when a pane moves to another database, and
  // again after an invalidation drops a cache entry.
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    for (const database of editorDatabases) {
      const key = schemaCacheKey(sessionId, database);
      if (key in schemaCache || schemaInFlightRef.current.has(key)) continue;
      schemaInFlightRef.current.add(key);
      api.schemaOverview(sessionId, database)
        .then((schema) => {
          if (!cancelled) setSchemaCache((prev) => ({ ...prev, [key]: schema }));
        })
        .catch(() => { /* autocomplete is best-effort; ignore failures */ })
        .finally(() => { schemaInFlightRef.current.delete(key); });
    }
    return () => { cancelled = true; };
  }, [sessionId, editorDatabases, schemaCache]);

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

  // Build fresh Tab objects from a saved workspace and replace the live layout.
  // Table tabs are verified via describeTable; entries pointing at tables that
  // no longer exist are demoted to query tabs holding the saved SQL. Each saved
  // pane is restored as its own pane so a split layout comes back split.
  const restoreSavedTabs = useCallback(
    async (sid: string, profile: ConnectionProfile, ws: PersistedWorkspace) => {
      const limit = Math.max(1, settings.defaultDisplayCount);
      const buildTab = async (s: PersistedTab): Promise<Tab> => {
        const restoredSnapshot = s.builderSnapshot ?? null;
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
              builderSnapshot: restoredSnapshot,
            };
          } catch {
            // Table is gone — fall through to a query tab using the saved SQL.
          }
        }
        if (s.kind === "explain") {
          const tab = makeExplainTab(s.sql);
          return {
            ...tab,
            title: s.title || tab.title,
            previewRowLimit: limit,
            builderSnapshot: restoredSnapshot,
          };
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
          builderSnapshot: restoredSnapshot,
        };
      };

      const allTabs: Tab[] = [];
      const builtPanes: PaneState[] = [];
      for (const persistedPane of ws.panes) {
        const builtTabs = await Promise.all(persistedPane.tabs.map(buildTab));
        if (builtTabs.length === 0) continue;
        const activeIdx = Math.min(Math.max(0, persistedPane.activeIndex), builtTabs.length - 1);
        builtPanes.push({
          id: newPaneId(),
          tabIds: builtTabs.map((tt) => tt.id),
          activeTabId: builtTabs[activeIdx].id,
        });
        allTabs.push(...builtTabs);
      }

      if (builtPanes.length === 0) {
        const tab = makeQueryTab();
        const paneId = newPaneId();
        setTabs([tab]);
        setPanes([{ id: paneId, tabIds: [tab.id], activeTabId: tab.id }]);
        setActivePaneId(paneId);
        return;
      }
      setTabs(allTabs);
      setPanes(builtPanes);
      const activePaneIdx = Math.min(Math.max(0, ws.activePane), builtPanes.length - 1);
      setActivePaneId(builtPanes[activePaneIdx].id);
      // Re-run the initial table query for restored table tabs so the user
      // immediately sees data instead of an empty grid.
      for (const tab of allTabs) {
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

  // Run the editor's SQL in a specific tab, applying the danger gate and auto
  // LIMIT. Pane content binds this to its own active tab so each pane runs
  // independently.
  const runInTabWithGate = useCallback((tab: Tab, sql: string) => {
    // On an explain tab the primary action re-runs EXPLAIN so the viewer keeps
    // getting plan JSON instead of a raw result set. EXPLAIN is read-only, so
    // it never trips the destructive-query gate or auto LIMIT.
    if (tab.kind === "explain") {
      runQueryInTab(tab.id, `${EXPLAIN_PREFIX}${sql}`);
      return;
    }
    // Auto LIMIT only guards free-form editor queries; table tabs carry their
    // own LIMIT. Writes pass through here too but the backend parser leaves
    // them untouched.
    const autoLimit =
      tab.kind === "query" && settings.autoLimitEnabled ? settings.autoLimitCount : null;
    const isProduction = selectedProfile?.is_production ?? false;
    const sessionReadOnly = selectedProfile?.read_only ?? false;
    // Production connections may opt into approving every data-modifying
    // statement. Read-only takes precedence: those sessions reject writes
    // outright on the backend, so there is nothing to approve here.
    const requireWriteApproval =
      isProduction && (selectedProfile?.confirm_writes ?? false) && !sessionReadOnly;
    const findings =
      isProduction || settings.confirmDangerousQueries ? analyzeDangerousSql(sql) : [];
    const needsWriteApproval = requireWriteApproval && !isReadOnlySql(sql);
    if (findings.length > 0 || needsWriteApproval) {
      setPendingDangerous({
        tabId: tab.id,
        sql,
        findings,
        isProduction,
        writeApproval: needsWriteApproval,
        autoLimit,
      });
      return;
    }
    runQueryInTab(tab.id, sql, null, autoLimit);
  }, [
    runQueryInTab,
    selectedProfile?.is_production,
    selectedProfile?.confirm_writes,
    selectedProfile?.read_only,
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
  const fetchAllForTab = useCallback((tab: Tab) => {
    if (tab.autoLimitSql === null) return;
    runQueryInTab(tab.id, tab.autoLimitSql, null, null);
  }, [runQueryInTab]);

  const explainForTab = useCallback((sourceTab: Tab, sql: string) => {
    // Re-explain in place when already on an explain tab; otherwise open a
    // dedicated explain tab in the same pane so the source is left untouched.
    if (sourceTab.kind === "explain") {
      runQueryInTab(sourceTab.id, `${EXPLAIN_PREFIX}${sql}`);
      return;
    }
    const owner = panesRef.current.find((p) => p.tabIds.includes(sourceTab.id));
    const tab = makeExplainTab(sql);
    addTab(tab, owner?.id);
    runQueryInTab(tab.id, `${EXPLAIN_PREFIX}${sql}`);
  }, [runQueryInTab, addTab]);

  // User-driven stop: cancel the tab's in-flight stream, drop the streaming
  // flag, and keep whatever rows have already arrived. The backend
  // `cancelStream` tears down the cursor while leaving the connection open.
  const stopTab = useCallback(async (tab: Tab) => {
    if (!tab.streaming) return;
    await cancelStreamForTab(tab.id);
    patchTab(tab.id, (tt) => ({ ...tt, streaming: false }));
    setStatus({ kind: "key", key: "statusQueryCancelled" });
  }, [cancelStreamForTab, patchTab]);

  // Insert a snippet into the focused pane's editor, or open a fresh query tab
  // holding the snippet when there is no active tab yet.
  const handleInsertSnippet = useCallback((snippet: Snippet) => {
    if (activeTab) {
      activeEditor()?.insertText(snippet.sql);
    } else if (sessionId) {
      addTab({ ...makeQueryTab(), sql: snippet.sql, lastExecutedSql: snippet.sql });
    }
  }, [activeTab, sessionId, activeEditor, addTab]);

  // Restore a history entry's SQL into the focused pane's query/explain editor
  // when there is one, otherwise into a fresh query tab so we don't clobber a
  // table tab's auto-generated SELECT.
  const handleRestoreHistory = useCallback((sql: string) => {
    if (activeTab && (activeTab.kind === "query" || activeTab.kind === "explain")) {
      activeEditor()?.setText(sql);
    } else if (sessionId) {
      addTab({ ...makeQueryTab(), sql, lastExecutedSql: sql });
    }
  }, [activeTab, sessionId, activeEditor, addTab]);

  // Always open history SQL in a fresh query tab, never overwriting the editor.
  const handleOpenHistoryInNewTab = useCallback((sql: string) => {
    addTab({ ...makeQueryTab(), sql, lastExecutedSql: sql });
  }, [addTab]);

  const handleSaveSnippetFromEditor = useCallback((sql: string) => {
    setEditingSnippet(null);
    setSnippetFormSql(sql);
    setShowForm(false);
    setShowSettings(false);
    setShowHelp(false);
    setShowCompare(false);
    setShowSnippetForm(true);
    setFormInstanceId((n) => n + 1);
  }, []);

  const handleEditSnippet = useCallback((snippet: Snippet) => {
    setEditingSnippet(snippet);
    setSnippetFormSql("");
    setShowForm(false);
    setShowSettings(false);
    setShowHelp(false);
    setShowCompare(false);
    setShowSnippetForm(true);
    setFormInstanceId((n) => n + 1);
  }, []);

  const handleDeleteSnippet = useCallback(async (id: string) => {
    await api.deleteSnippet(id);
    await refreshSnippets();
  }, [refreshSnippets]);

  const setCellEditForTab = useCallback(
    (tabId: string, rowIdx: number, colIdx: number, value: string | null) => {
      patchTab(tabId, (tt) => {
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
    [patchTab],
  );

  const clearEditsForTab = useCallback((tabId: string) => {
    patchTab(tabId, (tt) => ({ ...tt, pendingEdits: {} }));
  }, [patchTab]);

  // Discard from inside the preview pane: clear the edits AND dismiss the
  // preview view (otherwise the user is stuck on a preview of edits that
  // no longer exist). Also cancels any in-flight preview stream so a
  // late-arriving onMeta event doesn't re-populate `preview` after we've
  // cleared it.
  const discardEditsAndPreviewForTab = useCallback((tabId: string) => {
    void cancelStreamForTab(tabId);
    patchTab(tabId, (tt) => ({ ...tt, pendingEdits: {}, preview: null }));
  }, [patchTab, cancelStreamForTab]);

  const previewEditsForTab = useCallback((tab: Tab) => {
    if (!sessionId) return;
    const { result, tableColumns, database, table, pendingEdits } = tab;
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
    previewQueryInTab(tab.id, stmts[0]);
  }, [sessionId, previewQueryInTab, selectedProfile?.driver]);

  const applyEditsForTab = useCallback(async (tab: Tab) => {
    if (!sessionId) return;
    const { result, tableColumns, database, table, pendingEdits, paginatable } = tab;
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
    const tabId = tab.id;
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
      activateTab(existing.id);
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
    addTab(tab);
    runQueryInTab(tab.id, sql, base);
  }, [tabs, runQueryInTab, addTab, activateTab, settings.defaultDisplayCount, selectedProfile?.driver]);

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
    addTab(tab);
    runQueryInTab(tab.id, sql);
  }, [sessionId, runQueryInTab, addTab]);

  const handleRunTableSelect = useCallback((database: string, table: string) => {
    const limit = Math.max(1, settings.defaultDisplayCount);
    const base = qualifiedTableSql(selectedProfile?.driver ?? "mysql", database, table);
    openAndRunQuery(`${base} LIMIT ${limit}`, table);
  }, [openAndRunQuery, settings.defaultDisplayCount, selectedProfile?.driver]);

  // Insert SELECT * into the focused pane's editor, or open a fresh query tab
  // when the active tab has no editor (e.g. a table tab) — mirrors
  // handleRestoreHistory.
  const handleInsertTableSelect = useCallback((database: string, table: string) => {
    const sql = qualifiedTableSql(selectedProfile?.driver ?? "mysql", database, table);
    if (activeTab && (activeTab.kind === "query" || activeTab.kind === "explain")) {
      activeEditor()?.insertText(sql);
    } else if (sessionId) {
      addTab({ ...makeQueryTab(), sql, lastExecutedSql: sql });
    }
  }, [activeTab, sessionId, selectedProfile?.driver, activeEditor, addTab]);

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

  const handleNewTab = useCallback((paneId?: string) => {
    addTab(makeQueryTab(), paneId);
  }, [addTab]);

  // Close a tab, removing it from its pane and picking a neighbour as that
  // pane's new active tab. A second pane emptied by the close collapses back
  // into a single pane.
  const handleCloseTab = useCallback((id: string) => {
    cancelStreamForTab(id);
    const prevPanes = panesRef.current;
    let removedPaneId: string | null = null;
    let next = prevPanes.map((p) => {
      if (!p.tabIds.includes(id)) return p;
      const idx = p.tabIds.indexOf(id);
      const tabIds = p.tabIds.filter((t) => t !== id);
      const activeTabIdNext =
        p.activeTabId === id ? tabIds[idx] ?? tabIds[idx - 1] ?? null : p.activeTabId;
      return { ...p, tabIds, activeTabId: activeTabIdNext };
    });
    if (next.length > 1) {
      const empty = next.find((p) => p.tabIds.length === 0);
      if (empty) {
        removedPaneId = empty.id;
        next = next.filter((p) => p.tabIds.length > 0);
      }
    }
    setTabs((prev) => prev.filter((tt) => tt.id !== id));
    setPanes(next);
    if (removedPaneId && activePaneIdRef.current === removedPaneId) {
      setActivePaneId(next[0]?.id ?? null);
    }
  }, [cancelStreamForTab]);

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
    if (!sessionId || showForm || showSettings || showHelp || showCompare || showSnippetForm) return;
    const focusedPane = () =>
      panesRef.current.find((p) => p.id === activePaneIdRef.current) ?? panesRef.current[0] ?? null;
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      // Cmd/Ctrl+F → focus the focused pane's cross-column result search (no
      // Shift so the editor's Cmd/Ctrl+Shift+F format shortcut is left alone).
      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "f") {
        const grid = resultGridRefs.current.get(activePaneIdRef.current ?? "");
        if (grid) {
          e.preventDefault();
          grid.focusSearch();
        }
        return;
      }
      // Ctrl+Tab / Ctrl+Shift+Tab → next / previous tab within the focused pane
      // (wraps around). Uses Ctrl on every platform; Cmd+Tab is the macOS app
      // switcher.
      if (e.ctrlKey && !e.metaKey && !e.altKey && e.key === "Tab") {
        const pane = focusedPane();
        if (!pane || pane.tabIds.length === 0) return;
        e.preventDefault();
        const cur = pane.tabIds.indexOf(pane.activeTabId ?? "");
        const delta = e.shiftKey ? -1 : 1;
        const nextIdx = (cur + delta + pane.tabIds.length) % pane.tabIds.length;
        selectTab(pane.id, pane.tabIds[nextIdx]);
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
        const active = focusedPane()?.activeTabId;
        if (active) handleCloseTabRef.current(active);
        return;
      }
      if (e.key >= "1" && e.key <= "9") {
        const pane = focusedPane();
        if (!pane) return;
        const idx = Number(e.key) - 1;
        if (idx < pane.tabIds.length) {
          e.preventDefault();
          selectTab(pane.id, pane.tabIds[idx]);
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [sessionId, showForm, showSettings, showHelp, showCompare, showSnippetForm, handleNewTab, selectTab]);

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

  const statusText =
    status.kind === "idle" ? "" : status.kind === "literal" ? status.text : t(status.key, status.vars);

  const statusHintKey = useMemo(() => {
    if (status.kind === "idle" || !status.error) return null;
    const raw = status.kind === "literal" ? status.text : status.vars?.error;
    return raw != null ? matchErrorHint(String(raw)) : null;
  }, [status]);

  // The profile to offer a one-click reconnect for: set whenever a connect
  // failed or a live connection dropped (`errorProfileId`), while no session
  // is active. Lets the footer surface a "Reconnect" button so recovery
  // doesn't require hunting for the profile in the sidebar again.
  const reconnectProfile = useMemo(
    () =>
      !sessionId && errorProfileId
        ? profiles.find((p) => p.id === errorProfileId) ?? null
        : null,
    [sessionId, errorProfileId, profiles],
  );

  // Any new status (new query, connect/disconnect, connection switch) re-enables
  // the hint banner and the status bar itself so neither is permanently
  // suppressed by a prior dismissal.
  useEffect(() => {
    setHintDismissed(false);
    setStatusDismissed(false);
  }, [status]);

  // Build a single pane's content: its own TabBar plus the editor/result
  // splitter wired to that pane's active tab. Rendered once (single pane) or
  // twice (side-by-side split). Each pane streams independently because every
  // per-tab handler is keyed by tab id, and stream bookkeeping lives in refs
  // keyed by tab id (not pane).
  const renderPane = (pane: PaneState) => {
    const paneTabs = pane.tabIds
      .map((id) => tabs.find((tt) => tt.id === id))
      .filter((tt): tt is Tab => tt != null);
    const tab = tabs.find((tt) => tt.id === pane.activeTabId) ?? null;
    const split = panes.length > 1;
    const isFocused = pane.id === activePane?.id;
    const paneDatabase = tab?.database ?? selectedProfile?.database ?? null;
    const paneSchema = schemaForDatabase(paneDatabase);
    const summary = tab
      ? { cells: countEditedCells(tab.pendingEdits), rows: countEditedRows(tab.pendingEdits) }
      : { cells: 0, rows: 0 };
    return (
      <Flex
        key={pane.id}
        direction="column"
        flex="1 1 auto"
        minW={0}
        minH={0}
        overflow="hidden"
        borderTopWidth={split ? "2px" : undefined}
        borderTopStyle={split ? "solid" : undefined}
        borderTopColor={split ? (isFocused ? "var(--ws-accent)" : "transparent") : undefined}
        onMouseDownCapture={() => focusPane(pane.id)}
      >
        <TabBar
          tabs={paneTabs.map((tt) => ({
            id: tt.id,
            kind: tt.kind,
            title: tt.title,
            database: tt.database,
            table: tt.table,
            dirty: tt.kind === "query" && tt.sql !== tt.lastExecutedSql,
          }))}
          activeTabId={pane.activeTabId}
          onSelect={(id) => selectTab(pane.id, id)}
          onClose={handleCloseTab}
          onNew={() => handleNewTab(pane.id)}
          onTabContextMenu={openTabMenu}
          onSplit={split ? () => closePane(pane.id) : splitPane}
          splitMode={split ? "close" : "split"}
        />
        <AnimatePresence>
          {tab?.streaming && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 2 }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.18 }}
              aria-hidden
              style={{
                position: "relative",
                flexShrink: 0,
                overflow: "hidden",
                background: "color-mix(in srgb, var(--accent) 16%, transparent)",
              }}
            >
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  width: "35%",
                  borderRadius: "var(--radius-pill)",
                  background: "var(--accent)",
                  animation: "query-progress-slide 1.05s var(--ease) infinite",
                }}
              />
            </motion.div>
          )}
        </AnimatePresence>
        <Flex direction="column" flex="1" overflow="hidden">
          {tab ? (
            <Splitter
              direction="column"
              storageKey="noobdb.split.editor"
              defaultFraction={0.4}
              minSize={120}
              ariaLabel={t("splitterEditorAria")}
              first={
                <Suspense fallback={<PaneEmpty><Spinner size={20} /></PaneEmpty>}>
                  <QueryEditor
                    key={tab.id}
                    ref={getEditorRefSetter(pane.id)}
                    initialSql={tab.sql}
                    running={tab.streaming}
                    onRun={(sql) => runInTabWithGate(tab, sql)}
                    onPreview={tab.kind === "explain" ? undefined : (sql) => previewQueryInTab(tab.id, sql)}
                    onExplain={tab.kind === "explain" ? undefined : (sql) => explainForTab(tab, sql)}
                    explainMode={tab.kind === "explain"}
                    onChange={(sql) => updateTab(tab.id, { sql })}
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
                    schemaTable={tab.schemaTable}
                    databaseSchema={paneSchema}
                    activeTable={
                      tab.kind === "table" && tab.database && tab.table
                        ? { database: tab.database, name: tab.table }
                        : null
                    }
                    sessionId={sessionId}
                    defaultDatabase={tab.database ?? selectedProfile?.database ?? null}
                    driver={selectedProfile?.driver ?? "mysql"}
                    builderSnapshot={tab.builderSnapshot}
                    onBuilderPersist={(snapshot) => updateTab(tab.id, { builderSnapshot: snapshot })}
                    readOnly={readOnly}
                  />
                </Suspense>
              }
              second={
                <Suspense fallback={<PaneEmpty><Spinner size={20} /></PaneEmpty>}>
                  {tab.kind === "explain" ? (
                    <ExplainViewer result={tab.result} streaming={tab.streaming} />
                  ) : tab.preview ? (
                    <PreviewGrid
                      result={tab.preview}
                      rowLimit={tab.previewRowLimit}
                      streaming={tab.streaming}
                      onStop={() => stopTab(tab)}
                      pendingEditsSummary={
                        tab.kind === "table" && summary.cells > 0 ? summary : undefined
                      }
                      onApplyEdits={
                        tab.kind === "table" && summary.cells > 0
                          ? () => applyEditsForTab(tab)
                          : undefined
                      }
                      onDiscardEdits={
                        tab.kind === "table" && summary.cells > 0
                          ? () => discardEditsAndPreviewForTab(tab.id)
                          : undefined
                      }
                    />
                  ) : (
                    <ResultGrid
                      ref={getGridRefSetter(pane.id)}
                      result={tab.result}
                      streaming={tab.streaming}
                      onStopStreaming={() => stopTab(tab)}
                      loadingMore={tab.loadingMore}
                      canLoadMore={tab.canLoadMore}
                      onLoadMore={() => loadMoreInTab(tab.id)}
                      autoLimitApplied={tab.autoLimitApplied}
                      onFetchAllRows={() => fetchAllForTab(tab)}
                      database={tab.database ?? selectedProfile?.database ?? null}
                      table={tab.table ?? null}
                      editable={tab.kind === "table" && !readOnly}
                      tableColumns={tab.tableColumns}
                      pendingEdits={tab.pendingEdits}
                      onSetCellEdit={(r, c, v) => setCellEditForTab(tab.id, r, c, v)}
                      onClearEdits={() => clearEditsForTab(tab.id)}
                      onPreviewEdits={() => previewEditsForTab(tab)}
                      onApplyEdits={() => applyEditsForTab(tab)}
                    />
                  )}
                </Suspense>
              }
            />
          ) : (
            <PaneEmpty>
              <EmptyState
                icon="query"
                title={t("tabsEmptyTitle")}
                description={t("tabsEmpty")}
                action={{ label: t("tabsNewQuery"), onClick: () => handleNewTab(pane.id) }}
              />
            </PaneEmpty>
          )}
        </Flex>
      </Flex>
    );
  };

  return (
    <Flex direction="column" h="100vh">
      <TitleBar />
      <Grid
        templateColumns={
          sidebarCollapsed || (narrow && narrowSidebarOpen)
            ? "0 1fr"
            : "var(--sidebar-width, 300px) 1fr"
        }
        flex="1"
        minH={0}
        position="relative"
        style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}
      >
      <Flex
        as="aside"
        gridColumn="1"
        direction="column"
        overflow="hidden"
        borderRightWidth="1px"
        borderRightColor="app.border"
        bg="app.surface"
        {...(narrow && narrowSidebarOpen
          ? {
              position: "absolute" as const,
              top: 0,
              bottom: 0,
              left: 0,
              width: "var(--sidebar-width, 300px)",
              zIndex: 40,
              boxShadow: "md",
            }
          : {})}
      >
        <Flex
          as="header"
          px="12px"
          py="10px"
          borderBottomWidth="1px"
          borderBottomColor="app.border"
          fontWeight={600}
          justify="space-between"
          align="center"
          gap="var(--space-2)"
        >
          <IconButton
            flexShrink="0"
            onClick={toggleSidebar}
            title={t("sidebarCollapse")}
            aria-label={t("sidebarCollapse")}
          >
            <Icon name="chevron-left" />
          </IconButton>
          <chakra.span
            flex="1"
            fontSize="md"
            letterSpacing="0.02em"
            color="app.text"
            overflow="hidden"
            textOverflow="ellipsis"
            whiteSpace="nowrap"
          >
            {sidebarTab === "snippets"
              ? t("appSnippets")
              : sidebarTab === "history"
                ? t("appHistory")
                : t("appConnections")}
          </chakra.span>
          <Flex gap="var(--space-1)" align="center">
            <IconButton
              onClick={toggleTheme}
              title={theme === "dark" ? t("appThemeToLight") : t("appThemeToDark")}
              aria-label={t("appThemeToggle")}
            >
              <Icon name={theme === "dark" ? "sun" : "moon"} />
            </IconButton>
            <IconButton
              onClick={() => { setShowForm(false); setShowSnippetForm(false); setShowCompare(false); setShowSettings(false); setShowHelp(true); }}
              title={t("appHelp")}
              aria-label={t("appHelp")}
            >
              <Icon name="help" />
            </IconButton>
            <IconButton
              onClick={() => { setShowForm(false); setShowSnippetForm(false); setShowCompare(false); setShowHelp(false); setShowSettings(true); }}
              title={t("appSettings")}
              aria-label={t("appSettings")}
            >
              <Icon name="settings" />
            </IconButton>
            <IconButton
              onClick={() => { setShowForm(false); setShowSnippetForm(false); setShowHelp(false); setShowSettings(false); setShowCompare(true); }}
              title={t("appSchemaCompare")}
              aria-label={t("appSchemaCompare")}
            >
              <Icon name="diff" />
            </IconButton>
            {sidebarTab === "snippets" ? (
              <IconButton
                onClick={() => {
                  setEditingSnippet(null);
                  setSnippetFormSql("");
                  setShowSettings(false);
                  setShowHelp(false);
                  setShowCompare(false);
                  setShowForm(false);
                  setShowSnippetForm(true);
                  setFormInstanceId((n) => n + 1);
                }}
                title={t("appNewSnippet")}
                aria-label={t("appNewSnippet")}
              >
                <Icon name="plus" />
              </IconButton>
            ) : sidebarTab === "connections" ? (
              <IconButton
                onClick={() => { setEditing(null); setShowSettings(false); setShowHelp(false); setShowCompare(false); setShowSnippetForm(false); setShowForm(true); setFormInstanceId((n) => n + 1); }}
                title={t("appNew")}
                aria-label={t("appNew")}
              >
                <Icon name="plus" />
              </IconButton>
            ) : null}
          </Flex>
        </Flex>
        <Flex
          borderBottomWidth="1px"
          borderBottomColor="app.border"
          role="tablist"
          aria-label={t("sidebarTablistAria")}
        >
          <SidebarTabButton
            ref={(el) => { sidebarTabRefs.current.connections = el; }}
            tabKey="connections"
            active={sidebarTab === "connections"}
            onActivate={() => setSidebarTab("connections")}
            onKeyDown={handleSidebarTabKeyDown("connections")}
          >
            {t("sidebarTabConnections")}
          </SidebarTabButton>
          <SidebarTabButton
            ref={(el) => { sidebarTabRefs.current.snippets = el; }}
            tabKey="snippets"
            active={sidebarTab === "snippets"}
            onActivate={() => setSidebarTab("snippets")}
            onKeyDown={handleSidebarTabKeyDown("snippets")}
          >
            {t("sidebarTabSnippets")}
          </SidebarTabButton>
          <SidebarTabButton
            ref={(el) => { sidebarTabRefs.current.history = el; }}
            tabKey="history"
            active={sidebarTab === "history"}
            onActivate={() => setSidebarTab("history")}
            onKeyDown={handleSidebarTabKeyDown("history")}
          >
            {t("sidebarTabHistory")}
          </SidebarTabButton>
        </Flex>
        <Box
          role="tabpanel"
          id={sidebarPanelId(sidebarTab)}
          aria-labelledby={sidebarTabId(sidebarTab)}
          display="flex"
          flexDirection="column"
          flex="1"
          overflow="hidden"
        >
          {sidebarTab === "connections" ? (
          <ConnectionList
            profiles={profiles}
            activeProfileId={selectedProfile?.id ?? null}
            sessionId={sessionId}
            connectingId={connectingId}
            errorProfileId={errorProfileId}
            onConnect={handleConnect}
            onCreate={() => { setEditing(null); setShowSettings(false); setShowHelp(false); setShowCompare(false); setShowSnippetForm(false); setShowForm(true); setFormInstanceId((n) => n + 1); }}
            onEdit={(p) => { setEditing(p); setShowSnippetForm(false); setShowSettings(false); setShowHelp(false); setShowCompare(false); setShowForm(true); setFormInstanceId((n) => n + 1); }}
            onDuplicate={(p) => {
              // Open the form pre-filled with the source profile's non-secret
              // settings as a brand-new entry: blank id forces save_profile to
              // mint a fresh id, and secrets (password/passphrase) are never
              // carried over from the keyring.
              setEditing({ ...p, id: "", name: `${p.name}${t("listDuplicateSuffix")}` });
              setShowSnippetForm(false);
              setShowSettings(false);
              setShowHelp(false);
              setShowCompare(false);
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
        </Box>
      </Flex>

      {!sidebarCollapsed && (
        <Box
          position="absolute"
          top={0}
          bottom={0}
          left="var(--sidebar-width, 300px)"
          width="9px"
          transform="translateX(-5px)"
          cursor="ew-resize"
          zIndex={45}
          touchAction="none"
          data-dragging={sidebarResizing ? "true" : undefined}
          css={{
            "&::after": {
              content: '""',
              position: "absolute",
              top: 0,
              bottom: 0,
              left: "5px",
              width: "1px",
              background: "transparent",
              transition:
                "background var(--dur-fast, 0.12s) var(--ease, ease), width var(--dur-fast, 0.12s) var(--ease, ease)",
            },
            "&:hover::after, &[data-dragging='true']::after": {
              background: "var(--accent)",
              width: "2px",
            },
          }}
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
        <chakra.button
          position="absolute"
          top="9px"
          left="8px"
          zIndex={46}
          display="inline-flex"
          alignItems="center"
          justifyContent="center"
          width="28px"
          height="28px"
          p="0"
          borderWidth="1px"
          borderStyle="solid"
          borderColor="app.border"
          borderRadius="md"
          bg="app.surface"
          color="app.textSecondary"
          cursor="pointer"
          boxShadow="sm"
          _hover={{ color: "app.text", bg: "app.hover" }}
          onClick={toggleSidebar}
          title={t("sidebarExpand")}
          aria-label={t("sidebarExpand")}
        >
          <Icon name="chevron-right" />
        </chakra.button>
      )}

      {narrow && narrowSidebarOpen && (
        <Box
          position="absolute"
          inset={0}
          zIndex={30}
          bg="rgba(0, 0, 0, 0.3)"
          onClick={() => setNarrowSidebarOpen(false)}
          aria-hidden
        />
      )}

      <Flex
        as="main"
        gridColumn="2"
        direction="column"
        overflow="hidden"
        bg="app.bg"
        minW={0}
        style={
          selectedProfile?.color
            ? ({ "--ws-accent": selectedProfile.color } as CSSProperties)
            : undefined
        }
      >
        <Suspense fallback={<PaneEmpty><Spinner size={20} /></PaneEmpty>}>
        {showHelp ? (
          <HelpView onClose={() => setShowHelp(false)} />
        ) : showSettings ? (
          <SettingsView theme={theme} onClose={() => setShowSettings(false)} />
        ) : showCompare ? (
          <SchemaCompareView profiles={profiles} onClose={() => setShowCompare(false)} />
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
            <Flex
              align="center"
              gap="var(--space-3)"
              pl={sidebarCollapsed ? "46px" : "14px"}
              pr="14px"
              py="8px"
              borderBottomWidth="1px"
              borderBottomColor="app.border"
              minH="42px"
              bg={`color-mix(in srgb, var(--ws-accent) ${selectedProfile?.is_production ? "9%" : "4%"}, var(--bg-elevated))`}
              boxShadow={`inset 0 ${selectedProfile?.is_production ? "3px" : "2px"} 0 var(--ws-accent)`}
              transition="background var(--dur-med) var(--ease), box-shadow var(--dur-med) var(--ease)"
              css={{ "@media (max-width: 760px)": { flexWrap: "wrap", rowGap: "4px" } }}
            >
              <Flex align="center" gap="var(--space-2)" overflow="hidden">
                {selectedProfile ? (
                  <>
                    <StatusDot variant="connected" />
                    <chakra.span fontWeight={600} fontSize="md">{selectedProfile.name}</chakra.span>
                    {selectedProfile.is_production && (
                      <chakra.span
                        title={t("listProductionTitle")}
                        display="inline-flex"
                        alignItems="center"
                        gap="4px"
                        fontSize="xs"
                        textTransform="uppercase"
                        letterSpacing="0.06em"
                        fontWeight={700}
                        px="8px"
                        py="2px"
                        borderRadius="pill"
                        bg="app.status.error"
                        color="#fff"
                        borderWidth="1px"
                        borderStyle="solid"
                        borderColor="app.status.error"
                        flexShrink={0}
                      >
                        <Icon name="warning" size={12} />
                        {t("listProduction")}
                      </chakra.span>
                    )}
                    {selectedProfile.read_only && (
                      <chakra.span
                        title={t("listReadOnlyTitle")}
                        display="inline-flex"
                        alignItems="center"
                        gap="4px"
                        fontSize="xs"
                        textTransform="uppercase"
                        letterSpacing="0.06em"
                        fontWeight={700}
                        px="8px"
                        py="2px"
                        borderRadius="pill"
                        bg="var(--status-info, var(--bg-muted))"
                        color="app.text"
                        borderWidth="1px"
                        borderStyle="solid"
                        borderColor="app.borderStrong"
                        flexShrink={0}
                      >
                        <Icon name="key" size={12} />
                        {t("listReadOnly")}
                      </chakra.span>
                    )}
                    <chakra.span
                      color="app.textMuted"
                      fontSize="sm"
                      overflow="hidden"
                      textOverflow="ellipsis"
                      whiteSpace="nowrap"
                    >
                      {selectedProfile.driver === "sqlite"
                        ? selectedProfile.file_path ?? ""
                        : `${selectedProfile.user}@${selectedProfile.host}:${selectedProfile.port}${selectedProfile.database ? `/${selectedProfile.database}` : ""}`}
                    </chakra.span>
                  </>
                ) : (
                  <>
                    <StatusDot variant="idle" />
                    <chakra.span color="app.textMuted" fontSize="sm">{t("appDisconnected")}</chakra.span>
                  </>
                )}
              </Flex>
              <Box flex="1" />
              {sessionId && (
                <Button variant="danger" onClick={handleDisconnect}>
                  {t("appDisconnect")}
                </Button>
              )}
            </Flex>

            {sessionId ? (
              panes.length === 0 ? (
                <Flex direction="column" flex="1" overflow="hidden">
                  <PaneEmpty>
                    <EmptyState
                      icon="query"
                      title={t("tabsEmptyTitle")}
                      description={t("tabsEmpty")}
                      action={{ label: t("tabsNewQuery"), onClick: () => handleNewTab() }}
                    />
                  </PaneEmpty>
                </Flex>
              ) : panes.length === 1 ? (
                renderPane(panes[0])
              ) : (
                <Splitter
                  direction="row"
                  storageKey="noobdb.split.panes"
                  defaultFraction={0.5}
                  minSize={220}
                  ariaLabel={t("splitterPanesAria")}
                  first={renderPane(panes[0])}
                  second={renderPane(panes[1])}
                />
              )
            ) : (
              <Flex direction="column" flex="1" overflow="hidden">
                <PaneEmpty>
                  <EmptyState
                    icon="database"
                    title={t("notConnectedTitle")}
                    description={t("editorHintDisabled")}
                  />
                </PaneEmpty>
              </Flex>
            )}
          </>
        )}
        </Suspense>

        {!statusDismissed && status.kind !== "idle" && (() => {
          const tone = statusTone(status);
          const toneColor =
            tone === "running"
              ? "app.accent"
              : tone === "success"
                ? "app.status.success"
                : tone === "error"
                  ? "app.status.error"
                  : undefined;
          return (
            <Flex
              align="center"
              gap="var(--space-2)"
              px="14px"
              py="5px"
              bg={tone === "error" ? "app.bgError" : "app.surfaceMuted"}
              borderTopWidth="1px"
              borderTopColor="app.border"
              borderLeftWidth="3px"
              borderLeftStyle="solid"
              borderLeftColor={toneColor ?? "transparent"}
              fontSize="sm"
              color={tone === "error" ? "app.textError" : "app.textSecondary"}
            >
              <chakra.span
                aria-hidden
                display="inline-flex"
                alignItems="center"
                flexShrink="0"
                color={toneColor}
                css={{ "&:empty": { display: "none" }, "& .icon-svg": { width: "14px", height: "14px" } }}
              >
                {tone === "running" ? (
                  <Spinner size={13} />
                ) : tone === "success" ? (
                  <Icon name="check" />
                ) : tone === "error" ? (
                  <Icon name="warning" />
                ) : null}
              </chakra.span>
              <Box flex="1" minW="0">
                {statusHintKey && !hintDismissed ? (
                  <Flex direction="column" gap="3px">
                    <Flex align="baseline" gap="6px">
                      <chakra.span
                        flex="none"
                        fontWeight={600}
                        fontSize="xs"
                        px="6px"
                        py="1px"
                        borderRadius="sm"
                        bg="app.textError"
                        color="app.bgError"
                      >
                        {t("errorHintLabel")}
                      </chakra.span>
                      <chakra.span flex="1" minW="0" lineHeight="1.45">{t(statusHintKey)}</chakra.span>
                      <chakra.button
                        type="button"
                        flexShrink="0"
                        alignSelf="flex-start"
                        display="inline-flex"
                        alignItems="center"
                        justifyContent="center"
                        w="18px"
                        h="18px"
                        p="0"
                        border="none"
                        bg="transparent"
                        color="currentColor"
                        borderRadius="sm"
                        lineHeight="1"
                        cursor="pointer"
                        opacity={0.7}
                        _hover={{ opacity: 1, bg: "app.hover" }}
                        css={{ "& .icon-svg": { width: "13px", height: "13px" } }}
                        onClick={() => setHintDismissed(true)}
                        title={t("errorHintDismiss")}
                        aria-label={t("errorHintDismiss")}
                      >
                        <Icon name="close" />
                      </chakra.button>
                    </Flex>
                    <chakra.details
                      css={{ "& summary": { cursor: "pointer", opacity: 0.85, fontSize: "var(--text-xs)", width: "fit-content" } }}
                    >
                      <summary>{t("errorHintShowOriginal")}</summary>
                      <chakra.span
                        display="block"
                        mt="3px"
                        whiteSpace="pre-wrap"
                        wordBreak="break-word"
                        fontFamily="var(--font-mono)"
                        fontSize="xs"
                        opacity={0.9}
                      >
                        {statusText}
                      </chakra.span>
                    </chakra.details>
                  </Flex>
                ) : (
                  statusText
                )}
              </Box>
              {reconnectProfile && tone === "error" && (
                <chakra.button
                  type="button"
                  flexShrink="0"
                  display="inline-flex"
                  alignItems="center"
                  gap="5px"
                  px="10px"
                  py="3px"
                  fontSize="xs"
                  fontWeight={500}
                  color="#fff"
                  bg="app.status.error"
                  border="none"
                  borderRadius="sm"
                  cursor="pointer"
                  css={{
                    "&:hover:not(:disabled)": { background: "color-mix(in srgb, var(--status-error) 85%, #000)" },
                    "&:disabled": { opacity: 0.7, cursor: "default" },
                    "& .icon-svg": { width: "13px", height: "13px" },
                  }}
                  onClick={() => handleConnect(reconnectProfile)}
                  disabled={connectingId === reconnectProfile.id}
                  title={t("statusReconnectTitle", { name: reconnectProfile.name })}
                >
                  {connectingId === reconnectProfile.id ? (
                    <Spinner size={12} />
                  ) : (
                    <Icon name="refresh" />
                  )}
                  {t("statusReconnect")}
                </chakra.button>
              )}
              {tone === "error" && (
                <chakra.button
                  type="button"
                  flexShrink="0"
                  display="inline-flex"
                  alignItems="center"
                  justifyContent="center"
                  w="20px"
                  h="20px"
                  p="0"
                  border="none"
                  bg="transparent"
                  color="currentColor"
                  borderRadius="sm"
                  lineHeight="1"
                  cursor="pointer"
                  opacity={0.7}
                  _hover={{ opacity: 1, bg: "app.hover" }}
                  css={{ "& .icon-svg": { width: "14px", height: "14px" } }}
                  onClick={() => setStatusDismissed(true)}
                  title={t("statusDismiss")}
                  aria-label={t("statusDismiss")}
                >
                  <Icon name="close" />
                </chakra.button>
              )}
            </Flex>
          );
        })()}
      </Flex>

      <Suspense fallback={null}>
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
          writeApproval={pendingDangerous.writeApproval}
          onConfirm={handleConfirmDangerous}
          onCancel={handleCancelDangerous}
        />
      )}
      </Suspense>

      {tabMenu && (() => {
        const owner = panes.find((p) => p.tabIds.includes(tabMenu.tabId));
        // Moving is only possible when it won't leave a single pane empty.
        const canMove = !!owner && (panes.length > 1 || owner.tabIds.length > 1);
        const items: ContextMenuEntry[] = [
          {
            label: t("tabMoveOtherPane"),
            onSelect: () => moveTabToOtherPane(tabMenu.tabId),
            disabled: !canMove,
            title: canMove ? undefined : t("tabMoveOtherPaneDisabled"),
          },
          { separator: true },
          { label: t("tabClose"), onSelect: () => handleCloseTab(tabMenu.tabId), danger: true },
        ];
        return (
          <ContextMenu x={tabMenu.x} y={tabMenu.y} items={items} onClose={() => setTabMenu(null)} />
        );
      })()}
      </Grid>
      {confirmDialogElement}
    </Flex>
  );
}
