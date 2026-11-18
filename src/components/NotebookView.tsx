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
  countStaleCells,
  createEmptyNotebook,
  diffSqlLines,
  insertCellAfter,
  moveCell,
  newMarkdownCell,
  newSqlCell,
  resolveCellTarget,
  NOTEBOOK_FILE_EXTENSION,
  notebookFileName,
  parseNotebook,
  removeCell,
  reorderCellsByIds,
  serializeNotebook,
  snapshotFreshness,
  SNAPSHOT_ROW_LIMIT_CHOICES,
  sqlCellsToRun,
  updateCell,
  utf8ByteLength,
  MAX_NOTEBOOK_CELLS,
  MAX_NOTEBOOK_FILE_BYTES,
  checkNotebookLimits,
  MAX_SNAPSHOT_CELL_CHARS,
  type NotebookCell,
  type NotebookCellTarget,
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
import {
  getNotebookState,
  markNotebookSaved,
  replaceNotebook,
  updateNotebook,
  useNotebookState,
} from "../notebookStore";
import type { ChartConfig } from "./chartData";
import type { MaskConfig } from "./columnMask";
import { semanticColorToken } from "../semanticColors";
import { redactErrorText } from "../sqlCredentials";
import { Callout } from "./Callout";
import { useConfirm } from "./ConfirmDialog";
import { EmptyState } from "./EmptyState";
import { Icon, ICON_SIZES } from "./Icon";
import { ListboxSelect, type ListboxSelectOption } from "./ListboxSelect";
import { MarkdownView } from "./MarkdownView";
import { ErrorNote } from "./modalForm";
import { ProductionBadge } from "./ProfileBadge";
import { ResultViewSwitch } from "./ResultViewSwitch";
import { SqlPreview } from "./SqlPreview";
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
  /** 保存済みのプロファイル (セル単位の接続の選択肢 / 保存された接続の存在確認, #2396)。 */
  profiles: readonly ConnectionProfile[];
  /** 開いている接続 (アクティブ + 背景)。現在と違う接続のセルはここにあるものだけ実行できる。 */
  openConnections: readonly { sessionId: string; profile: ConnectionProfile }[];
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
  /** `database` はノートブックの実行先 (未指定なら null。呼び出し側が接続の既定へ寄せる)。 */
  onOpenInEditor: (sql: string, title: string, database: string | null) => void;
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
    stale: (reasons) =>
      reasons.length > 1
        ? translate("notebookExportStaleNoteBoth")
        : reasons[0] === "connection"
          ? translate("notebookExportStaleNoteConn")
          : translate("notebookExportStaleNote"),
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
  /** セルの実行先ドライバ (SQL の比較の字句規則。不明なら undefined)。 */
  driver: string | undefined;
  /** 再実行 (古い結果の目印のボタン)。実行できないときは理由 (`rerunDisabled`)。 */
  onRerun: (id: string) => void;
  rerunDisabled: string | null;
  running: boolean;
  onViewChange: (id: string, view: "table" | "chart") => void;
  onChartChange: (id: string, chart: ChartConfig) => void;
}

/** SQL / 接続を変えた後の「古い結果」の目印 (#2420)。ワンクリックの再実行と、実行時の SQL との差分表示を持つ。 */
function StaleNotice({
  cell,
  reasons,
  onRerun,
  rerunDisabled,
  running,
}: {
  cell: NotebookSqlCell;
  reasons: readonly ("sql" | "connection")[];
  onRerun: (id: string) => void;
  rerunDisabled: string | null;
  running: boolean;
}) {
  const t = useT();
  const [showDiff, setShowDiff] = useState(false);
  const executed = cell.snapshot?.sql ?? null;
  const sqlChanged = reasons.includes("sql");
  const diff = showDiff && sqlChanged && executed !== null ? diffSqlLines(executed, cell.sql) : null;
  const badgeText =
    reasons.length > 1
      ? t("notebookStaleBadgeBoth")
      : sqlChanged
        ? t("notebookStaleBadge")
        : t("notebookStaleBadgeConn");
  return (
    <Callout tone="warning" role="status" data-testid="notebook-stale">
      <Flex direction="column" gap="2">
        <Flex align="center" gap="2" flexWrap="wrap">
          <chakra.strong data-testid="notebook-stale-badge">{badgeText}</chakra.strong>
          <chakra.span>{t("notebookStaleHint")}</chakra.span>
          <Tooltip label={rerunDisabled}>
            <Button
              size="sm"
              variant="secondary"
              disabled={!!rerunDisabled || running}
              onClick={() => onRerun(cell.id)}
              data-testid="notebook-stale-rerun"
            >
              <Icon name="play" size={ICON_SIZES.sm} />
              {t("notebookStaleRerun")}
            </Button>
          </Tooltip>
          {sqlChanged && executed !== null && (
            <Button
              size="sm"
              variant="ghost"
              aria-expanded={showDiff}
              onClick={() => setShowDiff((v) => !v)}
              data-testid="notebook-stale-diff-toggle"
            >
              {showDiff ? t("notebookStaleHideDiff") : t("notebookStaleShowDiff")}
            </Button>
          )}
        </Flex>
        {showDiff && sqlChanged && executed !== null && (
          <Flex direction="column" gap="1">
            {diff === null && (
              <chakra.span color="app.textMuted" textStyle="caption">
                {t("notebookStaleDiffTooLong")}
              </chakra.span>
            )}
            <SqlPreview maxH="200px" sql={diff ?? executed} data-testid="notebook-stale-diff" />
          </Flex>
        )}
      </Flex>
    </Callout>
  );
}

function CellResult({
  cell,
  driver,
  onRerun,
  rerunDisabled,
  running,
  onViewChange,
  onChartChange,
}: CellResultProps) {
  const t = useT();
  const s = cell.snapshot;
  const freshness = snapshotFreshness(cell, driver);
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
      {s.connection &&
        ` / ${
          s.database
            ? t("notebookRanOnDb", { name: s.connection.name, database: s.database })
            : t("notebookRanOn", { name: s.connection.name })
        }`}
    </chakra.div>
  );
  const stale =
    freshness.kind === "stale" ? (
      <StaleNotice
        cell={cell}
        reasons={freshness.reasons}
        onRerun={onRerun}
        rerunDisabled={rerunDisabled}
        running={running}
      />
    ) : null;
  const dim = stale ? 0.55 : 1;
  if (s.error) {
    return (
      <Flex direction="column" gap="2">
        {stale}
        {meta}
        <ErrorNote role="alert">{t("notebookError", { error: s.error })}</ErrorNote>
      </Flex>
    );
  }
  if (!s.hasColumns) {
    return (
      <Flex direction="column" gap="2">
        {stale}
        {meta}
        <chakra.div fontSize="md" opacity={dim}>
          {t("notebookAffected", { rows: s.rowsAffected })}
        </chakra.div>
      </Flex>
    );
  }
  return (
    <Flex direction="column" gap="2">
      {stale}
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
        <Box
          h="360px"
          border="1px solid"
          borderColor="app.border"
          borderRadius="md"
          overflow="hidden"
          opacity={dim}
          data-stale={stale ? "true" : undefined}
        >
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
        <chakra.div opacity={dim} data-stale={stale ? "true" : undefined}>
          <SnapshotTable snapshot={s} />
        </chakra.div>
      )}
    </Flex>
  );
}

/** 実行開始時点に解決した、セルの実行先 (接続 + セッション)。 */
interface CellPin {
  /** 文書の既定 (= 現在の接続) で動くセルか。 */
  isDefault: boolean;
  profile: ConnectionProfile;
  sessionId: string;
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
  /** このセルが実際に実行される接続のセッション / プロファイル (セル単位の接続 #2396。未解決なら null)。 */
  sessionId: string | null;
  profile: ConnectionProfile | null;
  /** セルの実行先の状態 (`current` = 文書の既定 = 現在の接続)。 */
  targetKind: NotebookCellTarget["kind"];
  connectionOptions: readonly ListboxSelectOption[];
  /** 実行中は接続を変えさせない (確認済みの組とずれるため)。 */
  connectionLocked: boolean;
  onConnectionChange: (id: string, profileId: string) => void;
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
            {isSql && (
              <>
                <ListboxSelect
                  ariaLabel={t("notebookCellConn")}
                  disabled={p.connectionLocked}
                  css={{ minWidth: "160px", maxWidth: "240px" }}
                  value={cell.connection?.profileId ?? ""}
                  options={
                    cell.connection &&
                    !p.connectionOptions.some((o) => o.value === cell.connection?.profileId)
                      ? [
                          ...p.connectionOptions,
                          { value: cell.connection.profileId, label: cell.connection.name },
                        ]
                      : p.connectionOptions
                  }
                  onChange={(v) => p.onConnectionChange(cell.id, v)}
                />
                {p.targetKind !== "current" && p.profile?.is_production && <ProductionBadge />}
              </>
            )}
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
                <Tooltip
                  label={
                    p.targetKind !== "current"
                      ? t("notebookOpenInEditorOtherConn")
                      : t("notebookOpenInEditor")
                  }
                >
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={p.targetKind !== "current"}
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
                  {(p.targetKind === "missing" || p.targetKind === "closed") && cell.connection && (
                    <Callout tone="warning" role="status" data-testid="notebook-cell-conn-note">
                      {t(p.targetKind === "missing" ? "notebookCellConnMissing" : "notebookCellConnNotOpen", {
                        name: cell.connection.name,
                      })}
                    </Callout>
                  )}
                  <CellResult
                    cell={cell}
                    driver={p.profile?.driver}
                    onRerun={p.onRun}
                    rerunDisabled={p.runDisabled}
                    running={p.running}
                    onViewChange={p.onViewChange}
                    onChartChange={p.onChartChange}
                  />
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
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  // セル単位の接続の実行確認を済ませたプロファイル ID (文書の世代ごと)。
  const confirmedConnRef = useRef<{ epoch: number; ids: Set<string> }>({ epoch: -1, ids: new Set() });
  const docRef = useRef(doc);
  docRef.current = doc;
  const profileRef = useRef(props.profile);
  profileRef.current = props.profile;
  const profilesRef = useRef(props.profiles);
  profilesRef.current = props.profiles;
  const openConnectionsRef = useRef(props.openConnections);
  openConnectionsRef.current = props.openConnections;
  // 補完用の DB。ノートブックの実行先 (空なら接続の既定 DB)。
  const completionDb = doc.database ?? props.profile?.database ?? null;
  const databaseSchema = props.schemaForDatabase(completionDb);
  const busy = runningId !== null;

  /** セルの実行先 (セル単位の接続 #2396)。最新の props を ref から読む (実行直前の判定用)。 */
  const targetOf = useCallback(
    (cell: NotebookSqlCell): NotebookCellTarget =>
      resolveCellTarget(
        cell.connection,
        profileRef.current?.id ?? null,
        profilesRef.current,
        openConnectionsRef.current,
      ),
    [],
  );
  /** セルの実行先ドライバ (古い結果の判定で SQL の字句規則を合わせる)。解決できなければ undefined。 */
  const driverOfCell = (cell: NotebookSqlCell): string | undefined => {
    const target = targetOf(cell);
    if (target.kind === "open" || target.kind === "closed") return target.profile.driver;
    return target.kind === "current" ? (props.profile?.driver ?? undefined) : undefined;
  };
  /** セルを実行できない理由 (できるなら null)。 */
  const blockReason = (target: NotebookCellTarget): string | null => {
    if (target.kind === "current") return props.sessionId ? null : t("notebookNeedsConnection");
    if (target.kind === "missing") return t("notebookCellConnMissing", { name: target.ref.name });
    if (target.kind === "closed") return t("notebookCellConnNotOpen", { name: target.ref.name });
    return null;
  };
  const sqlCells = doc.cells.filter((c): c is NotebookSqlCell => c.kind === "sql");
  // 「すべて実行」: どのセルも実行先が無い (未接続で、開いている別接続を指すセルも無い) ときだけ無効にする。
  const runDisabled = sqlCells.some((c) => blockReason(targetOf(c)) === null)
    ? null
    : t("notebookNeedsConnection");
  const connectionOptions = useMemo<ListboxSelectOption[]>(() => {
    const opts: ListboxSelectOption[] = [{ value: "", label: t("notebookCellConnDefault") }];
    for (const p of props.profiles) opts.push({ value: p.id, label: p.name, searchText: p.name });
    return opts;
  }, [props.profiles, t]);

  const patchCell = useCallback(
    (id: string, patch: Parameters<typeof updateCell>[2]) =>
      updateNotebook((d) => ({ ...d, cells: updateCell(d.cells, id, patch) })),
    [],
  );

  /**
   * 1 セルを実行してスナップショットを書き戻す。続けてよいなら true。
   * 実行先は `pin` (実行開始時点に解決した接続 + セッション) に固定し、省略しない (実行中にアクティブ接続が
   * 切り替わっても別の接続で流さない)。
   */
  const runOne = useCallback(
    async (cell: NotebookSqlCell, pin: CellPin): Promise<boolean> => {
      setRunningId(cell.id);
      const started = Date.now();
      // 別の接続で流すセルには、文書の実行先 DB (既定の接続の DB 名) を持ち込まない。接続の既定 DB へ寄せる。
      const driverOfCell = pin.profile.driver;
      // 実行先 DB は実行開始時に 1 度だけ取り出す (実行中に DB 欄が編集されても、実行と記録は同じ値)。
      const runDatabase = pin.isDefault ? docRef.current.database : null;
      try {
        const limit = clampSnapshotRowLimit(docRef.current.snapshotRowLimit);
        const out = await props.onRunSql(cell.sql, {
          rowCap: limit,
          database: runDatabase,
          connection: { profileId: pin.profile.id, sessionId: pin.sessionId, name: pin.profile.name },
          onStart: (id) => {
            streamRef.current = id;
          },
          isCancelled: () => cancelRef.current,
        });
        if (out === null) return false;
        const source = {
          sql: cell.sql,
          connection: { profileId: pin.profile.id, name: pin.profile.name },
          database: runDatabase,
        };
        const snapshot = buildSnapshot({ ...out, error: null }, limit, maskRef.current, new Date(), source);
        patchCell(cell.id, { snapshot });
        return true;
      } catch (e) {
        if (e instanceof NotebookRunError && e.cancelled) return false;
        const raw = e instanceof Error ? e.message : String(e);
        // エラー文は SQL の断片を引用する。資格情報リテラル (`IDENTIFIED BY '…'` など) は、ファイルへ残す前に伏せる (#2174)。
        const message = redactErrorText(raw, cell.sql, driverOfCell);
        patchCell(cell.id, {
          snapshot: buildErrorSnapshot(message, Date.now() - started, new Date(), {
            sql: cell.sql,
            connection: { profileId: pin.profile.id, name: pin.profile.name },
            database: runDatabase,
          }),
        });
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
  const confirmConnection = async (profile: ConnectionProfile | null): Promise<boolean> => {
    // `profile` は既定の接続で動くセルがあるときの、実行開始時点の現在の接続 (無ければ付け替えは起きない)。
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

  /**
   * セルが現在の接続と違う接続を指しているときの確認 (#2396)。ファイルに保存された接続 ID は他人が書き換えうるので、
   * この文書を開いてから初めてその接続で実行するときは、接続名 (本番なら警告つき) を見せて承認を取る。
   * 承認は文書ごと (新規 / 読み込みで入れ替わるまで) 覚える。危険クエリ・本番 confirm_writes の確認は、
   * そのセルの接続の設定で実行時に別途かかる (`onRunSql`)。
   */
  const confirmCellConnections = async (pins: readonly CellPin[]): Promise<boolean> => {
    const epoch = getNotebookState().epoch;
    if (confirmedConnRef.current.epoch !== epoch) confirmedConnRef.current = { epoch, ids: new Set() };
    const pending = new Map<string, { name: string; production: boolean }>();
    for (const pin of pins) {
      if (pin.isDefault || confirmedConnRef.current.ids.has(pin.profile.id)) continue;
      pending.set(pin.profile.id, { name: pin.profile.name, production: pin.profile.is_production });
    }
    if (pending.size === 0) return true;
    const names = [...pending.values()]
      .map((v) => t("notebookCellConnName", { name: v.name }))
      .join(t("notebookCellConnNameSep"));
    const production = [...pending.values()].some((v) => v.production);
    const ok = await confirm({
      title: t("notebookCellConnTitle"),
      message: t(production ? "notebookCellConnMessageProd" : "notebookCellConnMessage", {
        names,
        current: profileRef.current?.name ?? "-",
      }),
      confirmLabel: t("notebookCellConnConfirm"),
      tone: production ? "danger" : undefined,
    });
    if (ok) for (const id of pending.keys()) confirmedConnRef.current.ids.add(id);
    return ok;
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: confirmConnection は profileRef / docRef から最新を読む
  const runCells = useCallback(
    async (cells: NotebookSqlCell[], all: boolean) => {
      // 未接続でも文書の編集はできるが、実行はしない (ボタンも無効)。
      if (busy || cells.length === 0) return;
      // 実行先が無いセル (現在の接続が無い / 別接続が開いていない・見つからない) があれば、1 つも流さずに止める
      // (途中までの実行で、後続が前のセルの結果を欠いたまま残るのを避ける)。
      // あわせて、実行先を「このときの接続 + セッション」に固定する (確認も実行もこの組で行う)。
      const pins = new Map<string, CellPin>();
      for (const c of cells) {
        const target = targetOf(c);
        const reason = blockReason(target);
        if (reason) {
          toast.error(reason);
          return;
        }
        if (target.kind === "open") {
          pins.set(c.id, { isDefault: false, profile: target.profile, sessionId: target.sessionId });
        } else if (target.kind === "current") {
          const profile = profileRef.current;
          if (!profile || !props.sessionId) {
            toast.error(t("notebookNeedsConnection"));
            return;
          }
          pins.set(c.id, { isDefault: true, profile, sessionId: props.sessionId });
        }
      }
      const pinList = [...pins.values()];
      if (!(await confirmConnection(pinList.find((p) => p.isDefault)?.profile ?? null))) return;
      if (!(await confirmCellConnections(pinList))) return;
      cancelRef.current = false;
      setRunAll(all);
      for (const c of cells) {
        if (cancelRef.current) break;
        // 実行直前の最新の SQL を使う (編集直後の実行でも取りこぼさない)。
        const latest = docRef.current.cells.find((x) => x.id === c.id);
        const pin = pins.get(c.id);
        if (!latest || latest.kind !== "sql" || !pin) continue;
        // 確認した後にセルの接続が変えられていたら、確認なしでは流さず止める。
        if ((latest.connection?.profileId ?? null) !== (c.connection?.profileId ?? null)) {
          toast.error(t("notebookCellConnChanged"));
          break;
        }
        // 失敗・取りやめ・中止のセルで止める (後続は前のセルの結果を前提にしがち)。
        if (!(await runOne(latest, pin))) break;
      }
      setRunAll(false);
    },
    [busy, runOne, props.sessionId, toast],
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
  const onConnectionChange = useCallback(
    (id: string, profileId: string) => {
      if (!profileId) {
        patchCell(id, { connection: null });
        return;
      }
      const p = profilesRef.current.find((x) => x.id === profileId);
      const prev = docRef.current.cells.find((x) => x.id === id);
      const name =
        p?.name ??
        (prev?.kind === "sql" && prev.connection?.profileId === profileId ? prev.connection.name : profileId);
      patchCell(id, { connection: { profileId, name } });
    },
    [patchCell],
  );
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
      // クエリタブはアクティブな接続でしか作れない。別の接続を指すセルは黙って別の接続へ移さず、開かない (ボタンも無効)。
      if (c?.kind === "sql" && targetOf(c).kind === "current") {
        props.onOpenInEditor(
          c.sql,
          docRef.current.title || translate("notebookTitle"),
          docRef.current.database,
        );
      }
    },
    [props.onOpenInEditor, targetOf],
  );
  const onAddAfter = useCallback(
    (afterId: string | null, kind: "markdown" | "sql") => {
      if (docRef.current.cells.length >= MAX_NOTEBOOK_CELLS) {
        toast.error(t("notebookTooManyCells", { limit: MAX_NOTEBOOK_CELLS.toLocaleString() }));
        return;
      }
      const cell = kind === "sql" ? newSqlCell() : newMarkdownCell();
      updateNotebook((d) => ({ ...d, cells: insertCellAfter(d.cells, afterId, cell) }));
      if (kind === "markdown") setEditingIds((prev) => new Set(prev).add(cell.id));
    },
    [t, toast],
  );
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
    if (savingRef.current || !(await guardDiscard())) return;
    replaceNotebook(
      createEmptyNotebook(props.profile ? { profileId: props.profile.id, name: props.profile.name } : null),
      null,
    );
    setEditingIds(new Set());
  };

  const onOpen = async () => {
    if (savingRef.current || !(await guardDiscard())) return;
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
    // 保存開始時点の文書・世代を固定する (書き込み中に実行完了などで文書が変わりうる)。
    const started = getNotebookState();
    const withConn = { ...started.doc, connection: started.doc.connection ?? connectionRef() };
    const violation = checkNotebookLimits(withConn);
    if (violation) {
      toast.error(
        t(violation.kind === "cells" ? "notebookTooManyCells" : "notebookCellTooLong", {
          limit: violation.limit.toLocaleString(),
        }),
      );
      return;
    }
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
    markNotebookSaved(path, { epoch: started.epoch, revision: started.revision });
    toast.success(t("notebookSaved", { path }));
  };

  const onSave = async (forceDialog: boolean) => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
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
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const onExport = async (kind: "md" | "html") => {
    try {
      const d: NotebookDoc = { ...docRef.current, connection: connectionRef() };
      // 書き出しもファイル保存と同じく、取得後に変えたマスク設定を反映する。
      const forExport: NotebookDoc = parseOrSame(d, maskRef.current);
      // 古い結果 (SQL を変えた後に再実行していないセル) があれば、書き出す前に確認する。書き出し本文にも注記する。
      const staleCount = countStaleCells(forExport.cells, driverOfCell);
      if (
        staleCount > 0 &&
        !(await confirm({
          title: t("notebookExportStaleTitle"),
          message: t("notebookExportStaleMessage", { count: staleCount }),
          confirmLabel: t("notebookExportStaleConfirm"),
        }))
      ) {
        return;
      }
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
          ? notebookToMarkdown(forExport, exportText(), new Date(), driverOfCell)
          : notebookToHtml(forExport, exportText(), getLocale(), new Date(), driverOfCell);
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
  const staleCount = countStaleCells(doc.cells, driverOfCell);
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
        {staleCount > 0 && (
          <Tooltip label={t("notebookStaleCountTip")}>
            <chakra.span color="app.textWarning" textStyle="caption" data-testid="notebook-stale-count">
              {t("notebookStaleCount", { count: staleCount })}
            </chakra.span>
          </Tooltip>
        )}
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
        <Button size="sm" variant="secondary" disabled={saving} onClick={() => void onNew()}>
          {t("notebookNew")}
        </Button>
        <Button size="sm" variant="secondary" disabled={saving} onClick={() => void onOpen()}>
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
                {doc.cells.map((cell, i) => {
                  const target = cell.kind === "sql" ? targetOf(cell) : ({ kind: "current" } as const);
                  const own = target.kind === "open";
                  const cellProfile =
                    target.kind === "open" || target.kind === "closed"
                      ? target.profile
                      : target.kind === "current"
                        ? props.profile
                        : null;
                  return (
                    <CellShell
                      key={cell.id}
                      cell={cell}
                      index={i}
                      count={doc.cells.length}
                      still={still}
                      running={runningId === cell.id}
                      runDisabled={cell.kind === "sql" ? blockReason(target) : null}
                      driver={cellProfile?.driver}
                      editing={editingIds.has(cell.id)}
                      sessionId={own ? target.sessionId : target.kind === "current" ? props.sessionId : null}
                      profile={cellProfile}
                      targetKind={target.kind}
                      connectionOptions={connectionOptions}
                      connectionLocked={busy}
                      onConnectionChange={onConnectionChange}
                      databaseSchema={target.kind === "current" ? databaseSchema : null}
                      defaultDatabase={
                        target.kind === "current" ? completionDb : (cellProfile?.database ?? null)
                      }
                      emergencyMode={own ? false : props.emergencyMode}
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
                  );
                })}
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
