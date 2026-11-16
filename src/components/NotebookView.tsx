import { lazy, memo, Suspense, useCallback, useMemo, useRef, useState } from "react";
import { Box, Flex, chakra } from "@chakra-ui/react";
import { AnimatePresence, Reorder, useDragControls, useReducedMotionConfig } from "motion/react";
import { open as openFileDialog, save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { api } from "../api/tauri";
import type { ConnectionProfile, QueryResult, TableSchema } from "../api/tauri";
import { useT, getLocale, t as translate } from "../i18n";
import { useSettings } from "../settings";
import { transitions, variants } from "../motion";
import {
  buildErrorSnapshot,
  buildSnapshot,
  cellHasWrites,
  clampSnapshotRowLimit,
  createEmptyNotebook,
  insertCellAfter,
  moveCell,
  newMarkdownCell,
  newSqlCell,
  NOTEBOOK_FILE_EXTENSION,
  notebookFileName,
  parseNotebook,
  removeCell,
  reorderCellsByIds,
  serializeNotebook,
  SNAPSHOT_ROW_LIMIT_CHOICES,
  sqlCellsToRun,
  updateCell,
  utf8ByteLength,
  MAX_NOTEBOOK_FILE_BYTES,
  MAX_SNAPSHOT_CELL_CHARS,
  type NotebookCell,
  type NotebookDoc,
  type NotebookSnapshot,
  type NotebookSqlCell,
} from "../notebook";
import {
  formatLocalSnapshotTime,
  notebookToHtml,
  notebookToMarkdown,
  type NotebookExportText,
} from "../notebookExport";
import {
  cancelNotebookStream,
  NotebookRunError,
  type NotebookRunOutput,
  type NotebookRunRequest,
} from "../notebookExec";
import { markNotebookSaved, replaceNotebook, updateNotebook, useNotebookState } from "../notebookStore";
import type { ChartConfig } from "./chartData";
import type { MaskConfig } from "./columnMask";
import { semanticColorToken } from "../semanticColors";
import { Callout } from "./Callout";
import { useConfirm } from "./ConfirmDialog";
import { EmptyState } from "./EmptyState";
import { Icon, ICON_SIZES } from "./Icon";
import { ListboxSelect } from "./ListboxSelect";
import { MarkdownView } from "./MarkdownView";
import { ErrorNote } from "./modalForm";
import { ResultViewSwitch } from "./ResultViewSwitch";
import { Spinner } from "./Spinner";
import { useToast } from "./Toast";
import { Tooltip } from "./Tooltip";
import { Button, Heading, Input, Textarea } from "./ui";
import { prefersStaticMotion } from "./revealOrigin";

const QueryEditor = lazy(() => import("./QueryEditor").then((m) => ({ default: m.QueryEditor })));
const ChartView = lazy(() => import("./ChartView").then((m) => ({ default: m.ChartView })));

/**
 * SQL ノートブック (#2380) の全画面サーフェス。Markdown セルと SQL セルを交互に並べ、各 SQL セルの結果を
 * スナップショットとして `.noobnb` に保存・再実行・書き出し (Markdown / HTML) できる。
 *
 * - 実行は `onRunSql` (App が既存の実行ゲート `runGuardedDdl` + ストリーミング実行へ橋渡しする) だけを通る。
 *   このコンポーネントは接続・安全網を持たない。
 * - 文書は `notebookStore` が持つので、画面が keep-alive から捨てられても未保存の編集は残る。
 * - 結果の表示は保存したスナップショットそのもの (開き直しても再実行せずに読める)。
 */

export interface NotebookViewProps {
  sessionId: string | null;
  profile: ConnectionProfile | null;
  /** 補完用スキーマの取得 (ノートブックの実行先 DB で引く)。 */
  schemaForDatabase: (database: string | null | undefined) => TableSchema[] | null;
  emergencyMode: boolean;
  /** 明示トランザクション中。中は同じ接続で 1 文ずつ流すため、実行中の中止ができない。 */
  transactionActive: boolean;
  /**
   * 1 セルぶんの SQL を既存の実行経路で流す。確認ダイアログで取りやめたら null。失敗は `NotebookRunError`。
   */
  onRunSql: (sql: string, req: NotebookRunRequest) => Promise<NotebookRunOutput | null>;
  /** SQL を通常のクエリタブで開く (実行はしない)。 */
  onOpenInEditor: (sql: string, title: string) => void;
  onClose: () => void;
}

function exportText(): NotebookExportText {
  return {
    untitled: translate("notebookUntitled"),
    snapshotMeta: (s, time) =>
      translate("notebookSnapshotMeta", {
        time,
        rows: s.hasColumns ? s.totalRows : s.rowsAffected,
        ms: s.elapsedMs,
      }),
    truncated: (shown, total) => translate("notebookTruncated", { shown, total }),
    error: (error) => translate("notebookError", { error }),
    affected: (rows) => translate("notebookAffected", { rows }),
    notRun: translate("notebookNotRun"),
    masked: (columns) => translate("notebookMasked", { columns }),
    autoLimit: (limit) => translate("notebookAutoLimit", { limit }),
    valuesTruncated: (chars) => translate("notebookValuesTruncated", { chars }),
    exportedAt: (time) => translate("notebookExportedAt", { time }),
    connection: (name) => translate("notebookConnectionLine", { name }),
  };
}

function snapshotToResult(s: NotebookSnapshot): QueryResult {
  return { columns: s.columns, rows: s.rows, rows_affected: s.rowsAffected, elapsed_ms: s.elapsedMs };
}

/** スナップショットの結果表。先頭 N 行だけの軽い表で、値の編集・並べ替えはしない。 */
function SnapshotTable({ snapshot }: { snapshot: NotebookSnapshot }) {
  const t = useT();
  return (
    <chakra.div overflow="auto" maxH="360px" border="1px solid" borderColor="app.border" borderRadius="md">
      <chakra.table
        aria-label={t("notebookResultAria")}
        fontFamily="mono"
        fontSize="sm"
        borderCollapse="separate"
        borderSpacing="0"
        minW="100%"
      >
        <chakra.thead>
          <tr>
            {snapshot.columns.map((c, i) => (
              <chakra.th
                key={i}
                position="sticky"
                top="0"
                bg="app.toolbar"
                textAlign="left"
                fontWeight={600}
                px="2.5"
                py="1.25"
                borderBottom="1px solid"
                borderColor="app.border"
                whiteSpace="nowrap"
              >
                {c.name}
              </chakra.th>
            ))}
          </tr>
        </chakra.thead>
        <tbody>
          {snapshot.rows.map((row, ri) => (
            <tr key={ri}>
              {snapshot.columns.map((_, ci) => {
                const v = row[ci] ?? null;
                return (
                  <chakra.td
                    key={ci}
                    px="2.5"
                    py="1.25"
                    borderBottom="1px solid"
                    borderColor="app.border"
                    whiteSpace="nowrap"
                    maxW="320px"
                    overflow="hidden"
                    textOverflow="ellipsis"
                    color={v === null ? "app.textMuted" : "app.text"}
                    fontStyle={v === null ? "italic" : "normal"}
                  >
                    {v === null ? "NULL" : String(v)}
                  </chakra.td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </chakra.table>
    </chakra.div>
  );
}

interface CellResultProps {
  cell: NotebookSqlCell;
  onViewChange: (id: string, view: "table" | "chart") => void;
  onChartChange: (id: string, chart: ChartConfig) => void;
}

function CellResult({ cell, onViewChange, onChartChange }: CellResultProps) {
  const t = useT();
  const s = cell.snapshot;
  if (!s) {
    return (
      <chakra.div color="app.textMuted" textStyle="caption">
        {t("notebookNotRun")}
      </chakra.div>
    );
  }
  const meta = (
    <chakra.div color="app.textMuted" textStyle="caption" data-testid="notebook-snapshot-meta">
      {t("notebookSnapshotMeta", {
        time: formatLocalSnapshotTime(s.executedAt, getLocale()),
        rows: s.hasColumns ? s.totalRows : s.rowsAffected,
        ms: s.elapsedMs,
      })}
    </chakra.div>
  );
  if (s.error) {
    return (
      <Flex direction="column" gap="2">
        {meta}
        <ErrorNote role="alert">{t("notebookError", { error: s.error })}</ErrorNote>
      </Flex>
    );
  }
  if (!s.hasColumns) {
    return (
      <Flex direction="column" gap="2">
        {meta}
        <chakra.div fontSize="md">{t("notebookAffected", { rows: s.rowsAffected })}</chakra.div>
      </Flex>
    );
  }
  return (
    <Flex direction="column" gap="2">
      <Flex align="center" gap="3" flexWrap="wrap">
        {cell.view === "table" && (
          <ResultViewSwitch
            value="grid"
            views={["grid", "chart"]}
            onChange={(v) => v === "chart" && onViewChange(cell.id, "chart")}
          />
        )}
        {meta}
      </Flex>
      {s.truncated && (
        <Callout tone="info" role="status">
          {t("notebookTruncated", { shown: s.rows.length, total: s.totalRows })}
        </Callout>
      )}
      {s.appliedAutoLimit !== null && (
        <chakra.div color="app.textMuted" textStyle="caption">
          {t("notebookAutoLimit", { limit: s.appliedAutoLimit })}
        </chakra.div>
      )}
      {s.valuesTruncated && (
        <chakra.div color="app.textMuted" textStyle="caption">
          {t("notebookValuesTruncated", { chars: MAX_SNAPSHOT_CELL_CHARS })}
        </chakra.div>
      )}
      {s.maskedColumns.length > 0 && (
        <chakra.div color="app.textMuted" textStyle="caption">
          {t("notebookMasked", { columns: s.maskedColumns.join(", ") })}
        </chakra.div>
      )}
      {cell.view === "chart" ? (
        <Box h="360px" border="1px solid" borderColor="app.border" borderRadius="md" overflow="hidden">
          <Suspense fallback={<Spinner size={16} />}>
            <ChartView
              // 結果が入れ替わったら設定の復元からやり直す。
              key={s.executedAt}
              result={snapshotToResult(s)}
              onChangeView={() => onViewChange(cell.id, "table")}
              availableViews={["grid", "chart"]}
              initialConfig={cell.chart}
              onConfigChange={(c) => onChartChange(cell.id, c)}
            />
          </Suspense>
        </Box>
      ) : (
        <SnapshotTable snapshot={s} />
      )}
    </Flex>
  );
}

interface CellShellProps {
  cell: NotebookCell;
  index: number;
  count: number;
  still: boolean;
  running: boolean;
  runDisabled: string | null;
  driver: string | undefined;
  editing: boolean;
  sessionId: string | null;
  profile: ConnectionProfile | null;
  databaseSchema: TableSchema[] | null;
  defaultDatabase: string | null;
  emergencyMode: boolean;
  onRun: (id: string) => void;
  onRunFrom: (id: string) => void;
  onMove: (id: string, delta: -1 | 1) => void;
  onRemove: (id: string) => void;
  onToggleCollapse: (id: string) => void;
  onSql: (id: string, sql: string) => void;
  onMarkdown: (id: string, text: string) => void;
  onEditing: (id: string, editing: boolean) => void;
  onViewChange: (id: string, view: "table" | "chart") => void;
  onChartChange: (id: string, chart: ChartConfig) => void;
  onOpenInEditor: (id: string) => void;
  onAddAfter: (id: string, kind: "markdown" | "sql") => void;
}

/** セル 1 つぶんの枠。並べ替え (`Reorder.Item`)・折りたたみ・追加/削除の出入りの動きを持つ。 */
const CellShell = memo(function CellShell(p: CellShellProps) {
  const t = useT();
  const controls = useDragControls();
  const { cell } = p;
  const isSql = cell.kind === "sql";
  const writes = isSql && cellHasWrites(cell.sql, p.driver);
  const label = isSql ? t("notebookCellSql") : t("notebookCellMarkdown");
  const instant = { duration: 0 } as const;
  const summary = cell.kind === "sql" ? cell.sql.trim().split("\n")[0] : cell.text.trim().split("\n")[0];

  return (
    <Reorder.Item
      as="div"
      value={cell.id}
      dragListener={false}
      dragControls={controls}
      layout={p.still ? undefined : "position"}
      variants={variants.collapse}
      initial="initial"
      animate="animate"
      exit="exit"
      transition={p.still ? instant : transitions.enter}
      whileDrag={p.still ? undefined : { boxShadow: "var(--shadow-lg)", zIndex: 3 }}
      style={{ listStyle: "none" }}
      data-testid="notebook-cell"
      data-cell-kind={cell.kind}
    >
      <chakra.div pb="3">
        <chakra.section
          aria-label={`${label} ${p.index + 1}`}
          border="1px solid"
          borderColor={writes ? semanticColorToken("warning", "border") : "app.border"}
          borderRadius="lg"
          bg="app.surface"
        >
          <Flex
            align="center"
            gap="1.5"
            px="2"
            py="1.5"
            bg="app.toolbar"
            borderBottom={cell.collapsed ? "none" : "1px solid"}
            borderColor="app.border"
            borderTopRadius="lg"
          >
            <Tooltip label={t("notebookDragHandle")}>
              <chakra.span
                role="img"
                aria-label={t("notebookDragHandle")}
                display="inline-flex"
                cursor="grab"
                color="app.textMuted"
                css={{ touchAction: "none" }}
                onPointerDown={(e) => controls.start(e)}
              >
                <Icon name="grip" size={ICON_SIZES.md} />
              </chakra.span>
            </Tooltip>
            <chakra.span textStyle="overline" color="app.textMuted">
              {label}
            </chakra.span>
            {writes && (
              <Tooltip label={t("notebookWritesTip")}>
                <chakra.span
                  tabIndex={0}
                  display="inline-flex"
                  alignItems="center"
                  gap="1"
                  fontSize="xs"
                  color="app.textWarning"
                  data-testid="notebook-writes-badge"
                >
                  <Icon name="warning" size={ICON_SIZES.sm} />
                  {t("notebookWritesBadge")}
                </chakra.span>
              </Tooltip>
            )}
            {cell.collapsed && summary && (
              <chakra.span
                flex="1"
                minW={0}
                overflow="hidden"
                textOverflow="ellipsis"
                whiteSpace="nowrap"
                color="app.textMuted"
                fontFamily={isSql ? "mono" : undefined}
                fontSize="sm"
              >
                {summary}
              </chakra.span>
            )}
            {!cell.collapsed && <chakra.span flex="1" />}
            {isSql && (
              <>
                <Tooltip label={p.runDisabled ?? t("notebookRunCell")}>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={!!p.runDisabled || p.running}
                    onClick={() => p.onRun(cell.id)}
                    aria-label={t("notebookRunCell")}
                  >
                    {p.running ? <Spinner size={12} /> : <Icon name="play" size={ICON_SIZES.sm} />}
                  </Button>
                </Tooltip>
                <Tooltip label={p.runDisabled ?? t("notebookRunFrom")}>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!!p.runDisabled}
                    onClick={() => p.onRunFrom(cell.id)}
                    aria-label={t("notebookRunFrom")}
                  >
                    <Icon name="play" size={ICON_SIZES.sm} />
                    {t("notebookRunFromShort")}
                  </Button>
                </Tooltip>
                <Tooltip label={t("notebookOpenInEditor")}>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => p.onOpenInEditor(cell.id)}
                    aria-label={t("notebookOpenInEditor")}
                  >
                    <Icon name="external-link" size={ICON_SIZES.sm} />
                  </Button>
                </Tooltip>
              </>
            )}
            {!isSql && (
              <Button size="sm" variant="ghost" onClick={() => p.onEditing(cell.id, !p.editing)}>
                <Icon name={p.editing ? "check" : "pencil"} size={ICON_SIZES.sm} />
                {p.editing ? t("notebookDoneEditing") : t("notebookEdit")}
              </Button>
            )}
            <Tooltip label={t("notebookMoveUp")}>
              <Button
                size="sm"
                variant="ghost"
                disabled={p.index === 0}
                onClick={() => p.onMove(cell.id, -1)}
                aria-label={t("notebookMoveUp")}
              >
                <Icon name="chevron-up" size={ICON_SIZES.sm} />
              </Button>
            </Tooltip>
            <Tooltip label={t("notebookMoveDown")}>
              <Button
                size="sm"
                variant="ghost"
                disabled={p.index === p.count - 1}
                onClick={() => p.onMove(cell.id, 1)}
                aria-label={t("notebookMoveDown")}
              >
                <Icon name="chevron-down" size={ICON_SIZES.sm} />
              </Button>
            </Tooltip>
            <Tooltip label={cell.collapsed ? t("notebookExpand") : t("notebookCollapse")}>
              <Button
                size="sm"
                variant="ghost"
                aria-expanded={!cell.collapsed}
                onClick={() => p.onToggleCollapse(cell.id)}
                aria-label={cell.collapsed ? t("notebookExpand") : t("notebookCollapse")}
              >
                <chakra.span
                  display="inline-flex"
                  transform={cell.collapsed ? "rotate(-90deg)" : "none"}
                  transition="transform var(--dur-fast) var(--ease)"
                >
                  <Icon name="chevron-down" size={ICON_SIZES.sm} />
                </chakra.span>
              </Button>
            </Tooltip>
            <Tooltip label={t("notebookDelete")}>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => p.onRemove(cell.id)}
                aria-label={t("notebookDelete")}
              >
                <Icon name="trash" size={ICON_SIZES.sm} />
              </Button>
            </Tooltip>
          </Flex>
          {!cell.collapsed && (
            <Flex direction="column" gap="3" p="3">
              {cell.kind === "sql" ? (
                <>
                  <Flex
                    direction="column"
                    h="200px"
                    border="1px solid"
                    borderColor="app.border"
                    borderRadius="md"
                    overflow="hidden"
                  >
                    <Suspense fallback={<Spinner size={16} />}>
                      <QueryEditor
                        initialSql={cell.sql}
                        onChange={(sql) => p.onSql(cell.id, sql)}
                        onRun={() => p.onRun(cell.id)}
                        running={p.running}
                        sessionId={p.sessionId}
                        driver={p.profile?.driver ?? "mysql"}
                        databaseSchema={p.databaseSchema}
                        defaultDatabase={p.defaultDatabase}
                        readOnly={p.profile?.read_only ?? false}
                        isProduction={p.profile?.is_production ?? false}
                        emergencyMode={p.emergencyMode}
                      />
                    </Suspense>
                  </Flex>
                  <CellResult cell={cell} onViewChange={p.onViewChange} onChartChange={p.onChartChange} />
                </>
              ) : p.editing || cell.text.trim() === "" ? (
                <Textarea
                  value={cell.text}
                  rows={5}
                  autoFocus={p.editing}
                  aria-label={t("notebookCellMarkdown")}
                  placeholder={t("notebookMarkdownPlaceholder")}
                  onChange={(e) => p.onMarkdown(cell.id, e.target.value)}
                  fontFamily="mono"
                />
              ) : (
                <chakra.div
                  onDoubleClick={() => p.onEditing(cell.id, true)}
                  data-testid="notebook-markdown-view"
                >
                  <MarkdownView source={cell.text} />
                </chakra.div>
              )}
            </Flex>
          )}
        </chakra.section>
        <Flex gap="2" pt="1.5" justify="center" opacity={0.85}>
          <Button size="sm" variant="ghost" onClick={() => p.onAddAfter(cell.id, "sql")}>
            <Icon name="plus" size={ICON_SIZES.sm} />
            {t("notebookAddSql")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => p.onAddAfter(cell.id, "markdown")}>
            <Icon name="plus" size={ICON_SIZES.sm} />
            {t("notebookAddMarkdown")}
          </Button>
        </Flex>
      </chakra.div>
    </Reorder.Item>
  );
});

export function NotebookView(props: NotebookViewProps) {
  const t = useT();
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const settings = useSettings();
  const { doc, filePath, dirty } = useNotebookState();
  const reduced = useReducedMotionConfig() ?? false;
  const still = reduced || prefersStaticMotion();
  const [editingIds, setEditingIds] = useState<ReadonlySet<string>>(() => new Set());
  const [runningId, setRunningId] = useState<string | null>(null);
  const [runAll, setRunAll] = useState(false);
  const streamRef = useRef<string | null>(null);
  const cancelRef = useRef(false);

  const mask: MaskConfig = useMemo(
    () => ({ enabled: settings.columnMaskEnabled, patterns: settings.columnMaskPatterns }),
    [settings.columnMaskEnabled, settings.columnMaskPatterns],
  );
  const maskRef = useRef(mask);
  maskRef.current = mask;
  const docRef = useRef(doc);
  docRef.current = doc;
  const profileRef = useRef(props.profile);
  profileRef.current = props.profile;
  const driver = props.profile?.driver;
  // 補完用の DB。ノートブックの実行先 (空なら接続の既定 DB)。
  const completionDb = doc.database ?? props.profile?.database ?? null;
  const databaseSchema = props.schemaForDatabase(completionDb);
  const busy = runningId !== null;
  const runDisabled = !props.sessionId ? t("notebookNeedsConnection") : null;

  const patchCell = useCallback(
    (id: string, patch: Parameters<typeof updateCell>[2]) =>
      updateNotebook((d) => ({ ...d, cells: updateCell(d.cells, id, patch) })),
    [],
  );

  /** 1 セルを実行してスナップショットを書き戻す。続けてよいなら true。 */
  const runOne = useCallback(
    async (cell: NotebookSqlCell): Promise<boolean> => {
      setRunningId(cell.id);
      const started = Date.now();
      try {
        const limit = clampSnapshotRowLimit(docRef.current.snapshotRowLimit);
        const out = await props.onRunSql(cell.sql, {
          rowCap: limit,
          database: docRef.current.database,
          onStart: (id) => {
            streamRef.current = id;
          },
          isCancelled: () => cancelRef.current,
        });
        if (out === null) return false;
        const snapshot = buildSnapshot({ ...out, error: null }, limit, maskRef.current);
        patchCell(cell.id, { snapshot });
        return true;
      } catch (e) {
        if (e instanceof NotebookRunError && e.cancelled) return false;
        const message = e instanceof Error ? e.message : String(e);
        patchCell(cell.id, { snapshot: buildErrorSnapshot(message, Date.now() - started) });
        return false;
      } finally {
        streamRef.current = null;
        setRunningId(null);
      }
    },
    [props.onRunSql, patchCell],
  );

  /**
   * 保存時の接続と現在の接続が違うときは、実行前に確認する (特に現在が本番のとき)。承認したらファイルの接続を
   * 現在の接続へ付け替える (黙って書き換えない)。接続がまだ無い文書は黙って現在の接続を記録する。
   */
  const confirmConnection = async (): Promise<boolean> => {
    const profile = profileRef.current;
    const saved = docRef.current.connection;
    if (!profile) return true;
    if (!saved) {
      updateNotebook((d) => ({ ...d, connection: { profileId: profile.id, name: profile.name } }));
      return true;
    }
    if (saved.profileId === profile.id) return true;
    const ok = await confirm({
      title: t("notebookRebindTitle"),
      message: t(profile.is_production ? "notebookRebindMessageProd" : "notebookRebindMessage", {
        saved: saved.name,
        current: profile.name,
      }),
      confirmLabel: t("notebookRebindConfirm"),
      tone: profile.is_production ? "danger" : undefined,
    });
    if (ok) updateNotebook((d) => ({ ...d, connection: { profileId: profile.id, name: profile.name } }));
    return ok;
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: confirmConnection は profileRef / docRef から最新を読む
  const runCells = useCallback(
    async (cells: NotebookSqlCell[], all: boolean) => {
      // 未接続でも文書の編集はできるが、実行はしない (ボタンも無効)。
      if (busy || cells.length === 0 || !props.sessionId) return;
      if (!(await confirmConnection())) return;
      cancelRef.current = false;
      setRunAll(all);
      for (const c of cells) {
        if (cancelRef.current) break;
        // 実行直前の最新の SQL を使う (編集直後の実行でも取りこぼさない)。
        const latest = docRef.current.cells.find((x) => x.id === c.id);
        if (!latest || latest.kind !== "sql") continue;
        // 失敗・取りやめ・中止のセルで止める (後続は前のセルの結果を前提にしがち)。
        if (!(await runOne(latest))) break;
      }
      setRunAll(false);
    },
    [busy, runOne, props.sessionId],
  );

  const onRunCell = useCallback(
    (id: string) => {
      const c = docRef.current.cells.find((x) => x.id === id);
      if (c?.kind === "sql" && c.sql.trim()) void runCells([c], false);
    },
    [runCells],
  );
  const onRunFrom = useCallback(
    (id: string) => void runCells(sqlCellsToRun(docRef.current.cells, id), true),
    [runCells],
  );
  const stop = () => {
    cancelRef.current = true;
    if (streamRef.current) cancelNotebookStream(streamRef.current);
  };

  const onMove = useCallback(
    (id: string, delta: -1 | 1) => updateNotebook((d) => ({ ...d, cells: moveCell(d.cells, id, delta) })),
    [],
  );
  const onRemove = useCallback(
    (id: string) => updateNotebook((d) => ({ ...d, cells: removeCell(d.cells, id) })),
    [],
  );
  const onToggleCollapse = useCallback(
    (id: string) => {
      const c = docRef.current.cells.find((x) => x.id === id);
      if (c) patchCell(id, { collapsed: !c.collapsed });
    },
    [patchCell],
  );
  const onSql = useCallback((id: string, sql: string) => patchCell(id, { sql }), [patchCell]);
  const onMarkdown = useCallback((id: string, text: string) => patchCell(id, { text }), [patchCell]);
  const onEditing = useCallback((id: string, editing: boolean) => {
    setEditingIds((prev) => {
      const next = new Set(prev);
      if (editing) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const onViewChange = useCallback(
    (id: string, view: "table" | "chart") => patchCell(id, { view }),
    [patchCell],
  );
  const onChartChange = useCallback(
    (id: string, chart: ChartConfig) => patchCell(id, { chart }),
    [patchCell],
  );
  const onOpenInEditor = useCallback(
    (id: string) => {
      const c = docRef.current.cells.find((x) => x.id === id);
      if (c?.kind === "sql") props.onOpenInEditor(c.sql, docRef.current.title || translate("notebookTitle"));
    },
    [props.onOpenInEditor],
  );
  const onAddAfter = useCallback((afterId: string | null, kind: "markdown" | "sql") => {
    const cell = kind === "sql" ? newSqlCell() : newMarkdownCell();
    updateNotebook((d) => ({ ...d, cells: insertCellAfter(d.cells, afterId, cell) }));
    if (kind === "markdown") setEditingIds((prev) => new Set(prev).add(cell.id));
  }, []);
  const onReorder = useCallback(
    (ids: string[]) => updateNotebook((d) => ({ ...d, cells: reorderCellsByIds(d.cells, ids) })),
    [],
  );

  /** 保存・書き出しに使う接続。付け替えは実行前の確認 (`confirmConnection`) だけで行い、ここでは書き換えない。 */
  const connectionRef = () =>
    docRef.current.connection ??
    (props.profile ? { profileId: props.profile.id, name: props.profile.name } : null);

  const guardDiscard = async (): Promise<boolean> => {
    if (!dirty) return true;
    return confirm({
      title: t("notebookDiscardTitle"),
      message: t("notebookDiscardMessage"),
      confirmLabel: t("notebookDiscardConfirm"),
      tone: "danger",
    });
  };

  const onNew = async () => {
    if (!(await guardDiscard())) return;
    replaceNotebook(
      createEmptyNotebook(props.profile ? { profileId: props.profile.id, name: props.profile.name } : null),
      null,
    );
    setEditingIds(new Set());
  };

  const onOpen = async () => {
    if (!(await guardDiscard())) return;
    try {
      const picked = await openFileDialog({
        multiple: false,
        directory: false,
        title: t("notebookOpen"),
        filters: [{ name: t("notebookFileFilter"), extensions: [NOTEBOOK_FILE_EXTENSION] }],
      });
      if (typeof picked !== "string" || !picked) return;
      const parsed = parseNotebook(await api.readTextFile(picked));
      if (!parsed.ok) {
        toast.error(
          t(
            parsed.reason === "newerVersion"
              ? "notebookOpenNewer"
              : parsed.reason === "format"
                ? "notebookOpenFormat"
                : "notebookOpenInvalid",
          ),
        );
        return;
      }
      replaceNotebook(parsed.doc, picked);
      setEditingIds(new Set());
    } catch (e) {
      toast.error(t("notebookOpenError", { error: String(e) }));
    }
  };

  const writeDoc = async (path: string) => {
    const withConn = { ...docRef.current, connection: connectionRef() };
    const body = serializeNotebook(withConn, maskRef.current);
    // 読み込み (`read_text_file`) の上限を超えると開き直せないので、保存前に止める。
    const bytes = utf8ByteLength(body);
    if (bytes > MAX_NOTEBOOK_FILE_BYTES) {
      toast.error(
        t("notebookTooLarge", {
          size: (bytes / (1024 * 1024)).toFixed(1),
          limit: MAX_NOTEBOOK_FILE_BYTES / (1024 * 1024),
        }),
      );
      return;
    }
    await api.writeTextFile(path, body);
    markNotebookSaved(path);
    toast.success(t("notebookSaved", { path }));
  };

  const onSave = async (forceDialog: boolean) => {
    try {
      let path = forceDialog ? null : filePath;
      if (!path) {
        const picked = await saveFileDialog({
          defaultPath: notebookFileName(docRef.current.title),
          title: t("notebookSave"),
          filters: [{ name: t("notebookFileFilter"), extensions: [NOTEBOOK_FILE_EXTENSION] }],
        });
        if (typeof picked !== "string" || !picked) return;
        path = picked;
      }
      await writeDoc(path);
    } catch (e) {
      toast.error(t("notebookSaveError", { error: String(e) }));
    }
  };

  const onExport = async (kind: "md" | "html") => {
    try {
      const d: NotebookDoc = { ...docRef.current, connection: connectionRef() };
      // 書き出しもファイル保存と同じく、取得後に変えたマスク設定を反映する。
      const forExport: NotebookDoc = parseOrSame(d, maskRef.current);
      const picked = await saveFileDialog({
        defaultPath: notebookFileName(d.title, kind),
        title: kind === "md" ? t("notebookExportMd") : t("notebookExportHtml"),
        filters: [
          kind === "md" ? { name: "Markdown", extensions: ["md"] } : { name: "HTML", extensions: ["html"] },
        ],
      });
      if (typeof picked !== "string" || !picked) return;
      const body =
        kind === "md"
          ? notebookToMarkdown(forExport, exportText())
          : notebookToHtml(forExport, exportText(), getLocale());
      await api.writeTextFile(picked, body);
      toast.success(t("notebookExported", { path: picked }));
    } catch (e) {
      toast.error(t("notebookExportError", { error: String(e) }));
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "s") {
      e.preventDefault();
      void onSave(e.shiftKey);
    }
  };

  const sqlCount = doc.cells.filter((c) => c.kind === "sql").length;
  const mismatch =
    doc.connection && props.profile && doc.connection.profileId !== props.profile.id ? doc.connection : null;
  const ids = doc.cells.map((c) => c.id);

  return (
    <Flex direction="column" flex="1" minH={0} onKeyDown={onKeyDown} data-testid="notebook-view">
      <chakra.header
        display="flex"
        alignItems="center"
        gap="2"
        flexWrap="wrap"
        py="3"
        px="6"
        borderBottom="1px solid"
        borderColor="app.border"
      >
        <Heading>{t("notebookTitle")}</Heading>
        <Input
          value={doc.title}
          onChange={(e) => updateNotebook((d) => ({ ...d, title: e.target.value }))}
          placeholder={t("notebookTitlePlaceholder")}
          aria-label={t("notebookTitlePlaceholder")}
          maxW="260px"
        />
        <Tooltip
          label={
            props.transactionActive
              ? `${t("notebookDatabaseTip")} ${t("notebookDatabaseTxTip")}`
              : t("notebookDatabaseTip")
          }
        >
          <Input
            value={doc.database ?? ""}
            onChange={(e) => updateNotebook((d) => ({ ...d, database: e.target.value.trim() || null }))}
            placeholder={t("notebookDatabasePlaceholder")}
            aria-label={t("notebookDatabasePlaceholder")}
            maxW="180px"
          />
        </Tooltip>
        {dirty && (
          <chakra.span color="app.textMuted" textStyle="caption" data-testid="notebook-dirty">
            {t("notebookUnsaved")}
          </chakra.span>
        )}
        <chakra.span flex="1" />
        {busy ? (
          <Tooltip label={props.transactionActive ? t("notebookStopInTransaction") : t("notebookStop")}>
            <Button size="sm" variant="secondary" onClick={stop}>
              <Icon name="stop" size={ICON_SIZES.sm} />
              {t("notebookStop")}
            </Button>
          </Tooltip>
        ) : (
          <Tooltip label={runDisabled ?? t("notebookRunAll")}>
            <Button
              size="sm"
              variant="primary"
              disabled={!!runDisabled || sqlCount === 0}
              onClick={() => void runCells(sqlCellsToRun(doc.cells), true)}
            >
              <Icon name="play" size={ICON_SIZES.sm} />
              {t("notebookRunAll")}
            </Button>
          </Tooltip>
        )}
        <chakra.label display="inline-flex" alignItems="center" gap="2" fontSize="sm" color="app.textMuted">
          {t("notebookRowLimit")}
          <ListboxSelect
            ariaLabel={t("notebookRowLimit")}
            css={{ minWidth: "88px" }}
            value={String(doc.snapshotRowLimit)}
            options={SNAPSHOT_ROW_LIMIT_CHOICES.map((n) => ({ value: String(n) }))}
            onChange={(v) =>
              updateNotebook((d) => ({ ...d, snapshotRowLimit: clampSnapshotRowLimit(Number(v)) }))
            }
          />
        </chakra.label>
        <Button size="sm" variant="secondary" onClick={() => void onNew()}>
          {t("notebookNew")}
        </Button>
        <Button size="sm" variant="secondary" onClick={() => void onOpen()}>
          {t("notebookOpen")}
        </Button>
        <Button size="sm" variant="secondary" onClick={() => void onSave(false)}>
          {t("notebookSave")}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void onSave(true)}>
          {t("notebookSaveAs")}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void onExport("md")}>
          <Icon name="download" size={ICON_SIZES.sm} />
          {t("notebookExportMd")}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void onExport("html")}>
          <Icon name="download" size={ICON_SIZES.sm} />
          {t("notebookExportHtml")}
        </Button>
        <Tooltip label={t("notebookClose")}>
          <Button
            minWidth="28px"
            px="2"
            py="1"
            lineHeight={1}
            onClick={props.onClose}
            aria-label={t("notebookClose")}
          >
            <Icon name="close" size={ICON_SIZES.sm} />
          </Button>
        </Tooltip>
      </chakra.header>
      <Box flex="1" minH={0} overflowY="auto" px="6" py="4">
        <Flex direction="column" maxW="960px" mx="auto" gap="3">
          {mismatch && (
            <Callout tone="info" role="status">
              {t("notebookConnectionMismatch", { name: mismatch.name })}
            </Callout>
          )}
          {runAll && busy && (
            <chakra.div color="app.textMuted" textStyle="caption" role="status">
              {t("notebookRunning")}
            </chakra.div>
          )}
          {doc.cells.length === 0 ? (
            <EmptyState
              icon="notebook"
              title={t("notebookEmpty")}
              description={t("notebookEmptyHint")}
              action={{ label: t("notebookAddSql"), onClick: () => onAddAfter(null, "sql") }}
            />
          ) : (
            <Reorder.Group
              as="div"
              axis="y"
              values={ids}
              onReorder={onReorder}
              style={{ display: "flex", flexDirection: "column", listStyle: "none", margin: 0, padding: 0 }}
            >
              <AnimatePresence initial={false}>
                {doc.cells.map((cell, i) => (
                  <CellShell
                    key={cell.id}
                    cell={cell}
                    index={i}
                    count={doc.cells.length}
                    still={still}
                    running={runningId === cell.id}
                    runDisabled={runDisabled}
                    driver={driver}
                    editing={editingIds.has(cell.id)}
                    sessionId={props.sessionId}
                    profile={props.profile}
                    databaseSchema={databaseSchema}
                    defaultDatabase={completionDb}
                    emergencyMode={props.emergencyMode}
                    onRun={onRunCell}
                    onRunFrom={onRunFrom}
                    onMove={onMove}
                    onRemove={onRemove}
                    onToggleCollapse={onToggleCollapse}
                    onSql={onSql}
                    onMarkdown={onMarkdown}
                    onEditing={onEditing}
                    onViewChange={onViewChange}
                    onChartChange={onChartChange}
                    onOpenInEditor={onOpenInEditor}
                    onAddAfter={onAddAfter}
                  />
                ))}
              </AnimatePresence>
            </Reorder.Group>
          )}
        </Flex>
      </Box>
      {dialog}
    </Flex>
  );
}

/** 書き出し用の文書。スナップショットに現在のマスク設定を掛け直したもの。 */
function parseOrSame(doc: NotebookDoc, mask: MaskConfig): NotebookDoc {
  const parsed = parseNotebook(serializeNotebook(doc, mask));
  return parsed.ok ? parsed.doc : doc;
}
