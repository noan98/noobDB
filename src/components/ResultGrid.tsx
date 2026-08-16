import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { transitions, variants } from "../motion";
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
  type VisibilityState,
} from "@tanstack/react-table";
import { CellValue, Column, QueryResult, TableColumnInfo, TableRowIdentity } from "../api/tauri";
import { useLocale, useT, type I18nKey } from "../i18n";
import { DEFAULT_SHORTCUT_COMBOS } from "../shortcuts";
import { comboMatchesEvent, formatCombo } from "../shortcutKeys";
import { enumBadgeHue, formatDateTimeDisplay, formatJsonCompact, rawValueTitle } from "./cellFormat";
import {
  AUTO_REFRESH_INTERVAL_OPTIONS,
  RESULT_GRID_PAGE_SIZE_OPTIONS,
  useSettings,
  type Density,
} from "../settings";
import { CellValueViewer } from "./CellValueViewer";
import { RowInspector } from "./RowInspector";
import { copyToClipboard } from "./clipboard";
import { useConfirm } from "./ConfirmDialog";
import { ContextMenu } from "./ContextMenu";
import { EmptyState } from "./EmptyState";
import { NoResultsIllustration, errorIllustration } from "./illustrations";
import { Icon, ICON_SIZES } from "./Icon";
import {
  type CellKind,
  CELL_KIND_META,
  classifyEmptyValue,
  classifyTypeName,
  EMPTY_BADGE,
  resolveBoolTruthy,
  truncateHexPreview,
} from "./cellTypeMeta";
import {
  type CondFormatMode,
  type NumericStats,
  toNumber,
  computeNumericStats,
  normalize,
  dataBarPercent,
  heatmapColor,
  HEAT_PALETTES,
  DEFAULT_HEAT_PALETTE,
} from "./cellConditionalFormat";
import { accentFill, ACCENT_FILL_STOPS, readableInk } from "../colorScale";
import { CountUp } from "./CountUp";
import { COUNT_UP_TOKEN, splitAroundCountUpToken } from "../useCountUp";
import { ExportModal, type FullExportContext } from "./ExportModal";
import { ResultViewSwitch, type ResultViewKind } from "./ResultViewSwitch";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { Spinner } from "./Spinner";
import { Skeleton, shimmerAfterCss, shimmerContainerCss } from "./Skeleton";
import { deriveQueryPhase, formatElapsed } from "../queryRunState";
import { useToast } from "./Toast";
import { Button } from "./ui";
import { LoadingButton } from "./LoadingButton";
import { Tooltip, TooltipBubble, useDelegatedTooltip } from "./Tooltip";
import {
  buildInsertClipboard,
  buildRowSql,
  countEditedCells,
  countEditedRows,
  editIsNoop,
  hasAmbiguousIdentity,
  isEditableColumnType,
  resolveRowIdentity,
  rowEditKey,
  validateCellInput,
  type PendingEdits,
  type PendingInsertRow,
  type RowIdentityKind,
  type RowSqlKind,
} from "./cellEdit";
import { planBulkCellEdit, type BulkEditTarget } from "./bulkEdit";
import { parseClipboardGrid, planPasteEdit } from "./pasteEdit";
import { quickSetOptions, resolveDynamicValue } from "./quickSetValues";
import {
  clientQuickFilter,
  isNullCell,
  quickFilterValueLabel,
  serverQuickFilter,
  type QuickFilterMode,
} from "./quickFilter";
import type { ServerFilter, ServerFilterOp, ServerSort, ServerSortDirection } from "./serverBrowse";
import { diffResultRows } from "../resultDiff";
import {
  buildFkJumpSql,
  buildReverseRefSql,
  type IncomingFk,
} from "../fkNavigation";
import {
  type SelectionSummary,
  type ColumnStats,
  type FullColumnStats,
  type FullStatsRequest,
  selectionSummary as computeSelectionSummary,
  columnStats as computeColumnStats,
  buildColumnStatsSql,
  parseFullColumnStats,
  isNumericStatsKind,
  columnNullRates,
  nullRatePercentOf,
} from "./gridStats";
import {
  type GridFindMatch,
  type GridFindResult,
  EMPTY_FIND_RESULT,
  buildFindKeySet,
  computeFindMatches,
  findMatchKey,
  nextMatchIndex,
  stableMatchIndex,
} from "./gridFind";
import {
  type FooterAggFn,
  type PersistedFooterState,
  availableFooterFns,
  computeFooterCell,
  defaultFooterFn,
  footerStateKeyFrom,
  readStoredFooterState,
  resolveFooterFn,
  writeStoredFooterState,
} from "./gridFooter";
import {
  gridViewStateKeyFrom,
  readStoredGridView,
  toPersistedGridView,
  writeStoredGridView,
} from "./gridViewState";

/**
 * 結果テーブル (TanStack グリッド) のセル/ヘッダ単位のスタイル。
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
/** Per-density seed height (px) for the virtualizer's first paint. The
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
    // 内包するため、フォント拡大時に窮屈にならず、かつ表示密度の切り替え
    // (Compact / Normal / Spacious) で行高さ・余白を統合的に調整できる。
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
  // 型アイコン + 名前を横並びにする行。
  "& th .th-label-row": {
    display: "inline-flex",
    alignItems: "center",
    gap: "1",
    minWidth: 0,
  },
  "& th .th-type-icon": {
    display: "inline-flex",
    alignItems: "center",
    color: "var(--text-muted)",
    flexShrink: 0,
  },
  "& th .th-name": {
    fontWeight: 600,
    color: "var(--text)",
    letterSpacing: "0.01em",
    overflow: "hidden",
    textOverflow: "ellipsis",
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
    // 字間は overline ラベルの単一トークン (#817) に揃える。色はアクセント色の
    // ままにしたいので `textStyle` は使わず値だけ共有する。
    letterSpacing: "var(--tracking-wider)",
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
  // 矩形範囲選択。アクセント色の薄い塗りで選択範囲を示す。アクティブセルの
  // フォーカスリングはそのまま重ねて表示される。ストライプ/ホバーより優先する。
  "& tbody td.is-selected-cell, & tbody tr.grid-row-stripe td.is-selected-cell, & tbody tr:hover td.is-selected-cell": {
    background: "color-mix(in srgb, var(--accent) 22%, var(--bg))",
  },
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
  // 編集がある」ことを行レベルで示す。個々のセルの is-pending-edit ハイライト
  // (列方向) と合わせ、行・セルの両軸で保留編集を把握できるようにする。
  "& tbody tr.grid-row-pending td.row-index": {
    boxShadow: "inset 3px 0 0 var(--preview-highlight)",
    color: "var(--preview-highlight)",
    fontWeight: 600,
  },
  // 削除予定の行: 取り消し線 + 危険色の淡い背景で「Apply で DELETE される」
  // ことを行レベルで示す。
  "& tbody tr.grid-row-deleting td": {
    textDecoration: "line-through",
    color: "var(--text-muted)",
    background: "color-mix(in srgb, var(--error-solid) 12%, transparent)",
  },
  "& tbody tr.grid-row-deleting td.row-index": {
    boxShadow: "inset 3px 0 0 var(--error-solid)",
  },
  "& th.col-filler, & td.col-filler": {
    padding: 0,
    borderRight: "none",
    background: "var(--bg-elevated)",
  },
  "& tbody tr.grid-row-stripe td.col-filler": { background: "var(--bg-elevated)" },
  "& tbody tr:hover td.col-filler": { background: "var(--bg-elevated)" },
  // NULL と空文字列を淡いピル型バッジで描き分ける。NULL は --text-null カラー、
  // 空文字列は --text-muted カラーで区別できる。色はトークン参照なので
  // ライト/ダーク両テーマで一貫する。
  "& .cell-null": {
    display: "inline-block",
    padding: "0 5px",
    fontSize: "var(--text-2xs)",
    fontWeight: 600,
    fontStyle: "normal",
    lineHeight: 1.5,
    letterSpacing: "var(--tracking-wider)",
    color: "var(--text-null)",
    background: "color-mix(in srgb, var(--text-null) 14%, transparent)",
    border: "1px solid color-mix(in srgb, var(--text-null) 38%, transparent)",
    borderRadius: "var(--radius-sm)",
  },
  "& td.is-null": { backgroundImage: "linear-gradient(transparent, transparent)" },
  // 空文字 / 空配列 / 空オブジェクトの淡色バッジ。NULL とは別トーンにして、
  // 「NULL ではないが空」であることを区別できるようにする。
  "& .cell-empty": {
    display: "inline-block",
    padding: "0 5px",
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-2xs)",
    fontWeight: 600,
    lineHeight: 1.5,
    letterSpacing: "var(--tracking-wider)",
    color: "var(--text-muted)",
    background: "color-mix(in srgb, var(--text-muted) 10%, transparent)",
    border: "1px dashed color-mix(in srgb, var(--text-muted) 36%, transparent)",
    borderRadius: "var(--radius-sm)",
  },
  "& .cell-number, & .cell-decimal": {
    color: "var(--cell-number)",
    fontVariantNumeric: "tabular-nums",
  },
  // 条件付き書式: データバー / ヒートマップの背景レイヤ。値テキストは前面。
  "& .cell-cf-wrap": {
    position: "relative",
    display: "block",
    width: "100%",
    borderRadius: "var(--radius-sm)",
    overflow: "hidden",
  },
  // データバーは幅を transform (scaleX) で表現する。width の補間はレイアウト/
  // ペイントを毎フレーム誘発するため、数値列の全セルが一斉に動くソート/再取得時に
  // 重くなる。scaleX なら GPU 合成のみで済む (値は利用側が inline style で渡す)。
  // 塗り色は `colorScale.ts` の `accentFill`/`ACCENT_FILL_STOPS` (#718) を参照し、
  // NULL 率ミニバーと同じ生成レシピ・不透明度段階を共有する (二重定義しない)。
  "& .cell-databar": {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    width: "100%",
    transformOrigin: "left center",
    background: accentFill(ACCENT_FILL_STOPS.dataBar),
    borderRadius: "var(--radius-sm)",
    transitionProperty: "transform",
    transitionDuration: "var(--dur-med)",
    transitionTimingFunction: "var(--ease-out)",
  },
  "& .cell-cf-value": { position: "relative" },
  "& .cell-bool": { fontWeight: 600 },
  "& .cell-bool.is-true": { color: "var(--cell-bool-true)" },
  "& .cell-bool.is-false": { color: "var(--cell-bool-false)" },
  // リッチ表示時の真偽値はピル型バッジで on/off を一目で示す。色は既存の
  // --cell-bool-* トークン参照なのでライト/ダーク両テーマで一貫する。
  "& .cell-bool.cell-bool-badge": {
    display: "inline-block",
    padding: "0 6px",
    fontSize: "var(--text-2xs)",
    lineHeight: 1.5,
    letterSpacing: "var(--tracking-wider)",
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
  // 列挙値 (ENUM/SET) の色分けバッジ。色相はセルごとに --enum-hue で渡され、
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
  // バイナリだと気付きにくいので、ピル型タグで明示する。
  "& .cell-binary-tag": {
    display: "inline-block",
    marginRight: "1.5",
    padding: "0 5px",
    fontSize: "var(--text-2xs)",
    fontWeight: 600,
    fontStyle: "normal",
    letterSpacing: "var(--tracking-wider)",
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
    gap: "1.5",
    flex: "1 1 auto",
    minWidth: 0,
    // ソート可能ヘッダのボタン余白もセルと同じ密度トークンに揃える。
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
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    color: "var(--accent)",
    width: "13px",
    flexShrink: 0,
    lineHeight: 1,
  },
  // 未ソート列の ↕ ヒントはホバー時のみ表示する。常時表示だと全列に並んで
  // ヘッダがごちゃつくため (幅は確保したままなのでホバー時のレイアウトシフトは無い)。
  "& th.is-sortable:not(.is-sorted-asc):not(.is-sorted-desc) .th-sort-indicator::before": {
    content: '"↕"',
    color: "var(--text-muted)",
    opacity: 0,
  },
  "& th.is-sortable:not(.is-sorted-asc):not(.is-sorted-desc):hover .th-sort-indicator::before": {
    opacity: 0.85,
  },
  // 多列ソートの優先順位バッジ。方向アイコンの右に小さな順位番号を出す。
  "& th .th-sort-rank": {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    minWidth: "14px",
    height: "14px",
    marginLeft: "0.5",
    padding: "0 3px",
    fontSize: "9px",
    fontWeight: 700,
    lineHeight: 1,
    color: "var(--bg)",
    background: "var(--accent)",
    borderRadius: "7px",
  },
  // 列ヘッダのフィルタアイコン。クリックで条件ポップアップ (ColumnFilterMenu) を開く。
  // 常時表示だと全列にアイコンと区切り線が並んでヘッダがごちゃつくため、ドラッグ
  // グリップと同様にホバー/キーボードフォーカス時のみ現す (幅は確保したままなので
  // 出現時のレイアウトシフトは無い)。フィルタ設定中の列とポップアップ表示中は
  // 見失わないよう常時表示する。
  "& th .th-filter-button": {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    padding: "0 7px",
    marginRight: "1",
    background: "transparent",
    border: "none",
    color: "var(--text-muted)",
    cursor: "pointer",
    opacity: 0,
    transition:
      "color var(--dur-fast) var(--ease), background var(--dur-fast) var(--ease), opacity var(--dur-fast) var(--ease)",
  },
  '& th:hover .th-filter-button, & th .th-filter-button:focus-visible, & th .th-filter-button[aria-expanded="true"]':
    { opacity: 1 },
  "& th .th-filter-button:hover": { background: "var(--bg-hover)", color: "var(--text)" },
  // フィルタが設定されている列はアイコンとヘッダ全体をアクセント色で強調する。
  "& th .th-filter-button.is-active": { color: "var(--accent)", opacity: 1 },
  "& th.is-filtered-col": {
    background: "color-mix(in srgb, var(--accent) 14%, var(--bg-header))",
  },
  "& th.is-filtered-col .th-name": { color: "var(--accent)" },
  // 列の並び替えグリップ。ホバーで現れ、ドラッグで列順を入れ替える。
  "& th .th-drag-grip": {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    width: "16px",
    cursor: "grab",
    color: "var(--text-muted)",
    opacity: 0,
    transition: "opacity var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease)",
  },
  "& th:hover .th-drag-grip, & th.is-dragging-col .th-drag-grip": { opacity: 0.7 },
  "& th .th-drag-grip:hover": { color: "var(--text)", opacity: 1 },
  "& th .th-drag-grip:active": { cursor: "grabbing" },
  "& th.is-dragging-col": { opacity: 0.5 },
  // ドロップ先候補のヘッダを左端のアクセント線とごく薄い塗りで示す。
  "& th.is-drag-over": {
    boxShadow: "inset 2px 0 0 0 var(--accent)",
    background: "color-mix(in srgb, var(--accent) 12%, var(--bg-header))",
  },
  // ピン留め列は sticky で固定する。背景を不透明にして横スクロール時に
  // 下を流れる列を隠し、ストライプ/ホバーの行背景にも追従させる。
  "& th.is-pinned": { background: "var(--bg-header)" },
  "& td.is-pinned": { background: "var(--bg)" },
  "& tbody tr.grid-row-stripe td.is-pinned": { background: "var(--bg-stripe)" },
  "& tbody tr:hover td.is-pinned": { background: "var(--bg-row-hover)" },
  // 固定列とスクロール列の境界に影を出してピン状態を視覚的に示す。
  "& th.is-pinned-left, & td.is-pinned-left": {
    boxShadow: "2px 0 4px -2px color-mix(in srgb, var(--text) 30%, transparent)",
  },
  "& th.is-pinned-right, & td.is-pinned-right": {
    boxShadow: "-2px 0 4px -2px color-mix(in srgb, var(--text) 30%, transparent)",
  },
  // 集計フッター行 (#645)。縦スクロールで最下部にスティッキーし (bottom:0)、
  // 横スクロールはテーブル幅共有で自動追従する。ヘッダ (sticky top) の反転。
  "& tfoot td.grid-footer-cell": {
    position: "sticky",
    bottom: 0,
    zIndex: 2,
    background: "var(--bg-header)",
    borderTop: "1px solid var(--border-strong)",
    color: "var(--text)",
    fontSize: "var(--text-xs)",
    whiteSpace: "nowrap",
  },
  // 行番号セルは左端固定 (sticky left) と最下部固定を両立させ、最前面へ。
  "& tfoot td.grid-footer-cell.row-index": { zIndex: 5, background: "var(--bg-header)" },
  // ピン留め列のフッターは横スクロール時に他フッターセルより前面へ。背景は
  // ヘッダ同色にして下を流れる列を隠す。左右の境界影は既存 is-pinned-* を共有。
  "& tfoot td.grid-footer-cell.is-pinned": { zIndex: 4, background: "var(--bg-header)" },
  "& tfoot td.grid-footer-cell.col-filler": { background: "var(--bg-elevated)" },
  // ラベル (左・淡色) と値 (右・等幅数字) を両端に配置する。
  "& tfoot .grid-footer-inner": {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: "var(--space-2, 8px)",
  },
  "& tfoot .grid-footer-fn": { textStyle: "overline" },
  "& tfoot .grid-footer-val": { fontVariantNumeric: "tabular-nums", fontWeight: 600 },
  "& td.grid-empty-cell": {
    padding: "3.5",
    color: "var(--text-muted)",
    fontStyle: "italic",
    textAlign: "center",
    whiteSpace: "normal",
  },
  "& tbody tr.grid-skeleton-row": { pointerEvents: "none" },
  // スケルトンセル。土台とシマー帯は Skeleton.tsx の共有定義
  // (shimmerContainerCss / shimmerAfterCss) を使い、帯幅・色・周期の
  // 修正漏れを防ぐ (#719)。多数セルの同時再ペイントを避けるため疑似要素の
  // transform スライドで動かし、スタッガの animationDelay は inline style
  // から疑似要素へ inherit で引き継ぐ。
  "& td.grid-skeleton-cell > div": {
    ...shimmerContainerCss,
    height: "10px",
    borderRadius: "2px",
  },
  "& td.grid-skeleton-cell > div::after": shimmerAfterCss,
  "& .grid-filter-summary": {
    position: "sticky",
    top: 0,
    zIndex: 4,
    display: "flex",
    alignItems: "center",
    gap: "2.5",
    py: "1",
    px: "2.5",
    fontSize: "var(--text-xs)",
    color: "var(--text-secondary)",
    background: "color-mix(in srgb, var(--accent) 10%, var(--bg-muted))",
    borderBottom: "1px solid var(--border)",
  },
  "& .grid-filter-clear": {
    py: "0.5",
    px: "2",
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
  // 列ヘッダ下端の常時 NULL 率ミニバー (#911)。ヘッダの**高さを変えない**よう
  // 絶対配置で下端に重ねる — こうすると密度設定 (Compact/Normal/Spacious) や
  // フォント拡大でヘッダ高さが変わっても、バーの有無で列間の整列が崩れない。
  // 目盛りとしての「地」を薄く敷き、NULL が 0 件の列でもバーの存在 (= 計測済み)
  // が分かるようにする。リサイズハンドル (zIndex 3) の方が手前に来るので、
  // 右端のドラッグ操作は妨げない。
  "& thead th .th-nullbar": {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: "3px",
    background: "color-mix(in srgb, var(--text-muted) 12%, transparent)",
    zIndex: 2,
  },
  // 塗りは `.cell-databar` / 列統計ポップオーバーの NULL 率バーと同じ
  // `accentFill(ACCENT_FILL_STOPS.nullRate)` (#718) を共有する。幅ではなく
  // scaleX で表現するのもデータバーと同じ理由 (レイアウトを誘発しない)。
  "& thead th .th-nullbar-fill": {
    height: "100%",
    width: "100%",
    transformOrigin: "left center",
    background: accentFill(ACCENT_FILL_STOPS.nullRate),
    transitionProperty: "transform",
    transitionDuration: "var(--dur-med)",
    transitionTimingFunction: "var(--ease-out)",
  },
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
  // 再実行差分の追加行 (#597, ResultGrid のみ)。変更セルは上の is-changed (黄) を
  // 流用し、追加行は緑で示す (削除行は今回結果に無いためツールバーの件数で示す)。
  // 緑は色覚に配慮しつつ「追加=増加」の直感に沿う。reduced-motion 時も色は残る。
  "& tbody tr.grid-row-added td.row-index": {
    boxShadow: "inset 3px 0 0 var(--status-success)",
  },
  "& tbody tr.grid-row-added td": {
    background: "color-mix(in srgb, var(--status-success) 12%, transparent)",
  },
  "& tbody tr.grid-row-added.grid-row-stripe td": {
    background: "color-mix(in srgb, var(--status-success) 16%, transparent)",
  },
  "& tbody tr.grid-row-added:hover td": {
    background: "color-mix(in srgb, var(--status-success) 20%, transparent)",
  },
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
  // ── セル状態の視覚言語 (4 段階の優先順位) ──
  // 1. selection (キーボード選択) … is-active-cell: アクセントの inset リング
  // 2. focus/editing (フォーカス内/編集中) … focus-within: 同じく inset リング
  //    + 編集入力 (cell-edit-input) に共有フォーカスリングトークン
  // 3. pending edit (未適用の編集) … is-pending-edit: 左端のアクセントバー + 淡塗り
  // 4. invalid (検証エラー) … is-invalid-edit: 左端の危険色バー + 危険色リング
  // いずれも --focus-ring / --focus-ring-inset / --accent / --error トークンを参照し、
  // ライト/ダーク両テーマで一貫する。
  //
  // グリッドセルのアクティブ/選択リングはすべて inset に統一している。
  //   - 外側 outline だと隣接セルのリングが重なり合い、矩形選択範囲の輪郭が読みづらい。
  //   - inset box-shadow はセル境界内に収まるため、選択範囲の輪郭が明確になる。
  //   - is-pending-edit / is-changed / is-invalid-edit も box-shadow (inset バー) を
  //     使っているが、方向 (左端バー vs 全周リング) が異なり視覚的に区別できる。
  //     ただし box-shadow は別ルール間では合成されず特異性の高い方が上書きするため、
  //     is-pending-edit + アクティブ/フォーカスの組み合わせには専用セレクタで
  //     バーとリングをカンマ区切りで明示的に重ねる (下記)。
  "& tbody td:not(.row-index):not(.col-filler):not(.grid-empty-cell)": {
    cursor: "default",
  },
  "& td.is-editable-cell": { cursor: "text" },
  "& tbody tr td.is-editable-cell:hover": {
    outline: "1px solid color-mix(in srgb, var(--accent) 45%, transparent)",
    outlineOffset: "-1px",
  },
  // 編集中 (アクティブ) のセルははっきりした inset リングで強調し、
  // どのセルを編集しているかを把握しやすくする (inset で隣接セルと重ならない)。
  "& td.is-editable-cell:focus-within": {
    outline: "none",
    boxShadow: "var(--focus-ring-inset)",
  },
  // キーボードナビゲーションで選択中のセル (編集モードでない場合のみ表示)
  // inset リングで描くことで隣接セルのリングが重ならず、選択範囲の輪郭が明確。
  "& td.is-active-cell:not(:focus-within)": {
    outline: "none",
    boxShadow: "var(--focus-ring-inset)",
  },
  // pending edit のセルがアクティブ/フォーカス中のとき: 上記リングが is-pending-edit の
  // 左端バーを上書きしてしまうため、専用セレクタでバー + リングを明示的に重ねる。
  "& td.is-pending-edit.is-editable-cell:focus-within": {
    boxShadow: "inset 2px 0 0 var(--preview-highlight), var(--focus-ring-inset)",
  },
  "& td.is-pending-edit.is-active-cell:not(:focus-within)": {
    boxShadow: "inset 2px 0 0 var(--preview-highlight), var(--focus-ring-inset)",
  },
  // 矩形範囲選択の各セルにも inset リングを付与し、選択範囲の輪郭を強調する。
  // アクティブセルと区別するため透明度を下げ (--focus-ring-inset より淡い)、
  // 「選択されているが現在のカーソル位置ではない」状態を視覚的に分離する。
  "& tbody td.is-selected-cell:not(.is-active-cell)": {
    boxShadow:
      "inset 0 0 0 var(--focus-ring-width, 2px) color-mix(in srgb, var(--accent) 45%, transparent)",
  },
  "& td.is-invalid-edit": { boxShadow: "inset 2px 0 0 var(--status-error)" },
  "& td.is-invalid-edit.is-pending-edit": {
    background: "color-mix(in srgb, var(--status-error) 12%, transparent)",
  },
  // アクティブセルが invalid-edit のとき: 左端エラーバー + inset エラーリングを重ねる。
  "& td.is-invalid-edit.is-active-cell:not(:focus-within)": {
    boxShadow:
      "inset 2px 0 0 var(--status-error), inset 0 0 0 var(--focus-ring-width, 2px) color-mix(in srgb, var(--status-error) 55%, transparent)",
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
    boxShadow: "var(--focus-ring)",
  },
  "& .cell-edit-input.is-invalid": {
    borderColor: "var(--error-solid)",
    boxShadow: "var(--focus-ring-danger)",
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
  // Apply 成功時の一時的な成功フラッシュ。App.css の @keyframes apply-flash と
  // セットで動作する。is-apply-flash クラスは ResultGrid の useEffect で付与/除去される。
  "&.is-apply-flash": {
    animation: "apply-flash 0.7s ease-out",
  },
  // 結果内検索 (Find in Results, #644) のヒットハイライト。行を隠す列フィルタと
  // 違い「読みながら探す」機能なので、選択 (アクセント色) と区別できる警告色系の
  // 塗りにする。ストライプ/ホバーの行背景より優先する。
  "& tbody td.is-find-hit, & tbody tr.grid-row-stripe td.is-find-hit, & tbody tr:hover td.is-find-hit":
    {
      background: "color-mix(in srgb, var(--status-warning) 22%, var(--bg))",
    },
  // 現在ヒット: 濃い塗り + inset リング。ジャンプ時は App.css の
  // @keyframes find-current-pulse で一瞬リングを太らせて着地を示す
  // (reduced-motion では App.css 末尾のメディアクエリで静止化)。
  "& tbody td.is-find-current, & tbody tr.grid-row-stripe td.is-find-current, & tbody tr:hover td.is-find-current":
    {
      background: "color-mix(in srgb, var(--status-warning) 38%, var(--bg))",
      boxShadow: "inset 0 0 0 2px var(--status-warning)",
      animation: "find-current-pulse 0.45s var(--ease-out)",
    },
};

/**
 * グリッド系ショートカット (#681) の解決済みバインド。`shortcutBindings` (App)
 * から必要なキーだけ抜き出して渡す。省略されたキーは
 * `DEFAULT_SHORTCUT_COMBOS` の既定値へフォールバックする。
 */
export interface GridBindings {
  gridCopy: string;
  gridCopyHeaders: string;
  gridInspector: string;
  gridUndo: string;
  gridRedo: string;
  /** ページ送り/戻し (#681)。Alt+←/→ の既定を App 側のページングへ正確に譲るための
   *  参照専用バインド — DataGrid 自身はこのキーで何もしない (App の window
   *  ハンドラが処理する)。 */
  gridPageNext: string;
  gridPagePrev: string;
}

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
  /**
   * Set when the last run stopped before finishing (user cancel or query
   * timeout) instead of completing normally, so `result` holds only a
   * partial result. Drives a status-bar badge and the export-confirmation
   * warning (#685). Cleared by the caller on the next run.
   */
  partialResult?: { reason: "cancelled" | "timeout"; rows: number } | null;
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
  /**
   * Row identity fallback for inline editing when the table has no primary
   * key (#849): rowid/ctid pseudo-column or all-columns matching. `null`
   * when a PK resolved (the common case) or hasn't been checked. Combined
   * with `tableColumns` via `resolveRowIdentity` to gate/build edits.
   */
  rowIdentity?: TableRowIdentity | null;
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
  /** True while the Apply transaction is in flight — shows an inline spinner. */
  applyingEdits?: boolean;
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
  /**
   * Foreign keys pointing at the current table (reverse references). Forwarded
   * to the grid so the right-click menu can offer "show referencing rows".
   */
  incomingFks?: IncomingFk[];
  /** 削除予定の行: rowEditKey の集合。 */
  pendingDeleteKeys?: Set<string>;
  /** 行を削除予定にトグルする。 */
  onToggleRowDelete?: (rowKey: string) => void;
  /** 新規行追加を要求する。 */
  onRequestInsertRow?: () => void;
  /**
   * 選択行を種に行追加モーダルを開く (行の複製、#820)。渡す値は列インデックスを
   * キーにした `PendingInsertRow` — `RowInsertModal` の `initialValues` にそのまま
   * 渡せる。未指定ならメニュー項目を出さない。
   */
  onDuplicateRow?: (row: PendingInsertRow) => void;
  /**
   * Apply a single value (or NULL) to every cell of the current rectangular
   * selection in one batch (#596). Set by App for editable table tabs.
   */
  onBulkEdit?: (edits: BulkEditTarget[]) => void;
  /**
   * 結果差分ハイライト (#597) のための前回結果の行スナップショット。同一クエリの
   * 再実行のときだけ App が前回結果を渡す。null なら差分なし。
   */
  diffPrevRows?: CellValue[][] | null;
  /**
   * 前回スナップショットと今回の結果が同一クエリ由来で比較可能か。App が
   * 「前回 SQL === 今回 SQL」を判定して渡す。false なら差分を出さず通常描画。
   */
  diffComparable?: boolean;
  /** 差分ハイライトのトグル状態 (ON/OFF)。 */
  diffHighlightEnabled?: boolean;
  /** 差分ハイライトのトグル切替。未指定ならトグル UI を出さない。 */
  onToggleDiffHighlight?: () => void;
  /**
   * 結果パネルの表示 (グリッド / ピボット / チャート) を切り替える。未指定なら
   * ツールバーに切替セグメントを出さない。ピボット/チャート側の同じセグメントと
   * 対になっていて、行が無い / ストリーミング中は Export と同じ条件で隠す。
   */
  onChangeView?: (view: ResultViewKind) => void;
  /**
   * 実行結果を新規テーブルへ保存 (CREATE TABLE ... AS SELECT、#821)。App が
   * セッション・対象クエリ・データベースを確定させたときだけ渡す — 読み取り専用
   * セッション、対象クエリが単一の SELECT/WITH でない、データベース文脈が無いなど
   * の理由で保存できないときは未指定になり、Export と同じくボタンは disabled
   * (ツールチップで理由を示す) のまま出る。
   */
  onSaveAsTable?: () => void;
  /**
   * 実行結果をビューへ保存 (「現在のクエリをビューとして保存」、#851)。App が
   * セッション・対象クエリ・データベースを確定させたときだけ渡す —
   * `onSaveAsTable` と同じ表示条件 (単一 SELECT/WITH・読み取り専用でない・
   * データベース文脈がある) で、未指定のときは disabled のまま出る。
   */
  onSaveAsView?: () => void;
  /**
   * 結果セットをローカル横断クエリエンジンへ「ローカルテーブルとして登録」する
   * (#740)。App がセッション種別・在メモリ行を確定させたときだけ渡す — 表示条件
   * (canExport/streaming) は Export・`onSaveAsTable` と揃える。
   */
  onRegisterLocalTable?: () => void;
  /**
   * 全件ストリーミングエクスポートのコンテキスト。提供されると ExportModal に
   * 「全件 (再実行)」モードが現れる。
   */
  fullExport?: FullExportContext;
  /**
   * Wall-clock timestamp (ms) set by the parent each time an Apply edit
   * succeeds. `ResultGrid` uses changes to this value to play a brief
   * success-flash animation on the grid container.
   */
  lastEditAppliedAt?: number;
  /**
   * Runs an ad-hoc SELECT for the column quick-stats popover's "aggregate all
   * rows" action (#524). App binds this to the active session; omit to offer
   * only in-memory stats.
   */
  onRunStatsQuery?: (sql: string) => Promise<QueryResult>;
  /**
   * 結果パネルの全画面モーダル表示の現在状態。`onToggleMaximize` が渡されたときだけ
   * ツールバーに最大化/復元トグルを出し、`maximized` でアイコンとツールチップを切り替える。
   */
  maximized?: boolean;
  onToggleMaximize?: () => void;
  /**
   * When provided, a "pin result" button appears in the toolbar so the current
   * result set can be kept for side-by-side comparison (#622). Disabled while
   * there is no settled result.
   */
  onPinResult?: () => void;
  canPinResult?: boolean;
  /**
   * 復元するグリッドの縦スクロール位置 (px、#678)。テーブルタブのみ App が渡す。
   * 行が揃った後に一度だけ、スクロール可能域へクランプして適用する (行が減っていたら
   * 末尾へクランプ)。
   */
  initialScrollTop?: number;
  /** スクロール位置が変わるたびに現在の scrollTop を通知する (#678。タブ永続化用)。 */
  onScroll?: (scrollTop: number) => void;
  /**
   * グリッド系ショートカット (コピー/コピー+ヘッダ/行インスペクタ/Undo/Redo) の
   * 解決済みバインド (#681)。省略時は今日の既定キー (`DEFAULT_SHORTCUT_COMBOS`)
   * のまま動く。
   */
  gridBindings?: GridBindings;
  /**
   * サーバ側ソート/フィルタ (#792): table タブでヘッダーメニューから適用した
   * 全件対象の並び替え/絞り込み。SQL 組み立て・再フェッチは App が担う。
   * `onSetServerSort`/`onSetServerFilter` 未指定なら table タブ以外とみなし、
   * ヘッダーメニューにセクションを出さない。
   */
  serverSort?: ServerSort | null;
  serverFilter?: ServerFilter | null;
  onSetServerSort?: (column: string, direction: ServerSortDirection | null) => void;
  onSetServerFilter?: (
    column: string,
    filter: { op: ServerFilterOp; value: string; numeric: boolean } | null,
  ) => void;
}

export interface ResultGridHandle {
  /** Open the find-in-results bar and focus its input (Cmd/Ctrl+F entry point, #644). */
  openFind: () => void;
  /** キーボードフォーカスをグリッドへ移す (ペインフォーカス循環 #681)。 */
  focus: () => void;
}

/**
 * 結果内検索 (#644) のナビゲーション要求。外側 `ResultGrid` (検索バー所有) から
 * 内側 `DataGrid` (仮想スクロール/ページング/アクティブセル所有) へ prop で渡す
 * ワンショットのコマンド。`seq` の単調増加で同一セルへの再ジャンプも発火する。
 */
interface GridFindNav {
  rowIdx: number;
  colIdx: number;
  seq: number;
  /** true ならアクティブセルもヒットへ移す (Enter ナビ)。タイピング追従は false。 */
  select: boolean;
  /** true ならセルへ DOM フォーカスも移す (Esc でバーを閉じてグリッドへ戻るとき)。 */
  focusCell: boolean;
}

/** Pixels-from-bottom that count as "near the end" for triggering a load. */
const LOAD_MORE_THRESHOLD_PX = 240;

interface RowShape {
  [key: string]: CellValue;
}

// CellKind は表示メタ (型アイコン/空値分類) と共有するため cellTypeMeta.ts に集約し、
// ここでは import して使う。

// 型名 → CellKind の分類基準は `cellTypeMeta.ts::classifyTypeName` に集約
// (DB 全体検索 #748 の走査対象絞り込みと共有するため)。
function classifyColumn(col: Column): CellKind {
  return classifyTypeName(col.type_name);
}

function classifyByValue(v: CellValue): CellKind | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return "number";
  if (typeof v === "boolean") return "bool";
  return null;
}

// toLocaleString() は呼び出しごとに内部で NumberFormat を作り直すため、可視セル
// 描画のたびに走る整数整形ではキャッシュしたフォーマッタを再利用する (出力は同一)。
const intFormatter = new Intl.NumberFormat();

function formatNumber(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  if (Number.isInteger(v)) return intFormatter.format(v);
  return v.toString();
}

/**
 * `resultStatusBar` の結果件数は元々 `.toLocaleString()` を通さず生の桁で表示
 * していた (#977 のカウントアップ導入前と同じ見た目を保つための整形関数)。
 */
function formatCountUpPlainInt(n: number): string {
  return String(Math.round(n));
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

// localeCompare はオプション付き呼び出しのたびに照合設定を再構築するため、
// O(n log n) のソート比較では事前構築した Intl.Collator を使う (順序は同一で
// 10〜100 倍速い)。
const stringCollator = new Intl.Collator(undefined, { numeric: true });

const sortString: SortingFn<RowShape> = (rowA, rowB, columnId) => {
  const av = rowA.getValue(columnId) as CellValue;
  const bv = rowB.getValue(columnId) as CellValue;
  const as = av === null || av === undefined ? null : String(av);
  const bs = bv === null || bv === undefined ? null : String(bv);
  return cmpNullable(as, bs, (x, y) => stringCollator.compare(x, y));
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

/**
 * 行の値を `PendingInsertRow` (列インデックス → 文字列) に変換する。行の複製
 * (#820) で、選択行の値を種に `RowInsertModal` の `initialValues` として渡す
 * ために使う。値の文字列化は `cellToText` と同じ規約 (コピー系アクション共通) を
 * 流用し、NULL/undefined の列はキー自体を省く — フォーム上は空欄のまま = 未設定
 * (DB 既定値) として扱われ、通常の「行を追加」の空欄と挙動が揃う。
 */
function rowToPendingInsert(row: CellValue[]): PendingInsertRow {
  const seed: PendingInsertRow = {};
  row.forEach((v, i) => {
    const text = cellToText(v);
    if (text !== "") seed[i] = text;
  });
  return seed;
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
 * Persisted per-result column layout (order/visibility, pinning).
 * Stored per result shape under a key derived from the column-sizing key, so it
 * follows the same database+table+column signature and is dropped for preview
 * panes (no key). All fields are optional — absent means "default".
 */
export interface PersistedColumnState {
  /** Display order as a list of column ids (`String(originalIndex)`). */
  order?: string[];
  /** Map of column id → visible flag. Absent ids default to visible. */
  visibility?: Record<string, boolean>;
  /** Pinned column ids per side (left/right). */
  pinning?: { left?: string[]; right?: string[] };
}

/** Derive the column-state storage key from the sizing key (same result shape). */
export function colStateKeyFrom(sizingKey: string | undefined): string | undefined {
  return sizingKey ? sizingKey.replace("noobdb.colsizing.v1", "noobdb.colstate.v1") : undefined;
}

export function readStoredColumnState(storageKey: string | undefined): PersistedColumnState {
  if (!storageKey) return {};
  try {
    const stored = localStorage.getItem(storageKey);
    if (stored !== null) {
      const parsed = JSON.parse(stored);
      if (parsed && typeof parsed === "object") return parsed as PersistedColumnState;
    }
  } catch {
    // ignore (corrupt entry, private mode, quota)
  }
  return {};
}

export function writeStoredColumnState(
  storageKey: string | undefined,
  state: PersistedColumnState,
): void {
  if (!storageKey) return;
  try {
    // Empty state → remove the entry so a reset truly falls back to defaults.
    const empty =
      (!state.order || state.order.length === 0) &&
      (!state.visibility || Object.keys(state.visibility).length === 0) &&
      (!state.pinning || ((state.pinning.left?.length ?? 0) === 0 && (state.pinning.right?.length ?? 0) === 0));
    if (empty) {
      localStorage.removeItem(storageKey);
    } else {
      localStorage.setItem(storageKey, JSON.stringify(state));
    }
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
export type TextFilterOp = "contains" | "equals" | "notEquals" | "startsWith" | "endsWith";
export type NumberFilterOp = "eq" | "ne" | "gt" | "lt" | "between";
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
  { op: "notEquals", key: "gridFilterOpNotEquals" },
  { op: "startsWith", key: "gridFilterOpStartsWith" },
  { op: "endsWith", key: "gridFilterOpEndsWith" },
];

const NUMBER_FILTER_OPS: { op: NumberFilterOp; key: I18nKey }[] = [
  { op: "eq", key: "gridFilterOpEq" },
  { op: "ne", key: "gridFilterOpNe" },
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
    case "notEquals":
    case "startsWith":
    case "endsWith": {
      const s = String(v).toLowerCase();
      const q = f.value.toLowerCase();
      if (f.op === "contains") return s.includes(q);
      if (f.op === "equals") return s === q;
      if (f.op === "notEquals") return s !== q;
      if (f.op === "startsWith") return s.startsWith(q);
      return s.endsWith(q);
    }
    case "eq":
    case "ne":
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
        if (f.op === "ne") return n !== BigInt(a);
        if (f.op === "gt") return n > BigInt(a);
        if (f.op === "lt") return n < BigInt(a);
        // between: an empty bound is treated as open.
        return (a === "" || n >= BigInt(a)) && (b === "" || n <= BigInt(b));
      }
      const n = Number(v);
      if (Number.isNaN(n)) return false;
      const an = a === "" ? NaN : Number(a);
      if (f.op === "eq") return !Number.isNaN(an) && n === an;
      if (f.op === "ne") return !Number.isNaN(an) && n !== an;
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
  py: "1",
  px: "1.5",
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
 * 結果内検索バー (#644) のトグルボタン (Aa / 完全一致 / 正規表現) の共有スタイル。
 * `aria-pressed` を状態の単一ソースにし、押下中はアクセント色で示す。
 */
const FIND_TOGGLE_CSS: SystemStyleObject = {
  px: "1.5",
  py: "0.5",
  fontSize: "var(--text-xs)",
  fontFamily: "var(--font-mono)",
  lineHeight: 1.5,
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)",
  background: "transparent",
  color: "var(--text-muted)",
  cursor: "pointer",
  whiteSpace: "nowrap",
  flexShrink: 0,
  transition:
    "background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease)",
  _hover: { background: "var(--bg-hover)", color: "var(--text)" },
  '&[aria-pressed="true"]': {
    background: "color-mix(in srgb, var(--accent) 18%, transparent)",
    borderColor: "var(--accent)",
    color: "var(--accent)",
  },
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
  formatSupported,
  formatMode,
  onFormatModeChange,
  paletteKey,
  onPaletteChange,
  onHideColumn,
  onShowAllColumns,
  onResetLayout,
  pinned,
  onPin,
  onShowStats,
  footerEnabled,
  onToggleFooter,
  serverSortDir,
  onSetServerSort,
  serverFilter,
  onApplyServerFilter,
  onClearServerFilter,
}: {
  columnName: string;
  kind: CellKind;
  anchor: DOMRect;
  value: ColumnFilter | undefined;
  onChange: (next: ColumnFilter | undefined) => void;
  onClose: () => void;
  /** 数値列のみ条件付き書式 (データバー/ヒート) を出す。 */
  formatSupported: boolean;
  formatMode: CondFormatMode;
  onFormatModeChange: (mode: CondFormatMode) => void;
  paletteKey: string;
  onPaletteChange: (key: string) => void;
  /** 列の表示/並び替え操作。未指定なら該当セクションを出さない。 */
  onHideColumn?: () => void;
  onShowAllColumns?: () => void;
  onResetLayout?: () => void;
  /** 列のピン留め状態と切替。未指定ならピン操作を出さない。 */
  pinned?: false | "left" | "right";
  onPin?: (side: false | "left" | "right") => void;
  /** 「列の統計」ポップオーバーを開く。未指定なら項目を出さない (#524)。 */
  onShowStats?: () => void;
  /** 集計フッター (#645) の表示状態と切替。未指定なら項目を出さない。 */
  footerEnabled?: boolean;
  onToggleFooter?: () => void;
  /**
   * サーバ側ソート (#792): この列が現在の全件ソート対象なら方向、そうでなければ
   * null。`onSetServerSort` 未指定なら table タブ以外 (プレビュー等) とみなし
   * セクション自体を出さない。
   */
  serverSortDir?: ServerSortDirection | null;
  onSetServerSort?: (direction: ServerSortDirection | null) => void;
  /** サーバ側フィルタ (#792): この列が現在の全件 WHERE 対象ならその条件。 */
  serverFilter?: { op: ServerFilterOp; value: string } | null;
  onApplyServerFilter?: (op: ServerFilterOp, value: string) => void;
  onClearServerFilter?: () => void;
}) {
  const t = useT();
  const numeric = isNumericFilterKind(kind);
  const ops = numeric ? NUMBER_FILTER_OPS : TEXT_FILTER_OPS;
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [draft, setDraft] = useState<ColumnFilter>(() => value ?? makeDefaultFilter(kind));
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [serverFilterOp, setServerFilterOp] = useState<ServerFilterOp>(
    () => serverFilter?.op ?? (numeric ? "eq" : "contains"),
  );
  const [serverFilterValue, setServerFilterValue] = useState<string>(() => serverFilter?.value ?? "");
  const serverFilterNeedsValue =
    serverFilterOp === "eq" || serverFilterOp === "ne" || serverFilterOp === "contains";

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
      zIndex="popover"
      width="240px"
      display="flex"
      flexDirection="column"
      gap="2"
      padding="2.5"
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
      <Tooltip label={columnName} focusableWrapper>
        <chakra.div
          fontSize="var(--text-sm)"
          fontWeight={600}
          color="app.text"
          whiteSpace="nowrap"
          overflow="hidden"
          textOverflow="ellipsis"
        >
          {columnName}
        </chakra.div>
      </Tooltip>

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
        <Box display="flex" gap="1.5">
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

      {(onSetServerSort || onApplyServerFilter) && (
        <Box
          display="flex"
          flexDirection="column"
          gap="1.5"
          paddingTop="1"
          borderTop="1px solid"
          borderColor="app.borderSubtle"
        >
          <chakra.span fontSize="var(--text-xs)" color="app.textMuted">
            {t("gridServerBrowseLabel")}
          </chakra.span>
          {onSetServerSort && (
            <chakra.select
              css={FILTER_FIELD_CSS}
              value={serverSortDir ?? "none"}
              aria-label={t("gridServerSortSelectAria")}
              onChange={(e) => {
                const v = e.target.value;
                onSetServerSort(v === "none" ? null : (v as ServerSortDirection));
              }}
            >
              <option value="none">{t("gridServerSortOptionNone")}</option>
              <option value="asc">{t("gridServerSortOptionAsc")}</option>
              <option value="desc">{t("gridServerSortOptionDesc")}</option>
            </chakra.select>
          )}
          {onApplyServerFilter && (
            <>
              <chakra.select
                css={FILTER_FIELD_CSS}
                value={serverFilterOp}
                aria-label={t("gridServerFilterOpAria")}
                onChange={(e) => setServerFilterOp(e.target.value as ServerFilterOp)}
              >
                <option value="eq">{t("gridServerFilterOpEq")}</option>
                <option value="ne">{t("gridServerFilterOpNe")}</option>
                <option value="contains">{t("gridServerFilterOpContains")}</option>
                <option value="isNull">{t("gridServerFilterOpIsNull")}</option>
                <option value="isNotNull">{t("gridServerFilterOpIsNotNull")}</option>
              </chakra.select>
              {serverFilterNeedsValue && (
                <chakra.input
                  css={FILTER_FIELD_CSS}
                  type="text"
                  inputMode={numeric ? "decimal" : undefined}
                  value={serverFilterValue}
                  placeholder={t("gridFilterValuePlaceholder")}
                  aria-label={t("gridServerFilterValueAria")}
                  onChange={(e) => setServerFilterValue(e.target.value)}
                />
              )}
              <Box display="flex" gap="1.5">
                <Button
                  variant="secondary"
                  size="sm"
                  px="2"
                  onClick={() => {
                    onApplyServerFilter(serverFilterOp, serverFilterValue);
                    onClose();
                  }}
                >
                  {t("gridServerFilterApply")}
                </Button>
                {serverFilter && onClearServerFilter && (
                  <Button
                    variant="secondary"
                    size="sm"
                    px="2"
                    onClick={() => {
                      onClearServerFilter();
                      onClose();
                    }}
                  >
                    {t("gridServerFilterClear")}
                  </Button>
                )}
              </Box>
            </>
          )}
        </Box>
      )}

      {formatSupported && (
        <chakra.label display="flex" flexDirection="column" gap="3px">
          <chakra.span fontSize="var(--text-xs)" color="app.textMuted">
            {t("gridCondFormatLabel")}
          </chakra.span>
          <chakra.select
            css={FILTER_FIELD_CSS}
            value={formatMode}
            onChange={(e) => onFormatModeChange(e.target.value as CondFormatMode)}
          >
            <option value="off">{t("gridCondFormatOff")}</option>
            <option value="bar">{t("gridCondFormatBar")}</option>
            <option value="heat">{t("gridCondFormatHeat")}</option>
          </chakra.select>
          {formatMode === "heat" && (
            <chakra.select
              css={FILTER_FIELD_CSS}
              value={paletteKey}
              aria-label={t("gridCondFormatPalette")}
              onChange={(e) => onPaletteChange(e.target.value)}
            >
              {Object.values(HEAT_PALETTES).map((p) => (
                <option key={p.key} value={p.key}>
                  {t(`gridPalette_${p.key}` as Parameters<typeof t>[0])}
                  {p.colorBlindSafe ? ` ${t("gridPaletteCbSafe")}` : ""}
                </option>
              ))}
            </chakra.select>
          )}
        </chakra.label>
      )}

      {onPin && (
        <chakra.label display="flex" flexDirection="column" gap="3px">
          <chakra.span fontSize="var(--text-xs)" color="app.textMuted">
            {t("gridPinLabel")}
          </chakra.span>
          <chakra.select
            css={FILTER_FIELD_CSS}
            value={pinned ? pinned : "none"}
            onChange={(e) => {
              const v = e.target.value;
              onPin(v === "none" ? false : (v as "left" | "right"));
            }}
          >
            <option value="none">{t("gridPinNone")}</option>
            <option value="left">{t("gridPinLeft")}</option>
            <option value="right">{t("gridPinRight")}</option>
          </chakra.select>
        </chakra.label>
      )}

      {(onHideColumn || onShowAllColumns || onResetLayout || onShowStats || onToggleFooter) && (
        <Box display="flex" flexDirection="column" gap="1" paddingTop="0.5" borderTop="1px solid" borderColor="app.borderSubtle">
          <chakra.span fontSize="var(--text-xs)" color="app.textMuted" paddingTop="1.5">
            {t("gridColumnsLabel")}
          </chakra.span>
          <Box display="flex" flexWrap="wrap" gap="1.5">
            {onShowStats && (
              <Button
                variant="secondary"
                size="sm"
                px="2"
                onClick={() => {
                  onShowStats();
                  onClose();
                }}
              >
                {t("gridColumnStats")}
              </Button>
            )}
            {onToggleFooter && (
              <Button
                variant="secondary"
                size="sm"
                px="2"
                onClick={() => {
                  onToggleFooter();
                  onClose();
                }}
              >
                {footerEnabled ? t("gridFooterHide") : t("gridFooterShow")}
              </Button>
            )}
            {onHideColumn && (
              <Button
                variant="secondary"
                size="sm"
                px="2"
                onClick={() => {
                  onHideColumn();
                  onClose();
                }}
              >
                {t("gridHideColumn")}
              </Button>
            )}
            {onShowAllColumns && (
              <Button variant="secondary" size="sm" px="2" onClick={onShowAllColumns}>
                {t("gridShowAllColumns")}
              </Button>
            )}
            {onResetLayout && (
              <Button
                variant="secondary"
                size="sm"
                px="2"
                onClick={() => {
                  onResetLayout();
                  onClose();
                }}
              >
                {t("gridResetLayout")}
              </Button>
            )}
          </Box>
        </Box>
      )}

      <Box display="flex" justifyContent="space-between" gap="1.5" paddingTop="0.5">
        <Button
          variant="secondary"
          size="sm"
          px="2.5"
          onClick={() => {
            apply(makeDefaultFilter(kind));
            onClose();
          }}
        >
          {t("gridFilterClearColumn")}
        </Button>
        <Button variant="secondary" size="sm" px="2.5" onClick={onClose}>
          {t("gridFilterCloseMenu")}
        </Button>
      </Box>
    </Box>,
    document.body,
  );
}

/** 統計ポップオーバーの 1 行 (ラベル + 値)。 */
function StatRow({ label, value, title }: { label: string; value: ReactNode; title?: string }) {
  const valueSpan = (
    <chakra.span
      fontSize="var(--text-sm)"
      fontFamily="mono"
      color="app.text"
      fontWeight={600}
      textAlign="right"
      overflow="hidden"
      textOverflow="ellipsis"
      whiteSpace="nowrap"
    >
      {value}
    </chakra.span>
  );
  return (
    <Box display="flex" alignItems="baseline" justifyContent="space-between" gap="2">
      <chakra.span fontSize="var(--text-xs)" color="app.textMuted" whiteSpace="nowrap">
        {label}
      </chakra.span>
      {title ? (
        <Tooltip label={title} focusableWrapper>
          {valueSpan}
        </Tooltip>
      ) : (
        valueSpan
      )}
    </Box>
  );
}

/** 数値統計の整形 (整数はロケール区切り、小数は最大 4 桁)。null は em ダッシュ。 */
function fmtStatNum(n: number | null): string {
  if (n === null) return "—";
  if (!Number.isFinite(n)) return String(n);
  return Number.isInteger(n)
    ? n.toLocaleString()
    : n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

/** 任意のセル値を統計表示用テキストへ (NULL は em ダッシュ)。 */
function fmtStatCell(v: CellValue): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "number") return fmtStatNum(v);
  return String(v);
}

/**
 * 集計フッター (#645) の関数ラベル i18n キー。列統計 (#524) と同じ短縮ラベルを
 * 再利用し、フッターセルとヘッダーメニューのセレクタで表記を一致させる。
 */
const FOOTER_FN_LABEL: Record<FooterAggFn, I18nKey> = {
  none: "gridFooterFnNone",
  count: "gridCountLabel",
  distinct: "gridDistinctLabel",
  nullRate: "gridStatsNullRate",
  sum: "gridSumLabel",
  avg: "gridAvgLabel",
  min: "gridMinLabel",
  max: "gridMaxLabel",
};

/** フッターセルの表示テキスト (空セルは空文字)。整形はここでロケール依存で行う。 */
function footerCellText(cell: { blank: boolean; numeric: number | null; percent: number | null }): string {
  if (cell.blank) return "";
  if (cell.percent !== null) {
    const p = cell.percent;
    return `${p.toFixed(p > 0 && p < 1 ? 1 : 0)}%`;
  }
  return fmtStatNum(cell.numeric);
}

/**
 * 列のクイック統計ポップオーバー (#524)。ヘッダーメニューの「列の統計」から開く。
 * `ColumnFilterMenu` と同じく <body> へポータルし、アンカー直下にクランプ表示する。
 *
 * - 在メモリ (取得済み行) の統計は `columnStats` で即時計算して表示する。
 * - `statsRequest` と `onRunStatsQuery` が揃うときだけ「全件集計」ボタンを出し、
 *   ドライバ方言の集計 SQL (`buildColumnStatsSql`) を実行して正確値を取得する。
 */
function ColumnStatsMenu({
  columnName,
  kind,
  anchor,
  values,
  onClose,
  statsRequest,
  onRunStatsQuery,
  footerFn,
  onSetFooterFn,
}: {
  columnName: string;
  kind: CellKind;
  anchor: DOMRect;
  /** 取得済み (在メモリ) のこの列の全値。 */
  values: CellValue[];
  onClose: () => void;
  /** 全件集計に必要な情報。未指定なら「全件集計」を出さない。 */
  statsRequest?: FullStatsRequest;
  /** 集計 SQL を実行する (App から api.runQuery を束ねて渡す)。 */
  onRunStatsQuery?: (sql: string) => Promise<QueryResult>;
  /** この列の集計フッター関数 (#645)。`onSetFooterFn` があるときだけ節を出す。 */
  footerFn?: FooterAggFn;
  onSetFooterFn?: (fn: FooterAggFn) => void;
}) {
  const t = useT();
  const numeric = isNumericStatsKind(kind);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [full, setFull] = useState<FullColumnStats | null>(null);
  const [loadingFull, setLoadingFull] = useState(false);
  const [fullError, setFullError] = useState<string | null>(null);

  const stats: ColumnStats = useMemo(() => computeColumnStats(values, kind), [values, kind]);
  // 率の式は列ヘッダのミニバー (#911) / 集計フッターと `nullRatePercentOf` で共有する。
  const nullPct = nullRatePercentOf(stats);

  // Clamp into the viewport once measured (mirrors ColumnFilterMenu). Re-runs on
  // `full`/`loadingFull` since the panel grows when the all-rows section appears.
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
  }, [anchor, full, loadingFull, fullError]);

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

  const runFull = async () => {
    if (!statsRequest || !onRunStatsQuery || loadingFull) return;
    setLoadingFull(true);
    setFullError(null);
    try {
      const res = await onRunStatsQuery(buildColumnStatsSql(statsRequest));
      const row = res.rows[0];
      if (!row) {
        setFullError(t("gridStatsError"));
        return;
      }
      setFull(parseFullColumnStats(row, numeric));
    } catch (e) {
      setFullError(typeof e === "string" ? e : e instanceof Error ? e.message : t("gridStatsError"));
    } finally {
      setLoadingFull(false);
    }
  };

  // NULL 率ミニバー (条件付き書式 #499 と同じアクセント系トーン)。塗りは
  // `colorScale.ts` の `accentFill`/`ACCENT_FILL_STOPS` を `.cell-databar` と
  // 共有し、`color-mix(--accent)` の直書きを避ける (#718)。
  const nullBar = (
    <Tooltip label={`${nullPct.toFixed(1)}%`} focusableWrapper>
      <Box
        role="img"
        aria-label={`${t("gridStatsNullRate")}: ${nullPct.toFixed(1)}%`}
        height="6px"
        borderRadius="full"
        overflow="hidden"
        background="color-mix(in srgb, var(--text-muted) 18%, transparent)"
      >
        <Box
          height="100%"
          width="100%"
          transformOrigin="left center"
          style={{ transform: `scaleX(${nullPct / 100})` }}
          background={accentFill(ACCENT_FILL_STOPS.nullRate)}
          transition="transform var(--dur-med) var(--ease-out)"
        />
      </Box>
    </Tooltip>
  );

  return createPortal(
    <Box
      ref={menuRef}
      role="dialog"
      aria-label={t("gridStatsAria", { column: columnName })}
      position="fixed"
      zIndex="popover"
      width="248px"
      display="flex"
      flexDirection="column"
      gap="2"
      padding="2.5"
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
      <Box display="flex" alignItems="center" gap="1.5" minWidth={0}>
        <Icon name={CELL_KIND_META[kind].icon} size={ICON_SIZES.sm} />
        <Tooltip label={columnName} focusableWrapper>
          <chakra.div
            fontSize="var(--text-sm)"
            fontWeight={600}
            color="app.text"
            whiteSpace="nowrap"
            overflow="hidden"
            textOverflow="ellipsis"
          >
            {columnName}
          </chakra.div>
        </Tooltip>
      </Box>

      <chakra.span fontSize="var(--text-xs)" color="app.textMuted">
        {t("gridStatsInMemory", { count: stats.count })}
      </chakra.span>

      <Box display="flex" flexDirection="column" gap="1">
        <StatRow
          label={t("gridCountLabel")}
          value={
            <>
              <CountUp value={stats.nonNullCount} />
              {" / "}
              <CountUp value={stats.count} />
            </>
          }
        />
        <Box display="flex" flexDirection="column" gap="0.5">
          <StatRow
            label={t("gridNullLabel")}
            value={
              <>
                <CountUp value={stats.nullCount} />
                {` (${nullPct.toFixed(nullPct > 0 && nullPct < 1 ? 1 : 0)}%)`}
              </>
            }
          />
          {nullBar}
        </Box>
        <StatRow label={t("gridDistinctLabel")} value={<CountUp value={stats.distinctCount} />} />
        {numeric ? (
          <>
            <StatRow label={t("gridMinLabel")} value={fmtStatNum(stats.min)} />
            <StatRow label={t("gridMaxLabel")} value={fmtStatNum(stats.max)} />
            <StatRow label={t("gridAvgLabel")} value={fmtStatNum(stats.avg)} />
            <StatRow label={t("gridSumLabel")} value={fmtStatNum(stats.sum)} />
          </>
        ) : (
          <>
            <StatRow label={t("gridMinLenLabel")} value={fmtStatNum(stats.minLen)} />
            <StatRow label={t("gridMaxLenLabel")} value={fmtStatNum(stats.maxLen)} />
            {stats.mode && (
              <StatRow
                label={t("gridModeLabel")}
                value={`${stats.mode.value} (${stats.mode.count})`}
                title={stats.mode.value}
              />
            )}
          </>
        )}
      </Box>

      {onSetFooterFn && (
        <Box
          display="flex"
          flexDirection="column"
          gap="1.5"
          paddingTop="1"
          borderTop="1px solid"
          borderColor="app.borderSubtle"
        >
          <chakra.label
            display="flex"
            alignItems="center"
            justifyContent="space-between"
            gap="2"
            fontSize="var(--text-xs)"
            color="app.textMuted"
          >
            {t("gridFooterLabel")}
            <chakra.select
              aria-label={t("gridFooterSelectAria", { column: columnName })}
              value={footerFn ?? defaultFooterFn(kind)}
              onChange={(e) => onSetFooterFn(e.target.value as FooterAggFn)}
              fontSize="var(--text-xs)"
              fontFamily="inherit"
              padding="2px 6px"
              border="1px solid var(--border)"
              background="var(--bg-input)"
              color="var(--text)"
              borderRadius="var(--radius-sm)"
            >
              {availableFooterFns(kind).map((fn) => (
                <option key={fn} value={fn}>
                  {t(FOOTER_FN_LABEL[fn])}
                </option>
              ))}
            </chakra.select>
          </chakra.label>
        </Box>
      )}

      {statsRequest && onRunStatsQuery && (
        <Box
          display="flex"
          flexDirection="column"
          gap="1.5"
          paddingTop="1"
          borderTop="1px solid"
          borderColor="app.borderSubtle"
        >
          {full ? (
            <>
              <chakra.span fontSize="var(--text-xs)" color="app.textMuted">
                {t("gridStatsFullSection")}
              </chakra.span>
              <StatRow
                label={t("gridCountLabel")}
                value={
                  <>
                    <CountUp value={full.nonNull} />
                    {" / "}
                    <CountUp value={full.total} />
                  </>
                }
              />
              <StatRow
                label={t("gridNullLabel")}
                value={<CountUp value={full.nullCount} />}
              />
              <StatRow label={t("gridDistinctLabel")} value={<CountUp value={full.distinct} />} />
              <StatRow label={t("gridMinLabel")} value={fmtStatCell(full.min)} title={fmtStatCell(full.min)} />
              <StatRow label={t("gridMaxLabel")} value={fmtStatCell(full.max)} title={fmtStatCell(full.max)} />
              {numeric && (
                <>
                  <StatRow label={t("gridAvgLabel")} value={fmtStatNum(full.avg)} />
                  <StatRow label={t("gridSumLabel")} value={fmtStatNum(full.sum)} />
                </>
              )}
            </>
          ) : (
            <LoadingButton
              variant="secondary"
              size="sm"
              loading={loadingFull}
              onClick={() => void runFull()}
            >
              {loadingFull ? t("gridStatsLoading") : t("gridStatsFullButton")}
            </LoadingButton>
          )}
          {fullError && (
            <chakra.span
              role="alert"
              fontSize="var(--text-xs)"
              color="var(--status-error)"
              whiteSpace="normal"
            >
              {fullError}
            </chakra.span>
          )}
        </Box>
      )}

      <Box display="flex" justifyContent="flex-end" paddingTop="0.5">
        <Button variant="secondary" size="sm" px="2.5" onClick={onClose}>
          {t("gridStatsClose")}
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
  addedRowIndices,
  globalFilter,
  editable = false,
  editableColumns,
  pkIndices,
  pendingEdits,
  onSetCellEdit,
  onBulkEdit,
  pendingDeleteKeys,
  onToggleRowDelete,
  onRequestInsertRow,
  onDuplicateRow,
  validateEdit,
  columnSizingStorageKey,
  emptyMessage,
  skeleton = false,
  scrollContainerRef,
  rowSqlDriver,
  rowSqlDatabase,
  rowSqlTable,
  columnMeta,
  incomingFks,
  onFkJump,
  paginationState,
  onPaginationChange,
  onUndoEdit,
  onRedoEdit,
  canUndo,
  canRedo,
  onSelectionSummary,
  onExportSelection,
  onRunStatsQuery,
  findHits,
  findCurrentKey,
  findNav,
  gridBindings,
  serverSort,
  serverFilter,
  onSetServerSort,
  onSetServerFilter,
}: {
  columns: Column[];
  rows: CellValue[][];
  enableColumnControls?: boolean;
  changedCells?: boolean[][];
  changedColumns?: boolean[];
  /**
   * Original row positions that are "added" relative to the previous run of the
   * same query (#597). Highlighted with a green row marker. Indexed by
   * `rows[i]` and resolved through `row.index`, like `changedCells`.
   */
  addedRowIndices?: Set<number>;
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
   * Result-column indices forming the row's identity — the table's primary
   * key when one resolves, or (#849) the outer `ResultGrid`'s
   * `resolveRowIdentity` fallback when it doesn't: a single rowid/ctid
   * pseudo-column, or every column when matching all of them is the only
   * option. Used to derive each row's stable `rowEditKey` so buffered edits
   * survive pagination. Empty (or omitted) means no resolvable identity at
   * all — editing is gated off in that case.
   */
  pkIndices?: number[];
  pendingEdits?: PendingEdits;
  onSetCellEdit?: (rowKey: string, colIdx: number, value: string | null) => void;
  /**
   * Apply a single value (or NULL) to every cell of the current rectangular
   * selection in one batch (#596). Receives the resolved per-cell targets from
   * `planBulkCellEdit`. Omit to hide the "set selected cells" menu item.
   */
  onBulkEdit?: (edits: BulkEditTarget[]) => void;
  /** 削除予定の行: rowEditKey の集合。該当行は取り消し線で示す。 */
  pendingDeleteKeys?: Set<string>;
  /** 行を削除予定にトグルする。未指定ならメニュー項目を出さない。 */
  onToggleRowDelete?: (rowKey: string) => void;
  /** 新規行追加を要求する。未指定ならメニュー項目を出さない。 */
  onRequestInsertRow?: () => void;
  /**
   * 選択行を種に行追加モーダルを開く (行の複製、#820)。未指定ならメニュー
   * 項目を出さない。
   */
  onDuplicateRow?: (row: PendingInsertRow) => void;
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
  /**
   * Foreign keys pointing AT the current table (reverse references). When
   * provided, the right-click menu offers "show referencing rows" items that
   * open the child tables filtered to the clicked row's key value.
   */
  incomingFks?: IncomingFk[];
  /** Called when the user triggers a FK jump with the generated SELECT SQL. */
  onFkJump?: (sql: string) => void;
  /** When set, TanStack pagination is activated and only this page of rows is rendered. */
  paginationState?: PaginationState;
  onPaginationChange?: OnChangeFn<PaginationState>;
  onUndoEdit?: () => void;
  onRedoEdit?: () => void;
  /**
   * 呼び出し元 (`ResultGrid`) が保持する Undo/Redo スタックの可否 (#815)。
   * 右クリックメニューの「元に戻す/やり直す」項目の disabled 判定にのみ使う —
   * ツールバーボタンの有効判定は `ResultGrid` 自身が別途行うので、ここは省略
   * (undefined) なら常に有効として扱う。
   */
  canUndo?: boolean;
  canRedo?: boolean;
  /**
   * Called whenever the rectangular range selection changes, with the live
   * aggregate of the selected cells (or null when nothing multi-cell is
   * selected). Lets `ResultGrid` surface the summary in its status bar (#523).
   */
  onSelectionSummary?: (summary: SelectionSummary | null) => void;
  /**
   * 矩形選択範囲の右クリック「選択範囲をエクスポート」から呼ばれる (#917)。
   * その時点の選択範囲が指す列/行の部分集合を一度きり渡す (継続的な同期はしない
   * — `onSelectionSummary` と違い、生のセル値をレンダーのたびに親へ push すると
   * 大きな結果セットで重いため)。`ResultGrid` はこれを `ExportModal` の
   * `selection` prop へそのまま渡し、モーダル側で「選択範囲」スコープを提示する。
   */
  onExportSelection?: (data: { columns: Column[]; rows: CellValue[][] }) => void;
  /**
   * Runs an ad-hoc SELECT for the column quick-stats popover's "aggregate all
   * rows" action (#524). Provided by App bound to the active session; omit to
   * hide the full-aggregate button (in-memory stats still show).
   */
  onRunStatsQuery?: (sql: string) => Promise<QueryResult>;
  /**
   * 結果内検索 (#644) のヒットセル ("row:col" キー) の集合。該当セルに
   * ハイライトクラスを付ける。省略時 (検索バーが閉じている/プレビュー) は無印。
   */
  findHits?: Set<string>;
  /** 現在ヒットのセルキー ("row:col")。ヒット中で強調するセル。 */
  findCurrentKey?: string | null;
  /** 現在ヒットへのスクロール/選択/フォーカス移動の要求 (seq で再発火)。 */
  findNav?: GridFindNav | null;
  /**
   * コピー/コピー+ヘッダ/行インスペクタ/Undo/Redo/ページ送りの解決済みバインド
   * (#681)。省略時は今日の既定キーのまま (`DEFAULT_SHORTCUT_COMBOS`)。
   */
  gridBindings?: GridBindings;
  /**
   * サーバ側ソート/フィルタ (#792): table タブでヘッダーメニューから適用した
   * 全件対象の並び替え/絞り込み。実際の SQL 組み立て (`applyServerBrowse`) と
   * 再フェッチは呼び出し元 (App.tsx) が担い、ここは現在の状態の表示と、
   * ヘッダーメニュー経由の変更要求の中継のみを行う。`onSetServerSort` /
   * `onSetServerFilter` が未指定なら table タブ以外とみなしセクション自体を
   * 出さない (プレビュー/ダイアログ内のグリッドなど)。
   */
  serverSort?: ServerSort | null;
  serverFilter?: ServerFilter | null;
  onSetServerSort?: (column: string, direction: ServerSortDirection | null) => void;
  onSetServerFilter?: (
    column: string,
    filter: { op: ServerFilterOp; value: string; numeric: boolean } | null,
  ) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const toast = useToast();
  const { cellEditOnBlur, richCellRendering, columnNullBars } = useSettings();
  const { confirm: confirmBlur, dialog: blurDialog } = useConfirm();
  // セル内容の全文ツールチップ (省略記号で切れた値・条件付き書式のホバー説明
  // など) は行×列に比例して大量に描画されうるため (仮想化されていても可視行 ×
  // 列数のぶんだけ Tooltip インスタンスが乗る)、`ConnectionList` のスキーマ
  // ツリーと同じ「1 つの共有ツールチップ + イベント委譲」方式
  // (`useDelegatedTooltip`、#884) に一本化する。native title からの後退はなく
  // (セルは元々 tabIndex を持たない)、表示速度とテーマ追従だけを底上げする。
  const { hovered: hoveredCellTooltip, bind: cellTooltipProps } = useDelegatedTooltip();

  // グリッド系ショートカットの実効バインド (#681)。未指定のキーは今日の既定へ
  // フォールバックするので、`gridBindings` を渡さない呼び出し元 (プレビューの
  // before/after 表示など) は従来どおりの挙動のまま変わらない。
  const effectiveGridBindings = useMemo<GridBindings>(
    () => ({
      gridCopy: gridBindings?.gridCopy ?? DEFAULT_SHORTCUT_COMBOS.gridCopy,
      gridCopyHeaders: gridBindings?.gridCopyHeaders ?? DEFAULT_SHORTCUT_COMBOS.gridCopyHeaders,
      gridInspector: gridBindings?.gridInspector ?? DEFAULT_SHORTCUT_COMBOS.gridInspector,
      gridUndo: gridBindings?.gridUndo ?? DEFAULT_SHORTCUT_COMBOS.gridUndo,
      gridRedo: gridBindings?.gridRedo ?? DEFAULT_SHORTCUT_COMBOS.gridRedo,
      gridPageNext: gridBindings?.gridPageNext ?? DEFAULT_SHORTCUT_COMBOS.gridPageNext,
      gridPagePrev: gridBindings?.gridPagePrev ?? DEFAULT_SHORTCUT_COMBOS.gridPagePrev,
    }),
    [gridBindings],
  );

  const columnKinds = useMemo<CellKind[]>(() => columns.map(classifyColumn), [columns]);

  // 数値セルの条件付き書式。列ごとの適用モードと、共有のヒートパレット。
  const [colFormats, setColFormats] = useState<Record<number, CondFormatMode>>({});
  const [heatPaletteKey, setHeatPaletteKey] = useState<string>(DEFAULT_HEAT_PALETTE);
  // 列内 min/max は全行から求める (バー/ヒートの基準)。数値列のみ算出。
  // `rows.map` で行数長の中間配列を列ごとに作らず、ジェネレータで 1 パス集計する。
  const columnStats = useMemo<(NumericStats | null)[]>(
    () =>
      columnKinds.map((k, i) =>
        k === "number" || k === "decimal"
          ? computeNumericStats(
              (function* () {
                for (const r of rows) yield r[i];
              })(),
            )
          : null,
      ),
    [columnKinds, rows],
  );

  // --- Sort & column filters, persisted per result shape (#677) ---
  // Column widths/order/visibility were already persisted (#616); sort and
  // column filters used to reset on every reopen. They now ride the same
  // per-result-shape key (`gridViewStateKeyFrom` mirrors `colStateKeyFrom`) so
  // "column widths remembered but sort forgotten" no longer feels broken.
  const gridViewKey = useMemo(
    () => gridViewStateKeyFrom(columnSizingStorageKey),
    [columnSizingStorageKey],
  );
  const [sorting, setSorting] = useState<SortingState>(
    () => readStoredGridView(gridViewKey).sorting ?? [],
  );
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>(
    () => readStoredGridView(gridViewKey).filters ?? [],
  );
  const sortingRef = useRef(sorting);
  sortingRef.current = sorting;
  const columnFiltersRef = useRef(columnFilters);
  columnFiltersRef.current = columnFilters;
  // Reload sort/filters when the result shape (table) changes. Persisting only
  // happens on user interaction (below), so this load never races a stale write.
  useEffect(() => {
    const s = readStoredGridView(gridViewKey);
    setSorting(s.sorting ?? []);
    setColumnFilters(s.filters ?? []);
  }, [gridViewKey]);
  const handleSortingChange: OnChangeFn<SortingState> = (updater) => {
    const next = typeof updater === "function" ? updater(sortingRef.current) : updater;
    setSorting(next);
    writeStoredGridView(gridViewKey, toPersistedGridView(next, columnFiltersRef.current));
  };
  const handleColumnFiltersChange: OnChangeFn<ColumnFiltersState> = (updater) => {
    const next = typeof updater === "function" ? updater(columnFiltersRef.current) : updater;
    setColumnFilters(next);
    writeStoredGridView(gridViewKey, toPersistedGridView(sortingRef.current, next));
  };
  // Clear both sort and filters, persisting the reset in one write (avoids the
  // stale-ref hazard of calling the two handlers back to back).
  const clearSortAndFilters = useCallback(() => {
    setSorting([]);
    setColumnFilters([]);
    writeStoredGridView(gridViewKey, {});
  }, [gridViewKey]);
  const clearSorting = useCallback(() => {
    setSorting([]);
    writeStoredGridView(gridViewKey, toPersistedGridView([], columnFiltersRef.current));
  }, [gridViewKey]);

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

  // --- Column order & visibility, persisted per result shape ---
  const colStateKey = useMemo(
    () => colStateKeyFrom(columnSizingStorageKey),
    [columnSizingStorageKey],
  );
  const [columnOrder, setColumnOrder] = useState<string[]>(
    () => readStoredColumnState(colStateKey).order ?? [],
  );
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(
    () => readStoredColumnState(colStateKey).visibility ?? {},
  );
  const columnOrderRef = useRef(columnOrder);
  columnOrderRef.current = columnOrder;
  const columnVisibilityRef = useRef(columnVisibility);
  columnVisibilityRef.current = columnVisibility;
  // Reload (order/visibility/pinning) when the result shape changes.
  useEffect(() => {
    const s = readStoredColumnState(colStateKey);
    setColumnOrder(s.order ?? []);
    setColumnVisibility(s.visibility ?? {});
    setColumnPinning({ left: s.pinning?.left ?? [], right: s.pinning?.right ?? [] });
  }, [colStateKey]);

  // Column pinning lives alongside order/visibility in one persisted blob.
  const [columnPinning, setColumnPinning] = useState<{ left: string[]; right: string[] }>(
    () => {
      const p = readStoredColumnState(colStateKey).pinning;
      return { left: p?.left ?? [], right: p?.right ?? [] };
    },
  );
  const columnPinningRef = useRef(columnPinning);
  columnPinningRef.current = columnPinning;

  // Persist the full layout blob (snapshotting from refs so each writer sees
  // the latest of the other two fields).
  const persistColumnState = useCallback(
    (patch: Partial<PersistedColumnState>) => {
      writeStoredColumnState(colStateKey, {
        order: patch.order ?? columnOrderRef.current,
        visibility: patch.visibility ?? columnVisibilityRef.current,
        pinning: patch.pinning ?? columnPinningRef.current,
      });
    },
    [colStateKey],
  );

  const handleColumnOrderChange: OnChangeFn<string[]> = (updater) => {
    const next = typeof updater === "function" ? updater(columnOrderRef.current) : updater;
    setColumnOrder(next);
    persistColumnState({ order: next });
  };
  const handleColumnVisibilityChange: OnChangeFn<VisibilityState> = (updater) => {
    const next = typeof updater === "function" ? updater(columnVisibilityRef.current) : updater;
    setColumnVisibility(next);
    persistColumnState({ visibility: next });
  };

  // Reset order/visibility/pinning to defaults. Column widths are a
  // separate concern and left untouched.
  const resetColumnLayout = useCallback(() => {
    setColumnOrder([]);
    setColumnVisibility({});
    setColumnPinning({ left: [], right: [] });
    writeStoredColumnState(colStateKey, {});
  }, [colStateKey]);

  // Whether any non-default layout is active (drives the "reset" affordance).
  const hasCustomLayout =
    columnOrder.length > 0 ||
    Object.values(columnVisibility).some((v) => v === false) ||
    columnPinning.left.length > 0 ||
    columnPinning.right.length > 0;

  // --- Aggregate footer row (#645), persisted per result shape ---
  // Footer show/hide + per-column aggregate function live in their own
  // localStorage namespace (`noobdb.gridfooter.v1`), keyed off the same table
  // signature as column layout (`footerStateKeyFrom` mirrors `colStateKeyFrom`).
  const footerStateKey = useMemo(
    () => footerStateKeyFrom(columnSizingStorageKey),
    [columnSizingStorageKey],
  );
  const [footerEnabled, setFooterEnabled] = useState<boolean>(
    () => readStoredFooterState(footerStateKey).enabled ?? false,
  );
  const [footerAggs, setFooterAggs] = useState<Record<string, FooterAggFn>>(
    () => readStoredFooterState(footerStateKey).aggs ?? {},
  );
  const footerEnabledRef = useRef(footerEnabled);
  footerEnabledRef.current = footerEnabled;
  const footerAggsRef = useRef(footerAggs);
  footerAggsRef.current = footerAggs;
  // Reload footer state when the result shape (table) changes.
  useEffect(() => {
    const s = readStoredFooterState(footerStateKey);
    setFooterEnabled(s.enabled ?? false);
    setFooterAggs(s.aggs ?? {});
  }, [footerStateKey]);
  const persistFooter = useCallback(
    (patch: Partial<PersistedFooterState>) => {
      writeStoredFooterState(footerStateKey, {
        enabled: patch.enabled ?? footerEnabledRef.current,
        aggs: patch.aggs ?? footerAggsRef.current,
      });
    },
    [footerStateKey],
  );
  const toggleFooter = useCallback(() => {
    const next = !footerEnabledRef.current;
    setFooterEnabled(next);
    persistFooter({ enabled: next });
  }, [persistFooter]);
  // Picking a per-column function also turns the footer on so the change shows.
  const setFooterAgg = useCallback(
    (colId: string, fn: FooterAggFn) => {
      const nextAggs = { ...footerAggsRef.current, [colId]: fn };
      setFooterAggs(nextAggs);
      setFooterEnabled(true);
      writeStoredFooterState(footerStateKey, { enabled: true, aggs: nextAggs });
    },
    [footerStateKey],
  );
  // Per-column in-memory ColumnStats for the footer, reusing gridStats
  // (#524) so aggregate math is never re-defined. Only computed while the
  // footer is shown, and memoized on the loaded rows so scrolling is free.
  const footerStats = useMemo<ColumnStats[] | null>(() => {
    if (!footerEnabled) return null;
    return columns.map((_, i) =>
      computeColumnStats(
        rows.map((r) => r[i] ?? null),
        columnKinds[i] ?? "string",
      ),
    );
  }, [footerEnabled, rows, columns, columnKinds]);

  // 列ヘッダの常時 NULL 率ミニバー (#911)。ポップオーバー (`ColumnStatsMenu`) を
  // 開かなくても欠損の偏りが一望できるよう、取得済み行の NULL 率だけを軽量に
  // 数える (`columnNullRates` — DISTINCT/代表値の頻度マップは作らない)。設定で
  // オフのとき、および行が 1 件も無いときは計算も描画もしない。
  const nullRates = useMemo<number[] | null>(() => {
    if (!columnNullBars || rows.length === 0 || columns.length === 0) return null;
    return columnNullRates(rows, columns.length);
  }, [columnNullBars, rows, columns.length]);

  // Drag-to-reorder columns: track the dragged/hovered column ids for
  // visual feedback, and commit a new order on drop.
  const [dragColId, setDragColId] = useState<string | null>(null);
  const [dragOverColId, setDragOverColId] = useState<string | null>(null);
  // Plain (non-memoized) function so it always closes over the current
  // `handleColumnOrderChange` / `persistColumnState`, whose persist key
  // (`colStateKey`) tracks database/table — not just `columns`. It's only
  // invoked from the (already per-render) header onDrop, so it needn't be stable.
  const reorderColumn = (fromId: string, toId: string) => {
    if (fromId === toId) return;
    const base = (
      columnOrderRef.current.length
        ? columnOrderRef.current
        : columns.map((_, i) => String(i))
    ).slice();
    const fromIdx = base.indexOf(fromId);
    if (fromIdx < 0) return;
    const [moved] = base.splice(fromIdx, 1);
    const insertAt = base.indexOf(toId);
    if (insertAt < 0) return;
    base.splice(insertAt, 0, moved);
    handleColumnOrderChange(base);
  };

  const tableColumns = useMemo<ColumnDef<RowShape>[]>(() => {
    // 列ごとの線形探索 (find) は横に広いテーブルで O(列数²) になるため、
    // 名前 → メタデータの Map を 1 度だけ作って引く。
    const metaByName = new Map(columnMeta?.map((m) => [m.name, m]) ?? []);
    return columns.map((c, i) => {
      const kind = columnKinds[i];
      const fkInfo = metaByName.get(c.name);
      const fkTable = fkInfo?.referenced_table ?? null;
      return {
        id: String(i),
        // ヘッダーは列数ぶんしか描画されない (行数に比例しない) ため、他の列
        // ヘッダー系コントロール (ソート/フィルタ/リサイズボタン等、後述) と
        // 同じく共有 `Tooltip` を直接使ってよい (#884)。
        header: () => (
          <Tooltip label={fkTable ? t("gridFkColHeader", { table: fkTable }) : c.type_name} focusableWrapper>
            <span className="th-content">
              <span className="th-label-row">
                {fkTable && <span className="th-fk-badge">FK</span>}
                <span className="th-name">{c.name}</span>
                {/* カラム型アイコン。aria-label で SR にも型を伝える。
                    名前の後ろに置き、ヘッダーのアクセシブル名が列名から始まるようにする。 */}
                <Tooltip label={t(CELL_KIND_META[kind].labelKey)} focusableWrapper>
                  <span className="th-type-icon" role="img" aria-label={t(CELL_KIND_META[kind].labelKey)}>
                    <Icon name={CELL_KIND_META[kind].icon} size={ICON_SIZES.sm} />
                  </span>
                </Tooltip>
              </span>
              <span className="th-type">{c.type_name}</span>
            </span>
          </Tooltip>
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
          // NULL / 空文字 / 空配列・空オブジェクトを描き分ける。表示専用で、
          // コピー/編集/エクスポートは常に元の値 (info.getValue()) を使う。
          const emptyKind = classifyEmptyValue(v);
          if (emptyKind === "null") {
            return <span className="cell-null">{t("resultNull")}</span>;
          }
          if (richCellRendering && emptyKind) {
            const badge = EMPTY_BADGE[emptyKind];
            return (
              <span
                className={`cell-empty cell-empty-${emptyKind}`}
                aria-label={t(badge.labelKey)}
                {...cellTooltipProps(t(badge.labelKey))}
              >
                {badge.glyph}
              </span>
            );
          }
          const effectiveKind = classifyByValue(v) ?? kind;
          // 数値セルの条件付き書式: 列単位でオプトインされたデータバー /
          // ヒートマップを背景に描く。NULL/非数値は対象外 (上で弾き済み or num===null)。
          const renderNumeric = (display: string, extraClass: string, title?: string) => {
            const mode = colFormats[i] ?? "off";
            const stats = columnStats[i];
            const num = toNumber(v);
            if (mode === "off" || !stats || num === null) {
              return (
                <span className={`cell-number ${extraClass}`} {...cellTooltipProps(title)}>
                  {display}
                </span>
              );
            }
            if (mode === "bar") {
              return (
                <span className="cell-cf-wrap" {...cellTooltipProps(title)}>
                  <span
                    className="cell-databar"
                    style={{ transform: `scaleX(${dataBarPercent(num, stats) / 100})` }}
                    aria-hidden
                  />
                  {/* データバーはアクセント色の半透明塗り (accentFill) が背景に乗るため、
                      型別の数値色 (--cell-number) のままだと塗りの上でコントラストが
                      不足しうる (#646)。中立な --text で全テーマ・任意のアクセント色に
                      対し安定した可読性を確保する。 */}
                  <span
                    className={`cell-number cell-cf-value ${extraClass}`}
                    style={{ color: "var(--text)" }}
                  >
                    {display}
                  </span>
                </span>
              );
            }
            const palette = HEAT_PALETTES[heatPaletteKey] ?? HEAT_PALETTES[DEFAULT_HEAT_PALETTE];
            const color = heatmapColor(normalize(num, stats), palette);
            // ヒートマップは半透明の塗り (行背景との合成) だと、合成後の色が
            // テーマ/行背景ごとに変わってしまい、固定の文字色ではコントラストを
            // 保証できない (#646: 一部の組み合わせで 1.3:1 まで低下していた)。
            // 不透明な塗りにし、`readableInk` で塗り色そのものから文字色を
            // 決めることで、テーマに関わらず十分なコントラストを確保する。
            return (
              <span className="cell-cf-wrap" {...cellTooltipProps(title)} style={{ background: color }}>
                <span
                  className={`cell-number cell-cf-value ${extraClass}`}
                  style={{ color: readableInk(color) }}
                >
                  {display}
                </span>
              </span>
            );
          };
          if (effectiveKind === "number") {
            const num = typeof v === "number" ? v : Number(v);
            const display = Number.isFinite(num) ? formatNumber(num) : String(v);
            // 桁区切り整形などで表示が元値と変わる場合 (例: "007" → "7") に備え、
            // ホバーで元の文字列を確認できるようにする (#647)。同一なら title は無し。
            return renderNumeric(display, "", rawValueTitle(String(v), display));
          }
          if (effectiveKind === "decimal") {
            return renderNumeric(String(v), "cell-decimal");
          }
          if (effectiveKind === "bool") {
            const truthy = resolveBoolTruthy(v);
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
              <span className="cell-date" {...cellTooltipProps(raw)}>
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
              <span className="cell-json" {...cellTooltipProps(raw)}>
                {compact}
              </span>
            ) : (
              <span className="cell-json">{raw}</span>
            );
          }
          if (effectiveKind === "enum") {
            const raw = String(v);
            // 列挙値は値ごとに決まる色相でバッジ表示する (表示専用)。OFF 時は素の文字列。
            // 長い値は他の型と同じくグリッド CSS の ellipsis で省略されるため、
            // ホバーで元の文字列を確認できるようにする (#647)。行×列に比例して
            // 描画されるため native title ではなく `cellTooltipProps` (共有
            // ツールチップ + イベント委譲、#884) を使う。
            if (!richCellRendering) {
              return (
                <span className="cell-string" {...cellTooltipProps(raw)}>
                  {raw}
                </span>
              );
            }
            return (
              <span
                className="cell-enum-badge"
                {...cellTooltipProps(raw)}
                style={{ "--enum-hue": enumBadgeHue(raw) } as CSSProperties}
              >
                {raw}
              </span>
            );
          }
          if (effectiveKind === "binary") {
            const s = String(v);
            const label = t("gridBlobBytes", { size: formatBytes(Math.floor(s.length / 2)) });
            const { preview } = truncateHexPreview(s);
            return (
              <span className="cell-binary" {...cellTooltipProps(`${label} — 0x${s}`)}>
                <span className="cell-binary-tag">{label}</span>0x{preview}
              </span>
            );
          }
          // 既定 (string) カテゴリ。JSON/日時/バイナリ/列挙と同じく、グリッドの
          // ellipsis で省略された長文をホバーで確認できるようにする。行×列に
          // 比例して描画されるセルなので、native title ではなく共有ツールチップ +
          // イベント委譲 (`cellTooltipProps`、#884) を使う — 可視行 (仮想化後) ×
          // 列数ぶん `Tooltip` インスタンスを乗せる素朴な全置換は、スクロールの
          // たびに大量のマウント/アンマウントを引き起こし性能リスクがあるため。
          const rawStr = String(v);
          return (
            <span className="cell-string" {...cellTooltipProps(rawStr)}>
              {rawStr}
            </span>
          );
        },
      };
    });
  }, [
    columns,
    columnKinds,
    columnMeta,
    t,
    enableColumnControls,
    richCellRendering,
    locale,
    colFormats,
    columnStats,
    heatPaletteKey,
  ]);

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
      columnOrder,
      columnVisibility,
      columnPinning,
      ...(paginationState ? { pagination: paginationState } : {}),
    },
    onSortingChange: handleSortingChange,
    onColumnFiltersChange: handleColumnFiltersChange,
    onColumnSizingChange: handleColumnSizingChange,
    onColumnOrderChange: handleColumnOrderChange,
    onColumnVisibilityChange: handleColumnVisibilityChange,
    onColumnPinningChange: (updater) => {
      const prev = columnPinningRef.current;
      const nextRaw = typeof updater === "function" ? updater(prev) : updater;
      const next = { left: nextRaw.left ?? [], right: nextRaw.right ?? [] };
      setColumnPinning(next);
      persistColumnState({ pinning: next });
    },
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
  // Rectangular range selection: anchor (where Shift-extension started)
  // and focus (the moving end = active cell). Both are ORIGINAL row/column
  // indices; the visible rectangle is derived from the current display order so
  // it stays a contiguous block under sort/filter/reorder/hide.
  const [selection, setSelection] = useState<{
    anchor: { rowIdx: number; colIdx: number };
    focus: { rowIdx: number; colIdx: number };
  } | null>(null);
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

  // Bulk-edit dialog (#596): when open, snapshots the selection rectangle's
  // original row indices and column indices, plus the value being typed.
  const [bulkEdit, setBulkEdit] = useState<
    { rowIndices: number[]; colIndices: number[]; value: string } | null
  >(null);

  // Row inspector: when open, shows the active cell's row vertically.
  const [inspectorOpen, setInspectorOpen] = useState(false);

  // Open per-column filter popup: which column, and the anchor rect of the
  // header's filter icon (captured at click for portal positioning).
  const [filterMenu, setFilterMenu] = useState<{ colIdx: number; anchor: DOMRect } | null>(null);

  // Column quick-stats popover (#524): which column + the anchor rect of the
  // header control that opened it (reuses the filter icon's rect).
  const [statsMenu, setStatsMenu] = useState<{ colIdx: number; anchor: DOMRect } | null>(null);

  useEffect(
    () => () => {
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    },
    [],
  );

  const runCopy = async (text: string) => {
    setCopyMenu(null);
    const ok = await copyToClipboard(text);
    if (!ok) {
      toast.error(t("clipboardCopyFailed"));
      return;
    }
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
  // UPDATE/DELETE mutate a real row, so they stay gated on a resolved table —
  // unlike "copy as INSERT" (below), which tolerates an ambiguous table via a
  // fallback name.
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

  // "Copy as INSERT" for one or more selected rows (#601). Unlike
  // UPDATE/DELETE this only ever reads data, so it works even without a
  // resolvable primary key, and even without a resolvable target table (a
  // JOIN / free-form query result falls back to a placeholder table name and
  // warns via toast — `buildInsertClipboard`'s `tableResolved` flag).
  const copyRowsAsInsert = (rowIndices: number[], combineValues: boolean) => {
    const selectedRows = rowIndices.map((i) => rows[i]).filter((r): r is CellValue[] => !!r);
    if (selectedRows.length === 0 || columns.length === 0) return;
    const result = buildInsertClipboard(
      {
        driver: rowSqlDriver ?? "mysql",
        database: rowSqlDatabase ?? "",
        table: rowSqlTable,
        columns,
        rows: selectedRows,
      },
      combineValues,
    );
    if (!result.sql) return;
    if (!result.tableResolved) {
      toast.info(t("gridCopyAsInsertAmbiguousTable"));
    }
    void runCopy(result.sql);
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

  // Buffer one value across a rectangle of cells (#596). Shared by the
  // bulk-edit dialog and the right-click "set value" shortcuts, so both paths
  // get the same editability/validity rules and the same result toast.
  // Editability and per-cell type validity are decided by `planBulkCellEdit`;
  // skipped cells (read-only column or invalid value) are surfaced via a toast.
  const applyValueToCells = (
    rowIndices: number[],
    colIndices: number[],
    value: string,
  ) => {
    if (!onBulkEdit) return;
    const plan = planBulkCellEdit({
      rows,
      columns,
      pkIndices: pkIndices ?? [],
      rowIndices,
      colIndices,
      value,
      isColEditable: (c) => editableColumns?.[c] ?? false,
      validate: (c, v) => validateEdit?.(c, v) ?? null,
    });
    if (plan.applied.length === 0 && plan.unchanged.length === 0) {
      toast.error(t("gridBulkEditNoneApplied"));
      return;
    }
    // `unchanged` は「すでにその値」のセル。新しい編集は積まないが、そこに残って
    // いる保留編集は解除したいので `applied` と一緒に渡す。
    onBulkEdit([...plan.applied, ...plan.unchanged]);
    if (plan.applied.length === 0) {
      toast.info(t("gridBulkEditAllUnchanged", { cells: plan.unchanged.length }));
      return;
    }
    const skipped =
      plan.skippedReadonly + plan.skippedInvalid + plan.unchanged.length;
    if (skipped > 0) {
      toast.info(
        t("gridBulkEditAppliedSkipped", { cells: plan.applied.length, skipped }),
      );
    } else {
      toast.success(t("gridBulkEditApplied", { cells: plan.applied.length }));
    }
  };

  // Apply the bulk-edit dialog's single value to every selected cell (#596).
  const applyBulkEdit = () => {
    const pending = bulkEdit;
    setBulkEdit(null);
    if (!pending) return;
    applyValueToCells(pending.rowIndices, pending.colIndices, pending.value);
  };

  const visibleRows = table.getRowModel().rows;
  // Original column indices in their current *display* order (reorder/hide
  // aware). Keyboard navigation steps through this; data lookups use the
  // original index it yields.
  const visibleColIds = table.getVisibleLeafColumns().map((c) => Number(c.id));
  const totalRows = rows.length;
  const hasColumnFilter = columnFilters.length > 0;
  const hasGlobalFilter = (globalFilter ?? "").trim().length > 0;
  const isFiltered = enableColumnControls && (hasColumnFilter || hasGlobalFilter);
  // Multi-column sort summary: surface a clear-all affordance when more
  // than one sort key is active (single-column sort clears via its own cycle).
  const multiSortActive = enableColumnControls && sorting.length > 1;

  // Resolve the range selection into the set of original row indices and
  // column ids it covers, plus the display bounds (for copy ordering). Derived
  // from the current display order so the rectangle stays contiguous even after
  // sort/filter/reorder/hide. Returns null when there is no multi-cell range.
  const selectionRect = useMemo(() => {
    if (!selection) return null;
    const aVis = visibleRows.findIndex((r) => r.index === selection.anchor.rowIdx);
    const fVis = visibleRows.findIndex((r) => r.index === selection.focus.rowIdx);
    const aCol = visibleColIds.indexOf(selection.anchor.colIdx);
    const fCol = visibleColIds.indexOf(selection.focus.colIdx);
    if (aVis < 0 || fVis < 0 || aCol < 0 || fCol < 0) return null;
    const r0 = Math.min(aVis, fVis);
    const r1 = Math.max(aVis, fVis);
    const c0 = Math.min(aCol, fCol);
    const c1 = Math.max(aCol, fCol);
    // A single cell isn't a "range" — let plain copy handle it.
    if (r0 === r1 && c0 === c1) return null;
    const rowIndexSet = new Set(visibleRows.slice(r0, r1 + 1).map((r) => r.index));
    const colIdSet = new Set(visibleColIds.slice(c0, c1 + 1));
    return { r0, r1, c0, c1, rowIndexSet, colIdSet };
  }, [selection, visibleRows, visibleColIds]);

  /**
   * Applies a right-click "set value" shortcut (`quickSetValues.ts`).
   *
   * Scope mirrors the bulk-edit dialog: when the clicked cell sits inside an
   * active rectangular selection, the value goes to the whole rectangle;
   * otherwise it goes to just that cell. Either way the change is *buffered*
   * like any inline edit — nothing reaches the database until Apply.
   */
  const applyQuickSet = (rowIdx: number, colIdx: number, value: string) => {
    const inSelection =
      !!selectionRect &&
      selectionRect.rowIndexSet.has(rowIdx) &&
      selectionRect.colIdSet.has(colIdx);
    if (inSelection && onBulkEdit) {
      applyValueToCells(
        visibleRows.slice(selectionRect.r0, selectionRect.r1 + 1).map((r) => r.index),
        visibleColIds.slice(selectionRect.c0, selectionRect.c1 + 1),
        value,
      );
      return;
    }
    const col = columns[colIdx];
    const row = rows[rowIdx];
    if (!col || !row || !onSetCellEdit) return;
    if (validateEdit?.(colIdx, value)) {
      toast.error(t("gridQuickSetInvalid"));
      return;
    }
    // Setting the value the cell already holds clears any buffered edit
    // instead of recording a no-op one.
    const rowKey = rowEditKey(row, pkIndices ?? [], rowIdx);
    onSetCellEdit(rowKey, colIdx, editIsNoop(value, col, row[colIdx]) ? null : value);
  };

  // Live aggregate of the selected rectangle, surfaced to the parent's status
  // bar (#523). Null when there is no multi-cell range so the summary hides.
  const selectionStats = useMemo<SelectionSummary | null>(() => {
    if (!selectionRect) return null;
    const cells: CellValue[] = [];
    for (const ri of selectionRect.rowIndexSet) {
      for (const ci of selectionRect.colIdSet) {
        cells.push(rows[ri]?.[ci] ?? null);
      }
    }
    return computeSelectionSummary(cells);
  }, [selectionRect, rows]);
  // Push the summary up only when its *value* changes. The effect must key off a
  // primitive — `selectionStats` is a fresh object each render (its memo deps
  // churn under TanStack's row/column models), so depending on its identity would
  // fire the effect every render and the parent setState would loop infinitely.
  const selectionStatsKey = selectionStats
    ? [
        selectionStats.count,
        selectionStats.nonNullCount,
        selectionStats.numericCount,
        selectionStats.sum,
        selectionStats.avg,
        selectionStats.min,
        selectionStats.max,
      ].join("|")
    : null;
  const selectionStatsRef = useRef(selectionStats);
  selectionStatsRef.current = selectionStats;
  useEffect(() => {
    onSelectionSummary?.(selectionStatsRef.current);
  }, [selectionStatsKey, onSelectionSummary]);
  // Clear the parent's summary when this grid unmounts (e.g. tab switch).
  useEffect(() => () => onSelectionSummary?.(null), [onSelectionSummary]);

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

  // Move the active cell *and* clear any range selection (plain navigation).
  const moveActive = (newRowIdx: number, newColIdx: number) => {
    setSelection(null);
    navigateCell(newRowIdx, newColIdx);
  };

  // Extend the range selection to the given cell (Shift navigation / click).
  // The anchor is the previous active cell when no selection exists yet.
  const extendSelectionTo = (newRowIdx: number, newColIdx: number) => {
    const anchor = selection?.anchor ?? activeCell ?? { rowIdx: newRowIdx, colIdx: newColIdx };
    setSelection({ anchor, focus: { rowIdx: newRowIdx, colIdx: newColIdx } });
    navigateCell(newRowIdx, newColIdx);
  };

  // Copy the current selection (or the active cell) as TSV using *real* values
  // (display formatting is for the grid only). `withHeaders` prepends the column
  // names of the covered columns.
  const copySelection = (withHeaders: boolean) => {
    if (selectionRect) {
      const rowIdxs = visibleRows.slice(selectionRect.r0, selectionRect.r1 + 1).map((r) => r.index);
      const colIds = visibleColIds.slice(selectionRect.c0, selectionRect.c1 + 1);
      const lines: string[] = [];
      if (withHeaders) lines.push(colIds.map((ci) => columns[ci]?.name ?? "").join("\t"));
      for (const ri of rowIdxs) {
        lines.push(colIds.map((ci) => cellToText(rows[ri]?.[ci] ?? null)).join("\t"));
      }
      void runCopy(lines.join("\n"));
      return;
    }
    if (activeCell) {
      if (withHeaders) {
        void runCopy(
          `${columns[activeCell.colIdx]?.name ?? ""}\n${cellToText(rows[activeCell.rowIdx]?.[activeCell.colIdx] ?? null)}`,
        );
      } else {
        copyCell(activeCell.rowIdx, activeCell.colIdx);
      }
    }
  };

  // Clipboard paste → multi-cell bulk edit (#793). Symmetric to `copySelection`:
  // pastes a TSV/CSV block from the clipboard, expanding from the active
  // rectangular selection's top-left corner (or the active cell) into the grid's
  // *display* order. A single pasted value onto an active rectangle fills the
  // whole rectangle via the existing `planBulkCellEdit` (#596) path instead of a
  // bespoke 1x1 case; anything larger goes through `planPasteEdit`.
  const handleGridPaste = (e: React.ClipboardEvent<HTMLTableElement>) => {
    // The inline cell editor (a plain <input>) handles its own paste natively;
    // only intercept when a grid cell itself has focus.
    if (editing || !editable || !onBulkEdit) return;
    const text = e.clipboardData?.getData("text/plain") ?? "";
    if (!text) return;
    const grid = parseClipboardGrid(text);
    if (grid.length === 0 || grid[0].length === 0) return;
    e.preventDefault();

    if (grid.length === 1 && grid[0].length === 1 && selectionRect) {
      applyValueToCells(
        visibleRows.slice(selectionRect.r0, selectionRect.r1 + 1).map((r) => r.index),
        visibleColIds.slice(selectionRect.c0, selectionRect.c1 + 1),
        grid[0][0],
      );
      return;
    }

    const anchorVis = selectionRect
      ? selectionRect.r0
      : visibleRows.findIndex((r) => r.index === activeCell?.rowIdx);
    const anchorColPos = selectionRect ? selectionRect.c0 : visibleColIds.indexOf(activeCell?.colIdx ?? -1);
    if (anchorVis < 0 || anchorColPos < 0) return;

    const maxCols = Math.max(...grid.map((r) => r.length));
    const targetRowIndices = visibleRows.slice(anchorVis, anchorVis + grid.length).map((r) => r.index);
    const targetColIndices = visibleColIds.slice(anchorColPos, anchorColPos + maxCols);

    const plan = planPasteEdit({
      grid,
      rows,
      columns,
      pkIndices: pkIndices ?? [],
      targetRowIndices,
      targetColIndices,
      isColEditable: (c) => editableColumns?.[c] ?? false,
      validate: (c, v) => validateEdit?.(c, v) ?? null,
    });

    if (plan.applied.length === 0 && plan.unchanged.length === 0) {
      toast.error(t("gridPasteNoneApplied"));
      return;
    }
    onBulkEdit([...plan.applied, ...plan.unchanged]);
    if (plan.applied.length === 0) {
      toast.info(t("gridPasteAllUnchanged", { cells: plan.unchanged.length }));
      return;
    }
    const skipped =
      plan.skippedReadonly + plan.skippedInvalid + plan.skippedOutOfBounds + plan.unchanged.length;
    if (skipped > 0) {
      toast.info(t("gridPasteAppliedSkipped", { cells: plan.applied.length, skipped }));
    } else {
      toast.success(t("gridPasteApplied", { cells: plan.applied.length }));
    }
  };

  // Delete/Backspace on a focused (non-editing) cell clears the selection (or
  // just the active cell) to NULL (#793) — the same "set value" path the
  // right-click quick-set / bulk-edit dialog use, so read-only columns and
  // NOT NULL violations are skipped with the same toast, not silently dropped.
  const clearSelectedCells = () => {
    if (!editable || !onBulkEdit) return;
    if (selectionRect) {
      applyValueToCells(
        visibleRows.slice(selectionRect.r0, selectionRect.r1 + 1).map((r) => r.index),
        visibleColIds.slice(selectionRect.c0, selectionRect.c1 + 1),
        "NULL",
      );
      return;
    }
    if (activeCell) {
      applyValueToCells([activeCell.rowIdx], [activeCell.colIdx], "NULL");
    }
  };

  // Row virtualization. Cells are single-line (`white-space: nowrap` +
  // ellipsis), so rows are uniform height; we still let the virtualizer
  // `measureElement` the real height so it follows the font-scale setting and
  // the occasional taller row (open inline editor). `estimateSize` only seeds
  // the first paint. When `scrollContainerRef` is absent (preview panes) we
  // render every row, so `virtualize` gates whether the virtual items are used.
  const virtualize = !!scrollContainerRef;
  // Seed the virtual row height from the active density preset. The exact
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
  // Total column count (row-index + visible data columns + filler) for spacer
  // colSpan. Uses the visible leaf count so hidden columns don't inflate
  // the virtual spacer span.
  const totalColCount = visibleColIds.length + 2;

  // ── 結果内検索 (#644) のナビゲーション ──
  // 要求はワンショットの prop (`findNav`) で届く。ページング表示ではヒットの
  // 属するページへ先に移動する必要があり、ページ切替後の再レンダーを待ってから
  // スクロール/フォーカスするため、要求を ref に保留して毎レンダーの効果で消化する。
  const pendingFindNavRef = useRef<GridFindNav | null>(null);
  const findNavSeq = findNav?.seq ?? null;
  useEffect(() => {
    if (!findNav) return;
    pendingFindNavRef.current = findNav;
    if (paginationState && onPaginationChange) {
      // ページング時: ソート/フィルタ適用後・ページ分割前の行モデルからヒット行の
      // 表示位置を求め、そのページへジャンプする。
      const pre = table.getPrePaginationRowModel().rows;
      const pos = pre.findIndex((r) => r.index === findNav.rowIdx);
      if (pos >= 0) {
        const page = Math.floor(pos / paginationState.pageSize);
        if (page !== paginationState.pageIndex) {
          onPaginationChange((p) => ({ ...p, pageIndex: page }));
        }
      }
    }
    // findNav は seq 単調増加のワンショット。seq だけを依存にし、同一要求で
    // 二重発火しないようにする。
  }, [findNavSeq]);
  useEffect(() => {
    const nav = pendingFindNavRef.current;
    if (!nav) return;
    const visIdx = visibleRows.findIndex((r) => r.index === nav.rowIdx);
    if (visIdx < 0) {
      // ページ切替が反映される前なら次レンダーまで保留。列フィルタ等で行自体が
      // 表示されていないなら諦める (件数表示は取得済み行ベースのまま)。
      if (paginationState) {
        const pre = table.getPrePaginationRowModel().rows;
        if (pre.some((r) => r.index === nav.rowIdx)) return;
      }
      pendingFindNavRef.current = null;
      return;
    }
    pendingFindNavRef.current = null;
    if (virtualize) rowVirtualizer.scrollToIndex(visIdx, { align: "auto" });
    if (nav.select) {
      setSelection(null);
      setActiveCell({ rowIdx: nav.rowIdx, colIdx: nav.colIdx });
    }
    if (nav.focusCell) {
      pendingFocusRef.current = { rowIdx: nav.rowIdx, colIdx: nav.colIdx };
    }
  });

  // Grid-level keyboard handler: arrow keys, Tab, Enter, Ctrl+C, etc.
  // Fires on the <table> (bubbled from the focused <td>). When the inline
  // editor is open the input handles its own keys and this handler short-circuits.
  const handleGridKeyDown = (e: React.KeyboardEvent<HTMLTableElement>) => {
    if (editing) return;
    if (!activeCell) return;
    const { rowIdx, colIdx } = activeCell;
    const visIdx = visibleRows.findIndex((r) => r.index === rowIdx);
    if (visIdx < 0) return;
    const rowCount = visibleRows.length;
    // Position of the active column within the current display order.
    const colPos = visibleColIds.indexOf(colIdx);
    const lastColPos = visibleColIds.length - 1;
    const firstCol = visibleColIds[0] ?? 0;
    const lastCol = visibleColIds[lastColPos] ?? 0;
    const PAGE_ROWS = 10;
    // Plain move clears the selection; Shift+move extends a rectangular range.
    const go = (r: number, c: number) => (e.shiftKey ? extendSelectionTo(r, c) : moveActive(r, c));

    // グリッド系ショートカット (行インスペクタ/Undo/Redo/コピー/コピー+ヘッダ、
    // #681)。既定コンボ (Alt+Enter 等) はナビゲーション用の switch と衝突しない
    // が、リバインドで任意のキーになり得るため switch より先に単独で突き合わせる。
    // Redo は従来からの Ctrl/Cmd+Y も後方互換で残す (再割り当て対象外の別名)。
    const ne = e.nativeEvent;
    if (comboMatchesEvent(effectiveGridBindings.gridInspector, ne)) {
      e.preventDefault();
      setInspectorOpen((o) => !o);
      return;
    }
    if (comboMatchesEvent(effectiveGridBindings.gridUndo, ne)) {
      e.preventDefault();
      // App レベルのグローバル Undo/Redo ハンドラ (window の keydown リスナ) が
      // 同じキー押下を二重に処理してしまわないよう、ここで止める
      // (CodeRabbit レビュー対応: stopPropagation しないと 1 回の押下で 2 回
      // undo/redo が走っていた)。
      e.stopPropagation();
      onUndoEdit?.();
      return;
    }
    if (
      comboMatchesEvent(effectiveGridBindings.gridRedo, ne) ||
      ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === "y" || e.key === "Y"))
    ) {
      e.preventDefault();
      e.stopPropagation();
      onRedoEdit?.();
      return;
    }
    if (comboMatchesEvent(effectiveGridBindings.gridCopyHeaders, ne)) {
      e.preventDefault();
      copySelection(true);
      return;
    }
    if (comboMatchesEvent(effectiveGridBindings.gridCopy, ne)) {
      e.preventDefault();
      copySelection(false);
      return;
    }

    switch (e.key) {
      case "ArrowUp":
        e.preventDefault();
        if (visIdx > 0) go(visibleRows[visIdx - 1].index, colIdx);
        break;
      case "ArrowDown":
        e.preventDefault();
        if (visIdx < rowCount - 1) go(visibleRows[visIdx + 1].index, colIdx);
        break;
      case "ArrowLeft":
        // gridPagePrev/gridPageNext (既定 Alt+←/→、#681) は App レベルのページ
        // 送りに譲り、ここでは何もしない (preventDefault もしない) — bubble した
        // イベントをそちらが拾う。セル移動と同時発火するのを防ぐ。リバインド後も
        // 正しく譲れるよう、素の e.altKey ではなく解決済みコンボそのものを見る
        // (#681 レビュー対応)。
        if (
          comboMatchesEvent(effectiveGridBindings.gridPageNext, ne) ||
          comboMatchesEvent(effectiveGridBindings.gridPagePrev, ne)
        ) {
          break;
        }
        e.preventDefault();
        if (colPos > 0) go(rowIdx, visibleColIds[colPos - 1]);
        break;
      case "ArrowRight":
        // 同上。
        if (
          comboMatchesEvent(effectiveGridBindings.gridPageNext, ne) ||
          comboMatchesEvent(effectiveGridBindings.gridPagePrev, ne)
        ) {
          break;
        }
        e.preventDefault();
        if (colPos >= 0 && colPos < lastColPos) go(rowIdx, visibleColIds[colPos + 1]);
        break;
      case "PageUp": {
        e.preventDefault();
        const target = Math.max(0, visIdx - PAGE_ROWS);
        if (target !== visIdx) go(visibleRows[target].index, colIdx);
        break;
      }
      case "PageDown": {
        e.preventDefault();
        const target = Math.min(rowCount - 1, visIdx + PAGE_ROWS);
        if (target !== visIdx) go(visibleRows[target].index, colIdx);
        break;
      }
      case "Tab":
        // Tab always moves a single active cell (never extends a selection).
        e.preventDefault();
        if (!e.shiftKey) {
          if (colPos < lastColPos) moveActive(rowIdx, visibleColIds[colPos + 1]);
          else if (visIdx < rowCount - 1) moveActive(visibleRows[visIdx + 1].index, firstCol);
        } else {
          if (colPos > 0) moveActive(rowIdx, visibleColIds[colPos - 1]);
          else if (visIdx > 0) moveActive(visibleRows[visIdx - 1].index, lastCol);
        }
        break;
      case "Home":
        e.preventDefault();
        go(rowIdx, firstCol);
        break;
      case "End":
        e.preventDefault();
        go(rowIdx, lastCol);
        break;
      case "Escape":
        e.preventDefault();
        if (inspectorOpen) setInspectorOpen(false);
        else if (selection) setSelection(null);
        else setActiveCell(null);
        break;
      case "Enter": {
        e.preventDefault();
        // Alt/Option+Enter (行インスペクタトグル) は switch より前段で処理済み。
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
      case "Delete":
      case "Backspace":
        // 編集不可な列やアクティブセルが無い場合は `clearSelectedCells` 側で
        // 何もしない (early return) — その場合はブラウザ既定の挙動 (何もない)
        // に任せるため preventDefault しない。
        if (editable && onBulkEdit && (selectionRect || activeCell)) {
          e.preventDefault();
          clearSelectedCells();
        }
        break;
      default:
        // Printable character → start editing with that char (Undo/Redo/Copy
        // are handled above, before the switch).
        if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1) {
          const colEd = editable && (editableColumns?.[colIdx] ?? false);
          if (colEd && onSetCellEdit) {
            e.preventDefault();
            setEditing({ rowIdx, colIdx, value: e.key });
          }
        }
    }
  };

  // One row's JSX, shared by the virtualized and non-virtualized paths.
  // `rowIdx` is the visible position (drives the row number and zebra parity);
  // `row.index` is the absolute index into `rows` used for edit/changed lookups.
  // `measureIndex` (when virtualizing) wires the row to the virtualizer so its
  // real height is measured.
  const renderRow = (row: Row<RowShape>, rowIdx: number, measureIndex?: number) => {
    // Does this row hold any buffered edit? Drives the row-level pending marker.
    // Looked up by the row's PK-derived identity, like the per-cell
    // lookup below, so it tracks the row across pagination/sort.
    const rowPendingKey = rowEditKey(rows[row.index] ?? [], pkIndices ?? [], row.index);
    const rowHasPending =
      !!pendingEdits?.[rowPendingKey] && Object.keys(pendingEdits[rowPendingKey]).length > 0;
    const rowMarkedDelete = !!pendingDeleteKeys?.has(rowPendingKey);
    // Re-run diff (#597): a row present in this result but not the previous one.
    const rowAdded = !!addedRowIndices?.has(row.index);
    const rowClass = [
      // Zebra striping by visible position. Class-based (not `:nth-of-type`)
      // because the virtualized body inserts spacer `<tr>` that would otherwise
      // flip the parity as you scroll.
      rowIdx % 2 === 1 ? "grid-row-stripe" : "",
      rowHasPending ? "grid-row-pending" : "",
      rowMarkedDelete ? "grid-row-deleting" : "",
      rowAdded ? "grid-row-added" : "",
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
      {row.getVisibleCells().map((cell) => {
        // Resolve original column index from the column id so reorder/hide
        // and pinning don't misalign per-column lookups.
        const colIdx = Number(cell.column.id);
        const v = cell.getValue() as CellValue;
        const kind = columnKinds[colIdx] ?? "string";
        const isNull = v === null || v === undefined;
        const isChanged = changedCells?.[row.index]?.[colIdx] ?? false;
        const colEditable = editable && (editableColumns?.[colIdx] ?? false);
        // Buffered edits are keyed by the row's PK identity, so look
        // them up by `rowEditKey` rather than the array position.
        const rowKey = rowEditKey(
          rows[row.index] ?? [],
          pkIndices ?? [],
          row.index,
        );
        const pendingForRow = pendingEdits?.[rowKey];
        const pendingValue = pendingForRow?.[colIdx];
        const hasPending = pendingValue !== undefined;
        const isEditingHere =
          editing !== null &&
          editing.rowIdx === row.index &&
          editing.colIdx === colIdx;
        const isActiveCell = activeCell?.rowIdx === row.index && activeCell?.colIdx === colIdx;
        const inSelection =
          !!selectionRect && selectionRect.rowIndexSet.has(row.index) && selectionRect.colIdSet.has(colIdx);
        // 結果内検索 (#644) のヒット/現在ヒット。キーは cellRefs と同じ "row:col"。
        const findKey = `${row.index}:${colIdx}`;
        const isFindHit = !!findHits?.has(findKey);
        const isFindCurrent = isFindHit && findCurrentKey === findKey;
        // Live validation of the value being typed, and of an
        // already-buffered value that's sitting invalid in the grid.
        const editError =
          isEditingHere && validateEdit
            ? validateEdit(colIdx, editing!.value)
            : null;
        const pendingError =
          hasPending && !isEditingHere && validateEdit
            ? validateEdit(colIdx, pendingValue)
            : null;
        // Original display string — used both for the input's
        // default contents and to detect "user typed it back to
        // the original" (which clears the pending edit).
        const originalDisplay = isNull ? "" : String(v);
        const pinSide = cell.column.getIsPinned();
        const pinStyle: CSSProperties = pinSide
          ? {
              position: "sticky",
              zIndex: 1,
              ...(pinSide === "left"
                ? { left: ROW_INDEX_WIDTH + cell.column.getStart("left") }
                : { right: cell.column.getAfter("right") }),
            }
          : {};
        const handleDoubleClick = () => {
          // Editable cells edit on double-click; everything else
          // (read-only grids, PK/BLOB columns, preview panes) opens
          // the full-value viewer instead, so the two never collide.
          if (colEditable && onSetCellEdit) {
            setEditing({
              rowIdx: row.index,
              colIdx,
              value: hasPending ? pendingValue : originalDisplay,
            });
            return;
          }
          setViewer({ rowIdx: row.index, colIdx });
        };
        return (
          <td
            key={cell.id}
            role="gridcell"
            tabIndex={isActiveCell ? 0 : -1}
            style={pinStyle}
            ref={(el) => {
              const key = `${row.index}:${colIdx}`;
              if (el) cellRefs.current.set(key, el);
              else cellRefs.current.delete(key);
            }}
            className={`col-${kind} ${isNumericKind(kind) ? "align-right" : ""} ${isNull && !hasPending ? "is-null" : ""} ${isChanged ? "is-changed" : ""} ${hasPending ? "is-pending-edit" : ""} ${colEditable ? "is-editable-cell" : ""} ${editError || pendingError ? "is-invalid-edit" : ""} ${isActiveCell ? "is-active-cell" : ""} ${inSelection ? "is-selected-cell" : ""} ${isFindHit ? "is-find-hit" : ""} ${isFindCurrent ? "is-find-current" : ""} ${pinSide ? `is-pinned is-pinned-${pinSide}` : ""}`}
            // マウス hover 用は行×列に比例するため native title ではなく
            // `cellTooltipProps` (#884) に委譲する。キーボードでの同等手段は
            // 既存の `gridInspector` ショートカット (`CellValueViewer`) が
            // アクティブセルの全文を常に提供済みなので、後退にはならない。
            {...cellTooltipProps(
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
                      // タイトルに文字数を添える。テキスト系の列だけが対象。
                      (kind === "string" || kind === "json") && String(v).length > 40
                      ? `${String(v)}\n(${t("gridCharCount", { count: String(v).length })})`
                      : String(v)
            )}
            onMouseDown={(e) => {
              // Right-click opens the context menu (which can act on the current
              // selection, e.g. bulk edit) — never clear the selection here.
              if (e.button !== 0) return;
              // Shift+click extends a rectangular selection from the active
              // cell; a plain click clears any selection (focus sets active).
              if (e.shiftKey && activeCell) {
                e.preventDefault();
                extendSelectionTo(row.index, colIdx);
              } else if (selection) {
                setSelection(null);
              }
            }}
            onFocus={(e) => {
              if (e.target === e.currentTarget) {
                setActiveCell({ rowIdx: row.index, colIdx });
              }
            }}
            onDoubleClick={handleDoubleClick}
            onContextMenu={(e) => {
              e.preventDefault();
              setCopyMenu({
                x: e.clientX,
                y: e.clientY,
                rowIdx: row.index,
                colIdx,
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
                      const ePos = visibleColIds.indexOf(eColIdx);
                      const lastPos = visibleColIds.length - 1;
                      if (!e.shiftKey) {
                        if (ePos >= 0 && ePos < lastPos) navigateCell(eRowIdx, visibleColIds[ePos + 1]);
                        else if (vi2 >= 0 && vi2 < visibleRows.length - 1)
                          navigateCell(visibleRows[vi2 + 1].index, visibleColIds[0] ?? 0);
                        else navigateCell(eRowIdx, eColIdx);
                      } else {
                        if (ePos > 0) navigateCell(eRowIdx, visibleColIds[ePos - 1]);
                        else if (vi2 > 0)
                          navigateCell(visibleRows[vi2 - 1].index, visibleColIds[lastPos] ?? 0);
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
              // 未適用編集の値は Motion で軽くハイライトする。`key` を
              // pendingValue にして値が変わるたび (= 編集/Undo/Redo のたび) 再マウント
              // させ、入場アニメを再生する。reduced-motion は MotionConfig 配下で
              // 自動的に即時化される。
              <motion.span
                key={pendingValue}
                className={
                  /^null$/i.test(pendingValue.trim())
                    ? "cell-null cell-pending-value"
                    : "cell-pending-value"
                }
                initial={variants.slideUp.initial}
                animate={variants.slideUp.animate}
                transition={transitions.crossfade}
              >
                {/^null$/i.test(pendingValue.trim()) ? t("resultNull") : pendingValue}
              </motion.span>
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
      {(isFiltered || multiSortActive || serverSort || serverFilter) && (
        <Box className="grid-filter-summary">
          {isFiltered && t("gridFilteredCount", { shown: visibleRows.length, total: totalRows })}
          {multiSortActive && (
            <chakra.span>{t("gridSortCount", { n: sorting.length })}</chakra.span>
          )}
          {hasColumnFilter && (
            <chakra.button
              type="button"
              className="grid-filter-clear"
              onClick={clearSortAndFilters}
            >
              {t("gridClearFilters")}
            </chakra.button>
          )}
          {multiSortActive && (
            <chakra.button
              type="button"
              className="grid-filter-clear"
              onClick={clearSorting}
            >
              {t("gridClearSort")}
            </chakra.button>
          )}
          {serverSort && (
            <chakra.span>
              {t("gridServerSortChip", {
                column: serverSort.column,
                dir: t(serverSort.direction === "asc" ? "gridServerSortOptionAsc" : "gridServerSortOptionDesc"),
              })}
            </chakra.span>
          )}
          {serverSort && onSetServerSort && (
            <chakra.button
              type="button"
              className="grid-filter-clear"
              onClick={() => onSetServerSort(serverSort.column, null)}
            >
              {t("gridServerBrowseClear")}
            </chakra.button>
          )}
          {serverFilter && (
            <chakra.span>{t("gridServerFilterChip", { column: serverFilter.column })}</chakra.span>
          )}
          {serverFilter && onSetServerFilter && (
            <chakra.button
              type="button"
              className="grid-filter-clear"
              onClick={() => onSetServerFilter(serverFilter.column, null)}
            >
              {t("gridServerBrowseClear")}
            </chakra.button>
          )}
        </Box>
      )}
      <table
        role="grid"
        style={{ width: ROW_INDEX_WIDTH + table.getTotalSize() }}
        onKeyDown={handleGridKeyDown}
        onPaste={handleGridPaste}
      >
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
              {hg.headers.map((h) => {
                // After reorder/hide the header's array position no longer
                // matches the original column index, so resolve all
                // original-order lookups (kind, name, changed flag, filter,
                // pinning) from the column id (`String(originalIndex)`).
                const colIdx = Number(h.column.id);
                const kind = columnKinds[colIdx] ?? "string";
                const canSort = enableColumnControls && h.column.getCanSort();
                const canResize = h.column.getCanResize();
                const isResizing = h.column.getIsResizing();
                const sortDir = h.column.getIsSorted();
                // Multi-column sort: a rank badge shows each key's
                // priority when more than one column is sorted (Shift+click
                // chains additional keys; plain click resets to single sort).
                const multiSort = sorting.length > 1;
                const sortRank = sortDir && multiSort ? h.column.getSortIndex() + 1 : 0;
                const sortTitle =
                  sortDir === "asc"
                    ? t("gridSortDesc")
                    : sortDir === "desc"
                      ? t("gridSortClear")
                      : t("gridSortAsc");
                const isChangedCol = changedColumns?.[colIdx] ?? false;
                const colFilterActive = isColumnFilterActive(
                  h.column.getFilterValue() as ColumnFilter | undefined,
                );
                const filterLabel = t("gridFilterAria", { column: columns[colIdx]?.name ?? "" });
                const pinSide = h.column.getIsPinned();
                const pinStyle: CSSProperties = pinSide
                  ? {
                      position: "sticky",
                      zIndex: 3,
                      ...(pinSide === "left"
                        ? { left: ROW_INDEX_WIDTH + h.column.getStart("left") }
                        : { right: h.column.getAfter("right") }),
                    }
                  : {};
                return (
                  <th
                    key={h.id}
                    style={pinStyle}
                    className={`col-${kind} ${canSort ? "is-sortable" : ""} ${sortDir ? `is-sorted-${sortDir}` : ""} ${isResizing ? "is-resizing" : ""} ${isChangedCol ? "is-changed-col" : ""} ${colFilterActive ? "is-filtered-col" : ""} ${dragOverColId === h.column.id ? "is-drag-over" : ""} ${dragColId === h.column.id ? "is-dragging-col" : ""} ${pinSide ? `is-pinned is-pinned-${pinSide}` : ""}`}
                    aria-sort={sortDir === "asc" ? "ascending" : sortDir === "desc" ? "descending" : "none"}
                    onDragOver={
                      dragColId
                        ? (e) => {
                            e.preventDefault();
                            if (dragOverColId !== h.column.id) setDragOverColId(h.column.id);
                          }
                        : undefined
                    }
                    onDrop={
                      dragColId
                        ? (e) => {
                            e.preventDefault();
                            reorderColumn(dragColId, h.column.id);
                            setDragColId(null);
                            setDragOverColId(null);
                          }
                        : undefined
                    }
                  >
                    {enableColumnControls ? (
                      <div className="th-inner">
                        <Tooltip label={t("gridDragColumn")}>
                          <chakra.span
                            className="th-drag-grip"
                            draggable
                            role="button"
                            tabIndex={-1}
                            aria-label={t("gridDragColumn")}
                            onDragStart={(e) => {
                              setDragColId(h.column.id);
                              e.dataTransfer.effectAllowed = "move";
                              e.dataTransfer.setData("text/plain", h.column.id);
                            }}
                            onDragEnd={() => {
                              setDragColId(null);
                              setDragOverColId(null);
                            }}
                          >
                            <Icon name="columns" size={ICON_SIZES.sm} />
                          </chakra.span>
                        </Tooltip>
                        <Tooltip label={sortTitle}>
                          <chakra.button
                            type="button"
                            className="th-sort-button"
                            onClick={h.column.getToggleSortingHandler()}
                          >
                            {flexRender(h.column.columnDef.header, h.getContext())}
                            <chakra.span className="th-sort-indicator" aria-hidden>
                              {sortDir === "asc" ? (
                                <Icon name="sort-asc" size={ICON_SIZES.sm} />
                              ) : sortDir === "desc" ? (
                                <Icon name="sort-desc" size={ICON_SIZES.sm} />
                              ) : null}
                              {sortRank > 0 && (
                                <chakra.span
                                  className="th-sort-rank"
                                  aria-label={t("gridSortPriority", { n: sortRank })}
                                >
                                  {sortRank}
                                </chakra.span>
                              )}
                            </chakra.span>
                          </chakra.button>
                        </Tooltip>
                        <Tooltip label={filterLabel}>
                          <chakra.button
                            type="button"
                            className={`th-filter-button ${colFilterActive ? "is-active" : ""}`}
                            onClick={(e) =>
                              setFilterMenu({
                                colIdx,
                                anchor: e.currentTarget.getBoundingClientRect(),
                              })
                            }
                            aria-label={filterLabel}
                            aria-haspopup="dialog"
                            aria-expanded={filterMenu?.colIdx === colIdx}
                          >
                            <Icon name="filter" size={ICON_SIZES.sm} strokeWidth={2.2} />
                          </chakra.button>
                        </Tooltip>
                      </div>
                    ) : (
                      flexRender(h.column.columnDef.header, h.getContext())
                    )}
                    {nullRates && (() => {
                      // 常時表示の NULL 率ミニバー (#911)。取得済み行のうち NULL が
                      // 占める割合を、ヘッダ下端の細い帯として列幅いっぱいに描く。
                      // 塗りは `.cell-databar` / 列統計ポップオーバーと同じ
                      // `accentFill` レシピ (#718) を共有し、色を二重定義しない。
                      // 幅は width ではなく scaleX で表現する (データバーと同じ理由)。
                      // 全列に必ず 1 本描くのでヘッダ高さは列ごとにブレず、密度/
                      // フォントサイズを変えても整列は崩れない。ツールチップは列数
                      // ぶんしか描かれないが、フォーカス不能な装飾要素にタブ
                      // ストップを増やさないよう、共有 Tooltip ではなくセルと同じ
                      // 委譲ツールチップ (hover 専用) に載せる。読み上げ向けの情報は
                      // `aria-label` が持つ。
                      const pct = nullRates[colIdx] ?? 0;
                      const label = t("gridNullBarAria", {
                        column: columns[colIdx]?.name ?? "",
                        percent: pct.toFixed(pct > 0 && pct < 1 ? 1 : 0),
                        count: rows.length.toLocaleString(),
                      });
                      return (
                        <div
                          className="th-nullbar"
                          role="img"
                          aria-label={label}
                          {...cellTooltipProps(label)}
                        >
                          <div
                            className="th-nullbar-fill"
                            style={{ transform: `scaleX(${pct / 100})` }}
                          />
                        </div>
                      );
                    })()}
                    {canResize && (
                      <Tooltip label={t("gridResizeColumn")}>
                        <div
                          className={`th-resize-handle ${isResizing ? "is-resizing" : ""}`}
                          onMouseDown={h.getResizeHandler()}
                          onTouchStart={h.getResizeHandler()}
                          onDoubleClick={() => h.column.resetSize()}
                          aria-hidden
                        />
                      </Tooltip>
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
        {footerEnabled && (
          // 集計フッター行 (#645)。ヘッダと同じ leaf 列順 (reorder/hide/pin 反映) で
          // 走査し、行番号セルと末尾フィラーを再現して桁を揃える。ピン留め列は
          // ヘッダ/本体と同じ sticky オフセットに bottom:0 を重ねて縦横に固定する。
          <tfoot>
            <tr role="row" aria-label={t("gridFooterAria")}>
              <td className="row-index grid-footer-cell" aria-hidden />
              {table.getHeaderGroups()[0]?.headers.map((h) => {
                const colIdx = Number(h.column.id);
                const kind = columnKinds[colIdx] ?? "string";
                const fn = resolveFooterFn(footerAggs[h.column.id], kind);
                const stats = footerStats?.[colIdx];
                const cell = stats ? computeFooterCell(stats, fn) : null;
                const text = cell ? footerCellText(cell) : "";
                const pinSide = h.column.getIsPinned();
                const pinStyle: CSSProperties = pinSide
                  ? {
                      zIndex: 4,
                      ...(pinSide === "left"
                        ? { left: ROW_INDEX_WIDTH + h.column.getStart("left") }
                        : { right: h.column.getAfter("right") }),
                    }
                  : {};
                const label = t(FOOTER_FN_LABEL[fn]);
                const footerTd = (
                  <td
                    key={h.id}
                    style={pinStyle}
                    className={`grid-footer-cell col-${kind} ${pinSide ? `is-pinned is-pinned-${pinSide}` : ""}`}
                  >
                    {fn !== "none" && (
                      <span className="grid-footer-inner">
                        <span className="grid-footer-fn">{label}</span>
                        <motion.span
                          key={text}
                          className="grid-footer-val"
                          initial={{ opacity: 0.35 }}
                          animate={{ opacity: 1 }}
                          transition={transitions.crossfade}
                        >
                          {text}
                        </motion.span>
                      </span>
                    )}
                  </td>
                );
                // 列数ぶんしか描画されない (行数には比例しない) ため、共有
                // `Tooltip` を直接使う (#884)。
                return text ? (
                  <Tooltip key={h.id} label={`${label}: ${text}`} focusableWrapper>
                    {footerTd}
                  </Tooltip>
                ) : (
                  footerTd
                );
              })}
              <td className="col-filler grid-footer-cell" aria-hidden />
            </tr>
          </tfoot>
        )}
      </table>
      {copyMenu && (
        <ContextMenu
          x={copyMenu.x}
          y={copyMenu.y}
          onClose={() => setCopyMenu(null)}
          items={[
            {
              label: t("gridCopyCell"),
              icon: "copy",
              shortcut: formatCombo(effectiveGridBindings.gridCopy),
              onSelect: () => copyCell(copyMenu.rowIdx, copyMenu.colIdx),
            },
            { label: t("gridCopyRow"), onSelect: () => copyRow(copyMenu.rowIdx) },
            {
              label: t("gridCopyRowWithHeaders"),
              shortcut: formatCombo(effectiveGridBindings.gridCopyHeaders),
              onSelect: () => copyRowWithHeaders(copyMenu.rowIdx),
            },
            // 選択範囲のエクスポート/コピー (#917): 矩形選択が 2 セル以上を
            // 覆っているときだけ出す (単一セルは上の「値をコピー」で足りる)。
            // 選択範囲の列/行部分集合を一度だけ `onExportSelection` へ渡し、
            // `ResultGrid` がそれを `ExportModal` の "selection" スコープとして開く。
            ...(selectionRect && onExportSelection
              ? [
                  {
                    label: t("gridExportSelection", {
                      count: selectionRect.rowIndexSet.size * selectionRect.colIdSet.size,
                    }),
                    icon: "download" as const,
                    title: t("gridExportSelectionTitle"),
                    onSelect: () => {
                      const rowIdxs = visibleRows
                        .slice(selectionRect.r0, selectionRect.r1 + 1)
                        .map((r) => r.index);
                      const colIds = visibleColIds.slice(selectionRect.c0, selectionRect.c1 + 1);
                      setCopyMenu(null);
                      onExportSelection({
                        columns: colIds.map((ci) => columns[ci]).filter((c): c is Column => !!c),
                        rows: rowIdxs.map((ri) => colIds.map((ci) => rows[ri]?.[ci] ?? null)),
                      });
                    },
                  },
                ]
              : []),
            // セル値のクイックフィルタ (#914)。探索で最頻用の「この値で絞る」を
            // 右クリック 1 手にする。新しいフィルタモデルは作らず、既存の 2 経路
            // (table タブのサーバ側 WHERE / クエリ結果のクライアント側
            // ColumnFilter) のどちらかへ `quickFilter.ts` が値を流し込むだけなので、
            // フィルタチップやヘッダーのアクティブ表示はそのまま再利用される。
            ...(() => {
              const col = columns[copyMenu.colIdx];
              // サーバ側フィルタが使えるのは table タブのみ。それ以外は
              // クライアント側へ載せるが、列フィルタ自体が無効な文脈
              // (`enableColumnControls: false` のプレビュー等) では出さない。
              if (!col || !(onSetServerFilter || enableColumnControls)) return [];
              const kind = columnKinds[copyMenu.colIdx] ?? "string";
              // BLOB は手元に 16 進表現しか無く、それで一致比較しても意味を成さない。
              if (kind === "binary") return [];
              const value = rows[copyMenu.rowIdx]?.[copyMenu.colIdx] ?? null;
              const numeric = isNumericFilterKind(kind);
              const nullCell = isNullCell(value);
              const shown = quickFilterValueLabel(value);
              const title = onSetServerFilter
                ? t("gridQuickFilterTitleServer")
                : t("gridQuickFilterTitleClient");
              const apply = (mode: QuickFilterMode) => {
                setCopyMenu(null);
                if (onSetServerFilter) {
                  onSetServerFilter(col.name, serverQuickFilter(value, mode, numeric));
                } else {
                  table
                    .getColumn(String(copyMenu.colIdx))
                    ?.setFilterValue(clientQuickFilter(value, mode, numeric));
                }
              };
              return [
                { separator: true as const },
                {
                  label: nullCell
                    ? t("gridQuickFilterEqNull")
                    : t("gridQuickFilterEq", { value: shown }),
                  icon: "filter" as const,
                  title,
                  onSelect: () => apply("eq"),
                },
                {
                  label: nullCell
                    ? t("gridQuickFilterNeNull")
                    : t("gridQuickFilterNe", { value: shown }),
                  title,
                  onSelect: () => apply("ne"),
                },
              ];
            })(),
            ...(() => {
              // "Copy as INSERT" (#601): operates on every row covered by an
              // active multi-row range selection, or just the clicked row
              // when there is none/it's a single row. Unlike UPDATE/DELETE
              // (below) it stays available even without a resolved target
              // table — `copyRowsAsInsert` falls back to a placeholder name
              // and warns instead.
              const insertRowIndices =
                selectionRect && selectionRect.rowIndexSet.size > 1
                  ? Array.from(selectionRect.rowIndexSet)
                  : [copyMenu.rowIdx];
              const multiRow = insertRowIndices.length > 1;
              return [
                { separator: true as const },
                multiRow
                  ? {
                      label: t("gridCopyAsInsertRows", { count: insertRowIndices.length }),
                      title: t("gridCopyAsInsertRowsTitle"),
                      onSelect: () => copyRowsAsInsert(insertRowIndices, false),
                    }
                  : {
                      label: t("gridCopyAsInsert"),
                      onSelect: () => copyRowsAsInsert(insertRowIndices, false),
                    },
                ...(multiRow
                  ? [
                      {
                        label: t("gridCopyAsInsertRowsCombined", {
                          count: insertRowIndices.length,
                        }),
                        title: t("gridCopyAsInsertRowsCombinedTitle"),
                        onSelect: () => copyRowsAsInsert(insertRowIndices, true),
                      },
                    ]
                  : []),
                ...(rowSqlAvailable
                  ? [
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
              ];
            })(),
            // 行の複製 (#820): クリックした行の値を種に行追加モーダルを開く。
            // `onRequestInsertRow` と同じ表示条件 (編集可能なテーブルタブ) で
            // App から渡される。
            ...(onDuplicateRow
              ? [
                  { separator: true as const },
                  {
                    label: t("gridDuplicateRow"),
                    title: t("gridDuplicateRowTitle"),
                    onSelect: () => {
                      const row = rows[copyMenu.rowIdx];
                      setCopyMenu(null);
                      if (row) onDuplicateRow(rowToPendingInsert(row));
                    },
                  },
                ]
              : []),
            // 値のワンクリック設定: NULL / 空文字 / 0 / true / false / 現在日時
            // といった「毎回手で打つのが煩わしい定番値」を列の型に応じて出す。
            // 表示条件はインライン編集そのもの (編集可能な列 + PK 解決済み) と
            // 同じで、書き込みではなく既存の pending 編集バッファに載せる。
            ...(() => {
              const colEditable =
                editable && (editableColumns?.[copyMenu.colIdx] ?? false) && !!onSetCellEdit;
              if (!colEditable) return [];
              const col = columns[copyMenu.colIdx];
              if (!col) return [];
              const meta = columnMeta?.find((m) => m.name === col.name) ?? null;
              // 矩形選択がクリックしたセルを含むときは選択範囲全体が対象。
              // ラベルは短いまま、対象範囲はツールチップで伝える。
              const selectedCells =
                selectionRect &&
                selectionRect.rowIndexSet.has(copyMenu.rowIdx) &&
                selectionRect.colIdSet.has(copyMenu.colIdx) &&
                onBulkEdit
                  ? selectionRect.rowIndexSet.size * selectionRect.colIdSet.size
                  : 0;
              const scopeNote =
                selectedCells > 1
                  ? t("gridQuickSetSelectionNote", { count: selectedCells })
                  : null;
              const items = quickSetOptions({ column: col, meta, now: new Date(), driver: rowSqlDriver }).map(
                (opt) => {
                  const note = opt.noteKey ? t(opt.noteKey) : null;
                  const title = opt.disabledReason
                    ? t(opt.disabledReason)
                    : [scopeNote, note].filter(Boolean).join("\n\n") || undefined;
                  return {
                    label: t(opt.labelKey),
                    title,
                    disabled: !!opt.disabledReason,
                    onSelect: () => {
                      const rk = copyMenu.rowIdx;
                      const ck = copyMenu.colIdx;
                      // 時刻系はメニューを開いてから選ぶまでの間に古くなるので、
                      // 確定した瞬間の時計で組み立て直す。
                      const value = opt.dynamic
                        ? resolveDynamicValue(opt.dynamic, new Date())
                        : opt.value;
                      setCopyMenu(null);
                      applyQuickSet(rk, ck, value);
                    },
                  };
                },
              );
              // 保留中の編集があるセルだけ、その 1 セルぶんを取り消す導線を足す
              // (Undo は編集履歴全体を 1 手戻すので、狙ったセルだけ戻したいとき用)。
              const rowKey = rowEditKey(
                rows[copyMenu.rowIdx] ?? [],
                pkIndices ?? [],
                copyMenu.rowIdx,
              );
              if (pendingEdits?.[rowKey]?.[copyMenu.colIdx] !== undefined) {
                items.push({
                  label: t("gridQuickSetRevert"),
                  title: undefined,
                  disabled: false,
                  onSelect: () => {
                    const ck = copyMenu.colIdx;
                    setCopyMenu(null);
                    onSetCellEdit?.(rowKey, ck, null);
                  },
                });
              }
              return [{ separator: true as const }, ...items];
            })(),
            // 一括編集 (#596): 矩形選択がある編集可能なテーブルでのみ、
            // 「選択セルに値を設定」を出す。PK が無いテーブルは行を特定できないため非表示。
            ...(onBulkEdit && editable && selectionRect && (pkIndices?.length ?? 0) > 0
              ? [
                  { separator: true as const },
                  {
                    label: t("gridBulkEditSelection", {
                      count:
                        selectionRect.rowIndexSet.size * selectionRect.colIdSet.size,
                    }),
                    title: t("gridBulkEditSelectionTitle"),
                    onSelect: () => {
                      const rowIndices = visibleRows
                        .slice(selectionRect.r0, selectionRect.r1 + 1)
                        .map((r) => r.index);
                      const colIndices = visibleColIds.slice(
                        selectionRect.c0,
                        selectionRect.c1 + 1,
                      );
                      setCopyMenu(null);
                      setBulkEdit({ rowIndices, colIndices, value: "" });
                    },
                  },
                ]
              : []),
            ...(() => {
              if (!onFkJump) return [];
              const driver = rowSqlDriver ?? "mysql";
              const items: { label: string; title: string; onSelect: () => void }[] = [];

              // 順方向: クリックしたセルが FK なら参照先テーブルへジャンプ。
              const fkMeta = columnMeta?.find(
                (m) => m.name === columns[copyMenu.colIdx]?.name,
              );
              if (fkMeta?.referenced_table && fkMeta.referenced_column) {
                const refTable = fkMeta.referenced_table;
                const sql = buildFkJumpSql({
                  driver,
                  database: rowSqlDatabase,
                  refTable,
                  refColumn: fkMeta.referenced_column,
                  value: rows[copyMenu.rowIdx]?.[copyMenu.colIdx] ?? null,
                });
                items.push({
                  label: t("gridFkJump", { table: refTable }),
                  title: t("gridFkJumpTitle"),
                  onSelect: () => { setCopyMenu(null); onFkJump(sql); },
                });
              }

              // 逆方向: この行を参照している子テーブルの行一覧を辿る。参照先カラムが
              // 結果に含まれていない場合 (キー値を取れない) は対象から外す。
              for (const inc of incomingFks ?? []) {
                const refColIdx = columns.findIndex((c) => c.name === inc.referencedColumn);
                if (refColIdx < 0) continue;
                const value = rows[copyMenu.rowIdx]?.[refColIdx] ?? null;
                const sql = buildReverseRefSql({
                  driver,
                  database: rowSqlDatabase,
                  childTable: inc.table,
                  childColumn: inc.column,
                  value,
                });
                items.push({
                  label: t("gridFkReverse", { table: inc.table, column: inc.column }),
                  title: t("gridFkReverseTitle"),
                  onSelect: () => { setCopyMenu(null); onFkJump(sql); },
                });
              }

              if (items.length === 0) return [];
              return [{ separator: true as const }, ...items];
            })(),
            { separator: true as const },
            {
              label: t("gridViewFull"),
              onSelect: () => setViewer({ rowIdx: copyMenu.rowIdx, colIdx: copyMenu.colIdx }),
            },
            {
              label: t("gridRowInspector"),
              shortcut: formatCombo(effectiveGridBindings.gridInspector),
              onSelect: () => {
                const rk = copyMenu.rowIdx;
                const ck = copyMenu.colIdx;
                setCopyMenu(null);
                setActiveCell({ rowIdx: rk, colIdx: ck });
                setInspectorOpen(true);
              },
            },
            // 元に戻す/やり直す (#815): ツールバーの Undo/Redo ボタンと同じ
            // ハンドラ/有効判定をメニューからも呼べるようにする。
            ...(onUndoEdit || onRedoEdit
              ? [
                  { separator: true as const },
                  ...(onUndoEdit
                    ? [
                        {
                          label: t("gridUndoItem"),
                          icon: "undo" as const,
                          shortcut: formatCombo(effectiveGridBindings.gridUndo),
                          disabled: canUndo === false,
                          onSelect: () => { setCopyMenu(null); onUndoEdit(); },
                        },
                      ]
                    : []),
                  ...(onRedoEdit
                    ? [
                        {
                          label: t("gridRedoItem"),
                          icon: "redo" as const,
                          shortcut: formatCombo(effectiveGridBindings.gridRedo),
                          disabled: canRedo === false,
                          onSelect: () => { setCopyMenu(null); onRedoEdit(); },
                        },
                      ]
                    : []),
                ]
              : []),
            // 行の追加・削除。PK が無いテーブルでは削除を無効化 (行を一意に
            // 特定できないため)。新規行追加は PK 有無に依らず可能。
            ...(onToggleRowDelete || onRequestInsertRow
              ? [{ separator: true as const }]
              : []),
            ...(onRequestInsertRow
              ? [{ label: t("gridAddRow"), onSelect: () => { setCopyMenu(null); onRequestInsertRow(); } }]
              : []),
            ...(onToggleRowDelete
              ? [
                  (() => {
                    const key = rowEditKey(
                      rows[copyMenu.rowIdx] ?? [],
                      pkIndices ?? [],
                      copyMenu.rowIdx,
                    );
                    const marked = !!pendingDeleteKeys?.has(key);
                    const hasPk = (pkIndices?.length ?? 0) > 0;
                    return {
                      label: marked ? t("gridUnmarkDelete") : t("gridMarkDelete"),
                      onSelect: () => { setCopyMenu(null); onToggleRowDelete(key); },
                      disabled: !hasPk,
                      title: hasPk ? undefined : t("gridCopyAsSqlNoPk"),
                      danger: !marked,
                    };
                  })(),
                ]
              : []),
          ]}
        />
      )}
      <AnimatePresence>
        {bulkEdit && (
          <Modal width="420px" onClose={() => setBulkEdit(null)}>
            <ModalHeader onClose={() => setBulkEdit(null)} closeLabel={t("dangerousCancel")}>
              {t("gridBulkEditTitle")}
            </ModalHeader>
            <ModalBody>
              <chakra.p fontSize="sm" color="app.textMuted" marginBottom="2">
                {t("gridBulkEditBody", {
                  count: bulkEdit.rowIndices.length * bulkEdit.colIndices.length,
                })}
              </chakra.p>
              <chakra.input
                autoFocus
                value={bulkEdit.value}
                onChange={(e) => setBulkEdit({ ...bulkEdit, value: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    applyBulkEdit();
                  }
                }}
                placeholder={t("gridBulkEditPlaceholder")}
                aria-label={t("gridBulkEditTitle")}
                width="100%"
                fontFamily="var(--font-mono)"
                fontSize="sm"
                py="1" px="2"
                border="1px solid var(--border)"
                background="var(--bg-input)"
                color="var(--text)"
                borderRadius="var(--radius-sm)"
                _focus={{
                  outline: "none",
                  borderColor: "var(--accent)",
                  boxShadow: "var(--focus-ring)",
                }}
              />
              <chakra.button
                type="button"
                onClick={() => setBulkEdit({ ...bulkEdit, value: "NULL" })}
                marginTop="1.5"
                fontSize="xs"
                color="app.textMuted"
                textDecoration="underline"
                cursor="pointer"
                background="transparent"
              >
                {t("gridBulkEditSetNull")}
              </chakra.button>
            </ModalBody>
            <ModalFooter>
              <div style={{ flex: 1 }} />
              <Button variant="secondary" size="sm" onClick={() => setBulkEdit(null)}>
                {t("dangerousCancel")}
              </Button>
              <Button variant="primary" size="sm" onClick={applyBulkEdit}>
                {t("gridBulkEditApply")}
              </Button>
            </ModalFooter>
          </Modal>
        )}
      </AnimatePresence>
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
          formatSupported={isNumericKind(columnKinds[filterMenu.colIdx] ?? "string")}
          formatMode={colFormats[filterMenu.colIdx] ?? "off"}
          onFormatModeChange={(mode) =>
            setColFormats((prev) => {
              const next = { ...prev };
              if (mode === "off") delete next[filterMenu.colIdx];
              else next[filterMenu.colIdx] = mode;
              return next;
            })
          }
          paletteKey={heatPaletteKey}
          onPaletteChange={setHeatPaletteKey}
          onHideColumn={
            enableColumnControls
              ? () => table.getColumn(String(filterMenu.colIdx))?.toggleVisibility(false)
              : undefined
          }
          onShowAllColumns={
            enableColumnControls ? () => table.toggleAllColumnsVisible(true) : undefined
          }
          onResetLayout={enableColumnControls && hasCustomLayout ? resetColumnLayout : undefined}
          pinned={
            enableColumnControls
              ? table.getColumn(String(filterMenu.colIdx))?.getIsPinned() ?? false
              : undefined
          }
          onPin={
            enableColumnControls
              ? (side) => table.getColumn(String(filterMenu.colIdx))?.pin(side)
              : undefined
          }
          onShowStats={
            enableColumnControls
              ? () => {
                  const { colIdx, anchor } = filterMenu;
                  setFilterMenu(null);
                  setStatsMenu({ colIdx, anchor });
                }
              : undefined
          }
          footerEnabled={footerEnabled}
          onToggleFooter={enableColumnControls ? toggleFooter : undefined}
          serverSortDir={
            serverSort && serverSort.column === (columns[filterMenu.colIdx]?.name ?? "")
              ? serverSort.direction
              : null
          }
          onSetServerSort={
            onSetServerSort
              ? (dir) => onSetServerSort(columns[filterMenu.colIdx]?.name ?? "", dir)
              : undefined
          }
          serverFilter={
            serverFilter && serverFilter.column === (columns[filterMenu.colIdx]?.name ?? "")
              ? { op: serverFilter.op, value: serverFilter.value }
              : null
          }
          onApplyServerFilter={
            onSetServerFilter
              ? (op, value) =>
                  onSetServerFilter(columns[filterMenu.colIdx]?.name ?? "", {
                    op,
                    value,
                    numeric: isNumericFilterKind(columnKinds[filterMenu.colIdx] ?? "string"),
                  })
              : undefined
          }
          onClearServerFilter={
            onSetServerFilter
              ? () => onSetServerFilter(columns[filterMenu.colIdx]?.name ?? "", null)
              : undefined
          }
        />
      )}
      {statsMenu && (() => {
        const colIdx = statsMenu.colIdx;
        const kind = columnKinds[colIdx] ?? "string";
        const colName = columns[colIdx]?.name ?? "";
        const colValues = rows.map((r) => r[colIdx] ?? null);
        // 全件集計は具体的なターゲットテーブルと実行系が揃うときだけ提供する。
        const statsRequest: FullStatsRequest | undefined =
          rowSqlTable && onRunStatsQuery
            ? {
                driver: rowSqlDriver ?? "mysql",
                database: rowSqlDatabase ?? null,
                table: rowSqlTable,
                column: colName,
                kind,
              }
            : undefined;
        return (
          <ColumnStatsMenu
            key={colIdx}
            columnName={colName}
            kind={kind}
            anchor={statsMenu.anchor}
            values={colValues}
            statsRequest={statsRequest}
            onRunStatsQuery={statsRequest ? onRunStatsQuery : undefined}
            onClose={() => setStatsMenu(null)}
            footerFn={resolveFooterFn(footerAggs[String(colIdx)], kind)}
            onSetFooterFn={
              enableColumnControls ? (fn) => setFooterAgg(String(colIdx), fn) : undefined
            }
          />
        );
      })()}
      <AnimatePresence>
        {copied && (
          <motion.div
            key="copy-confirm"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            transition={transitions.enter}
            style={{
              position: "fixed",
              bottom: "48px",
              left: "50%",
              transform: "translateX(-50%)",
              // motion.div は素の DOM 要素なので Chakra の zIndex トークン名
              // ("popover") は効かない。CSS 変数を直接参照して popover レイヤーに乗せる
              // (ThemeTransition と同じ方式)。
              zIndex: "var(--z-popover)" as unknown as number,
              pointerEvents: "none",
            }}
          >
            <Box
              role="status"
              aria-live="polite"
              py="1.5" px="3.5"
              fontSize="sm"
              // 意味色「success」のベタ塗り (#664)。以前は白文字を生の hex で
              // 固定し、背景も `color-mix()` で --status-success を手動で暗く
              // 調整していた。ボタンで既に AA (白文字) を検証済みの success の
              // 塗り/文字トークンを再利用する。
              color="app.successFg"
              background="app.successBg"
              borderRadius="md"
              boxShadow="lg"
            >
              {t("gridCopied")}
            </Box>
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {viewer && (() => {
          // 大きな TEXT / JSON 値の直接編集 (#556)。インライン編集と同じ条件
          // (編集可・PK あり・列が編集対象) を満たすときだけ編集モードを許可し、
          // 保存は既存のセル編集経路 (commitEdit → onSetCellEdit) に合流させる。
          const vRow = rows[viewer.rowIdx];
          const vVal = vRow?.[viewer.colIdx] ?? null;
          const cellEditable =
            !!editable &&
            (pkIndices?.length ?? 0) > 0 &&
            (editableColumns?.[viewer.colIdx] ?? false) &&
            !!onSetCellEdit;
          const rowKey = rowEditKey(vRow ?? [], pkIndices ?? [], viewer.rowIdx);
          const originalDisplay = vVal === null || vVal === undefined ? "" : String(vVal);
          return (
            <CellValueViewer
              columnName={columns[viewer.colIdx]?.name ?? ""}
              value={vVal}
              isBinary={columnKinds[viewer.colIdx] === "binary"}
              editable={cellEditable}
              isJson={columnKinds[viewer.colIdx] === "json"}
              validate={validateEdit ? (v) => validateEdit(viewer.colIdx, v) : undefined}
              pendingValue={pendingEdits?.[rowKey]?.[viewer.colIdx] ?? null}
              onSave={
                cellEditable
                  ? (value) => commitEdit(viewer.rowIdx, viewer.colIdx, value, originalDisplay)
                  : undefined
              }
              onClose={() => setViewer(null)}
            />
          );
        })()}
      </AnimatePresence>
      {inspectorOpen && activeCell && rows[activeCell.rowIdx] && (() => {
        const inspVis = visibleRows.findIndex((r) => r.index === activeCell.rowIdx);
        const moveTo = (visTarget: number) => {
          const r = visibleRows[visTarget];
          if (r) navigateCell(r.index, activeCell.colIdx);
        };
        return (
          <RowInspector
            columns={columns}
            values={rows[activeCell.rowIdx]}
            columnKinds={columnKinds}
            rowNumber={inspVis >= 0 ? inspVis + 1 : activeCell.rowIdx + 1}
            hasPrev={inspVis > 0}
            hasNext={inspVis >= 0 && inspVis < visibleRows.length - 1}
            onPrev={() => moveTo(inspVis - 1)}
            onNext={() => moveTo(inspVis + 1)}
            onClose={() => setInspectorOpen(false)}
          />
        );
      })()}
      {blurDialog}
      {hoveredCellTooltip && (
        <TooltipBubble label={hoveredCellTooltip.label} anchor={hoveredCellTooltip.rect} />
      )}
    </>
  );
}

/**
 * ストリーミング実行中の経過時間 (ms) を実時間でライブに刻む。
 *
 * バックエンドの `elapsed_ms` はバッチ到着時にしか更新されないため、カラム未着の
 * 「無の時間」やバッチ間では値が固まって見える。ここで `streaming` が真の間だけ
 * 200ms ごとに自前で計時し、経過時間が常に進んでいることを示す。reduced-motion とは
 * 無関係 (時間表示であってアニメーションではない) なので常時刻む。
 */
function useStreamingElapsed(active: boolean): number {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!active) return;
    const start = Date.now();
    setElapsed(0);
    const id = window.setInterval(() => setElapsed(Date.now() - start), 200);
    return () => window.clearInterval(id);
  }, [active]);
  return elapsed;
}

/**
 * ストリーミング実行中のステータスバナー。カラム未着のスケルトン段階と、行が
 * 流入している段階の両方で同じ見た目を共有する。
 *
 * - ライブな経過時間 (`elapsedMs`) と行数 (`rows`) を表示。
 * - 行数の変化に合わせて文言を `motion.span` の `key` 差し替えで控えめに slide-up
 *   させ、行が積み上がる様子を可視化する (reduced-motion は `MotionConfig` が自動抑制)。
 * - クエリタイムアウト (`timeoutSecs`) の 8 割を超えたら警告トーンへ切り替え、残り
 *   秒数を表示して「間際」であることを伝える。
 * - `onStop` があれば停止ボタン (`cancel_stream` 導線) を常に出す。
 */
function StreamingBanner({
  rows,
  elapsedMs,
  hasColumns,
  onStop,
  timeoutSecs,
}: {
  rows: number;
  elapsedMs: number;
  hasColumns: boolean;
  onStop?: () => void;
  timeoutSecs: number;
}) {
  const t = useT();
  const timeoutMs = timeoutSecs > 0 ? timeoutSecs * 1000 : 0;
  const approaching = timeoutMs > 0 && elapsedMs >= timeoutMs * 0.8;
  const remainingSecs = Math.max(0, Math.ceil((timeoutMs - elapsedMs) / 1000));
  const elapsed = formatElapsed(elapsedMs);
  const statusText = hasColumns
    ? t("statusStreaming", { rows, elapsed })
    : t("statusRunningElapsed", { elapsed });
  return (
    <Box
      role="status"
      aria-live="polite"
      display="flex"
      alignItems="center"
      gap="1.5"
      py="1"
      px="2.5"
      fontSize="sm"
      color="app.textMuted"
      flexShrink={0}
      borderBottom="1px solid"
      borderColor={approaching ? "color-mix(in srgb, var(--status-warning) 45%, var(--border))" : "app.borderSubtle"}
      bg={approaching ? "color-mix(in srgb, var(--status-warning) 12%, var(--bg-muted))" : "app.surfaceMuted"}
    >
      <chakra.span
        aria-hidden
        width="8px"
        height="8px"
        borderRadius="50%"
        flexShrink={0}
        background={approaching ? "var(--status-error)" : "var(--status-warning)"}
        animation="streaming-pulse 1s ease-in-out infinite"
      />
      <chakra.span flex="1" display="inline-flex" alignItems="center" gap="2" minW={0} overflow="hidden">
        <motion.span
          key={rows}
          initial={{ opacity: 0, y: 3 }}
          animate={{ opacity: 1, y: 0 }}
          transition={transitions.enter}
          style={{ whiteSpace: "nowrap" }}
        >
          {statusText}
        </motion.span>
        {approaching && (
          <chakra.span color="var(--text-warning)" fontWeight={600} whiteSpace="nowrap">
            {t("statusTimeoutApproaching", { secs: remainingSecs })}
          </chakra.span>
        )}
      </chakra.span>
      {onStop && (
        <Tooltip label={t("gridStopButtonTitle")}>
          <Button
            variant="warning"
            size="sm"
            px="3"
            py="0.5"
            whiteSpace="nowrap"
            onClick={onStop}
          >
            {t("gridStopButton")}
          </Button>
        </Tooltip>
      )}
    </Box>
  );
}

/**
 * i18n keys for the toolbar hint shown next to Preview/Apply when a table has
 * no primary key (#849). One pair per non-`"primary_key"` strategy —
 * `"none"` keeps the original PK-required wording (editing stays disabled),
 * the others explain which fallback identifies rows so users understand why
 * editing is (still) available.
 */
function identityHintKeys(
  strategy: RowIdentityKind,
  ambiguous: boolean,
): { label: I18nKey; title: I18nKey } {
  switch (strategy) {
    case "rowid":
      return { label: "editRowidHint", title: "editRowidHintTitle" };
    case "ctid":
      return { label: "editCtidHint", title: "editCtidHintTitle" };
    case "all_columns":
      return ambiguous
        ? { label: "editAllColumnsAmbiguousHint", title: "editAllColumnsAmbiguousHintTitle" }
        : { label: "editAllColumnsHint", title: "editAllColumnsHintTitle" };
    default:
      return { label: "editNoPkHint", title: "editNoPkHintTitle" };
  }
}

export const ResultGrid = forwardRef<ResultGridHandle, Props>(function ResultGrid({
  result,
  streaming,
  onStopStreaming,
  loadingMore,
  canLoadMore,
  onLoadMore,
  autoLimitApplied,
  partialResult,
  onFetchAllRows,
  driver,
  database,
  table,
  editable,
  tableColumns,
  rowIdentity,
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
  incomingFks,
  pendingDeleteKeys,
  onToggleRowDelete,
  onRequestInsertRow,
  onDuplicateRow,
  onBulkEdit,
  diffPrevRows,
  diffComparable,
  diffHighlightEnabled,
  onToggleDiffHighlight,
  onChangeView,
  onSaveAsTable,
  onSaveAsView,
  onRegisterLocalTable,
  fullExport,
  lastEditAppliedAt,
  applyingEdits,
  onRunStatsQuery,
  maximized,
  onToggleMaximize,
  onPinResult,
  canPinResult,
  initialScrollTop,
  onScroll,
  gridBindings,
  serverSort,
  serverFilter,
  onSetServerSort,
  onSetServerFilter,
}: Props, ref) {
  const t = useT();
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);
  // Live range-selection summary lifted from the inner DataGrid (#523).
  const [selSummary, setSelSummary] = useState<SelectionSummary | null>(null);
  const settings = useSettings();
  // ストリーミング中はバックエンドのバッチ更新を待たず実時間で経過を刻む。
  const streamElapsedMs = useStreamingElapsed(!!streaming);
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
  // 確定した結果件数のカウントアップ (#977)。ストリーミング中は行数が絶えず増える
  // ため、その途中経過をカウントアップさせるとチカチカするだけで逆効果 — なので
  // `streaming` が真の間は前回の確定値に据え置き、完了した瞬間にだけ新しい値へ
  // 遷移させる (これにより `useCountUp` 自身の「意味のある差分か」判定にも確定値
  // 同士の差分だけが渡る)。
  const [confirmedRowCount, setConfirmedRowCount] = useState(rowCount);
  useEffect(() => {
    if (!streaming) setConfirmedRowCount(rowCount);
  }, [streaming, rowCount]);
  const [showExport, setShowExport] = useState(false);
  // 右クリック「選択範囲をエクスポート」(#917) で `DataGrid` から一度きり渡される
  // 選択範囲の列/行部分集合。モーダルを閉じたら破棄し、次に (右クリック経由でなく)
  // ツールバーの通常 Export を開いたときに古い選択が「選択範囲」スコープとして
  // 残らないようにする。
  const [selectionExport, setSelectionExport] = useState<{
    columns: Column[];
    rows: CellValue[][];
  } | null>(null);
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
  // Scroll position capture/restore for tab persistence (#678). `onScrollRef`
  // keeps the callback fresh without re-binding the listener; `scrollRestoredRef`
  // ensures the persisted position is applied at most once per mount.
  const onScrollRef = useRef(onScroll);
  onScrollRef.current = onScroll;
  const scrollRestoredRef = useRef(false);
  // 直近に再生済みの apply-flash タイムスタンプ。タブ切替などで同じ
  // lastEditAppliedAt を持つ ResultGrid が再マウント/再評価されても、過去の成功時刻で
  // フラッシュが再発火しないよう単調増加チェックに使う。
  const lastHandledApplyAtRef = useRef(0);

  // Apply-edit 成功時に containerRef に apply-flash アニメーションを付与する。
  // lastEditAppliedAt の変化を検知して CSS animation クラスを一時的に追加し、
  // アニメーション完了後 (0.7s) に除去する。新しいタイムスタンプのときだけ発火させ、
  // 既に再生済み (タブ復帰時など) の時刻では何もしない。
  useEffect(() => {
    if (!lastEditAppliedAt) return;
    if (lastEditAppliedAt <= lastHandledApplyAtRef.current) return;
    lastHandledApplyAtRef.current = lastEditAppliedAt;
    const el = containerRef.current;
    if (!el) return;
    el.classList.add("is-apply-flash");
    const timer = window.setTimeout(() => el.classList.remove("is-apply-flash"), 700);
    return () => {
      window.clearTimeout(timer);
      el.classList.remove("is-apply-flash");
    };
  }, [lastEditAppliedAt]);

  // ── 結果内検索 (Find in Results, #644) ──
  // 取得済み行を横断してヒットセルをハイライトし、Enter/Shift+Enter で前後の
  // ヒットへジャンプする。列フィルタ (行を隠す) とは独立で、マッチ計算は
  // `gridFind.ts` の純ロジックに委ねる。
  const findInputRef = useRef<HTMLInputElement>(null);
  const [findOpen, setFindOpen] = useState(false);
  // バーが既に開いているときの Ctrl+F 再押下でも入力へ再フォーカスするための seq。
  const [findFocusSeq, setFindFocusSeq] = useState(0);
  const [findQuery, setFindQuery] = useState("");
  const [findCaseSensitive, setFindCaseSensitive] = useState(false);
  const [findWholeCell, setFindWholeCell] = useState(false);
  const [findRegex, setFindRegex] = useState(false);
  const [findIdx, setFindIdx] = useState<number | null>(null);
  const [findNav, setFindNav] = useState<GridFindNav | null>(null);
  const findSeqRef = useRef(0);
  const findIdxRef = useRef(findIdx);
  findIdxRef.current = findIdx;
  // ストリーミング等でヒット一覧が再計算されても現在ヒットのセルを維持するための
  // スナップショットと、タイピング追従スクロールの重複発行を防ぐ直近キー。
  const prevFindMatchRef = useRef<GridFindMatch | null>(null);
  const lastFindAutoNavKeyRef = useRef<string | null>(null);

  const findResult = useMemo<GridFindResult>(() => {
    if (!findOpen || !result) return EMPTY_FIND_RESULT;
    return computeFindMatches(result.rows, result.columns.length, findQuery, {
      caseSensitive: findCaseSensitive,
      wholeCell: findWholeCell,
      regex: findRegex,
    });
  }, [findOpen, result, findQuery, findCaseSensitive, findWholeCell, findRegex]);
  const findHits = useMemo(
    () => (findResult.matches.length > 0 ? buildFindKeySet(findResult.matches) : undefined),
    [findResult],
  );
  const findCurrentMatch =
    findIdx != null ? (findResult.matches[findIdx] ?? null) : null;

  const emitFindNav = useCallback(
    (m: GridFindMatch, select: boolean, focusCell: boolean) => {
      findSeqRef.current += 1;
      setFindNav({
        rowIdx: m.rowIdx,
        colIdx: m.colIdx,
        seq: findSeqRef.current,
        select,
        focusCell,
      });
    },
    [],
  );

  // ヒット一覧の再計算 (タイピング / オプション変更 / ストリーミングの行追加) の
  // たびに現在ヒットを安定化し、指すセルが変わったときだけスクロール追従する
  // (行追加だけで現在ヒットが不変なら視界を動かさない)。
  useEffect(() => {
    const idx = stableMatchIndex(
      findResult.matches,
      prevFindMatchRef.current,
      findIdxRef.current,
    );
    setFindIdx(idx);
    const m = idx != null ? findResult.matches[idx] : null;
    prevFindMatchRef.current = m;
    if (m) {
      const key = findMatchKey(m);
      if (lastFindAutoNavKeyRef.current !== key) {
        lastFindAutoNavKeyRef.current = key;
        // タイピング追従はスクロールのみ (アクティブセル/フォーカスは動かさない)。
        emitFindNav(m, false, false);
      }
    } else {
      lastFindAutoNavKeyRef.current = null;
    }
  }, [findResult, emitFindNav]);

  // Enter / Shift+Enter (およびバーの ‹ › ボタン): 次/前のヒットへ wrap-around で移動。
  const findStep = (dir: 1 | -1) => {
    const next = nextMatchIndex(findResult.matches.length, findIdx, dir);
    if (next == null) return;
    const m = findResult.matches[next];
    setFindIdx(next);
    prevFindMatchRef.current = m;
    lastFindAutoNavKeyRef.current = findMatchKey(m);
    emitFindNav(m, true, false);
  };

  // Esc / 閉じるボタン: バーを閉じ、現在ヒットのセルへフォーカスを戻す (ヒットが
  // 無ければグリッドのスクロールコンテナへ)。クエリは保持し、再オープン時に全選択で
  // すぐ上書きできるようにする (閉じている間はハイライトも消える)。
  const closeFind = () => {
    const m = findCurrentMatch;
    setFindOpen(false);
    if (m) emitFindNav(m, true, true);
    else containerRef.current?.focus();
  };

  useImperativeHandle(ref, () => ({
    openFind: () => {
      setFindOpen(true);
      setFindFocusSeq((n) => n + 1);
    },
    focus: () => {
      containerRef.current?.focus();
    },
  }), []);
  useEffect(() => {
    if (!findOpen) return;
    const el = findInputRef.current;
    if (el) {
      el.focus();
      el.select();
    }
  }, [findOpen, findFocusSeq]);
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

  // Report the grid's scroll position so table tabs can restore where the user
  // was (#678). Independent of the load-more listener (which is conditional).
  // Re-binds only when the container mounts/unmounts (result toggles null ↔ set);
  // the same DOM node persists across result replacements, so it stays attached.
  const hasResultForScroll = result != null;
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const report = () => onScrollRef.current?.(el.scrollTop);
    el.addEventListener("scroll", report, { passive: true });
    return () => el.removeEventListener("scroll", report);
  }, [hasResultForScroll]);

  // Restore the persisted scroll position once, after rows first populate (#678).
  // Clamp to the scrollable range so a now-shorter result lands at the end
  // instead of overscrolling. Applied at most once per mount (`scrollRestoredRef`).
  useEffect(() => {
    if (scrollRestoredRef.current) return;
    if (!initialScrollTop || initialScrollTop <= 0) {
      scrollRestoredRef.current = true;
      return;
    }
    const el = containerRef.current;
    if (!el) return;
    if (streaming) return; // ストリーミング完了前は行の並びが確定しないため復元を待つ
    if ((result?.rows.length ?? 0) === 0) return; // wait for rows to lay out
    const max = Math.max(0, el.scrollHeight - el.clientHeight);
    el.scrollTop = Math.min(initialScrollTop, max);
    scrollRestoredRef.current = true;
  }, [initialScrollTop, result?.rows.length, streaming]);

  // Row identity indices and per-column editability are computed once per
  // render so both the toolbar (gating Preview/Apply) and the grid agree on
  // which cells are interactive. These hooks must run before any early
  // return so the hook order stays stable as `result` transitions
  // null → columns (otherwise React aborts the whole tree on the next
  // render).
  const columns = result?.columns;
  // Resolve row identity regardless of `editable`: a read-only table tab
  // still wants it for row→SQL generation (UPDATE/DELETE WHERE clause).
  // Inline editing stays gated on `editable` downstream, so this never makes
  // cells editable. Prefers a real primary key; falls back to the backend's
  // rowid/ctid/all-columns strategy (#849) when there's none.
  const identity = useMemo(
    () => (columns ? resolveRowIdentity(columns, tableColumns ?? null, rowIdentity ?? null) : { indices: [], strategy: "none" as RowIdentityKind }),
    [columns, tableColumns, rowIdentity],
  );
  const pkIndices = identity.indices;
  const identityStrategy = identity.strategy;
  const editableCols = useMemo<boolean[]>(() => {
    if (!editable || !columns) return columns ? columns.map(() => false) : [];
    if (pkIndices.length === 0) return columns.map(() => false);
    // The "all_columns" fallback (#849) has no PK column to protect — every
    // column is fair game to edit, since the WHERE clause is always rebuilt
    // from the row's ORIGINAL values (not the pending edit), so editing a
    // column that also happens to be part of the identity is safe. For the
    // other strategies, disallow editing the identity column(s) themselves:
    // a real PK or the rowid/ctid pseudo-column changing in-place would
    // invalidate the WHERE clause used to identify the row (rowid/ctid also
    // isn't a real declared column, so editing it wouldn't mean anything).
    if (identityStrategy === "all_columns") {
      return columns.map((c) => isEditableColumnType(c.type_name));
    }
    const pkSet = new Set(pkIndices);
    return columns.map((c, i) => !pkSet.has(i) && isEditableColumnType(c.type_name));
  }, [editable, columns, pkIndices, identityStrategy]);

  const resultRows = result?.rows;
  // Whether the currently-loaded rows contain a genuine identity collision
  // under the "all_columns" fallback (#849) — two rows with identical values
  // in every column, which a WHERE clause built from that identity can't
  // tell apart. Best-effort (only sees rows actually fetched into the grid),
  // but strengthens the toolbar hint and Apply's confirmation wording from a
  // generic caution to "this data actually has duplicates".
  const ambiguousIdentity = useMemo(
    () => identityStrategy === "all_columns" && !!resultRows && hasAmbiguousIdentity(resultRows, pkIndices),
    [identityStrategy, resultRows, pkIndices],
  );

  // Re-run diff (#597): compare the previous snapshot against the current
  // result and surface changed cells / added rows / removed count. Computed only
  // when the toggle is on, the two results came from the same query
  // (`diffComparable`), streaming has settled, a PK is resolvable, and a
  // snapshot exists — otherwise we fall back to normal rendering (no highlight).
  const diff = useMemo(() => {
    if (
      !diffHighlightEnabled ||
      !diffComparable ||
      streaming ||
      !diffPrevRows ||
      !resultRows ||
      !columns ||
      pkIndices.length === 0
    ) {
      return null;
    }
    return diffResultRows(diffPrevRows, resultRows, pkIndices, columns.length);
  }, [
    diffHighlightEnabled,
    diffComparable,
    streaming,
    diffPrevRows,
    resultRows,
    columns,
    pkIndices,
  ]);

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
  // The name→metadata map avoids a linear scan per validated cell.
  const tableColumnsByName = useMemo(
    () => new Map((tableColumns ?? []).map((c) => [c.name, c])),
    [tableColumns],
  );
  const validateEdit = useCallback(
    (colIdx: number, value: string): I18nKey | null => {
      const col = columns?.[colIdx];
      if (!col) return null;
      const info = tableColumnsByName.get(col.name) ?? null;
      return validateCellInput(value, col.type_name, info?.nullable ?? true);
    },
    [columns, tableColumnsByName],
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
      // カラム情報未着のストリーミング中: 密度設定に合わせた行数ぶんのスケルトン行を
      // 表示してレイアウトシフトを抑える。データ到着後は DataGrid に差し替わる。
      // 行数は「表示領域の高さ / 推定行高」から概算し、空白が目立たないよう 8 行を
      // 最大として適度な数にする。
      const skeletonRowCount = Math.min(8, Math.max(3, Math.round(320 / DENSITY_ROW_ESTIMATE[settings.density])));
      const skeletonColWidths = [42, 68, 55, 80, 50, 72, 60, 45];
      return (
        <Box
          display="flex"
          flexDirection="column"
          flex="1 1 auto"
          minHeight={0}
          minWidth={0}
          overflow="hidden"
          bg="app.surface"
          role="status"
          aria-label={t("statusRunningQuery")}
          aria-busy="true"
          aria-live="polite"
        >
          {/* カラム未着の段階でも経過時間・キャンセル導線を出し、「無の時間」を埋める */}
          <StreamingBanner
            rows={0}
            elapsedMs={streamElapsedMs}
            hasColumns={false}
            onStop={onStopStreaming}
            timeoutSecs={settings.queryTimeoutSecs}
          />
          {/* スケルトン行: 密度ごとの行高に合わせた疑似列バーを並べる */}
          <Box
            px="3"
            pt="2.5"
            display="flex"
            flexDirection="column"
            gap={settings.density === "compact" ? "1" : settings.density === "spacious" ? "2" : "1.5"}
            aria-hidden
          >
            {Array.from({ length: skeletonRowCount }, (_, i) => (
              <Box key={i} display="flex" gap="2" opacity={1 - i * 0.1}>
                {skeletonColWidths.slice(0, 5).map((w, ci) => (
                  <Skeleton
                    key={ci}
                    height={`${DENSITY_ROW_ESTIMATE[settings.density] - 8}px`}
                    style={{ width: `${w}px`, animationDelay: `${(i * 5 + ci) * 0.05}s` }}
                    flexShrink={0}
                  />
                ))}
                <Skeleton
                  height={`${DENSITY_ROW_ESTIMATE[settings.density] - 8}px`}
                  flex="1"
                  style={{ animationDelay: `${(i * 5 + 5) * 0.05}s` }}
                />
              </Box>
            ))}
          </Box>
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

  // `resultStatusBar` は "{rows} 件 · {ms} ms" 形式の 1 文を `t()` で組み立てるため、
  // 件数だけをアニメーションさせるには展開済み文字列からプレースホルダの前後を
  // 逆算して分割する (#977)。テンプレート自体・i18n 実装には触れず、どの言語でも
  // 動く。
  const statusBarParts =
    !streaming && result.elapsed_ms != null && result.columns.length > 0
      ? splitAroundCountUpToken(
          t("resultStatusBar", { rows: COUNT_UP_TOKEN, ms: result.elapsed_ms }),
        )
      : null;

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
      // カラム確定でスケルトン → 実データへ切り替わる瞬間だけ一度フェードイン
      // させ、滑らかに差し替える (#657)。reduced-motion では静止 (App.css)。
      className={streaming ? "grid-data-reveal" : undefined}
      // 実行フェーズを離散モデル (queryRunState) で表し、スタイル/テストの
      // フックとして公開する (#657)。
      data-query-phase={deriveQueryPhase({
        streaming,
        error: !!queryError,
        canceled: !!partialResult,
        hasResult: result.columns.length > 0,
      })}
    >
      {streaming && (
        <StreamingBanner
          rows={result.rows.length}
          elapsedMs={streamElapsedMs}
          hasColumns
          onStop={onStopStreaming}
          timeoutSecs={settings.queryTimeoutSecs}
        />
      )}
      {showAutoLimitBadge && (
        <Box
          role="status"
          aria-live="polite"
          display="flex"
          alignItems="center"
          gap="2.5"
          padding="5px 10px"
          fontSize="sm"
          color="app.text"
          borderBottom="1px solid"
          borderColor="app.borderSubtle"
          background="color-mix(in srgb, var(--status-warning) 14%, var(--bg-muted))"
        >
          <chakra.span flex="1">
            {t("autoLimitApplied", { limit: autoLimitApplied! })}
          </chakra.span>
          <Tooltip label={t("autoLimitFetchAllTitle")}>
            <Button
              size="sm"
              px="2.5"
              whiteSpace="nowrap"
              onClick={onFetchAllRows}
            >
              {t("autoLimitFetchAll")}
            </Button>
          </Tooltip>
        </Box>
      )}
      <Box
        display="flex"
        alignItems="center"
        gap="1.5"
        py="1" px="2"
        bg="app.toolbar"
        borderBottom="1px solid"
        borderColor="app.borderSubtle"
        flexShrink={0}
        // 分割ペインが狭いとき、縮まないボタン (ピン/最大化/ピボット/チャート) が
        // 親の overflow: hidden でクリップされて操作不能になるのを防ぐ。TabBar と
        // 同じ横スクロール方式で、フォーカス移動時もブラウザが自動で見える位置へ
        // スクロールする。
        overflowX="auto"
        overflowY="hidden"
        scrollbarWidth="thin"
      >
        {/*
          グリッド / ピボット / チャートの表示切替。以前は「ピボット」「チャート」の
          独立ボタンが差分トグルの右隣にあり、戻る導線は各ビュー側だけだったが、
          3 択のセグメントへ寄せて往復を 1 か所にまとめる。ツールバー先頭 (最も
          目に付く位置) に置き、表示条件は Export と同じ (ストリーミング中でなく
          行がある)。
        */}
        {onChangeView && canExport && (
          <ResultViewSwitch value="grid" onChange={onChangeView} />
        )}
        <Tooltip
          focusableWrapper={!canExport}
          label={
            canExport
              ? t("exportButtonTitle")
              : streaming
                ? t("exportDisabledStreaming")
                : t("exportDisabledNoRows")
          }
        >
          <Button
            size="sm"
            px="2.5"
            onClick={() => setShowExport(true)}
            disabled={!canExport}
          >
            <Icon name="download" size={ICON_SIZES.md} /> {t("exportButton")}
          </Button>
        </Tooltip>
        <Tooltip
          focusableWrapper={!canExport || !onSaveAsTable}
          label={
            streaming
              ? t("exportDisabledStreaming")
              : !canExport
                ? t("exportDisabledNoRows")
                : onSaveAsTable
                  ? t("saveAsTableButtonTitle")
                  : t("saveAsTableDisabledTitle")
          }
        >
          <Button
            size="sm"
            px="2.5"
            onClick={() => onSaveAsTable?.()}
            disabled={!canExport || !onSaveAsTable}
          >
            <Icon name="table" size={ICON_SIZES.md} /> {t("saveAsTableButton")}
          </Button>
        </Tooltip>
        <Tooltip
          focusableWrapper={!canExport || !onSaveAsView}
          label={
            streaming
              ? t("exportDisabledStreaming")
              : !canExport
                ? t("exportDisabledNoRows")
                : onSaveAsView
                  ? t("saveAsViewButtonTitle")
                  : t("saveAsViewDisabledTitle")
          }
        >
          <Button
            size="sm"
            px="2.5"
            onClick={() => onSaveAsView?.()}
            disabled={!canExport || !onSaveAsView}
          >
            <Icon name="view" size={ICON_SIZES.md} /> {t("saveAsViewButton")}
          </Button>
        </Tooltip>
        <Tooltip
          focusableWrapper={!canExport || !onRegisterLocalTable}
          label={
            streaming
              ? t("exportDisabledStreaming")
              : !canExport
                ? t("exportDisabledNoRows")
                : onRegisterLocalTable
                  ? t("registerLocalTableButtonTitle")
                  : t("registerLocalTableDisabledTitle")
          }
        >
          <Button
            size="sm"
            px="2.5"
            onClick={() => onRegisterLocalTable?.()}
            disabled={!canExport || !onRegisterLocalTable}
          >
            <Icon name="database" size={ICON_SIZES.md} /> {t("registerLocalTableButton")}
          </Button>
        </Tooltip>
        {onSetAutoRefresh && (
          <Tooltip label={autoRefreshAllowed ? t("autoRefreshEnabledTitle") : t("autoRefreshDisabledTitle")}>
          <Box
            display="inline-flex"
            alignItems="center"
            gap="1.5"
            paddingLeft="2px"
          >
            <chakra.label
              display="inline-flex"
              alignItems="center"
              gap="1"
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
              py="0.5" px="1"
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
          </Tooltip>
        )}
        {onToggleDiffHighlight && pkIndices.length > 0 && (
          <Tooltip label={t("diffHighlightTitle")}>
          <Box
            display="inline-flex"
            alignItems="center"
            gap="1.5"
            paddingLeft="2px"
          >
            <chakra.label
              display="inline-flex"
              alignItems="center"
              gap="1"
              fontSize="xs"
              whiteSpace="nowrap"
              color="app.text"
              cursor="pointer"
            >
              <chakra.input
                type="checkbox"
                checked={!!diffHighlightEnabled}
                aria-label={t("diffHighlightAria")}
                onChange={onToggleDiffHighlight}
              />
              {t("diffHighlightLabel")}
            </chakra.label>
            {diff?.hasChanges && (
              <chakra.span
                role="status"
                aria-live="polite"
                fontSize="xs"
                color="app.textMuted"
                whiteSpace="nowrap"
              >
                {t("diffHighlightSummary", {
                  added: diff.addedRows.size,
                  removed: diff.removedCount,
                })}
              </chakra.span>
            )}
          </Box>
          </Tooltip>
        )}
        {editable && tableColumns && identityStrategy !== "primary_key" && (
          <Tooltip label={t(identityHintKeys(identityStrategy, ambiguousIdentity).title)}>
            <chakra.span
              fontSize="xs"
              color={identityStrategy === "all_columns" ? "var(--text-warning)" : "app.textMuted"}
              fontStyle="italic"
              paddingLeft="4px"
            >
              {t(identityHintKeys(identityStrategy, ambiguousIdentity).label)}
            </chakra.span>
          </Tooltip>
        )}
        {editableActive && (
          // 未確定変更が 1 件以上のとき、pending 変更レビューバーを Motion で
          // 出現/退出させる (#659)。reduced-motion は MotionConfig が自動抑制する。
          <AnimatePresence>
            {hasPendingEdits && (
              <motion.div
                key="edit-review-bar"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 4 }}
                transition={transitions.enter}
                style={{ display: "inline-flex", alignItems: "stretch" }}
              >
          <Box
            role="group"
            aria-label={t("editToolbarAria")}
            display="inline-flex"
            alignItems="center"
            gap="1.5"
            py="0.5" px="2"
            borderLeft="1px solid var(--border-subtle)"
            borderRight="1px solid var(--border-subtle)"
            background="color-mix(in srgb, var(--preview-highlight) 8%, transparent)"
          >
            {/* 件数バッジ: 未確定の編集セル数を丸ピルで示す (#659)。 */}
            <chakra.span
              display="inline-flex"
              alignItems="center"
              justifyContent="center"
              minW="18px"
              height="18px"
              px="1.5"
              borderRadius="full"
              fontSize="2xs"
              fontWeight={700}
              lineHeight="1"
              color="var(--preview-highlight)"
              background="color-mix(in srgb, var(--preview-highlight) 20%, transparent)"
              flexShrink={0}
              aria-hidden
            >
              {editsCount}
            </chakra.span>
            <chakra.span
              fontSize="xs"
              color="var(--preview-highlight)"
              fontWeight={500}
              whiteSpace="nowrap"
            >
              {t("editPendingCount", { cells: editsCount, rows: editedRowCount })}
            </chakra.span>
            {editedRowCount > 1 && !hasInvalidEdit && (
              // Preview only handles one row at a time; surface that
              // limitation explicitly so users don't assume Apply has been
              // dry-run-validated for every edited row.
              <Tooltip label={t("editPreviewMultiRowBannerTitle")}>
                <chakra.span
                  role="note"
                  fontSize="xs"
                  color="app.textMuted"
                  fontStyle="italic"
                  whiteSpace="nowrap"
                >
                  {t("editPreviewMultiRowBanner")}
                </chakra.span>
              </Tooltip>
            )}
            <Tooltip label={t("editUndoTitle")}>
              <Button
                variant="secondary"
                size="sm"
                px="1.5"
                onClick={onUndoEdit}
                disabled={!canUndo}
                aria-label={t("editUndoTitle")}
              >
                <Icon name="undo" />
              </Button>
            </Tooltip>
            <Tooltip label={t("editRedoTitle")}>
              <Button
                variant="secondary"
                size="sm"
                px="1.5"
                onClick={onRedoEdit}
                disabled={!canRedo}
                aria-label={t("editRedoTitle")}
              >
                <Icon name="redo" />
              </Button>
            </Tooltip>
            <Tooltip
              focusableWrapper={!canPreview}
              label={
                hasInvalidEdit
                  ? t("editApplyDisabledInvalid")
                  : editedRowCount > 1
                    ? t("editPreviewMultiRowTitle")
                    : streaming
                      ? t("editDisabledStreaming")
                      : t("editorPreviewTitle")
              }
            >
              <Button
                variant="warning"
                size="sm"
                px="2.5"
                onClick={onPreviewEdits}
                disabled={!canPreview}
              >
                <Icon name="eye" size={ICON_SIZES.md} /> {t("editPreviewButton")}
              </Button>
            </Tooltip>
            <Tooltip
              focusableWrapper={!canApply}
              label={
                hasInvalidEdit
                  ? t("editApplyDisabledInvalid")
                  : streaming
                    ? t("editDisabledStreaming")
                    : t("editApplyButtonTitle")
              }
            >
              <LoadingButton
                variant="success"
                size="sm"
                px="2.5"
                loading={applyingEdits}
                onClick={onApplyEdits}
                disabled={!canApply}
              >
                <Icon name="check" size={ICON_SIZES.md} /> {t("editApplyButton")}
              </LoadingButton>
            </Tooltip>
            <Tooltip label={t("editCancelButtonTitle")}>
            <Button
              variant="secondary"
              size="sm"
              px="2.5"
              onClick={() => setShowDiscardConfirm(true)}
            >
              <Icon name="close" size={ICON_SIZES.md} /> {t("editCancelButton")}
            </Button>
            </Tooltip>
          </Box>
              </motion.div>
            )}
          </AnimatePresence>
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
        {selSummary && (
          <chakra.span
            marginLeft="auto"
            display="inline-flex"
            alignItems="center"
            gap="2.5"
            fontSize="xs"
            color="app.text"
            whiteSpace="nowrap"
            fontFamily="mono"
            aria-live="polite"
            aria-label={t("gridSelectionAria")}
            py="0.5"
            px="2"
            borderRadius="var(--radius-sm)"
            background="color-mix(in srgb, var(--accent) 10%, transparent)"
          >
            <chakra.span color="app.textMuted">
              {t("gridSelectionCells", { count: selSummary.count })}
            </chakra.span>
            {selSummary.numericCount > 0 ? (
              <>
                <span>{t("gridSumLabel")} {fmtStatNum(selSummary.sum)}</span>
                <span>{t("gridAvgLabel")} {fmtStatNum(selSummary.avg)}</span>
                <span>{t("gridMinLabel")} {fmtStatNum(selSummary.min)}</span>
                <span>{t("gridMaxLabel")} {fmtStatNum(selSummary.max)}</span>
                <chakra.span color="app.textMuted">
                  {t("gridCountLabel")} {selSummary.numericCount.toLocaleString()}
                </chakra.span>
              </>
            ) : (
              <chakra.span color="app.textMuted">
                {t("gridSelectionNonNull", { n: selSummary.nonNullCount })}
              </chakra.span>
            )}
          </chakra.span>
        )}
        {statusBarParts && (
          <chakra.span
            marginLeft={selSummary ? "4" : "auto"}
            fontSize="xs"
            color="app.textMuted"
            whiteSpace="nowrap"
            fontFamily="mono"
            aria-live="polite"
          >
            {statusBarParts[0]}
            <CountUp value={confirmedRowCount} formatter={formatCountUpPlainInt} />
            {statusBarParts[1]}
            {autoLimitApplied != null && result.rows.length >= autoLimitApplied && (
              <Tooltip label={t("autoLimitApplied", { limit: autoLimitApplied })}>
                <chakra.span color="var(--text-warning)" marginLeft="6px">
                  LIMIT {autoLimitApplied}
                </chakra.span>
              </Tooltip>
            )}
            {partialResult && (
              <Tooltip
                label={t(
                  partialResult.reason === "cancelled"
                    ? "partialResultCancelledTitle"
                    : "partialResultTimeoutTitle",
                  { rows: partialResult.rows },
                )}
              >
                <chakra.span color="var(--text-warning)" marginLeft="6px">
                  {t("partialResultBadge")}
                </chakra.span>
              </Tooltip>
            )}
          </chakra.span>
        )}
        <chakra.input
          ref={searchInputRef}
          type="search"
          marginLeft={selSummary || statusBarParts ? "8px" : "auto"}
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
        {onPinResult && (
          <Tooltip label={t("pinResultTitle")} focusableWrapper={!canPinResult}>
            <Button
              variant="secondary"
              size="sm"
              px="1.5"
              marginLeft="1.5"
              flexShrink={0}
              onClick={onPinResult}
              disabled={!canPinResult}
              aria-label={t("pinResultTitle")}
            >
              <Icon name="pin" />
            </Button>
          </Tooltip>
        )}
        {onToggleMaximize && (
          <Tooltip label={maximized ? t("resultRestoreTitle") : t("resultMaximizeTitle")}>
            <Button
              variant="secondary"
              size="sm"
              px="1.5"
              marginLeft="1.5"
              flexShrink={0}
              onClick={onToggleMaximize}
              aria-label={maximized ? t("resultRestoreTitle") : t("resultMaximizeTitle")}
              aria-pressed={!!maximized}
            >
              <Icon name={maximized ? "minimize" : "maximize"} />
            </Button>
          </Tooltip>
        )}
      </Box>
      <AnimatePresence initial={false}>
        {findOpen && (
          <motion.div
            key="grid-find-bar"
            initial={variants.slideUp.initial}
            animate={variants.slideUp.animate}
            exit={variants.slideUp.exit}
            transition={transitions.enter}
          >
            <Box
              role="search"
              aria-label={t("gridFindAria")}
              display="flex"
              alignItems="center"
              flexWrap="wrap"
              gap="1.5"
              py="1"
              px="2"
              bg="app.toolbar"
              borderBottom="1px solid"
              borderColor="app.borderSubtle"
              flexShrink={0}
            >
              <chakra.input
                ref={findInputRef}
                type="text"
                width="240px"
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
                value={findQuery}
                onChange={(e) => setFindQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    findStep(e.shiftKey ? -1 : 1);
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    closeFind();
                  }
                }}
                placeholder={t("gridFindPlaceholder")}
                aria-label={t("gridFindInputAria")}
              />
              <Tooltip label={t("gridFindCaseTitle")}>
                <chakra.button
                  type="button"
                  css={FIND_TOGGLE_CSS}
                  aria-pressed={findCaseSensitive}
                  onClick={() => setFindCaseSensitive((v) => !v)}
                  aria-label={t("gridFindCaseTitle")}
                >
                  Aa
                </chakra.button>
              </Tooltip>
              <Tooltip label={t("gridFindWholeTitle")}>
                <chakra.button
                  type="button"
                  css={FIND_TOGGLE_CSS}
                  aria-pressed={findWholeCell}
                  onClick={() => setFindWholeCell((v) => !v)}
                  aria-label={t("gridFindWholeTitle")}
                >
                  =
                </chakra.button>
              </Tooltip>
              <Tooltip label={t("gridFindRegexTitle")}>
                <chakra.button
                  type="button"
                  css={FIND_TOGGLE_CSS}
                  aria-pressed={findRegex}
                  onClick={() => setFindRegex((v) => !v)}
                  aria-label={t("gridFindRegexTitle")}
                >
                  .*
                </chakra.button>
              </Tooltip>
              <chakra.span
                fontSize="xs"
                fontFamily="mono"
                whiteSpace="nowrap"
                aria-live="polite"
                color={
                  findResult.invalidRegex || (findQuery !== "" && findResult.matches.length === 0)
                    ? "var(--text-warning)"
                    : "app.textMuted"
                }
              >
                {findResult.invalidRegex
                  ? t("gridFindInvalidRegex")
                  : findQuery === ""
                    ? ""
                    : findResult.matches.length === 0
                      ? t("gridFindNoHits")
                      : t("gridFindCount", {
                          current: (findIdx ?? 0) + 1,
                          total: findResult.matches.length,
                        })}
              </chakra.span>
              <Tooltip label={t("gridFindPrevTitle")} focusableWrapper={findResult.matches.length === 0}>
                <Button
                  variant="secondary"
                  size="sm"
                  px="1.5"
                  disabled={findResult.matches.length === 0}
                  onClick={() => findStep(-1)}
                  aria-label={t("gridFindPrevTitle")}
                >
                  ‹
                </Button>
              </Tooltip>
              <Tooltip label={t("gridFindNextTitle")} focusableWrapper={findResult.matches.length === 0}>
                <Button
                  variant="secondary"
                  size="sm"
                  px="1.5"
                  disabled={findResult.matches.length === 0}
                  onClick={() => findStep(1)}
                  aria-label={t("gridFindNextTitle")}
                >
                  ›
                </Button>
              </Tooltip>
              <Tooltip label={t("gridFindCloseTitle")}>
                <Button
                  variant="secondary"
                  size="sm"
                  px="1.5"
                  marginLeft="auto"
                  onClick={closeFind}
                  aria-label={t("gridFindCloseTitle")}
                >
                  <Icon name="close" />
                </Button>
              </Tooltip>
            </Box>
          </motion.div>
        )}
      </AnimatePresence>
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
          onBulkEdit={editableActive ? onBulkEdit : undefined}
          changedCells={diff?.changedCells}
          addedRowIndices={diff?.addedRows}
          pendingDeleteKeys={pendingDeleteKeys}
          onToggleRowDelete={editableActive ? onToggleRowDelete : undefined}
          onRequestInsertRow={editableActive ? onRequestInsertRow : undefined}
          onDuplicateRow={editableActive ? onDuplicateRow : undefined}
          onUndoEdit={onUndoEdit}
          onRedoEdit={onRedoEdit}
          canUndo={canUndo}
          canRedo={canRedo}
          validateEdit={validateEdit}
          rowSqlDriver={driver}
          rowSqlDatabase={database}
          rowSqlTable={table}
          columnMeta={tableColumns ?? undefined}
          incomingFks={incomingFks}
          onFkJump={onFkJump}
          columnSizingStorageKey={columnSizingStorageKey}
          skeleton={!!streaming}
          onSelectionSummary={setSelSummary}
          onExportSelection={(data) => {
            setSelectionExport(data);
            setShowExport(true);
          }}
          onRunStatsQuery={onRunStatsQuery}
          paginationState={paginateMode ? pagination : undefined}
          onPaginationChange={paginateMode ? setPagination : undefined}
          findHits={findHits}
          findCurrentKey={findCurrentMatch ? findMatchKey(findCurrentMatch) : null}
          findNav={findNav}
          gridBindings={gridBindings}
          serverSort={serverSort}
          serverFilter={serverFilter}
          onSetServerSort={onSetServerSort}
          onSetServerFilter={onSetServerFilter}
          emptyMessage={
            streaming ? undefined : queryError ? (
              <EmptyState
                illustration={errorIllustration(queryError)}
                icon="warning"
                title={t("gridQueryError")}
                description={queryError}
                action={onRetry ? { label: t("gridRetry"), onClick: onRetry } : undefined}
              />
            ) : (
              <EmptyState
                illustration={<NoResultsIllustration />}
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
            gap="1.5"
            py="1.5" px="2.5"
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
            <Tooltip label={title} focusableWrapper={disabled}>
              <chakra.button
                aria-label={title}
                disabled={disabled}
                onClick={onClick}
                fontSize="xs"
                px="1.5"
                py="0.5"
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
            </Tooltip>
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
              gap="1.5"
              px="2.5"
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
                <Box display="flex" alignItems="center" gap="1">
                  <Spinner size={12} />
                  <chakra.span>{t("paginationLoadingMore")}</chakra.span>
                </Box>
              )}
              {!loadingMore && isLast && canLoadMore && (
                <chakra.span color="app.textMuted" fontStyle="italic">
                  {t("paginationCanLoadMore")}
                </chakra.span>
              )}
              <chakra.span marginLeft="auto" display="flex" alignItems="center" gap="1" whiteSpace="nowrap">
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
            driver={driver}
            partial={showAutoLimitBadge || !!canLoadMore || !!partialResult}
            stoppedPartial={!!partialResult}
            fullExport={fullExport}
            selection={selectionExport}
            onClose={() => {
              setShowExport(false);
              setSelectionExport(null);
            }}
          />
        )}
      </AnimatePresence>
    </Box>
  );
});
