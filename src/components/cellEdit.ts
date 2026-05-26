import { CellValue, Column, TableColumnInfo } from "../api/tauri";
import type { I18nKey } from "../i18n";
import { quoteIdentFor } from "./sqlDialect";

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

type EditTypeKind = "number" | "date" | "datetime" | "time" | "boolean" | "other";

/**
 * Buckets a column's reported type name into the broad kinds we validate
 * client-side. Normalizes away `(...)` length/precision and trailing
 * `UNSIGNED` / `ZEROFILL` modifiers, then matches conservatively across the
 * MySQL / PostgreSQL / SQLite spellings. Anything unrecognised falls back to
 * `"other"`, which is never rejected — a false reject (blocking a valid edit)
 * is worse than letting the server have the final say.
 */
function classifyEditType(typeName: string): EditTypeKind {
  const base = typeName
    .toUpperCase()
    .replace(/\(.*$/, "")
    .replace(/\s+(UNSIGNED|ZEROFILL)\b/g, "")
    .trim();
  if (NUMERIC_TYPES.has(base)) return "number";
  if (/^(INT|SERIAL|BIGSERIAL|SMALLSERIAL|FLOAT4|FLOAT8|INT2|INT4|INT8)$/.test(base)) {
    return "number";
  }
  if (base === "DATE") return "date";
  if (base === "TIME") return "time";
  if (base === "DATETIME" || base.startsWith("TIMESTAMP")) return "datetime";
  if (base === "BOOLEAN" || base === "BOOL") return "boolean";
  return "other";
}

const NUMERIC_INPUT_RE = /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i;
const DATE_RE = /^\d{4}-\d{1,2}-\d{1,2}$/;
const DATETIME_RE = /^\d{4}-\d{1,2}-\d{1,2}[ T]\d{1,2}:\d{2}(:\d{2})?(\.\d+)?$/;
const TIME_RE = /^-?\d{1,3}:\d{2}(:\d{2})?(\.\d+)?$/;

function errorKeyForKind(kind: EditTypeKind): I18nKey | null {
  switch (kind) {
    case "number":
      return "editInvalidNumber";
    case "date":
      return "editInvalidDate";
    case "datetime":
      return "editInvalidDateTime";
    case "time":
      return "editInvalidTime";
    case "boolean":
      return "editInvalidBoolean";
    default:
      return null;
  }
}

/**
 * Best-effort client-side validation of a pending inline edit. Returns an
 * i18n key describing the problem, or `null` when the value looks acceptable
 * for the destination column. Mirrors `literalFromInput`'s conventions: the
 * literal `NULL` keyword clears a column, and numeric/temporal/boolean
 * columns require a well-formed value (or `NULL` when the column allows it).
 * String-like columns are never rejected here.
 */
export function validateCellInput(
  raw: string,
  typeName: string,
  nullable: boolean,
): I18nKey | null {
  const trimmed = raw.trim();
  const kind = classifyEditType(typeName);
  if (/^null$/i.test(trimmed)) {
    return nullable ? null : "editInvalidNotNull";
  }
  if (trimmed === "") {
    if (!nullable) return "editInvalidNotNull";
    // On a nullable column an empty value only makes sense for string-like
    // types; numeric/temporal/boolean columns need a real value or NULL.
    return kind === "other" ? null : errorKeyForKind(kind);
  }
  switch (kind) {
    case "number":
      return NUMERIC_INPUT_RE.test(trimmed) ? null : "editInvalidNumber";
    case "date":
      return DATE_RE.test(trimmed) ? null : "editInvalidDate";
    case "datetime":
      return DATETIME_RE.test(trimmed) ? null : "editInvalidDateTime";
    case "time":
      return TIME_RE.test(trimmed) ? null : "editInvalidTime";
    case "boolean": {
      const lc = trimmed.toLowerCase();
      return lc === "true" || lc === "false" || lc === "0" || lc === "1"
        ? null
        : "editInvalidBoolean";
    }
    default:
      return null;
  }
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

function qualifiedTableRef(driver: string, database: string, table: string): string {
  // SQLite has a single namespace per connection — the synthetic "main"
  // database label is for the UI tree, not the SQL itself.
  if (driver === "sqlite") return quoteIdentFor(driver, table);
  return `${quoteIdentFor(driver, database)}.${quoteIdentFor(driver, table)}`;
}

function quoteString(driver: string, s: string): string {
  // Single quotes are doubled in every dialect. Backslash is only special
  // inside MySQL string literals; Postgres (with the default
  // `standard_conforming_strings = on`) and SQLite treat it as an ordinary
  // character, so doubling it there would corrupt the stored value (and break
  // PK matching when a key contains a backslash). Mirror `quoteIdentFor`'s
  // convention of treating unknown drivers as MySQL.
  const escaped =
    driver === "postgres" || driver === "sqlite"
      ? s.replace(/'/g, "''")
      : s.replace(/\\/g, "\\\\").replace(/'/g, "''");
  return "'" + escaped + "'";
}

/**
 * Converts a `CellValue` (as returned by the backend) into a SQL literal
 * suitable for a WHERE clause. Used for the PK columns identifying the
 * row to update — these come from the original row, not user input.
 */
function literalFromCellValue(driver: string, v: CellValue): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  return quoteString(driver, String(v));
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
function literalFromInput(driver: string, raw: string, col: Column): string {
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
  return quoteString(driver, raw);
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
        `${quoteIdentFor(input.driver, col.name)} = ${literalFromInput(input.driver, rowEdits[colIdx], col)}`,
      );
    }
    if (setParts.length === 0) continue;
    const whereParts = input.pkIndices.map((i) => {
      const col = input.columns[i];
      return `${quoteIdentFor(input.driver, col.name)} = ${literalFromCellValue(input.driver, row[i])}`;
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
