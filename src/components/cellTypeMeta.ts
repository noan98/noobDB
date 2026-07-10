/**
 * カラム型 (CellKind) → ヘッダーアイコン / NULL・空値の分類 を司る純ロジック。
 *
 * **表示専用**であり、ここで決まるのはヘッダーのアイコンやセルの空値バッジといった
 * 「見た目」だけ。コピー・編集・エクスポートの実値 (`cellEdit.ts`) には一切影響を
 * 与えない。副作用のない純関数として切り出し、`cellTypeMeta.test.ts` で単体テスト
 * する (CLAUDE.md の「安全性に直結する純ロジックをテストする」方針)。
 */

import type { IconName } from "./Icon";
import type { I18nKey } from "../i18n";

/** 結果グリッドの列を分類する型タグ。`ResultGrid` の `classifyColumn` が割り当てる。 */
export type CellKind =
  | "number"
  | "decimal"
  | "bool"
  | "date"
  | "time"
  | "json"
  | "enum"
  | "binary"
  | "string";

export interface CellKindMeta {
  /** ヘッダーに表示する型アイコン (Icon.tsx のセマンティック名)。 */
  icon: IconName;
  /** スクリーンリーダー向けの i18n ラベルキー。 */
  labelKey: I18nKey;
}

/** 型 → アイコン + ラベルキー の対応表 (1 型 1 アイコン)。 */
export const CELL_KIND_META: Record<CellKind, CellKindMeta> = {
  number: { icon: "hash", labelKey: "colTypeNumber" },
  decimal: { icon: "hash", labelKey: "colTypeDecimal" },
  bool: { icon: "toggle", labelKey: "colTypeBool" },
  date: { icon: "calendar", labelKey: "colTypeDate" },
  time: { icon: "clock", labelKey: "colTypeTime" },
  json: { icon: "braces", labelKey: "colTypeJson" },
  enum: { icon: "list", labelKey: "colTypeEnum" },
  binary: { icon: "binary", labelKey: "colTypeBinary" },
  string: { icon: "text", labelKey: "colTypeString" },
};

/** 型タグからヘッダーアイコン名を引く。 */
export function cellKindIcon(kind: CellKind): IconName {
  return CELL_KIND_META[kind].icon;
}

/**
 * セルの「空」を細分類する。NULL・空文字・空配列・空オブジェクトを描き分ける
 * ためのもので、非空・非対象の値では `null` を返し呼び出し側が通常描画へフォール
 * バックできるようにする。判定は表示専用で実値は変更しない。
 *
 * - `null` (DB の NULL)            → "null"
 * - 空文字列 ""                    → "empty"
 * - 空配列 "[]" (空白許容)         → "empty-array"
 * - 空オブジェクト "{}" (空白許容) → "empty-object"
 */
export type EmptyKind = "null" | "empty" | "empty-array" | "empty-object";

export function classifyEmptyValue(raw: unknown): EmptyKind | null {
  if (raw === null || raw === undefined) return "null";
  if (typeof raw !== "string") return null;
  if (raw.length === 0) return "empty";
  const trimmed = raw.trim();
  if (trimmed === "[]") return "empty-array";
  if (trimmed === "{}") return "empty-object";
  return null;
}

/** 空値バッジに表示するプレースホルダ記号と i18n ラベルキー。 */
export const EMPTY_BADGE: Record<EmptyKind, { glyph: string; labelKey: I18nKey }> = {
  null: { glyph: "∅", labelKey: "resultNull" },
  empty: { glyph: "''", labelKey: "resultEmptyString" },
  "empty-array": { glyph: "[ ]", labelKey: "resultEmptyArray" },
  "empty-object": { glyph: "{ }", labelKey: "resultEmptyObject" },
};

/**
 * 真偽値セルの "truthy" 判定 (表示専用)。ドライバによって `true`/`1`/`"1"`/`"true"`
 * など表現がまちまちなため、代表的な表現をここで一箇所に集約する。ソート
 * (`ResultGrid.ts` の `sortBool`) は NULL を明示的に区別する別実装で、こちらは
 * kind が既に "bool" と判定済みの値を色/バッジに振り分けるためだけの単純化した
 * 判定 (マッチしなければ false 扱い)。#647 で `ResultGrid` のセル描画から抽出し、
 * 単体テスト可能にした。
 */
export function resolveBoolTruthy(v: unknown): boolean {
  return v === true || v === 1 || v === "1" || String(v).toLowerCase() === "true";
}

/** {@link truncateHexPreview} の戻り値。 */
export interface HexPreview {
  /** グリッド内に表示する 16 進文字列 (切り詰め時は末尾に "…" を含む)。 */
  preview: string;
  /** 切り詰めが発生したかどうか。 */
  truncated: boolean;
}

/**
 * BLOB セルの 16 進文字列をグリッド内プレビュー用に切り詰める (表示専用)。
 * コピー/編集/エクスポートは常に元の hex 文字列を使うため、ここでの切り詰めは
 * 見た目にのみ影響する。#647 で `ResultGrid` のセル描画から抽出し、単体テスト
 * 可能にした。
 */
export function truncateHexPreview(hex: string, maxChars = 64): HexPreview {
  if (hex.length <= maxChars) return { preview: hex, truncated: false };
  return { preview: `${hex.slice(0, maxChars)}…`, truncated: true };
}
