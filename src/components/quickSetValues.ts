import type { CellValue, Column, TableColumnInfo } from "../api/tauri";
import type { I18nKey } from "../i18n";
import { classifyEditType, type EditTypeKind } from "./cellEdit";

/** 空文字 '' を正当な値として受け付ける (文字列系の) 型名か。型名なし (SQLite) も許す。 */
function acceptsEmptyString(base: string): boolean {
  if (base === "") return true;
  return /CHAR|TEXT|STRING|CLOB|^NAME$|^CITEXT$/.test(base);
}

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
export type QuickSetId = "null" | "empty" | "zero" | "true" | "false" | "now" | "above";

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

/** `BIT` on a driver where it is *not* a boolean but a bit string. */
function isBitStringDriver(driver: string | undefined): boolean {
  // PostgreSQL `BIT(n)` holds a string of bits ('10110000'), not a truth
  // value: `TRUE`/`FALSE` are invalid literals for it and so is `''` (there
  // is no zero-length `bit(n)`). Everywhere else — MySQL/SQLite where 1/0 is
  // a valid BIT value — true/false is both meaningful and safe
  // (`literalFromInput` emits 1/0).
  return driver === "postgres";
}

const BOOLEAN_OPTIONS: QuickSetOption[] = [
  { id: "true", labelKey: "gridQuickSetTrue", value: "true" },
  { id: "false", labelKey: "gridQuickSetFalse", value: "false" },
];

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
 * `BIT` is the one type whose meaning depends on the driver, so it is decided
 * here rather than in `classifyEditType` (which sees only the type name): see
 * `isBitStringDriver`. On a bit-string driver nothing but NULL is offered —
 * neither `true`/`false` nor `''` is a valid bit-string literal, and suggesting
 * a value that is guaranteed to fail at Apply is worse than suggesting none.
 *
 * `meta` supplies nullability; when it is missing the column is treated as
 * nullable, matching `validateEdit`'s permissive default.
 */
export function quickSetOptions(input: {
  column: Column;
  meta?: TableColumnInfo | null;
  now: Date;
  /** Session driver, for the `BIT` split above. Unknown/absent → not a bit string. */
  driver?: string;
  /**
   * 同じ列で表示順の直前の行の値 (#1628)。直前の行が無い (先頭行)・出してはいけない
   * (マスク中など) ときは `undefined`。`null` は NULL を意味する。
   */
  aboveValue?: CellValue;
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
  const above = aboveQuickSetOption(input.aboveValue, nullable);
  // `classifyEditType` buckets BIT as "other" (it cannot know the driver), so
  // intercept it before the string-like default would offer the empty string.
  const base = input.column.type_name.toUpperCase().replace(/\(.*$/, "").trim();
  if (base === "BIT") {
    if (!isBitStringDriver(input.driver)) options.push(...BOOLEAN_OPTIONS);
    if (above) options.push(above);
    return options;
  }
  switch (kind) {
    case "number":
      options.push({ id: "zero", labelKey: "gridQuickSetZero", value: "0" });
      break;
    case "boolean":
      options.push(...BOOLEAN_OPTIONS);
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
      // JSON / uuid / inet / xml / 配列など '' を受け付けない型では、Apply が必ず失敗する値を
      // 出さない。空文字が正当なのは文字列系 (と型名が無い SQLite の列) だけ。
      if (!acceptsEmptyString(base)) break;
      options.push({
        id: "empty",
        labelKey: "gridQuickSetEmpty",
        value: "",
        noteKey: "gridQuickSetEmptyNote",
      });
      break;
  }
  if (above) options.push(above);
  return options;
}

/**
 * 「上の行と同じ値」(#1628)。直前の行の値を、手で打つ文字列と同じ生テキストにして返す。
 * 値の検証・NOT NULL・型別の変換は他のショートカットと同じ経路 (`validateCellInput` など) が
 * 担うので、ここでは作らない。上の値が NULL で列が NOT NULL のときは無効化して理由を出す。
 * 文字列の `NULL` は入力欄では NULL 化の指示と区別できないので、曖昧なものは無効化する。
 */
function aboveQuickSetOption(aboveValue: CellValue | undefined, nullable: boolean): QuickSetOption | null {
  if (aboveValue === undefined) return null;
  const base: QuickSetOption = { id: "above", labelKey: "gridQuickSetAbove", value: "NULL" };
  if (aboveValue === null) {
    return nullable ? base : { ...base, disabledReason: "editInvalidNotNull" };
  }
  const text = String(aboveValue);
  if (/^null$/i.test(text.trim()))
    return { ...base, value: text, disabledReason: "gridQuickSetAboveAmbiguous" };
  return { ...base, value: text };
}
