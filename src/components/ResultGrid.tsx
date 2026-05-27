import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode } from "react";
import { Box, chakra, type SystemStyleObject } from "@chakra-ui/react";
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type ColumnFiltersState,
  type ColumnSizingState,
  type FilterFn,
  type OnChangeFn,
  type SortingFn,
  type SortingState,
  type Row,
} from "@tanstack/react-table";
import { CellValue, Column, QueryResult, TableColumnInfo } from "../api/tauri";
import { useT, type I18nKey } from "../i18n";
import { CellValueViewer } from "./CellValueViewer";
import { copyToClipboard } from "./clipboard";
import { ContextMenu } from "./ContextMenu";
import { EmptyState } from "./EmptyState";
import { ExportModal } from "./ExportModal";
import { Spinner } from "./Spinner";
import { Button } from "./ui";
import {
  countEditedCells,
  countEditedRows,
  isEditableColumnType,
  resolvePkIndices,
  validateCellInput,
  type PendingEdits,
} from "./cellEdit";

/**
 * 結果テーブル (TanStack グリッド) のセル/ヘッダ単位のスタイル。`App.css` の
 * `:where(.results, .preview-pane-body) …` ルール群をコンポーネント側へ移設したもの。
 * `ResultGrid` のスクロール枠と `PreviewGrid` の各ペイン本体に `css` で適用する
 * (両者が `DataGrid` を共有するため定義を 1 箇所に集約する)。
 *
 * 性能上、セル/行は素の `th` / `td` / `span` のまま (重い Chakra コンポーネントを
 * セル単位で使わない) で、ここで子孫セレクタとして一括スタイルする。色はテーマの
 * CSS 変数を直接参照する (`--cell-*` などのトークン定義は `App.css` に残す方針)。
 */
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
    padding: "5px 10px",
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
  "& tbody tr:nth-of-type(even) td": { background: "var(--bg-stripe)" },
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
  "& tbody tr:nth-of-type(even) td.row-index": { background: "var(--bg-stripe)" },
  "& tbody tr:hover td.row-index": { background: "var(--bg-row-hover)" },
  "& th.col-filler, & td.col-filler": {
    padding: 0,
    borderRight: "none",
    background: "var(--bg-elevated)",
  },
  "& tbody tr:nth-of-type(even) td.col-filler": { background: "var(--bg-elevated)" },
  "& tbody tr:hover td.col-filler": { background: "var(--bg-elevated)" },
  "& .cell-null": { color: "var(--text-null)", fontStyle: "italic" },
  "& td.is-null": { backgroundImage: "linear-gradient(transparent, transparent)" },
  "& .cell-number, & .cell-decimal": {
    color: "var(--cell-number)",
    fontVariantNumeric: "tabular-nums",
  },
  "& .cell-bool": { fontWeight: 600 },
  "& .cell-bool.is-true": { color: "var(--cell-bool-true)" },
  "& .cell-bool.is-false": { color: "var(--cell-bool-false)" },
  "& .cell-date": { color: "var(--cell-date)" },
  "& .cell-json": { color: "var(--cell-json)" },
  "& .cell-binary": { color: "var(--cell-binary)", fontStyle: "italic" },
  "& .cell-string": { color: "var(--text)" },
  // 列ヘッダのソート/フィルタ
  "& th.is-sortable": { padding: 0 },
  "& th.is-sortable .th-sort-button": {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    width: "100%",
    padding: "5px 10px",
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
  "& tr.filter-row th": {
    position: "sticky",
    top: "38px",
    background: "var(--bg-muted)",
    padding: "3px 6px",
    fontWeight: 400,
    borderBottom: "1px solid var(--border-strong)",
    zIndex: 2,
  },
  "& tr.filter-row th.row-index": { top: "38px", zIndex: 3, background: "var(--bg-muted)" },
  "& .grid-filter-input": {
    width: "100%",
    padding: "3px 6px",
    fontSize: "var(--text-xs)",
    fontFamily: "inherit",
    border: "1px solid var(--border)",
    background: "var(--bg-input)",
    color: "var(--text)",
    borderRadius: "var(--radius-sm)",
  },
  "& .grid-filter-input::placeholder": { color: "var(--text-muted)" },
  "& .grid-filter-input:focus": {
    outline: "none",
    borderColor: "var(--accent)",
    boxShadow: "0 0 0 1px color-mix(in srgb, var(--accent) 35%, transparent)",
  },
  "& td.grid-empty-cell": {
    padding: "14px",
    color: "var(--text-muted)",
    fontStyle: "italic",
    textAlign: "center",
    whiteSpace: "normal",
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
  "& tbody tr:nth-of-type(even) td.is-changed": {
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
  "& tbody tr:nth-of-type(even) td.is-pending-edit": {
    background: "color-mix(in srgb, var(--preview-highlight) 18%, transparent)",
  },
  "& tbody tr:hover td.is-pending-edit": {
    background: "color-mix(in srgb, var(--preview-highlight) 24%, transparent)",
  },
  "& .cell-pending-value": { color: "var(--preview-highlight)", fontWeight: 500 },
  "& td.is-editable-cell": { cursor: "text" },
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
  /** Edits awaiting Preview/Apply. Keyed by [rowIdx][colIdx]. */
  pendingEdits?: PendingEdits;
  /** Called when a cell's pending value is set (or cleared via `null`). */
  onSetCellEdit?: (rowIdx: number, colIdx: number, value: string | null) => void;
  /** Discard all pending edits for the active tab. */
  onClearEdits?: () => void;
  /** Build & preview the UPDATE for the pending edits (single-row only). */
  onPreviewEdits?: () => void;
  /** Build & execute the UPDATE(s) for the pending edits, then refresh. */
  onApplyEdits?: () => void;
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

type CellKind = "number" | "decimal" | "bool" | "date" | "time" | "json" | "binary" | "string";

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
  if (t === "JSON") return "json";
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

function readStoredColumnSizing(storageKey: string | undefined): ColumnSizingState {
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

function writeStoredColumnSizing(
  storageKey: string | undefined,
  sizing: ColumnSizingState,
): void {
  if (!storageKey) return;
  try {
    localStorage.setItem(storageKey, JSON.stringify(sizing));
  } catch {
    // ignore
  }
}

const includesFilter: FilterFn<RowShape> = (row, columnId, filterValue) => {
  const fv = (filterValue ?? "") as string;
  if (fv === "") return true;
  const v = row.getValue(columnId) as CellValue;
  if (v === null || v === undefined) {
    return "null".includes(fv.toLowerCase());
  }
  return String(v).toLowerCase().includes(fv.toLowerCase());
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

/**
 * Render a column/row pair as a TanStack-backed HTML table. Used by both
 * `ResultGrid` (single result) and the preview view (before/after).
 *
 * When `enableColumnControls` is true (default), each header is clickable
 * to cycle sort (none → asc → desc → none) and a per-column filter row is
 * shown beneath the headers.
 *
 * `changedCells`/`changedColumns` are indexed by the ORIGINAL row position
 * (i.e. `rows[i]`) and applied after sort/filter via `row.index`, so the
 * highlight tracks the row even when the user re-sorts the preview pane.
 */
export function DataGrid({
  columns,
  rows,
  enableColumnControls = true,
  changedCells,
  changedColumns,
  globalFilter,
  editable = false,
  editableColumns,
  pendingEdits,
  onSetCellEdit,
  validateEdit,
  columnSizingStorageKey,
  emptyMessage,
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
  pendingEdits?: PendingEdits;
  onSetCellEdit?: (rowIdx: number, colIdx: number, value: string | null) => void;
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
}) {
  const t = useT();

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
      return {
        id: String(i),
        header: () => (
          <span className="th-content" title={c.type_name}>
            <span className="th-name">{c.name}</span>
            <span className="th-type">{c.type_name}</span>
          </span>
        ),
        accessorFn: (row) => row[String(i)],
        sortingFn: sortingFnForKind(kind),
        filterFn: includesFilter,
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
            return (
              <span className={`cell-bool ${truthy ? "is-true" : "is-false"}`}>
                {truthy ? "true" : "false"}
              </span>
            );
          }
          if (effectiveKind === "date" || effectiveKind === "time") {
            return <span className="cell-date">{String(v)}</span>;
          }
          if (effectiveKind === "json") {
            return <span className="cell-json">{String(v)}</span>;
          }
          if (effectiveKind === "binary") {
            const s = String(v);
            const preview = s.length > 64 ? `${s.slice(0, 64)}…` : s;
            return <span className="cell-binary" title={s}>0x{preview}</span>;
          }
          return <span className="cell-string">{String(v)}</span>;
        },
      };
    });
  }, [columns, columnKinds, t, enableColumnControls]);

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
    state: { sorting, columnFilters, globalFilter: globalFilter ?? "", columnSizing },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onColumnSizingChange: handleColumnSizingChange,
    globalFilterFn: globalIncludesFilter,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
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

  const commitEdit = (
    rowIdx: number,
    colIdx: number,
    value: string,
    originalDisplay: string,
  ) => {
    if (!onSetCellEdit) return;
    // Re-typing the original value clears the pending edit so the user
    // can "undo" without hitting Cancel.
    if (value === originalDisplay) {
      onSetCellEdit(rowIdx, colIdx, null);
    } else {
      onSetCellEdit(rowIdx, colIdx, value);
    }
  };

  const visibleRows = table.getRowModel().rows;
  const totalRows = rows.length;
  const hasColumnFilter = columnFilters.length > 0;
  const hasGlobalFilter = (globalFilter ?? "").trim().length > 0;
  const isFiltered = enableColumnControls && (hasColumnFilter || hasGlobalFilter);

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
      <table style={{ width: ROW_INDEX_WIDTH + table.getTotalSize() }}>
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
                return (
                  <th
                    key={h.id}
                    className={`col-${kind} ${canSort ? "is-sortable" : ""} ${sortDir ? `is-sorted-${sortDir}` : ""} ${isResizing ? "is-resizing" : ""} ${isChangedCol ? "is-changed-col" : ""}`}
                    aria-sort={sortDir === "asc" ? "ascending" : sortDir === "desc" ? "descending" : "none"}
                  >
                    {canSort ? (
                      <button
                        type="button"
                        className="th-sort-button"
                        onClick={h.column.getToggleSortingHandler()}
                        title={sortTitle}
                      >
                        {flexRender(h.column.columnDef.header, h.getContext())}
                        <span className="th-sort-indicator" aria-hidden>
                          {sortGlyph}
                        </span>
                      </button>
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
          {enableColumnControls && (
            <tr className="filter-row">
              <th className="row-index" aria-hidden />
              {table.getHeaderGroups()[0]?.headers.map((h, idx) => {
                const kind = columnKinds[idx] ?? "string";
                const value = (h.column.getFilterValue() as string | undefined) ?? "";
                return (
                  <th key={`${h.id}-filter`} className={`col-${kind} filter-cell`}>
                    <input
                      className="grid-filter-input"
                      type="search"
                      value={value}
                      placeholder={t("gridFilterPlaceholder")}
                      onChange={(e) => h.column.setFilterValue(e.target.value)}
                      aria-label={t("gridFilterAria", { column: columns[idx]?.name ?? "" })}
                    />
                  </th>
                );
              })}
              <th className="col-filler" aria-hidden />
            </tr>
          )}
        </thead>
        <tbody>
          {visibleRows.length === 0 && (isFiltered || emptyMessage) ? (
            <tr>
              <td className="row-index" aria-hidden />
              <td className="grid-empty-cell" colSpan={columns.length}>
                {isFiltered ? t("gridNoMatches") : emptyMessage}
              </td>
              <td className="col-filler" aria-hidden />
            </tr>
          ) : (
            visibleRows.map((row, rowIdx) => (
              <tr key={row.id}>
                <td className="row-index">{rowIdx + 1}</td>
                {row.getVisibleCells().map((cell, idx) => {
                  const v = cell.getValue() as CellValue;
                  const kind = columnKinds[idx] ?? "string";
                  const isNull = v === null || v === undefined;
                  const isChanged = changedCells?.[row.index]?.[idx] ?? false;
                  const colEditable = editable && (editableColumns?.[idx] ?? false);
                  const pendingForRow = pendingEdits?.[row.index];
                  const pendingValue = pendingForRow?.[idx];
                  const hasPending = pendingValue !== undefined;
                  const isEditingHere =
                    editing !== null &&
                    editing.rowIdx === row.index &&
                    editing.colIdx === idx;
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
                      className={`col-${kind} ${isNumericKind(kind) ? "align-right" : ""} ${isNull && !hasPending ? "is-null" : ""} ${isChanged ? "is-changed" : ""} ${hasPending ? "is-pending-edit" : ""} ${colEditable ? "is-editable-cell" : ""} ${editError || pendingError ? "is-invalid-edit" : ""}`}
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
                              : String(v)
                      }
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
                              commitEdit(
                                editing!.rowIdx,
                                editing!.colIdx,
                                editing!.value,
                                originalDisplay,
                              );
                              setEditing(null);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                commitEdit(
                                  editing!.rowIdx,
                                  editing!.colIdx,
                                  editing!.value,
                                  originalDisplay,
                                );
                                setEditing(null);
                              } else if (e.key === "Escape") {
                                e.preventDefault();
                                setEditing(null);
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
            ))
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
            {
              label: t("gridViewFull"),
              onSelect: () => setViewer({ rowIdx: copyMenu.rowIdx, colIdx: copyMenu.colIdx }),
            },
          ]}
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
      {viewer && (
        <CellValueViewer
          columnName={columns[viewer.colIdx]?.name ?? ""}
          value={rows[viewer.rowIdx]?.[viewer.colIdx] ?? null}
          isBinary={columnKinds[viewer.colIdx] === "binary"}
          onClose={() => setViewer(null)}
        />
      )}
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
  database,
  table,
  editable,
  tableColumns,
  pendingEdits,
  onSetCellEdit,
  onClearEdits,
  onPreviewEdits,
  onApplyEdits,
}: Props, ref) {
  const t = useT();
  const [showExport, setShowExport] = useState(false);
  const [search, setSearch] = useState("");
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
  // happens).
  useEffect(() => {
    if (!canLoadMore || loadingMore) return;
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
  const pkIndices = useMemo(
    () => (editable && columns ? resolvePkIndices(columns, tableColumns ?? null) : []),
    [editable, columns, tableColumns],
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
      const rowEdits = pendingEdits[Number(rowKey)];
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
              size="sm"
              px="10px"
              onClick={onClearEdits}
              title={t("editCancelButtonTitle")}
            >
              {t("editCancelButton")}
            </Button>
          </Box>
        )}
        <chakra.input
          ref={searchInputRef}
          type="search"
          marginLeft="auto"
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
          globalFilter={search}
          editable={editableActive}
          editableColumns={editableCols}
          pendingEdits={pendingEdits}
          onSetCellEdit={onSetCellEdit}
          validateEdit={validateEdit}
          columnSizingStorageKey={columnSizingStorageKey}
          emptyMessage={
            streaming ? undefined : (
              <EmptyState
                compact
                icon="table"
                title={t("gridZeroRows")}
                description={t("gridZeroRowsHint", { ms: result.elapsed_ms })}
              />
            )
          }
        />
        {loadingMore && (
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
      </Box>
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
    </Box>
  );
});
