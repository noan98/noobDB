import type { CellValue, Column, TableColumnInfo } from "../api/tauri";
import type { I18nKey } from "../i18n";
import { cellValueFromInput, classifyEditType, type EditTypeKind } from "./cellEdit";

/**
 * Right-click "set value" shortcuts for the result grid (`ResultGrid`'s cell
 * context menu).
 *
 * Typing a value by hand is fine for one-off edits, but the handful of values
 * people reach for constantly — SQL NULL above all, plus the empty string, 0,
 * true/false and "now" — are worth one click. This module is the pure,
 * dialect-independent decision of *which* shortcuts a given column offers and
 * *what raw edit-box text* each one produces; `ResultGrid` only wires them to
 * the existing inline-edit / bulk-edit plumbing.
 *
 * The produced `value` is deliberately the same raw string a user could have
 * typed, so every downstream rule (`validateCellInput`, `literalFromInput`,
 * `cellValueFromInput`) applies unchanged — these shortcuts add no new path to
 * the database, they just fill the edit box.
 */

/** Stable identity of a shortcut, used as a React key and in tests. */
export type QuickSetId = "null" | "empty" | "zero" | "true" | "false" | "now";

/**
 * Time-derived shortcuts carry the shape to (re)format instead of a frozen
 * timestamp, so the value is resolved when the user actually clicks — a menu
 * left open for a while must not write a stale clock reading.
 */
export type QuickSetDynamic = "date" | "time" | "datetime";

export interface QuickSetOption {
  id: QuickSetId;
  /** Menu label. */
  labelKey: I18nKey;
  /**
   * Raw edit-box text this shortcut sets. For `dynamic` options this is the
   * value as of the `now` passed to `quickSetOptions` — callers should
   * re-resolve via `resolveDynamicValue` at click time.
   */
  value: string;
  /** Set when `value` is clock-derived; see `QuickSetDynamic`. */
  dynamic?: QuickSetDynamic;
  /** i18n key explaining why the shortcut is unavailable; unset when enabled. */
  disabledReason?: I18nKey;
  /** i18n key with an extra note shown as the item's tooltip. */
  noteKey?: I18nKey;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** `YYYY-MM-DD` in the machine's local time zone (matches `DATE_RE`). */
export function formatLocalDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** `HH:MM:SS` in the machine's local time zone (matches `TIME_RE`). */
export function formatLocalTime(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** `YYYY-MM-DD HH:MM:SS` in the machine's local time zone (matches `DATETIME_RE`). */
export function formatLocalDateTime(d: Date): string {
  return `${formatLocalDate(d)} ${formatLocalTime(d)}`;
}

/**
 * Formats `now` for a clock-derived shortcut. The value comes from the local
 * machine's clock, not the database server's — the menu item says so, because
 * the two differ whenever the server runs in another time zone.
 */
export function resolveDynamicValue(dynamic: QuickSetDynamic, now: Date): string {
  switch (dynamic) {
    case "date":
      return formatLocalDate(now);
    case "time":
      return formatLocalTime(now);
    default:
      return formatLocalDateTime(now);
  }
}

/**
 * The shortcuts offered for one column, in menu order.
 *
 * NULL is always listed (disabled, with the reason, on a NOT NULL column so the
 * constraint is visible rather than the item silently missing). The rest are
 * picked by the column's value shape so the menu stays short and every offered
 * value is actually valid for the column:
 *   - number   → `0`
 *   - boolean  → `true` / `false`
 *   - date / time / datetime → the corresponding "now" value
 *   - anything else (string-like) → the empty string
 *
 * `meta` supplies nullability; when it is missing the column is treated as
 * nullable, matching `validateEdit`'s permissive default.
 */
export function quickSetOptions(input: {
  column: Column;
  meta?: TableColumnInfo | null;
  now: Date;
}): QuickSetOption[] {
  const kind: EditTypeKind = classifyEditType(input.column.type_name);
  const nullable = input.meta?.nullable ?? true;
  const options: QuickSetOption[] = [
    {
      id: "null",
      labelKey: "gridQuickSetNull",
      value: "NULL",
      disabledReason: nullable ? undefined : "editInvalidNotNull",
    },
  ];
  switch (kind) {
    case "number":
      options.push({ id: "zero", labelKey: "gridQuickSetZero", value: "0" });
      break;
    case "boolean":
      options.push(
        { id: "true", labelKey: "gridQuickSetTrue", value: "true" },
        { id: "false", labelKey: "gridQuickSetFalse", value: "false" },
      );
      break;
    case "date":
      options.push({
        id: "now",
        labelKey: "gridQuickSetToday",
        value: formatLocalDate(input.now),
        dynamic: "date",
        noteKey: "gridQuickSetNowNote",
      });
      break;
    case "time":
      options.push({
        id: "now",
        labelKey: "gridQuickSetCurrentTime",
        value: formatLocalTime(input.now),
        dynamic: "time",
        noteKey: "gridQuickSetNowNote",
      });
      break;
    case "datetime":
      options.push({
        id: "now",
        labelKey: "gridQuickSetNow",
        value: formatLocalDateTime(input.now),
        dynamic: "datetime",
        noteKey: "gridQuickSetNowNote",
      });
      break;
    default:
      options.push({
        id: "empty",
        labelKey: "gridQuickSetEmpty",
        value: "",
        noteKey: "gridQuickSetEmptyNote",
      });
      break;
  }
  return options;
}

/**
 * Whether applying `value` to a cell currently holding `current` would be a
 * no-op — i.e. the shortcut sets the value the row already has.
 *
 * Compared through `cellValueFromInput` (the same coercion an applied edit
 * goes through) rather than by raw text, so "NULL" on an already-NULL cell and
 * "0" on a cell holding the number 0 both count as unchanged. Callers clear the
 * cell's buffered edit instead of recording one, which keeps the pending-edit
 * count honest and lets a shortcut undo an earlier edit.
 */
export function quickSetIsNoop(value: string, col: Column, current: CellValue): boolean {
  const next = cellValueFromInput(value, col);
  const nextNull = next === null || next === undefined;
  const currentNull = current === null || current === undefined;
  if (nextNull || currentNull) return nextNull && currentNull;
  return String(next) === String(current);
}
