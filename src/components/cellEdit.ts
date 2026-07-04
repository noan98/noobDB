import { CellValue, Column, TableColumnInfo } from "../api/tauri";
import type { I18nKey } from "../i18n";
import { quoteIdentFor } from "./sqlDialect";

/**
 * Inline cell edits awaiting Preview/Apply.
 *
 * The outer key is the row's stable edit identity (`rowEditKey`) — derived
 * from the row's primary-key values, NOT its array position — so a buffered
 * edit stays bound to the same logical row across pagination, which appends
 * rows and (without a stable ORDER BY) can re-surface a row already shown.
 * The inner key is the column index in `QueryResult.columns`. Values are raw
 * strings from the input box — parsed into SQL literals by
 * `buildUpdateStatements`.
 */
export type PendingEdits = Record<string, Record<number, string>>;

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
  // PostgreSQL のバイナリ型。db/postgres.rs は bytea 列を type_name = "BYTEA"
  // で報告するため、ここに含めないと編集不可の防御をすり抜けて hex 文字列が
  // そのままテキストとして書き込まれ、元のバイナリ値を破壊してしまう。
  "BYTEA",
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

// Distinct, collision-resistant encoding of a single primary-key cell. A type
// tag keeps the value domains apart so the number 1, the string "1", the
// boolean true and SQL NULL never collapse onto the same key. PK values are
// simple scalars in practice, so stringifying the value is enough.
function encodePkPart(v: CellValue): string {
  if (v === null || v === undefined) return "x";
  if (typeof v === "boolean") return v ? "b1" : "b0";
  if (typeof v === "number") return "n" + String(v);
  return "s" + String(v);
}

/**
 * Stable identity for a result row, used as the key under which inline edits
 * are buffered in `PendingEdits`. Derived from the row's primary-key column
 * values so an edit follows the same logical row when the result array grows
 * or reorders during pagination — array position does not, the primary key
 * does.
 *
 * Falls back to the row's array index (prefixed so it can't collide with a
 * PK-derived key) when the table has no resolvable primary key. Inline editing
 * is only offered once a primary key resolves, so the fallback is effectively
 * unused for real edits; it just keeps the function total.
 */
export function rowEditKey(
  row: CellValue[],
  pkIndices: number[],
  fallbackIndex: number,
): string {
  if (pkIndices.length === 0) return "i" + fallbackIndex;
  // Length-prefix each encoded part so a composite key is unambiguous: two
  // different value tuples can never serialize to the same string regardless
  // of what characters the values contain.
  return (
    "k" +
    pkIndices
      .map((i) => {
        const part = encodePkPart(row[i]);
        return part.length + ":" + part;
      })
      .join("")
  );
}

function qualifiedTableRef(driver: string, database: string, table: string): string {
  // SQLite has a single namespace per connection — the synthetic "main"
  // database label is for the UI tree, not the SQL itself.
  if (driver === "sqlite") return quoteIdentFor(driver, table);
  return `${quoteIdentFor(driver, database)}.${quoteIdentFor(driver, table)}`;
}

export function quoteString(driver: string, s: string): string {
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
export function literalFromCellValue(driver: string, v: CellValue): string {
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

/**
 * Converts raw input text from the edit box into the `CellValue` it will
 * display as once committed, loosely typed by the destination column. Mirrors
 * `literalFromInput`'s coercion exactly so the optimistic in-grid value matches
 * what the database actually stores:
 *   - "NULL" (case-insensitive, after trim) → SQL NULL (`null`)
 *   - numeric column + numeric-looking input → a `number` (kept as the trimmed
 *     string when it exceeds JS safe-integer range, matching how the backend's
 *     `decode_cell` returns huge BIGINT/DECIMAL values as text to keep precision)
 *   - boolean column + true/false/0/1 → `true` / `false`
 *   - otherwise → the raw string (untrimmed, like the quoted string literal)
 *
 * Used to reflect an applied edit in the result grid in place, without a full
 * refetch, so the edited cell shows its new value and the user keeps their
 * scroll/page position.
 */
export function cellValueFromInput(raw: string, col: Column): CellValue {
  const trimmed = raw.trim();
  if (/^null$/i.test(trimmed)) return null;
  const t = col.type_name.toUpperCase();
  if (NUMERIC_TYPES.has(t) && /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(trimmed)) {
    const n = Number(trimmed);
    if (Number.isFinite(n) && (Number.isSafeInteger(n) || !Number.isInteger(n))) {
      return n;
    }
    return trimmed;
  }
  if (t === "BOOLEAN" || t === "BOOL") {
    const lc = trimmed.toLowerCase();
    if (lc === "true" || lc === "1") return true;
    if (lc === "false" || lc === "0") return false;
  }
  return raw;
}

/**
 * Applies buffered edits (and optional pending-delete keys) to a copy of the
 * result rows, returning a new rows array. Used after a successful Apply to
 * reflect committed changes in place — edited cells take their new value (via
 * `cellValueFromInput`) and rows flagged for deletion are dropped — without a
 * refetch, so the grid keeps its current position.
 *
 * Edits/deletes are matched by `rowEditKey` (primary-key identity), exactly as
 * the grid buffers them. A row with no matching edit is passed through
 * unchanged (same reference).
 */
export function applyEditsToRows(input: {
  columns: Column[];
  rows: CellValue[][];
  pkIndices: number[];
  edits: PendingEdits;
  deleteKeys?: Set<string>;
}): CellValue[][] {
  const { columns, rows, pkIndices, edits, deleteKeys } = input;
  const out: CellValue[][] = [];
  for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
    const row = rows[rowIdx];
    if (!row) continue;
    const key = rowEditKey(row, pkIndices, rowIdx);
    if (deleteKeys?.has(key)) continue;
    const rowEdits = edits[key];
    if (!rowEdits) {
      out.push(row);
      continue;
    }
    const next = [...row];
    for (const colKey of Object.keys(rowEdits)) {
      const colIdx = Number(colKey);
      const c = columns[colIdx];
      if (!c) continue;
      next[colIdx] = cellValueFromInput(rowEdits[colIdx], c);
    }
    out.push(next);
  }
  return out;
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
 * Edits are keyed by `rowEditKey` (primary-key identity), so we walk `rows`
 * in array order, compute each row's key, and emit a statement for any row
 * with a matching edit. Iterating `rows` (rather than the edit map) keeps the
 * statement order stable top-to-bottom and resolves the ORIGINAL pk values
 * (from `rows`, not the pending edits) for the WHERE clause — so even an edit
 * that changes a non-PK column still targets the right row. A re-surfaced row
 * (same PK appearing twice in `rows` when pagination lacks a stable ORDER BY)
 * is emitted only once.
 */
export function buildUpdateStatements(input: BuildUpdateInput): string[] {
  if (input.pkIndices.length === 0) return [];
  const ref = qualifiedTableRef(input.driver, input.database, input.table);
  const stmts: string[] = [];
  const emitted = new Set<string>();
  for (let rowIdx = 0; rowIdx < input.rows.length; rowIdx++) {
    const row = input.rows[rowIdx];
    if (!row) continue;
    const key = rowEditKey(row, input.pkIndices, rowIdx);
    if (emitted.has(key)) continue;
    const rowEdits = input.edits[key];
    if (!rowEdits) continue;
    emitted.add(key);
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

/** One pending new row: column index → typed value. Unset columns are
 *  omitted from the INSERT so the database applies defaults / auto-increment.
 *  A value of `"null"` (any case) becomes SQL `NULL`. */
export type PendingInsertRow = Record<number, string>;

/**
 * Builds one `INSERT INTO ... (cols) VALUES (...)` per pending new row.
 * Only the columns the user filled are included; the typed value is converted
 * with the same `literalFromInput` coercion used by cell edits. Rows with no
 * filled columns are skipped.
 */
export function buildInsertStatements(input: {
  driver: string;
  database: string;
  table: string;
  columns: Column[];
  inserts: PendingInsertRow[];
}): string[] {
  const ref = qualifiedTableRef(input.driver, input.database, input.table);
  const stmts: string[] = [];
  for (const row of input.inserts) {
    const idxs = Object.keys(row)
      .map(Number)
      .filter((i) => input.columns[i] !== undefined);
    if (idxs.length === 0) continue;
    const cols = idxs.map((i) => quoteIdentFor(input.driver, input.columns[i].name)).join(", ");
    const vals = idxs
      .map((i) => literalFromInput(input.driver, row[i], input.columns[i]))
      .join(", ");
    stmts.push(`INSERT INTO ${ref} (${cols}) VALUES (${vals});`);
  }
  return stmts;
}

/**
 * Builds one `DELETE FROM ... WHERE pk = ...` per row whose PK-derived
 * `rowEditKey` is in `deleteKeys`. The original PK values come from
 * `rows`, so the delete targets the correct row regardless of sort/pagination.
 * Returns empty when there is no resolvable PK.
 */
export function buildDeleteStatements(input: {
  driver: string;
  database: string;
  table: string;
  columns: Column[];
  rows: CellValue[][];
  pkIndices: number[];
  deleteKeys: Set<string>;
}): string[] {
  if (input.pkIndices.length === 0 || input.deleteKeys.size === 0) return [];
  const ref = qualifiedTableRef(input.driver, input.database, input.table);
  const stmts: string[] = [];
  const emitted = new Set<string>();
  for (let rowIdx = 0; rowIdx < input.rows.length; rowIdx++) {
    const row = input.rows[rowIdx];
    if (!row) continue;
    const key = rowEditKey(row, input.pkIndices, rowIdx);
    if (!input.deleteKeys.has(key) || emitted.has(key)) continue;
    emitted.add(key);
    const whereParts = input.pkIndices.map((i) => {
      const col = input.columns[i];
      return `${quoteIdentFor(input.driver, col.name)} = ${literalFromCellValue(input.driver, row[i])}`;
    });
    stmts.push(`DELETE FROM ${ref} WHERE ${whereParts.join(" AND ")};`);
  }
  return stmts;
}

/**
 * Renders a BLOB cell value (carried as a bare hex string, per CLAUDE.md's
 * `Value::Bytes`) as a driver-appropriate binary literal:
 *   - PostgreSQL: `'\xDEADBEEF'` (bytea hex input; backslash is literal under
 *     the default `standard_conforming_strings = on`)
 *   - SQLite:     `X'DEADBEEF'` (blob literal)
 *   - MySQL:      `0xDEADBEEF` (hex literal; an empty blob has no `0x` form, so
 *     it falls back to the empty string `''`)
 */
function blobLiteral(driver: string, hex: string): string {
  if (driver === "postgres") return "'\\x" + hex + "'";
  if (driver === "sqlite") return "X'" + hex + "'";
  return hex.length > 0 ? "0x" + hex : "''";
}

/**
 * Converts a `CellValue` straight from a result row into a SQL literal for
 * row→SQL generation. Unlike `literalFromInput` (which parses user-typed edit
 * text) this trusts the value's runtime type and the column's declared type:
 *   - NULL/undefined → SQL NULL
 *   - BLOB-family column → driver-specific binary literal (`blobLiteral`)
 *   - boolean → TRUE/FALSE, finite number → bare numeral
 *   - numeric column whose value arrived as a numeric-looking string (e.g. a
 *     BIGINT/DECIMAL kept as text to preserve precision) → unquoted numeral
 *   - everything else → a quoted, escaped string literal
 */
function rowValueLiteral(driver: string, v: CellValue, col: Column): string {
  if (v === null || v === undefined) return "NULL";
  const t = col.type_name.toUpperCase();
  if (BINARY_TYPES.has(t)) return blobLiteral(driver, String(v));
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (NUMERIC_TYPES.has(t) && /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(String(v).trim())) {
    return String(v).trim();
  }
  return quoteString(driver, String(v));
}

/** Which statement shape `buildRowSql` should emit for the selected rows. */
export type RowSqlKind = "insert" | "update" | "delete";

export interface BuildRowSqlInput {
  driver: string;
  database: string;
  table: string;
  columns: Column[];
  /** The result rows to turn into statements (one statement per row). */
  rows: CellValue[][];
  /** Primary-key column indices; empty means no resolvable PK. */
  pkIndices: number[];
}

/**
 * Builds executable `INSERT` / `UPDATE` / `DELETE` statements from selected
 * result rows, one statement per row, for the right-click "copy as SQL" menu.
 *
 * - INSERT lists every column with its literal value.
 * - UPDATE sets every non-PK column and keys the WHERE clause on the PK.
 * - DELETE keys the WHERE clause on the PK.
 *
 * `UPDATE`/`DELETE` require a resolvable primary key: without one we cannot
 * build a row-identifying WHERE clause, so they return `[]` (the menu disables
 * them in that case). Identifiers are quoted and the table reference qualified
 * per the driver's dialect, reusing the same helpers as inline-edit Apply.
 */
export function buildRowSql(input: BuildRowSqlInput, kind: RowSqlKind): string[] {
  const { driver, database, table, columns, rows, pkIndices } = input;
  if (columns.length === 0) return [];
  if ((kind === "update" || kind === "delete") && pkIndices.length === 0) return [];
  const ref = qualifiedTableRef(driver, database, table);
  const pkSet = new Set(pkIndices);
  const stmts: string[] = [];
  for (const row of rows) {
    if (!row) continue;
    const whereParts = pkIndices.map(
      (i) =>
        `${quoteIdentFor(driver, columns[i].name)} = ${rowValueLiteral(driver, row[i], columns[i])}`,
    );
    if (kind === "insert") {
      const cols = columns.map((c) => quoteIdentFor(driver, c.name)).join(", ");
      const vals = columns.map((c, i) => rowValueLiteral(driver, row[i], c)).join(", ");
      stmts.push(`INSERT INTO ${ref} (${cols}) VALUES (${vals});`);
    } else if (kind === "update") {
      const setParts = columns
        .map((c, i) =>
          pkSet.has(i)
            ? null
            : `${quoteIdentFor(driver, c.name)} = ${rowValueLiteral(driver, row[i], c)}`,
        )
        .filter((s): s is string => s !== null);
      // Every column is part of the PK — there is nothing to SET.
      if (setParts.length === 0) continue;
      stmts.push(
        `UPDATE ${ref} SET ${setParts.join(", ")} WHERE ${whereParts.join(" AND ")};`,
      );
    } else {
      stmts.push(`DELETE FROM ${ref} WHERE ${whereParts.join(" AND ")};`);
    }
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
