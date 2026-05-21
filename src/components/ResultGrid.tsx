import { useMemo, useState } from "react";
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type ColumnFiltersState,
  type FilterFn,
  type SortingFn,
  type SortingState,
} from "@tanstack/react-table";
import { CellValue, Column, QueryResult } from "../api/tauri";
import { useT } from "../i18n";

interface Props {
  result: QueryResult | null;
}

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

const includesFilter: FilterFn<RowShape> = (row, columnId, filterValue) => {
  const fv = (filterValue ?? "") as string;
  if (fv === "") return true;
  const v = row.getValue(columnId) as CellValue;
  if (v === null || v === undefined) {
    return "null".includes(fv.toLowerCase());
  }
  return String(v).toLowerCase().includes(fv.toLowerCase());
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
}: {
  columns: Column[];
  rows: CellValue[][];
  enableColumnControls?: boolean;
  changedCells?: boolean[][];
  changedColumns?: boolean[];
}) {
  const t = useT();

  const columnKinds = useMemo<CellKind[]>(() => columns.map(classifyColumn), [columns]);

  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);

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
    state: { sorting, columnFilters },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    enableSortingRemoval: true,
    enableColumnResizing: true,
    columnResizeMode: "onChange",
  });

  const isNumericKind = (k: CellKind) => k === "number" || k === "decimal";

  const visibleRows = table.getRowModel().rows;
  const totalRows = rows.length;
  const isFiltered = enableColumnControls && columnFilters.length > 0;

  return (
    <>
      {isFiltered && (
        <div className="grid-filter-summary">
          {t("gridFilteredCount", { shown: visibleRows.length, total: totalRows })}
          <button
            type="button"
            className="grid-filter-clear"
            onClick={() => {
              setColumnFilters([]);
              setSorting([]);
            }}
          >
            {t("gridClearFilters")}
          </button>
        </div>
      )}
      <table
        className="data-grid-table"
        style={{ width: ROW_INDEX_WIDTH + table.getTotalSize() }}
      >
        <colgroup>
          <col style={{ width: ROW_INDEX_WIDTH }} />
          {table.getHeaderGroups()[0]?.headers.map((h) => (
            <col key={h.id} style={{ width: h.getSize() }} />
          ))}
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
                    className={`col-${kind} ${isNumericKind(kind) ? "align-right" : ""} ${canSort ? "is-sortable" : ""} ${sortDir ? `is-sorted-${sortDir}` : ""} ${isResizing ? "is-resizing" : ""} ${isChangedCol ? "is-changed-col" : ""}`}
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
            </tr>
          )}
        </thead>
        <tbody>
          {visibleRows.length === 0 && isFiltered ? (
            <tr>
              <td className="row-index" aria-hidden />
              <td className="grid-empty-cell" colSpan={columns.length}>
                {t("gridNoMatches")}
              </td>
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
                  return (
                    <td
                      key={cell.id}
                      className={`col-${kind} ${isNumericKind(kind) ? "align-right" : ""} ${isNull ? "is-null" : ""} ${isChanged ? "is-changed" : ""}`}
                      title={isNull ? t("resultNull") : String(v)}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  );
                })}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </>
  );
}

export function ResultGrid({ result }: Props) {
  const t = useT();

  if (!result) {
    return <div className="results empty">{t("resultEmpty")}</div>;
  }
  if (result.columns.length === 0) {
    return (
      <div className="results empty">
        {t("resultExecuted", { rows: result.rows_affected, ms: result.elapsed_ms })}
      </div>
    );
  }
  return (
    <div className="results">
      <DataGrid columns={result.columns} rows={result.rows} />
    </div>
  );
}
