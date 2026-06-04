import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence } from "motion/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Box, chakra, type SystemStyleObject } from "@chakra-ui/react";
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type ColumnFiltersState,
  type ColumnSizingState,
  type FilterFn,
  type OnChangeFn,
  type PaginationState,
  type SortingFn,
  type SortingState,
  type Row,
} from "@tanstack/react-table";
import { CellValue, Column, QueryResult, TableColumnInfo } from "../api/tauri";
import { useLocale, useT, type I18nKey } from "../i18n";
import { enumBadgeHue, formatDateTimeDisplay, formatJsonCompact } from "./cellFormat";
import {
  AUTO_REFRESH_INTERVAL_OPTIONS,
  RESULT_GRID_PAGE_SIZE_OPTIONS,
  useSettings,
  type Density,
} from "../settings";
import { CellValueViewer } from "./CellValueViewer";
import { copyToClipboard } from "./clipboard";
import { useConfirm } from "./ConfirmDialog";
import { ContextMenu } from "./ContextMenu";
import { EmptyState } from "./EmptyState";
import { Icon } from "./Icon";
import { ExportModal } from "./ExportModal";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { Spinner } from "./Spinner";
import { Button } from "./ui";
import {
  buildRowSql,
  countEditedCells,
  countEditedRows,
  isEditableColumnType,
  literalFromCellValue,
  resolvePkIndices,
  rowEditKey,
  validateCellInput,
  type PendingEdits,
  type RowSqlKind,
} from "./cellEdit";
import { quoteIdentFor } from "./sqlDialect";

/**
 * 結果テーブル (TanStack グリッド) のセル/ヘッダ単位のスタイル。`App.css` の
 * `:where(.results, .preview-pane-body) …` ルール群をコンポーネント側へ移設したもの。
 * `ResultGrid` のスクロール枠と `PreviewGrid` の各ペイン本体に `css` で適用する
 * (両者が `DataGrid` を共有するため定義を 1 箇所に集約する)。
 *
 * 性能上、セル/行は素の `th` / `td` / `span` のまま (重い Chakra コンポーネントを
 * セル単位で使わない) で、ここで子孫セレクタとして一括スタイルする。色はテーマの
 * CSS 変数を直接参照する (`--cell-*` などのトークン定義は `App.css` に残す方針)。
 *
 * **方針 (className 撤去の意図的な例外)**: 他コンポーネント (ExplainViewer /
 * QueryBuilder / SchemaCompareView) は className + 子孫セレクタを撤去し各要素へ
 * 直接 `css` を適用したが、結果グリッドは TanStack Table が生成する大量のセルを
 * 扱うため、セル単位の style props 化はレンダリングコストが高い。ここは単一の
 * `css` オブジェクト + 子孫セレクタを **意図的に維持** する (className 文字列の
 * 同期が不要なよう、対象は素のタグセレクタに限定している)。
 */
/** Per-density seed height (px) for the virtualizer's first paint (#410). The
 *  real height is measured afterwards; these only need to be close. Values track
 *  the `--density-row-h` tokens in App.css. */
const DENSITY_ROW_ESTIMATE: Record<Density, number> = {
  compact: 24,
  normal: 30,
  spacious: 40,
};

export const GRID_CSS: SystemStyleObject = {
  "& table": {
    borderCollapse: "separate",
    borderSpacing: 0,
    fontSize: "var(--text-sm)",
    fontFamily: "var(--font-mono)",
    color: "var(--text)",
    tableLayout: "fixed",
    minWidth: "100%",
  },
  "& th, & td": {
    borderRight: "1px solid var(--border)",
    borderBottom: "1px solid var(--border)",
    // セル余白は密度トークン (--density-cell-*) に従う。これ自体が --font-scale を
    // 内包するため、フォント拡大時に窮屈にならず (#327)、かつ表示密度の切り替え
    // (Compact / Normal / Spacious) で行高さ・余白を統合的に調整できる (#410)。
    padding: "var(--density-cell-py) var(--density-cell-px)",
    textAlign: "left",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    verticalAlign: "middle",
    position: "relative",
  },
  "& th": {
    background: "var(--bg-header)",
    position: "sticky",
    top: 0,
    zIndex: 2,
    fontWeight: 600,
    borderBottom: "1px solid var(--border-strong)",
  },
  "& th.align-right, & td.align-right": { textAlign: "right" },
  "& th .th-content": {
    display: "inline-flex",
    flexDirection: "column",
    lineHeight: 1.2,
    gap: "1px",
  },
  "& th .th-name": {
    fontWeight: 600,
    color: "var(--text)",
    letterSpacing: "0.01em",
  },
  "& th .th-type": {
    fontSize: "var(--text-2xs)",
    fontWeight: 400,
    fontFamily: "var(--font-mono)",
    color: "var(--text-muted)",
    textTransform: "lowercase",
    letterSpacing: "0.01em",
    opacity: 0.85,
  },
  "& th .th-fk-badge": {
    display: "inline-block",
    padding: "0 4px",
    fontSize: "var(--text-2xs)",
    fontWeight: 700,
    fontFamily: "var(--font-sans, sans-serif)",
    lineHeight: 1.4,
    letterSpacing: "0.04em",
    color: "var(--accent)",
    background: "color-mix(in srgb, var(--accent) 12%, transparent)",
    border: "1px solid color-mix(in srgb, var(--accent) 30%, transparent)",
    borderRadius: "var(--radius-sm)",
    alignSelf: "flex-start",
    textTransform: "uppercase",
  },
  // Zebra striping keys off an explicit class (`grid-row-stripe`, applied to
  // every odd visible row) rather than `:nth-of-type(even)`, because the
  // virtualized body inserts spacer `<tr>` that would otherwise flip the parity
  // as the user scrolls. The class is applied by visible position so the
  // pattern stays stable regardless of which rows are mounted.
  "& tbody tr.grid-row-stripe td": { background: "var(--bg-stripe)" },
  "& tbody tr:hover td": { background: "var(--bg-row-hover)" },
  "& td.row-index, & th.row-index": {
    position: "sticky",
    left: 0,
    textAlign: "right",
    color: "var(--text-muted)",
    background: "var(--bg-header)",
    fontSize: "var(--text-xs)",
    minWidth: "36px",
    zIndex: 1,
    borderRight: "1px solid var(--border-strong)",
  },
  "& thead th.row-index": { top: 0, zIndex: 3 },
  "& tbody tr.grid-row-stripe td.row-index": { background: "var(--bg-stripe)" },
  "& tbody tr:hover td.row-index": { background: "var(--bg-row-hover)" },
  // 編集保留中の行は、行番号セルの左端にアクセントバーを出して「この行に未適用の
  // 編集がある」ことを行レベルで示す (#387)。個々のセルの is-pending-edit ハイライト
  // (列方向) と合わせ、行・セルの両軸で保留編集を把握できるようにする。
  "& tbody tr.grid-row-pending td.row-index": {
    boxShadow: "inset 3px 0 0 var(--preview-highlight)",
    color: "var(--preview-highlight)",
    fontWeight: 600,
  },
  "& th.col-filler, & td.col-filler": {
    padding: 0,
    borderRight: "none",
    background: "var(--bg-elevated)",
  },
  "& tbody tr.grid-row-stripe td.col-filler": { background: "var(--bg-elevated)" },
  "& tbody tr:hover td.col-filler": { background: "var(--bg-elevated)" },
  // NULL を空文字列と取り違えないよう、淡いピル型バッジで明示する (#385)。空文字列は
  // セルが本当に空のまま描画されるので、バッジの有無で両者を一目で区別できる。色は
  // --text-null トークン参照なのでライト/ダーク両テーマで一貫する。
  "& .cell-null": {
    display: "inline-block",
    padding: "0 5px",
    fontSize: "var(--text-2xs)",
    fontWeight: 600,
    fontStyle: "normal",
    lineHeight: 1.5,
    letterSpacing: "0.04em",
    color: "var(--text-null)",
    background: "color-mix(in srgb, var(--text-null) 14%, transparent)",
    border: "1px solid color-mix(in srgb, var(--text-null) 38%, transparent)",
    borderRadius: "var(--radius-sm)",
  },
  "& td.is-null": { backgroundImage: "linear-gradient(transparent, transparent)" },
  "& .cell-number, & .cell-decimal": {
    color: "var(--cell-number)",
    fontVariantNumeric: "tabular-nums",
  },
  "& .cell-bool": { fontWeight: 600 },
  "& .cell-bool.is-true": { color: "var(--cell-bool-true)" },
  "& .cell-bool.is-false": { color: "var(--cell-bool-false)" },
  // リッチ表示時の真偽値はピル型バッジで on/off を一目で示す (#451)。色は既存の
  // --cell-bool-* トークン参照なのでライト/ダーク両テーマで一貫する。
  "& .cell-bool.cell-bool-badge": {
    display: "inline-block",
    padding: "0 6px",
    fontSize: "var(--text-2xs)",
    lineHeight: 1.5,
    letterSpacing: "0.04em",
    textTransform: "uppercase",
    borderRadius: "var(--radius-sm)",
  },
  "& .cell-bool-badge.is-true": {
    background: "color-mix(in srgb, var(--cell-bool-true) 14%, transparent)",
    border: "1px solid color-mix(in srgb, var(--cell-bool-true) 38%, transparent)",
  },
  "& .cell-bool-badge.is-false": {
    background: "color-mix(in srgb, var(--cell-bool-false) 14%, transparent)",
    border: "1px solid color-mix(in srgb, var(--cell-bool-false) 38%, transparent)",
  },
  "& .cell-date": { color: "var(--cell-date)" },
  "& .cell-json": { color: "var(--cell-json)" },
  // 列挙値 (ENUM/SET) の色分けバッジ (#451)。色相はセルごとに --enum-hue で渡され、
  // 彩度/明度はテーマトークン (--cell-enum-s / -l) で吸収する。
  "& .cell-enum-badge": {
    display: "inline-block",
    maxWidth: "100%",
    padding: "0 6px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    verticalAlign: "bottom",
    fontSize: "var(--text-2xs)",
    fontWeight: 600,
    lineHeight: 1.6,
    letterSpacing: "0.02em",
    borderRadius: "var(--radius-sm)",
    color: "hsl(var(--enum-hue, 0) var(--cell-enum-s) var(--cell-enum-l))",
    background: "hsl(var(--enum-hue, 0) var(--cell-enum-s) var(--cell-enum-l) / 0.12)",
    border: "1px solid hsl(var(--enum-hue, 0) var(--cell-enum-s) var(--cell-enum-l) / 0.35)",
  },
  "& .cell-binary": { color: "var(--cell-binary)", fontStyle: "italic" },
  // BLOB セルの先頭に付ける「BLOB · <サイズ>」ラベル。16 進プレビューだけだと
  // バイナリだと気付きにくいので、ピル型タグで明示する (#385)。
  "& .cell-binary-tag": {
    display: "inline-block",
    marginRight: "6px",
    padding: "0 5px",
    fontSize: "var(--text-2xs)",
    fontWeight: 600,
    fontStyle: "normal",
    letterSpacing: "0.04em",
    color: "var(--cell-binary)",
    background: "color-mix(in srgb, var(--cell-binary) 14%, transparent)",
    border: "1px solid color-mix(in srgb, var(--cell-binary) 38%, transparent)",
    borderRadius: "var(--radius-sm)",
  },
  "& .cell-string": { color: "var(--text)" },
  // 列ヘッダのソート/フィルタ
  "& th.is-sortable": { padding: 0 },
  // ヘッダ内はソートボタン (伸長) とフィルタアイコン (固定) の横並び。
  "& th .th-inner": {
    display: "flex",
    alignItems: "stretch",
    width: "100%",
    minWidth: 0,
  },
  "& th.is-sortable .th-sort-button": {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    flex: "1 1 auto",
    minWidth: 0,
    // ソート可能ヘッダのボタン余白もセルと同じ密度トークンに揃える (#327 / #410)。
    padding: "var(--density-cell-py) var(--density-cell-px)",
    background: "transparent",
    border: "none",
    borderRadius: 0,
    color: "inherit",
    font: "inherit",
    cursor: "pointer",
    textAlign: "inherit",
    userSelect: "none",
    transition:
      "background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease), box-shadow var(--dur-fast) var(--ease)",
  },
  "& th.is-sortable .th-sort-button:hover": { background: "var(--bg-hover)" },
  "& th.is-sorted-asc .th-sort-button, & th.is-sorted-desc .th-sort-button": {
    background: "var(--bg-active)",
  },
  "& th .th-sort-indicator": {
    fontSize: "var(--text-2xs)",
    color: "var(--accent)",
    width: "10px",
    flexShrink: 0,
    lineHeight: 1,
  },
  "& th.is-sortable:not(.is-sorted-asc):not(.is-sorted-desc) .th-sort-indicator::before": {
    content: '"↕"',
    color: "var(--text-muted)",
    opacity: 0.4,
  },
  "& th.is-sortable:not(.is-sorted-asc):not(.is-sorted-desc):hover .th-sort-indicator::before": {
    opacity: 0.85,
  },
  // 列ヘッダのフィルタアイコン。クリックで条件ポップアップ (ColumnFilterMenu) を開く。
  "& th .th-filter-button": {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    padding: "0 7px",
    marginRight: "4px",
    background: "transparent",
    border: "none",
    borderLeft: "1px solid var(--border)",
    color: "var(--text-muted)",
    cursor: "pointer",
    transition:
      "color var(--dur-fast) var(--ease), background var(--dur-fast) var(--ease)",
  },
  "& th .th-filter-button:hover": { background: "var(--bg-hover)", color: "var(--text)" },
  // フィルタが設定されている列はアイコンとヘッダ全体をアクセント色で強調する。
  "& th .th-filter-button.is-active": { color: "var(--accent)" },
  "& th.is-filtered-col": {
    background: "color-mix(in srgb, var(--accent) 14%, var(--bg-header))",
  },
  "& th.is-filtered-col .th-name": { color: "var(--accent)" },
  "& td.grid-empty-cell": {
    padding: "14px",
    color: "var(--text-muted)",
    fontStyle: "italic",
    textAlign: "center",
    whiteSpace: "normal",
  },
  "& tbody tr.grid-skeleton-row": { pointerEvents: "none" },
  "& td.grid-skeleton-cell > div": {
    height: "10px",
    borderRadius: "2px",
    background: "linear-gradient(90deg, var(--bg-muted) 25%, var(--bg-elevated) 50%, var(--bg-muted) 75%)",
    backgroundSize: "200% 100%",
    animation: "skeleton-shimmer 1.4s ease-in-out infinite",
  },
  "& .grid-filter-summary": {
    position: "sticky",
    top: 0,
    zIndex: 4,
    display: "flex",
    alignItems: "center",
    gap: "10px",
    padding: "4px 10px",
    fontSize: "var(--text-xs)",
    color: "var(--text-secondary)",
    background: "color-mix(in srgb, var(--accent) 10%, var(--bg-muted))",
    borderBottom: "1px solid var(--border)",
  },
  "& .grid-filter-clear": {
    padding: "2px 8px",
    fontSize: "var(--text-xs)",
    border: "1px solid var(--border-strong)",
    background: "var(--bg-elevated)",
    color: "var(--text)",
    borderRadius: "var(--radius-sm)",
    cursor: "pointer",
    transition:
      "background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease), box-shadow var(--dur-fast) var(--ease)",
  },
  "& .grid-filter-clear:hover": { background: "var(--bg-hover)" },
  // 列リサイズハンドル
  "& thead th .th-resize-handle": {
    position: "absolute",
    top: 0,
    right: 0,
    height: "100%",
    width: "6px",
    cursor: "col-resize",
    userSelect: "none",
    touchAction: "none",
    background: "transparent",
    zIndex: 3,
  },
  "& thead th .th-resize-handle:hover, & thead th .th-resize-handle.is-resizing": {
    background: "var(--accent)",
    opacity: 0.65,
  },
  "& thead th.is-resizing": { userSelect: "none" },
  // プレビュー差分ハイライト (PreviewGrid のみ出現)
  "& td.is-changed": {
    background: "color-mix(in srgb, var(--preview-highlight) 18%, transparent)",
    boxShadow: "inset 2px 0 0 var(--preview-highlight)",
  },
  "& tbody tr.grid-row-stripe td.is-changed": {
    background: "color-mix(in srgb, var(--preview-highlight) 22%, transparent)",
  },
  "& tbody tr:hover td.is-changed": {
    background: "color-mix(in srgb, var(--preview-highlight) 28%, transparent)",
  },
  "& th.is-changed-col": {
    background: "color-mix(in srgb, var(--preview-highlight) 22%, var(--bg-header))",
    boxShadow: "inset 0 -2px 0 var(--preview-highlight)",
  },
  "& th.is-changed-col .th-name": { color: "var(--preview-highlight)" },
  // インラインセル編集 (ResultGrid のみ出現)
  "& td.is-pending-edit": {
    background: "color-mix(in srgb, var(--preview-highlight) 14%, transparent)",
    boxShadow: "inset 2px 0 0 var(--preview-highlight)",
  },
  "& tbody tr.grid-row-stripe td.is-pending-edit": {
    background: "color-mix(in srgb, var(--preview-highlight) 18%, transparent)",
  },
  "& tbody tr:hover td.is-pending-edit": {
    background: "color-mix(in srgb, var(--preview-highlight) 24%, transparent)",
  },
  "& .cell-pending-value": { color: "var(--preview-highlight)", fontWeight: 500 },
  // セルの編集可否と選択状態の視覚フィードバック (#349)。
  // 既定のデータセルは「編集できない」ことが伝わるよう矢印カーソルにし (読み取り
  // 専用セッションや PK/BLOB 列・非テーブル結果では is-editable-cell が付かないため
  // 自動的にこの見た目になる)、編集可能セルだけテキストカーソル + ホバー時の
  // アクセントリングで「ダブルクリックで編集できる」affordance を与える。
  // outline を使うのは、is-pending-edit / is-changed / is-invalid-edit が使う左端の
  // box-shadow バーと競合させずに重ねるため (両者は別プロパティ)。色は --accent
  // トークン参照なのでライト/ダーク両テーマで一貫する。
  "& tbody td:not(.row-index):not(.col-filler):not(.grid-empty-cell)": {
    cursor: "default",
  },
  "& td.is-editable-cell": { cursor: "text" },
  "& tbody tr td.is-editable-cell:hover": {
    outline: "1px solid color-mix(in srgb, var(--accent) 45%, transparent)",
    outlineOffset: "-1px",
  },
  // 編集中 (アクティブ) のセルははっきりしたアクセントのアウトラインで強調し、
  // どのセルを編集しているかを把握しやすくする。
  "& td.is-editable-cell:focus-within": {
    outline: "2px solid var(--accent)",
    outlineOffset: "-2px",
  },
  // キーボードナビゲーションで選択中のセル (編集モードでない場合のみ表示)
  "& td.is-active-cell:not(:focus-within)": {
    outline: "2px solid var(--accent)",
    outlineOffset: "-2px",
  },
  "& td.is-invalid-edit": { boxShadow: "inset 2px 0 0 var(--status-error)" },
  "& td.is-invalid-edit.is-pending-edit": {
    background: "color-mix(in srgb, var(--status-error) 12%, transparent)",
  },
  "& .cell-edit-wrap": { position: "relative" },
  "& .cell-edit-input": {
    width: "100%",
    boxSizing: "border-box",
    margin: "-3px -6px",
    padding: "3px 6px",
    fontFamily: "inherit",
    fontSize: "inherit",
    color: "var(--text)",
    background: "var(--bg-input)",
    border: "1px solid var(--accent)",
    borderRadius: "var(--radius-sm)",
    outline: "none",
    boxShadow: "0 0 0 2px color-mix(in srgb, var(--accent) 30%, transparent)",
  },
  "& .cell-edit-input.is-invalid": {
    borderColor: "var(--status-error)",
    boxShadow: "0 0 0 2px color-mix(in srgb, var(--status-error) 30%, transparent)",
  },
  "& .cell-edit-error": {
    position: "absolute",
    top: "calc(100% + 2px)",
    left: "-6px",
    zIndex: 5,
    maxWidth: "280px",
    padding: "3px 7px",
    fontSize: "var(--text-xs)",
    fontWeight: 500,
    color: "#fff",
    background: "var(--status-error)",
    borderRadius: "var(--radius-sm)",
    boxShadow: "var(--shadow-md, 0 2px 6px rgb(0 0 0 / 0.3))",
    whiteSpace: "normal",
    pointerEvents: "none",
  },
};

interface Props {
  result: QueryResult | null;
  /** True while batches are still arriving from a streaming query. */
  streaming?: boolean;
  /** Cancel the in-flight stream for the active tab (keeps rows received so far). */
  onStopStreaming?: () => void;
  /** True while a scroll-triggered "load more" page is in flight. */
  loadingMore?: boolean;
  /** When true, scrolling near the bottom fetches another page. */
  canLoadMore?: boolean;
  /** Called when the viewport approaches the bottom of the results. */
  onLoadMore?: () => void;
  /**
   * Row cap auto-injected into the query, or null when none was applied. The
   * "auto LIMIT" badge shows only when the cap was actually binding (the result
   * filled it), so small results and aggregates stay quiet.
   */
  autoLimitApplied?: number | null;
  /** Called from the badge to re-run the query without the auto LIMIT. */
  onFetchAllRows?: () => void;
  /** Active connection's driver ("mysql" | "postgres" | "sqlite"), for row→SQL generation. */
  driver?: string;
  /** Schema (database) name of the active tab, used for the export default filename. */
  database?: string | null;
  /** Table name of the active tab, used for the export default filename. */
  table?: string | null;
  /**
   * When true (and the underlying table has a primary key) cells become
   * double-clickable for inline edit. Currently set by App for tabs whose
   * `kind === "table"`.
   */
  editable?: boolean;
  /** Column metadata from `describeTable` — used to detect PK + types. */
  tableColumns?: TableColumnInfo[] | null;
  /** Edits awaiting Preview/Apply. Keyed by [rowEditKey][colIdx]. */
  pendingEdits?: PendingEdits;
  /**
   * Called when a cell's pending value is set (or cleared via `null`). The row
   * is identified by its PK-derived `rowEditKey`, not its array index.
   */
  onSetCellEdit?: (rowKey: string, colIdx: number, value: string | null) => void;
  /** Whether there is at least one undo snapshot available. */
  canUndo?: boolean;
  /** Whether there is at least one redo snapshot available. */
  canRedo?: boolean;
  /** Discard all pending edits for the active tab. */
  onClearEdits?: () => void;
  /** Undo the last pending-edit change (Ctrl+Z). */
  onUndoEdit?: () => void;
  /** Redo the previously undone edit (Ctrl+Shift+Z). */
  onRedoEdit?: () => void;
  /** Build & preview the UPDATE for the pending edits (single-row only). */
  onPreviewEdits?: () => void;
  /** Build & execute the UPDATE(s) for the pending edits, then refresh. */
  onApplyEdits?: () => void;
  /** Current auto-refresh cadence (seconds), or null when polling is off. */
  autoRefreshSecs?: number | null;
  /**
   * Whether auto-refresh may be enabled: the result came from a read-only query
   * that has been executed at least once. When false the control is disabled.
   */
  autoRefreshAllowed?: boolean;
  /** Wall-clock ms of the last completed auto-refresh tick, for the badge. */
  autoRefreshLastRunAt?: number | null;
  /** Enable polling at `secs`, or disable it when `null`. */
  onSetAutoRefresh?: (secs: number | null) => void;
  /** Non-null when the last query failed (before a new run). Shows an error EmptyState in the grid body. */
  queryError?: string | null;
  /** Called when the user clicks "Retry" in the error EmptyState. */
  onRetry?: () => void;
  /**
   * When provided, a "Jump to …" item appears in the right-click menu for
   * cells belonging to a foreign-key column (from `tableColumns`). The
   * callback receives the generated `SELECT … WHERE …` SQL.
   */
  onFkJump?: (sql: string) => void;
}

export interface ResultGridHandle {
  /** Move focus to the cross-column search box (Cmd/Ctrl+F entry point). */
  focusSearch: () => void;
}

/** Pixels-from-bottom that count as "near the end" for triggering a load. */
const LOAD_MORE_THRESHOLD_PX = 240;

interface RowShape {
  [key: string]: CellValue;
}

type CellKind =
  | "number"
  | "decimal"
  | "bool"
  | "date"
  | "time"
  | "json"
  | "enum"
  | "binary"
  | "string";

const NUMERIC_TYPES = new Set([
  "TINYINT",
  "SMALLINT",
  "MEDIUMINT",
  "INT",
  "INTEGER",
  "BIGINT",
  "YEAR",
  "FLOAT",
  "DOUBLE",
  "REAL",
  "TINYINT UNSIGNED",
  "SMALLINT UNSIGNED",
  "MEDIUMINT UNSIGNED",
  "INT UNSIGNED",
  "BIGINT UNSIGNED",
]);

const DECIMAL_TYPES = new Set(["DECIMAL", "NEWDECIMAL", "NUMERIC"]);
const DATE_TYPES = new Set(["DATE", "DATETIME", "TIMESTAMP"]);
const TIME_TYPES = new Set(["TIME"]);
const BINARY_TYPES = new Set([
  "BLOB",
  "TINYBLOB",
  "MEDIUMBLOB",
  "LONGBLOB",
  "BINARY",
  "VARBINARY",
]);

function classifyColumn(col: Column): CellKind {
  const t = col.type_name.toUpperCase();
  if (NUMERIC_TYPES.has(t)) return "number";
  if (DECIMAL_TYPES.has(t)) return "decimal";
  if (t === "BOOLEAN" || t === "BOOL") return "bool";
  if (DATE_TYPES.has(t)) return "date";
  if (TIME_TYPES.has(t)) return "time";
  if (t === "JSON" || t === "JSONB") return "json";
  if (t === "ENUM" || t === "SET") return "enum";
  if (BINARY_TYPES.has(t)) return "binary";
  return "string";
}

function classifyByValue(v: CellValue): CellKind | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return "number";
  if (typeof v === "boolean") return "bool";
  return null;
}

function formatNumber(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  if (Number.isInteger(v)) return v.toLocaleString();
  return v.toString();
}

/**
 * BLOB の概算サイズを人間可読な単位 (B / KB / MB) に整形する。`Value::Bytes` は
 * 16 進文字列としてワイヤに乗る (CLAUDE.md 参照) ため、バイト長は文字数の半分。
 */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

// Sort: nulls are pushed after non-null values for asc; flipped to top by desc inversion.
function cmpNullable<T>(a: T | null, b: T | null, cmp: (a: T, b: T) => number): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return cmp(a, b);
}

const sortNumeric: SortingFn<RowShape> = (rowA, rowB, columnId) => {
  const av = rowA.getValue(columnId) as CellValue;
  const bv = rowB.getValue(columnId) as CellValue;
  const an = av === null || av === undefined ? null : Number(av);
  const bn = bv === null || bv === undefined ? null : Number(bv);
  return cmpNullable(an, bn, (x, y) => {
    if (Number.isNaN(x) && Number.isNaN(y)) return 0;
    if (Number.isNaN(x)) return 1;
    if (Number.isNaN(y)) return -1;
    return x === y ? 0 : x < y ? -1 : 1;
  });
};

const sortBool: SortingFn<RowShape> = (rowA, rowB, columnId) => {
  const av = rowA.getValue(columnId) as CellValue;
  const bv = rowB.getValue(columnId) as CellValue;
  const toBool = (v: CellValue): boolean | null => {
    if (v === null || v === undefined) return null;
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0;
    const s = String(v).toLowerCase();
    if (s === "true" || s === "1") return true;
    if (s === "false" || s === "0") return false;
    return null;
  };
  return cmpNullable(toBool(av), toBool(bv), (x, y) => (x === y ? 0 : x ? 1 : -1));
};

const sortString: SortingFn<RowShape> = (rowA, rowB, columnId) => {
  const av = rowA.getValue(columnId) as CellValue;
  const bv = rowB.getValue(columnId) as CellValue;
  const as = av === null || av === undefined ? null : String(av);
  const bs = bv === null || bv === undefined ? null : String(bv);
  return cmpNullable(as, bs, (x, y) => x.localeCompare(y, undefined, { numeric: true }));
};

function sortingFnForKind(kind: CellKind): SortingFn<RowShape> {
  switch (kind) {
    case "number":
    case "decimal":
      return sortNumeric;
    case "bool":
      return sortBool;
    case "date":
    case "time":
    case "json":
    case "enum":
    case "binary":
    case "string":
      return sortString;
  }
}

function defaultColumnSize(kind: CellKind): number {
  switch (kind) {
    case "bool":
      return 90;
    case "number":
    case "decimal":
      return 120;
    case "date":
    case "time":
      return 170;
    case "binary":
      return 220;
    case "enum":
      return 130;
    case "json":
    case "string":
      return 180;
  }
}

const ROW_INDEX_WIDTH = 44;

/** Render a cell value as plain text for clipboard copy. NULL → empty string. */
function cellToText(v: CellValue): string {
  if (v === null || v === undefined) return "";
  return String(v);
}

const COL_SIZING_LRU_KEY = "noobdb.colsizing.lru.v1";
const COL_SIZING_MAX_ENTRIES = 50;

function readLruOrder(): string[] {
  try {
    const raw = localStorage.getItem(COL_SIZING_LRU_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed as string[];
    }
  } catch {
    // ignore
  }
  return [];
}

function writeLruOrder(order: string[]): void {
  try {
    localStorage.setItem(COL_SIZING_LRU_KEY, JSON.stringify(order));
  } catch {
    // ignore
  }
}

export function readStoredColumnSizing(storageKey: string | undefined): ColumnSizingState {
  if (!storageKey) return {};
  try {
    const stored = localStorage.getItem(storageKey);
    if (stored !== null) {
      const parsed = JSON.parse(stored);
      if (parsed && typeof parsed === "object") return parsed as ColumnSizingState;
    }
  } catch {
    // ignore (corrupt entry, private mode, quota)
  }
  return {};
}

export function writeStoredColumnSizing(
  storageKey: string | undefined,
  sizing: ColumnSizingState,
): void {
  if (!storageKey) return;
  try {
    localStorage.setItem(storageKey, JSON.stringify(sizing));
    // LRU: move this key to the front, evict oldest beyond the cap.
    const order = readLruOrder().filter((k) => k !== storageKey);
    order.unshift(storageKey);
    if (order.length > COL_SIZING_MAX_ENTRIES) {
      const evicted = order.splice(COL_SIZING_MAX_ENTRIES);
      for (const k of evicted) {
        try { localStorage.removeItem(k); } catch { /* ignore */ }
      }
    }
    writeLruOrder(order);
  } catch {
    // ignore
  }
}

/**
 * Per-column filter model. Replaces the old plain-string "contains" filter
 * with an operator-driven condition so each header can express text matches
 * (contains / equals / starts / ends), numeric comparisons (= / > / < / range)
 * and a NULL gate, all combined with the cross-column global filter (AND). The
 * structured value is stored as the TanStack column filter value and read back
 * by `columnFilter` (the `filterFn`) and the header popup.
 */
export type FilterNullMode = "any" | "only" | "exclude";
export type TextFilterOp = "contains" | "equals" | "startsWith" | "endsWith";
export type NumberFilterOp = "eq" | "gt" | "lt" | "between";
export type FilterOp = TextFilterOp | NumberFilterOp;

export interface ColumnFilter {
  op: FilterOp;
  /** Primary operand (or lower bound for `between`). */
  value: string;
  /** Upper bound for `between`; ignored by every other operator. */
  value2: string;
  nullMode: FilterNullMode;
}

const TEXT_FILTER_OPS: { op: TextFilterOp; key: I18nKey }[] = [
  { op: "contains", key: "gridFilterOpContains" },
  { op: "equals", key: "gridFilterOpEquals" },
  { op: "startsWith", key: "gridFilterOpStartsWith" },
  { op: "endsWith", key: "gridFilterOpEndsWith" },
];

const NUMBER_FILTER_OPS: { op: NumberFilterOp; key: I18nKey }[] = [
  { op: "eq", key: "gridFilterOpEq" },
  { op: "gt", key: "gridFilterOpGt" },
  { op: "lt", key: "gridFilterOpLt" },
  { op: "between", key: "gridFilterOpBetween" },
];

function isNumericFilterKind(kind: CellKind): boolean {
  return kind === "number" || kind === "decimal";
}

function makeDefaultFilter(kind: CellKind): ColumnFilter {
  return {
    op: isNumericFilterKind(kind) ? "eq" : "contains",
    value: "",
    value2: "",
    nullMode: "any",
  };
}

/** A plain (optionally signed) base-10 integer string, safe for BigInt(). */
function isIntegerLiteral(s: string): boolean {
  return /^[+-]?\d+$/.test(s.trim());
}

/** Does the filter carry a value operand (vs. being a NULL-only condition)? */
function filterHasValue(f: ColumnFilter): boolean {
  if (f.op === "between") return f.value.trim() !== "" || f.value2.trim() !== "";
  return f.value.trim() !== "";
}

/**
 * A filter only counts as "active" when it actually narrows the result: it has
 * a value operand or a non-default NULL gate. Inactive filters are stored as
 * `undefined` so the header icon highlight and the filtered-row summary track
 * real conditions only.
 */
export function isColumnFilterActive(f: ColumnFilter | undefined): f is ColumnFilter {
  return !!f && (f.nullMode !== "any" || filterHasValue(f));
}

function matchesColumnValue(v: Exclude<CellValue, null | undefined>, f: ColumnFilter): boolean {
  switch (f.op) {
    case "contains":
    case "equals":
    case "startsWith":
    case "endsWith": {
      const s = String(v).toLowerCase();
      const q = f.value.toLowerCase();
      if (f.op === "contains") return s.includes(q);
      if (f.op === "equals") return s === q;
      if (f.op === "startsWith") return s.startsWith(q);
      return s.endsWith(q);
    }
    case "eq":
    case "gt":
    case "lt":
    case "between": {
      const raw = String(v).trim();
      const a = f.value.trim();
      const b = f.value2.trim();
      // Big integers (e.g. BIGINT ids beyond 2^53) lose precision through
      // Number(), which would break `eq`/range on real-world key columns. When
      // the cell value and every supplied operand are plain integers, compare
      // exactly via BigInt. Fractional decimals (and anything non-integer) fall
      // back to Number — the same precision ceiling the numeric sort comparator
      // already accepts.
      const operands = f.op === "between" ? [a, b] : [a];
      const present = operands.filter((x) => x !== "");
      if (isIntegerLiteral(raw) && present.length > 0 && present.every(isIntegerLiteral)) {
        const n = BigInt(raw);
        if (f.op === "eq") return n === BigInt(a);
        if (f.op === "gt") return n > BigInt(a);
        if (f.op === "lt") return n < BigInt(a);
        // between: an empty bound is treated as open.
        return (a === "" || n >= BigInt(a)) && (b === "" || n <= BigInt(b));
      }
      const n = Number(v);
      if (Number.isNaN(n)) return false;
      const an = a === "" ? NaN : Number(a);
      if (f.op === "eq") return !Number.isNaN(an) && n === an;
      if (f.op === "gt") return !Number.isNaN(an) && n > an;
      if (f.op === "lt") return !Number.isNaN(an) && n < an;
      // between: an empty bound is treated as open (-∞ / +∞).
      const bn = b === "" ? NaN : Number(b);
      const lo = Number.isNaN(an) ? -Infinity : an;
      const hi = Number.isNaN(bn) ? Infinity : bn;
      return n >= lo && n <= hi;
    }
  }
}

const columnFilter: FilterFn<RowShape> = (row, columnId, filterValue) => {
  const f = filterValue as ColumnFilter | undefined;
  if (!isColumnFilterActive(f)) return true;
  const v = row.getValue(columnId) as CellValue;
  const isNull = v === null || v === undefined;
  if (f.nullMode === "only") return isNull;
  if (f.nullMode === "exclude" && isNull) return false;
  // The NULL gate is satisfied; a bare NULL gate (no value operand) passes here.
  if (!filterHasValue(f)) return true;
  // A value condition can't be met by NULL (the "only" case already returned).
  if (isNull) return false;
  return matchesColumnValue(v, f);
};

const globalIncludesFilter: FilterFn<RowShape> = (row, _columnId, filterValue) => {
  const fv = (filterValue ?? "") as string;
  if (fv === "") return true;
  const needle = fv.toLowerCase();
  const r = row as Row<RowShape>;
  for (const cell of r.getAllCells()) {
    if (!cell.column.getCanGlobalFilter()) continue;
    const v = cell.getValue() as CellValue;
    const s = v === null || v === undefined ? "null" : String(v);
    if (s.toLowerCase().includes(needle)) return true;
  }
  return false;
};

/** Field styling shared by the filter popup's selects/inputs. */
const FILTER_FIELD_CSS: SystemStyleObject = {
  width: "100%",
  padding: "4px 6px",
  fontSize: "var(--text-sm)",
  fontFamily: "var(--font-mono)",
  color: "var(--text)",
  background: "var(--bg-input)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)",
  _focus: {
    outline: "none",
    borderColor: "var(--accent)",
    boxShadow: "0 0 0 1px color-mix(in srgb, var(--accent) 35%, transparent)",
  },
  _disabled: { opacity: 0.5, cursor: "not-allowed" },
};

/**
 * Per-column filter popup, anchored under a header's filter icon and rendered
 * to <body> via a portal (so it escapes the grid's overflow/sticky clipping,
 * mirroring `ContextMenu`). It owns a local `draft` seeded once from the active
 * filter; every edit is pushed up via `onChange` — as the structured value when
 * it narrows anything, or `undefined` to clear it. Text columns expose
 * contains/equals/starts/ends; numeric columns expose = / > / < / range; both
 * carry a NULL gate (include / only / exclude).
 */
function ColumnFilterMenu({
  columnName,
  kind,
  anchor,
  value,
  onChange,
  onClose,
}: {
  columnName: string;
  kind: CellKind;
  anchor: DOMRect;
  value: ColumnFilter | undefined;
  onChange: (next: ColumnFilter | undefined) => void;
  onClose: () => void;
}) {
  const t = useT();
  const numeric = isNumericFilterKind(kind);
  const ops = numeric ? NUMBER_FILTER_OPS : TEXT_FILTER_OPS;
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [draft, setDraft] = useState<ColumnFilter>(() => value ?? makeDefaultFilter(kind));
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // Commit the draft up to the table, clearing it when it no longer narrows.
  const apply = (next: ColumnFilter) => {
    setDraft(next);
    onChange(isColumnFilterActive(next) ? next : undefined);
  };

  // Clamp into the viewport once measured: anchor the right edge under the
  // icon, flipping up/left when it would overflow. Re-runs on `draft.op` too,
  // since switching to `between` adds a row and changes the menu height — a
  // popup opened near the bottom edge must re-measure so it doesn't overflow.
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const margin = 6;
    let left = anchor.right - width;
    if (left < margin) left = anchor.left;
    let top = anchor.bottom + 4;
    if (top + height + margin > window.innerHeight) top = anchor.top - height - 4;
    left = Math.min(Math.max(margin, left), window.innerWidth - width - margin);
    top = Math.min(Math.max(margin, top), window.innerHeight - height - margin);
    setPos({ left, top });
  }, [anchor, draft.op]);

  // Dismiss on Escape, outside pointer-down, scroll or resize (as ContextMenu).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("scroll", onClose, true);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  const valuesDisabled = draft.nullMode === "only";
  const label = t("gridFilterAria", { column: columnName });

  return createPortal(
    <Box
      ref={menuRef}
      role="dialog"
      aria-label={label}
      position="fixed"
      zIndex={1000}
      width="240px"
      display="flex"
      flexDirection="column"
      gap="8px"
      padding="10px"
      bg="app.surface"
      border="1px solid"
      borderColor="app.borderStrong"
      borderRadius="md"
      boxShadow="md"
      style={{
        left: pos?.left ?? anchor.left,
        top: pos?.top ?? anchor.bottom,
        visibility: pos ? "visible" : "hidden",
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <chakra.div
        fontSize="var(--text-sm)"
        fontWeight={600}
        color="app.text"
        whiteSpace="nowrap"
        overflow="hidden"
        textOverflow="ellipsis"
        title={columnName}
      >
        {columnName}
      </chakra.div>

      <chakra.label display="flex" flexDirection="column" gap="3px">
        <chakra.span fontSize="var(--text-xs)" color="app.textMuted">
          {t("gridFilterOperatorLabel")}
        </chakra.span>
        <chakra.select
          css={FILTER_FIELD_CSS}
          value={draft.op}
          onChange={(e) => apply({ ...draft, op: e.target.value as FilterOp })}
        >
          {ops.map((o) => (
            <option key={o.op} value={o.op}>
              {t(o.key)}
            </option>
          ))}
        </chakra.select>
      </chakra.label>

      {draft.op === "between" ? (
        <Box display="flex" gap="6px">
          <chakra.input
            css={FILTER_FIELD_CSS}
            type="text"
            inputMode="decimal"
            value={draft.value}
            disabled={valuesDisabled}
            placeholder={t("gridFilterMinPlaceholder")}
            aria-label={t("gridFilterMinPlaceholder")}
            onChange={(e) => apply({ ...draft, value: e.target.value })}
          />
          <chakra.input
            css={FILTER_FIELD_CSS}
            type="text"
            inputMode="decimal"
            value={draft.value2}
            disabled={valuesDisabled}
            placeholder={t("gridFilterMaxPlaceholder")}
            aria-label={t("gridFilterMaxPlaceholder")}
            onChange={(e) => apply({ ...draft, value2: e.target.value })}
          />
        </Box>
      ) : (
        <chakra.input
          autoFocus
          css={FILTER_FIELD_CSS}
          type="text"
          inputMode={numeric ? "decimal" : undefined}
          value={draft.value}
          disabled={valuesDisabled}
          placeholder={t("gridFilterValuePlaceholder")}
          aria-label={label}
          onChange={(e) => apply({ ...draft, value: e.target.value })}
        />
      )}

      <chakra.label display="flex" flexDirection="column" gap="3px">
        <chakra.span fontSize="var(--text-xs)" color="app.textMuted">
          {t("gridFilterNullLabel")}
        </chakra.span>
        <chakra.select
          css={FILTER_FIELD_CSS}
          value={draft.nullMode}
          onChange={(e) => apply({ ...draft, nullMode: e.target.value as FilterNullMode })}
        >
          <option value="any">{t("gridFilterNullAny")}</option>
          <option value="only">{t("gridFilterNullOnly")}</option>
          <option value="exclude">{t("gridFilterNullExclude")}</option>
        </chakra.select>
      </chakra.label>

      <Box display="flex" justifyContent="space-between" gap="6px" paddingTop="2px">
        <Button
          variant="secondary"
          size="sm"
          px="10px"
          onClick={() => {
            apply(makeDefaultFilter(kind));
            onClose();
          }}
        >
          {t("gridFilterClearColumn")}
        </Button>
        <Button size="sm" px="10px" onClick={onClose}>
          {t("gridFilterCloseMenu")}
        </Button>
      </Box>
    </Box>,
    document.body,
  );
}

/**
 * Render a column/row pair as a TanStack-backed HTML table. Used by both
 * `ResultGrid` (single result) and the preview view (before/after).
 *
 * When `enableColumnControls` is true (default), each header is clickable
 * to cycle sort (none → asc → desc → none) and exposes a filter icon that
 * opens a per-column condition popup (`ColumnFilterMenu`).
 *
 * `changedCells`/`changedColumns` are indexed by the ORIGINAL row position
 * (i.e. `rows[i]`) and applied after sort/filter via `row.index`, so the
 * highlight tracks the row even when the user re-sorts the preview pane.
 */
/** Pseudo-random width percentages for skeleton shimmer bars (cycles by column index). */
const SKELETON_WIDTHS = [68, 85, 52, 90, 72, 58];

export function DataGrid({
  columns,
  rows,
  enableColumnControls = true,
  changedCells,
  changedColumns,
  globalFilter,
  editable = false,
  editableColumns,
  pkIndices,
  pendingEdits,
  onSetCellEdit,
  validateEdit,
  columnSizingStorageKey,
  emptyMessage,
  skeleton = false,
  scrollContainerRef,
  rowSqlDriver,
  rowSqlDatabase,
  rowSqlTable,
  columnMeta,
  onFkJump,
  paginationState,
  onPaginationChange,
  onUndoEdit,
  onRedoEdit,
}: {
  columns: Column[];
  rows: CellValue[][];
  enableColumnControls?: boolean;
  changedCells?: boolean[][];
  changedColumns?: boolean[];
  /** Optional global filter string applied across all visible columns. */
  globalFilter?: string;
  /**
   * When true, double-clicking an editable cell opens an inline `<input>`.
   * `editableColumns[i]` gates per-column (false for PK and BLOB columns).
   * `pendingEdits` / `onSetCellEdit` route the buffered change up to App.
   */
  editable?: boolean;
  editableColumns?: boolean[];
  /**
   * Result-column indices forming the table's primary key. Used to derive each
   * row's stable `rowEditKey` so buffered edits survive pagination. Empty (or
   * omitted) means no resolvable PK — editing is gated off in that case.
   */
  pkIndices?: number[];
  pendingEdits?: PendingEdits;
  onSetCellEdit?: (rowKey: string, colIdx: number, value: string | null) => void;
  /**
   * Validates a pending edit by result-column index, returning an i18n key
   * describing the problem or `null` when the value is acceptable. Drives the
   * inline error shown under the edit box and the invalid-cell highlight.
   */
  validateEdit?: (colIdx: number, value: string) => I18nKey | null;
  /**
   * When set, user-adjusted column widths persist to `localStorage` under
   * this key and are restored for matching result shapes. Omit (preview
   * panes) to keep sizing ephemeral.
   */
  columnSizingStorageKey?: string;
  /**
   * Shown in the body when the result genuinely has 0 rows (not filtered out).
   * Omitted (e.g. mid-stream) leaves the body empty under the header.
   */
  emptyMessage?: ReactNode;
  /** When true and `rows` is empty, render skeleton shimmer rows instead of the empty body. */
  skeleton?: boolean;
  /**
   * Scroll container that owns this grid's vertical overflow. When provided the
   * `<tbody>` is **row-virtualized** (`@tanstack/react-virtual`): only the rows
   * near the viewport are rendered, with top/bottom spacer `<tr>` absorbing the
   * off-screen height. Large result sets (the default auto LIMIT is 1000 rows,
   * and "load more" appends thousands) otherwise mount every cell, which makes
   * scrolling and re-renders heavy. Omit it (e.g. preview panes with small
   * snapshots) to render every row as before.
   */
  scrollContainerRef?: RefObject<HTMLDivElement | null>;
  /**
   * When `rowSqlTable` is set, the right-click menu can generate executable
   * INSERT / UPDATE / DELETE statements for the clicked row. `rowSqlDriver`
   * selects the dialect (identifier quoting, BLOB literal form) and
   * `rowSqlDatabase` qualifies the table reference (ignored for SQLite).
   * UPDATE / DELETE additionally require a resolvable primary key (`pkIndices`).
   * Omit `rowSqlTable` (free-form query results with no single target table) to
   * hide the SQL-copy items entirely.
   */
  rowSqlDriver?: string;
  rowSqlDatabase?: string | null;
  rowSqlTable?: string | null;
  /**
   * Column metadata from `describe_table` (FK, key info). When provided and a
   * column carries `referenced_table`, a "Jump to …" item is added to the
   * right-click menu and an FK badge appears in the column header.
   */
  columnMeta?: TableColumnInfo[];
  /** Called when the user triggers a FK jump with the generated SELECT SQL. */
  onFkJump?: (sql: string) => void;
  /** When set, TanStack pagination is activated and only this page of rows is rendered. */
  paginationState?: PaginationState;
  onPaginationChange?: OnChangeFn<PaginationState>;
  onUndoEdit?: () => void;
  onRedoEdit?: () => void;
}) {
  const t = useT();
  const locale = useLocale();
  const { cellEditOnBlur, richCellRendering } = useSettings();
  const { confirm: confirmBlur, dialog: blurDialog } = useConfirm();

  const columnKinds = useMemo<CellKind[]>(() => columns.map(classifyColumn), [columns]);

  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);

  // Column widths persist per result shape. The ref mirrors the live state so
  // functional updates from TanStack resolve against the latest value without
  // re-creating the change handler on every render.
  const [columnSizing, setColumnSizing] = useState<ColumnSizingState>(() =>
    readStoredColumnSizing(columnSizingStorageKey),
  );
  const columnSizingRef = useRef(columnSizing);
  columnSizingRef.current = columnSizing;
  // Reload (or clear) sizing when the storage key changes — i.e. a different
  // table/result shape. Persisting happens only on user resize (below), so
  // this load never races a stale write back to the new key.
  useEffect(() => {
    setColumnSizing(readStoredColumnSizing(columnSizingStorageKey));
  }, [columnSizingStorageKey]);
  // Persist on resize. Inlined into table options so the latest storage key
  // is captured each render (TanStack re-reads options every render).
  const handleColumnSizingChange: OnChangeFn<ColumnSizingState> = (updater) => {
    const next =
      typeof updater === "function" ? updater(columnSizingRef.current) : updater;
    setColumnSizing(next);
    writeStoredColumnSizing(columnSizingStorageKey, next);
  };

  const tableColumns = useMemo<ColumnDef<RowShape>[]>(() => {
    return columns.map((c, i) => {
      const kind = columnKinds[i];
      const fkInfo = columnMeta?.find((m) => m.name === c.name);
      const fkTable = fkInfo?.referenced_table ?? null;
      return {
        id: String(i),
        header: () => (
          <span
            className="th-content"
            title={fkTable ? t("gridFkColHeader", { table: fkTable }) : c.type_name}
          >
            {fkTable && <span className="th-fk-badge">FK</span>}
            <span className="th-name">{c.name}</span>
            <span className="th-type">{c.type_name}</span>
          </span>
        ),
        accessorFn: (row) => row[String(i)],
        sortingFn: sortingFnForKind(kind),
        filterFn: columnFilter,
        enableSorting: enableColumnControls,
        enableColumnFilter: enableColumnControls,
        size: defaultColumnSize(kind),
        minSize: 60,
        maxSize: 800,
        cell: (info) => {
          const v = info.getValue() as CellValue;
          if (v === null || v === undefined) {
            return <span className="cell-null">{t("resultNull")}</span>;
          }
          const effectiveKind = classifyByValue(v) ?? kind;
          if (effectiveKind === "number") {
            const num = typeof v === "number" ? v : Number(v);
            const display = Number.isFinite(num) ? formatNumber(num) : String(v);
            return <span className="cell-number">{display}</span>;
          }
          if (effectiveKind === "decimal") {
            return <span className="cell-number cell-decimal">{String(v)}</span>;
          }
          if (effectiveKind === "bool") {
            const truthy = v === true || v === 1 || v === "1" || String(v).toLowerCase() === "true";
            // リッチ表示時はピル型バッジ、OFF 時は従来の色付きテキスト。どちらも
            // 表示文字列は "true"/"false" のまま (コピー時は元の値を使う)。
            const cls = richCellRendering ? "cell-bool cell-bool-badge" : "cell-bool";
            return (
              <span className={`${cls} ${truthy ? "is-true" : "is-false"}`}>
                {truthy ? "true" : "false"}
              </span>
            );
          }
          if (effectiveKind === "date" || effectiveKind === "time") {
            const raw = String(v);
            // 日付/時刻のローカライズ整形は表示専用。原文を title に残し、コピー/
            // 編集/エクスポートは元の値 (raw) を使う。time 型や解析不能な値は素の
            // ままにする。
            const formatted =
              richCellRendering && effectiveKind === "date"
                ? formatDateTimeDisplay(raw, locale)
                : null;
            return formatted !== null ? (
              <span className="cell-date" title={raw}>
                {formatted}
              </span>
            ) : (
              <span className="cell-date">{raw}</span>
            );
          }
          if (effectiveKind === "json") {
            const raw = String(v);
            // グリッド内では空白を畳んだコンパクト表現にする (表示専用、原文は title)。
            const compact = richCellRendering ? formatJsonCompact(raw) : null;
            return compact !== null ? (
              <span className="cell-json" title={raw}>
                {compact}
              </span>
            ) : (
              <span className="cell-json">{raw}</span>
            );
          }
          if (effectiveKind === "enum") {
            const raw = String(v);
            // 列挙値は値ごとに決まる色相でバッジ表示する (表示専用)。OFF 時は素の文字列。
            if (!richCellRendering) {
              return <span className="cell-string">{raw}</span>;
            }
            return (
              <span
                className="cell-enum-badge"
                title={raw}
                style={{ "--enum-hue": enumBadgeHue(raw) } as CSSProperties}
              >
                {raw}
              </span>
            );
          }
          if (effectiveKind === "binary") {
            const s = String(v);
            const label = t("gridBlobBytes", { size: formatBytes(Math.floor(s.length / 2)) });
            const preview = s.length > 64 ? `${s.slice(0, 64)}…` : s;
            return (
              <span className="cell-binary" title={`${label} — 0x${s}`}>
                <span className="cell-binary-tag">{label}</span>0x{preview}
              </span>
            );
          }
          return <span className="cell-string">{String(v)}</span>;
        },
      };
    });
  }, [columns, columnKinds, columnMeta, t, enableColumnControls, richCellRendering, locale]);

  const data = useMemo<RowShape[]>(() => {
    return rows.map((r) => {
      const o: RowShape = {};
      r.forEach((v, i) => (o[String(i)] = v));
      return o;
    });
  }, [rows]);

  const table = useReactTable({
    data,
    columns: tableColumns,
    state: {
      sorting,
      columnFilters,
      globalFilter: globalFilter ?? "",
      columnSizing,
      ...(paginationState ? { pagination: paginationState } : {}),
    },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onColumnSizingChange: handleColumnSizingChange,
    ...(onPaginationChange ? { onPaginationChange } : {}),
    globalFilterFn: globalIncludesFilter,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    ...(paginationState ? { getPaginationRowModel: getPaginationRowModel() } : {}),
    enableSortingRemoval: true,
    enableColumnResizing: true,
    columnResizeMode: "onChange",
  });

  const isNumericKind = (k: CellKind) => k === "number" || k === "decimal";

  // Inline-edit state: the cell currently being typed into (if any) plus
  // the buffered text. Lives in DataGrid so navigation between cells is
  // local — committed values are lifted via `onSetCellEdit`.
  const [editing, setEditing] = useState<
    { rowIdx: number; colIdx: number; value: string } | null
  >(null);

  // Keyboard navigation: the currently selected cell (row = original row index).
  const [activeCell, setActiveCell] = useState<{ rowIdx: number; colIdx: number } | null>(null);
  // When set, the next layout effect will try to focus that cell's <td>.
  const pendingFocusRef = useRef<{ rowIdx: number; colIdx: number } | null>(null);
  // Refs to mounted data <td> elements keyed by "rowIdx:colIdx".
  const cellRefs = useRef<Map<string, HTMLTableCellElement>>(new Map());

  // Right-click "copy" menu. `rowIdx` is the ORIGINAL row index (so copied
  // values match `rows` regardless of sort/filter) and `colIdx` the display
  // column position. `copied` drives a brief confirmation toast.
  const [copyMenu, setCopyMenu] = useState<
    { x: number; y: number; rowIdx: number; colIdx: number } | null
  >(null);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | null>(null);

  // Full-value viewer target (original row index + display column index).
  const [viewer, setViewer] = useState<{ rowIdx: number; colIdx: number } | null>(null);

  // Open per-column filter popup: which column, and the anchor rect of the
  // header's filter icon (captured at click for portal positioning).
  const [filterMenu, setFilterMenu] = useState<{ colIdx: number; anchor: DOMRect } | null>(null);

  useEffect(
    () => () => {
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    },
    [],
  );

  const runCopy = async (text: string) => {
    setCopyMenu(null);
    await copyToClipboard(text);
    setCopied(true);
    if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => setCopied(false), 1500);
  };
  const copyCell = (rowIdx: number, colIdx: number) =>
    void runCopy(cellToText(rows[rowIdx]?.[colIdx] ?? null));
  const copyRow = (rowIdx: number) =>
    void runCopy((rows[rowIdx] ?? []).map(cellToText).join("\t"));
  const copyRowWithHeaders = (rowIdx: number) =>
    void runCopy(
      `${columns.map((c) => c.name).join("\t")}\n${(rows[rowIdx] ?? [])
        .map(cellToText)
        .join("\t")}`,
    );

  // Whether the right-click menu can offer "copy as SQL": we need a concrete
  // target table (set only for table tabs, not free-form query results).
  const rowSqlAvailable = !!rowSqlTable;
  const rowSqlHasPk = (pkIndices?.length ?? 0) > 0;
  const copyRowSql = (rowIdx: number, kind: RowSqlKind) => {
    const row = rows[rowIdx];
    if (!row || !rowSqlTable) return;
    const stmts = buildRowSql(
      {
        driver: rowSqlDriver ?? "mysql",
        database: rowSqlDatabase ?? "",
        table: rowSqlTable,
        columns,
        rows: [row],
        pkIndices: pkIndices ?? [],
      },
      kind,
    );
    if (stmts.length === 0) return;
    void runCopy(stmts.join("\n"));
  };

  const commitEdit = (
    rowIdx: number,
    colIdx: number,
    value: string,
    originalDisplay: string,
  ) => {
    if (!onSetCellEdit) return;
    // Lift the change under the row's PK-derived identity, not its array
    // index, so it stays bound to this row after pagination grows `rows`.
    const rowKey = rowEditKey(rows[rowIdx] ?? [], pkIndices ?? [], rowIdx);
    // Re-typing the original value clears the pending edit so the user
    // can "undo" without hitting Cancel.
    if (value === originalDisplay) {
      onSetCellEdit(rowKey, colIdx, null);
    } else {
      onSetCellEdit(rowKey, colIdx, value);
    }
  };

  const visibleRows = table.getRowModel().rows;
  const totalRows = rows.length;
  const hasColumnFilter = columnFilters.length > 0;
  const hasGlobalFilter = (globalFilter ?? "").trim().length > 0;
  const isFiltered = enableColumnControls && (hasColumnFilter || hasGlobalFilter);

  // After every render, attempt to focus the pending cell (the element may not
  // have been in the DOM on the previous cycle if the virtualizer needed to
  // scroll it into view first).
  useLayoutEffect(() => {
    const target = pendingFocusRef.current;
    if (!target) return;
    const el = cellRefs.current.get(`${target.rowIdx}:${target.colIdx}`);
    if (!el) return;
    el.focus({ preventScroll: true });
    pendingFocusRef.current = null;
  });

  // Move keyboard focus to the given cell (original row index + column index).
  // Scrolls the virtualizer when the target row is off-screen.
  const navigateCell = (newRowIdx: number, newColIdx: number) => {
    const visIdx = visibleRows.findIndex((r) => r.index === newRowIdx);
    if (visIdx >= 0 && virtualize) {
      rowVirtualizer.scrollToIndex(visIdx, { align: "auto" });
    }
    setActiveCell({ rowIdx: newRowIdx, colIdx: newColIdx });
    pendingFocusRef.current = { rowIdx: newRowIdx, colIdx: newColIdx };
  };

  // Row virtualization. Cells are single-line (`white-space: nowrap` +
  // ellipsis), so rows are uniform height; we still let the virtualizer
  // `measureElement` the real height so it follows the font-scale setting and
  // the occasional taller row (open inline editor). `estimateSize` only seeds
  // the first paint. When `scrollContainerRef` is absent (preview panes) we
  // render every row, so `virtualize` gates whether the virtual items are used.
  const virtualize = !!scrollContainerRef;
  // Seed the virtual row height from the active density preset (#410). The exact
  // height is still measured via `measureElement`, but a density-matched seed
  // avoids a visible re-layout jump on the first paint and after switching
  // density (see the re-measure effect below).
  const density = useSettings().density;
  const rowVirtualizer = useVirtualizer({
    count: visibleRows.length,
    getScrollElement: () => scrollContainerRef?.current ?? null,
    estimateSize: () => DENSITY_ROW_ESTIMATE[density],
    overscan: 16,
  });
  // Density changes the row height via CSS vars; re-measure so the virtualizer's
  // cached sizes (and total scroll height) follow instead of lagging by a paint.
  useEffect(() => {
    if (virtualize) rowVirtualizer.measure();
  }, [density, virtualize, rowVirtualizer]);
  const virtualItems = virtualize ? rowVirtualizer.getVirtualItems() : [];
  const virtualPaddingTop = virtualItems.length > 0 ? virtualItems[0].start : 0;
  const virtualPaddingBottom =
    virtualItems.length > 0
      ? rowVirtualizer.getTotalSize() - virtualItems[virtualItems.length - 1].end
      : 0;
  // Total column count (row-index + data columns + filler) for spacer colSpan.
  const totalColCount = columns.length + 2;

  // Grid-level keyboard handler: arrow keys, Tab, Enter, Ctrl+C, etc.
  // Fires on the <table> (bubbled from the focused <td>). When the inline
  // editor is open the input handles its own keys and this handler short-circuits.
  const handleGridKeyDown = (e: React.KeyboardEvent<HTMLTableElement>) => {
    if (editing) return;
    if (!activeCell) return;
    const { rowIdx, colIdx } = activeCell;
    const visIdx = visibleRows.findIndex((r) => r.index === rowIdx);
    if (visIdx < 0) return;
    const colCount = columns.length;
    const rowCount = visibleRows.length;

    switch (e.key) {
      case "ArrowUp":
        e.preventDefault();
        if (visIdx > 0) navigateCell(visibleRows[visIdx - 1].index, colIdx);
        break;
      case "ArrowDown":
        e.preventDefault();
        if (visIdx < rowCount - 1) navigateCell(visibleRows[visIdx + 1].index, colIdx);
        break;
      case "ArrowLeft":
        e.preventDefault();
        if (colIdx > 0) navigateCell(rowIdx, colIdx - 1);
        break;
      case "ArrowRight":
        e.preventDefault();
        if (colIdx < colCount - 1) navigateCell(rowIdx, colIdx + 1);
        break;
      case "Tab":
        e.preventDefault();
        if (!e.shiftKey) {
          if (colIdx < colCount - 1) navigateCell(rowIdx, colIdx + 1);
          else if (visIdx < rowCount - 1) navigateCell(visibleRows[visIdx + 1].index, 0);
        } else {
          if (colIdx > 0) navigateCell(rowIdx, colIdx - 1);
          else if (visIdx > 0) navigateCell(visibleRows[visIdx - 1].index, colCount - 1);
        }
        break;
      case "Home":
        e.preventDefault();
        navigateCell(rowIdx, 0);
        break;
      case "End":
        e.preventDefault();
        navigateCell(rowIdx, colCount - 1);
        break;
      case "Escape":
        e.preventDefault();
        setActiveCell(null);
        break;
      case "Enter": {
        e.preventDefault();
        const colEd = editable && (editableColumns?.[colIdx] ?? false);
        if (colEd && onSetCellEdit) {
          const v = rows[rowIdx]?.[colIdx] ?? null;
          const rowKey = rowEditKey(rows[rowIdx] ?? [], pkIndices ?? [], rowIdx);
          const pending = pendingEdits?.[rowKey]?.[colIdx];
          setEditing({
            rowIdx,
            colIdx,
            value: pending !== undefined ? pending : (v === null || v === undefined ? "" : String(v)),
          });
        } else if (visIdx < rowCount - 1) {
          navigateCell(visibleRows[visIdx + 1].index, colIdx);
        }
        break;
      }
      default:
        // Printable character → start editing with that char
        if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1) {
          const colEd = editable && (editableColumns?.[colIdx] ?? false);
          if (colEd && onSetCellEdit) {
            e.preventDefault();
            setEditing({ rowIdx, colIdx, value: e.key });
          }
        } else if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === "z" || e.key === "Z") && !e.shiftKey) {
          e.preventDefault();
          onUndoEdit?.();
        } else if (
          (e.ctrlKey || e.metaKey) && !e.altKey &&
          ((e.key === "z" || e.key === "Z") && e.shiftKey || e.key === "y" || e.key === "Y")
        ) {
          e.preventDefault();
          onRedoEdit?.();
        } else if ((e.ctrlKey || e.metaKey) && (e.key === "c" || e.key === "C")) {
          e.preventDefault();
          copyCell(rowIdx, colIdx);
        }
    }
  };

  // One row's JSX, shared by the virtualized and non-virtualized paths.
  // `rowIdx` is the visible position (drives the row number and zebra parity);
  // `row.index` is the absolute index into `rows` used for edit/changed lookups.
  // `measureIndex` (when virtualizing) wires the row to the virtualizer so its
  // real height is measured.
  const renderRow = (row: Row<RowShape>, rowIdx: number, measureIndex?: number) => {
    // Does this row hold any buffered edit? Drives the row-level pending marker
    // (#387). Looked up by the row's PK-derived identity, like the per-cell
    // lookup below, so it tracks the row across pagination/sort.
    const rowPendingKey = rowEditKey(rows[row.index] ?? [], pkIndices ?? [], row.index);
    const rowHasPending =
      !!pendingEdits?.[rowPendingKey] && Object.keys(pendingEdits[rowPendingKey]).length > 0;
    const rowClass = [
      // Zebra striping by visible position. Class-based (not `:nth-of-type`)
      // because the virtualized body inserts spacer `<tr>` that would otherwise
      // flip the parity as you scroll.
      rowIdx % 2 === 1 ? "grid-row-stripe" : "",
      rowHasPending ? "grid-row-pending" : "",
    ]
      .filter(Boolean)
      .join(" ");
    return (
    <tr
      key={row.id}
      role="row"
      className={rowClass || undefined}
      ref={measureIndex === undefined ? undefined : rowVirtualizer.measureElement}
      data-index={measureIndex}
    >
      <td className="row-index">{rowIdx + 1}</td>
      {row.getVisibleCells().map((cell, idx) => {
        const v = cell.getValue() as CellValue;
        const kind = columnKinds[idx] ?? "string";
        const isNull = v === null || v === undefined;
        const isChanged = changedCells?.[row.index]?.[idx] ?? false;
        const colEditable = editable && (editableColumns?.[idx] ?? false);
        // Buffered edits are keyed by the row's PK identity, so look
        // them up by `rowEditKey` rather than the array position.
        const rowKey = rowEditKey(
          rows[row.index] ?? [],
          pkIndices ?? [],
          row.index,
        );
        const pendingForRow = pendingEdits?.[rowKey];
        const pendingValue = pendingForRow?.[idx];
        const hasPending = pendingValue !== undefined;
        const isEditingHere =
          editing !== null &&
          editing.rowIdx === row.index &&
          editing.colIdx === idx;
        const isActiveCell = activeCell?.rowIdx === row.index && activeCell?.colIdx === idx;
        // Live validation of the value being typed, and of an
        // already-buffered value that's sitting invalid in the grid.
        const editError =
          isEditingHere && validateEdit
            ? validateEdit(idx, editing!.value)
            : null;
        const pendingError =
          hasPending && !isEditingHere && validateEdit
            ? validateEdit(idx, pendingValue)
            : null;
        // Original display string — used both for the input's
        // default contents and to detect "user typed it back to
        // the original" (which clears the pending edit).
        const originalDisplay = isNull ? "" : String(v);
        const handleDoubleClick = () => {
          // Editable cells edit on double-click; everything else
          // (read-only grids, PK/BLOB columns, preview panes) opens
          // the full-value viewer instead, so the two never collide.
          if (colEditable && onSetCellEdit) {
            setEditing({
              rowIdx: row.index,
              colIdx: idx,
              value: hasPending ? pendingValue : originalDisplay,
            });
            return;
          }
          setViewer({ rowIdx: row.index, colIdx: idx });
        };
        return (
          <td
            key={cell.id}
            role="gridcell"
            tabIndex={isActiveCell ? 0 : -1}
            ref={(el) => {
              const key = `${row.index}:${idx}`;
              if (el) cellRefs.current.set(key, el);
              else cellRefs.current.delete(key);
            }}
            className={`col-${kind} ${isNumericKind(kind) ? "align-right" : ""} ${isNull && !hasPending ? "is-null" : ""} ${isChanged ? "is-changed" : ""} ${hasPending ? "is-pending-edit" : ""} ${colEditable ? "is-editable-cell" : ""} ${editError || pendingError ? "is-invalid-edit" : ""} ${isActiveCell ? "is-active-cell" : ""}`}
            title={
              isEditingHere
                ? undefined
                : hasPending
                  ? t("editPendingTitle", {
                      original: isNull ? t("resultNull") : String(v),
                      next: pendingValue,
                    })
                  : isNull
                    ? t("resultNull")
                    : // 長文テキストは省略記号で切れて全長が分からないので、ホバーの
                      // タイトルに文字数を添える (#385)。テキスト系の列だけが対象。
                      (kind === "string" || kind === "json") && String(v).length > 40
                      ? `${String(v)}\n(${t("gridCharCount", { count: String(v).length })})`
                      : String(v)
            }
            onFocus={(e) => {
              if (e.target === e.currentTarget) {
                setActiveCell({ rowIdx: row.index, colIdx: idx });
              }
            }}
            onDoubleClick={handleDoubleClick}
            onContextMenu={(e) => {
              e.preventDefault();
              setCopyMenu({
                x: e.clientX,
                y: e.clientY,
                rowIdx: row.index,
                colIdx: idx,
              });
            }}
          >
            {isEditingHere ? (
              <div className="cell-edit-wrap">
                <input
                  autoFocus
                  className={`cell-edit-input ${editError ? "is-invalid" : ""}`}
                  aria-invalid={editError ? true : undefined}
                  value={editing!.value}
                  onChange={(e) =>
                    setEditing({
                      rowIdx: editing!.rowIdx,
                      colIdx: editing!.colIdx,
                      value: e.target.value,
                    })
                  }
                  onBlur={() => {
                    const eRowIdx = editing!.rowIdx;
                    const eColIdx = editing!.colIdx;
                    const eValue = editing!.value;
                    const eOrigDisplay = originalDisplay;
                    if (cellEditOnBlur !== "confirm") {
                      commitEdit(eRowIdx, eColIdx, eValue, eOrigDisplay);
                      setEditing(null);
                      return;
                    }
                    // Capture the row's stable key now: an auto-refresh while
                    // the dialog is open could shift `rows[eRowIdx]`.
                    const eRowKey = rowEditKey(rows[eRowIdx] ?? [], pkIndices ?? [], eRowIdx);
                    setEditing(null);
                    void (async () => {
                      const commit = await confirmBlur({
                        title: t("editBlurTitle"),
                        message: t("editBlurMessage"),
                        confirmLabel: t("editBlurCommit"),
                        cancelLabel: t("editBlurDiscard"),
                      });
                      if (commit && onSetCellEdit) {
                        onSetCellEdit(
                          eRowKey,
                          eColIdx,
                          eValue === eOrigDisplay ? null : eValue,
                        );
                      }
                    })();
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Tab") {
                      e.preventDefault();
                      const eRowIdx = editing!.rowIdx;
                      const eColIdx = editing!.colIdx;
                      commitEdit(eRowIdx, eColIdx, editing!.value, originalDisplay);
                      setEditing(null);
                      const vi2 = visibleRows.findIndex((r) => r.index === eRowIdx);
                      const nc = columns.length;
                      if (!e.shiftKey) {
                        if (eColIdx < nc - 1) navigateCell(eRowIdx, eColIdx + 1);
                        else if (vi2 >= 0 && vi2 < visibleRows.length - 1)
                          navigateCell(visibleRows[vi2 + 1].index, 0);
                        else navigateCell(eRowIdx, eColIdx);
                      } else {
                        if (eColIdx > 0) navigateCell(eRowIdx, eColIdx - 1);
                        else if (vi2 > 0)
                          navigateCell(visibleRows[vi2 - 1].index, nc - 1);
                        else navigateCell(eRowIdx, eColIdx);
                      }
                    } else if (e.key === "Enter") {
                      e.preventDefault();
                      const eRowIdx = editing!.rowIdx;
                      const eColIdx = editing!.colIdx;
                      commitEdit(eRowIdx, eColIdx, editing!.value, originalDisplay);
                      setEditing(null);
                      const vi2 = visibleRows.findIndex((r) => r.index === eRowIdx);
                      if (vi2 >= 0 && vi2 < visibleRows.length - 1)
                        navigateCell(visibleRows[vi2 + 1].index, eColIdx);
                      else navigateCell(eRowIdx, eColIdx);
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      setEditing(null);
                      navigateCell(editing!.rowIdx, editing!.colIdx);
                    }
                  }}
                />
                {editError && (
                  <div className="cell-edit-error" role="alert">
                    {t(editError)}
                  </div>
                )}
              </div>
            ) : hasPending ? (
              /^null$/i.test(pendingValue.trim()) ? (
                <span className="cell-null cell-pending-value">
                  {t("resultNull")}
                </span>
              ) : (
                <span className="cell-pending-value">{pendingValue}</span>
              )
            ) : (
              flexRender(cell.column.columnDef.cell, cell.getContext())
            )}
          </td>
        );
      })}
      <td className="col-filler" aria-hidden />
    </tr>
    );
  };

  return (
    <>
      {isFiltered && (
        <Box className="grid-filter-summary">
          {t("gridFilteredCount", { shown: visibleRows.length, total: totalRows })}
          {hasColumnFilter && (
            <chakra.button
              type="button"
              className="grid-filter-clear"
              onClick={() => {
                setColumnFilters([]);
                setSorting([]);
              }}
            >
              {t("gridClearFilters")}
            </chakra.button>
          )}
        </Box>
      )}
      <table role="grid" style={{ width: ROW_INDEX_WIDTH + table.getTotalSize() }} onKeyDown={handleGridKeyDown}>
        <colgroup>
          <col style={{ width: ROW_INDEX_WIDTH }} />
          {table.getHeaderGroups()[0]?.headers.map((h) => (
            <col key={h.id} style={{ width: h.getSize() }} />
          ))}
          {/* Absorbs any extra width so the row-index and data columns
              keep their declared sizes instead of stretching to fill. */}
          <col />
        </colgroup>
        <thead>
          {table.getHeaderGroups().map((hg) => (
            <tr key={hg.id}>
              <th className="row-index" aria-hidden />
              {hg.headers.map((h, idx) => {
                const kind = columnKinds[idx] ?? "string";
                const canSort = enableColumnControls && h.column.getCanSort();
                const canResize = h.column.getCanResize();
                const isResizing = h.column.getIsResizing();
                const sortDir = h.column.getIsSorted();
                const sortGlyph = sortDir === "asc" ? "▲" : sortDir === "desc" ? "▼" : "";
                const sortTitle =
                  sortDir === "asc"
                    ? t("gridSortDesc")
                    : sortDir === "desc"
                      ? t("gridSortClear")
                      : t("gridSortAsc");
                const isChangedCol = changedColumns?.[idx] ?? false;
                const colFilterActive = isColumnFilterActive(
                  h.column.getFilterValue() as ColumnFilter | undefined,
                );
                const filterLabel = t("gridFilterAria", { column: columns[idx]?.name ?? "" });
                return (
                  <th
                    key={h.id}
                    className={`col-${kind} ${canSort ? "is-sortable" : ""} ${sortDir ? `is-sorted-${sortDir}` : ""} ${isResizing ? "is-resizing" : ""} ${isChangedCol ? "is-changed-col" : ""} ${colFilterActive ? "is-filtered-col" : ""}`}
                    aria-sort={sortDir === "asc" ? "ascending" : sortDir === "desc" ? "descending" : "none"}
                  >
                    {enableColumnControls ? (
                      <div className="th-inner">
                        <chakra.button
                          type="button"
                          className="th-sort-button"
                          onClick={h.column.getToggleSortingHandler()}
                          title={sortTitle}
                        >
                          {flexRender(h.column.columnDef.header, h.getContext())}
                          <chakra.span className="th-sort-indicator" aria-hidden>
                            {sortGlyph}
                          </chakra.span>
                        </chakra.button>
                        <chakra.button
                          type="button"
                          className={`th-filter-button ${colFilterActive ? "is-active" : ""}`}
                          onClick={(e) =>
                            setFilterMenu({
                              colIdx: idx,
                              anchor: e.currentTarget.getBoundingClientRect(),
                            })
                          }
                          title={filterLabel}
                          aria-label={filterLabel}
                          aria-haspopup="dialog"
                          aria-expanded={filterMenu?.colIdx === idx}
                        >
                          <Icon name="filter" size={12} strokeWidth={2.2} />
                        </chakra.button>
                      </div>
                    ) : (
                      flexRender(h.column.columnDef.header, h.getContext())
                    )}
                    {canResize && (
                      <div
                        className={`th-resize-handle ${isResizing ? "is-resizing" : ""}`}
                        onMouseDown={h.getResizeHandler()}
                        onTouchStart={h.getResizeHandler()}
                        onDoubleClick={() => h.column.resetSize()}
                        title={t("gridResizeColumn")}
                        aria-hidden
                      />
                    )}
                  </th>
                );
              })}
              <th className="col-filler" aria-hidden />
            </tr>
          ))}
        </thead>
        <tbody>
          {skeleton && rows.length === 0 ? (
            // Skeleton shimmer rows shown while the first batch of a streaming query
            // has not yet arrived. Rows fade out progressively to create visual depth.
            Array.from({ length: 6 }, (_, i) => (
              <tr key={i} className="grid-skeleton-row" style={{ opacity: 1 - i * 0.14 }} aria-hidden>
                <td className="row-index" />
                {columns.length > 0 ? columns.map((_, ci) => (
                  <td key={ci} className="grid-skeleton-cell">
                    <div style={{
                      width: `${SKELETON_WIDTHS[ci % SKELETON_WIDTHS.length]}%`,
                      animationDelay: `${i * 0.1}s`,
                    }} />
                  </td>
                )) : (
                  <td colSpan={1} className="grid-skeleton-cell">
                    <div style={{
                      width: `${SKELETON_WIDTHS[i % SKELETON_WIDTHS.length]}%`,
                      animationDelay: `${i * 0.1}s`,
                    }} />
                  </td>
                )}
                <td className="col-filler" />
              </tr>
            ))
          ) : visibleRows.length === 0 && (isFiltered || emptyMessage) ? (
            <tr>
              <td className="row-index" aria-hidden />
              <td className="grid-empty-cell" colSpan={columns.length}>
                {isFiltered ? t("gridNoMatches") : emptyMessage}
              </td>
              <td className="col-filler" aria-hidden />
            </tr>
          ) : virtualize && virtualItems.length > 0 ? (
            // `virtualItems.length > 0` gates the virtualized path: when the
            // scroll container has no measured height yet (first render before
            // the ref attaches, or non-layout test environments like jsdom) the
            // virtualizer yields no items, so we fall through to rendering every
            // row. In a real browser the layout effect measures the viewport and
            // re-renders virtualized before paint; by the time a result grows to
            // thousands of rows (streaming/paging/"fetch all") the grid is
            // already mounted and measured, so the full render only ever covers
            // the small initial batch.
            <>
              {/* Spacer rows hold the off-screen height so the scrollbar and
                  sticky columns behave as if every row were present. */}
              {virtualPaddingTop > 0 && (
                <tr aria-hidden>
                  <td
                    colSpan={totalColCount}
                    style={{ height: virtualPaddingTop, padding: 0, border: 0, background: "transparent" }}
                  />
                </tr>
              )}
              {virtualItems.map((vi) => renderRow(visibleRows[vi.index], vi.index, vi.index))}
              {virtualPaddingBottom > 0 && (
                <tr aria-hidden>
                  <td
                    colSpan={totalColCount}
                    style={{ height: virtualPaddingBottom, padding: 0, border: 0, background: "transparent" }}
                  />
                </tr>
              )}
            </>
          ) : (
            visibleRows.map((row, rowIdx) => renderRow(row, rowIdx))
          )}
        </tbody>
      </table>
      {copyMenu && (
        <ContextMenu
          x={copyMenu.x}
          y={copyMenu.y}
          onClose={() => setCopyMenu(null)}
          items={[
            { label: t("gridCopyCell"), onSelect: () => copyCell(copyMenu.rowIdx, copyMenu.colIdx) },
            { label: t("gridCopyRow"), onSelect: () => copyRow(copyMenu.rowIdx) },
            {
              label: t("gridCopyRowWithHeaders"),
              onSelect: () => copyRowWithHeaders(copyMenu.rowIdx),
            },
            ...(rowSqlAvailable
              ? [
                  { separator: true as const },
                  {
                    label: t("gridCopyAsInsert"),
                    onSelect: () => copyRowSql(copyMenu.rowIdx, "insert"),
                  },
                  {
                    label: t("gridCopyAsUpdate"),
                    onSelect: () => copyRowSql(copyMenu.rowIdx, "update"),
                    disabled: !rowSqlHasPk,
                    title: rowSqlHasPk ? undefined : t("gridCopyAsSqlNoPk"),
                  },
                  {
                    label: t("gridCopyAsDelete"),
                    onSelect: () => copyRowSql(copyMenu.rowIdx, "delete"),
                    disabled: !rowSqlHasPk,
                    title: rowSqlHasPk ? undefined : t("gridCopyAsSqlNoPk"),
                  },
                ]
              : []),
            ...(() => {
              const fkMeta = columnMeta?.find(
                (m) => m.name === columns[copyMenu.colIdx]?.name,
              );
              if (!fkMeta?.referenced_table || !fkMeta.referenced_column || !onFkJump) return [];
              const driver = rowSqlDriver ?? "mysql";
              const refTable = fkMeta.referenced_table;
              const refColumn = fkMeta.referenced_column;
              const cellValue = rows[copyMenu.rowIdx]?.[copyMenu.colIdx] ?? null;
              const fromRef =
                driver === "sqlite" || !rowSqlDatabase
                  ? quoteIdentFor(driver, refTable)
                  : `${quoteIdentFor(driver, rowSqlDatabase)}.${quoteIdentFor(driver, refTable)}`;
              const predicate =
                cellValue === null || cellValue === undefined
                  ? `${quoteIdentFor(driver, refColumn)} IS NULL`
                  : `${quoteIdentFor(driver, refColumn)} = ${literalFromCellValue(driver, cellValue)}`;
              const sql = `SELECT * FROM ${fromRef} WHERE ${predicate}`;
              return [
                { separator: true as const },
                {
                  label: t("gridFkJump", { table: refTable }),
                  title: t("gridFkJumpTitle"),
                  onSelect: () => { setCopyMenu(null); onFkJump(sql); },
                },
              ];
            })(),
            { separator: true as const },
            {
              label: t("gridViewFull"),
              onSelect: () => setViewer({ rowIdx: copyMenu.rowIdx, colIdx: copyMenu.colIdx }),
            },
          ]}
        />
      )}
      {filterMenu && (
        <ColumnFilterMenu
          key={filterMenu.colIdx}
          columnName={columns[filterMenu.colIdx]?.name ?? ""}
          kind={columnKinds[filterMenu.colIdx] ?? "string"}
          anchor={filterMenu.anchor}
          value={
            table.getColumn(String(filterMenu.colIdx))?.getFilterValue() as
              | ColumnFilter
              | undefined
          }
          onChange={(next) =>
            table.getColumn(String(filterMenu.colIdx))?.setFilterValue(next)
          }
          onClose={() => setFilterMenu(null)}
        />
      )}
      {copied && (
        <Box
          role="status"
          aria-live="polite"
          position="fixed"
          bottom="48px"
          left="50%"
          transform="translateX(-50%)"
          zIndex={1100}
          padding="6px 14px"
          fontSize="sm"
          color="#ffffff"
          background="color-mix(in srgb, #16a34a 92%, #000000)"
          borderRadius="md"
          boxShadow="lg"
          pointerEvents="none"
        >
          {t("gridCopied")}
        </Box>
      )}
      <AnimatePresence>
        {viewer && (
          <CellValueViewer
            columnName={columns[viewer.colIdx]?.name ?? ""}
            value={rows[viewer.rowIdx]?.[viewer.colIdx] ?? null}
            isBinary={columnKinds[viewer.colIdx] === "binary"}
            onClose={() => setViewer(null)}
          />
        )}
      </AnimatePresence>
      {blurDialog}
    </>
  );
}

export const ResultGrid = forwardRef<ResultGridHandle, Props>(function ResultGrid({
  result,
  streaming,
  onStopStreaming,
  loadingMore,
  canLoadMore,
  onLoadMore,
  autoLimitApplied,
  onFetchAllRows,
  driver,
  database,
  table,
  editable,
  tableColumns,
  pendingEdits,
  canUndo,
  canRedo,
  onSetCellEdit,
  onClearEdits,
  onUndoEdit,
  onRedoEdit,
  onPreviewEdits,
  onApplyEdits,
  autoRefreshSecs,
  autoRefreshAllowed,
  autoRefreshLastRunAt,
  onSetAutoRefresh,
  queryError,
  onRetry,
  onFkJump,
}: Props, ref) {
  const t = useT();
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);
  const settings = useSettings();
  const paginateMode = settings.resultGridMode === "paginate";
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: settings.resultGridPageSize,
  });
  // Sync page size when the setting changes (but preserve the current page index).
  useEffect(() => {
    setPagination((p) => ({ ...p, pageSize: settings.resultGridPageSize }));
  }, [settings.resultGridPageSize]);
  // Reset to page 0 whenever new results arrive (new query run).
  const rowCount = result?.rows.length ?? 0;
  const prevRowCountRef = useRef(rowCount);
  useEffect(() => {
    const prev = prevRowCountRef.current;
    prevRowCountRef.current = rowCount;
    // A shrink (new query) resets; a grow (load more) keeps the current page.
    if (rowCount < prev) setPagination((p) => ({ ...p, pageIndex: 0 }));
  }, [rowCount]);
  const [showExport, setShowExport] = useState(false);
  const [search, setSearch] = useState("");
  // Interval the toggle will use when switched on. Seeded from the persisted
  // default and from the live cadence so the selector reflects the active poll.
  const [intervalChoice, setIntervalChoice] = useState(
    () => autoRefreshSecs ?? settings.autoRefreshDefaultSecs,
  );
  useEffect(() => {
    if (autoRefreshSecs != null) setIntervalChoice(autoRefreshSecs);
  }, [autoRefreshSecs]);
  const containerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useImperativeHandle(ref, () => ({
    focusSearch: () => {
      const el = searchInputRef.current;
      if (!el) return;
      el.focus();
      el.select();
    },
  }), []);
  // Latest callback in a ref so we don't have to re-attach the scroll
  // listener every time `onLoadMore` is rebuilt (it changes on every
  // App.tsx render because of useCallback deps).
  const onLoadMoreRef = useRef(onLoadMore);
  useEffect(() => { onLoadMoreRef.current = onLoadMore; }, [onLoadMore]);

  // Trigger another page when scrolled near the bottom. Re-runs each time
  // `canLoadMore` or `loadingMore` flips, so a completed load can be
  // immediately followed by another if the user is still pinned to the
  // end (e.g. the table fits in the viewport and natural scroll never
  // happens). Disabled in paginate mode — loading is triggered from the
  // paginator footer instead.
  useEffect(() => {
    if (paginateMode || !canLoadMore || loadingMore) return;
    const el = containerRef.current;
    if (!el) return;
    const trigger = () => {
      const remaining = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (remaining < LOAD_MORE_THRESHOLD_PX) {
        onLoadMoreRef.current?.();
      }
    };
    trigger();
    el.addEventListener("scroll", trigger, { passive: true });
    return () => el.removeEventListener("scroll", trigger);
  }, [canLoadMore, loadingMore, result?.rows.length]);

  // PK indices and per-column editability are computed once per render so
  // both the toolbar (gating Preview/Apply) and the grid agree on which
  // cells are interactive. These hooks must run before any early return so
  // the hook order stays stable as `result` transitions null → columns
  // (otherwise React aborts the whole tree on the next render).
  const columns = result?.columns;
  // Resolve the PK regardless of `editable`: a read-only table tab still wants
  // it for row→SQL generation (UPDATE/DELETE WHERE clause). Inline editing
  // stays gated on `editable` downstream, so this never makes cells editable.
  const pkIndices = useMemo(
    () => (columns ? resolvePkIndices(columns, tableColumns ?? null) : []),
    [columns, tableColumns],
  );
  const editableCols = useMemo<boolean[]>(() => {
    if (!editable || !columns) return columns ? columns.map(() => false) : [];
    const hasPk = pkIndices.length > 0;
    if (!hasPk) return columns.map(() => false);
    const pkSet = new Set(pkIndices);
    return columns.map((c, i) =>
      // Disallow editing PK columns themselves: changing a PK in-place
      // would invalidate the WHERE clause used to identify the row.
      !pkSet.has(i) && isEditableColumnType(c.type_name),
    );
  }, [editable, columns, pkIndices]);

  // Persist column widths per result shape: same database+table+column set
  // restores saved widths, a different shape falls back to defaults. The
  // column signature keeps free-form queries with distinct columns separate.
  const columnSizingStorageKey = useMemo(() => {
    if (!columns || columns.length === 0) return undefined;
    const signature = JSON.stringify(columns.map((c) => c.name));
    return `noobdb.colsizing.v1::${database ?? ""}::${table ?? ""}::${signature}`;
  }, [columns, database, table]);

  // Client-side type/NOT NULL validation of a pending edit, by result-column
  // index. Mirrors the literal-building rules in cellEdit so invalid input is
  // caught before a (wasted) Preview/Apply round-trip. `nullable` defaults to
  // true when no column metadata is available, keeping validation permissive.
  // Memoized so the per-cell checks in the grid and the `hasInvalidEdit` scan
  // below reuse one stable function instead of rebuilding it every render.
  const validateEdit = useCallback(
    (colIdx: number, value: string): I18nKey | null => {
      const col = columns?.[colIdx];
      if (!col) return null;
      const info = tableColumns?.find((c) => c.name === col.name) ?? null;
      return validateCellInput(value, col.type_name, info?.nullable ?? true);
    },
    [columns, tableColumns],
  );

  // True when any pending edit fails validation. Memoized over the edits and
  // the validator so it isn't recomputed (looping every edited cell) on each
  // render — only when the edits or validation inputs actually change.
  const hasInvalidEdit = useMemo(() => {
    if (!pendingEdits) return false;
    for (const rowKey of Object.keys(pendingEdits)) {
      const rowEdits = pendingEdits[rowKey];
      if (!rowEdits) continue;
      for (const colKey of Object.keys(rowEdits)) {
        if (validateEdit(Number(colKey), rowEdits[Number(colKey)])) return true;
      }
    }
    return false;
  }, [pendingEdits, validateEdit]);

  if (!result) {
    return (
      <Box flex="1 1 auto" minHeight={0} minWidth={0} overflow="auto" bg="app.surface">
        {t("resultEmpty")}
      </Box>
    );
  }
  if (result.columns.length === 0) {
    if (streaming) {
      return (
        <Box
          flex="1 1 auto"
          minHeight={0}
          minWidth={0}
          overflow="auto"
          bg="app.surface"
          display="flex"
          alignItems="center"
          justifyContent="center"
          gap="8px"
        >
          <Spinner />
          <chakra.span>{t("statusRunningQuery")}</chakra.span>
        </Box>
      );
    }
    return (
      <Box flex="1 1 auto" minHeight={0} minWidth={0} overflow="auto" bg="app.surface">
        {t("resultExecuted", { rows: result.rows_affected, ms: result.elapsed_ms })}
      </Box>
    );
  }
  const canExport = !streaming && result.rows.length > 0;
  // Only surface the badge when the cap was actually binding: a result that
  // came back shorter than the limit wasn't truncated, so there's nothing to
  // "fetch all" and an aggregate's single row stays quiet.
  const showAutoLimitBadge =
    !streaming &&
    autoLimitApplied != null &&
    result.rows.length >= autoLimitApplied;

  const editsCount = pendingEdits ? countEditedCells(pendingEdits) : 0;
  const editedRowCount = pendingEdits ? countEditedRows(pendingEdits) : 0;
  const hasPendingEdits = editsCount > 0;
  const editableActive = !!editable && pkIndices.length > 0;
  const autoRefreshOn = autoRefreshSecs != null && autoRefreshSecs > 0;

  // Preview wraps a single statement; multi-row edits would need a
  // multi-statement preview path that doesn't exist yet, so the button is
  // disabled (with a tooltip) until the user trims their edits to one row.
  const canPreview =
    hasPendingEdits && editedRowCount === 1 && !streaming && !hasInvalidEdit;
  const canApply = hasPendingEdits && !streaming && !hasInvalidEdit;

  return (
    <Box
      display="flex"
      flexDirection="column"
      flex="1 1 auto"
      minHeight={0}
      minWidth={0}
      overflow="hidden"
      bg="app.surface"
      position={streaming ? "relative" : undefined}
    >
      {streaming && (
        <Box
          role="status"
          aria-live="polite"
          display="flex"
          alignItems="center"
          gap="6px"
          padding="4px 10px"
          fontSize="sm"
          color="app.textMuted"
          borderBottom="1px solid"
          borderColor="app.borderSubtle"
          bg="app.surfaceMuted"
        >
          <chakra.span
            aria-hidden
            width="8px"
            height="8px"
            borderRadius="50%"
            background="#f59e0b"
            animation="streaming-pulse 1s ease-in-out infinite"
          />
          <chakra.span flex="1">
            {t("statusStreaming", { rows: result.rows.length, ms: result.elapsed_ms })}
          </chakra.span>
          {onStopStreaming && (
            <Button
              variant="warning"
              size="sm"
              px="12px"
              py="2px"
              whiteSpace="nowrap"
              onClick={onStopStreaming}
              title={t("gridStopButtonTitle")}
            >
              {t("gridStopButton")}
            </Button>
          )}
        </Box>
      )}
      {showAutoLimitBadge && (
        <Box
          role="status"
          aria-live="polite"
          display="flex"
          alignItems="center"
          gap="10px"
          padding="5px 10px"
          fontSize="sm"
          color="app.text"
          borderBottom="1px solid"
          borderColor="app.borderSubtle"
          background="color-mix(in srgb, #f59e0b 14%, var(--bg-muted))"
        >
          <chakra.span flex="1">
            {t("autoLimitApplied", { limit: autoLimitApplied! })}
          </chakra.span>
          <Button
            size="sm"
            px="10px"
            whiteSpace="nowrap"
            onClick={onFetchAllRows}
            title={t("autoLimitFetchAllTitle")}
          >
            {t("autoLimitFetchAll")}
          </Button>
        </Box>
      )}
      <Box
        display="flex"
        alignItems="center"
        gap="6px"
        padding="4px 8px"
        bg="app.toolbar"
        borderBottom="1px solid"
        borderColor="app.borderSubtle"
        flexShrink={0}
      >
        <Button
          size="sm"
          px="10px"
          onClick={() => setShowExport(true)}
          disabled={!canExport}
          title={
            canExport
              ? t("exportButtonTitle")
              : streaming
                ? t("exportDisabledStreaming")
                : t("exportDisabledNoRows")
          }
        >
          {t("exportButton")}
        </Button>
        {onSetAutoRefresh && (
          <Box
            display="inline-flex"
            alignItems="center"
            gap="6px"
            paddingLeft="2px"
            title={autoRefreshAllowed ? t("autoRefreshEnabledTitle") : t("autoRefreshDisabledTitle")}
          >
            <chakra.label
              display="inline-flex"
              alignItems="center"
              gap="4px"
              fontSize="xs"
              whiteSpace="nowrap"
              color={autoRefreshAllowed ? "app.text" : "app.textMuted"}
              cursor={autoRefreshAllowed ? "pointer" : "not-allowed"}
            >
              <chakra.input
                type="checkbox"
                checked={autoRefreshOn}
                disabled={!autoRefreshAllowed}
                aria-label={t("autoRefreshAria")}
                onChange={(e) => onSetAutoRefresh(e.target.checked ? intervalChoice : null)}
              />
              {t("autoRefreshLabel")}
            </chakra.label>
            <chakra.select
              aria-label={t("autoRefreshIntervalAria")}
              value={String(intervalChoice)}
              disabled={!autoRefreshAllowed}
              onChange={(e) => {
                const secs = Number(e.target.value);
                setIntervalChoice(secs);
                // Retarget the live timer immediately when already polling.
                if (autoRefreshOn) onSetAutoRefresh(secs);
              }}
              fontSize="xs"
              fontFamily="inherit"
              padding="2px 4px"
              border="1px solid var(--border)"
              background="var(--bg-input)"
              color="var(--text)"
              borderRadius="var(--radius-sm)"
            >
              {AUTO_REFRESH_INTERVAL_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {s % 60 === 0
                    ? t("autoRefreshIntervalMins", { mins: s / 60 })
                    : t("autoRefreshIntervalSecs", { secs: s })}
                </option>
              ))}
            </chakra.select>
            {autoRefreshOn && (
              <chakra.span fontSize="xs" color="app.textMuted" whiteSpace="nowrap">
                {streaming
                  ? t("autoRefreshRunning")
                  : autoRefreshLastRunAt
                    ? t("autoRefreshUpdatedAt", {
                        time: new Date(autoRefreshLastRunAt).toLocaleTimeString(),
                      })
                    : ""}
              </chakra.span>
            )}
          </Box>
        )}
        {editable && tableColumns && pkIndices.length === 0 && (
          <chakra.span
            fontSize="xs"
            color="app.textMuted"
            fontStyle="italic"
            paddingLeft="4px"
            title={t("editNoPkHintTitle")}
          >
            {t("editNoPkHint")}
          </chakra.span>
        )}
        {editableActive && hasPendingEdits && (
          <Box
            role="group"
            aria-label={t("editToolbarAria")}
            display="inline-flex"
            alignItems="center"
            gap="6px"
            padding="2px 8px"
            borderLeft="1px solid var(--border-subtle)"
            borderRight="1px solid var(--border-subtle)"
            background="color-mix(in srgb, var(--preview-highlight) 8%, transparent)"
          >
            <chakra.span
              fontSize="xs"
              color="var(--preview-highlight)"
              fontWeight={500}
              whiteSpace="nowrap"
            >
              {t("editPendingCount", { cells: editsCount, rows: editedRowCount })}
            </chakra.span>
            {editedRowCount > 1 && !hasInvalidEdit && (
              // #285: Preview only handles one row at a time; surface that
              // limitation explicitly so users don't assume Apply has been
              // dry-run-validated for every edited row.
              <chakra.span
                role="note"
                fontSize="xs"
                color="app.textMuted"
                fontStyle="italic"
                whiteSpace="nowrap"
                title={t("editPreviewMultiRowBannerTitle")}
              >
                {t("editPreviewMultiRowBanner")}
              </chakra.span>
            )}
            <Button
              variant="secondary"
              size="sm"
              px="6px"
              onClick={onUndoEdit}
              disabled={!canUndo}
              title={t("editUndoTitle")}
              aria-label={t("editUndoTitle")}
            >
              <Icon name="undo" />
            </Button>
            <Button
              variant="secondary"
              size="sm"
              px="6px"
              onClick={onRedoEdit}
              disabled={!canRedo}
              title={t("editRedoTitle")}
              aria-label={t("editRedoTitle")}
            >
              <Icon name="redo" />
            </Button>
            <Button
              variant="warning"
              size="sm"
              px="10px"
              onClick={onPreviewEdits}
              disabled={!canPreview}
              title={
                hasInvalidEdit
                  ? t("editApplyDisabledInvalid")
                  : editedRowCount > 1
                    ? t("editPreviewMultiRowTitle")
                    : streaming
                      ? t("editDisabledStreaming")
                      : t("editorPreviewTitle")
              }
            >
              {t("editPreviewButton")}
            </Button>
            <Button
              variant="success"
              size="sm"
              px="10px"
              onClick={onApplyEdits}
              disabled={!canApply}
              title={
                hasInvalidEdit
                  ? t("editApplyDisabledInvalid")
                  : streaming
                    ? t("editDisabledStreaming")
                    : t("editApplyButtonTitle")
              }
            >
              {t("editApplyButton")}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              px="10px"
              onClick={() => setShowDiscardConfirm(true)}
              title={t("editCancelButtonTitle")}
            >
              {t("editCancelButton")}
            </Button>
          </Box>
        )}
        <AnimatePresence>
          {showDiscardConfirm && (
            <Modal width="400px" onClose={() => setShowDiscardConfirm(false)}>
              <ModalHeader onClose={() => setShowDiscardConfirm(false)} closeLabel={t("dangerousCancel")}>
                {t("editDiscardConfirmTitle")}
              </ModalHeader>
              <ModalBody>
                {t("editDiscardConfirmBody", {
                  cells: String(countEditedCells(pendingEdits ?? {})),
                  rows: String(countEditedRows(pendingEdits ?? {})),
                })}
              </ModalBody>
              <ModalFooter>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setShowDiscardConfirm(false)}
                >
                  {t("dangerousCancel")}
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => {
                    setShowDiscardConfirm(false);
                    onClearEdits?.();
                  }}
                >
                  {t("editDiscardConfirmOk")}
                </Button>
              </ModalFooter>
            </Modal>
          )}
        </AnimatePresence>
        {!streaming && result.elapsed_ms != null && result.columns.length > 0 && (
          <chakra.span
            marginLeft="auto"
            fontSize="xs"
            color="app.textMuted"
            whiteSpace="nowrap"
            fontFamily="mono"
            aria-live="polite"
          >
            {t("resultStatusBar", { rows: result.rows.length, ms: result.elapsed_ms })}
            {autoLimitApplied != null && result.rows.length >= autoLimitApplied && (
              <chakra.span color="#f59e0b" marginLeft="6px" title={t("autoLimitApplied", { limit: autoLimitApplied })}>
                LIMIT {autoLimitApplied}
              </chakra.span>
            )}
          </chakra.span>
        )}
        <chakra.input
          ref={searchInputRef}
          type="search"
          marginLeft={!streaming && result.elapsed_ms != null && result.columns.length > 0 ? "8px" : "auto"}
          width="220px"
          padding="3px 8px"
          fontSize="sm"
          fontFamily="inherit"
          border="1px solid var(--border)"
          background="var(--bg-input)"
          color="var(--text)"
          borderRadius="var(--radius-sm)"
          _placeholder={{ color: "var(--text-muted)" }}
          _focus={{
            outline: "none",
            borderColor: "var(--accent)",
            boxShadow: "0 0 0 1px color-mix(in srgb, var(--accent) 35%, transparent)",
          }}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              setSearch("");
              containerRef.current?.focus();
            }
          }}
          placeholder={t("gridSearchPlaceholder")}
          aria-label={t("gridSearchAria")}
        />
      </Box>
      <Box
        ref={containerRef}
        tabIndex={-1}
        flex="1"
        overflow="auto"
        minHeight={0}
        _focus={{ outline: "none" }}
        css={GRID_CSS}
      >
        <DataGrid
          columns={result.columns}
          rows={result.rows}
          scrollContainerRef={containerRef}
          globalFilter={search}
          editable={editableActive}
          editableColumns={editableCols}
          pkIndices={pkIndices}
          pendingEdits={pendingEdits}
          onSetCellEdit={onSetCellEdit}
          onUndoEdit={onUndoEdit}
          onRedoEdit={onRedoEdit}
          validateEdit={validateEdit}
          rowSqlDriver={driver}
          rowSqlDatabase={database}
          rowSqlTable={table}
          columnMeta={tableColumns ?? undefined}
          onFkJump={onFkJump}
          columnSizingStorageKey={columnSizingStorageKey}
          skeleton={!!streaming}
          paginationState={paginateMode ? pagination : undefined}
          onPaginationChange={paginateMode ? setPagination : undefined}
          emptyMessage={
            streaming ? undefined : queryError ? (
              <EmptyState
                compact
                icon="warning"
                title={t("gridQueryError")}
                description={queryError}
                action={onRetry ? { label: t("gridRetry"), onClick: onRetry } : undefined}
              />
            ) : (
              <EmptyState
                compact
                icon="table"
                title={t("gridZeroRows")}
                description={t("gridZeroRowsHint", { ms: result.elapsed_ms })}
              />
            )
          }
        />
        {!paginateMode && loadingMore && (
          <Box
            role="status"
            aria-live="polite"
            position="sticky"
            bottom={0}
            display="flex"
            alignItems="center"
            justifyContent="center"
            gap="6px"
            padding="6px 10px"
            fontSize="sm"
            color="app.textMuted"
            borderTop="1px solid"
            borderColor="app.borderSubtle"
            bg="app.surfaceMuted"
          >
            <Spinner size={14} />
            {t("gridLoadingMore")}
          </Box>
        )}
        {paginateMode && (() => {
          const totalLoaded = result.rows.length;
          const { pageIndex, pageSize } = pagination;
          const pageCount = Math.max(1, Math.ceil(totalLoaded / pageSize));
          const from = pageIndex * pageSize + 1;
          const to = Math.min((pageIndex + 1) * pageSize, totalLoaded);
          const isFirst = pageIndex === 0;
          const isLast = pageIndex >= pageCount - 1;
          const navButton = (
            label: string,
            title: string,
            disabled: boolean,
            onClick: () => void,
          ) => (
            <chakra.button
              aria-label={title}
              title={title}
              disabled={disabled}
              onClick={onClick}
              fontSize="xs"
              px="6px"
              py="2px"
              border="1px solid var(--border)"
              borderRadius="var(--radius-sm)"
              background={disabled ? "transparent" : "var(--bg-input)"}
              color={disabled ? "var(--text-muted)" : "var(--text)"}
              cursor={disabled ? "not-allowed" : "pointer"}
              _hover={disabled ? {} : { background: "var(--bg-muted)" }}
              whiteSpace="nowrap"
              lineHeight={1.4}
            >
              {label}
            </chakra.button>
          );
          const handleNext = () => {
            if (isLast && canLoadMore && !loadingMore) onLoadMore?.();
            if (!isLast) setPagination((p) => ({ ...p, pageIndex: p.pageIndex + 1 }));
          };
          return (
            <Box
              role="navigation"
              aria-label="pagination"
              display="flex"
              alignItems="center"
              flexWrap="wrap"
              gap="6px"
              px="10px"
              py="5px"
              fontSize="xs"
              color="app.textMuted"
              borderTop="1px solid"
              borderColor="app.borderSubtle"
              bg="app.toolbar"
              flexShrink={0}
            >
              {navButton("«", t("paginationFirst"), isFirst, () =>
                setPagination((p) => ({ ...p, pageIndex: 0 }))
              )}
              {navButton("‹", t("paginationPrev"), isFirst, () =>
                setPagination((p) => ({ ...p, pageIndex: p.pageIndex - 1 }))
              )}
              <chakra.span color="app.text" whiteSpace="nowrap">
                {t("paginationPage", { page: pageIndex + 1, pages: pageCount })}
              </chakra.span>
              {navButton("›", t("paginationNext"), isLast && !canLoadMore, handleNext)}
              {navButton("»", t("paginationLast"), isLast && !canLoadMore, () =>
                setPagination((p) => ({ ...p, pageIndex: pageCount - 1 }))
              )}
              <chakra.span whiteSpace="nowrap">
                {totalLoaded > 0
                  ? t("paginationRows", { from, to, total: totalLoaded })
                  : ""}
              </chakra.span>
              {loadingMore && (
                <Box display="flex" alignItems="center" gap="4px">
                  <Spinner size={12} />
                  <chakra.span>{t("paginationLoadingMore")}</chakra.span>
                </Box>
              )}
              {!loadingMore && isLast && canLoadMore && (
                <chakra.span color="app.textMuted" fontStyle="italic">
                  {t("paginationCanLoadMore")}
                </chakra.span>
              )}
              <chakra.span marginLeft="auto" display="flex" alignItems="center" gap="4px" whiteSpace="nowrap">
                {t("paginationRowsPerPage")}
                <chakra.select
                  aria-label={t("paginationRowsPerPage")}
                  value={String(pageSize)}
                  onChange={(e) => {
                    const newSize = Number(e.target.value);
                    setPagination({ pageIndex: 0, pageSize: newSize });
                  }}
                  fontSize="xs"
                  fontFamily="inherit"
                  padding="1px 4px"
                  border="1px solid var(--border)"
                  background="var(--bg-input)"
                  color="var(--text)"
                  borderRadius="var(--radius-sm)"
                >
                  {RESULT_GRID_PAGE_SIZE_OPTIONS.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </chakra.select>
              </chakra.span>
            </Box>
          );
        })()}
      </Box>
      <AnimatePresence>
        {showExport && (
          <ExportModal
            columns={result.columns}
            rows={result.rows}
            database={database ?? null}
            table={table ?? null}
            partial={showAutoLimitBadge || !!canLoadMore}
            onClose={() => setShowExport(false)}
          />
        )}
      </AnimatePresence>
    </Box>
  );
});
