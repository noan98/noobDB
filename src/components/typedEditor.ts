/**
 * 型別インライン・エディタ (#1355) の判定・変換を司る純ロジック。
 *
 * 日付/日時/時刻はネイティブの `<input type="date|datetime-local|time">`、真偽値は
 * `<select>` で編集する。ここで決めるのは「どのコントロールを出すか」と DB 文字列 ↔
 * ネイティブ入力値の変換だけ。確定値は従来どおりテキストとして `PendingEdits` /
 * `PendingInsertRow` に載り、SQL リテラル化は `cellEdit.ts` が行う (書き込み経路は不変)。
 * 型分類は `cellEdit.ts` の `classifyEditType` を単一ソースとして使う。
 */

import { classifyEditType } from "./cellEdit";
import { resolveBoolTruthy } from "./cellTypeMeta";

export type NativeInputType = "date" | "datetime-local" | "time";

export type TypedEditor =
  | { control: "native"; inputType: NativeInputType }
  | { control: "bool" };

const NATIVE_RE: Record<NativeInputType, RegExp> = {
  date: /^\d{4}-\d{2}-\d{2}$/,
  "datetime-local": /^\d{4}-\d{2}-\d{2}[ T]([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d{1,3})?)?$/,
  time: /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d{1,3})?)?$/,
};

const isBlank = (s: string): boolean => s.trim() === "" || /^null$/i.test(s.trim());

/**
 * 列の型名と編集中の現在値から、出し分けるエディタを決める。ネイティブ入力で表現
 * できない値 (MySQL の `838:59:59`、タイムゾーン付き、小数 4 桁以上など) は `null`
 * を返し、呼び出し側は従来のテキスト入力にフォールバックする (値を失わないため)。
 */
export function resolveTypedEditor(typeName: string, current: string): TypedEditor | null {
  const kind = classifyEditType(typeName);
  if (kind === "boolean") return { control: "bool" };
  const inputType: NativeInputType | null =
    kind === "date" ? "date" : kind === "datetime" ? "datetime-local" : kind === "time" ? "time" : null;
  if (inputType === null) return null;
  return isBlank(current) || NATIVE_RE[inputType].test(current.trim())
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
 * ネイティブ入力の value → 編集バッファ文字列。`datetime-local` は DB が受け付ける
 * 空白区切りに戻す。クリア (空) は `blankAs` (グリッドでは "NULL"、行追加では "" =
 * DB 既定値に委ねる) へ。
 */
export function fromNativeValue(inputType: NativeInputType, native: string, blankAs: string): string {
  if (native === "") return blankAs;
  return inputType === "datetime-local" ? native.replace("T", " ") : native;
}

/** 真偽値セレクタの選択肢 (値はそのままリテラル生成に渡る)。 */
export function boolOptions(current: string): string[] {
  // 現在値が 1/0 表記なら選択肢も 1/0 にそろえ、選び直しで表記が変わらないようにする。
  const numeric = /^[01]$/.test(current.trim());
  return numeric ? ["1", "0", "NULL"] : ["true", "false", "NULL"];
}

/** 現在値に対応するセレクタの選択値 (空・NULL は "NULL"、判定外は "NULL")。 */
export function boolSelectValue(current: string): string {
  const opts = boolOptions(current);
  if (isBlank(current)) return "NULL";
  return resolveBoolTruthy(current) ? opts[0] : opts[1];
}
