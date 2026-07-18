import { forwardRef, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ComponentProps, type CSSProperties, type ReactNode } from "react";
import { Box, Flex, Grid, chakra } from "@chakra-ui/react";
import { AnimatePresence, motion } from "motion/react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openFileDialog, save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import {
  api,
  CellValue,
  Column,
  ConnectionProfile,
  DriverKind,
  ForeignKey,
  type ProfileImportStrategy,
  PreviewResult,
  QueryResult,
  Snippet,
  TableColumnInfo,
  TableSchema,
  listenConnectProgress,
  listenPreviewStream,
  listenQueryStream,
} from "./api/tauri";
import { cancelledPartialResult, timeoutPartialResult } from "./streamPartialResult";
// Pure helper (not the lazy dialog) so the re-trust flow can pin the approved
// fingerprint without pulling the dialog component into the main bundle (#682).
import { parseHostKeyFingerprints } from "./components/hostKeyFingerprints";
import {
  applyEditsToRows,
  buildDeleteStatements,
  buildInsertStatements,
  buildUpdateStatements,
  countEditedCells,
  countEditedRows,
  resolvePkIndices,
  type PendingEdits,
  type PendingInsertRow,
} from "./components/cellEdit";
import { type BulkEditTarget } from "./components/bulkEdit";
import { ConnectionList, type ConnectionListHandle } from "./components/ConnectionList";
import { copyToClipboard } from "./components/clipboard";
import {
  buildDropTableSql,
  buildRenameTableSql,
  buildTruncateSql,
} from "./components/tableMaintenance";
import type { MaintenanceCommand } from "./components/maintenanceCommands";
import { quoteIdentFor } from "./components/sqlDialect";
import { EmptyState } from "./components/EmptyState";
import { DisconnectedIllustration, ProductionWarningIllustration } from "./components/illustrations";
import { WelcomeView } from "./components/WelcomeView";
import { OnboardingTour } from "./components/OnboardingTour";
import * as onboarding from "./onboarding";
import { Spinner } from "./components/Spinner";
import { useToast } from "./components/Toast";
import { SnippetList } from "./components/SnippetList";
import { HistoryList } from "./components/HistoryList";
import type { QueryEditorHandle, SchemaTable } from "./components/QueryEditor";
import type { QueryBuilderSnapshot } from "./components/QueryBuilder";
import type { ResultGridHandle } from "./components/ResultGrid";
import { TabBar } from "./components/TabBar";
import { TitleBar } from "./components/TitleBar";
import { ProductionBadge, ProfileColorChip } from "./components/ProfileBadge";
import { SplashScreen } from "./components/SplashScreen";
import { Splitter } from "./components/Splitter";
import { Icon } from "./components/Icon";
import { Button } from "./components/ui";
import { LoadingButton } from "./components/LoadingButton";
import { useConfirm } from "./components/ConfirmDialog";
import { ContextMenu, type ContextMenuEntry } from "./components/ContextMenu";
import { singleLine, type CommandItem } from "./components/commandPaletteSearch";

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
const TestDataModal = lazy(() =>
  import("./components/TestDataModal").then((m) => ({ default: m.TestDataModal })),
);
const PlanWatchPanel = lazy(() =>
  import("./components/PlanWatchPanel").then((m) => ({ default: m.PlanWatchPanel })),
);
const DumpModal = lazy(() =>
  import("./components/DumpModal").then((m) => ({ default: m.DumpModal })),
);
const SchemaExportModal = lazy(() =>
  import("./components/SchemaExportModal").then((m) => ({ default: m.SchemaExportModal })),
);
const ProfileImportDialog = lazy(() =>
  import("./components/ProfileImportDialog").then((m) => ({ default: m.ProfileImportDialog })),
);
const PaginationBar = lazy(() =>
  import("./components/PaginationBar").then((m) => ({ default: m.PaginationBar })),
);
const ObjectSearchModal = lazy(() =>
  import("./components/ObjectSearchModal").then((m) => ({ default: m.ObjectSearchModal })),
);
const CreateTableModal = lazy(() =>
  import("./components/CreateTableModal").then((m) => ({ default: m.CreateTableModal })),
);
const RenameTableDialog = lazy(() =>
  import("./components/RenameTableDialog").then((m) => ({ default: m.RenameTableDialog })),
);
const HostKeyMismatchDialog = lazy(() =>
  import("./components/HostKeyMismatchDialog").then((m) => ({ default: m.HostKeyMismatchDialog })),
);
const RowInsertModal = lazy(() =>
  import("./components/RowInsertModal").then((m) => ({ default: m.RowInsertModal })),
);
const ChartView = lazy(() =>
  import("./components/ChartView").then((m) => ({ default: m.ChartView })),
);
const PivotView = lazy(() =>
  import("./components/PivotView").then((m) => ({ default: m.PivotView })),
);
const BatchResultsView = lazy(() =>
  import("./components/BatchResultsView").then((m) => ({ default: m.BatchResultsView })),
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
const ERDiagramView = lazy(() =>
  import("./components/ERDiagramView").then((m) => ({ default: m.ERDiagramView })),
);
const PinnedComparisonView = lazy(() =>
  import("./components/PinnedComparisonView").then((m) => ({ default: m.PinnedComparisonView })),
);
const ProcessListPanel = lazy(() =>
  import("./components/ProcessListPanel").then((m) => ({ default: m.ProcessListPanel })),
);
const TableStatisticsPanel = lazy(() =>
  import("./components/TableStatisticsPanel").then((m) => ({ default: m.TableStatisticsPanel })),
);
const ServerInfoPanel = lazy(() =>
  import("./components/ServerInfoPanel").then((m) => ({ default: m.ServerInfoPanel })),
);
const QueryInspectorPanel = lazy(() =>
  import("./components/QueryInspectorPanel").then((m) => ({ default: m.QueryInspectorPanel })),
);
const DangerousQueryDialog = lazy(() =>
  import("./components/DangerousQueryDialog").then((m) => ({ default: m.DangerousQueryDialog })),
);
const CommandPalette = lazy(() =>
  import("./components/CommandPalette").then((m) => ({ default: m.CommandPalette })),
);
const ShortcutCheatSheet = lazy(() =>
  import("./components/ShortcutCheatSheet").then((m) => ({ default: m.ShortcutCheatSheet })),
);
const ParameterInputModal = lazy(() =>
  import("./components/ParameterInputModal").then((m) => ({ default: m.ParameterInputModal })),
);
import {
  analyzeDangerousSql,
  isReadOnlySql,
  isSchemaMutatingSql,
  type DangerFinding,
} from "./dangerousSql";
import { resolveTypedConfirmTarget } from "./typeToConfirm";
import { extractQueryParams, substituteQueryParams, type ParamType } from "./queryParams";
import { resolveErrorHint } from "./errorHints";
import { errorKindOf } from "./api/tauri";
import {
  backoffDelayMs,
  shouldAutoReconnect,
  type ConnectionStatus,
} from "./reconnect";
import { t as translate, useT, useLocale } from "./i18n";
import {
  isAppWindowFocused,
  registerNotificationClickFocus,
  sendQueryNotification,
} from "./notifications";
import { checkForAppUpdate } from "./updater";
import { confirmAndInstallUpdate } from "./components/updatePrompt";
import {
  firstLineForNotification,
  shouldNotifyQueryCompletion,
  type QueryNotificationKind,
} from "./queryNotify";
import { incomingForeignKeys } from "./fkNavigation";
import { addPinned, type PinnedResult } from "./pinnedCompare";
import { transitions, variants } from "./motion";
import { resolveShortcutBindings } from "./shortcuts";
import { comboMatchesEvent } from "./shortcutKeys";
import { parseLayoutMode, toggleLayoutMode, type LayoutMode } from "./components/paneLayout";
import {
  useSettings,
  getSettings,
  setAutoRefreshDefaultSecs,
  BASE_FONT_SIZE_PX,
  monoFontStack,
  uiFontStack,
  themePresetDataTheme,
  type TabRestoreMode,
} from "./settings";
import { ThemeTransition } from "./components/ThemeTransition";
import { accentVars } from "./accent";
import {
  clearPersistedTabs,
  loadPersistedWorkspace,
  savePersistedWorkspace,
  type PersistedTab,
  type PersistedWorkspace,
} from "./tabPersistence";
import { reorderIfPermutation } from "./tabReorder";
import { formatElapsed } from "./queryRunState";
import {
  buildPageSql,
  clampPage,
  estimatedTotalPages,
} from "./pagination";
import {
  isMultiStatement,
  splitSqlStatements,
  type BatchStatementResult,
} from "./sqlScript";
import {
  EMPTY_QUICK_ACCESS,
  loadQuickAccess,
  recordRecent as recordRecentTable,
  saveQuickAccess,
  toggleFavorite as toggleFavoriteTable,
  type QuickAccessState,
} from "./tableQuickAccess";
import {
  EMPTY_PLAN_WATCH,
  isWatched,
  loadPlanWatch,
  newGenerationId,
  recordGeneration,
  removeWatch,
  savePlanWatch,
  toggleWatch,
  watchedIds,
  type PlanWatchState,
} from "./planWatch";

type Theme = "light" | "dark";

const THEME_STORAGE_KEY = "noobdb.theme";
// エディタ/結果のレイアウトモード (#618) の永続化キー。ワークスペース単位で 1 つ。
const LAYOUT_MODE_STORAGE_KEY = "noobdb.layout.mode";

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
  | { kind: "literal"; text: string; error?: boolean; errorKind?: string | null }
  // `errorKind` carries the structured `AppError.kind` (#683) so the hint/
  // illustration resolver can classify reliably instead of pattern-matching the
  // message text. Optional: paths that only have a plain string omit it and the
  // resolver falls back to message matching.
  | { kind: "key"; key: Parameters<ReturnType<typeof useT>>[0]; vars?: Record<string, string | number>; error?: boolean; errorKind?: string | null };

// エラーは重大度別に区別する。`critical` は接続喪失など回復に再接続を要する
// 致命的状態 (赤、目立つバッジ)、`warning` はタイムアウトなど接続は生きている軽度
// 障害 (黄)、`error` は SQL 構文エラー・制約違反など個別クエリの失敗 (赤)。
type StatusTone = "running" | "success" | "error" | "warning" | "critical" | "info";

// Status keys that represent an in-progress operation (spinner + accent border).
const RUNNING_STATUS_KEYS = new Set([
  "statusConnecting",
  "statusRunningQuery",
  "statusRunningPreview",
  "statusApplyingEdits",
]);

// 致命的 (critical): セッションが使えなくなり再接続が必要な状態。フッターに残し、
// 「重大」バッジ + 再接続導線で対処を促す。
const CRITICAL_STATUS_KEYS = new Set(["statusConnectionLost"]);

// 警告 (warning): 接続は維持されており、設定変更や再試行で回復しうる軽度の障害。
const WARNING_STATUS_KEYS = new Set(["statusQueryTimeout", "statusQueryTimeoutPartial"]);

// Maps a status to a tone for the footer's icon + colored left border.
// Derived from the existing `error` flag and known keys, so call sites don't
// each have to declare a severity.
function statusTone(s: Status): StatusTone {
  if (s.kind === "idle") return "info";
  if (s.kind === "key") {
    if (RUNNING_STATUS_KEYS.has(s.key)) return "running";
    // critical / warning は error フラグの有無より優先して重大度を確定させる。
    if (CRITICAL_STATUS_KEYS.has(s.key)) return "critical";
    if (WARNING_STATUS_KEYS.has(s.key)) return "warning";
    if (s.error) return "error";
    if (s.key === "appDisconnected") return "info";
    return "success";
  }
  if (s.error) return "error";
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
      p="6"
      textAlign="center"
    >
      {children}
    </Flex>
  );
}

/** トップバーの密なアイコン専用ボタン。`Button` の既定 padding を詰めて
 *  正方形に近い当たり判定にし、アイコン文字のみを中央配置する。 */
function IconButton(props: ComponentProps<typeof Button>) {
  return <Button px="2" py="1" minW="28px" lineHeight="1" fontSize="base" {...props} />;
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
 * サイドバー上部の Connections / Snippets / History 切替タブ。
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
      px="2"
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

// EXPLAIN の方言別プレフィックス。MySQL/PostgreSQL は JSON プラン、SQLite は
// `EXPLAIN QUERY PLAN` (行ベース)。ExplainViewer が driver でパーサを切り替える。
function explainPrefixFor(driver: string | undefined): string {
  if (driver === "postgres") return "EXPLAIN (FORMAT JSON) ";
  if (driver === "sqlite") return "EXPLAIN QUERY PLAN ";
  return "EXPLAIN FORMAT=JSON ";
}

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
  /**
   * True while the active stream is a Dry Run preview (a subset of `streaming`).
   * Lets the QueryEditor flip the Preview badge into its `running` state without
   * also flipping the Run badge.
   */
  previewStreaming: boolean;
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
   * プレビュー開始前の `paginatable` の退避値 (#F3)。プレビュー中は `paginatable`
   * を一時的に null にするため、完了/キャンセル/破棄のいずれの終了パスでもここから
   * 復元する。`undefined` は「プレビュー未実行、または復元済み」を意味する。
   */
  previewPrevPaginatable?: string | null;
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
   * 現在のページ番号 (1 始まり)。table タブのページネーション用。
   * 未指定は 1 ページ目とみなす。
   */
  page?: number;
  /**
   * ページサイズ (1 ページの行数)。table タブのページネーション用。未指定なら
   * `previewRowLimit` (= テーブルを開いたときの表示件数) を使う。
   */
  pageSize?: number;
  /**
   * テーブルの行数推定 (総ページ数の目安算出用)。table タブを開いたときに
   * `table_row_estimates` から取得して設定する。未取得/不明なら null/undefined。
   */
  rowEstimateTotal?: number | null;
  /** Non-null when the last query run failed (cleared on the next run). */
  queryError: string | null;
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
  /** Previous pendingEdits snapshots for Ctrl+Z undo. In-memory only (not persisted). */
  editUndoStack: PendingEdits[];
  /** Re-applicable snapshots for Ctrl+Shift+Z redo. Cleared when a new edit is made. */
  editRedoStack: PendingEdits[];
  /** 削除予定の行: rowEditKey のリスト。Apply で DELETE される。 */
  pendingDeletes?: string[];
  /** 追加予定の新規行: 各要素は colIdx→値。Apply で INSERT される。 */
  pendingInserts?: PendingInsertRow[];
  /** チャートビューを表示中か。結果グリッドの代わりにチャートを描く。 */
  showChart?: boolean;
  /** ピボットビューを表示中か。結果グリッドの代わりにクロス集計表を描く (#661)。 */
  showPivot?: boolean;
  /** SQL スクリプトのバッチ実行の文ごとの結果。設定時は結果ビューに代えて表示。 */
  batchResults?: BatchStatementResult[];
  /** バッチ実行のスクリプト本文 (stop/continue 切替で再実行するため保持)。 */
  batchScript?: string;
  /** バッチ実行中フラグ。 */
  batchRunning?: boolean;
  /**
   * Wall-clock timestamp (ms) set each time an Apply edit completes successfully.
   * Passed to `ResultGrid` to trigger a brief success-flash animation. In-memory only.
   */
  lastEditAppliedAt?: number;
  /** True while the Apply Edits transaction is in flight for this tab. */
  applyingEdits?: boolean;
  /**
   * Most recent Query Builder inputs captured on its Run / Dry Run, restored
   * when the builder is reopened in this tab. Persisted alongside the tab
   * so it survives reconnects and app restarts; cleared only when the
   * tab itself is closed. Holds the latest single snapshot — no history.
   */
  builderSnapshot: QueryBuilderSnapshot | null;
  /**
   * Auto-refresh (scheduled re-execution) cadence in seconds, or null/undefined
   * when off. Only ever set for read-only `lastExecutedSql`; a manual write run
   * clears it. In-memory only (not persisted) so polling never resumes silently
   * after a restart.
   */
  autoRefreshSecs?: number | null;
  /** Wall-clock time (ms) of the last completed auto-refresh tick, for the badge. */
  autoRefreshLastRunAt?: number | null;
  /**
   * 結果差分ハイライト (#597) 用に保持する、前回実行時の結果行スナップショット。
   * 新しい実行のたびに「直前の結果行」を退避し、同一クエリの再実行のときだけ
   * 今回結果との差分計算に使う。In-memory only。
   */
  prevResultRows?: CellValue[][] | null;
  /** `prevResultRows` を生成した SQL。今回 SQL と一致するときだけ差分を出す。 */
  prevResultSql?: string | null;
  /** 結果差分ハイライトのトグル (ON/OFF)。既定 OFF。In-memory only。 */
  diffHighlight?: boolean;
  /**
   * Set when the last run stopped before completing normally (user cancel or
   * query timeout), so `result.rows` holds only a partial result. Cleared on
   * the next run. Drives the partial-result badge in `ResultGrid` and the
   * export-confirmation warning (#685). `rows` is the row count reported by
   * the backend at the moment the stream stopped.
   */
  partialResult?: { reason: "cancelled" | "timeout"; rows: number } | null;
}

/**
 * One column of the split workspace. Tab *data* lives in the flat `tabs` array;
 * a pane only tracks which tab ids it holds (in display order) and which is
 * active. With a single pane the layout behaves exactly like the old single-tab
 * workspace; a second pane is added on demand for side-by-side viewing.
 */
interface PaneState {
  id: string;
  tabIds: string[];
  activeTabId: string | null;
}

/** Maximum number of undo/redo snapshots kept per tab. */
const EDIT_UNDO_LIMIT = 50;

let tabSeq = 0;
function newTabId(): string {
  tabSeq += 1;
  return `tab_${Date.now().toString(36)}_${tabSeq.toString(36)}`;
}

let connectAttemptSeq = 0;
/** A unique id per connection attempt so progress events / cancel target the
 *  right attempt (#684). */
function makeConnectAttemptId(): string {
  connectAttemptSeq += 1;
  return `conn_${Date.now().toString(36)}_${connectAttemptSeq.toString(36)}`;
}

/** Map a backend connect-phase label (#684) to its localized i18n key. Unknown
 *  labels fall back to the generic "connecting" text. */
function connectPhaseI18nKey(
  phase: string,
): "connectPhasePreparing" | "connectPhaseTunnelConnecting" | "connectPhaseTunnelAuthenticating" | "connectPhaseDbConnecting" {
  switch (phase) {
    case "tunnel_connecting":
      return "connectPhaseTunnelConnecting";
    case "tunnel_authenticating":
      return "connectPhaseTunnelAuthenticating";
    case "db_connecting":
      return "connectPhaseDbConnecting";
    default:
      return "connectPhasePreparing";
  }
}

let paneSeq = 0;
function newPaneId(): string {
  paneSeq += 1;
  return `pane_${Date.now().toString(36)}_${paneSeq.toString(36)}`;
}

function newStreamId(tabId: string): string {
  return `${tabId}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function qualifiedTableSql(driver: string, database: string, table: string): string {
  // SQLite has a single attached namespace ("main"); leaving the
  // db.table qualification off keeps the generated SELECT portable.
  if (driver === "sqlite") return `SELECT * FROM ${quoteIdentFor(driver, table)}`;
  return `SELECT * FROM ${quoteIdentFor(driver, database)}.${quoteIdentFor(driver, table)}`;
}

// SQL that returns a table's definition, or null for drivers without a
// single-statement form (Postgres). MySQL uses SHOW CREATE TABLE; SQLite reads
// the original DDL out of sqlite_master.
function tableDefinitionSql(driver: string, database: string, table: string): string | null {
  if (driver === "mysql") {
    return `SHOW CREATE TABLE ${quoteIdentFor(driver, database)}.${quoteIdentFor(driver, table)}`;
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

/**
 * 複数結果タブで新しい結果タブのタイトルを SQL から導出する。先頭の
 * 1 行を短く切り詰める。空なら既定の無題タイトル。
 */
function deriveResultTabTitle(sql: string): string {
  const firstLine = sql.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  if (!firstLine) return translate("tabUntitledQuery");
  return firstLine.length > 28 ? `${firstLine.slice(0, 27)}…` : firstLine;
}

/** 共通の初期状態でタブを生成する。呼び出し側は必要なフィールドだけ上書きする。 */
function makeTab(kind: TabKind, title: string, sql: string): Tab {
  return {
    id: newTabId(),
    kind,
    title,
    sql,
    lastExecutedSql: sql,
    result: null,
    preview: null,
    schemaTable: null,
    streaming: false,
    previewStreaming: false,
    previewRowLimit: getSettings().defaultDisplayCount,
    paginatable: null,
    autoLimitApplied: null,
    autoLimitSql: null,
    loadingMore: false,
    canLoadMore: false,
    queryError: null,
    tableColumns: null,
    pendingEdits: {},
    editUndoStack: [],
    editRedoStack: [],
    builderSnapshot: null,
  };
}

function makeQueryTab(): Tab {
  // 新規クエリタブは空のエディタで開く。
  return makeTab("query", translate("tabUntitledQuery"), "");
}

function explainTabTitle(sql: string): string {
  const oneLine = sql.replace(/\s+/g, " ").trim();
  const base = translate("tabExplainTitle");
  if (!oneLine) return base;
  const snippet = oneLine.length > 28 ? `${oneLine.slice(0, 28)}…` : oneLine;
  return `${base}: ${snippet}`;
}

function makeExplainTab(sql: string): Tab {
  return makeTab("explain", explainTabTitle(sql), sql);
}

/** ドラッグ&ドロップで受理するファイル種別の判定結果。 */
type DroppedKind = "sql" | "csv" | "unsupported";

/** パスの拡張子 (小文字、ドットなし)。拡張子が無ければ空文字。 */
function fileExtension(path: string): string {
  const base = path.split(/[/\\]/).pop() ?? path;
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** パスのファイル名部分 (ディレクトリを除く)。タブのタイトルに使う。 */
function fileBaseName(path: string): string {
  return path.split(/[/\\]/).pop() || path;
}

/** ドロップされた 1 ファイルの種別を拡張子から判定する。 */
function classifyDroppedFile(path: string): DroppedKind {
  const ext = fileExtension(path);
  if (ext === "sql" || ext === "txt") return "sql";
  if (ext === "csv" || ext === "tsv") return "csv";
  return "unsupported";
}

/**
 * ドラッグオーバー中のオーバーレイ表示用に、ドロップ予定ファイル群を 1 つの
 * フィードバック状態へ畳み込む。受理できるファイルが 1 つでもあれば
 * `accept`、種別が混在していれば `mixed`、すべて非対応なら `reject`。
 */
type DragFeedback = { accept: boolean; kind: "sql" | "csv" | "mixed" | "reject" };

function dragFeedbackFor(paths: string[]): DragFeedback {
  const kinds = new Set(paths.map(classifyDroppedFile));
  const hasSql = kinds.has("sql");
  const hasCsv = kinds.has("csv");
  if (!hasSql && !hasCsv) return { accept: false, kind: "reject" };
  if (hasSql && hasCsv) return { accept: true, kind: "mixed" };
  return { accept: true, kind: hasSql ? "sql" : "csv" };
}

function toPersistedTab(tab: Tab): PersistedTab {
  const out: PersistedTab = { kind: tab.kind, title: tab.title, sql: tab.sql };
  if (tab.database) out.database = tab.database;
  if (tab.table) out.table = tab.table;
  // Carry the Query Builder snapshot through so the inputs come back on
  // the next reconnect — closing the tab still drops it because the tab is
  // removed from the persisted list before the next save.
  if (tab.builderSnapshot) out.builderSnapshot = tab.builderSnapshot;
  return out;
}

/**
 * Restore-tabs ゲート。`mode === "ask"` のときだけ呼び出し側から渡された
 * `askUser()` (Promise<boolean>) で確認する。同期的な `window.confirm` を
 * 排除するため Promise を返す形にしている。
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

// Apply 完了後、実際に DB へ送信・コミットされたセル編集 (`applied`) だけを
// `current` の pendingEdits から取り除く。Apply の往復中に追加/上書きされた
// 編集 (= `applied` に無いか、値が食い違うもの) はまだ DB 未送信なので保持し、
// 「未送信の編集が黙ってコミット済み扱いになる」事故 (#F2) を防ぐ。
function pendingEditsAfterApply(current: PendingEdits, applied: PendingEdits): PendingEdits {
  const next: PendingEdits = {};
  for (const rowKey of Object.keys(current)) {
    const currentRow = current[rowKey];
    const appliedRow = applied[rowKey];
    if (!appliedRow) {
      next[rowKey] = currentRow;
      continue;
    }
    const remainingRow: Record<number, string> = {};
    for (const colKey of Object.keys(currentRow)) {
      const colIdx = Number(colKey);
      // 送信した値のままなら反映済みなので削除。Apply 中にさらに書き換えられて
      // いれば (値が食い違う)、まだ未送信の新しい編集として残す。
      if (appliedRow[colIdx] !== undefined && currentRow[colIdx] === appliedRow[colIdx]) {
        continue;
      }
      remainingRow[colIdx] = currentRow[colIdx];
    }
    if (Object.keys(remainingRow).length > 0) next[rowKey] = remainingRow;
  }
  return next;
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
  // `t` 自体は識別子が安定なので、ロケール切替でコマンドパレット候補の文言メモが
  // 再計算されるよう、現在のロケールを依存に含めるために購読する。
  const locale = useLocale();
  const toast = useToast();
  // テーマに追従するカスタム確認ダイアログ。`window.confirm()` の代替で、
  // `await confirm({...})` の形で同期感覚で呼べる。
  const { confirm, dialog: confirmDialogElement } = useConfirm();
  const [theme, setTheme] = useState<Theme>(readInitialTheme);
  const settings = useSettings();
  // 解決済みショートカットバインド (既定 + ユーザ上書き、#557)。グローバルキー
  // ハンドラは `bindingsRef` 経由で参照し、エディタには `editorBindings` で渡す。
  const shortcutBindings = useMemo(
    () => resolveShortcutBindings(settings.shortcutOverrides),
    [settings.shortcutOverrides],
  );
  const bindingsRef = useRef(shortcutBindings);
  bindingsRef.current = shortcutBindings;
  const editorBindings = useMemo(
    () => ({
      run: shortcutBindings.run,
      runStatement: shortcutBindings.runStatement,
      preview: shortcutBindings.preview,
      format: shortcutBindings.format,
    }),
    [
      shortcutBindings.run,
      shortcutBindings.runStatement,
      shortcutBindings.preview,
      shortcutBindings.format,
    ],
  );
  const [showSettings, setShowSettings] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  // 初回起動オンボーディングツアー (#599)。ウェルカム画面の「はじめかたを見る」
  // からの手動起動、および新規ユーザ (プロファイル 0 件・未表示) への自動起動の
  // 両方でこのフラグを立てる。表示済みフラグの永続化は閉じるときに行う。
  const [showTour, setShowTour] = useState(false);
  const [showCompare, setShowCompare] = useState(false);
  const [showErd, setShowErd] = useState(false);
  // ピン留め結果の比較ビュー (#622)。保持はメモリのみ・上限あり (addPinned)。
  const [showCompareResults, setShowCompareResults] = useState(false);
  const [pinnedResults, setPinnedResults] = useState<PinnedResult[]>([]);
  // プロセスモニタパネル (processlist / pg_stat_activity + KILL) の開閉。
  const [showProcesses, setShowProcesses] = useState(false);
  // サーバ情報パネル (バージョン・設定変数) の開閉。#563。
  const [showServerInfo, setShowServerInfo] = useState(false);
  // ライブクエリ・インスペクタ (ライブテール + digest 集計) の開閉。#746。
  const [showQueryInspector, setShowQueryInspector] = useState(false);
  // サイズ・統計ダッシュボードの対象データベース (null = 非表示)。#562。
  const [sizesTarget, setSizesTarget] = useState<string | null>(null);
  const showSizes = sizesTarget !== null;
  // コマンドパレット (Cmd/Ctrl+K) の開閉。接続前でも開けるよう、他ビューの
  // 状態には依存させない。
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  // スキーマ横断のグローバルオブジェクト検索の開閉。
  const [showObjectSearch, setShowObjectSearch] = useState(false);
  // `?` キーで開くショートカット チートシートの開閉。
  const [showCheatSheet, setShowCheatSheet] = useState(false);
  // エディタ/結果のレイアウトモード (#618)。`result` は結果パネルの全画面化
  // (Cmd/Ctrl+Shift+M / 結果ツールバーのトグル / Esc)、`editor` はエディタ集中表示
  // (Cmd/Ctrl+Shift+E / エディタツールバーのトグル / Esc)。フォーカス中ペインの
  // アクティブタブにのみ適用する。ワークスペース単位で localStorage に永続化し、
  // 再起動でも復元する (タブ ID は再起動を跨いで安定しないため、タブ個別ではなく
  // ワークスペース全体のモードとして保持する — 既定スプリット比率と同じ方針)。
  const [layoutMode, setLayoutMode] = useState<LayoutMode>(() => {
    try {
      return parseLayoutMode(localStorage.getItem(LAYOUT_MODE_STORAGE_KEY));
    } catch {
      return "normal";
    }
  });
  useEffect(() => {
    try {
      if (layoutMode === "normal") localStorage.removeItem(LAYOUT_MODE_STORAGE_KEY);
      else localStorage.setItem(LAYOUT_MODE_STORAGE_KEY, layoutMode);
    } catch {
      // ignore (private mode / quota)
    }
  }, [layoutMode]);

  // data-theme はテーマプリセットと light/dark トグルから合成する。
  // THEME_STORAGE_KEY には light/dark のみ保存する。
  const dataTheme = themePresetDataTheme(settings.themePreset, theme);
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", dataTheme);
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [dataTheme, theme]);

  useEffect(() => {
    const colors = settings.syntaxColors[theme];
    const root = document.documentElement;
    for (const [key, val] of Object.entries(colors)) {
      root.style.setProperty(`--syntax-${key}`, val);
    }
    root.style.setProperty("--preview-highlight", settings.previewHighlight[theme]);
    root.style.setProperty("--font-scale", String(settings.fontSizePx / BASE_FONT_SIZE_PX));

    // フォントファミリ: 設定があれば共有フォールバック付きのスタックを
    // --font-mono / --font-sans に注入し、未指定なら App.css の既定スタックへ戻す。
    const monoStack = monoFontStack(settings.monoFontFamily);
    if (monoStack) root.style.setProperty("--font-mono", monoStack);
    else root.style.removeProperty("--font-mono");
    const sansStack = uiFontStack(settings.uiFontFamily);
    if (sansStack) root.style.setProperty("--font-sans", sansStack);
    else root.style.removeProperty("--font-sans");

    // アクセント色: ユーザー指定があれば 3 つの CSS 変数を実行時に注入し、未指定
    // (null) なら inline 上書きを外して App.css のテーマ既定へ戻す。前景と
    // hover はテーマに応じて算出するため、theme 変更時も再実行される。
    if (settings.accentColor) {
      const v = accentVars(settings.accentColor, theme);
      root.style.setProperty("--accent", v.accent);
      root.style.setProperty("--accent-hover", v.accentHover);
      root.style.setProperty("--accent-text", v.accentText);
    } else {
      root.style.removeProperty("--accent");
      root.style.removeProperty("--accent-hover");
      root.style.removeProperty("--accent-text");
    }

    // 表示密度: data-density 属性で App.css の `--density-*` トークンを切り替える。
    root.setAttribute("data-density", settings.density);
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

  // 長時間クエリ完了時の OS 通知 (#707): クリックでウィンドウを前面化する購読を
  // アプリ起動時に一度だけ登録する。通知自体は runQueryInTab の onDone/onError で
  // 個別に判定・送信する (notifyQueryOutcome を参照)。
  useEffect(() => {
    registerNotificationClickFocus();
  }, []);

  // アプリ内自動更新 (#705): 起動時に一度だけ更新を確認する (設定でオフにできる)。
  // ベストエフォート — オフライン/マニフェスト取得失敗は静かに無視して起動を
  // ブロックしない。更新があればユーザ承認制の確認ダイアログを出し、承認された
  // ときだけダウンロード・適用・再起動する (勝手には再起動しない)。
  useEffect(() => {
    if (!getSettings().autoUpdateCheckEnabled) return;
    let cancelled = false;
    void (async () => {
      try {
        const update = await checkForAppUpdate();
        if (cancelled || !update) return;
        await confirmAndInstallUpdate(update, { t, toast, confirm });
      } catch {
        // ベストエフォート: 起動時チェックの失敗は静かに無視する。
      }
    })();
    return () => {
      cancelled = true;
    };
    // 起動時に一度だけ。t/toast/confirm はレンダー間で安定なので依存に含めない。
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  // 起動スプラッシュ (#619)。初回プロファイル読み込みが終わるまで true のまま。
  const [booted, setBooted] = useState(false);
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
  // お気に入り / 最近使ったテーブル。アクティブ接続プロファイル単位で
  // localStorage に永続化する。`handleOpenTable` がテーブルを開くたびに最近へ記録。
  const [quickAccess, setQuickAccess] = useState<QuickAccessState>(EMPTY_QUICK_ACCESS);
  const [historyReloadKey, setHistoryReloadKey] = useState(0);
  // 直近の実行クエリ (最新が先頭、連続重複は畳む)。QueryEditor の ↑/↓ 履歴
  // ナビゲーション用。接続プロファイル単位で読み込み、実行のたびに
  // `historyReloadKey` が増えるのを契機に再取得する。
  const [queryHistory, setQueryHistory] = useState<string[]>([]);
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
  const connectionListRef = useRef<ConnectionListHandle>(null);
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
  // Set when a connect fails with an SSH host-key mismatch (#682): drives the
  // recovery dialog that lets the user forget the stale key and reconnect.
  const [hostKeyMismatch, setHostKeyMismatch] = useState<
    { profile: ConnectionProfile; message: string } | null
  >(null);
  const [reTrustingHostKey, setReTrustingHostKey] = useState(false);
  // The in-flight connection attempt's id + current phase (#684). Set while a
  // connect is running so the footer can show which phase it's in and offer a
  // cancel button; cleared when the attempt settles.
  const [connectAttempt, setConnectAttempt] = useState<
    { id: string; phase: string } | null
  >(null);
  // 同時に開いている接続のレジストリ (#複数同時接続)。別プロファイルへ接続しても
  // 既存セッションを切断せず背景で生かしておき、クリックで即座に切り替えられる
  // ようにする。各エントリは生存中のバックエンドセッション 1 本に対応する。
  // 「アクティブな接続」もここに含まれる (active = この中の sessionId のいずれか)。
  type OpenConnection = { sessionId: string; profile: ConnectionProfile };
  const [openConnections, setOpenConnections] = useState<OpenConnection[]>([]);
  const openConnectionsRef = useRef<OpenConnection[]>([]);
  useEffect(() => { openConnectionsRef.current = openConnections; }, [openConnections]);
  // プロファイル id の集合 (ConnectionList の接続済み表示・切替/切断 UI 用)。
  const openProfileIds = useMemo(
    () => new Set(openConnections.map((c) => c.profile.id)),
    [openConnections],
  );
  // レジストリへの登録/差し替え (同一プロファイルは最新セッションで上書き)。
  const upsertOpenConnection = useCallback((sid: string, profile: ConnectionProfile) => {
    setOpenConnections((prev) => [
      ...prev.filter((c) => c.profile.id !== profile.id),
      { sessionId: sid, profile },
    ]);
  }, []);
  const removeOpenConnection = useCallback((profileId: string) => {
    setOpenConnections((prev) => prev.filter((c) => c.profile.id !== profileId));
  }, []);
  // ライブ接続の状態 (#600)。`reconnecting` の間は TitleBar に警告帯/バッジを出し、
  // 新規クエリは明示的に弾く。`connected` 以外への遷移は自動再接続オーケストレータが司る。
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("connected");
  const connectionStatusRef = useRef<ConnectionStatus>("connected");
  useEffect(() => { connectionStatusRef.current = connectionStatus; }, [connectionStatus]);
  // 自動再接続ループの二重起動防止と、手動操作 (接続/切断) でループを中断するフラグ。
  const reconnectingRef = useRef(false);
  const reconnectAbortRef = useRef(false);
  const [status, setStatus] = useState<Status>({ kind: "key", key: "appDisconnected" });
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
  // サイドバーヘッダの「プロファイル転送」ボタン直下に出すインポート/エクスポート
  // メニューのアンカー座標 (viewport coords)。ヘッダのボタン過密対策 (2 ボタン → 1)。
  const [profileTransferMenu, setProfileTransferMenu] = useState<{ x: number; y: number } | null>(null);
  // 同じくヘッダの「ツール」ボタン直下に出す補助ビュー (スキーマ比較 / ER 図 /
  // プロセス一覧) メニューのアンカー座標。3 ボタン → 1 ボタンへの集約。
  const [toolsMenu, setToolsMenu] = useState<{ x: number; y: number } | null>(null);
  const [importTarget, setImportTarget] = useState<{ database: string; table: string } | null>(null);
  // テストデータ生成ウィザード (#602) の対象テーブル。
  const [testDataTarget, setTestDataTarget] = useState<{ database: string; table: string } | null>(null);
  // ドラッグ&ドロップで .csv を落としたときに ImportModal へ渡す事前選択パス。
  const [importInitialPath, setImportInitialPath] = useState<string | null>(null);
  // ファイルがウィンドウ上にドラッグされている間の受理/拒否フィードバック。
  // null のときオーバーレイは出さない。
  const [dragFeedback, setDragFeedback] = useState<DragFeedback | null>(null);
  const [dumpTarget, setDumpTarget] = useState<string | null>(null);
  // AI 向けスキーマ Markdown エクスポートの対象 DB (null で閉じる)。
  const [schemaExportTarget, setSchemaExportTarget] = useState<string | null>(null);
  // プロファイルインポート: ファイル選択後、衝突解決ダイアログに渡すパス。
  const [importProfilesPath, setImportProfilesPath] = useState<string | null>(null);
  // CREATE TABLE ウィザード: 対象データベース。null で閉じる。
  const [createTableDb, setCreateTableDb] = useState<string | null>(null);
  // テーブル名変更: 対象。null で閉じる。
  const [renameTarget, setRenameTarget] = useState<{ database: string; table: string } | null>(null);
  // 新規行追加モーダル: 対象タブ ID。null で閉じる。
  const [rowInsertTabId, setRowInsertTabId] = useState<string | null>(null);
  // 明示トランザクション: 現在のセッションでトランザクションが有効か。実行経路の
  // 振り分けにコールバックから参照するため ref も併せ持つ。
  const [txActive, setTxActive] = useState(false);
  const txActiveRef = useRef(false);
  useEffect(() => { txActiveRef.current = txActive; }, [txActive]);
  // 接続が変わったらトランザクション状態はリセットする (切断で破棄される)。
  useEffect(() => { setTxActive(false); }, [sessionId]);
  // 切断時はセッション依存のモーダル状態をリセットする (検索モーダルが
  // 再接続時に意図せず再表示されるのを防ぐ)。
  useEffect(() => {
    if (!sessionId) {
      setShowObjectSearch(false);
      setCreateTableDb(null);
      setRenameTarget(null);
      setRowInsertTabId(null);
    }
  }, [sessionId]);
  // Whole-schema autocomplete snapshots, keyed by schemaCacheKey(session, db).
  // Fetched lazily per database and reused across tabs; invalidated after DDL
  // and dropped wholesale when the session changes.
  const [schemaCache, setSchemaCache] = useState<Record<string, TableSchema[]>>({});
  // Keys with a schemaOverview request in flight, so the fetch effect doesn't
  // fire a duplicate while one is pending.
  const schemaInFlightRef = useRef<Set<string>>(new Set());
  // Foreign keys per database (keyed by schemaCacheKey), used to offer reverse
  // FK navigation ("show rows referencing this row"). #621
  const [fkCache, setFkCache] = useState<Record<string, ForeignKey[]>>({});
  const fkInFlightRef = useRef<Set<string>>(new Set());
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
    /** True when this run should execute as a multi-statement batch. */
    batch?: boolean;
    /**
     * Set when this is an irreversible DROP/TRUNCATE on a production
     * connection: text the user must type to enable the confirm button
     * (#675). Null when the extra gate doesn't apply (non-production, or no
     * drop/truncate finding).
     */
    typedConfirmTarget: string | null;
  } | null>(null);

  // Pending {{variable}} parameter prompt. When the editor's SQL contains
  // placeholders, the run/preview/explain action is held here while the input
  // modal collects values; on submit the substituted SQL re-enters the same
  // action (so it still passes the danger gate). `mode` records which action
  // to resume.
  const [pendingParams, setPendingParams] = useState<{
    tab: Tab;
    sql: string;
    mode: "run" | "preview" | "explain";
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
  // ドラッグ&ドロップのイベント購読を毎タブ切替で貼り直さずに済むよう、
  // アクティブタブを ref でも参照できるようにする (ドロップ時の最新値読み取り用)。
  const activeTabRef = useRef<Tab | null>(activeTab);
  useEffect(() => { activeTabRef.current = activeTab; }, [activeTab]);

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
  // Wall-clock start of each tab's in-flight run (keyed by tab id). Read on
  // cancel to compute elapsed time for the completion notification (#707),
  // since `tab.result.elapsed_ms` stays 0 until the first row batch arrives.
  const runStartRef = useRef<Map<string, number>>(new Map());

  // Active auto-refresh (scheduled re-execution) timers, keyed by tab id. Held
  // in a ref so reconciling them doesn't churn on every streamed row batch.
  const autoRefreshTimers = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());

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

  // 戻り値は「実際にキャンセルできた場合の、中断時点で届いていた行数」(#685)。
  // ストリームが既に終わっていた/存在しなかった場合は null。呼び出し側 (例:
  // 明示的な停止ボタン `stopTab`) はこれを使って「N 行で停止」を表示できる。
  const cancelStreamForTab = useCallback(
    async (tabId: string): Promise<number | null> => {
      const sid = streamIdRef.current.get(tabId);
      detachStreamListener(tabId);
      if (!sid) return null;
      try {
        // バックエンドの AbortHandle 登録より先にここへ来ると (invoke の
        // ラウンドトリップ中)、cancel は空振り (cancelled: false) を返し旧
        // クエリが完走しうる (#F5)。結果を確認し、空振りのときだけ短い遅延を
        // 挟んでもう一度だけ試みる (ベストエフォートの緩和であり完全な解消
        // ではない)。
        const first = await api.cancelStream(sid);
        if (first.cancelled) return first.deliveredRows;
        await new Promise((resolve) => setTimeout(resolve, 50));
        const retry = await api.cancelStream(sid).catch(() => null);
        return retry?.cancelled ? retry.deliveredRows : null;
      } catch {
        return null;
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

  // Reorder tabs within a pane via drag/keyboard. `orderedIds` is the
  // pane's full tab-id list in its new order; we only accept a permutation of
  // the pane's current ids so a stale callback can't smuggle in foreign tabs.
  // Persistence is order-aware already (persistTabsForProfile maps tabIds in
  // order), so the new order is saved on the next flush.
  const reorderTabsInPane = useCallback((paneId: string, orderedIds: string[]) => {
    setPanes((prev) =>
      prev.map((p) => {
        if (p.id !== paneId) return p;
        // Accept only a true permutation of this pane's ids so a stale callback
        // can't smuggle in foreign tabs or drop one (see tabReorder.ts).
        const validated = reorderIfPermutation(p.tabIds, orderedIds);
        return validated ? { ...p, tabIds: validated } : p;
      }),
    );
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
    // 初回ロード: プロファイル取得とスプラッシュの最小表示時間 (350ms) を
    // 競わせ、両方終わったらスプラッシュを畳む。瞬間表示によるちらつきを防ぐ。
    let alive = true;
    const minVisible = new Promise<void>((resolve) => setTimeout(resolve, 350));
    Promise.all([refreshProfiles(), minVisible]).finally(() => {
      if (alive) setBooted(true);
    });
    return () => {
      alive = false;
    };
  }, [refreshProfiles]);

  // 初回起動オンボーディング (#599): 起動が完了した時点でプロファイルが 0 件
  // (= 新規ユーザ) かつツアー未表示なら自動で開始する。既存ユーザ (プロファイル
  // ありでツアー未表示のケースを含む) には自動表示しない。`tourAutoCheckedRef`
  // で起動直後の 1 回だけに限定し、その後プロファイルを全削除しても再度自動
  // 表示されないようにする。
  const tourAutoCheckedRef = useRef(false);
  useEffect(() => {
    if (!booted || tourAutoCheckedRef.current) return;
    tourAutoCheckedRef.current = true;
    if (profiles.length === 0 && !onboarding.beenShown()) {
      setShowTour(true);
    }
  }, [booted, profiles]);

  // 接続プロファイルのエクスポート: 全プロファイルを秘密情報抜きで JSON へ。
  const handleExportProfiles = useCallback(async () => {
    if (profiles.length === 0) {
      toast.info(translate("profileExportEmpty"));
      return;
    }
    try {
      const dest = await saveFileDialog({
        defaultPath: "noobdb-profiles.json",
        title: translate("profileExportTitle"),
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (typeof dest !== "string" || !dest) return;
      await api.exportProfiles(dest);
      toast.success(translate("profileExportSuccess", { path: dest }));
    } catch (e) {
      toast.error(translate("profileExportError", { error: String(e) }));
    }
  }, [profiles.length, toast, translate]);

  // 接続プロファイルのインポート: ファイルを選び、衝突解決ダイアログを開く。
  const handleImportProfilesPick = useCallback(async () => {
    try {
      const picked = await openFileDialog({
        multiple: false,
        title: translate("profileImportTitle"),
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (typeof picked !== "string" || !picked) return;
      setImportProfilesPath(picked);
    } catch (e) {
      toast.error(translate("profileImportError", { error: String(e) }));
    }
  }, [toast, translate]);

  const handleImportProfilesConfirm = useCallback(
    async (strategy: ProfileImportStrategy) => {
      const path = importProfilesPath;
      setImportProfilesPath(null);
      if (!path) return;
      try {
        const res = await api.importProfiles(path, strategy);
        await refreshProfiles();
        toast.success(translate("profileImportSuccess", res as unknown as Record<string, string | number>));
      } catch (e) {
        toast.error(translate("profileImportError", { error: String(e) }));
      }
    },
    [importProfilesPath, refreshProfiles, toast, translate],
  );

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

  const runWithErrorStatus = useCallback(
    async (fn: () => Promise<void>, key: Parameters<ReturnType<typeof useT>>[0]) => {
      try {
        await fn();
      } catch (e) {
        setStatus({ kind: "key", key, vars: { error: String(e) }, error: true });
      }
    },
    [],
  );

  // 履歴ナビゲーション用に直近の実行クエリを読み込む。接続中のみ取得し、
  // プロファイル切替・実行 (`historyReloadKey`) を契機に最新化する。連続して同じ
  // SQL が並ぶと ↑/↓ で 1 件しか進まないように、隣り合う重複は畳む。
  useEffect(() => {
    const profileId = selectedProfile?.id ?? null;
    if (!sessionId || !profileId) {
      setQueryHistory([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const entries = await api.listHistory({ profileId, limit: 100 });
        if (cancelled) return;
        const sqls: string[] = [];
        for (const e of entries) {
          if (sqls.length === 0 || sqls[sqls.length - 1] !== e.sql) sqls.push(e.sql);
        }
        setQueryHistory(sqls);
      } catch {
        // 履歴の取得失敗はナビゲーションを無効化するだけで、致命的ではない。
        if (!cancelled) setQueryHistory([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, selectedProfile?.id, historyReloadKey]);

  // クイックアクセス: アクティブ接続が変わったら、そのプロファイルの
  // お気に入り/最近をストレージから読み込む。未接続時は空にする。
  useEffect(() => {
    const id = selectedProfile?.id ?? null;
    setQuickAccess(id ? loadQuickAccess(id) : EMPTY_QUICK_ACCESS);
  }, [selectedProfile?.id]);

  // 実行計画ウォッチ (#743): アクティブプロファイルのウォッチ状態と比較パネル。
  const [planWatch, setPlanWatch] = useState<PlanWatchState>(EMPTY_PLAN_WATCH);
  const [planWatchOpen, setPlanWatchOpen] = useState(false);
  const [planWatchRefreshing, setPlanWatchRefreshing] = useState(false);
  const activeProfileIdRef = useRef<string | null>(null);
  useEffect(() => {
    const id = selectedProfile?.id ?? null;
    activeProfileIdRef.current = id;
    setPlanWatch(id ? loadPlanWatch(id) : EMPTY_PLAN_WATCH);
    setPlanWatchOpen(false);
  }, [selectedProfile?.id]);
  // 接続時の自動チェックが古いスニペット一覧を掴まないよう ref で追従する。
  const snippetsRef = useRef<Snippet[]>([]);
  useEffect(() => { snippetsRef.current = snippets; }, [snippets]);

  // プロファイル単位の更新中フラグ (再入抑止) と、並行更新数のカウンタ
  // (`planWatchRefreshing` は複数プロファイルの背景更新が重なっても
  // 全部終わるまで true を保つ)。
  const planWatchInFlightRef = useRef<Set<string>>(new Set());
  const planWatchRefreshCountRef = useRef(0);

  /**
   * ウォッチ中スニペットの EXPLAIN を実行して世代を記録し、前世代から構造的な
   * 変化があればトーストで通知する。`run_query` (非ストリーミング) 経由なので
   * クエリ履歴を汚さず、EXPLAIN は読み取り専用セッションでも許可される。
   * `planDiff` は (dagre を含む) `explainPlan` に依存するため、初期バンドルを
   * 太らせないよう動的 import で遅延ロードする。
   *
   * 保存は EXPLAIN 1 件ごとに「最新の状態を読み直し → 記録 → 保存」を await を
   * 挟まず同期的に行う。ループ全体で 1 つの state を抱えて最後にまとめて保存
   * すると、await 中に行われたウォッチ解除/登録 (同じく同期の load → save) を
   * 古い state で上書きして復活・消失させてしまうため。更新中に解除された id は
   * `recordGeneration` が no-op にし、同一プロファイルの重複更新は in-flight
   * フラグで抑止する。
   */
  const refreshPlanWatches = useCallback(
    async (sid: string, profile: ConnectionProfile, onlyIds?: string[]) => {
      if (planWatchInFlightRef.current.has(profile.id)) return;
      const targets = watchedIds(loadPlanWatch(profile.id)).filter(
        (id) => !onlyIds || onlyIds.includes(id),
      );
      if (targets.length === 0) return;
      planWatchInFlightRef.current.add(profile.id);
      planWatchRefreshCountRef.current += 1;
      setPlanWatchRefreshing(true);
      try {
        const planDiff = await import("./components/planDiff");
        let changed = 0;
        for (const id of targets) {
          const snippet = snippetsRef.current.find((s) => s.id === id);
          if (!snippet) continue;
          try {
            const res = await api.runQuery(
              sid,
              `${explainPrefixFor(profile.driver)}${snippet.sql}`,
            );
            const snapshot = planDiff.snapshotFromResult(profile.driver, res);
            if (!snapshot) continue;
            const ops = planDiff.opsFromSnapshot(snapshot);
            const rec = recordGeneration(loadPlanWatch(profile.id), id, {
              id: newGenerationId(),
              capturedAt: new Date().toISOString(),
              driver: profile.driver,
              payloadKind: snapshot.payloadKind,
              payload: snapshot.payload,
              fingerprint: planDiff.planFingerprint(ops),
            });
            if (rec.added) {
              savePlanWatch(profile.id, rec.state);
              if (rec.prev) {
                const cmp = planDiff.comparePlans(planDiff.opsFromSnapshot(rec.prev), ops);
                if (cmp.significant) changed += 1;
              }
            }
          } catch (e) {
            toast.error(
              translate("planWatchRefreshFailedToast", { name: snippet.name, error: String(e) }),
            );
          }
        }
        // 更新中に別プロファイルへ切り替わっていたら、他所の状態で上書きしない。
        if (activeProfileIdRef.current === profile.id) {
          setPlanWatch(loadPlanWatch(profile.id));
        }
        if (changed > 0) {
          toast.info(translate("planWatchChangedToast", { count: changed }));
        }
      } finally {
        planWatchInFlightRef.current.delete(profile.id);
        planWatchRefreshCountRef.current -= 1;
        setPlanWatchRefreshing(planWatchRefreshCountRef.current > 0);
      }
    },
    [toast],
  );

  const handleTogglePlanWatch = useCallback(
    (snippet: Snippet) => {
      if (!selectedProfile) return;
      const next = toggleWatch(loadPlanWatch(selectedProfile.id), snippet.id);
      savePlanWatch(selectedProfile.id, next);
      setPlanWatch(next);
      // 登録直後に接続中なら、最初の世代をその場で取得する。
      if (isWatched(next, snippet.id) && sessionId) {
        void refreshPlanWatches(sessionId, selectedProfile, [snippet.id]);
      }
    },
    [selectedProfile, sessionId, refreshPlanWatches],
  );

  const handleUnwatchPlan = useCallback(
    (snippetId: string) => {
      if (!selectedProfile) return;
      const next = removeWatch(loadPlanWatch(selectedProfile.id), snippetId);
      savePlanWatch(selectedProfile.id, next);
      setPlanWatch(next);
    },
    [selectedProfile],
  );

  const watchedPlanIdList = useMemo(() => watchedIds(planWatch), [planWatch]);
  const handleOpenPlanWatch = useCallback(() => setPlanWatchOpen(true), []);
  const handleRefreshPlanWatch = useCallback(() => {
    if (sessionId && selectedProfile) void refreshPlanWatches(sessionId, selectedProfile);
  }, [sessionId, selectedProfile, refreshPlanWatches]);

  // 最近開いたテーブルを記録する。`handleOpenTable` から呼ばれ、永続化も行う。
  const recordRecentTableOpen = useCallback((database: string, table: string) => {
    const id = selectedProfile?.id;
    if (!id) return;
    setQuickAccess((prev) => {
      const next = recordRecentTable(prev, { database, table });
      saveQuickAccess(id, next);
      return next;
    });
  }, [selectedProfile?.id]);

  // お気に入りのトグル (登録/解除)。永続化も行う。
  const handleToggleFavorite = useCallback((database: string, table: string) => {
    const id = selectedProfile?.id;
    if (!id) return;
    setQuickAccess((prev) => {
      const next = toggleFavoriteTable(prev, { database, table });
      saveQuickAccess(id, next);
      return next;
    });
  }, [selectedProfile?.id]);

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

  // Flushing on `beforeunload` lands the current state in localStorage as the
  // window tears down, so in-session tab updates (builder snapshots, SQL edits)
  // survive closing the app without disconnecting first — `setItem` is
  // synchronous so the write completes before unload.
  useEffect(() => {
    const id = selectedProfile?.id;
    if (!id) return;
    const flush = () => persistTabsForProfile(id);
    window.addEventListener("beforeunload", flush);
    return () => window.removeEventListener("beforeunload", flush);
  }, [selectedProfile?.id, persistTabsForProfile]);


  const closeAllTabs = useCallback(async () => {
    // Cancel any in-flight streams before tearing down tabs.
    const ids = Array.from(streamIdRef.current.keys());
    await Promise.all(ids.map((tid) => cancelStreamForTab(tid)));
    setTabs([]);
    setPanes([]);
    setActivePaneId(null);
  }, [cancelStreamForTab]);

  // 既に開いている接続へ即座に切り替える (#複数同時接続)。再接続せず、生存中の
  // バックエンドセッションへアクティブを差し替えるだけ。現在のタブを退避してから
  // 切替先の保存済みワークスペースを復元する。スキーマツリーは ConnectionList が
  // sessionId prop の変化を検知して自動で再ロードする。
  const switchToOpenConnection = useCallback(async (target: OpenConnection) => {
    if (target.sessionId === sessionId) return;
    // 進行中の自動再接続ループは手動切替で中断する。
    reconnectAbortRef.current = true;
    reconnectingRef.current = false;
    // 現在の接続のタブを退避してから片付ける (背景セッションは生かしたまま)。
    if (selectedProfile) persistTabsForProfile(selectedProfile.id);
    await closeAllTabs();
    // 旧セッションの DB 名を持ったまま各モーダルが新しい sessionId で開き続けない
    // よう、切替時も handleDisconnect / tearDownLostSession と同じく閉じる。
    setImportTarget(null);
    setDumpTarget(null);
    setSchemaExportTarget(null);
    setErrorProfileId(null);
    setConnectionStatus("connected");
    setSessionId(target.sessionId);
    setSelectedProfile(target.profile);
    const savedWs = loadPersistedWorkspace(target.profile.id);
    const savedCount = savedWs.panes.reduce((n, p) => n + p.tabs.length, 0);
    if (savedCount > 0 && restoreSavedTabsRef.current) {
      await restoreSavedTabsRef.current(target.sessionId, target.profile, savedWs);
    } else {
      setTabs([]);
      setPanes([]);
      setActivePaneId(null);
    }
    setStatus({ kind: "idle" });
    toast.success(translate("toastSwitchedConnection", { name: target.profile.name }));
  }, [sessionId, selectedProfile, closeAllTabs, persistTabsForProfile, toast]);

  const handleConnect = useCallback(async (profile: ConnectionProfile) => {
    // 既にアクティブな接続なら何もしない (誤クリックで張り直さない)。
    if (sessionId && selectedProfile?.id === profile.id) return;
    // 背景で開いたままの接続をクリックしたら、再接続せず即座に切り替える。
    const alreadyOpen = openConnectionsRef.current.find((c) => c.profile.id === profile.id);
    if (alreadyOpen) {
      await switchToOpenConnection(alreadyOpen);
      return;
    }
    if (profile.is_production && settings.confirmProductionConnect) {
      const ok = await confirm({
        title: translate("productionConfirmTitle"),
        message: (
          <Flex direction="column" gap="2" color="app.text" alignItems="center">
            <ProductionWarningIllustration size={80} />
            <Flex align="center" gap="2">
              {/* ここは「まだ接続していないプロファイル」の確認ダイアログなので、
                  色未設定時に現在のワークスペースアクセントへフォールバックする
                  ProfileColorChip の既定挙動は使わず、色があるときだけ表示する
                  (#663: チップ/バッジの見た目自体は ConnectionList / TitleBar と共有)。 */}
              {profile.color && <ProfileColorChip color={profile.color} size={14} />}
              <chakra.span fontWeight={600} fontSize="md">{profile.name}</chakra.span>
              <ProductionBadge />
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
    // 手動接続は進行中の自動再接続ループより優先する: ループを中断させる。
    reconnectAbortRef.current = true;
    reconnectingRef.current = false;
    setConnectingId(profile.id);
    setErrorProfileId(null);
    setConnectionStatus("connected");
    setStatus({ kind: "key", key: "statusConnecting", vars: { name: profile.name } });
    if (sessionId) {
      // 別プロファイルへ接続するときは現在の接続を切断せず背景で生かしたまま残す
      // (#複数同時接続)。タブだけ退避し、レジストリのエントリはそのまま保持する。
      if (selectedProfile) persistTabsForProfile(selectedProfile.id);
      setSessionId(null);
      await closeAllTabs();
    }
    // Fresh attempt id so we can subscribe to phase progress and cancel this
    // specific attempt (#684).
    const attemptId = makeConnectAttemptId();
    setConnectAttempt({ id: attemptId, phase: "preparing" });
    const unlistenProgress = await listenConnectProgress(attemptId, (phase) =>
      setConnectAttempt((prev) => (prev?.id === attemptId ? { ...prev, phase } : prev)),
    ).catch(() => undefined);
    try {
      const driver: DriverKind =
        profile.driver === "postgres" || profile.driver === "sqlite" || profile.driver === "mysql"
          ? profile.driver
          : "mysql";
      const res = await api.connect(
        {
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
        },
        attemptId,
        settings.connectTimeoutSecs,
      );
      setSessionId(res.session_id);
      setSelectedProfile(profile);
      // 新しいセッションを同時接続レジストリへ登録する (#複数同時接続)。
      upsertOpenConnection(res.session_id, profile);

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
        // 接続直後はクエリタブを自動で開かない。空のワークスペース
        // (panes.length === 0) は EmptyState (「新規クエリ」ボタン付き) が
        // 表示されるため、ユーザが必要なときだけ明示的にタブを開ける。
        setTabs([]);
        setPanes([]);
        setActivePaneId(null);
      }
      setStatus({ kind: "idle" });
      toast.success(translate("toastConnected", { name: profile.name }));
      // 実行計画ウォッチ (#743): 設定が有効なら、ウォッチ登録済みスニペットの
      // EXPLAIN を背景で取得して世代記録・変化検知を行う (接続をブロックしない)。
      if (settings.planWatchOnConnect) {
        void refreshPlanWatches(res.session_id, profile);
      }
    } catch (e) {
      // 接続失敗時は表示状態を実態 (未接続) に合わせる。sessionId は既に null に
      // なっているが selectedProfile を旧プロファイルのままにすると、ヘッダが
      // 実際には非アクティブな旧接続を「接続中」として描画し続けてしまう (#F6)。
      setSelectedProfile(null);
      setErrorProfileId(profile.id);
      const kind = errorKindOf(e);
      setStatus({ kind: "key", key: "statusConnectionFailed", vars: { error: String(e) }, error: true, errorKind: kind });
      // An SSH host-key mismatch is recoverable in-app: offer the re-trust
      // dialog instead of leaving the user to hand-edit known_hosts (#682).
      if (kind === "sshHostKeyMismatch" && profile.ssh) {
        setHostKeyMismatch({ profile, message: String(e) });
      }
    } finally {
      setConnectingId(null);
      setConnectAttempt(null);
      unlistenProgress?.();
    }
  }, [
    sessionId,
    selectedProfile,
    closeAllTabs,
    persistTabsForProfile,
    switchToOpenConnection,
    upsertOpenConnection,
    settings.connectTimeoutSecs,
    settings.confirmProductionConnect,
    settings.tabRestoreMode,
    settings.planWatchOnConnect,
    refreshPlanWatches,
    toast,
    confirm,
  ]);

  // Host-key mismatch recovery (#682): pin the fingerprint the user approved in
  // the dialog, then reconnect. Pinning (rather than a plain forget + TOFU) means
  // the reconnect is verified against that exact key — if an active MITM presents
  // a *different* key during the re-trust window it mismatches again and is
  // rejected, keeping the mismatch dialog up instead of silently trusting it.
  // If the fingerprint can't be parsed from the message (unexpected format), fall
  // back to forget + TOFU so recovery is still possible.
  const handleReTrustHostKey = useCallback(async () => {
    const mismatch = hostKeyMismatch;
    const ssh = mismatch?.profile.ssh;
    if (!mismatch || !ssh) return;
    const { profile } = mismatch;
    const approved = parseHostKeyFingerprints(mismatch.message)?.actual;
    setReTrustingHostKey(true);
    try {
      if (approved) {
        await api.trustHostKey(ssh.host, ssh.port, approved);
      } else {
        await api.forgetHostKey(ssh.host, ssh.port);
      }
      setHostKeyMismatch(null);
      toast.success(translate("hostKeyReTrustedToast", { name: profile.name }));
      await handleConnect(profile);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setReTrustingHostKey(false);
    }
  }, [hostKeyMismatch, handleConnect, toast, translate]);

  // Abort the in-flight connection attempt (#684): the awaiting connect command
  // rejects with a "cancelled" error, which handleConnect's catch surfaces.
  const handleCancelConnect = useCallback(async () => {
    const id = connectAttempt?.id;
    if (!id) return;
    await api.cancelConnect(id).catch(() => {
      /* attempt may have already finished; ignore */
    });
  }, [connectAttempt]);

  const handleDisconnect = useCallback(async () => {
    if (!sessionId) return;
    // 明示切断は進行中の自動再接続ループを中断させる。
    reconnectAbortRef.current = true;
    reconnectingRef.current = false;
    setConnectionStatus("connected");
    // Persist before tearing down — closeAllTabs clears the in-memory list.
    if (selectedProfile) persistTabsForProfile(selectedProfile.id);
    await closeAllTabs();
    // アクティブな接続をレジストリから外す (#複数同時接続)。
    const closingId = selectedProfile?.id ?? null;
    if (closingId) removeOpenConnection(closingId);
    try {
      await api.disconnect(sessionId);
    } catch (e) {
      console.warn(e);
    }
    setSessionId(null);
    setSelectedProfile(null);
    setImportTarget(null);
    setDumpTarget(null);
    setSchemaExportTarget(null);
    // 他に開いている接続が残っていれば、そのうち最後に開いたものへ切り替える。
    // 残っていなければ未接続状態へ。
    const remaining = openConnectionsRef.current.filter((c) => c.profile.id !== closingId);
    if (remaining.length > 0) {
      await switchToOpenConnection(remaining[remaining.length - 1]);
    } else {
      setStatus({ kind: "key", key: "appDisconnected" });
    }
  }, [sessionId, selectedProfile, closeAllTabs, persistTabsForProfile, removeOpenConnection, switchToOpenConnection]);

  // 特定の接続 (背景またはアクティブ) を再接続せずに閉じる (#複数同時接続)。
  // 背景接続ならアクティブなワークスペースには触れずバックエンドセッションだけ
  // 落とす。アクティブ接続を閉じる場合は handleDisconnect と同じ後始末を行う。
  const handleDisconnectProfile = useCallback(async (profileId: string) => {
    const entry = openConnectionsRef.current.find((c) => c.profile.id === profileId);
    if (!entry) return;
    if (entry.profile.id === selectedProfile?.id) {
      await handleDisconnect();
      return;
    }
    // 背景接続: タブは退避済みなので、セッションを落としてレジストリから外すだけ。
    removeOpenConnection(profileId);
    try {
      await api.disconnect(entry.sessionId);
    } catch (e) {
      console.warn(e);
    }
    toast.info(translate("toastDisconnected", { name: entry.profile.name }));
  }, [selectedProfile?.id, handleDisconnect, removeOpenConnection, toast]);

  // A query or preview failed because the connection dropped (server idle
  // timeout, network or VPN loss). Tear the now-dead session down the same way
  // an explicit Disconnect would — close tabs and release the backend session
  // and its SSH tunnel — then surface a clear reconnect message. The dropped
  // profile is flagged in the connection list so reconnecting is one click.
  //
  // 死んだセッションを完全に破棄して手動再接続 UI に倒す。自動再接続を行わない
  // (無効設定・トランザクション中・リトライ上限到達) ときの共通後始末。
  // `inTransaction` のときは「中途半端なコミットを避けて再接続しなかった」旨を示す。
  const tearDownLostSession = useCallback(
    async (profile: ConnectionProfile | null, oldSessionId: string | null, opts?: {
      inTransaction?: boolean;
      gaveUpAfter?: number;
    }) => {
      const lostProfileId = profile?.id ?? null;
      if (profile) persistTabsForProfile(profile.id);
      await closeAllTabs();
      // 死んだ接続をレジストリから外す (#複数同時接続)。
      if (lostProfileId) removeOpenConnection(lostProfileId);
      if (oldSessionId) {
        try { await api.disconnect(oldSessionId); } catch (e) { console.warn(e); }
      }
      setSessionId(null);
      setSelectedProfile(null);
      setImportTarget(null);
      setDumpTarget(null);
      setSchemaExportTarget(null);
      setConnectionStatus("connected");
      setErrorProfileId(lostProfileId);
      if (opts?.inTransaction) {
        setStatus({ kind: "key", key: "statusReconnectTx", error: true });
      } else if (opts?.gaveUpAfter != null && profile) {
        setStatus({
          kind: "key",
          key: "statusReconnectGaveUp",
          vars: { name: profile.name, max: opts.gaveUpAfter },
          error: true,
        });
      } else {
        setStatus({ kind: "key", key: "statusConnectionLost", error: true });
      }
    },
    [closeAllTabs, persistTabsForProfile, removeOpenConnection],
  );

  // 指数バックオフで自動再接続を試みるループ。成功したら同じプロファイルで張り直した
  // 新セッションへ差し替え (開いているタブはそのまま維持)、上限まで失敗したら
  // `tearDownLostSession` で手動再接続 UI に倒す。SSH トンネルの張り直しは
  // `api.connect` → バックエンドの `build_options` が担い、ライフタイム規約を守る。
  const runReconnectLoop = useCallback(
    async (profile: ConnectionProfile, oldSessionId: string, maxRetries: number) => {
      if (reconnectingRef.current) return;
      reconnectingRef.current = true;
      reconnectAbortRef.current = false;
      setConnectionStatus("reconnecting");
      // 再接続が最終的に失敗してもタブが失われないよう先に退避しておく。
      persistTabsForProfile(profile.id);
      // 死んだバックエンドセッションを落としてリークを防ぐ (ベストエフォート)。
      try { await api.disconnect(oldSessionId); } catch { /* already gone */ }

      const driver: DriverKind =
        profile.driver === "postgres" || profile.driver === "sqlite" || profile.driver === "mysql"
          ? profile.driver
          : "mysql";

      for (let attempt = 0; attempt < maxRetries; attempt++) {
        if (reconnectAbortRef.current) { reconnectingRef.current = false; return; }
        setStatus({
          kind: "key",
          key: "statusReconnectingAttempt",
          vars: { name: profile.name, attempt: attempt + 1, max: maxRetries },
        });
        await new Promise((resolve) => setTimeout(resolve, backoffDelayMs(attempt)));
        if (reconnectAbortRef.current) { reconnectingRef.current = false; return; }
        try {
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
          // connect 解決後に中断フラグを再確認する。await 中にユーザが別接続へ
          // 切り替えていた場合、ここで確立できてしまったセッションを表示中の
          // (別の) セッションへ上書きしてしまうと「見た目は別接続・実行先は
          // このセッション」という食い違いが起きるため、状態反映せず後始末する。
          if (reconnectAbortRef.current) {
            try { await api.disconnect(res.session_id); } catch { /* best effort */ }
            reconnectingRef.current = false;
            return;
          }
          // 成功: タブを維持したままセッションだけ差し替える。
          setSessionId(res.session_id);
          setSelectedProfile(profile);
          // レジストリの該当エントリを新セッション id へ差し替える (#複数同時接続)。
          upsertOpenConnection(res.session_id, profile);
          setErrorProfileId(null);
          setConnectionStatus("connected");
          setStatus({ kind: "idle" });
          toast.success(translate("statusReconnected", { name: profile.name }));
          reconnectingRef.current = false;
          return;
        } catch (e) {
          // 次の試行へ。最終試行で抜けたら下の give-up 処理に落ちる。
          console.warn("reconnect attempt failed", e);
        }
      }
      // 上限到達: 諦めて手動再接続 UI へ。
      reconnectingRef.current = false;
      if (reconnectAbortRef.current) return;
      await tearDownLostSession(profile, null, { gaveUpAfter: maxRetries });
    },
    [persistTabsForProfile, tearDownLostSession, upsertOpenConnection, toast],
  );

  // 接続断 (クエリ失敗 / フォーカス時のヘルスチェック失敗) の統一ハンドラ。設定と
  // トランザクション状態に応じて、自動再接続ループを起動するか手動再接続へ倒すかを
  // 振り分ける。トランザクション中の断は再接続せず明示エラーにする (#600)。
  const handleConnectionLost = useCallback(async () => {
    const oldSessionId = sessionId;
    const profile = selectedProfile;
    if (!oldSessionId) return;
    if (reconnectingRef.current) return; // 既にループ実行中。
    const inTransaction = txActiveRef.current;
    const cfg = getSettings();
    if (
      !profile ||
      !shouldAutoReconnect({
        enabled: cfg.autoReconnectEnabled,
        inTransaction,
        attempt: 0,
        maxRetries: cfg.autoReconnectMaxRetries,
      })
    ) {
      await tearDownLostSession(profile, oldSessionId, { inTransaction });
      return;
    }
    await runReconnectLoop(profile, oldSessionId, cfg.autoReconnectMaxRetries);
  }, [sessionId, selectedProfile, tearDownLostSession, runReconnectLoop]);

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

  // Fetch the database's foreign keys for each active table tab so the result
  // grid can offer reverse FK navigation (rows referencing the current row).
  // Cached per database and reused across tabs. #621
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    for (const tt of paneActiveTabs) {
      if (!tt || tt.kind !== "table" || !tt.database) continue;
      const key = schemaCacheKey(sessionId, tt.database);
      if (key in fkCache || fkInFlightRef.current.has(key)) continue;
      fkInFlightRef.current.add(key);
      const database = tt.database;
      api.foreignKeys(sessionId, database)
        .then((fks) => {
          if (!cancelled) setFkCache((prev) => ({ ...prev, [key]: fks }));
        })
        .catch(() => { /* ignore: reverse FK nav is best-effort */ })
        .finally(() => { fkInFlightRef.current.delete(key); });
    }
    return () => { cancelled = true; };
  }, [sessionId, paneActiveTabs, fkCache]);

  // Drop every cached schema when the session changes so a new connection
  // never autocompletes against the previous database's tables.
  useEffect(() => {
    setSchemaCache({});
    schemaInFlightRef.current.clear();
    setFkCache({});
    fkInFlightRef.current.clear();
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
  // called after DDL. Pass the database the DDL ran against to drop only that
  // snapshot, so a split pane editing another database keeps its cache (and
  // doesn't trigger a needless re-fetch). With no database (or no session) we
  // fall back to clearing the whole map; entries are cheap to rebuild.
  const invalidateSchemaCache = useCallback(
    (database?: string | null) => {
      if (!sessionId || !database) {
        schemaInFlightRef.current.clear();
        setSchemaCache({});
        return;
      }
      const key = schemaCacheKey(sessionId, database);
      schemaInFlightRef.current.delete(key);
      setSchemaCache((prev) => {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });
    },
    [sessionId],
  );

  // Tabs ref kept in sync so streaming callbacks below can read the latest
  // committed tab state without re-creating themselves on every batch.
  const tabsRef = useRef<Tab[]>(tabs);
  useEffect(() => { tabsRef.current = tabs; }, [tabs]);

  const nextRowCount = useCallback((tabId: string, justAdded: number) => {
    const tt = tabsRef.current.find((x) => x.id === tabId);
    if (tt?.result) return tt.result.rows.length;
    return justAdded;
  }, []);

  // 長時間クエリ完了時の OS 通知 (#707)。実行開始からの経過時間が設定の閾値以上
  // かつウィンドウが非フォーカスのときだけ発火する (判定は queryNotify.ts の
  // 純関数)。通知本文には件数・経過時間・エラー先頭 1 行のみを含め、SQL 本文や
  // 結果データは一切渡さない。ベストエフォートで、失敗してもクエリ完了処理自体は
  // 継続する (finalize/setStatus は呼び出し元で完結済み)。
  const notifyQueryOutcome = useCallback(
    async (
      kind: QueryNotificationKind,
      elapsedMs: number,
      extra: { rows?: number; error?: string | null } = {},
    ) => {
      if (!settings.queryNotificationsEnabled) return;
      const windowFocused = await isAppWindowFocused();
      if (
        !shouldNotifyQueryCompletion({
          enabled: settings.queryNotificationsEnabled,
          elapsedMs,
          thresholdSecs: settings.queryNotificationThresholdSecs,
          windowFocused,
        })
      ) {
        return;
      }
      let title: string;
      let body: string;
      switch (kind) {
        case "done":
          title = translate("notifyQueryDoneTitle");
          body = translate("notifyQueryDoneBody", { rows: extra.rows ?? 0, ms: elapsedMs });
          break;
        case "timeout":
          title = translate("notifyQueryTimeoutTitle");
          body = translate("notifyQueryTimeoutBody");
          break;
        case "cancelled":
          title = translate("notifyQueryCancelledTitle");
          body = translate("notifyQueryCancelledBody");
          break;
        case "error":
        default:
          title = translate("notifyQueryErrorTitle");
          body = firstLineForNotification(extra.error ?? "");
          break;
      }
      void sendQueryNotification(title, body);
    },
    [settings.queryNotificationsEnabled, settings.queryNotificationThresholdSecs],
  );

  const runQueryInTab = useCallback(async (
    tabId: string,
    sql: string,
    paginatableBase: string | null = null,
    autoLimit: number | null = null,
    autoRefresh: boolean = false,
  ) => {
    if (!sessionId) {
      setStatus({ kind: "key", key: "statusNotConnected", error: true });
      return;
    }
    // 自動再接続中は接続が無効。キューイングはせず明示的に弾く (#600)。
    if (connectionStatusRef.current === "reconnecting") {
      setStatus({ kind: "key", key: "statusReconnectBusy", error: true });
      return;
    }
    const tab = tabs.find((tt) => tt.id === tabId);
    await cancelStreamForTab(tabId);

    const timeoutSecs = settings.queryTimeoutSecs;
    const streamId = newStreamId(tabId);
    streamIdRef.current.set(tabId, streamId);
    const startedAt = Date.now();
    runStartRef.current.set(tabId, startedAt);
    setStatus({ kind: "key", key: "statusRunningQuery" });
    // 結果差分ハイライト (#597): 直前の結果行とその SQL を退避しておき、同一クエリの
    // 再実行 (prevResultSql === 今回 sql) のときだけ ResultGrid 側で差分計算に使う。
    const prevRowsSnapshot = tab?.result?.rows ?? null;
    const prevSqlSnapshot = tab?.lastExecutedSql ?? null;
    updateTab(tabId, {
      lastExecutedSql: sql,
      result: emptyResult([]),
      preview: null,
      prevResultRows: prevRowsSnapshot,
      prevResultSql: prevSqlSnapshot,
      streaming: true,
      paginatable: paginatableBase,
      autoLimitApplied: null,
      autoLimitSql: autoLimit !== null ? sql : null,
      loadingMore: false,
      canLoadMore: false,
      queryError: null,
      partialResult: null,
      // Drop any in-flight cell edits: their row indices reference the
      // previous result set and would no longer line up with the new rows.
      pendingEdits: {},
      editUndoStack: [],
      editRedoStack: [],
      // A manual run of a non-read-only statement turns auto-refresh off so the
      // toggle never lingers "on" while silently skipping ticks. Read-only
      // manual re-runs keep polling, now targeting the new SQL.
      ...(!autoRefresh && !isReadOnlySql(sql) ? { autoRefreshSecs: null } : {}),
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
            vars: { rows: nextRowCount(tabId, rows.length), elapsed: formatElapsed(Date.now() - startedAt) },
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
            ...(autoRefresh ? { autoRefreshLastRunAt: Date.now() } : {}),
          };
        });
        if (hasColumns) {
          setStatus({ kind: "key", key: "statusStreamingDone", vars: { rows: totalRows, ms: elapsedMs } });
        } else {
          setStatus({ kind: "key", key: "statusRowsAffected", vars: { rows: rowsAffected, ms: elapsedMs } });
        }
        // A new entry was just written to history; refresh the panel. Auto-refresh
        // ticks never write history, so they skip the (otherwise per-tick) reload.
        if (!autoRefresh) setHistoryReloadKey((k) => k + 1);
        // DDL may have added/renamed tables or columns — refresh autocomplete
        // for the database this statement ran against (the executing tab's, or
        // the profile default when the tab pins no database), leaving other
        // panes' cached schemas untouched.
        if (isSchemaMutatingSql(sql)) {
          invalidateSchemaCache(tab?.database ?? selectedProfile?.database ?? null);
        }
        finalize();
        // Auto-refresh ticks fire this same onDone every cadence — notifying on
        // every tick while the window is unfocused would be spam, not a useful
        // nudge, so only long-running *manual* runs are eligible (#707).
        if (!autoRefresh) {
          void notifyQueryOutcome("done", elapsedMs, { rows: hasColumns ? totalRows : rowsAffected });
        }
      },
      onError: ({ error, timedOut, connectionLost, deliveredRows }) => {
        patchTab(tabId, (tt) => ({
          ...tt,
          streaming: false,
          queryError: connectionLost ? null : (error ?? "Unknown error"),
          // タイムアウトは取得済みの行を残したまま止まる — 部分結果である旨を
          // グリッドのバッジ/エクスポート確認に伝える (#685)。
          ...(timedOut ? { partialResult: timeoutPartialResult(deliveredRows) } : {}),
        }));
        setHistoryReloadKey((k) => k + 1);
        finalize();
        if (!autoRefresh && !connectionLost) {
          void notifyQueryOutcome(timedOut ? "timeout" : "error", Date.now() - startedAt, { error });
        }
        // A dropped connection leaves the session unusable: tear it down and
        // prompt a reconnect rather than showing the raw transport error.
        if (connectionLost) {
          void handleConnectionLostRef.current();
          return;
        }
        if (timedOut) {
          setStatus({
            kind: "key",
            key: "statusQueryTimeoutPartial",
            vars: { secs: timeoutSecs, rows: deliveredRows },
            error: true,
          });
        } else {
          setStatus({ kind: "key", key: "statusQueryError", vars: { error }, error: true });
        }
      },
    });
    // While the listener was being attached (await above), a newer run on this
    // tab may have cancelled this stream and registered its own id. Registering
    // our unlisten now would overwrite (and leak) the newer one, and starting
    // the backend stream would race two writers patching the same tab — so
    // detach and bail instead.
    if (streamIdRef.current.get(tabId) !== streamId) {
      unlisten();
      return;
    }
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
        autoRefresh,
      });
    } catch (e) {
      patchTab(tabId, (tt) => ({ ...tt, streaming: false, queryError: String(e) }));
      setStatus({ kind: "key", key: "statusQueryError", vars: { error: String(e) }, error: true, errorKind: errorKindOf(e) });
      finalize();
    }
  }, [
    sessionId,
    tabs,
    updateTab,
    patchTab,
    cancelStreamForTab,
    invalidateSchemaCache,
    notifyQueryOutcome,
    selectedProfile?.database,
    settings.defaultDisplayCount,
    settings.streamPrefetchSize,
    settings.queryTimeoutSecs,
  ]);

  // ---- Auto-refresh (scheduled re-execution) -------------------------------
  // Latest `runQueryInTab` / `sessionId` kept in refs so a long-lived timer
  // always calls the current closure without being torn down on every render.
  const runQueryInTabRef = useRef(runQueryInTab);
  runQueryInTabRef.current = runQueryInTab;
  const sessionIdRef = useRef(sessionId);
  useEffect(() => { sessionIdRef.current = sessionId; }, [sessionId]);
  // 接続ヘルスチェックの同時実行を防ぐフラグ。
  const healthCheckBusyRef = useRef(false);

  // Toggle auto-refresh for a tab: `secs` enables polling at that cadence (also
  // remembered as the global default), `null` turns it off.
  const setAutoRefreshForTab = useCallback((tabId: string, secs: number | null) => {
    if (secs !== null) setAutoRefreshDefaultSecs(secs);
    updateTab(tabId, { autoRefreshSecs: secs, autoRefreshLastRunAt: null });
  }, [updateTab]);

  // Reconcile live timers with each tab's cadence. Keyed on a compact signature
  // of just (tabId, secs) pairs so streamed row batches — which mutate `tabs`
  // constantly — don't tear down and recreate the intervals.
  const autoRefreshSignature = tabs
    .map((tt) => `${tt.id}:${tt.autoRefreshSecs ?? 0}`)
    .join("|");
  useEffect(() => {
    const timers = autoRefreshTimers.current;
    const desired = new Map<string, number>();
    for (const tt of tabsRef.current) {
      const secs = tt.autoRefreshSecs ?? 0;
      if (secs > 0) desired.set(tt.id, secs);
    }
    // Drop timers for tabs that turned auto-refresh off (or were closed).
    for (const [tabId, handle] of timers) {
      if (!desired.has(tabId)) {
        clearInterval(handle);
        timers.delete(tabId);
      }
    }
    // (Re)create a timer for each desired tab. Recreated unconditionally because
    // the cadence may have changed since the last reconcile.
    for (const [tabId, secs] of desired) {
      const existing = timers.get(tabId);
      if (existing) clearInterval(existing);
      const handle = setInterval(() => {
        if (!sessionIdRef.current) return;
        const tt = tabsRef.current.find((x) => x.id === tabId);
        if (!tt) return;
        // In-flight guard: skip this tick if the previous run is still streaming.
        if (tt.streaming) return;
        // 未適用の編集がある間は自動リフレッシュを見送る (次の tick へ持ち越す)。
        // runQueryInTab は常に pendingEdits / editUndoStack / editRedoStack を
        // リセットするため、ここでスキップしないと編集中のセルと Undo/Redo 履歴が
        // 黙って破棄されてしまう (#F1)。
        if (Object.keys(tt.pendingEdits).length > 0) return;
        const sql = tt.lastExecutedSql;
        // Defence in depth: never poll a non-read-only statement (the backend
        // enforces this too via the auto-refresh guard).
        if (!sql || !isReadOnlySql(sql)) return;
        void runQueryInTabRef.current(tabId, sql, tt.paginatable ?? null, null, true);
      }, secs * 1000);
      timers.set(tabId, handle);
    }
  }, [autoRefreshSignature]);

  // Clear every timer on unmount so intervals don't outlive the component.
  useEffect(() => () => {
    for (const handle of autoRefreshTimers.current.values()) clearInterval(handle);
    autoRefreshTimers.current.clear();
  }, []);

  // Build fresh Tab objects from a saved workspace and replace the live layout.
  // Table tabs are verified via describeTable; entries pointing at tables that
  // no longer exist are demoted to query tabs holding the saved SQL. Each saved
  // pane is restored as its own pane so a split layout comes back split.
  const restoreSavedTabs = useCallback(
    async (sid: string, profile: ConnectionProfile, ws: PersistedWorkspace) => {
      const limit = Math.max(1, settings.defaultDisplayCount);
      // Table tabs whose table can no longer be described (dropped, renamed, or
      // the connection dropped) silently downgrade to query tabs. We collect
      // those here so the user gets one consolidated toast explaining why a
      // table tab came back as a query tab, instead of silently losing it.
      const restoreFailures: { table: string; reason: "missing" | "connection" | "other" }[] = [];
      const buildTab = async (s: PersistedTab): Promise<Tab> => {
        const restoredSnapshot = s.builderSnapshot ?? null;
        if (s.kind === "table" && s.database && s.table) {
          try {
            await api.describeTable(sid, s.database, s.table);
            const base = qualifiedTableSql(profile.driver, s.database, s.table);
            const sql = `${base} LIMIT ${limit}`;
            return {
              ...makeTab("table", s.title || s.table, sql),
              database: s.database,
              table: s.table,
              previewRowLimit: limit,
              paginatable: base,
              builderSnapshot: restoredSnapshot,
            };
          } catch (e) {
            // Table is gone — fall through to a query tab using the saved SQL,
            // but record why so we can tell the user.
            const msg = String(e);
            const reason: "missing" | "connection" | "other" =
              /table .* does(?:n't| not) exist|no such table|relation .* does not exist|unknown table/i.test(msg)
                ? "missing"
                : /server has gone away|lost connection|broken pipe|connection was killed|server closed the connection|terminating connection|error communicating with database|connection refused|connection reset|connection timed out|not connected/i.test(msg)
                  ? "connection"
                  : "other";
            restoreFailures.push({ table: s.table, reason });
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
          ...makeTab("query", s.kind === "query" ? s.title : translate("tabUntitledQuery"), s.sql),
          previewRowLimit: limit,
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
      // Surface any table tabs that downgraded to query tabs. `skip_history`
      // sessions opt out of incidental notifications, so stay quiet for them.
      if (restoreFailures.length > 0 && !profile.skip_history) {
        const names = restoreFailures.map((f) => f.table).join(", ");
        const allConnection = restoreFailures.every((f) => f.reason === "connection");
        const key = allConnection
          ? "toastTabRestoreConnectionLost"
          : restoreFailures.length === 1
            ? "toastTabRestoreMissing"
            : "toastTabRestoreMissingMany";
        toast.info(
          translate(key, { table: names, count: restoreFailures.length }),
          6000,
        );
      }
    },
    [runQueryInTab, settings.defaultDisplayCount, toast],
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
    // プレビュー中は (下の PreviewGrid 分岐で ResultGrid ごと差し替わるため)
    // paginatable を一時的に無効化するが、プレビュー終了後は元のテーブルタブへ
    // 戻れるよう必ず復元する (#F3)。復元しないと PaginationBar・全件エクスポート・
    // Retry・INSERT 後の再取得が恒久的に機能停止する。
    const previousPaginatable = tab?.paginatable ?? null;
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
      previewStreaming: true,
      previewRowLimit: rowLimit,
      paginatable: null,
      previewPrevPaginatable: previousPaginatable,
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
        patchTab(tabId, (tt) => ({
          ...tt,
          streaming: false,
          previewStreaming: false,
          paginatable: previousPaginatable,
          previewPrevPaginatable: undefined,
        }));
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
        patchTab(tabId, (tt) => ({
          ...tt,
          streaming: false,
          previewStreaming: false,
          paginatable: previousPaginatable,
          previewPrevPaginatable: undefined,
        }));
        finalize();
        if (connectionLost) {
          void handleConnectionLostRef.current();
          return;
        }
        setStatus({ kind: "key", key: "statusPreviewError", vars: { error }, error: true });
      },
    });
    // Same stale-stream guard as runQueryInTab: a newer run/preview on this
    // tab may have superseded this stream while the listener attached.
    if (streamIdRef.current.get(tabId) !== streamId) {
      unlisten();
      return;
    }
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
      patchTab(tabId, (tt) => ({
        ...tt,
        streaming: false,
        previewStreaming: false,
        paginatable: previousPaginatable,
        previewPrevPaginatable: undefined,
      }));
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
    // Buffered inline edits survive pagination because they are keyed by each
    // row's primary key (`rowEditKey`) rather than its array index. Appending a
    // page leaves existing rows in place, and even if a query without a stable
    // ORDER BY re-surfaces a row already shown, its PK identity is unchanged so
    // the edit still targets the correct row.
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
          // load-more は結果行を伸ばすが SQL の再実行ではない。差分スナップショット
          // (#597) を無効化し、伸びた行が「追加」として誤ハイライトされるのを防ぐ。
          prevResultRows: null,
          prevResultSql: null,
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

  // ページネーション: table タブの `paginatable` base SQL から N ページ目を
  // 取得して結果を**置き換える** (loadMore は追記、こちらはページ送り)。ページング用の
  // 内部クエリは `api.runQuery` 経由なので履歴を汚さない (CLAUDE.md のクエリ履歴方針)。
  const goToPageInTab = useCallback(async (tabId: string, page: number, sizeOverride?: number) => {
    if (!sessionId) return;
    const tab = tabsRef.current.find((tt) => tt.id === tabId);
    if (
      !tab ||
      tab.kind !== "table" ||
      !tab.paginatable ||
      tab.streaming ||
      tab.loadingMore
    ) {
      return;
    }
    const pageSize = Math.max(1, sizeOverride ?? tab.pageSize ?? tab.previewRowLimit);
    const total = estimatedTotalPages(tab.rowEstimateTotal ?? null, pageSize);
    const target = clampPage(page, total);
    if (target === (tab.page ?? 1) && tab.result) return;
    const sql = buildPageSql(tab.paginatable, pageSize, target);
    patchTab(tabId, (tt) => ({ ...tt, loadingMore: true }));
    try {
      const res = await api.runQuery(sessionId, sql, tab.database ?? null);
      patchTab(tabId, (tt) => ({
        ...tt,
        result: res,
        // ページ送りは完全な新ページへの置換なので、前回のキャンセル/タイム
        // アウト由来の部分結果バッジ (#685) はここでクリアする。
        partialResult: null,
        page: target,
        pageSize,
        loadingMore: false,
        // ページングは置換なので、無限スクロールの load-more は無効化する。
        canLoadMore: false,
        // ページ送りは別ページへの置換であり SQL の再実行ではない。差分
        // スナップショット (#597) を無効化し、旧ページとの誤比較を防ぐ。
        prevResultRows: null,
        prevResultSql: null,
        // 別ページに切り替えたら旧ページ由来の保留編集は孤立するため破棄する。
        pendingEdits: {},
        editUndoStack: [],
        editRedoStack: [],
        preview: null,
      }));
      setStatus({
        kind: "key",
        key: "statusStreamingDone",
        vars: { rows: res.rows.length, ms: res.elapsed_ms },
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
  }, [sessionId, patchTab]);

  // ページサイズを変更し、1 ページ目から取り直す。状態反映のレースを避けるため、
  // 新サイズを goToPageInTab に直接渡す。
  const setPageSizeInTab = useCallback((tabId: string, size: number) => {
    void goToPageInTab(tabId, 1, Math.max(1, Math.floor(size)));
  }, [goToPageInTab]);

  // SQL スクリプト (複数文) のバッチ実行。文ごとに順次実行し、各文の結果
  // (結果セット / 影響行数 / エラー) を集めて batchResults に積む。stopOnError なら
  // 最初のエラーで残りをスキップ、false なら続行する。読み取り専用ガードは文ごとに
  // バックエンドが強制する (api.runQuery 経由なので履歴は汚さない)。
  // `tabOverride` は、新規結果タブを addTab した直後に呼ぶケース用。tabsRef は
  // effect 経由で更新されるため直後は新タブを見つけられない。その場合はメモリ上の Tab を
  // 直接渡してレース (無実行化) を避ける。同一タブの再実行では渡さず、tabsRef の最新
  // フラグで再入ガードを効かせる。
  const runBatchInTab = useCallback(async (tabId: string, sql: string, stopOnError: boolean, tabOverride?: Tab) => {
    if (!sessionId) return;
    const tab = tabOverride ?? tabsRef.current.find((tt) => tt.id === tabId);
    if (!tab) return;
    // 再入ガード: 実行中の二重起動を防ぎ、DML の重複実行を避ける。
    if (tab.batchRunning || tab.streaming) return;
    const statements = splitSqlStatements(sql);
    if (statements.length === 0) return;
    const db = tab.database ?? selectedProfile?.database ?? null;
    const MAX_PREVIEW_ROWS = 200;
    patchTab(tabId, (tt) => ({
      ...tt,
      batchRunning: true,
      batchScript: sql,
      batchResults: [],
      showChart: false,
      showPivot: false,
      preview: null,
      queryError: null,
    }));
    setStatus({ kind: "key", key: "statusBatchRunning", vars: { total: statements.length } });
    const results: BatchStatementResult[] = [];
    let stopped = false;
    for (const stmt of statements) {
      if (stopped) {
        results.push({ sql: stmt, status: "skipped" });
        continue;
      }
      try {
        // 明示トランザクションが有効なら同一接続で実行して tx に乗せる。
        const res = txActiveRef.current
          ? await api.runInTransaction(sessionId, stmt)
          : await api.runQuery(sessionId, stmt, db);
        const isSelect = res.columns.length > 0;
        results.push({
          sql: stmt,
          status: "ok",
          columns: isSelect ? res.columns : undefined,
          rows: isSelect ? res.rows.slice(0, MAX_PREVIEW_ROWS) : undefined,
          rowsAffected: isSelect ? undefined : Number(res.rows_affected ?? 0),
          elapsedMs: res.elapsed_ms,
        });
      } catch (e) {
        results.push({ sql: stmt, status: "error", error: String(e) });
        if (stopOnError) stopped = true;
      }
      // 進捗を反映 (途中経過を見せる)。コピーして積む。
      patchTab(tabId, (tt) => ({ ...tt, batchResults: [...results] }));
    }
    patchTab(tabId, (tt) => ({ ...tt, batchRunning: false, batchResults: results }));
    const okCount = results.filter((r) => r.status === "ok").length;
    const errCount = results.filter((r) => r.status === "error").length;
    setStatus({
      kind: "key",
      key: "statusBatchDone",
      vars: { ok: okCount, errors: errCount, total: results.length },
      error: errCount > 0,
    });
  }, [sessionId, selectedProfile?.database, patchTab]);

  // Run the editor's SQL in a specific tab, applying the danger gate and auto
  // LIMIT. Pane content binds this to its own active tab so each pane runs
  // independently.
  // 明示トランザクション内で 1 文を実行し、結果をタブへ反映する (非ストリーム)。
  const runTxInTab = useCallback(async (tabId: string, sql: string) => {
    if (!sessionId) return;
    patchTab(tabId, (tt) => ({
      ...tt,
      streaming: true,
      queryError: null,
      showChart: false,
      showPivot: false,
      batchResults: undefined,
      preview: null,
      // 結果を置き換えるので、旧結果由来の保留編集は破棄して整合を保つ。
      pendingEdits: {},
      editUndoStack: [],
      editRedoStack: [],
    }));
    try {
      const res = await api.runInTransaction(sessionId, sql);
      patchTab(tabId, (tt) => ({
        ...tt,
        streaming: false,
        result: res,
        lastExecutedSql: sql,
        paginatable: null,
        canLoadMore: false,
        autoLimitApplied: null,
        autoLimitSql: null,
      }));
      setStatus({ kind: "key", key: "statusStreamingDone", vars: { rows: res.rows.length, ms: res.elapsed_ms } });
    } catch (e) {
      patchTab(tabId, (tt) => ({ ...tt, streaming: false, queryError: String(e) }));
      setStatus({ kind: "key", key: "statusQueryError", vars: { error: String(e) }, error: true, errorKind: errorKindOf(e) });
    }
  }, [sessionId, patchTab]);

  // トランザクション制御。開始/確定/破棄。
  const handleBeginTransaction = useCallback(async () => {
    if (!sessionId) return;
    try {
      await api.beginTransaction(sessionId, selectedProfile?.database ?? null);
      setTxActive(true);
      toast.info(translate("txBegun"));
    } catch (e) {
      toast.error(String(e));
    }
  }, [sessionId, selectedProfile?.database, toast]);

  const handleFinishTransaction = useCallback(async (commit: boolean) => {
    if (!sessionId) return;
    try {
      await api.finishTransaction(sessionId, commit);
      setTxActive(false);
      toast.success(commit ? translate("txCommitted") : translate("txRolledBack"));
    } catch (e) {
      toast.error(String(e));
    }
  }, [sessionId, toast]);

  const runInTabWithGate = useCallback((tab: Tab, sql: string, opts?: { newTab?: boolean }) => {
    // On an explain tab the primary action re-runs EXPLAIN so the viewer keeps
    // getting plan JSON instead of a raw result set. EXPLAIN is read-only, so
    // it never trips the destructive-query gate or auto LIMIT.
    if (tab.kind === "explain") {
      runQueryInTab(tab.id, `${explainPrefixFor(selectedProfile?.driver)}${sql}`);
      return;
    }
    // 複数結果タブ: 設定 `resultsInNewTab` または明示指定のとき、結果を上書き
    // せず SQL を複製した新しいタブで実行して前の結果を残す。以降のゲート/実行はこの
    // ターゲットタブに対して行う。
    let target = tab;
    let openedInNewTab = false;
    if (tab.kind === "query" && (opts?.newTab ?? settings.resultsInNewTab)) {
      const newTab: Tab = {
        ...makeQueryTab(),
        sql,
        lastExecutedSql: sql,
        title: deriveResultTabTitle(sql),
      };
      addTab(newTab);
      target = newTab;
      openedInNewTab = true;
    }
    // Auto LIMIT only guards free-form editor queries; table tabs carry their
    // own LIMIT. Writes pass through here too but the backend parser leaves
    // them untouched.
    const autoLimit =
      target.kind === "query" && settings.autoLimitEnabled ? settings.autoLimitCount : null;
    const isProduction = selectedProfile?.is_production ?? false;
    const sessionReadOnly = selectedProfile?.read_only ?? false;
    // Production connections may opt into approving every data-modifying
    // statement. Read-only takes precedence: those sessions reject writes
    // outright on the backend, so there is nothing to approve here.
    const requireWriteApproval =
      isProduction && (selectedProfile?.confirm_writes ?? false) && !sessionReadOnly;
    // 複数文スクリプトはバッチ実行に振り分ける。auto LIMIT は付けない。
    const batch = target.kind === "query" && isMultiStatement(sql);
    const findings =
      isProduction || settings.confirmDangerousQueries ? analyzeDangerousSql(sql) : [];
    const needsWriteApproval = requireWriteApproval && !isReadOnlySql(sql);
    if (findings.length > 0 || needsWriteApproval) {
      // Irreversible DROP/TRUNCATE on a production connection gets the
      // stronger "type the target name to confirm" gate (#675); everything
      // else (non-production, or DELETE/UPDATE-without-WHERE findings) keeps
      // the existing one-click confirmation.
      const destructiveTargets = findings
        .filter((f) => f.kind === "drop" || f.kind === "truncate")
        .map((f) => f.target);
      const typedConfirmTarget =
        isProduction && destructiveTargets.length > 0
          ? resolveTypedConfirmTarget(destructiveTargets)
          : null;
      setPendingDangerous({
        tabId: target.id,
        sql,
        findings,
        isProduction,
        writeApproval: needsWriteApproval,
        autoLimit,
        batch,
        typedConfirmTarget,
      });
      return;
    }
    if (batch) {
      // 新タブ直後は tabsRef に未反映なので、メモリ上の target を直接渡す。
      void runBatchInTab(target.id, sql, true, openedInNewTab ? target : undefined);
      return;
    }
    // 明示トランザクション中は同一接続で実行する経路に振り分ける。
    if (txActiveRef.current && target.kind === "query") {
      void runTxInTab(target.id, sql);
      return;
    }
    runQueryInTab(target.id, sql, null, autoLimit);
  }, [
    runQueryInTab,
    runBatchInTab,
    runTxInTab,
    addTab,
    selectedProfile?.is_production,
    selectedProfile?.confirm_writes,
    selectedProfile?.read_only,
    settings.confirmDangerousQueries,
    settings.autoLimitEnabled,
    settings.autoLimitCount,
    settings.resultsInNewTab,
    selectedProfile?.driver,
  ]);

  const handleConfirmDangerous = useCallback(() => {
    if (!pendingDangerous) return;
    const { tabId, sql, autoLimit, batch } = pendingDangerous;
    setPendingDangerous(null);
    if (batch) {
      void runBatchInTab(tabId, sql, true);
      return;
    }
    // 明示トランザクション中の振り分けは runInTabWithGate と同じく query タブのみ。
    const target = tabsRef.current.find((tt) => tt.id === tabId);
    if (txActiveRef.current && target?.kind === "query") {
      void runTxInTab(tabId, sql);
      return;
    }
    runQueryInTab(tabId, sql, null, autoLimit);
  }, [pendingDangerous, runQueryInTab, runBatchInTab, runTxInTab]);

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
      runQueryInTab(sourceTab.id, `${explainPrefixFor(selectedProfile?.driver)}${sql}`);
      return;
    }
    const owner = panesRef.current.find((p) => p.tabIds.includes(sourceTab.id));
    const tab = makeExplainTab(sql);
    addTab(tab, owner?.id);
    runQueryInTab(tab.id, `${explainPrefixFor(selectedProfile?.driver)}${sql}`);
  }, [runQueryInTab, addTab, selectedProfile?.driver]);

  // 現在のタブの結果セットをピン留めして保持する (#622)。スナップショットなので
  // 以降タブを再実行・破棄しても比較ビューに残る。上限超過時は古い順に破棄。
  const pinCurrentResult = useCallback((tab: Tab) => {
    if (!tab.result) return;
    const item: PinnedResult = {
      id: `pin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      title: tab.title || deriveResultTabTitle(tab.lastExecutedSql) || "result",
      sql: tab.lastExecutedSql,
      columns: tab.result.columns,
      rows: tab.result.rows,
      rowsAffected: tab.result.rows_affected,
      elapsedMs: tab.result.elapsed_ms,
      pinnedAt: Date.now(),
    };
    setPinnedResults((prev) => addPinned(prev, item));
  }, []);

  // Run the resolved SQL through whichever action the user triggered. Used both
  // directly (no parameters) and after the parameter modal substitutes values.
  const dispatchEditorAction = useCallback(
    (tab: Tab, sql: string, mode: "run" | "preview" | "explain") => {
      if (mode === "preview") previewQueryInTab(tab.id, sql);
      else if (mode === "explain") explainForTab(tab, sql);
      else runInTabWithGate(tab, sql);
    },
    [previewQueryInTab, explainForTab, runInTabWithGate],
  );

  // Editor run/preview/explain gate for {{variable}} parameters: when the SQL
  // has placeholders, prompt for values first; otherwise run straight through.
  const resolveParamsThen = useCallback(
    (tab: Tab, sql: string, mode: "run" | "preview" | "explain") => {
      if (extractQueryParams(sql).length === 0) {
        dispatchEditorAction(tab, sql, mode);
        return;
      }
      setPendingParams({ tab, sql, mode });
    },
    [dispatchEditorAction],
  );

  const handleParamsSubmit = useCallback(
    (values: Record<string, string>, types: Record<string, ParamType>) => {
      if (!pendingParams) return;
      const { tab, sql, mode } = pendingParams;
      const driver = (selectedProfile?.driver ?? "mysql") as DriverKind;
      const finalSql = substituteQueryParams(sql, driver, values, types);
      setPendingParams(null);
      dispatchEditorAction(tab, finalSql, mode);
    },
    [pendingParams, selectedProfile?.driver, dispatchEditorAction],
  );

  const handleParamsCancel = useCallback(() => setPendingParams(null), []);

  // User-driven stop: cancel the tab's in-flight stream, drop the streaming
  // flag, and keep whatever rows have already arrived. The backend
  // `cancelStream` tears down the cursor while leaving the connection open.
  const stopTab = useCallback(async (tab: Tab) => {
    if (!tab.streaming) return;
    const wasPreview = tab.previewStreaming;
    // バックエンドが報告する「中断時点で届いていた行数」(#685)。ストリームが
    // 既に終わっていた場合 (null) は、フロント側に貯まっている行数へフォール
    // バックする (resolveCancelledRows) — メッセージは常に何らかの行数を出す。
    const deliveredRows = await cancelStreamForTab(tab.id);
    const partial = cancelledPartialResult(deliveredRows, tab.result?.rows.length ?? 0);
    const rows = partial.rows;
    patchTab(tab.id, (tt) => ({
      ...tt,
      streaming: false,
      previewStreaming: false,
      // プレビューは別グリッド (before/after) で完結し、部分結果バッジの対象外。
      ...(wasPreview ? {} : { partialResult: partial }),
      // プレビューをキャンセルした場合、previewQueryInTab の onDone/onError は
      // (リスナーが既に detach 済みのため) 発火しない。退避しておいた
      // paginatable をここで復元する (#F3)。プレビューでなければ
      // previewPrevPaginatable は undefined なのでノーオペ。
      ...(tt.previewPrevPaginatable !== undefined
        ? { paginatable: tt.previewPrevPaginatable, previewPrevPaginatable: undefined }
        : null),
    }));
    setStatus(
      wasPreview
        ? { kind: "key", key: "statusQueryCancelled" }
        : { kind: "key", key: "statusQueryCancelledPartial", vars: { rows } },
    );
    // Preview (dry-run) cancellations aren't the "long-running editor query"
    // this notification is meant for (#707) — only notify for a real query run.
    if (!wasPreview) {
      // 行がまだ届いていない長時間クエリの停止でも経過時間を正しく出すため、
      // result.elapsed_ms (行到着まで 0) ではなく実行開始時刻から算出する。
      const started = runStartRef.current.get(tab.id);
      const elapsedMs =
        started !== undefined ? Date.now() - started : (tab.result?.elapsed_ms ?? 0);
      void notifyQueryOutcome("cancelled", elapsedMs);
    }
  }, [cancelStreamForTab, patchTab, notifyQueryOutcome]);

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
    setShowErd(false); setShowProcesses(false); setShowCompareResults(false);
    setShowServerInfo(false); setShowQueryInspector(false); setSizesTarget(null);
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
    setShowErd(false); setShowProcesses(false); setShowCompareResults(false);
    setShowServerInfo(false); setShowQueryInspector(false); setSizesTarget(null);
    setShowSnippetForm(true);
    setFormInstanceId((n) => n + 1);
  }, []);

  const handleDeleteSnippet = useCallback(async (id: string) => {
    await runWithErrorStatus(async () => {
      await api.deleteSnippet(id);
      await refreshSnippets();
      // 実行計画ウォッチ (#743): 削除したスニペットのウォッチと世代データを
      // 全プロファイルのストアから取り除く (孤立データを localStorage に
      // 残さない。手動のウォッチ解除と同じ削除方針)。
      for (const p of profiles) {
        const cur = loadPlanWatch(p.id);
        if (isWatched(cur, id)) savePlanWatch(p.id, removeWatch(cur, id));
      }
      if (activeProfileIdRef.current) {
        setPlanWatch(loadPlanWatch(activeProfileIdRef.current));
      }
    }, "statusFailedDeleteSnippet");
  }, [runWithErrorStatus, refreshSnippets, profiles]);

  const setCellEditForTab = useCallback(
    (tabId: string, rowKey: string, colIdx: number, value: string | null) => {
      patchTab(tabId, (tt) => {
        const next = { ...tt.pendingEdits };
        const row = { ...(next[rowKey] ?? {}) };
        if (value === null) {
          delete row[colIdx];
        } else {
          row[colIdx] = value;
        }
        if (Object.keys(row).length === 0) {
          delete next[rowKey];
        } else {
          next[rowKey] = row;
        }
        const undoStack = [...(tt.editUndoStack ?? []), tt.pendingEdits].slice(-EDIT_UNDO_LIMIT);
        return { ...tt, pendingEdits: next, editUndoStack: undoStack, editRedoStack: [] };
      });
    },
    [patchTab],
  );

  // 複数セル一括編集 (#596): 選択範囲へ展開された複数の pending edit を **1 回の
  // patch** で適用し、Undo スナップショットも 1 つだけ積む (1 セルずつ
  // setCellEditForTab を呼ぶと N 個のスナップショットが積まれてしまうため)。
  const setBulkCellEditsForTab = useCallback(
    (tabId: string, edits: BulkEditTarget[]) => {
      if (edits.length === 0) return;
      patchTab(tabId, (tt) => {
        const next: PendingEdits = {};
        for (const k of Object.keys(tt.pendingEdits)) next[k] = { ...tt.pendingEdits[k] };
        for (const e of edits) {
          next[e.rowKey] = { ...(next[e.rowKey] ?? {}), [e.colIdx]: e.value };
        }
        const undoStack = [...(tt.editUndoStack ?? []), tt.pendingEdits].slice(-EDIT_UNDO_LIMIT);
        return { ...tt, pendingEdits: next, editUndoStack: undoStack, editRedoStack: [] };
      });
    },
    [patchTab],
  );

  const clearEditsForTab = useCallback((tabId: string) => {
    patchTab(tabId, (tt) => {
      if (Object.keys(tt.pendingEdits).length === 0) return tt;
      const undoStack = [...(tt.editUndoStack ?? []), tt.pendingEdits].slice(-EDIT_UNDO_LIMIT);
      return { ...tt, pendingEdits: {}, editUndoStack: undoStack, editRedoStack: [] };
    });
  }, [patchTab]);

  // Discard from inside the preview pane: clear the edits AND dismiss the
  // preview view (otherwise the user is stuck on a preview of edits that
  // no longer exist). Also cancels any in-flight preview stream so a
  // late-arriving onMeta event doesn't re-populate `preview` after we've
  // cleared it.
  const discardEditsAndPreviewForTab = useCallback((tabId: string) => {
    void cancelStreamForTab(tabId);
    patchTab(tabId, (tt) => {
      const undoStack =
        Object.keys(tt.pendingEdits).length > 0
          ? [...(tt.editUndoStack ?? []), tt.pendingEdits].slice(-EDIT_UNDO_LIMIT)
          : (tt.editUndoStack ?? []);
      // ストリーミング中に破棄した場合、previewQueryInTab の onDone/onError は
      // (リスナー detach 済みのため) 発火せず paginatable を復元できない。退避値
      // が残っていればここで復元する (#F3)。
      const paginatableRestore =
        tt.previewPrevPaginatable !== undefined
          ? { paginatable: tt.previewPrevPaginatable, previewPrevPaginatable: undefined }
          : null;
      return {
        ...tt,
        pendingEdits: {},
        editUndoStack: undoStack,
        editRedoStack: [],
        preview: null,
        ...paginatableRestore,
      };
    });
  }, [patchTab, cancelStreamForTab]);

  const undoCellEditForTab = useCallback((tabId: string) => {
    patchTab(tabId, (tt) => {
      const stack = tt.editUndoStack ?? [];
      if (stack.length === 0) return tt;
      const prev = stack[stack.length - 1];
      const redoStack = [...(tt.editRedoStack ?? []), tt.pendingEdits].slice(-EDIT_UNDO_LIMIT);
      return { ...tt, pendingEdits: prev, editUndoStack: stack.slice(0, -1), editRedoStack: redoStack };
    });
  }, [patchTab]);

  const redoCellEditForTab = useCallback((tabId: string) => {
    patchTab(tabId, (tt) => {
      const stack = tt.editRedoStack ?? [];
      if (stack.length === 0) return tt;
      const next = stack[stack.length - 1];
      const undoStack = [...(tt.editUndoStack ?? []), tt.pendingEdits].slice(-EDIT_UNDO_LIMIT);
      return { ...tt, pendingEdits: next, editUndoStack: undoStack, editRedoStack: stack.slice(0, -1) };
    });
  }, [patchTab]);

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
    const driver = selectedProfile?.driver ?? "mysql";
    // 1 トランザクションに UPDATE (セル編集) + DELETE (削除予定行) + INSERT (新規行) を
    // まとめる。all-or-nothing なので一部失敗で全体がロールバックする。
    const updates = buildUpdateStatements({
      driver, database, table, columns: result.columns, rows: result.rows, pkIndices, edits: pendingEdits,
    });
    const deletes = buildDeleteStatements({
      driver, database, table, columns: result.columns, rows: result.rows, pkIndices,
      deleteKeys: new Set(tab.pendingDeletes ?? []),
    });
    const inserts = buildInsertStatements({
      driver, database, table, columns: result.columns, inserts: tab.pendingInserts ?? [],
    });
    const stmts = [...updates, ...deletes, ...inserts];
    if (stmts.length === 0) return;
    // 本番接続で書き込み承認 (confirm_writes) が有効なときは、通常のクエリ実行
    // ゲートと同じく、インライン編集の一括 Apply にも確認を要求する (#659)。
    // read-only は編集面自体が無効なので到達しないが、保険で条件に含める。
    const needsWriteApproval =
      (selectedProfile?.is_production ?? false) &&
      (selectedProfile?.confirm_writes ?? false) &&
      !readOnly;
    if (needsWriteApproval) {
      const ok = await confirm({
        title: translate("editApplyConfirmTitle"),
        message: translate("editApplyConfirmBody", { count: stmts.length }),
        confirmLabel: translate("editApplyButton"),
        tone: "warning",
      });
      if (!ok) return;
    }
    const tabId = tab.id;
    patchTab(tabId, (tt) => ({ ...tt, applyingEdits: true }));
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
    patchTab(tabId, (tt) => ({ ...tt, applyingEdits: false }));
    if (failure) {
      // トランザクションはロールバックされ DB は未変更。保留中の編集と行操作は
      // そのまま残し、ユーザが原因を直して再適用できるようにする (以前はここで
      // 1 ページ目を取り直して編集を破棄していた)。
      setStatus({
        kind: "key",
        key: "statusApplyEditsPartial",
        vars: { total: stmts.length, error: failure },
        error: true,
      });
      return;
    }
    // 成功時はコミット済みの変更を、取得済みの結果行へその場で反映する。これにより
    // 編集セルが新しい値を表示し、ユーザのスクロール/ページ位置も保たれる。以前は
    // 常に 1 ページ目 (`LIMIT 既定件数`) を取り直していたため、2 ページ目以降や
    // 「さらに読み込む」で表示した行を編集すると、Apply 後に表示が先頭ページへ戻り、
    // 編集対象の行が消えたり編集前の値に見えたりしていた。
    const hasInserts = (tab.pendingInserts ?? []).length > 0;
    if (hasInserts && paginatable) {
      // 新規行はサーバが採番する PK (AUTO_INCREMENT など) を取り込む必要があるため、
      // ここだけは再取得して反映する。
      const limit = Math.max(1, settings.defaultDisplayCount);
      patchTab(tabId, (tt) => ({ ...tt, pendingDeletes: [], pendingInserts: [] }));
      runQueryInTab(tabId, `${paginatable} LIMIT ${limit}`, paginatable);
    } else {
      patchTab(tabId, (tt) => {
        // Apply 実行中 (await 中) に追加/上書きされた編集は DB へ送信されていない
        // ため、送信済みスナップショット (`pendingEdits`、この関数冒頭で捕捉) だけを
        // グリッドへ反映し pendingEdits から取り除く。それ以外の新規編集は pending
        // のまま保持する (#F2)。
        if (!tt.result) {
          return {
            ...tt,
            pendingEdits: pendingEditsAfterApply(tt.pendingEdits, pendingEdits),
            editUndoStack: [],
            editRedoStack: [],
            preview: null,
            pendingDeletes: [],
            pendingInserts: [],
          };
        }
        const nextRows = applyEditsToRows({
          columns: tt.result.columns,
          rows: tt.result.rows,
          pkIndices,
          edits: pendingEdits,
          deleteKeys: new Set(tt.pendingDeletes ?? []),
        });
        return {
          ...tt,
          result: { ...tt.result, rows: nextRows, rows_affected: nextRows.length },
          pendingEdits: pendingEditsAfterApply(tt.pendingEdits, pendingEdits),
          editUndoStack: [],
          editRedoStack: [],
          preview: null,
          pendingDeletes: [],
          pendingInserts: [],
        };
      });
    }
    patchTab(tabId, (tt) => ({ ...tt, lastEditAppliedAt: Date.now() }));
    setStatus({
      kind: "key",
      key: "statusAppliedEdits",
      vars: { rows: totalAffected, count: stmts.length },
    });
  }, [
    sessionId,
    patchTab,
    runQueryInTab,
    settings.defaultDisplayCount,
    selectedProfile?.driver,
    selectedProfile?.is_production,
    selectedProfile?.confirm_writes,
    readOnly,
    confirm,
  ]);

  // 行を削除予定にトグルする。
  const toggleRowDeleteForTab = useCallback((tabId: string, rowKey: string) => {
    patchTab(tabId, (tt) => {
      const cur = tt.pendingDeletes ?? [];
      const next = cur.includes(rowKey) ? cur.filter((k) => k !== rowKey) : [...cur, rowKey];
      return { ...tt, pendingDeletes: next };
    });
  }, [patchTab]);

  // 新規行追加モーダルを開く。
  const requestInsertRowForTab = useCallback((tabId: string) => {
    setRowInsertTabId(tabId);
  }, []);

  // モーダルで確定した新規行を保留に追加する。
  const addInsertRowForTab = useCallback((tabId: string, row: PendingInsertRow) => {
    setRowInsertTabId(null);
    patchTab(tabId, (tt) => ({ ...tt, pendingInserts: [...(tt.pendingInserts ?? []), row] }));
  }, [patchTab]);

  // 行操作 (追加/削除) の保留を破棄する。
  const discardRowOpsForTab = useCallback((tabId: string) => {
    patchTab(tabId, (tt) => ({ ...tt, pendingDeletes: [], pendingInserts: [] }));
  }, [patchTab]);

  const handleOpenTable = useCallback((database: string, table: string) => {
    recordRecentTableOpen(database, table);
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
      ...makeTab("table", table, sql),
      database,
      table,
      previewRowLimit: limit,
      paginatable: base,
      page: 1,
      pageSize: limit,
      rowEstimateTotal: null,
    };
    addTab(tab);
    runQueryInTab(tab.id, sql, base);
    // ページネーションの総ページ数目安に使う行数推定を取得 (ベストエフォート)。
    if (sessionId) {
      void api
        .tableRowEstimates(sessionId, database)
        .then((list) => {
          const est = list.find((e) => e.name === table)?.estimate ?? null;
          if (est != null) patchTab(tab.id, (tt) => ({ ...tt, rowEstimateTotal: est }));
        })
        .catch(() => {});
    }
  }, [tabs, runQueryInTab, addTab, activateTab, settings.defaultDisplayCount, selectedProfile?.driver, recordRecentTableOpen, sessionId, patchTab]);

  const handleImportTable = useCallback((database: string, table: string) => {
    setImportTarget({ database, table });
  }, []);

  // テストデータ生成ウィザード (#602) を開く。
  const handleGenerateTestData = useCallback((database: string, table: string) => {
    setTestDataTarget({ database, table });
  }, []);

  const handleDumpDatabase = useCallback((database: string) => {
    setDumpTarget(database);
  }, []);

  const handleSchemaExport = useCallback((database: string) => {
    setSchemaExportTarget(database);
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

  // SQL を実行せずに新しいクエリタブのエディタへ流し込む (「エディタへ送る」)。
  const openQueryInEditor = useCallback((sql: string, title?: string) => {
    const tab: Tab = { ...makeQueryTab(), sql };
    if (title) tab.title = title;
    addTab(tab);
  }, [addTab]);

  // スキーマオブジェクトの定義 DDL を取得して読み取り用のクエリタブに表示する。
  const handleOpenObjectDefinition = useCallback(async (database: string, kind: string, name: string, id: string | null) => {
    if (!sessionId) return;
    try {
      const ddl = await api.getObjectDefinition(sessionId, database, kind, name, id);
      openQueryInEditor(ddl, name);
    } catch (e) {
      toast.error(translate("objDefinitionError", { error: String(e) }));
    }
  }, [sessionId, openQueryInEditor, toast]);

  // CREATE TABLE ウィザードの実行: DDL を新しいクエリタブで実行し、閉じる。
  const handleCreateTableRun = useCallback((sql: string) => {
    setCreateTableDb(null);
    openAndRunQuery(sql);
  }, [openAndRunQuery]);

  const handleCreateTableToEditor = useCallback((sql: string) => {
    setCreateTableDb(null);
    openQueryInEditor(sql);
  }, [openQueryInEditor]);

  // テーブル保守操作: DDL を実行し、スキーマキャッシュとツリーを更新する。
  const runMaintenanceDdl = useCallback(async (sql: string, database: string): Promise<boolean> => {
    if (!sessionId) return false;
    try {
      await api.runQuery(sessionId, sql, database);
      invalidateSchemaCache(database);
      connectionListRef.current?.refreshSchema();
      return true;
    } catch (e) {
      toast.error(translate("statusQueryError", { error: String(e) }));
      return false;
    }
  }, [sessionId, invalidateSchemaCache, toast]);

  const handleCopyTableName = useCallback(async (table: string) => {
    if (await copyToClipboard(table)) {
      toast.success(translate("tableNameCopied", { table }));
    }
  }, [toast]);

  // 破壊的操作の確認メッセージ。本番接続では追加警告を添える。
  const maintenanceMessage = useCallback((body: ReactNode): ReactNode => {
    if (selectedProfile?.is_production) {
      return (
        <>
          {body}
          <br />
          <br />
          <strong>{translate("maintenanceProductionWarning")}</strong>
        </>
      );
    }
    return body;
  }, [selectedProfile?.is_production]);

  const handleTruncateTable = useCallback(async (database: string, table: string) => {
    // 不可逆 (TRUNCATE) × 本番接続では、対象テーブル名のタイプ入力を要求する
    // 強確認ゲートを追加する (#675)。非本番はこれまで通り 1 クリック確認。
    const ok = await confirm({
      title: translate("truncateConfirmTitle", { table }),
      message: maintenanceMessage(translate("truncateConfirmBody", { table })),
      confirmLabel: translate("truncateConfirmOk"),
      tone: "danger",
      typedConfirmation: selectedProfile?.is_production ? table : undefined,
    });
    if (!ok) return;
    const driver = selectedProfile?.driver ?? "mysql";
    await runMaintenanceDdl(buildTruncateSql(driver, database, table), database);
  }, [confirm, maintenanceMessage, selectedProfile?.driver, selectedProfile?.is_production, runMaintenanceDdl]);

  const handleDropTable = useCallback(async (database: string, table: string) => {
    // 不可逆 (DROP) × 本番接続では同様にタイプ入力の強確認ゲートを追加する (#675)。
    const ok = await confirm({
      title: translate("dropConfirmTitle", { table }),
      message: maintenanceMessage(translate("dropConfirmBody", { table })),
      confirmLabel: translate("dropConfirmOk"),
      tone: "danger",
      typedConfirmation: selectedProfile?.is_production ? table : undefined,
    });
    if (!ok) return;
    const driver = selectedProfile?.driver ?? "mysql";
    const success = await runMaintenanceDdl(buildDropTableSql(driver, database, table), database);
    if (success) {
      // 開いている対象テーブルのタブは整合性が取れなくなるので閉じる。
      tabsRef.current
        .filter((tt) => tt.kind === "table" && tt.database === database && tt.table === table)
        .forEach((tt) => handleCloseTabRef.current(tt.id));
    }
  }, [confirm, maintenanceMessage, selectedProfile?.driver, selectedProfile?.is_production, runMaintenanceDdl]);

  const handleRenameTableSubmit = useCallback(async (newName: string) => {
    const target = renameTarget;
    setRenameTarget(null);
    const trimmedName = newName.trim();
    if (!target || !trimmedName || trimmedName === target.table) return;
    const driver = selectedProfile?.driver ?? "mysql";
    const success = await runMaintenanceDdl(
      buildRenameTableSql(driver, target.database, target.table, trimmedName),
      target.database,
    );
    if (success) {
      // 開いている対象テーブルのタブは旧名のままなので閉じる (新名で開き直せる)。
      tabsRef.current
        .filter((tt) => tt.kind === "table" && tt.database === target.database && tt.table === target.table)
        .forEach((tt) => handleCloseTabRef.current(tt.id));
    }
  }, [renameTarget, selectedProfile?.driver, runMaintenanceDdl]);

  // テーブル保守コマンド (ANALYZE / OPTIMIZE / VACUUM / REINDEX 等)。#561。
  // 生成済み SQL を確認ダイアログで提示し、承認後に既存のクエリ経路で実行する。
  // データは消さないが書き込み/ロックを伴うため、本番接続では追加警告を出す。
  const handleRunTableMaintenance = useCallback(
    async (database: string, table: string, command: MaintenanceCommand) => {
      const ok = await confirm({
        title: translate("maintenanceConfirmTitle", { table }),
        message: maintenanceMessage(
          <>
            {translate("maintenanceConfirmBody", { target: table })}
            <br />
            <br />
            <chakra.code
              display="block"
              fontFamily="var(--font-mono)"
              fontSize="sm"
              whiteSpace="pre-wrap"
              wordBreak="break-all"
            >
              {command.sql}
            </chakra.code>
          </>,
        ),
        confirmLabel: translate("maintenanceConfirmOk"),
      });
      if (!ok) return;
      const success = await runMaintenanceDdl(command.sql, database);
      if (success) toast.success(translate("maintenanceDone", { target: table }));
    },
    [confirm, maintenanceMessage, runMaintenanceDdl, toast],
  );

  // DB 全体の保守コマンド (SQLite VACUUM / PostgreSQL VACUUM・ANALYZE 等)。#561。
  const handleRunDatabaseMaintenance = useCallback(
    async (database: string, command: MaintenanceCommand) => {
      const ok = await confirm({
        title: translate("maintenanceConfirmDbTitle", { database }),
        message: maintenanceMessage(
          <>
            {translate("maintenanceConfirmBody", { target: database })}
            <br />
            <br />
            <chakra.code
              display="block"
              fontFamily="var(--font-mono)"
              fontSize="sm"
              whiteSpace="pre-wrap"
              wordBreak="break-all"
            >
              {command.sql}
            </chakra.code>
          </>,
        ),
        confirmLabel: translate("maintenanceConfirmOk"),
      });
      if (!ok) return;
      const success = await runMaintenanceDdl(command.sql, database);
      if (success) toast.success(translate("maintenanceDone", { target: database }));
    },
    [confirm, maintenanceMessage, runMaintenanceDdl, toast],
  );

  // サイズ・統計ダッシュボードを対象 DB で開く。#562。他の全画面ビューは閉じる。
  const handleShowDatabaseSizes = useCallback((database: string) => {
    setEditing(null);
    setShowForm(false);
    setShowSettings(false);
    setShowHelp(false);
    setShowCompare(false);
    setShowErd(false); setShowProcesses(false); setShowCompareResults(false);
    setShowServerInfo(false); setShowQueryInspector(false);
    setShowSnippetForm(false);
    setSizesTarget(database);
  }, []);

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

  // 接続リスト (ConnectionList) のフォーム系コールバックは memo 化した子へ安定参照
  // で渡すため useCallback で固定する。依存は useState セッター (安定) と
  // モジュールレベルの `t`・`api`、useCallback 済みの refreshProfiles のみ。
  const handleOpenCreateForm = useCallback(() => {
    setEditing(null);
    setShowSettings(false);
    setShowHelp(false);
    setShowCompare(false);
    setShowErd(false); setShowProcesses(false); setShowCompareResults(false);
    setShowServerInfo(false); setShowQueryInspector(false); setSizesTarget(null);
    setShowSnippetForm(false);
    setShowForm(true);
    setFormInstanceId((n) => n + 1);
  }, []);
  const handleOpenEditForm = useCallback((p: ConnectionProfile) => {
    setEditing(p);
    setShowSnippetForm(false);
    setShowSettings(false);
    setShowHelp(false);
    setShowCompare(false);
    setShowErd(false); setShowProcesses(false); setShowCompareResults(false);
    setShowServerInfo(false); setShowQueryInspector(false); setSizesTarget(null);
    setShowForm(true);
    setFormInstanceId((n) => n + 1);
  }, []);
  const handleDuplicateProfile = useCallback((p: ConnectionProfile) => {
    // Open the form pre-filled with the source profile's non-secret settings as
    // a brand-new entry: blank id forces save_profile to mint a fresh id, and
    // secrets (password/passphrase) are never carried over from the keyring.
    setEditing({ ...p, id: "", name: `${p.name}${t("listDuplicateSuffix")}` });
    setShowSnippetForm(false);
    setShowSettings(false);
    setShowHelp(false);
    setShowCompare(false);
    setShowErd(false); setShowProcesses(false); setShowCompareResults(false);
    setShowServerInfo(false); setShowQueryInspector(false); setSizesTarget(null);
    setShowForm(true);
    setFormInstanceId((n) => n + 1);
  }, []);
  const handleDeleteProfile = useCallback(async (id: string) => {
    await runWithErrorStatus(async () => {
      await api.deleteProfile(id);
      await refreshProfiles();
    }, "statusFailedDeleteProfile");
  }, [runWithErrorStatus, refreshProfiles]);

  // ウェルカム画面 (#599) の「SQLite ファイルを開く」導線。選ばれたファイルパスと
  // sqlite ドライバを初期値にした空のプロファイルを editing にセットしてフォームを
  // 開く (id を空にすることで保存時に新規プロファイルとして作られる。
  // handleDuplicateProfile と同じ「blank id」方式)。
  const handleWelcomeOpenSqlite = useCallback((filePath: string) => {
    setEditing({
      id: "",
      name: "",
      driver: "sqlite",
      host: "",
      port: 0,
      user: "",
      database: null,
      ssh: null,
      group: null,
      color: null,
      is_production: false,
      confirm_writes: false,
      read_only: false,
      skip_history: false,
      file_path: filePath,
    });
    setShowSnippetForm(false);
    setShowSettings(false);
    setShowHelp(false);
    setShowCompare(false);
    setShowErd(false); setShowProcesses(false); setShowCompareResults(false);
    setShowServerInfo(false); setShowQueryInspector(false); setSizesTarget(null);
    setShowForm(true);
    setFormInstanceId((n) => n + 1);
  }, []);

  // ウェルカム画面 (#599) の「はじめかたを見る」、およびサイドバーの「+」から
  // 新規スニペットフォームを開く共通ハンドラ。
  const handleOpenSnippetForm = useCallback(() => {
    setEditingSnippet(null);
    setSnippetFormSql("");
    setShowSettings(false);
    setShowHelp(false);
    setShowCompare(false);
    setShowErd(false); setShowProcesses(false); setShowCompareResults(false);
    setShowServerInfo(false); setShowQueryInspector(false); setSizesTarget(null);
    setShowForm(false);
    setShowSnippetForm(true);
    setFormInstanceId((n) => n + 1);
  }, []);

  // オンボーディングツアー (#599) の開始/終了。終了はスキップ・完了・Esc の
  // いずれからも呼ばれ、表示済みフラグを永続化して以後の自動起動を止める。
  const handleStartTour = useCallback(() => {
    setShowTour(true);
  }, []);
  const handleCloseTour = useCallback(() => {
    onboarding.markShown();
    setShowTour(false);
  }, []);

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

  /**
   * ウィンドウへドロップされたファイル群を拡張子で振り分けて処理する。
   * - `.sql` / `.txt` … 内容を読んで新規クエリタブとして開く (複数なら複数タブ)。
   * - `.csv` / `.tsv` … アクティブなテーブルタブがあれば ImportModal を事前選択
   *   パス付きで開く (ImportModal は単一ファイルなので先頭のみ)。
   * - 非対応拡張子 … トーストで明示的に拒否する。
   * 最新のセッション/アクティブタブは ref 経由で読むため、購読は貼り直さない。
   */
  const handleFilesDropped = useCallback(async (paths: string[]) => {
    if (paths.length === 0) return;
    const sqlPaths = paths.filter((p) => classifyDroppedFile(p) === "sql");
    const csvPaths = paths.filter((p) => classifyDroppedFile(p) === "csv");
    const unsupported = paths.filter((p) => classifyDroppedFile(p) === "unsupported");

    // .sql / .txt → 新規クエリタブ。
    let openedSql = 0;
    for (const p of sqlPaths) {
      try {
        const content = await api.readTextFile(p);
        addTab({
          ...makeQueryTab(),
          title: fileBaseName(p),
          sql: content,
          lastExecutedSql: content,
        });
        openedSql += 1;
      } catch (e) {
        toast.error(translate("dropReadError", { name: fileBaseName(p), error: String(e) }));
      }
    }
    if (openedSql === 1 && sqlPaths.length === 1) {
      toast.success(translate("dropOpenedSql", { name: fileBaseName(sqlPaths[0]) }));
    } else if (openedSql > 1) {
      toast.success(translate("dropOpenedSqlMulti", { count: openedSql }));
    }

    // .csv / .tsv → ImportModal (アクティブなテーブルタブが対象)。
    if (csvPaths.length > 0) {
      const tab = activeTabRef.current;
      if (!sessionIdRef.current || !tab || tab.kind !== "table" || !tab.database || !tab.table) {
        toast.error(translate("dropCsvNoTable"));
      } else {
        if (csvPaths.length > 1) {
          toast.info(translate("dropCsvMultiOnlyFirst"));
        }
        setImportInitialPath(csvPaths[0]);
        setImportTarget({ database: tab.database, table: tab.table });
      }
    }

    // 非対応ファイル。
    if (unsupported.length > 0) {
      toast.error(translate("dropUnsupported", { name: fileBaseName(unsupported[0]) }));
    }
  }, [addTab, toast]);

  // Tauri のウィンドウ drag-drop イベントを購読する。enter でファイル群の
  // 受理可否を判定してオーバーレイ用の状態を立て、drop で実際に振り分ける。over は
  // 座標のみでパスを持たないため、enter で得た判定をそのまま維持する。`leave` /
  // `drop` でオーバーレイを畳む。`dragDropEnabled` は Tauri v2 で既定 true のため、
  // tauri.conf.json の追加設定は不要 (capabilities も core イベントで足りる)。
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let disposed = false;
    void (async () => {
      try {
        const webview = getCurrentWebview();
        const un = await webview.onDragDropEvent((event) => {
          const payload = event.payload;
          if (payload.type === "enter") {
            setDragFeedback(dragFeedbackFor(payload.paths));
          } else if (payload.type === "leave") {
            setDragFeedback(null);
          } else if (payload.type === "drop") {
            setDragFeedback(null);
            void handleFilesDropped(payload.paths);
          }
        });
        if (disposed) un();
        else unlisten = un;
      } catch {
        // 非 Tauri 環境 (ブラウザテスト等) では webview が無いので無視する。
      }
    })();
    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }, [handleFilesDropped]);

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
  // and focusing the result search. Editor-scoped shortcuts
  // (run/preview/format) live in QueryEditor's CodeMirror keymap so they only
  // fire while the editor has focus. These are gated to the tabbed view so
  // they never fire over the Help/Settings/Form panels.
  useEffect(() => {
    if (!sessionId || showForm || showSettings || showHelp || showCompare || showCompareResults || showErd || showProcesses || showServerInfo || showQueryInspector || showSizes || showSnippetForm || showCommandPalette || showCheatSheet) return;
    const focusedPane = () =>
      panesRef.current.find((p) => p.id === activePaneIdRef.current) ?? panesRef.current[0] ?? null;
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      // Cmd/Ctrl+F → open the focused pane's find-in-results bar (#644; no
      // Shift so the editor's Cmd/Ctrl+Shift+F format shortcut is left alone).
      // When focus is inside the query editor (CodeMirror), defer to its own
      // in-editor find/replace instead of stealing the shortcut.
      if (comboMatchesEvent(bindingsRef.current.resultSearch, e)) {
        if ((e.target as HTMLElement | null)?.closest?.(".cm-editor")) return;
        const grid = resultGridRefs.current.get(activePaneIdRef.current ?? "");
        if (grid) {
          e.preventDefault();
          grid.openFind();
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
      if (comboMatchesEvent(bindingsRef.current.newTab, e)) {
        e.preventDefault();
        handleNewTab();
        return;
      }
      if (comboMatchesEvent(bindingsRef.current.closeTab, e)) {
        // Always suppress the webview's default "close window" while in the
        // tabbed workspace.
        e.preventDefault();
        const active = focusedPane()?.activeTabId;
        if (active) handleCloseTabRef.current(active);
        return;
      }
      // n 番目のタブへのジャンプ (Cmd/Ctrl+1〜9) は再割り当て対象外。
      if (!mod || e.altKey || e.shiftKey) return;
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
  }, [sessionId, showForm, showSettings, showHelp, showCompare, showCompareResults, showErd, showProcesses, showServerInfo, showQueryInspector, showSizes, showSnippetForm, showCommandPalette, showCheatSheet, handleNewTab, selectTab]);

  // Cmd/Ctrl+K でコマンドパレットを開閉する。接続前でも (接続切替・設定/ヘルプ
  // 遷移のため) 使えるよう、上の workspace ショートカットと違い常時有効にする。
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (comboMatchesEvent(bindingsRef.current.commandPalette, e)) {
        e.preventDefault();
        setShowCommandPalette((v) => !v);
      }
      // スキーマ横断のグローバルオブジェクト検索。接続中のみ。
      if (comboMatchesEvent(bindingsRef.current.objectSearch, e)) {
        e.preventDefault();
        if (sessionIdRef.current) setShowObjectSearch((v) => !v);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // 複数結果タブ: Cmd/Ctrl+Shift+Enter で、アクティブなクエリタブの SQL を
  // 結果を残したまま**新しいタブ**で実行する (設定 resultsInNewTab の一回限り版)。
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (comboMatchesEvent(bindingsRef.current.runNewTab, e)) {
        const t = activeTab;
        if (t && t.kind === "query" && t.sql.trim() && sessionId) {
          e.preventDefault();
          runInTabWithGate(t, t.sql, { newTab: true });
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeTab, sessionId, runInTabWithGate]);

  // Cmd/Ctrl+Z / Cmd/Ctrl+Shift+Z で、アクティブなテーブルタブの未適用インライン
  // セル編集を Undo / Redo する。トーストやツールバーのボタンと同じ編集
  // スタックを操作する。テキスト入力 (セル編集の input / CodeMirror エディタ /
  // その他の input・textarea) にフォーカスがある間は介入せず、その場のネイティブ
  // undo に委ねる (フォーカス文脈での衝突を避ける受け入れ条件)。各種オーバーレイ
  // 表示中も発火させない。スタックが空のときは preventDefault せず素通しする。
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || e.altKey || e.key.toLowerCase() !== "z") return;
      if (
        showForm || showSettings || showHelp || showCompare || showCompareResults || showErd || showProcesses || showServerInfo || showQueryInspector || showSizes ||
        showSnippetForm || showCommandPalette || showObjectSearch || showCheatSheet
      ) {
        return;
      }
      const tab = activeTab;
      if (!tab || tab.kind !== "table") return;
      // テキスト編集文脈ではネイティブ undo を優先 (誤発火防止)。
      const el = document.activeElement as HTMLElement | null;
      if (el) {
        const tag = el.tagName;
        if (
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          tag === "SELECT" ||
          el.isContentEditable ||
          el.closest(".cm-editor")
        ) {
          return;
        }
      }
      if (e.shiftKey) {
        if ((tab.editRedoStack?.length ?? 0) === 0) return;
        e.preventDefault();
        redoCellEditForTab(tab.id);
      } else {
        if ((tab.editUndoStack?.length ?? 0) === 0) return;
        e.preventDefault();
        undoCellEditForTab(tab.id);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    activeTab,
    showForm,
    showSettings,
    showHelp,
    showCompare,
    showCompareResults,
    showErd,
    showProcesses,
    showServerInfo,
    showQueryInspector,
    showSizes,
    showSnippetForm,
    showCommandPalette,
    showObjectSearch,
    showCheatSheet,
    undoCellEditForTab,
    redoCellEditForTab,
  ]);

  // 接続のヘルスチェックと自動再接続。ウィンドウがフォーカスを取り戻したとき
  // (= OS スリープ復帰やタブ切り替え後) に SELECT 1 で接続が生きているか確認し、死んで
  // いれば統一ハンドラ (自動再接続 or 手動フォールバック) に倒す。トンネル断やスリープ
  // 復帰で「次のクエリが急に失敗する」体験を緩和する。同時実行は healthCheckBusyRef で
  // 1 件に絞り、再接続ループ実行中・非接続状態では走らせない (#600)。
  useEffect(() => {
    if (!sessionId || !selectedProfile) return;
    const onFocus = async () => {
      if (healthCheckBusyRef.current || connectingId || reconnectingRef.current) return;
      if (connectionStatusRef.current !== "connected") return;
      healthCheckBusyRef.current = true;
      try {
        const alive = await api.pingSession(sessionId);
        if (!alive) {
          await handleConnectionLostRef.current();
        }
      } catch {
        // セッションが既に消えている等は無視 (UI 側で切断扱い)。
      } finally {
        healthCheckBusyRef.current = false;
      }
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [sessionId, selectedProfile, connectingId]);

  // Cmd/Ctrl+P でサイドバーの接続・スキーマフィルタにフォーカスする。
  // 接続タブが選択されていなければ切り替えてからフォーカスする。
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (comboMatchesEvent(bindingsRef.current.sidebarFilter, e)) {
        e.preventDefault();
        setSidebarTab("connections");
        requestAnimationFrame(() => connectionListRef.current?.focusFilter());
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // `?` (Shift+/) でショートカット チートシートを開閉する。入力欄・
  // CodeMirror エディタにフォーカスがある間は `?` を文字入力として通し、奪わない
  // (誤発火防止)。他のモーダル/フォームが開いている間も発火させない。
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "?" || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = document.activeElement as HTMLElement | null;
      if (el) {
        const tag = el.tagName;
        if (
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          tag === "SELECT" ||
          el.isContentEditable ||
          el.closest(".cm-editor")
        ) {
          return;
        }
      }
      // チートシート以外のオーバーレイが開いているときは介入しない。
      if (showForm || showSettings || showHelp || showCompare || showCompareResults || showSnippetForm || showCommandPalette) {
        return;
      }
      e.preventDefault();
      setShowCheatSheet((v) => !v);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [showForm, showSettings, showHelp, showCompare, showCompareResults, showSnippetForm, showCommandPalette]);

  // 結果最大化 (Cmd/Ctrl+Shift+M) / エディタ集中 (Cmd/Ctrl+Shift+E) のトグルと、
  // どちらかが有効なときの Esc での復元。他のオーバーレイ表示中は介入しない。
  // Esc は入力欄/エディタにフォーカスがある間はその場のローカル Esc 処理
  // (検索クリア等) を優先し、奪わない。
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const overlayOpen =
        showForm || showSettings || showHelp || showCompare || showCompareResults || showErd || showProcesses || showServerInfo || showQueryInspector || showSizes ||
        showSnippetForm || showCommandPalette || showObjectSearch || showCheatSheet;
      if (comboMatchesEvent(bindingsRef.current.maximizeResult, e)) {
        if (overlayOpen || !sessionIdRef.current) return;
        e.preventDefault();
        setLayoutMode((m) => toggleLayoutMode(m, "result"));
        return;
      }
      if (comboMatchesEvent(bindingsRef.current.focusEditor, e)) {
        if (overlayOpen || !sessionIdRef.current) return;
        e.preventDefault();
        setLayoutMode((m) => toggleLayoutMode(m, "editor"));
        return;
      }
      if (e.key === "Escape" && layoutMode !== "normal") {
        const el = document.activeElement as HTMLElement | null;
        if (el) {
          const tag = el.tagName;
          if (
            tag === "INPUT" ||
            tag === "TEXTAREA" ||
            tag === "SELECT" ||
            el.isContentEditable ||
            el.closest(".cm-editor")
          ) {
            return;
          }
        }
        e.preventDefault();
        setLayoutMode("normal");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    layoutMode,
    showForm,
    showSettings,
    showHelp,
    showCompare,
    showCompareResults,
    showErd,
    showProcesses,
    showServerInfo,
    showQueryInspector,
    showSizes,
    showSnippetForm,
    showCommandPalette,
    showObjectSearch,
    showCheatSheet,
  ]);

  // レイアウトモードは接続状態に依らず保持し、再起動・再接続でも復元する (#618)。
  // 全画面オーバーレイはフォーカス中ペインにアクティブタブがあるときだけ描画される
  // (renderPane の `maximized` / `editorFocused` ガード) ため、未接続・タブなしの
  // 状態では自動的に通常表示になり、「全画面のまま始まる」ことはない。復元を妨げない
  // よう、ここで明示的に normal へ戻すことはしない。

  // コマンドパレットの候補。接続プロファイル・現在接続のテーブル (キャッシュ済み
  // スキーマ由来)・スニペット・直近履歴・画面遷移を 1 リストに束ねる。各 `run` は
  // パレット側で実行直後にパレットを閉じる。
  const openFullView = useCallback((view: "settings" | "help" | "compare" | "erDiagram" | "processes" | "serverInfo" | "queryInspector" | "compareResults" | "newConnection") => {
    setEditing(null);
    setShowForm(false);
    setShowSettings(false);
    setShowHelp(false);
    setShowCompare(false);
    setShowErd(false); setShowProcesses(false); setShowCompareResults(false);
    setShowServerInfo(false); setShowQueryInspector(false); setSizesTarget(null);
    setShowSnippetForm(false);
    if (view === "settings") setShowSettings(true);
    else if (view === "help") setShowHelp(true);
    else if (view === "compare") setShowCompare(true);
    else if (view === "erDiagram") setShowErd(true);
    else if (view === "processes") setShowProcesses(true);
    else if (view === "serverInfo") setShowServerInfo(true);
    else if (view === "queryInspector") setShowQueryInspector(true);
    else if (view === "compareResults") setShowCompareResults(true);
    else if (view === "newConnection") {
      setShowForm(true);
      setFormInstanceId((n) => n + 1);
    }
  }, []);

  // パレットの「現在の DB」を要する項目 (スキーマエクスポート等) の対象 DB。
  const paletteDatabase = activeTab?.database ?? selectedProfile?.database ?? null;

  const commandItems = useMemo<CommandItem[]>(() => {
    const items: CommandItem[] = [];

    // 画面遷移・グローバル操作。
    if (sessionId) {
      items.push({
        id: "nav:new-query-tab",
        group: "navigation",
        label: t("cmdkActionNewQueryTab"),
        icon: "plus",
        keywords: "query tab editor クエリ タブ",
        run: () => handleNewTab(),
      });
      items.push({
        id: "nav:er-diagram",
        group: "navigation",
        label: t("cmdkActionErDiagram"),
        icon: "er-diagram",
        keywords: "er diagram schema relations foreign key 図 スキーマ 関係 外部キー",
        run: () => openFullView("erDiagram"),
      });
      if (paletteDatabase) {
        items.push({
          id: "nav:schema-export",
          group: "navigation",
          label: t("cmdkActionSchemaExport"),
          icon: "database",
          keywords: "schema export ai markdown claude llm スキーマ 出力 エクスポート",
          run: () => setSchemaExportTarget(paletteDatabase),
        });
      }
    }
    items.push(
      {
        id: "nav:new-connection",
        group: "navigation",
        label: t("cmdkActionNewConnection"),
        icon: "link",
        keywords: "connection profile 接続 新規",
        run: () => openFullView("newConnection"),
      },
      {
        id: "nav:settings",
        group: "navigation",
        label: t("cmdkActionSettings"),
        icon: "settings",
        keywords: "settings preferences 設定",
        run: () => openFullView("settings"),
      },
      {
        id: "nav:help",
        group: "navigation",
        label: t("cmdkActionHelp"),
        icon: "help",
        keywords: "help docs ヘルプ",
        run: () => openFullView("help"),
      },
      {
        id: "nav:compare",
        group: "navigation",
        label: t("cmdkActionCompare"),
        icon: "diff",
        keywords: "schema compare diff スキーマ 比較",
        run: () => openFullView("compare"),
      },
      {
        id: "nav:compare-results",
        group: "navigation",
        label: t("appPinCompare", { count: pinnedResults.length }),
        icon: "pin",
        keywords: "pin pinned result compare diff ピン 結果 比較 差分",
        run: () => openFullView("compareResults"),
      },
      {
        id: "nav:toggle-theme",
        group: "navigation",
        label: t("cmdkActionToggleTheme"),
        icon: theme === "dark" ? "sun" : "moon",
        keywords: "theme dark light テーマ ダーク ライト",
        run: () => toggleTheme(),
      },
    );
    if (sessionId) {
      items.push({
        id: "nav:disconnect",
        group: "navigation",
        label: t("cmdkActionDisconnect"),
        icon: "unplug",
        keywords: "disconnect close 切断",
        run: () => void handleDisconnect(),
      });
    }

    // 接続プロファイル。
    for (const profile of profiles) {
      const isSqlite = profile.driver === "sqlite";
      const sublabel = isSqlite
        ? profile.file_path ?? ""
        : `${profile.user}@${profile.host}:${profile.port}${profile.database ? ` · ${profile.database}` : ""}`;
      const badges: string[] = [profile.driver.toUpperCase()];
      if (profile.is_production) badges.push(t("listProduction"));
      if (profile.read_only) badges.push(t("listReadOnly"));
      if (sessionId && selectedProfile?.id === profile.id) badges.push(t("cmdkBadgeConnected"));
      items.push({
        id: `conn:${profile.id}`,
        group: "connections",
        label: profile.name,
        sublabel: sublabel || undefined,
        keywords: `${profile.driver} ${profile.host} ${profile.database ?? ""} ${profile.group ?? ""}`,
        icon: "link",
        badges,
        run: () => void handleConnect(profile),
      });
    }

    // 現在の接続でキャッシュ済みのスキーマからテーブルを列挙する。
    if (sessionId) {
      const prefix = `${sessionId}\0`;
      for (const [key, schema] of Object.entries(schemaCache)) {
        if (!key.startsWith(prefix)) continue;
        const database = key.slice(prefix.length);
        for (const table of schema) {
          items.push({
            id: `table:${database}\0${table.name}`,
            group: "tables",
            label: table.name,
            sublabel: database,
            keywords: `${database} ${table.columns.join(" ")}`,
            icon: "table",
            run: () => handleRunTableSelect(database, table.name),
          });
        }
      }
    }

    // スニペット。
    for (const snippet of snippets) {
      items.push({
        id: `snippet:${snippet.id}`,
        group: "snippets",
        label: snippet.name,
        sublabel: snippet.folder ?? undefined,
        keywords: `${snippet.tags.join(" ")} ${snippet.sql}`,
        icon: "snippet",
        run: () => handleInsertSnippet(snippet),
      });
    }

    // 直近のクエリ履歴 (最新優先、件数を抑える)。
    for (const [i, sql] of queryHistory.slice(0, 40).entries()) {
      items.push({
        id: `history:${i}`,
        group: "history",
        label: singleLine(sql),
        keywords: sql,
        icon: "clock",
        run: () => handleRestoreHistory(sql),
      });
    }

    return items;
  }, [
    sessionId,
    selectedProfile?.id,
    paletteDatabase,
    profiles,
    schemaCache,
    snippets,
    queryHistory,
    theme,
    t,
    locale,
    handleNewTab,
    handleDisconnect,
    handleConnect,
    handleRunTableSelect,
    handleInsertSnippet,
    handleRestoreHistory,
    openFullView,
    toggleTheme,
    pinnedResults.length,
  ]);

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
    if (raw == null) return null;
    // Prefer the structured `AppError.kind` when the error path carried it
    // (#683); otherwise fall back to matching the raw message text.
    return resolveErrorHint({ kind: status.errorKind ?? null, message: String(raw) });
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
  // the status bar so it is never permanently suppressed by a prior dismissal.
  useEffect(() => {
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
    // フォーカス中ペインのアクティブタブの結果/エディタをモーダル全画面化するか。
    // CSS でラッパを position: fixed の全画面オーバーレイに切り替えるため、React の
    // 要素ツリーは保たれグリッドの状態 (スクロール/選択) やエディタの内容も維持される。
    const maximized = layoutMode === "result" && isFocused && tab != null;
    const editorFocused = layoutMode === "editor" && isFocused && tab != null;
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
          onReorder={(ids) => reorderTabsInPane(pane.id, ids)}
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
              transition={transitions.fade}
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
                  animation: "query-progress-slide var(--dur-progress-loop) var(--ease) infinite",
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
                <Box
                  display="flex"
                  flexDirection="column"
                  minH={0}
                  minW={0}
                  className={editorFocused ? "pane-overlay" : undefined}
                  {...(editorFocused
                    ? {
                        // エディタ集中モード: エディタを全画面オーバーレイ化する。
                        // タイトルバー (高さ 38px) は覆わずウィンドウ操作を残す。
                        position: "fixed" as const,
                        top: "38px",
                        left: 0,
                        right: 0,
                        bottom: 0,
                        zIndex: "modal" as const,
                        bg: "app.surface",
                        boxShadow: "lg",
                      }
                    : { flex: "1", position: "relative" as const })}
                >
                  {editorFocused && (
                    <Flex
                      align="center"
                      gap="2"
                      px="3"
                      py="1.5"
                      flex="none"
                      borderBottomWidth="1px"
                      borderBottomColor="app.border"
                      bg="app.toolbar"
                    >
                      <Icon name="maximize" size={14} />
                      <chakra.span
                        fontSize="sm"
                        color="app.text"
                        fontWeight={500}
                        overflow="hidden"
                        textOverflow="ellipsis"
                        whiteSpace="nowrap"
                      >
                        {tab.title}
                      </chakra.span>
                      <chakra.span flex="1" />
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={() => setLayoutMode("normal")}
                        title={t("editorRestoreTitle")}
                      >
                        <Icon name="minimize" size={14} /> {t("editorFocusedLabel")}
                      </Button>
                    </Flex>
                  )}
                  <Box flex="1" minH={0} minW={0} display="flex" flexDirection="column" overflow="hidden">
                <Suspense fallback={<PaneEmpty><Spinner size={20} /></PaneEmpty>}>
                  <QueryEditor
                    key={tab.id}
                    ref={getEditorRefSetter(pane.id)}
                    initialSql={tab.sql}
                    running={tab.streaming && !tab.previewStreaming}
                    previewRunning={tab.previewStreaming}
                    onRun={(sql) => resolveParamsThen(tab, sql, "run")}
                    onPreview={tab.kind === "explain" ? undefined : (sql) => resolveParamsThen(tab, sql, "preview")}
                    onExplain={tab.kind === "explain" ? undefined : (sql) => resolveParamsThen(tab, sql, "explain")}
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
                    queryHistory={queryHistory}
                    editorBindings={editorBindings}
                    focusMode={editorFocused}
                    onToggleFocus={
                      sessionId ? () => setLayoutMode((m) => toggleLayoutMode(m, "editor")) : undefined
                    }
                  />
                </Suspense>
                  </Box>
                </Box>
              }
              second={
                <Box
                  display="flex"
                  flexDirection="column"
                  minH={0}
                  minW={0}
                  className={maximized ? "pane-overlay" : undefined}
                  {...(maximized
                    ? {
                        // 結果セクションを全画面オーバーレイ化する。タイトルバー
                        // (高さ 38px) は覆わず、ウィンドウ操作を残す。
                        position: "fixed" as const,
                        top: "38px",
                        left: 0,
                        right: 0,
                        bottom: 0,
                        zIndex: "modal" as const,
                        bg: "app.surface",
                        boxShadow: "lg",
                      }
                    : { flex: "1", position: "relative" as const })}
                >
                  {maximized && (
                    <Flex
                      align="center"
                      gap="2"
                      px="3"
                      py="1.5"
                      flex="none"
                      borderBottomWidth="1px"
                      borderBottomColor="app.border"
                      bg="app.toolbar"
                    >
                      <Icon name="maximize" size={14} />
                      <chakra.span
                        fontSize="sm"
                        color="app.text"
                        fontWeight={500}
                        overflow="hidden"
                        textOverflow="ellipsis"
                        whiteSpace="nowrap"
                      >
                        {tab.title}
                      </chakra.span>
                      <chakra.span flex="1" />
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={() => setLayoutMode("normal")}
                        title={t("resultRestoreTitle")}
                      >
                        <Icon name="minimize" size={14} /> {t("resultMaximizedLabel")}
                      </Button>
                    </Flex>
                  )}
                  <Box flex="1" minH={0} minW={0} display="flex" flexDirection="column" overflow="hidden">
                <Suspense fallback={<PaneEmpty><Spinner size={20} /></PaneEmpty>}>
                  {tab.kind === "explain" ? (
                    <ExplainViewer
                      result={tab.result}
                      driver={selectedProfile?.driver ?? "mysql"}
                      streaming={tab.streaming}
                    />
                  ) : tab.batchResults ? (
                    <BatchResultsView
                      results={tab.batchResults}
                      running={!!tab.batchRunning}
                      onRerun={(stopOnError) => {
                        if (tab.batchScript) void runBatchInTab(tab.id, tab.batchScript, stopOnError);
                      }}
                      onClose={() => patchTab(tab.id, (tt) => ({ ...tt, batchResults: undefined, batchScript: undefined }))}
                    />
                  ) : tab.showChart && tab.result && !tab.streaming ? (
                    <ChartView
                      result={tab.result}
                      onClose={() => patchTab(tab.id, (tt) => ({ ...tt, showChart: false }))}
                    />
                  ) : tab.showPivot && tab.result && !tab.streaming ? (
                    <PivotView
                      result={tab.result}
                      driver={selectedProfile?.driver ?? "mysql"}
                      sourceSql={tab.lastExecutedSql}
                      onSendToEditor={openQueryInEditor}
                      onClose={() => patchTab(tab.id, (tt) => ({ ...tt, showPivot: false }))}
                    />
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
                      applyingEdits={tab.applyingEdits}
                    />
                  ) : (
                    <Flex direction="column" h="100%" minH={0} minW={0}>
                    {tab.result && tab.result.rows.length > 0 && !tab.streaming && (
                      <Flex justify="flex-end" gap="2" px="2.5" py="1" flex="none" borderBottomWidth="1px" borderBottomColor="app.border">
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          onClick={() => patchTab(tab.id, (tt) => ({ ...tt, showPivot: true, showChart: false }))}
                          title={t("pivotShow")}
                        >
                          <Icon name="table" size={14} /> {t("pivotShow")}
                        </Button>
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          onClick={() => patchTab(tab.id, (tt) => ({ ...tt, showChart: true, showPivot: false }))}
                          title={t("chartShow")}
                        >
                          <Icon name="er-diagram" size={14} /> {t("chartShow")}
                        </Button>
                      </Flex>
                    )}
                    {tab.kind === "table" && !readOnly &&
                      ((tab.pendingInserts?.length ?? 0) > 0 || (tab.pendingDeletes?.length ?? 0) > 0) && (
                      <Flex
                        align="center"
                        gap="2.5"
                        px="3"
                        py="1.5"
                        flex="none"
                        borderBottomWidth="1px"
                        borderBottomColor="app.border"
                        bg="color-mix(in srgb, var(--accent) 8%, transparent)"
                        fontSize="sm"
                      >
                        <Icon name="table" size={14} />
                        <chakra.span color="app.text">
                          {t("rowOpsBarSummary", {
                            inserts: tab.pendingInserts?.length ?? 0,
                            deletes: tab.pendingDeletes?.length ?? 0,
                          })}
                        </chakra.span>
                        <chakra.span flex="1" />
                        <Button type="button" variant="secondary" size="sm" onClick={() => discardRowOpsForTab(tab.id)} disabled={tab.applyingEdits}>
                          {t("rowOpsDiscard")}
                        </Button>
                        <LoadingButton type="button" variant="success" size="sm" loading={tab.applyingEdits} onClick={() => applyEditsForTab(tab)}>
                          {t("rowOpsApply")}
                        </LoadingButton>
                      </Flex>
                    )}
                    <ResultGrid
                      ref={getGridRefSetter(pane.id)}
                      result={tab.result}
                      streaming={tab.streaming}
                      onStopStreaming={() => stopTab(tab)}
                      loadingMore={tab.loadingMore}
                      canLoadMore={tab.kind === "table" && tab.paginatable ? false : tab.canLoadMore}
                      onLoadMore={() => loadMoreInTab(tab.id)}
                      pendingDeleteKeys={tab.pendingDeletes ? new Set(tab.pendingDeletes) : undefined}
                      onToggleRowDelete={tab.kind === "table" && !readOnly ? (key) => toggleRowDeleteForTab(tab.id, key) : undefined}
                      onRequestInsertRow={tab.kind === "table" && !readOnly ? () => requestInsertRowForTab(tab.id) : undefined}
                      autoLimitApplied={tab.autoLimitApplied}
                      partialResult={tab.partialResult ?? null}
                      onFetchAllRows={() => fetchAllForTab(tab)}
                      driver={selectedProfile?.driver ?? "mysql"}
                      database={tab.database ?? selectedProfile?.database ?? null}
                      table={tab.table ?? null}
                      editable={tab.kind === "table" && !readOnly}
                      tableColumns={tab.tableColumns}
                      pendingEdits={tab.pendingEdits}
                      canUndo={(tab.editUndoStack?.length ?? 0) > 0}
                      canRedo={(tab.editRedoStack?.length ?? 0) > 0}
                      onSetCellEdit={(r, c, v) => setCellEditForTab(tab.id, r, c, v)}
                      onBulkEdit={(edits) => setBulkCellEditsForTab(tab.id, edits)}
                      diffPrevRows={tab.prevResultRows ?? null}
                      diffComparable={
                        !!tab.prevResultSql && tab.prevResultSql === tab.lastExecutedSql
                      }
                      diffHighlightEnabled={tab.diffHighlight ?? false}
                      onToggleDiffHighlight={() =>
                        patchTab(tab.id, (tt) => ({ ...tt, diffHighlight: !tt.diffHighlight }))
                      }
                      onClearEdits={() => clearEditsForTab(tab.id)}
                      onUndoEdit={() => undoCellEditForTab(tab.id)}
                      onRedoEdit={() => redoCellEditForTab(tab.id)}
                      onPreviewEdits={() => previewEditsForTab(tab)}
                      onApplyEdits={() => applyEditsForTab(tab)}
                      applyingEdits={tab.applyingEdits}
                      autoRefreshSecs={tab.autoRefreshSecs ?? null}
                      autoRefreshAllowed={!!tab.result && isReadOnlySql(tab.lastExecutedSql)}
                      autoRefreshLastRunAt={tab.autoRefreshLastRunAt ?? null}
                      onSetAutoRefresh={(secs) => setAutoRefreshForTab(tab.id, secs)}
                      queryError={tab.queryError ?? null}
                      onRetry={
                        tab.lastExecutedSql
                          ? () => {
                              if (tab.kind === "table") {
                                void runQueryInTab(tab.id, tab.lastExecutedSql, tab.paginatable);
                                return;
                              }
                              runInTabWithGate(tab, tab.lastExecutedSql);
                            }
                          : undefined
                      }
                      onFkJump={(sql) => openAndRunQuery(sql)}
                      incomingFks={
                        tab.kind === "table" && tab.table && tab.database && sessionId
                          ? incomingForeignKeys(
                              fkCache[schemaCacheKey(sessionId, tab.database)] ?? [],
                              tab.table,
                            )
                          : undefined
                      }
                      onRunStatsQuery={
                        sessionId ? (sql) => api.runQuery(sessionId, sql, null) : undefined
                      }
                      fullExport={
                        sessionId && (tab.kind === "table" ? tab.paginatable : tab.lastExecutedSql)
                          ? {
                              sessionId,
                              // table タブは LIMIT を持たない base SQL を再実行して全件出す。
                              sql: tab.kind === "table" ? (tab.paginatable as string) : tab.lastExecutedSql,
                              initialBatch: Math.max(1, settings.defaultDisplayCount),
                              chunkSize: Math.max(1, settings.streamPrefetchSize),
                            }
                          : undefined
                      }
                      lastEditAppliedAt={tab.lastEditAppliedAt}
                      maximized={maximized}
                      onToggleMaximize={() => setLayoutMode((m) => toggleLayoutMode(m, "result"))}
                      onPinResult={() => pinCurrentResult(tab)}
                      canPinResult={!!tab.result && !tab.streaming}
                    />
                    {tab.kind === "table" && tab.paginatable && tab.result && !tab.streaming && (
                      <PaginationBar
                        page={tab.page ?? 1}
                        pageSize={tab.pageSize ?? tab.previewRowLimit}
                        rowsOnPage={tab.result.rows.length}
                        totalPages={estimatedTotalPages(
                          tab.rowEstimateTotal ?? null,
                          tab.pageSize ?? tab.previewRowLimit,
                        )}
                        loading={tab.loadingMore}
                        onGoToPage={(p) => goToPageInTab(tab.id, p)}
                        onSetPageSize={(s) => setPageSizeInTab(tab.id, s)}
                      />
                    )}
                    </Flex>
                  )}
                </Suspense>
                  </Box>
                </Box>
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
    <Flex
      direction="column"
      h="100vh"
      // アクティブ接続色をルートに伝播し、タイトルバーも含め全体で参照できる
      // ようにする。main 側 (gridColumn 2) でも個別に上書きしている。
      style={
        sessionId && selectedProfile?.color
          ? ({ "--ws-accent": selectedProfile.color } as CSSProperties)
          : undefined
      }
    >
      <ThemeTransition themeKey={dataTheme} />
      {/* 起動スプラッシュ (#619)。ブート完了でアンマウントしフェードアウトする。 */}
      <AnimatePresence>{!booted && <SplashScreen />}</AnimatePresence>
      <TitleBar
        connection={
          sessionId && selectedProfile
            ? {
                name: selectedProfile.name,
                color: selectedProfile.color ?? null,
                isProduction: selectedProfile.is_production,
                status: connectionStatus,
              }
            : null
        }
      />
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
          px="3"
          py="2.5"
          borderBottomWidth="1px"
          borderBottomColor="app.border"
          fontWeight={600}
          justify="space-between"
          align="center"
          gap="2"
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
          <Flex gap="1" align="center">
            <IconButton
              onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                setToolsMenu({ x: rect.left, y: rect.bottom + 4 });
              }}
              title={t("appTools")}
              aria-label={t("appTools")}
              aria-haspopup="menu"
            >
              <Icon name="tools" />
            </IconButton>
            {sidebarTab === "snippets" ? (
              <IconButton
                onClick={handleOpenSnippetForm}
                title={t("appNewSnippet")}
                aria-label={t("appNewSnippet")}
              >
                <Icon name="plus" />
              </IconButton>
            ) : sidebarTab === "connections" ? (
              <>
                <IconButton
                  onClick={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    setProfileTransferMenu({ x: rect.left, y: rect.bottom + 4 });
                  }}
                  title={t("profileTransferAria")}
                  aria-label={t("profileTransferAria")}
                  aria-haspopup="menu"
                >
                  <Icon name="transfer" />
                </IconButton>
                <IconButton
                  onClick={() => { setEditing(null); setShowSettings(false); setShowHelp(false); setShowCompare(false); setShowErd(false); setShowProcesses(false); setShowCompareResults(false); setShowServerInfo(false); setShowQueryInspector(false); setSizesTarget(null); setShowSnippetForm(false); setShowForm(true); setFormInstanceId((n) => n + 1); }}
                  title={t("appNew")}
                  aria-label={t("appNew")}
                >
                  <Icon name="plus" />
                </IconButton>
              </>
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
            ref={connectionListRef}
            profiles={profiles}
            activeProfileId={selectedProfile?.id ?? null}
            sessionId={sessionId}
            connectingId={connectingId}
            errorProfileId={errorProfileId}
            openProfileIds={openProfileIds}
            onConnect={handleConnect}
            onDisconnectProfile={handleDisconnectProfile}
            onCreate={handleOpenCreateForm}
            onEdit={handleOpenEditForm}
            onDuplicate={handleDuplicateProfile}
            onDelete={handleDeleteProfile}
            onPickTable={handleOpenTable}
            onImportTable={handleImportTable}
            onGenerateTestData={handleGenerateTestData}
            onDumpDatabase={handleDumpDatabase}
            onSchemaExport={handleSchemaExport}
            onRunTableSelect={handleRunTableSelect}
            onInsertTableSelect={handleInsertTableSelect}
            onShowCreateTable={
              selectedProfile && (selectedProfile.driver === "mysql" || selectedProfile.driver === "sqlite")
                ? handleShowCreateTable
                : undefined
            }
            selectLimit={Math.max(1, settings.defaultDisplayCount)}
            favorites={quickAccess.favorites}
            recent={quickAccess.recent}
            onToggleFavorite={handleToggleFavorite}
            onCreateTable={(db) => setCreateTableDb(db)}
            onTruncateTable={handleTruncateTable}
            onDropTable={handleDropTable}
            onRenameTable={(database, table) => setRenameTarget({ database, table })}
            onRunTableMaintenance={handleRunTableMaintenance}
            onRunDatabaseMaintenance={handleRunDatabaseMaintenance}
            onShowDatabaseSizes={handleShowDatabaseSizes}
            onCopyTableName={handleCopyTableName}
            onOpenObjectDefinition={handleOpenObjectDefinition}
          />
        ) : sidebarTab === "snippets" ? (
          <SnippetList
            snippets={snippets}
            activeProfile={selectedProfile}
            onInsert={handleInsertSnippet}
            onEdit={handleEditSnippet}
            onDelete={handleDeleteSnippet}
            onCreate={handleOpenSnippetForm}
            watchedPlanIds={watchedPlanIdList}
            onTogglePlanWatch={selectedProfile ? handleTogglePlanWatch : undefined}
            onOpenPlanWatch={selectedProfile ? handleOpenPlanWatch : undefined}
          />
        ) : (
          <HistoryList
            activeProfile={selectedProfile}
            reloadKey={historyReloadKey}
            onRestore={handleRestoreHistory}
            onOpenInNewTab={handleOpenHistoryInNewTab}
            onNewQuery={sessionId ? handleNewTab : undefined}
          />
        )}
        </Box>
        {/* グローバル操作 (テーマ / ヘルプ / 設定) のフッタ。接続先一覧とは無関係な
            操作のため、過密になったヘッダから下部へ退避 (VSCode の下部ギアと同配置)。 */}
        <Flex
          as="footer"
          px="3"
          py="1.5"
          borderTopWidth="1px"
          borderTopColor="app.border"
          gap="1"
          align="center"
        >
          <IconButton
            onClick={toggleTheme}
            title={theme === "dark" ? t("appThemeToLight") : t("appThemeToDark")}
            aria-label={t("appThemeToggle")}
          >
            <Icon name={theme === "dark" ? "sun" : "moon"} />
          </IconButton>
          <IconButton
            onClick={() => openFullView("help")}
            title={t("appHelp")}
            aria-label={t("appHelp")}
          >
            <Icon name="help" />
          </IconButton>
          <IconButton
            onClick={() => openFullView("settings")}
            title={t("appSettings")}
            aria-label={t("appSettings")}
          >
            <Icon name="settings" />
          </IconButton>
        </Flex>
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
          bg="var(--overlay)"
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
        {showCompare ? (
          <SchemaCompareView profiles={profiles} onClose={() => setShowCompare(false)} />
        ) : showErd && sessionId ? (
          <ERDiagramView
            sessionId={sessionId}
            driver={(selectedProfile?.driver ?? "mysql") as DriverKind}
            initialDatabase={activeTab?.database ?? selectedProfile?.database ?? null}
            onOpenTable={handleOpenTable}
            onClose={() => setShowErd(false)}
          />
        ) : showProcesses && sessionId ? (
          <ProcessListPanel
            sessionId={sessionId}
            readOnly={selectedProfile?.read_only ?? false}
            onClose={() => setShowProcesses(false)}
          />
        ) : showServerInfo && sessionId ? (
          <ServerInfoPanel sessionId={sessionId} onClose={() => setShowServerInfo(false)} />
        ) : showQueryInspector && sessionId ? (
          <QueryInspectorPanel
            sessionId={sessionId}
            driver={selectedProfile?.driver ?? "mysql"}
            onClose={() => setShowQueryInspector(false)}
          />
        ) : showSizes && sizesTarget && sessionId ? (
          <TableStatisticsPanel
            sessionId={sessionId}
            database={sizesTarget}
            onOpenTable={(table) => {
              const db = sizesTarget;
              setSizesTarget(null);
              handleOpenTable(db, table);
            }}
            onClose={() => setSizesTarget(null)}
          />
        ) : showCompareResults ? (
          <PinnedComparisonView
            pinned={pinnedResults}
            driver={selectedProfile?.driver ?? "mysql"}
            onUnpin={(id) => setPinnedResults((prev) => prev.filter((p) => p.id !== id))}
            onClear={() => setPinnedResults([])}
            onClose={() => setShowCompareResults(false)}
          />
        ) : showForm ? (
          <ConnectionForm
            key={formInstanceId}
            initial={editing}
            profiles={profiles}
            onSaved={async () => {
              setShowForm(false);
              setEditing(null);
              await runWithErrorStatus(refreshProfiles, "statusFailedLoadProfiles");
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
              await runWithErrorStatus(refreshSnippets, "statusFailedLoadSnippets");
            }}
            onCancel={() => { setShowSnippetForm(false); setEditingSnippet(null); setSnippetFormSql(""); }}
          />
        ) : (
          <>
            <Flex
              align="center"
              gap="3"
              pl={sidebarCollapsed ? "46px" : "14px"}
              pr="3.5"
              py="2"
              borderBottomWidth="1px"
              borderBottomColor="app.border"
              minH="42px"
              bg={`color-mix(in srgb, var(--ws-accent) ${selectedProfile?.is_production ? "9%" : "4%"}, var(--bg-elevated))`}
              transition="background var(--dur-med) var(--ease)"
              css={{ "@media (max-width: 760px)": { flexWrap: "wrap", rowGap: "1" } }}
            >
              <Flex align="center" gap="2" overflow="hidden">
                {selectedProfile ? (
                  <>
                    <StatusDot variant="connected" />
                    <chakra.span fontWeight={600} fontSize="md">{selectedProfile.name}</chakra.span>
                    {selectedProfile.is_production && (
                      <chakra.span
                        title={t("listProductionTitle")}
                        display="inline-flex"
                        alignItems="center"
                        gap="1"
                        fontSize="xs"
                        textTransform="uppercase"
                        letterSpacing="0.06em"
                        fontWeight={700}
                        px="2"
                        py="0.5"
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
                        gap="1"
                        fontSize="xs"
                        textTransform="uppercase"
                        letterSpacing="0.06em"
                        fontWeight={700}
                        px="2"
                        py="0.5"
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
                <Flex align="center" gap="2" mr="2.5">
                  {txActive ? (
                    <>
                      <chakra.span
                        fontSize="2xs"
                        fontWeight={700}
                        letterSpacing="0.06em"
                        px="1.5"
                        py="0.5"
                        borderRadius="4px"
                        bg="color-mix(in srgb, var(--status-warning) 18%, transparent)"
                        color="var(--text-warning)"
                        title={t("txActiveHelp")}
                      >
                        {t("txActiveBadge")}
                      </chakra.span>
                      <Button variant="success" size="sm" onClick={() => handleFinishTransaction(true)}>
                        {t("txCommit")}
                      </Button>
                      <Button variant="warning" size="sm" onClick={() => handleFinishTransaction(false)}>
                        {t("txRollback")}
                      </Button>
                    </>
                  ) : (
                    <Button variant="secondary" size="sm" onClick={handleBeginTransaction} title={t("txBeginHelp")}>
                      {t("txBegin")}
                    </Button>
                  )}
                </Flex>
              )}
              {sessionId && (
                <Button variant="dangerOutline" size="sm" onClick={handleDisconnect}>
                  <Icon name="unplug" size={14} />
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
            ) : profiles.length === 0 ? (
              // 初回起動ウェルカム画面 (#599): プロファイルが 1 件も無い新規
              // ユーザには、単一 CTA の EmptyState の代わりに主要導線を並べた
              // WelcomeView を出す。1 件以上あれば従来どおりの未接続表示のまま。
              <Flex direction="column" flex="1" overflow="hidden">
                <WelcomeView
                  onCreateConnection={handleOpenCreateForm}
                  onOpenSqlite={handleWelcomeOpenSqlite}
                  onStartTour={handleStartTour}
                />
              </Flex>
            ) : (
              <Flex direction="column" flex="1" overflow="hidden">
                <PaneEmpty>
                  <EmptyState
                    illustration={<DisconnectedIllustration />}
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
          // critical は error と同じ赤系で描き、加えて「重大」バッジで際立たせる。
          // warning は黄系。どちらも閉じる導線を出す。
          const isCritical = tone === "critical";
          const isError = tone === "error" || isCritical;
          const isWarning = tone === "warning";
          const isDismissible = isError || isWarning;
          const toneColor =
            tone === "running"
              ? "app.accent"
              : tone === "success"
                ? "app.status.success"
                : isError
                  ? "app.status.error"
                  : isWarning
                    ? "app.status.warning"
                    : undefined;
          return (
            <Flex
              align="center"
              gap="2"
              px="3.5"
              py="5px"
              bg={isError ? "app.bgError" : isWarning ? "app.bgWarning" : "app.surfaceMuted"}
              borderTopWidth="1px"
              borderTopColor="app.border"
              borderLeftWidth="3px"
              borderLeftStyle="solid"
              borderLeftColor={toneColor ?? "transparent"}
              fontSize="sm"
              color={isError ? "app.textError" : isWarning ? "app.textWarning" : "app.textSecondary"}
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
                ) : isError || isWarning ? (
                  <Icon name="warning" />
                ) : null}
              </chakra.span>
              {isCritical && (
                <chakra.span
                  flexShrink="0"
                  fontWeight={700}
                  fontSize="xs"
                  letterSpacing="0.04em"
                  textTransform="uppercase"
                  px="7px"
                  py="0.5"
                  borderRadius="sm"
                  bg="app.status.error"
                  color="#fff"
                >
                  {t("statusSeverityCritical")}
                </chakra.span>
              )}
              <Box flex="1" minW="0">
                {statusHintKey ? (
                  // ヒントは初心者向けの一般的な言い回しだけだと具体性に欠けるため、
                  // 実際のエラー本文 (シンタックスエラーの箇所など具体的な値) を常に
                  // 併記する。閉じる操作はステータスバー右端の X に一本化し、ここには
                  // 個別の閉じるボタンを置かない (閉じるボタンの二重表示を避ける)。
                  <Flex direction="column" gap="3px">
                    <Flex align="baseline" gap="1.5">
                      <chakra.span
                        flex="none"
                        fontWeight={600}
                        fontSize="xs"
                        px="1.5"
                        py="1px"
                        borderRadius="sm"
                        bg="app.textError"
                        color="app.bgError"
                      >
                        {t("errorHintLabel")}
                      </chakra.span>
                      <chakra.span flex="1" minW="0" lineHeight="1.45">{t(statusHintKey)}</chakra.span>
                    </Flex>
                    <chakra.span
                      display="block"
                      maxH="88px"
                      overflow="auto"
                      whiteSpace="pre-wrap"
                      wordBreak="break-word"
                      fontFamily="var(--font-mono)"
                      fontSize="xs"
                      opacity={0.9}
                    >
                      {statusText}
                    </chakra.span>
                  </Flex>
                ) : (
                  // 単一行ステータスは折り返さず省略記号で詰め、全文はホバー
                  // (title) で確認できるようにする。フッターが複数行に
                  // 伸びてレイアウトが崩れるのを防ぐ。
                  <chakra.span
                    display="block"
                    whiteSpace="nowrap"
                    overflow="hidden"
                    textOverflow="ellipsis"
                    title={statusText}
                  >
                    {statusText}
                  </chakra.span>
                )}
              </Box>
              {reconnectProfile && isError && (
                <chakra.button
                  type="button"
                  flexShrink="0"
                  display="inline-flex"
                  alignItems="center"
                  gap="5px"
                  px="2.5"
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
              {connectAttempt && (
                <>
                  <chakra.span
                    flexShrink="0"
                    fontSize="xs"
                    opacity={0.85}
                    display="inline-flex"
                    alignItems="center"
                    gap="5px"
                  >
                    <Spinner size={12} />
                    {t(connectPhaseI18nKey(connectAttempt.phase))}
                  </chakra.span>
                  <chakra.button
                    type="button"
                    flexShrink="0"
                    px="2.5"
                    py="3px"
                    fontSize="xs"
                    fontWeight={500}
                    border="1px solid"
                    borderColor="app.border"
                    borderRadius="sm"
                    bg="transparent"
                    cursor="pointer"
                    css={{ "&:hover": { background: "var(--bg-muted)" } }}
                    onClick={handleCancelConnect}
                    title={t("connectCancel")}
                  >
                    {t("connectCancel")}
                  </chakra.button>
                </>
              )}
              {isDismissible && (
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
      {/* 各モーダルは `AnimatePresence` で包み、閉じる際の exit を再生させてから
          アンマウントさせる (Modal.tsx の開閉アニメ前提)。 */}
      <AnimatePresence>
        {importTarget && sessionId && (
          <ImportModal
            sessionId={sessionId}
            database={importTarget.database}
            table={importTarget.table}
            initialPath={importInitialPath ?? undefined}
            onClose={() => {
              setImportTarget(null);
              setImportInitialPath(null);
            }}
            onImported={() => handleImported(importTarget.database, importTarget.table)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {testDataTarget && sessionId && (
          <TestDataModal
            sessionId={sessionId}
            database={testDataTarget.database}
            table={testDataTarget.table}
            driver={selectedProfile?.driver ?? "mysql"}
            isProduction={selectedProfile?.is_production ?? false}
            onClose={() => setTestDataTarget(null)}
            onInserted={() => handleImported(testDataTarget.database, testDataTarget.table)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {planWatchOpen && selectedProfile && (
          <PlanWatchPanel
            profile={selectedProfile}
            snippets={snippets}
            state={planWatch}
            refreshing={planWatchRefreshing}
            canRefresh={sessionId !== null}
            onRefresh={handleRefreshPlanWatch}
            onUnwatch={handleUnwatchPlan}
            onClose={() => setPlanWatchOpen(false)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {dumpTarget && sessionId && (
          <DumpModal
            sessionId={sessionId}
            database={dumpTarget}
            driver={(selectedProfile?.driver ?? "mysql") as DriverKind}
            onClose={() => setDumpTarget(null)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {schemaExportTarget && sessionId && (
          <SchemaExportModal
            key={schemaExportTarget}
            sessionId={sessionId}
            database={schemaExportTarget}
            driver={(selectedProfile?.driver ?? "mysql") as DriverKind}
            onClose={() => setSchemaExportTarget(null)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {importProfilesPath && (
          <ProfileImportDialog
            onConfirm={handleImportProfilesConfirm}
            onCancel={() => setImportProfilesPath(null)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {createTableDb !== null && sessionId && (
          <Suspense fallback={null}>
            <CreateTableModal
              driver={(selectedProfile?.driver ?? "mysql") as DriverKind}
              database={createTableDb || null}
              readOnly={readOnly}
              onRun={handleCreateTableRun}
              onSendToEditor={handleCreateTableToEditor}
              onClose={() => setCreateTableDb(null)}
            />
          </Suspense>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {renameTarget && (
          <Suspense fallback={null}>
            <RenameTableDialog
              table={renameTarget.table}
              onConfirm={handleRenameTableSubmit}
              onCancel={() => setRenameTarget(null)}
            />
          </Suspense>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {hostKeyMismatch && (
          <Suspense fallback={null}>
            <HostKeyMismatchDialog
              profile={hostKeyMismatch.profile}
              message={hostKeyMismatch.message}
              busy={reTrustingHostKey}
              onReTrust={handleReTrustHostKey}
              onCancel={() => setHostKeyMismatch(null)}
            />
          </Suspense>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {(() => {
          const insTab = rowInsertTabId ? tabs.find((tt) => tt.id === rowInsertTabId) : null;
          if (!insTab || !insTab.result || !insTab.table) return null;
          return (
            <Suspense fallback={null}>
              <RowInsertModal
                table={insTab.table}
                columns={insTab.result.columns}
                onConfirm={(row) => addInsertRowForTab(insTab.id, row)}
                onCancel={() => setRowInsertTabId(null)}
              />
            </Suspense>
          );
        })()}
      </AnimatePresence>

      <AnimatePresence>
        {pendingParams && (
          <ParameterInputModal
            sql={pendingParams.sql}
            driver={(selectedProfile?.driver ?? "mysql") as DriverKind}
            onSubmit={handleParamsSubmit}
            onCancel={handleParamsCancel}
          />
        )}
        {pendingDangerous && (
          <DangerousQueryDialog
            findings={pendingDangerous.findings}
            isProduction={pendingDangerous.isProduction}
            writeApproval={pendingDangerous.writeApproval}
            typedConfirmTarget={pendingDangerous.typedConfirmTarget}
            onConfirm={handleConfirmDangerous}
            onCancel={handleCancelDangerous}
          />
        )}
      </AnimatePresence>
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

      {profileTransferMenu && (
        <ContextMenu
          x={profileTransferMenu.x}
          y={profileTransferMenu.y}
          items={[
            { label: t("profileImportAria"), onSelect: handleImportProfilesPick },
            { label: t("profileExportAria"), onSelect: handleExportProfiles },
          ]}
          onClose={() => setProfileTransferMenu(null)}
        />
      )}

      {toolsMenu && (
        <ContextMenu
          x={toolsMenu.x}
          y={toolsMenu.y}
          items={[
            { label: t("appSchemaCompare"), onSelect: () => openFullView("compare") },
            {
              label: t("appErDiagram"),
              onSelect: () => openFullView("erDiagram"),
              disabled: !sessionId,
              title: !sessionId ? t("appToolsNeedsSession") : undefined,
            },
            {
              label: t("appProcesses"),
              onSelect: () => openFullView("processes"),
              disabled: !sessionId || selectedProfile?.driver === "sqlite",
              title: !sessionId
                ? t("appToolsNeedsSession")
                : selectedProfile?.driver === "sqlite"
                  ? t("appProcessesUnsupported")
                  : undefined,
            },
            {
              label: t("appQueryInspector"),
              onSelect: () => openFullView("queryInspector"),
              // SQLite はサーバ統計を持たず非対応のため導線を出さない (#746)。
              disabled: !sessionId || selectedProfile?.driver === "sqlite",
              title: !sessionId
                ? t("appToolsNeedsSession")
                : selectedProfile?.driver === "sqlite"
                  ? t("appQueryInspectorUnsupported")
                  : undefined,
            },
            {
              label: t("serverInfoMenuLabel"),
              onSelect: () => openFullView("serverInfo"),
              disabled: !sessionId,
              title: !sessionId ? t("appToolsNeedsSession") : undefined,
            },
            {
              label: t("sizeMenuLabel"),
              onSelect: () => {
                const db = activeTab?.database ?? selectedProfile?.database ?? null;
                if (db) handleShowDatabaseSizes(db);
              },
              disabled: !sessionId || !(activeTab?.database ?? selectedProfile?.database),
              title: !sessionId ? t("appToolsNeedsSession") : undefined,
            },
            {
              label: t("appSchemaExportMenu"),
              onSelect: () => {
                const db = activeTab?.database ?? selectedProfile?.database ?? null;
                if (db) setSchemaExportTarget(db);
              },
              disabled: !sessionId || !(activeTab?.database ?? selectedProfile?.database),
              title: !sessionId ? t("appToolsNeedsSession") : undefined,
            },
            {
              label: t("appPinCompare", { count: pinnedResults.length }),
              onSelect: () => openFullView("compareResults"),
              disabled: pinnedResults.length === 0,
              title: pinnedResults.length === 0 ? t("pinCompareEmptyHint") : undefined,
            },
          ]}
          onClose={() => setToolsMenu(null)}
        />
      )}
      </Grid>
      <Suspense fallback={null}>
        <AnimatePresence>
          {showCommandPalette && (
            <CommandPalette
              items={commandItems}
              onClose={() => setShowCommandPalette(false)}
            />
          )}
        </AnimatePresence>
        <AnimatePresence>
          {showObjectSearch && sessionId && (
            <ObjectSearchModal
              sessionId={sessionId}
              currentDatabase={activeTab?.database ?? selectedProfile?.database ?? null}
              onOpenTable={handleOpenTable}
              onClose={() => setShowObjectSearch(false)}
            />
          )}
        </AnimatePresence>
        <AnimatePresence>
          {showCheatSheet && <ShortcutCheatSheet onClose={() => setShowCheatSheet(false)} />}
        </AnimatePresence>
        <AnimatePresence>
          {showSettings && (
            <SettingsView theme={theme} onClose={() => setShowSettings(false)} />
          )}
        </AnimatePresence>
        <AnimatePresence>
          {showHelp && <HelpView onClose={() => setShowHelp(false)} />}
        </AnimatePresence>
      </Suspense>
      {/* enter のみのポップオーバー (ContextMenu と同方針) なので AnimatePresence
          は不要 — 閉じる際はアンマウントで即座に消える。 */}
      {showTour && <OnboardingTour onClose={handleCloseTour} />}
      {confirmDialogElement}
      {/* ファイルのドラッグ&ドロップ時のオーバーレイ。受理/拒否を視覚的に
          示す。pointerEvents none で実際のドロップは webview のネイティブ経路に任せ、
          このレイヤはフィードバック表示専用。 */}
      <AnimatePresence>
        {dragFeedback && (
          <motion.div
            initial={variants.fade.initial}
            animate={variants.fade.animate}
            exit={variants.fade.exit}
            transition={transitions.enter}
            aria-hidden
            style={{
              position: "fixed",
              inset: 0,
              zIndex: 2000,
              pointerEvents: "none",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "color-mix(in srgb, var(--bg) 55%, transparent)",
              backdropFilter: "blur(2px)",
            }}
          >
            <motion.div
              initial={variants.fadeScale.initial}
              animate={variants.fadeScale.animate}
              exit={variants.fadeScale.exit}
              transition={transitions.enter}
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: "12px",
                padding: "32px 48px",
                borderRadius: "16px",
                border: `2px dashed ${dragFeedback.accept ? "var(--accent)" : "var(--status-error)"}`,
                background: "var(--bg-elevated, var(--bg))",
                color: dragFeedback.accept ? "var(--accent)" : "var(--status-error)",
                boxShadow: "var(--shadow-lg, 0 12px 40px rgba(0,0,0,0.3))",
              }}
            >
              <Icon name={dragFeedback.accept ? "upload" : "warning"} size={32} />
              <chakra.span fontSize="lg" fontWeight={600}>
                {dragFeedback.accept
                  ? t("dropOverlayTitle")
                  : t("dropOverlayReject")}
              </chakra.span>
              {dragFeedback.accept && (
                <chakra.span fontSize="sm" color="app.textMuted" textAlign="center">
                  {dragFeedback.kind === "sql"
                    ? t("dropOverlayHintSql")
                    : dragFeedback.kind === "csv"
                      ? t("dropOverlayHintCsv")
                      : t("dropOverlayHintMixed")}
                </chakra.span>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </Flex>
  );
}
