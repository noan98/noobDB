import { CellValue, Column, TableColumnInfo, TableRowIdentity } from "../api/tauri";
import type { I18nKey } from "../i18n";
import { insertFunctionSql, quoteIdentFor, type InsertFunctionId } from "./sqlDialect";

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

/** BLOB/BINARY/BYTEA 系の列型か (16 進文字列で届く値をバイナリとして扱う判定)。 */
export function isBinaryColumnType(typeName: string): boolean {
  return BINARY_TYPES.has(typeName.toUpperCase());
}

/**
 * Whether a column may be edited inline. BLOB-family columns are excluded
 * because their JSON shape is hex bytes and round-tripping arbitrary
 * binary through the text protocol is fragile.
 */
export function isEditableColumnType(typeName: string): boolean {
  return !BINARY_TYPES.has(typeName.toUpperCase());
}

/**
 * Broad value-shape buckets a column falls into for edit-time validation and
 * for the right-click "set value" shortcuts (`quickSetValues.ts`).
 */
export type EditTypeKind = "number" | "date" | "datetime" | "time" | "boolean" | "other";

/**
 * Buckets a column's reported type name into the broad kinds we validate
 * client-side. Normalizes away `(...)` length/precision and trailing
 * `UNSIGNED` / `ZEROFILL` modifiers, then matches conservatively across the
 * MySQL / PostgreSQL / SQLite spellings. Anything unrecognised falls back to
 * `"other"`, which is never rejected — a false reject (blocking a valid edit)
 * is worse than letting the server have the final say.
 */
export function classifyEditType(typeName: string): EditTypeKind {
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

const INTEGER_TYPES = new Set([
  "TINYINT",
  "SMALLINT",
  "MEDIUMINT",
  "INT",
  "INTEGER",
  "BIGINT",
  "YEAR",
  "SERIAL",
  "BIGSERIAL",
  "SMALLSERIAL",
  "INT2",
  "INT4",
  "INT8",
]);

/** 整数型の列か (`UNSIGNED` / `ZEROFILL` / `(n)` 修飾は無視)。小数入力を弾く判定に使う。 */
export function isIntegerColumnType(typeName: string): boolean {
  const base = typeName
    .toUpperCase()
    .replace(/\(.*$/, "")
    .replace(/\s+(UNSIGNED|ZEROFILL)\b/g, "")
    .trim();
  return INTEGER_TYPES.has(base);
}

const INTEGER_INPUT_RE = /^-?\d+$/;
const NUMERIC_INPUT_RE = /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i;
const DATE_RE = /^\d{4}-\d{1,2}-\d{1,2}$/;
// 末尾のタイムゾーン (`Z` / `+09` / `+09:00` / `+0900`、直前の空白可) は PostgreSQL の
// timestamptz が受理する入力なので許す。最終判断は DB に任せる方針。
const DATETIME_RE = /^\d{4}-\d{1,2}-\d{1,2}[ T]\d{1,2}:\d{2}(:\d{2})?(\.\d+)?\s*(Z|[+-]\d{2}(:?\d{2})?)?$/i;
// PostgreSQL の boolean 入力で有効な表記 (MySQL / SQLite の BOOL でも 0/1 は通る)。
const BOOLEAN_TRUE = new Set(["true", "t", "yes", "y", "on", "1"]);
const BOOLEAN_FALSE = new Set(["false", "f", "no", "n", "off", "0"]);

/**
 * boolean 列の入力表記 (PostgreSQL が受理する true/false/t/f/yes/no/y/n/on/off/1/0、
 * 大文字小文字・前後空白不問) を真偽値に正規化する。受理しない表記は null。検証と
 * 書き込み側 (`literalFromInput` / `cellValueFromInput` / `setValueFromInput`) で共有し、
 * 受理した表記は必ず bool として書く (MySQL / SQLite に 'yes' 文字列を入れない)。
 */
export function parseBooleanInput(s: string): boolean | null {
  const lc = s.trim().toLowerCase();
  if (BOOLEAN_TRUE.has(lc)) return true;
  if (BOOLEAN_FALSE.has(lc)) return false;
  return null;
}
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
 * String-like columns are never rejected here — including an empty box, which
 * means the empty string `''` rather than NULL.
 */
export function validateCellInput(raw: string, typeName: string, nullable: boolean): I18nKey | null {
  const trimmed = raw.trim();
  const kind = classifyEditType(typeName);
  if (/^null$/i.test(trimmed)) {
    return nullable ? null : "editInvalidNotNull";
  }
  if (trimmed === "") {
    // An empty edit box on a string-like column is the empty string literal
    // `''` (that is what `literalFromInput` builds), NOT SQL NULL — so it is
    // a legal value even on a NOT NULL column and must not be reported as a
    // nullability violation. The right-click "set to empty string" shortcut
    // (`quickSetValues.ts`) relies on this.
    if (kind === "other") return null;
    // Other kinds have no empty literal: they need a real value, or NULL when
    // the column allows it.
    if (!nullable) return "editInvalidNotNull";
    return errorKeyForKind(kind);
  }
  switch (kind) {
    case "number":
      // 整数列への小数は DB 側で丸められる (SQLite は REAL のまま保持) 一方、グリッドは
      // 入力値をそのまま表示してしまうため、書き込む前に弾く。
      if (isIntegerColumnType(typeName)) {
        if (INTEGER_INPUT_RE.test(trimmed)) return null;
        return NUMERIC_INPUT_RE.test(trimmed) ? "editInvalidInteger" : "editInvalidNumber";
      }
      return NUMERIC_INPUT_RE.test(trimmed) ? null : "editInvalidNumber";
    case "date":
      return DATE_RE.test(trimmed) ? null : "editInvalidDate";
    case "datetime":
      return DATETIME_RE.test(trimmed) ? null : "editInvalidDateTime";
    case "time":
      return TIME_RE.test(trimmed) ? null : "editInvalidTime";
    case "boolean": {
      return parseBooleanInput(trimmed) !== null ? null : "editInvalidBoolean";
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
export function resolvePkIndices(columns: Column[], tableColumns: TableColumnInfo[] | null): number[] {
  if (!tableColumns) return [];
  const pkNames = tableColumns.filter((c) => c.key.toUpperCase() === "PRI").map((c) => c.name);
  if (pkNames.length === 0) return [];
  const indices: number[] = [];
  for (const name of pkNames) {
    const i = columns.findIndex((c) => c.name === name);
    if (i < 0) return [];
    indices.push(i);
  }
  return indices;
}

/** Which row-identity strategy backs a set of identity indices (#849). */
export type RowIdentityKind = "primary_key" | "rowid" | "ctid" | "all_columns" | "none";

export interface RowIdentityResolution {
  /** Result-column indices to use in the WHERE clause identifying a row. */
  indices: number[];
  strategy: RowIdentityKind;
}

/**
 * Resolves the result-column indices to use for a row's identity (#849): the
 * WHERE clause of an UPDATE/DELETE, and the key `rowEditKey` derives buffered
 * edits from. Tries strategies in order of trustworthiness:
 *
 * 1. A real primary key (`resolvePkIndices`) — always preferred when it
 *    resolves.
 * 2. The backend's `rowIdentity` fallback (`open_table` の `row_identity`, #849) when
 *    the table has none:
 *    - `"rowid"` / `"ctid"` — a single pseudo-column the caller must have
 *      appended to the browse `SELECT` (see `qualifiedTableSql`) and that
 *      must therefore already be present in `columns` under that name.
 *    - `"all_columns"` — every column in the result, in order. This cannot
 *      guarantee uniqueness on its own (see `hasAmbiguousIdentity`), so
 *      callers must warn before applying edits built from it.
 * 3. Nothing resolvable → `{ indices: [], strategy: "none" }`, same as the
 *    previous PK-only behavior (editing stays disabled).
 */
export function resolveRowIdentity(
  columns: Column[],
  tableColumns: TableColumnInfo[] | null,
  rowIdentity: Pick<TableRowIdentity, "strategy" | "hidden_column"> | null,
): RowIdentityResolution {
  const pk = resolvePkIndices(columns, tableColumns);
  if (pk.length > 0) return { indices: pk, strategy: "primary_key" };
  if (!rowIdentity || columns.length === 0) return { indices: [], strategy: "none" };
  if (rowIdentity.strategy === "rowid" || rowIdentity.strategy === "ctid") {
    if (!rowIdentity.hidden_column) return { indices: [], strategy: "none" };
    const idx = columns.findIndex((c) => c.name === rowIdentity.hidden_column);
    if (idx < 0) return { indices: [], strategy: "none" };
    return { indices: [idx], strategy: rowIdentity.strategy };
  }
  if (rowIdentity.strategy === "all_columns") {
    return { indices: columns.map((_, i) => i), strategy: "all_columns" };
  }
  return { indices: [], strategy: "none" };
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
export function rowEditKey(row: CellValue[], pkIndices: number[], fallbackIndex: number): string {
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

/**
 * True when two or more rows share the exact same identity (#849's
 * `"all_columns"` fallback: without a PK/UNIQUE constraint, nothing stops the
 * database from holding genuinely duplicate rows). When this is true, a
 * WHERE clause built from that identity would match every duplicate at once
 * — an UPDATE/DELETE meant for one row silently touches all of them. Callers
 * use this to warn before applying an edit built from a non-PK identity.
 *
 * Only meaningful for the `"all_columns"` (and, in principle, `"rowid"`/
 * `"ctid"`, though those are physically unique by construction) strategies —
 * a real primary key can never collide, so callers typically skip this check
 * once `resolveRowIdentity` reports `"primary_key"`.
 */
export function hasAmbiguousIdentity(rows: CellValue[][], indices: number[]): boolean {
  if (indices.length === 0) return false;
  const seen = new Set<string>();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    const key = rowEditKey(row, indices, i);
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

export function qualifiedTableRef(driver: string, database: string, table: string): string {
  // SQLite has a single namespace per connection — the synthetic "main"
  // database label is for the UI tree, not the SQL itself.
  if (driver === "sqlite") return quoteIdentFor(driver, table);
  return `${quoteIdentFor(driver, database)}.${quoteIdentFor(driver, table)}`;
}

export function quoteString(driver: string, s: string): string {
  // Single quotes are doubled in every dialect. Backslash is only special
  // inside MySQL string literals; Postgres/SQLite (with the default
  // `standard_conforming_strings = on`) treat it as an ordinary character,
  // so doubling it there would corrupt the stored value (and break PK
  // matching when a key contains a backslash). Mirror `quoteIdentFor`'s
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
  if (typeof v === "boolean") {
    return v ? "TRUE" : "FALSE";
  }
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  return quoteString(driver, String(v));
}

/**
 * Builds one `col = <literal>` / `col IS NULL` WHERE-clause term identifying
 * a row by an original (not user-edited) cell value. A plain `= NULL` is
 * always false in SQL, so NULL must use `IS NULL` instead — this never
 * mattered while row identity was PK-only (PK columns are practically never
 * NULL), but the `"all_columns"` fallback (#849) routinely includes nullable
 * columns in the WHERE clause, so every identity-WHERE builder below goes
 * through this helper rather than inlining `literalFromCellValue`.
 */
function whereEqualsClause(driver: string, col: Column, v: CellValue): string {
  const quoted = quoteIdentFor(driver, col.name);
  if (v === null || v === undefined) return `${quoted} IS NULL`;
  // BLOB 列の値は 16 進文字列で届く。通常の文字列として引用すると 0 行にしか
  // 当たらない (all_columns 同定で BLOB を含む表の更新・削除) ため、バイナリ
  // リテラルにする。
  if (BINARY_TYPES.has(col.type_name.toUpperCase()) && isHexBytes(v)) {
    return `${quoted} = ${blobLiteral(driver, v)}`;
  }
  // 単精度 (PG の FLOAT4 / REAL、MySQL の FLOAT) は、バックエンドが f32 の最短表記
  // (0.1 など) で返す (#1534)。`col = 0.1` は列が倍精度へ広がった値と比べられて一致しない
  // ため、f32 の丸め誤差より十分大きい相対許容差で比較する。
  const approx = singleFloatWhere(driver, col, v);
  if (approx) return approx;
  return `${quoted} = ${literalFromCellValue(driver, v)}`;
}

/** 単精度 float 列の WHERE 項 (`ABS(col - x) <= ...`)。対象外の列・値は null。 */
function singleFloatWhere(driver: string, col: Column, v: CellValue): string | null {
  if (!isSinglePrecisionFloat(driver, col) || typeof v !== "number" || !Number.isFinite(v)) {
    return null;
  }
  const quoted = quoteIdentFor(driver, col.name);
  const lit = `(${literalFromCellValue(driver, v)})`;
  return `ABS(${quoted} - ${lit}) <= ABS(${lit}) * ${FLOAT4_WHERE_REL_TOLERANCE}`;
}

/** f32 の相対精度 (約 6e-8) より大きく、別の値と取り違えない程度の許容差。 */
const FLOAT4_WHERE_REL_TOLERANCE = "0.000001";

function isSinglePrecisionFloat(driver: string, col: Column): boolean {
  // SQLite の REAL は常に f64 (最短表記でも厳密に往復する)。
  if (driver === "sqlite") return false;
  const t = col.type_name.toUpperCase();
  return t === "FLOAT4" || t === "REAL" || t === "FLOAT";
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
export function literalFromInput(driver: string, raw: string, col: Column): string {
  const trimmed = raw.trim();
  if (/^null$/i.test(trimmed)) return "NULL";
  const t = col.type_name.toUpperCase();
  if (NUMERIC_TYPES.has(t) && /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(trimmed)) {
    return trimmed;
  }
  if (t === "BOOLEAN" || t === "BOOL") {
    const b = parseBooleanInput(trimmed);
    if (b !== null) return b ? "TRUE" : "FALSE";
  }
  if (t === "BIT") {
    const lc = trimmed.toLowerCase();
    if (lc === "true" || lc === "1") return "1";
    if (lc === "false" || lc === "0") return "0";
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
    const b = parseBooleanInput(trimmed);
    if (b !== null) return b;
  }
  return raw;
}

/**
 * 編集欄の入力から「実際に保存される値」の注記を作る (#1628)。`cellValueFromInput` と同じ
 * 変換を通すので、Apply 後にグリッドへ反映される値と食い違わない。
 *
 * 入力がそのまま保存されるだけの通常のテキスト・数値は注記不要なので `null`。注記が要るのは
 * 次の場合: NULL 化 (`NULL` と打った)、空文字の保存、真偽値表記の正規化 (`yes` → `TRUE`)、
 * 数値の正規化 (`007` → `7`)、前後の空白をそのまま保存する文字列。
 */
export type SavedValuePreview =
  | { kind: "null" }
  | { kind: "empty" }
  | { kind: "normalized"; value: string; raw: string }
  | { kind: "edgeSpace" };

export function previewSavedValue(raw: string, col: Column): SavedValuePreview | null {
  const v = cellValueFromInput(raw, col);
  if (v === null || v === undefined) return { kind: "null" };
  const trimmed = raw.trim();
  if (typeof v === "boolean") {
    const shown = v ? "TRUE" : "FALSE";
    return trimmed === shown ? null : { kind: "normalized", value: shown, raw: trimmed };
  }
  if (typeof v === "number") {
    // DECIMAL/NUMERIC は DB が列の小数桁に合わせて保存する ("1.50" は 1.50 のまま) ので、
    // JS の数値表記への「正規化」を示すと誤解を招く。
    if (/decimal|numeric|money/i.test(col.type_name)) return null;
    const shown = String(v);
    return trimmed === shown ? null : { kind: "normalized", value: shown, raw: trimmed };
  }
  if (raw === "") {
    // 文字列系の空欄は NULL ではなく空文字 (`literalFromInput` が `''` を作る)。
    // 数値・日時などは空欄が検証エラーになるのでここへは来ない前提だが、注記は文字列系に限る。
    return classifyEditType(col.type_name) === "other" ? { kind: "empty" } : null;
  }
  if (raw !== trimmed && classifyEditType(col.type_name) === "other") return { kind: "edgeSpace" };
  return null;
}

/**
 * Whether buffering `raw` for a cell currently holding `current` would be a
 * no-op — i.e. the edit sets the value the row already has.
 *
 * Compared through `cellValueFromInput` (the same coercion an applied edit goes
 * through) rather than by raw text, so "NULL" on an already-NULL cell and "0"
 * on a cell holding the number 0 both count as unchanged. Callers clear the
 * cell's buffered edit instead of recording one, which keeps the pending-edit
 * count honest, avoids emitting `SET col = <same value>` at Apply, and lets the
 * action undo an earlier edit on that cell.
 */
export function editIsNoop(raw: string, col: Column, current: CellValue): boolean {
  const next = cellValueFromInput(raw, col);
  const nextNull = next === null || next === undefined;
  const currentNull = current === null || current === undefined;
  if (nextNull || currentNull) return nextNull && currentNull;
  return String(next) === String(current);
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
    const whereParts = input.pkIndices.map((i) => whereEqualsClause(input.driver, input.columns[i], row[i]));
    stmts.push(`UPDATE ${ref} SET ${setParts.join(", ")} WHERE ${whereParts.join(" AND ")};`);
  }
  return stmts;
}

/**
 * `SET` に書く値を列型に応じて分類したもの (#1259)。`literalFromInput` と同じ判定を
 * SQL 文字列ではなく構造で表し、リテラル化 (方言別エスケープ) は Rust の
 * `bulk_update_cells` が担う。
 */
export type BulkSetValue =
  | { kind: "null" }
  | { kind: "number"; text: string }
  | { kind: "bool"; value: boolean }
  | { kind: "text"; text: string };

/**
 * `literalFromInput` と同じ規則で、入力テキストを構造化した値へ分類する:
 *   - "NULL" (大小無視・trim 後) → null
 *   - 数値列 + 数値らしい入力 → number (trim 済みテキストをそのまま)
 *   - BOOLEAN 列 + true/false/0/1 → bool
 *   - BIT 列 + true/false/0/1 → number "1" / "0"
 *   - それ以外 → 生の文字列 (trim しない)
 */
export function setValueFromInput(raw: string, col: Column): BulkSetValue {
  const trimmed = raw.trim();
  if (/^null$/i.test(trimmed)) return { kind: "null" };
  const t = col.type_name.toUpperCase();
  if (NUMERIC_TYPES.has(t) && /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(trimmed)) {
    return { kind: "number", text: trimmed };
  }
  if (t === "BOOLEAN" || t === "BOOL") {
    const b = parseBooleanInput(trimmed);
    if (b !== null) return { kind: "bool", value: b };
  }
  if (t === "BIT") {
    const lc = trimmed.toLowerCase();
    if (lc === "true" || lc === "1") return { kind: "number", text: "1" };
    if (lc === "false" || lc === "0") return { kind: "number", text: "0" };
  }
  return { kind: "text", text: raw };
}

/** 同じ `SET` (列, 値) を適用する行の集合。`keys` は各行の元の主キー値。 */
export interface UpdateGroup {
  set: { column: string; value: BulkSetValue }[];
  keys: CellValue[][];
}

/**
 * 保留中のセル編集を、同じ (列, 値) の組ごとにまとめた構造化入力へ変換する (#1259)。
 * `buildUpdateStatements` が 1 行 1 `UPDATE` (リテラル埋め込み) を返していたのに対し、
 * こちらはグループ化だけを行い、SQL 組み立て (`UPDATE t SET c = v WHERE pk IN (…)`) と
 * リテラル化は Rust の `bulk_update_cells` が担う。行の走査順・重複排除・元の主キー値
 * での特定は `buildUpdateStatements` と同じ (`rows` を上から順に見る)。グループは
 * 最初に現れた行の順に並ぶ。`rowCount` は編集対象の行数 (進捗表示用)。
 */
export function buildUpdateGroups(input: BuildUpdateInput): {
  groups: UpdateGroup[];
  rowCount: number;
} {
  if (input.pkIndices.length === 0) return { groups: [], rowCount: 0 };
  const groups = new Map<string, UpdateGroup>();
  const emitted = new Set<string>();
  let rowCount = 0;
  for (let rowIdx = 0; rowIdx < input.rows.length; rowIdx++) {
    const row = input.rows[rowIdx];
    if (!row) continue;
    const key = rowEditKey(row, input.pkIndices, rowIdx);
    if (emitted.has(key)) continue;
    const rowEdits = input.edits[key];
    if (!rowEdits) continue;
    emitted.add(key);
    const set: UpdateGroup["set"] = [];
    for (const colKey of Object.keys(rowEdits)) {
      const colIdx = Number(colKey);
      const col = input.columns[colIdx];
      if (!col) continue;
      set.push({ column: col.name, value: setValueFromInput(rowEdits[colIdx], col) });
    }
    if (set.length === 0) continue;
    rowCount++;
    const sig = JSON.stringify(set);
    let g = groups.get(sig);
    if (!g) {
      g = { set, keys: [] };
      groups.set(sig, g);
    }
    g.keys.push(input.pkIndices.map((i) => row[i]));
  }
  return { groups: [...groups.values()], rowCount };
}

/**
 * 1 セルの BLOB を丸ごと差し替える `UPDATE` を 1 文組み立てる (#1148、ファイルからの
 * 読み込み)。`hex` は新しい内容の 16 進文字列。WHERE は行の**元の**主キー値で組む
 * (`buildUpdateStatements` と同じ規約)。主キーが無い / 列が範囲外なら null。
 */
export function buildBlobUpdateStatement(input: {
  driver: string;
  database: string;
  table: string;
  columns: Column[];
  row: CellValue[];
  pkIndices: number[];
  colIdx: number;
  hex: string;
}): string | null {
  const { driver, columns, row, pkIndices, colIdx, hex } = input;
  const col = columns[colIdx];
  if (!col || pkIndices.length === 0 || !/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) {
    return null;
  }
  const ref = qualifiedTableRef(driver, input.database, input.table);
  const where = pkIndices.map((i) => whereEqualsClause(driver, columns[i], row[i]));
  return `UPDATE ${ref} SET ${quoteIdentFor(driver, col.name)} = ${blobLiteral(driver, hex.toLowerCase())} WHERE ${where.join(" AND ")};`;
}

/**
 * 行追加で DB 側の関数を式として入れる値 (#1357)。`sql` は `insertFunctionSql` の
 * 固定カタログ由来で、利用者が打った文字列は決してここに入らない (打った文字列は
 * 通常どおり `string` として `literalFromInput` で引用される)。
 */
export interface InsertFunctionValue {
  fn: InsertFunctionId;
}

/**
 * 空文字 `''` を明示した値 (#1526)。行の複製で元が空文字の列を、NULL / 未設定
 * (= DB 既定値) と区別して INSERT まで届けるために使う。素の `""` は「空欄 = 既定値」
 * (#1357) のままなので、別の値として持つ。
 */
export interface InsertEmptyStringValue {
  empty: true;
}

/** 行追加バッファの 1 セル。`string` は利用者の入力 (リテラル化される)、関数値は式そのまま。 */
export type PendingInsertValue = string | InsertFunctionValue | InsertEmptyStringValue;

/** 関数値か (`string` / 空文字値ではない)。 */
export function isInsertFunctionValue(v: PendingInsertValue | undefined): v is InsertFunctionValue {
  return typeof v === "object" && v !== null && "fn" in v;
}

/** 空文字を明示した値か。 */
export function isInsertEmptyStringValue(v: PendingInsertValue | undefined): v is InsertEmptyStringValue {
  return typeof v === "object" && v !== null && "empty" in v;
}

/** One pending new row: column index → typed value. Unset columns are
 *  omitted from the INSERT so the database applies defaults / auto-increment.
 *  A value of `"null"` (any case) becomes SQL `NULL`. */
export type PendingInsertRow = Record<number, PendingInsertValue>;

/**
 * 空欄 (`""` / 未設定) の行追加セルか。空欄は INSERT の列から省き、DB の既定値 /
 * 自動採番に委ねる (#1357)。関数値は空欄ではない。
 */
export function isEmptyInsertValue(v: PendingInsertValue | undefined): boolean {
  return v === undefined || v === "";
}

/**
 * Builds one `INSERT INTO ... (cols) VALUES (...)` per pending new row.
 * Only the columns the user filled are included (empty cells are omitted so the
 * database applies its default / auto-increment). Typed text goes through the
 * same `literalFromInput` coercion used by cell edits; a function value becomes
 * its bare expression via `insertFunctionSql` for this driver. Rows with no
 * filled columns are skipped. A row holding a function the driver lacks
 * (`insertFunctionSql` → `null`) is excluded as a whole, never emitted with a
 * wrong value; the UI does not offer such a function, so this only guards
 * against stale state.
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
    const cols: string[] = [];
    const vals: string[] = [];
    let unsupported = false;
    for (const i of Object.keys(row).map(Number)) {
      const col = input.columns[i];
      const v = row[i];
      if (col === undefined || isEmptyInsertValue(v)) continue;
      const literal =
        typeof v === "string"
          ? literalFromInput(input.driver, v, col)
          : isInsertFunctionValue(v)
            ? insertFunctionSql(input.driver, v.fn)
            : "''";
      if (literal === null) {
        unsupported = true;
        break;
      }
      cols.push(quoteIdentFor(input.driver, col.name));
      vals.push(literal);
    }
    if (unsupported || cols.length === 0) continue;
    stmts.push(`INSERT INTO ${ref} (${cols.join(", ")}) VALUES (${vals.join(", ")});`);
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
    const whereParts = input.pkIndices.map((i) => whereEqualsClause(input.driver, input.columns[i], row[i]));
    stmts.push(`DELETE FROM ${ref} WHERE ${whereParts.join(" AND ")};`);
  }
  return stmts;
}

/**
 * Renders a BLOB cell value (carried as a bare hex string, per CLAUDE.md's
 * `Value::Bytes`) as a driver-appropriate binary literal:
 *   - PostgreSQL: `'\xDEADBEEF'` (bytea hex input; one `\x` prefix for the
 *     whole string; backslash is literal under standard-conforming strings)
 *   - SQLite:     `X'DEADBEEF'` (blob literal)
 *   - MySQL:      `0xDEADBEEF` (hex literal; an empty blob has no `0x` form, so
 *     it falls back to the empty string `''`)
 */
/**
 * BINARY 系の列でも、値が 16 進文字列として届いたときだけバイナリリテラルにする。
 * SQLite の非 STRICT テーブルは BLOB 宣言の列に TEXT / INTEGER を入れられ、その値は
 * 文字列・数値のまま届く。確認せず `X'…'` に埋めると SQL インジェクション / 構文エラーになる
 * (Rust 側 `sqlite.rs` の `pk_literal` も同じ確認をする)。
 */
function isHexBytes(v: CellValue): v is string {
  return typeof v === "string" && /^([0-9a-f]{2})*$/i.test(v);
}

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
export function rowValueLiteral(driver: string, v: CellValue, col: Column): string {
  if (v === null || v === undefined) return "NULL";
  const t = col.type_name.toUpperCase();
  if (BINARY_TYPES.has(t) && isHexBytes(v)) return blobLiteral(driver, v);
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

function rowWhereParts(driver: string, columns: Column[], row: CellValue[], pkIndices: number[]): string[] {
  return pkIndices.map((i) => {
    const v = row[i];
    const quoted = quoteIdentFor(driver, columns[i].name);
    // A real WHERE `= NULL` never matches (SQL three-valued logic) — see
    // `whereEqualsClause`'s doc for why this matters once identity can
    // include nullable columns (#849's all_columns fallback).
    if (v === null || v === undefined) return `${quoted} IS NULL`;
    const approx = singleFloatWhere(driver, columns[i], v);
    if (approx) return approx;
    return `${quoted} = ${rowValueLiteral(driver, v, columns[i])}`;
  });
}

/**
 * 1 行を主キーで特定する WHERE 述語 (`"id" = 1 AND ...`)。`UPDATE` / `DELETE` のコピーと
 * 同じ規則 (NULL は `IS NULL`、64bit 整数・BLOB は `CellValue` から生成)。主キーが解決できない
 * (`pkIndices` が空) ときは null (#1541)。
 */
export function buildRowWhere(
  driver: string,
  columns: Column[],
  row: CellValue[],
  pkIndices: number[],
): string | null {
  if (pkIndices.length === 0) return null;
  return rowWhereParts(driver, columns, row, pkIndices).join(" AND ");
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
    const whereParts = rowWhereParts(driver, columns, row, pkIndices);
    if (kind === "insert") {
      const cols = columns.map((c) => quoteIdentFor(driver, c.name)).join(", ");
      const vals = columns.map((c, i) => rowValueLiteral(driver, row[i], c)).join(", ");
      stmts.push(`INSERT INTO ${ref} (${cols}) VALUES (${vals});`);
    } else if (kind === "update") {
      const setParts = columns
        .map((c, i) =>
          pkSet.has(i) ? null : `${quoteIdentFor(driver, c.name)} = ${rowValueLiteral(driver, row[i], c)}`,
        )
        .filter((s): s is string => s !== null);
      // Every column is part of the PK — there is nothing to SET.
      if (setParts.length === 0) continue;
      stmts.push(`UPDATE ${ref} SET ${setParts.join(", ")} WHERE ${whereParts.join(" AND ")};`);
    } else {
      stmts.push(`DELETE FROM ${ref} WHERE ${whereParts.join(" AND ")};`);
    }
  }
  return stmts;
}

/**
 * Fallback table name used by `buildInsertClipboard` when no concrete target
 * table can be resolved (e.g. a JOIN or otherwise free-form query result with
 * no single owning table). Mirrors the backend's SQL-export fallback
 * (`commands/export.rs`'s `exported_table`) so the two "copy as INSERT" paths
 * agree on what an unresolved table looks like.
 */
export const FALLBACK_INSERT_TABLE = "exported_table";

export interface BuildInsertClipboardResult {
  /** The generated SQL, or `""` when there was nothing to emit (no rows or
   *  no columns). */
  sql: string;
  /** `false` when `table` was empty/unresolved and `FALLBACK_INSERT_TABLE`
   *  was substituted — callers should warn the user the table name needs
   *  editing before the statement can run as-is. */
  tableResolved: boolean;
}

export interface BuildInsertClipboardInput {
  driver: string;
  database: string;
  /** Resolved target table name, or `null`/`undefined`/blank when the
   *  result's origin table is ambiguous (e.g. a JOIN). */
  table: string | null | undefined;
  columns: Column[];
  /** The selected result rows, one INSERT (or VALUES tuple) per row. */
  rows: CellValue[][];
}

/**
 * Builds a clipboard-ready `INSERT` payload for one or more selected result
 * rows — the row context menu / range-selection "Copy as INSERT" action
 * (#601).
 *
 * `combineValues` selects the statement shape:
 *   - `false` — one `INSERT INTO ... VALUES (...);` per row (delegates to
 *     `buildRowSql`, so the literal/escaping rules are identical to the
 *     existing single-row "copy as INSERT").
 *   - `true`  — a single statement with one `VALUES` tuple per row:
 *     `INSERT INTO ... VALUES (...), (...), ...;`.
 *
 * When `table` is missing/blank, falls back to `FALLBACK_INSERT_TABLE` and
 * reports `tableResolved: false` so the caller can surface a warning instead
 * of silently emitting SQL against a guessed table name.
 */
export function buildInsertClipboard(
  input: BuildInsertClipboardInput,
  combineValues: boolean,
): BuildInsertClipboardResult {
  const { driver, database, columns, rows } = input;
  const tableResolved = !!(input.table && input.table.trim().length > 0);
  const table = tableResolved ? (input.table as string).trim() : FALLBACK_INSERT_TABLE;
  const validRows = rows.filter((r): r is CellValue[] => !!r);
  if (columns.length === 0 || validRows.length === 0) {
    return { sql: "", tableResolved };
  }
  if (!combineValues) {
    const stmts = buildRowSql({ driver, database, table, columns, rows: validRows, pkIndices: [] }, "insert");
    return { sql: stmts.join("\n"), tableResolved };
  }
  const ref = qualifiedTableRef(driver, database, table);
  const cols = columns.map((c) => quoteIdentFor(driver, c.name)).join(", ");
  const tuples = validRows.map(
    (row) => `(${columns.map((c, i) => rowValueLiteral(driver, row[i], c)).join(", ")})`,
  );
  return {
    sql: `INSERT INTO ${ref} (${cols}) VALUES ${tuples.join(", ")};`,
    tableResolved,
  };
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
