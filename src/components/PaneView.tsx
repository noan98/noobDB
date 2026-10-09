import { lazy, memo, Suspense, useCallback, useMemo, useSyncExternalStore, type ComponentProps, type MutableRefObject, type ReactNode } from "react";
import { Box, Flex, chakra } from "@chakra-ui/react";
import { AnimatePresence, motion } from "motion/react";
import { api, ConnectionProfile, QueryResult, TableSchema } from "../api/tauri";
import { countEditedCells, countEditedRows, type PendingEdits, type PendingInsertRow } from "./cellEdit";
import { type BulkEditTarget } from "./bulkEdit";
import { TabDirtyWatcher } from "../tabSqlStore";
import { isTabDirty } from "../tabDirty";
import { useKeyedStable } from "../useKeyedStable";
import { isCtasEligibleSql } from "./resultsToTable";
import { applyServerBrowse, type ServerFilterOp, type ServerSortDirection } from "./serverBrowse";
import { EmptyState } from "./EmptyState";
import { StreamProgressBar } from "./StreamProgressBar";
import { ResultPaneSkeleton } from "./ResultPaneSkeleton";
import { showsResultSkeletonFallback } from "./resultSkeleton";
import { Spinner } from "./Spinner";
import type { QueryEditorHandle } from "./QueryEditor";
import type { PreflightResult } from "./usePreflight";
import type { ResultGridHandle } from "./ResultGrid";
import { ResultExplainContext, type ResultViewKind } from "./ResultViewSwitch";
import { bundleExplainPrefix, bundlePlanSupported } from "./investigationBundle";
import { explainAnalyzeSupported } from "./explainAnalyze";
import { TabBar } from "./TabBar";
import { Splitter } from "./Splitter";
import { Icon, ICON_SIZES } from "./Icon";
import { Button } from "./ui";
import { buildTabsEmptyActions } from "./tabsEmptyActions";
import { LoadingButton } from "./LoadingButton";
import { readOnlyWithHint } from "../dangerousSql";
import { useT } from "../i18n";
import type { IncomingFk } from "../fkNavigation";
import type { ValueLookup } from "./useValuePicker";
import { transitions, variants } from "../motion";
import { resolveShortcutBindings } from "../shortcuts";
import { formatCombo } from "../shortcutKeys";
import { toggleLayoutMode, type LayoutMode } from "./paneLayout";
import { KeepAlive } from "./KeepAlive";
import { ResultGridSlot } from "./ResultGridSlot";
import { GRID_KEEP_ALIVE_LIMIT } from "./keepAliveSet";
import { type Status } from "../statusMessage";
import { estimatedTotalPages } from "../pagination";
import { Tooltip } from "./Tooltip";
import type { Tab, PaneState } from "../App";
import type { Settings } from "../settings";
import type { AiSqlEditorAction } from "../ai/sqlAssist";
import { useStoreSelector, type TabPaneStore } from "../tabPaneStore";


// 重いビューはコード分割する (App.tsx と同じ方針、ペインが初めて描画するときに読み込む)。
const QueryEditor = lazy(() =>
  import("./QueryEditor").then((m) => ({ default: m.QueryEditor })),
);
const ResultGrid = lazy(() =>
  import("./ResultGrid").then((m) => ({ default: m.ResultGrid })),
);
const PreviewGrid = lazy(() =>
  import("./PreviewGrid").then((m) => ({ default: m.PreviewGrid })),
);
const ExplainViewer = lazy(() =>
  import("./ExplainViewer").then((m) => ({ default: m.ExplainViewer })),
);
const PaginationBar = lazy(() =>
  import("./PaginationBar").then((m) => ({ default: m.PaginationBar })),
);
const ChartView = lazy(() =>
  import("./ChartView").then((m) => ({ default: m.ChartView })),
);
const PivotView = lazy(() =>
  import("./PivotView").then((m) => ({ default: m.PivotView })),
);
const ResultJsonView = lazy(() =>
  import("./ResultJsonView").then((m) => ({ default: m.ResultJsonView })),
);
const BatchResultsView = lazy(() =>
  import("./BatchResultsView").then((m) => ({ default: m.BatchResultsView })),
);

const explainPrefixFor = bundleExplainPrefix;

/** 中央寄せの空状態プレースホルダ。ペインに何もない時 / 遅延読み込み中に使う。 */
export function PaneEmpty({ children }: { children: ReactNode }) {
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

/**
 * table タブの総ページ数目安 (#792)。`rowEstimateTotal` は統計情報ベースの全件
 * 概算行数なので、サーバ側フィルタ (WHERE) 適用中はもはや正しい母数ではない —
 * 誤って小さすぎる総ページ数を表示しないよう、その場合は未知 (null) として扱い
 * `canGoNext` の「直近ページが満杯なら続きがありそう」フォールバックに委ねる。
 * ソートのみ (WHERE なし) なら行数は変わらないので、そのまま概算を使う。
 */
export function tableTotalPagesEstimate(
  tab: Pick<Tab, "serverFilter" | "rowEstimateTotal">,
  pageSize: number,
): number | null {
  if (tab.serverFilter) return null;
  return estimatedTotalPages(tab.rowEstimateTotal ?? null, pageSize);
}

/** 逆方向 FK のキャッシュキー (セッション + DB + テーブル)。 */
export function incomingFkCacheKey(sessionId: string, database: string, table: string): string {
  return `${sessionId}\0${database}\0${table}`;
}

/** まだ取得できていないテーブルに渡す安定した空配列 (毎回新しい配列を作らない)。 */
export const NO_INCOMING_FKS: IncomingFk[] = [];

const NO_TABS: Tab[] = [];

function sameTabs(a: Tab[], b: Tab[]): boolean {
  return a === b || (a.length === b.length && a.every((v, i) => v === b[i]));
}

/**
 * ペインが描画に使う、App 由来の値と安定したコールバック (#1318)。
 *
 * `PaneView` は `memo` で包み、`env` の各フィールドを 1 つずつ `Object.is` で比べる
 * (`env` 自体は毎回作り直されてよい)。したがって:
 * - 値 (`sessionId` など) は変わったときだけペインが再描画される。
 * - `actions` は `useStableCallbacks` で参照を固定した束で、呼ばれた時点の最新の
 *   ハンドラへ委譲する。ペインはこれを経由して App の state を触る。
 * - ここに無い値を `App` のクロージャ越しに読まない (古い値を掴むため)。
 */
export interface PaneActions {
  applyEditsForTab: (tab: Tab, rowScope?: PendingEdits) => Promise<boolean>;
  clearEditsForTab: (tabId: string) => void;
  closePane: (paneId: string) => void;
  discardEditsAndPreviewForTab: (tabId: string) => void;
  discardRowOpsForTab: (tabId: string) => void;
  explainForTab: (tab: Tab, sql: string) => void;
  fetchAllForTab: (tab: Tab) => void;
  focusPane: (paneId: string) => void;
  goToPageInTab: (tabId: string, page: number, sizeOverride?: number) => unknown;
  handleCloseTab: (id: string) => void;
  handleEditorDocChange: (tabId: string, doc: { toString(): string }) => void;
  handleExploreColumns: (database: string, table: string, column?: string | null) => void;
  handleNewTab: (paneId?: string) => void;
  handleOpenAiSql: (sql: string, database: string | null) => void;
  handleAiSqlAction: (action: AiSqlEditorAction) => void;
  handleOpenSqlFile: () => unknown;
  handleRegisterLocalTable: (result: QueryResult, sourceSql: string) => void;
  handleSaveSnippetFromEditor: (sql: string) => void;
  handleSaveSqlFile: () => unknown;
  handleToggleEmergencyMode: (next: boolean) => unknown;
  loadMoreInTab: (tabId: string) => unknown;
  openAndRunQuery: (sql: string, title?: string) => void;
  openQueryInEditor: (sql: string, title?: string, database?: string) => void;
  openTabMenu: (tabId: string, x: number, y: number) => void;
  renameTab: (tabId: string, input: string) => void;
  cancelRenameTab: () => void;
  requestRenameTab: (tabId: string) => void;
  patchTab: (id: string, patcher: (tab: Tab) => Tab) => void;
  pinCurrentResult: (tab: Tab) => void;
  previewEditsForTab: (tab: Tab) => void;
  redoCellEditForTab: (tabId: string) => void;
  reorderTabsInPane: (paneId: string, orderedIds: string[]) => void;
  replaceColumnForTab: (tab: Tab, sql: string) => unknown;
  requestBroadcast: (sql: string, tab: Tab | null) => void;
  requestDuplicateRowForTab: (tabId: string, row: PendingInsertRow) => void;
  requestInsertRowForTab: (tabId: string) => void;
  resolveParamsThen: (tab: Tab, sql: string, mode: "run" | "runNewTab" | "preview" | "explain") => void;
  runBatchInTab: (tabId: string, sql: string, stopOnError: boolean, tabOverride?: Tab) => unknown;
  runExplainInTab: (tabId: string, sql: string, analyze: boolean) => unknown;
  runInTabWithGate: (tab: Tab, sql: string, opts?: { newTab?: boolean; fresh?: boolean }) => void;
  runQueryInTab: (tabId: string, sql: string, paginatableBase?: string | null) => unknown;
  selectTab: (paneId: string, tabId: string) => void;
  setAutoRefreshForTab: (tabId: string, secs: number | null) => void;
  setBulkCellEditsForTab: (tabId: string, edits: BulkEditTarget[]) => void;
  setCellEditForTab: (tabId: string, rowKey: string, colIdx: number, value: string | null) => void;
  setLayoutMode: (next: LayoutMode | ((prev: LayoutMode) => LayoutMode)) => void;
  setPageSizeInTab: (tabId: string, size: number) => void;
  setResultView: (tabId: string, view: ResultViewKind) => void;
  setSaveAsTableRequest: (req: { sql: string; database: string }) => void;
  setSaveAsViewRequest: (req: { sql: string; database: string; initialName?: string }) => void;
  setServerFilterInTab: (
    tabId: string,
    column: string,
    filter: { op: ServerFilterOp; value: string; value2?: string; numeric: boolean } | null,
  ) => void;
  setServerSortInTab: (tabId: string, column: string, direction: ServerSortDirection | null) => void;
  setStatus: (status: Status) => void;
  setTransferSource: (source: { kind: "query"; database: string | null; sql: string }) => void;
  splitPane: () => void;
  stopTab: (tab: Tab) => unknown;
  toggleRowDeleteForTab: (tabId: string, rowKey: string) => void;
  undoCellEditForTab: (tabId: string) => void;
  updateTab: (id: string, patch: Partial<Tab>) => void;
  writeBlobForTab: (tab: Tab, rowIdx: number, colIdx: number, hex: string) => Promise<boolean>;
  // 空状態の補助導線 (パレット / SQL ファイル / ER 図 / スニペット)
  openSnippetsFromEmpty: () => void;
  openErDiagramFromEmpty: () => void;
  openCommandPaletteFromEmpty: () => void;
}

export interface PaneEnv {
  /** タブ・ペインの外部ストア。ペインは自分のぶんだけ購読する。 */
  store: TabPaneStore<Tab, PaneState>;
  actions: PaneActions;
  t: ReturnType<typeof useT>;
  sessionId: string | null;
  selectedProfile: ConnectionProfile | null;
  layoutMode: LayoutMode;
  readOnly: boolean;
  emergencyMode: boolean;
  broadcastAvailable: boolean;
  queryHistory: string[];
  editorBindings: ComponentProps<typeof QueryEditor>["editorBindings"];
  gridBindings: ComponentProps<typeof ResultGrid>["gridBindings"];
  shortcutBindings: ReturnType<typeof resolveShortcutBindings>;
  /** タブ名をインライン編集中のタブ ID (#1390)。 */
  renamingTabId: string | null;
  density: Settings["density"];
  defaultDisplayCount: number;
  streamPrefetchSize: number;
  incomingFkCache: Record<string, IncomingFk[]>;
  schemaForDatabase: (database: string | null | undefined) => TableSchema[] | null;
  lookupForSession: (sid: string) => ValueLookup;
  /** dirty 表示の切り替わり (TabDirtyWatcher) で増える。TabBar の dirty ドットを再計算させる。 */
  dirtyTick: number;
  dirtyWatcher: TabDirtyWatcher;
  getTabSql: (tab: Tab) => string;
  gridStable: ReturnType<typeof useKeyedStable>;
  editorSelectionRef: MutableRefObject<Map<string, { anchor: number; head: number }>>;
  gridScrollRef: MutableRefObject<Map<string, number>>;
  preflightRef: MutableRefObject<Map<string, PreflightResult | null>>;
  getEditorRefSetter: (paneId: string) => (h: QueryEditorHandle | null) => void;
  getGridRefSetter: (paneId: string) => (h: ResultGridHandle | null) => void;
}

export interface PaneViewProps {
  paneId: string;
  /** ペインが 2 枚あるか。 */
  split: boolean;
  /** このペインがフォーカス中か。 */
  isFocused: boolean;
  env: PaneEnv;
}

function sameEnv(a: PaneEnv, b: PaneEnv): boolean {
  const keys = Object.keys(a) as (keyof PaneEnv)[];
  return keys.length === Object.keys(b).length && keys.every((k) => Object.is(a[k], b[k]));
}

/**
 * 1 ペインぶんの描画: 自分の TabBar と、アクティブタブに結び付いたエディタ / 結果の
 * スプリッタ。ペイン自身とそのタブはストアから購読するので、他のペインやタブの変更では
 * 再描画されない (#1318)。App 由来の値は `env` の浅い比較で判定する。
 */
export const PaneView = memo(
  function PaneView({ paneId, split, isFocused, env }: PaneViewProps) {
  const {
    store, actions, t, sessionId, selectedProfile, layoutMode, readOnly, emergencyMode, broadcastAvailable,
    queryHistory, editorBindings, gridBindings, shortcutBindings, density, defaultDisplayCount,
    streamPrefetchSize, incomingFkCache, schemaForDatabase, lookupForSession, dirtyTick, dirtyWatcher,
    getTabSql, gridStable, editorSelectionRef, gridScrollRef, preflightRef, getEditorRefSetter,
    getGridRefSetter, renamingTabId,
  } = env;
  // テーブルタブで編集系の操作 (セル編集・行の追加/削除・BLOB 書き戻し・列置換) を
  // 出してよいか。read_only 接続に加え、行を特定できないデフォルトクエリ (#1253) で
  // 開いたタブも読み取り専用にする (誤った行を書き換えないよう再判定はしない)。
  const tableTabEditable = (tab: Pick<Tab, "kind" | "openTemplate">): boolean =>
    tab.kind === "table" && !readOnly && tab.openTemplate?.editable !== false;
  const emptyCombo = formatCombo(shortcutBindings.commandPalette);
  const emptyActions = useMemo(
    () =>
      buildTabsEmptyActions(
        t,
        {
          openSqlFile: () => void actions.handleOpenSqlFile(),
          snippets: actions.openSnippetsFromEmpty,
          erDiagram: actions.openErDiagramFromEmpty,
          commandPalette: actions.openCommandPaletteFromEmpty,
        },
        emptyCombo,
      ),
    [t, actions, emptyCombo],
  );
  const pane = useSyncExternalStore(store.subscribe, () => store.getPane(paneId));
  const paneTabs = useStoreSelector(
    store,
    store.getTabs,
    (all) => {
      if (!pane) return NO_TABS;
      const out: Tab[] = [];
      for (const id of pane.tabIds) {
        const found = all.find((tt) => tt.id === id);
        if (found) out.push(found);
      }
      return out;
    },
    sameTabs,
  );
  // TabBar (memo) へ渡すペイン単位のコールバック。`actions` も `paneId` も不変なので参照が固定される。
  const onSelectTab = useCallback((id: string) => actions.selectTab(paneId, id), [actions, paneId]);
  const onNewTab = useCallback(() => actions.handleNewTab(paneId), [actions, paneId]);
  const onReorderTabs = useCallback(
    (ids: string[]) => actions.reorderTabsInPane(paneId, ids),
    [actions, paneId],
  );
  const onSplit = useCallback(
    () => (split ? actions.closePane(paneId) : actions.splitPane()),
    [actions, paneId, split],
  );
  // QueryEditor (memo) へ渡す、タブに依存しないコールバック。
  const onOpenSqlFile = useCallback(() => void actions.handleOpenSqlFile(), [actions]);
  const onSaveSqlFile = useCallback(() => void actions.handleSaveSqlFile(), [actions]);
  const onFormatError = useCallback(
    (error: string) =>
      actions.setStatus({ kind: "key", key: "statusFormatError", vars: { error }, error: true }),
    [actions],
  );
  const onToggleEmergencyMode = useCallback(
    (next: boolean) => void actions.handleToggleEmergencyMode(next),
    [actions],
  );
  const onToggleEditorFocus = useCallback(
    () => actions.setLayoutMode((m) => toggleLayoutMode(m, "editor")),
    [actions],
  );
  const onToggleResultMaximize = useCallback(
    () => actions.setLayoutMode((m) => toggleLayoutMode(m, "result")),
    [actions],
  );
  // TabBar へ渡すタブの一覧。dirty (SQL が最後の実行と違う) は `dirtyTick` が変わったとき
  // (TabDirtyWatcher が切り替わりを検知したとき) と、タブ自体が変わったときだけ再計算する。
  // biome-ignore lint/correctness/useExhaustiveDependencies: dirtyTick は TabDirtyWatcher の切り替わりで dirty を再計算するための再計算トリガー (本体では参照しない)
  const tabBarItems = useMemo(
    () =>
      paneTabs.map((tt) => ({
        id: tt.id,
        kind: tt.kind,
        title: tt.title,
        database: tt.database,
        table: tt.table,
        dirty: (() => {
          const d = isTabDirty(tt, getTabSql(tt));
          dirtyWatcher.recordShown(tt.id, d);
          return d;
        })(),
      })),
    [paneTabs, dirtyTick, getTabSql, dirtyWatcher],
  );
  if (!pane) return null;
  const tab = paneTabs.find((tt) => tt.id === pane.activeTabId) ?? null;
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
  // 結果領域が「どの軽量パネルを表示しているか」の判別子 (#788)。下の結果側
  // 条件分岐 (explain → batch → chart → pivot → json → preview → grid) と同順で一致させ、
  // これを AnimatePresence の key にすることで、パネルの種類が変わるとき (例:
  // グリッド ⇔ EXPLAIN) だけ控えめなクロスフェードを添える。table ⇔ query の
  // ように両者とも "grid" のままなら key は不変なので、重い ResultGrid を
  // フェードのために再マウントしない (issue #788 の設計方針: 軽量パネル側に
  // トランジションを限定)。tab が無い空状態は下の Splitter 分岐の外側で扱うため
  // ここでは使われない (安全に "empty" を返すだけ)。
  const contentMode = !tab
    ? "empty"
    : tab.kind === "explain"
      ? "explain"
      : tab.batchResults
        ? "batch"
        : tab.showChart && tab.result && !tab.streaming
          ? "chart"
          : tab.showPivot && tab.result && !tab.streaming
            ? "pivot"
            : tab.showJson && tab.result && !tab.streaming
              ? "json"
              : tab.preview
                ? "preview"
                : "grid";
  // 結果ツールバーの「EXPLAIN」(#1113)。直前に実行した SQL の実行計画を専用の
  // EXPLAIN タブで開く。keep-alive で保持するグリッドの中にも同じ Provider を置く (#1309)。
  const explainCtxValue =
    tab &&
    sessionId &&
    tab.kind !== "explain" &&
    !tab.batchResults &&
    !tab.streaming &&
    (tab.result?.columns.length ?? 0) > 0 &&
    tab.lastExecutedSql.trim().length > 0
      ? gridStable.fn(`${tab.id}:explainCtx`, () => actions.explainForTab(tab, tab.lastExecutedSql))
      : null;
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
      onMouseDownCapture={() => actions.focusPane(pane.id)}
    >
      <TabBar
        tabs={tabBarItems}
        activeTabId={pane.activeTabId}
        onSelect={onSelectTab}
        onClose={actions.handleCloseTab}
        onNew={onNewTab}
        newTabCombo={shortcutBindings.newTab}
        onReorder={onReorderTabs}
        onTabContextMenu={actions.openTabMenu}
        renamingTabId={renamingTabId}
        onRenameRequest={actions.requestRenameTab}
        onRename={actions.renameTab}
        onRenameCancel={actions.cancelRenameTab}
        onSplit={onSplit}
        splitMode={split ? "close" : "split"}
      />
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
                    <Icon name="maximize" size={ICON_SIZES.md} />
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
                    <Tooltip label={t("editorRestoreTitle")}>
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={() => actions.setLayoutMode("normal")}
                      >
                        <Icon name="minimize" size={ICON_SIZES.md} /> {t("editorFocusedLabel")}
                      </Button>
                    </Tooltip>
                  </Flex>
                )}
                <Box flex="1" minH={0} minW={0} display="flex" flexDirection="column" overflow="hidden">
              <Suspense fallback={<PaneEmpty><Spinner size={20} /></PaneEmpty>}>
                <QueryEditor
                  tabId={tab.id}
                  ref={getEditorRefSetter(pane.id)}
                  initialSql={getTabSql(tab)}
                  initialSelection={editorSelectionRef.current.get(tab.id) ?? tab.selection}
                  onSelectionChange={gridStable.fn(`${tab.id}:ed:selection`, (sel: { anchor: number; head: number }) =>
                    editorSelectionRef.current.set(tab.id, sel),
                  )}
                  running={tab.streaming && !tab.previewStreaming}
                  previewRunning={tab.previewStreaming}
                  onRun={gridStable.fn(`${tab.id}:ed:run`, (sql: string) => actions.resolveParamsThen(tab, sql, "run"))}
                  onRunInNewTab={
                    tab.kind === "explain"
                      ? undefined
                      : gridStable.fn(`${tab.id}:ed:runNewTab`, (sql: string) =>
                          actions.resolveParamsThen(tab, sql, "runNewTab"),
                        )
                  }
                  runNewTabCombo={shortcutBindings.runNewTab}
                  onPreview={
                    tab.kind === "explain"
                      ? undefined
                      : gridStable.fn(`${tab.id}:ed:preview`, (sql: string) =>
                          actions.resolveParamsThen(tab, sql, "preview"),
                        )
                  }
                  onExplain={
                    tab.kind === "explain"
                      ? undefined
                      : gridStable.fn(`${tab.id}:ed:explain`, (sql: string) =>
                          actions.resolveParamsThen(tab, sql, "explain"),
                        )
                  }
                  onBroadcast={
                    tab.kind === "explain"
                      ? undefined
                      : gridStable.fn(`${tab.id}:ed:broadcast`, (sql: string) =>
                          actions.requestBroadcast(sql, tab),
                        )
                  }
                  broadcastAvailable={broadcastAvailable}
                  explainMode={tab.kind === "explain"}
                  onDocChange={gridStable.fn(`${tab.id}:ed:doc`, (doc: { toString(): string }) =>
                    actions.handleEditorDocChange(tab.id, doc),
                  )}
                  onPreflightImpact={gridStable.fn(`${tab.id}:ed:preflight`, (r: PreflightResult | null) =>
                    preflightRef.current.set(tab.id, r),
                  )}
                  onSaveSnippet={actions.handleSaveSnippetFromEditor}
                  onOpenFile={onOpenSqlFile}
                  onSaveFile={onSaveSqlFile}
                  onFormatError={onFormatError}
                  disabled={!sessionId}
                  schemaTable={tab.schemaTable}
                  databaseSchema={paneSchema}
                  activeTable={gridStable.memo(
                    `${tab.id}:ed:activeTable`,
                    [tab.kind, tab.database, tab.table],
                    () =>
                      tab.kind === "table" && tab.database && tab.table
                        ? { database: tab.database, name: tab.table }
                        : null,
                  )}
                  sessionId={sessionId}
                  defaultDatabase={tab.database ?? selectedProfile?.database ?? null}
                  driver={selectedProfile?.driver ?? "mysql"}
                  builderSnapshot={tab.builderSnapshot}
                  onBuilderPersist={gridStable.fn(`${tab.id}:ed:builder`, (snapshot: Tab["builderSnapshot"]) =>
                    actions.updateTab(tab.id, { builderSnapshot: snapshot }),
                  )}
                  readOnly={readOnly}
                  isProduction={selectedProfile?.is_production ?? false}
                  onOpenSqlInNewTab={actions.handleOpenAiSql}
                  onAiSqlAction={actions.handleAiSqlAction}
                  emergencyMode={emergencyMode}
                  onToggleEmergencyMode={onToggleEmergencyMode}
                  queryHistory={queryHistory}
                  editorBindings={editorBindings}
                  focusMode={editorFocused}
                  onToggleFocus={sessionId ? onToggleEditorFocus : undefined}
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
                    <Icon name="maximize" size={ICON_SIZES.md} />
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
                    <Tooltip label={t("resultRestoreTitle")}>
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={() => actions.setLayoutMode("normal")}
                      >
                        <Icon name="minimize" size={ICON_SIZES.md} /> {t("resultMaximizedLabel")}
                      </Button>
                    </Tooltip>
                  </Flex>
                )}
                {/* ストリーミング実行中の indeterminate 進捗バー (#872)。結果
                    ペイン上端に置き、クエリ実行・プレビューの双方で「動いて
                    いる」ことをモーダル系進捗と同じ語彙で示す。running 信号は
                    既存の tab.streaming (フッター tone と同源) を共有する。 */}
                <StreamProgressBar active={!!tab.streaming} />
                <Box flex="1" minH={0} minW={0} display="flex" flexDirection="column" overflow="hidden">
              {/* 初回実行でグリッドのチャンクを読み込む間は、副次パネルと揃えた
                  骨格を出す (#1071)。表の結果を待っていない場合は従来の Spinner。 */}
              <Suspense
                fallback={
                  showsResultSkeletonFallback(tab) ? (
                    <ResultPaneSkeleton
                      columnCount={tab.result?.columns.length ?? null}
                      density={density}
                    />
                  ) : (
                    <PaneEmpty><Spinner size={20} /></PaneEmpty>
                  )
                }
              >
                {/* 結果パネルの種類が変わるとき (グリッド ⇔ EXPLAIN /
                    チャート / ピボット / プレビュー / バッチ) に控えめな
                    クロスフェードを添える (#788)。key は contentMode なので
                    同種のまま (table ⇔ query タブ切替など) は再生されず、
                    ResultGrid を余計に再マウントしない。reduced-motion は
                    ルートの MotionConfig で自動抑制。initial={false} で
                    ペイン初回描画時のフェードインは抑える。 */}
                {/* 結果ツールバーの「EXPLAIN」(#1113)。直前に実行した SQL の実行計画を
                    専用の EXPLAIN タブで開く (エディタの EXPLAIN と同じ経路)。 */}
                <ResultExplainContext.Provider value={explainCtxValue}>
                {/* exit を持たせない: 旧パネルは即座に外れ、新パネルだけがフェードインする
                    (`mode="wait"` だと退場 + 入場で 360ms の待ちが入っていた, #1311)。 */}
                <AnimatePresence initial={false}>
                  {contentMode !== "grid" && (
                  <motion.div
                    key={contentMode}
                    initial={variants.fade.initial}
                    animate={variants.fade.animate}
                    transition={transitions.enter}
                    style={{
                      flex: 1,
                      minHeight: 0,
                      minWidth: 0,
                      display: "flex",
                      flexDirection: "column",
                      overflow: "hidden",
                    }}
                  >
                {tab.kind === "explain" ? (
                  <ExplainViewer
                    result={tab.result}
                    driver={selectedProfile?.driver ?? "mysql"}
                    streaming={tab.streaming}
                    ai={
                      sessionId && selectedProfile
                        ? {
                            sessionId,
                            isProduction: selectedProfile.is_production ?? false,
                            readOnly,
                            sql: tab.explainSourceSql ?? getTabSql(tab),
                            database: tab.database ?? selectedProfile.database ?? null,
                            // 新しいタブに開くのは、EXPLAIN タブに DDL を入れると EXPLAIN CREATE INDEX になるため。
                            onInsertSql: (sql) => actions.openQueryInEditor(sql, undefined, tab.database),
                          }
                        : undefined
                    }
                    analyze={{
                      supported: explainAnalyzeSupported(selectedProfile?.driver),
                      active: !!tab.explainAnalyze,
                      onToggle: (next) => {
                        if (tab.streaming) return;
                        void actions.runExplainInTab(tab.id, getTabSql(tab), next);
                      },
                    }}
                  />
                ) : tab.batchResults ? (
                  <BatchResultsView
                    // 以下の結果ビューは同じcontentModeでもタブごとに作り直す。useState初期化子で設定を決めるため、使い回すと前タブの設定が残る(#1323)
                    key={tab.id}
                    results={tab.batchResults}
                    running={!!tab.batchRunning}
                    onRerun={(stopOnError) => {
                      if (tab.batchScript) void actions.runBatchInTab(tab.id, tab.batchScript, stopOnError);
                    }}
                    onClose={() => actions.patchTab(tab.id, (tt) => ({ ...tt, batchResults: undefined, batchScript: undefined }))}
                  />
                ) : tab.showChart && tab.result && !tab.streaming ? (
                  <ChartView
                    key={tab.id}
                    result={tab.result}
                    sourceSql={tab.lastExecutedSql}
                    driver={selectedProfile?.driver ?? "mysql"}
                    onRunQuery={
                      sessionId ? (sql) => api.runQuery(sessionId, sql, tab.database ?? null) : undefined
                    }
                    onChangeView={(v) => actions.setResultView(tab.id, v)}
                  />
                ) : tab.showJson && tab.result && !tab.streaming ? (
                  <ResultJsonView
                    key={tab.id}
                    result={tab.result}
                    database={tab.database ?? selectedProfile?.database ?? null}
                    table={tab.table ?? null}
                    onChangeView={(v) => actions.setResultView(tab.id, v)}
                  />
                ) : tab.showPivot && tab.result && !tab.streaming ? (
                  <PivotView
                    key={tab.id}
                    result={tab.result}
                    driver={selectedProfile?.driver ?? "mysql"}
                    sourceSql={tab.lastExecutedSql}
                    onSendToEditor={actions.openQueryInEditor}
                    onChangeView={(v) => actions.setResultView(tab.id, v)}
                  />
                ) : tab.preview ? (
                  <PreviewGrid
                    key={tab.id}
                    result={tab.preview}
                    rowLimit={tab.previewRowLimit}
                    streaming={tab.streaming}
                    onStop={() => actions.stopTab(tab)}
                    pendingEditsSummary={
                      tab.kind === "table" && summary.cells > 0 ? summary : undefined
                    }
                    onApplyEdits={
                      tab.kind === "table" && summary.cells > 0
                        ? () => actions.applyEditsForTab(tab)
                        : undefined
                    }
                    onDiscardEdits={
                      tab.kind === "table" && summary.cells > 0
                        ? () => actions.discardEditsAndPreviewForTab(tab.id)
                        : undefined
                    }
                    applyingEdits={tab.applyingEdits}
                  />
                ) : null}
                  </motion.div>
                  )}
                </AnimatePresence>
                </ResultExplainContext.Provider>
                {/* 結果グリッドは作り直さず非表示のまま保持する (#1309)。直近に開いた
                    GRID_KEEP_ALIVE_LIMIT 個のタブぶんだけ (MRU)、閉じたタブは即座に外す。
                    チャート / ピボット等の結果ビューへ切り替える間も隠れるだけで破棄しない
                    ので、グリッドへ戻っても選択・Find・列設定が残り、全行の再変換も走らない。 */}
                <KeepAlive
                  activeKey={contentMode === "grid" ? tab.id : null}
                  limit={GRID_KEEP_ALIVE_LIMIT}
                  liveKeys={pane.tabIds}
                >
                <ResultExplainContext.Provider value={explainCtxValue}>
                  <Flex direction="column" h="100%" minH={0} minW={0}>
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
                      <Icon name="table" size={ICON_SIZES.md} />
                      <chakra.span color="app.text">
                        {t("rowOpsBarSummary", {
                          inserts: tab.pendingInserts?.length ?? 0,
                          deletes: tab.pendingDeletes?.length ?? 0,
                        })}
                      </chakra.span>
                      <chakra.span flex="1" />
                      <Button type="button" variant="secondary" size="sm" onClick={() => actions.discardRowOpsForTab(tab.id)} disabled={tab.applyingEdits}>
                        <Icon name="close" size={ICON_SIZES.md} /> {t("rowOpsDiscard")}
                      </Button>
                      <LoadingButton type="button" variant="success" size="sm" loading={tab.applyingEdits} onClick={() => actions.applyEditsForTab(tab)}>
                        <Icon name="check" size={ICON_SIZES.md} /> {t("rowOpsApply")}
                      </LoadingButton>
                    </Flex>
                  )}
                  <ResultGridSlot register={getGridRefSetter(pane.id)}>
                  {(gridRef) => (
                  <ResultGrid
                    ref={gridRef}
                    gridBindings={gridBindings}
                    result={tab.result}
                    initialScrollTop={
                      tab.kind === "table"
                        ? (gridScrollRef.current.get(tab.id) ?? tab.gridScrollTop)
                        : undefined
                    }
                    onScroll={gridStable.fn(`${tab.id}:scroll`, (top: number) =>
                      gridScrollRef.current.set(tab.id, top),
                    )}
                    streaming={tab.streaming}
                    onStopStreaming={gridStable.fn(`${tab.id}:stop`, () => actions.stopTab(tab))}
                    loadingMore={tab.loadingMore}
                    canLoadMore={tab.kind === "table" && tab.paginatable ? false : tab.canLoadMore}
                    onLoadMore={gridStable.fn(`${tab.id}:loadMore`, () => actions.loadMoreInTab(tab.id))}
                    pendingDeleteKeys={gridStable.memo(
                      `${tab.id}:pendingDeleteKeys`,
                      [tab.pendingDeletes],
                      () => (tab.pendingDeletes ? new Set(tab.pendingDeletes) : undefined),
                    )}
                    onToggleRowDelete={
                      tableTabEditable(tab)
                        ? gridStable.fn(`${tab.id}:toggleRowDelete`, (key: string) =>
                            actions.toggleRowDeleteForTab(tab.id, key),
                          )
                        : undefined
                    }
                    onRequestInsertRow={
                      tableTabEditable(tab)
                        ? gridStable.fn(`${tab.id}:requestInsertRow`, () => actions.requestInsertRowForTab(tab.id))
                        : undefined
                    }
                    onDuplicateRow={
                      tableTabEditable(tab)
                        ? gridStable.fn(`${tab.id}:duplicateRow`, (row: Parameters<typeof actions.requestDuplicateRowForTab>[1]) =>
                            actions.requestDuplicateRowForTab(tab.id, row),
                          )
                        : undefined
                    }
                    autoLimitApplied={tab.autoLimitApplied}
                    partialResult={tab.partialResult ?? null}
                    onFetchAllRows={gridStable.fn(`${tab.id}:fetchAll`, () => actions.fetchAllForTab(tab))}
                    driver={selectedProfile?.driver ?? "mysql"}
                    database={tab.database ?? selectedProfile?.database ?? null}
                    table={tab.table ?? null}
                    editable={tableTabEditable(tab)}
                    readOnlyNotice={
                      tab.kind === "table" && tab.openTemplate && !tab.openTemplate.editable
                        ? t(
                            tab.openTemplate.source === "override"
                              ? "tableOpenQueryReadOnlyHintOverride"
                              : "tableOpenQueryReadOnlyHintGlobal",
                          )
                        : null
                    }
                    tableColumns={tab.tableColumns}
                    rowIdentity={tab.rowIdentity}
                    blobIo={
                      sessionId && tab.kind === "table"
                        ? gridStable.memo(
                            `${tab.id}:blobIo`,
                            [
                              sessionId,
                              tableTabEditable(tab),
                              gridStable.fn(
                                `${tab.id}:blobWrite`,
                                (r: number, c: number, hex: string) => actions.writeBlobForTab(tab, r, c, hex),
                              ),
                            ],
                            () => ({
                              sessionId,
                              onWrite: !tableTabEditable(tab)
                                ? undefined
                                : gridStable.fn(
                                    `${tab.id}:blobWrite`,
                                    (r: number, c: number, hex: string) =>
                                      actions.writeBlobForTab(tab, r, c, hex),
                                  ),
                            }),
                          )
                        : undefined
                    }
                    pendingEdits={tab.pendingEdits}
                    canUndo={(tab.editUndoStack?.length ?? 0) > 0}
                    canRedo={(tab.editRedoStack?.length ?? 0) > 0}
                    onSetCellEdit={gridStable.fn(`${tab.id}:setCellEdit`, (r: string, c: number, v: string | null) =>
                      actions.setCellEditForTab(tab.id, r, c, v),
                    )}
                    onBulkEdit={gridStable.fn(`${tab.id}:bulkEdit`, (edits: Parameters<typeof actions.setBulkCellEditsForTab>[1]) =>
                      actions.setBulkCellEditsForTab(tab.id, edits),
                    )}
                    onReplaceColumn={
                      tableTabEditable(tab) && tab.paginatable
                        ? gridStable.fn(`${tab.id}:replaceColumn`, (sql: string) =>
                            void actions.replaceColumnForTab(tab, sql),
                          )
                        : undefined
                    }
                    diffPrevRows={tab.prevResultRows ?? null}
                    diffComparable={
                      !!tab.prevResultSql && tab.prevResultSql === tab.lastExecutedSql
                    }
                    diffHighlightEnabled={tab.diffHighlight ?? false}
                    onToggleDiffHighlight={gridStable.fn(`${tab.id}:diffToggle`, () =>
                      actions.patchTab(tab.id, (tt) => ({ ...tt, diffHighlight: !tt.diffHighlight })),
                    )}
                    onChangeView={gridStable.fn(`${tab.id}:view`, (v: ResultViewKind) =>
                      actions.setResultView(tab.id, v),
                    )}
                    onSaveAsTable={
                      sessionId &&
                      !readOnly &&
                      tab.lastExecutedSql &&
                      isCtasEligibleSql(tab.lastExecutedSql, selectedProfile?.driver) &&
                      (tab.database ?? selectedProfile?.database)
                        ? gridStable.fn(`${tab.id}:saveAsTable`, () =>
                            actions.setSaveAsTableRequest({
                              sql: tab.lastExecutedSql,
                              database: (tab.database ?? selectedProfile?.database) as string,
                            }),
                          )
                        : undefined
                    }
                    onSaveAsView={
                      sessionId &&
                      !readOnly &&
                      tab.lastExecutedSql &&
                      isCtasEligibleSql(tab.lastExecutedSql, selectedProfile?.driver) &&
                      (tab.database ?? selectedProfile?.database)
                        ? gridStable.fn(`${tab.id}:saveAsView`, () =>
                            actions.setSaveAsViewRequest({
                              sql: tab.lastExecutedSql,
                              database: (tab.database ?? selectedProfile?.database) as string,
                              initialName: tab.editingViewName,
                            }),
                          )
                        : undefined
                    }
                    onTransferResult={
                      sessionId &&
                      tab.lastExecutedSql &&
                      isCtasEligibleSql(tab.lastExecutedSql, selectedProfile?.driver)
                        ? gridStable.fn(`${tab.id}:transfer`, () =>
                            actions.setTransferSource({
                              kind: "query",
                              database: tab.database ?? selectedProfile?.database ?? null,
                              sql: tab.lastExecutedSql,
                            }),
                          )
                        : undefined
                    }
                    onRegisterLocalTable={
                      sessionId && tab.result
                        ? gridStable.fn(`${tab.id}:registerLocal`, () =>
                            actions.handleRegisterLocalTable(tab.result as QueryResult, tab.lastExecutedSql),
                          )
                        : undefined
                    }
                    onClearEdits={gridStable.fn(`${tab.id}:clearEdits`, () => actions.clearEditsForTab(tab.id))}
                    onUndoEdit={gridStable.fn(`${tab.id}:undo`, () => actions.undoCellEditForTab(tab.id))}
                    onRedoEdit={gridStable.fn(`${tab.id}:redo`, () => actions.redoCellEditForTab(tab.id))}
                    onPreviewEdits={gridStable.fn(`${tab.id}:previewEdits`, () => actions.previewEditsForTab(tab))}
                    onApplyEdits={gridStable.fn(`${tab.id}:applyEdits`, () => actions.applyEditsForTab(tab))}
                    onApplyRowEdits={
                      tableTabEditable(tab)
                        ? gridStable.fn(
                            `${tab.id}:applyRowEdits`,
                            (rowKey: string, edits: Record<number, string>) =>
                              actions.applyEditsForTab(tab, { [rowKey]: edits }),
                          )
                        : undefined
                    }
                    applyingEdits={tab.applyingEdits}
                    autoRefreshSecs={tab.autoRefreshSecs ?? null}
                    autoRefreshAllowed={
                      !!tab.result &&
                      readOnlyWithHint(tab.lastRunReadOnly, tab.lastExecutedSql, selectedProfile?.driver)
                    }
                    autoRefreshLastRunAt={tab.autoRefreshLastRunAt ?? null}
                    onSetAutoRefresh={gridStable.fn(`${tab.id}:autoRefresh`, (secs: number | null) =>
                      actions.setAutoRefreshForTab(tab.id, secs),
                    )}
                    queryError={tab.queryError ?? null}
                    onRetry={
                      tab.lastExecutedSql
                        ? gridStable.fn(`${tab.id}:retry`, () => {
                            if (tab.kind === "table") {
                              void actions.runQueryInTab(tab.id, tab.lastExecutedSql, tab.paginatable);
                              return;
                            }
                            actions.runInTabWithGate(tab, tab.lastExecutedSql);
                          })
                        : undefined
                    }
                    onFkJump={gridStable.fn(`${tab.id}:fkJump`, (sql: string) => actions.openAndRunQuery(sql))}
                    incomingFks={
                      tab.kind === "table" && tab.table && tab.database && sessionId
                        ? incomingFkCache[incomingFkCacheKey(sessionId, tab.database, tab.table)] ??
                          NO_INCOMING_FKS
                        : undefined
                    }
                    onRunStatsQuery={
                      sessionId
                        ? gridStable.fn(`${tab.id}:statsQuery`, (sql: string) =>
                            api.runQuery(sessionId, sql, null),
                          )
                        : undefined
                    }
                    onRunRelatedQuery={
                      sessionId
                        ? gridStable.fn(`${tab.id}:relatedQuery`, (sql: string) =>
                            api.runQuery(sessionId, sql, tab.database ?? null),
                          )
                        : undefined
                    }
                    onLookupQuery={
                      sessionId
                        ? gridStable.memo(`${tab.id}:lookup`, [sessionId, lookupForSession], () =>
                            lookupForSession(sessionId),
                          )
                        : undefined
                    }
                    onExploreColumn={
                      sessionId
                        ? gridStable.fn(`${tab.id}:exploreColumn`, (target: { database?: string | null; table: string; column: string }) =>
                            actions.handleExploreColumns(target.database ?? "", target.table, target.column),
                          )
                        : undefined
                    }
                    serverSort={tab.kind === "table" ? tab.serverSort ?? null : undefined}
                    serverFilter={tab.kind === "table" ? tab.serverFilter ?? null : undefined}
                    onSetServerSort={
                      tab.kind === "table" && sessionId && tab.paginatable
                        ? gridStable.fn(`${tab.id}:serverSort`, (column: Parameters<typeof actions.setServerSortInTab>[1], direction: Parameters<typeof actions.setServerSortInTab>[2]) =>
                            actions.setServerSortInTab(tab.id, column, direction),
                          )
                        : undefined
                    }
                    onSetServerFilter={
                      tab.kind === "table" && sessionId && tab.paginatable
                        ? gridStable.fn(`${tab.id}:serverFilter`, (column: Parameters<typeof actions.setServerFilterInTab>[1], filter: Parameters<typeof actions.setServerFilterInTab>[2]) =>
                            actions.setServerFilterInTab(tab.id, column, filter),
                          )
                        : undefined
                    }
                    fullExport={
                      sessionId && (tab.kind === "table" ? tab.paginatable : tab.lastExecutedSql)
                        ? gridStable.memo(
                            `${tab.id}:fullExport`,
                            [
                              sessionId,
                              tab.kind,
                              tab.paginatable,
                              tab.lastExecutedSql,
                              tab.serverFilter,
                              tab.serverSort,
                              tab.openTemplate?.wrapBrowse,
                              selectedProfile?.driver,
                              defaultDisplayCount,
                              streamPrefetchSize,
                            ],
                            () => ({
                            sessionId,
                            // table タブは LIMIT を持たない base SQL を再実行して全件出す。
                            // アクティブなサーバ側ソート/フィルタ (#792) があれば、画面に
                            // 見えている条件と食い違わないよう同じ WHERE/ORDER BY を効かせる。
                            sql:
                              tab.kind === "table"
                                ? applyServerBrowse(
                                    tab.paginatable as string,
                                    selectedProfile?.driver ?? "mysql",
                                    tab.serverFilter ?? null,
                                    tab.serverSort ?? null,
                                    tab.openTemplate?.wrapBrowse ?? false,
                                  )
                                : tab.lastExecutedSql,
                            initialBatch: Math.max(1, defaultDisplayCount),
                            chunkSize: Math.max(1, streamPrefetchSize),
                          }),
                          )
                        : undefined
                    }
                    bundleContext={
                      // 調査バンドル (#745): 接続の非秘密メタ情報だけを渡す
                      // (パスワード・接続文字列は型ごと持たない)。
                      tab.result
                        ? gridStable.memo(
                            `${tab.id}:bundle`,
                            [
                              sessionId,
                              tab.lastExecutedSql,
                              tab.lastRunAt,
                              tab.lastRunReadOnly,
                              tab.database,
                              selectedProfile?.name,
                              selectedProfile?.host,
                              selectedProfile?.driver,
                            ],
                            () => ({
                            sql: tab.lastExecutedSql || null,
                            profileName: selectedProfile?.name ?? null,
                            host: selectedProfile?.host || null,
                            executedAt: tab.lastRunAt ?? null,
                            describe: sessionId
                              ? (db, table) => api.describeTable(sessionId, db, table)
                              : undefined,
                            // EXPLAIN は対応ドライバかつ読み取り SQL のときだけ (複文の書き込みを
                            // EXPLAIN 付きで送って実行してしまう事故を避ける)。
                            loadPlan:
                              sessionId &&
                              tab.lastExecutedSql &&
                              bundlePlanSupported(selectedProfile?.driver) &&
                              readOnlyWithHint(tab.lastRunReadOnly, tab.lastExecutedSql, selectedProfile?.driver)
                                ? () =>
                                    api.runQuery(
                                      sessionId,
                                      `${explainPrefixFor(selectedProfile?.driver)}${tab.lastExecutedSql}`,
                                      tab.database ?? null,
                                    )
                                : undefined,
                          }),
                          )
                        : undefined
                    }
                    lastEditAppliedAt={tab.lastEditAppliedAt}
                    maximized={maximized}
                    onToggleMaximize={onToggleResultMaximize}
                    onPinResult={gridStable.fn(`${tab.id}:pin`, () => actions.pinCurrentResult(tab))}
                    canPinResult={!!tab.result && !tab.streaming}
                  />
                  )}
                  </ResultGridSlot>
                  {tab.kind === "table" && tab.paginatable && tab.result && !tab.streaming && (
                    <PaginationBar
                      page={tab.page ?? 1}
                      pageSize={tab.pageSize ?? tab.previewRowLimit}
                      rowsOnPage={tab.result.rows.length}
                      totalPages={tableTotalPagesEstimate(tab, tab.pageSize ?? tab.previewRowLimit)}
                      loading={tab.loadingMore}
                      onGoToPage={gridStable.fn(`${tab.id}:goToPage`, (p: number) => actions.goToPageInTab(tab.id, p))}
                      onSetPageSize={gridStable.fn(`${tab.id}:pageSize`, (s: number) =>
                        actions.setPageSizeInTab(tab.id, s),
                      )}
                    />
                  )}
                  </Flex>
                </ResultExplainContext.Provider>
                </KeepAlive>
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
              action={{ label: t("tabsNewQuery"), onClick: () => actions.handleNewTab(pane.id), testId: "new-query-empty" }}
              secondaryActions={emptyActions}
            />
          </PaneEmpty>
        )}
      </Flex>
    </Flex>
  );
  },
  (a, b) =>
    a.paneId === b.paneId && a.split === b.split && a.isFocused === b.isFocused && sameEnv(a.env, b.env),
);
