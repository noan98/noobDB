import type { DriverKind } from "./api/tauri";
import { quoteString } from "./components/cellEdit";
import { quoteIdentFor } from "./components/sqlDialect";

/**
 * Interactive query parameters: `{{name}}` placeholders typed into the editor
 * that prompt for a value before the query runs (#388). Detection and the
 * driver-aware, injection-safe substitution live here as pure functions so the
 * security-critical escaping is unit-testable without React. The input UI is in
 * `components/ParameterInputModal.tsx`; App wires detection into the run /
 * preview / explain gate.
 */

/**
 * How a parameter's value is rendered into SQL. The user picks this per
 * parameter (default `text`) so both data values and object names are handled
 * safely:
 *   - `text`       → a quoted, escaped string literal (`'...'`).
 *   - `number`     → a bare numeric literal (no quotes).
 *   - `identifier` → a quoted, escaped identifier (table/column name).
 */
export type ParamType = "text" | "number" | "identifier";

/** A `{{name}}` placeholder. `name` is one or more word chars (letters/digits/_). */
function paramRegex(): RegExp {
  // A fresh instance per call keeps `lastIndex` state from leaking between the
  // `matchAll` (extract) and `replace` (substitute) uses.
  return /\{\{(\w+)\}\}/g;
}

/** A numeric literal acceptable for the `number` parameter type. */
const NUMERIC_RE = /^[+-]?\d+(\.\d+)?(e[+-]?\d+)?$/i;

/** Whether `raw` is a plain numeric literal (used to validate `number` params). */
export function isNumericParam(raw: string): boolean {
  return NUMERIC_RE.test(raw.trim());
}

/** Extract the unique `{{name}}` placeholders in `sql`, in first-seen order. */
export function extractQueryParams(sql: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of sql.matchAll(paramRegex())) {
    const name = m[1];
    if (!seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/**
 * Render one parameter value into safe SQL for its type. **Every branch is
 * injection-safe regardless of input**: `text` and `identifier` go through the
 * driver-aware quoting helpers (which double the relevant quote char), and a
 * `number` whose value isn't actually numeric falls back to a quoted string
 * rather than being inlined raw.
 */
export function renderParamValue(driver: DriverKind, raw: string, type: ParamType): string {
  if (type === "identifier") return quoteIdentFor(driver, raw);
  if (type === "number") return isNumericParam(raw) ? raw.trim() : quoteString(driver, raw);
  return quoteString(driver, raw);
}

/**
 * Replace every `{{name}}` in `sql` with the escaped value for its type. A
 * placeholder with no supplied value is left untouched, so a typo surfaces as a
 * literal `{{name}}` (a clear SQL error) rather than a silent empty match.
 */
export function substituteQueryParams(
  sql: string,
  driver: DriverKind,
  values: Record<string, string>,
  types: Record<string, ParamType>,
): string {
  return sql.replace(paramRegex(), (whole, name: string) => {
    if (!(name in values)) return whole;
    return renderParamValue(driver, values[name], types[name] ?? "text");
  });
}
