import { CellValue, Column, TableColumnInfo } from "../api/tauri";

/**
 * Inline cell edits awaiting Preview/Apply.
 *
 * The outer key is the row index in `QueryResult.rows` (canonical
 * "original" position — unaffected by sort/filter); the inner key is the
 * column index in `QueryResult.columns`. Values are raw strings from the
 * input box — they are parsed into SQL literals by `buildUpdateStatements`.
 */
export type PendingEdits = Record<number, Record<number, string>>;

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
  "DECIMAL",
  "NEWDECIMAL",
  "NUMERIC",
]);

const BINARY_TYPES = new Set([
  "BLOB",
  "TINYBLOB",
  "MEDIUMBLOB",
  "LONGBLOB",
  "BINARY",
  "VARBINARY",
]);

/**
 * Whether a column may be edited inline. BLOB-family columns are excluded
 * because their JSON shape is hex bytes and round-tripping arbitrary
 * binary through the text protocol is fragile.
 */
export function isEditableColumnType(typeName: string): boolean {
  return !BINARY_TYPES.has(typeName.toUpperCase());
}

/**
 * Resolves the indices of the table's primary-key columns inside the
 * result column order. Returns an empty array when any PK column is
 * missing from the result (e.g. a SELECT that projected only some
 * columns) — without a complete PK we cannot build a safe WHERE clause.
 */
export function resolvePkIndices(
  columns: Column[],
  tableColumns: TableColumnInfo[] | null,
): number[] {
  if (!tableColumns) return [];
  const pkNames = tableColumns
    .filter((c) => c.key.toUpperCase() === "PRI")
    .map((c) => c.name);
  if (pkNames.length === 0) return [];
  const indices: number[] = [];
  for (const name of pkNames) {
    const i = columns.findIndex((c) => c.name === name);
    if (i < 0) return [];
    indices.push(i);
  }
  return indices;
}

function quoteIdent(driver: string, name: string): string {
  if (driver === "postgres" || driver === "sqlite") {
    return '"' + name.replace(/"/g, '""') + '"';
  }
  return "`" + name.replace(/`/g, "``") + "`";
}

function qualifiedTableRef(driver: string, database: string, table: string): string {
  // SQLite has a single namespace per connection — the synthetic "main"
  // database label is for the UI tree, not the SQL itself.
  if (driver === "sqlite") return quoteIdent(driver, table);
  return `${quoteIdent(driver, database)}.${quoteIdent(driver, table)}`;
}

function quoteString(s: string): string {
  return "'" + s.replace(/\\/g, "\\\\").replace(/'/g, "''") + "'";
}

/**
 * Converts a `CellValue` (as returned by the backend) into a SQL literal
 * suitable for a WHERE clause. Used for the PK columns identifying the
 * row to update — these come from the original row, not user input.
 */
function literalFromCellValue(v: CellValue): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  return quoteString(String(v));
}

/**
 * Converts raw input text from the edit box into a SQL literal,
 * loosely typed by the destination column. Rules:
 *   - "NULL" (case-insensitive, exact match after trim) → SQL NULL
 *   - numeric column + numeric-looking input → number literal
 *   - boolean column + true/false/0/1 → TRUE/FALSE
 *   - otherwise → quoted string
 *
 * Empty input is left as an empty string (use the explicit "NULL"
 * keyword to clear a column).
 */
function literalFromInput(raw: string, col: Column): string {
  const trimmed = raw.trim();
  if (/^null$/i.test(trimmed)) return "NULL";
  const t = col.type_name.toUpperCase();
  if (NUMERIC_TYPES.has(t) && /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(trimmed)) {
    return trimmed;
  }
  if (t === "BOOLEAN" || t === "BOOL") {
    const lc = trimmed.toLowerCase();
    if (lc === "true" || lc === "1") return "TRUE";
    if (lc === "false" || lc === "0") return "FALSE";
  }
  return quoteString(raw);
}

export interface BuildUpdateInput {
  driver: string;
  database: string;
  table: string;
  columns: Column[];
  rows: CellValue[][];
  pkIndices: number[];
  edits: PendingEdits;
}

/**
 * Builds one `UPDATE ... SET ... WHERE pk = ...` statement per edited
 * row. Returns an empty array when there are no edits or when the PK is
 * unresolved.
 *
 * Each row's WHERE clause uses the ORIGINAL pk values (from `rows`), not
 * any pending edits, so even an edit that changes a non-PK column still
 * targets the right row.
 */
export function buildUpdateStatements(input: BuildUpdateInput): string[] {
  if (input.pkIndices.length === 0) return [];
  const ref = qualifiedTableRef(input.driver, input.database, input.table);
  const stmts: string[] = [];
  // Iterate the edits map in row-index order so the order of generated
  // statements is stable and matches the visual top-to-bottom flow.
  const rowIndices = Object.keys(input.edits)
    .map((k) => Number(k))
    .filter((k) => Number.isFinite(k))
    .sort((a, b) => a - b);
  for (const rowIdx of rowIndices) {
    const rowEdits = input.edits[rowIdx];
    if (!rowEdits) continue;
    const row = input.rows[rowIdx];
    if (!row) continue;
    const setParts: string[] = [];
    for (const colKey of Object.keys(rowEdits)) {
      const colIdx = Number(colKey);
      const col = input.columns[colIdx];
      if (!col) continue;
      setParts.push(
        `${quoteIdent(input.driver, col.name)} = ${literalFromInput(rowEdits[colIdx], col)}`,
      );
    }
    if (setParts.length === 0) continue;
    const whereParts = input.pkIndices.map((i) => {
      const col = input.columns[i];
      return `${quoteIdent(input.driver, col.name)} = ${literalFromCellValue(row[i])}`;
    });
    stmts.push(
      `UPDATE ${ref} SET ${setParts.join(", ")} WHERE ${whereParts.join(" AND ")};`,
    );
  }
  return stmts;
}

/** Total number of cells (across all rows) currently flagged for edit. */
export function countEditedCells(edits: PendingEdits): number {
  let n = 0;
  for (const row of Object.values(edits)) {
    n += Object.keys(row).length;
  }
  return n;
}

/** Number of distinct rows with at least one pending edit. */
export function countEditedRows(edits: PendingEdits): number {
  return Object.keys(edits).length;
}
