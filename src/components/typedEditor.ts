/**
 * 型別インライン・エディタ (#1355) の判定・変換を司る純ロジック。
 *
 * 日付/日時/時刻はネイティブの `<input type="date|datetime-local|time">`、真偽値は
 * `<select>` で編集する。ここで決めるのは「どのコントロールを出すか」と DB 文字列 ↔
 * ネイティブ入力値の変換だけ。確定値は従来どおりテキストとして `PendingEdits` /
 * `PendingInsertRow` に載り、SQL リテラル化は `cellEdit.ts` が行う (書き込み経路は不変)。
 * 型分類は `cellEdit.ts` の `classifyEditType` を単一ソースとして使う。
 *
 * エディタ種別は**編集開始時の値で一度だけ**決めること (打鍵の途中でコントロールが
 * 切り替わると入力が壊れるため)。
 */

import { classifyEditType } from "./cellEdit";
import { resolveBoolTruthy } from "./cellTypeMeta";

export type NativeInputType = "date" | "datetime-local" | "time";

export type TypedEditor =
  | { control: "native"; inputType: NativeInputType }
  | { control: "bool" };

// 小数秒を持つ値と月日 00 (MySQL のゼロ日付) は、ネイティブ入力で往復すると値が
// 変わるので対象外 (テキスト入力にフォールバックして値を保つ)。
const DATE_PART = "\\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])";
const TIME_PART = "([01]\\d|2[0-3]):[0-5]\\d(:[0-5]\\d)?";
const NATIVE_RE: Record<NativeInputType, RegExp> = {
  date: new RegExp(`^${DATE_PART}$`),
  "datetime-local": new RegExp(`^${DATE_PART}[ T]${TIME_PART}$`),
  time: new RegExp(`^${TIME_PART}$`),
};

const isBlank = (s: string): boolean => s.trim() === "" || /^null$/i.test(s.trim());

/**
 * 列の型名と編集開始時の値から、出し分けるエディタを決める。ネイティブ入力・セレクタで
 * 表現できない値 (MySQL の `838:59:59`、タイムゾーン付き、小数秒、真偽値の想定外表記、
 * 打鍵で始めた編集の 1 文字目など) は `null` を返し、呼び出し側は従来のテキスト入力に
 * フォールバックする (値を失わないため)。
 */
export function resolveTypedEditor(typeName: string, start: string): TypedEditor | null {
  const kind = classifyEditType(typeName);
  if (kind === "boolean") {
    return isBlank(start) || /^(true|false|0|1)$/i.test(start.trim()) ? { control: "bool" } : null;
  }
  const inputType: NativeInputType | null =
    kind === "date" ? "date" : kind === "datetime" ? "datetime-local" : kind === "time" ? "time" : null;
  if (inputType === null) return null;
  return isBlank(start) || NATIVE_RE[inputType].test(start.trim())
    ? { control: "native", inputType }
    : null;
}

/** DB 文字列 → ネイティブ入力の value (`datetime-local` は空白を `T` に)。 */
export function toNativeValue(inputType: NativeInputType, text: string): string {
  const s = text.trim();
  if (isBlank(s)) return "";
  return inputType === "datetime-local" ? s.replace(" ", "T") : s;
}

/**
 * ネイティブ入力の value → 編集バッファ文字列。書式は編集開始時の値 `original` に
 * そろえる: 日時の区切り (`T` / 空白) を引き継ぎ、元の値に秒があれば秒 0 でも `:00` を
 * 補う (ブラウザは秒 0 だと `HH:MM` に正規化するため)。クリア (空) は `blankAs`
 * (グリッドでは "NULL"、行追加では "" = DB 既定値に委ねる) へ。
 */
export function fromNativeValue(
  inputType: NativeInputType,
  native: string,
  blankAs: string,
  original = "",
): string {
  if (native === "") return blankAs;
  let v = native;
  if (inputType !== "date" && /\d{2}:\d{2}:\d{2}$/.test(original.trim()) && /(^|[T ])\d{2}:\d{2}$/.test(v)) {
    v += ":00";
  }
  if (inputType === "datetime-local") {
    v = v.replace("T", original.includes("T") ? "T" : " ");
  }
  return v;
}

/**
 * 真偽値セレクタの選択肢 (値はそのままリテラル生成に渡る)。`start` (編集開始時の値) が
 * 1/0 表記なら選択肢も 1/0 にそろえ、選び直しで表記が変わらないようにする。
 */
export function boolOptions(start: string): string[] {
  return /^[01]$/.test(start.trim()) ? ["1", "0", "NULL"] : ["true", "false", "NULL"];
}

/** 現在値に対応するセレクタの選択値 (空・NULL は "NULL")。 */
export function boolSelectValue(current: string, start: string): string {
  if (isBlank(current)) return "NULL";
  const opts = boolOptions(start);
  return resolveBoolTruthy(current) ? opts[0] : opts[1];
}
