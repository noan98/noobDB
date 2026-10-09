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

/**
 * 生の型名 (DB カタログ由来。`Column.type_name` / `TableColumnInfo.data_type` の
 * どちらも同じ文字列語彙) を {@link CellKind} へ分類する。`ResultGrid` のセル
 * 描画 (`classifyColumn`) と、DB 全体検索 (`dataSearch.ts` の走査対象絞り込み) が
 * 同じ分類基準を共有するための単一ソース。大文字化してから比較するので
 * 大小は問わない。
 */
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
]);

const DECIMAL_TYPES = new Set(["DECIMAL", "NEWDECIMAL", "NUMERIC"]);
const DATE_TYPES = new Set(["DATE", "DATETIME", "TIMESTAMP"]);
const TIME_TYPES = new Set(["TIME"]);
const BINARY_TYPES = new Set([
  "BLOB",
  "TINYBLOB",
  "MEDIUMBLOB",
  "LONGBLOB",
  "BINARY",
  "VARBINARY",
]);

export function classifyTypeName(typeName: string): CellKind {
  const t = typeName.toUpperCase();
  if (NUMERIC_TYPES.has(t)) return "number";
  if (DECIMAL_TYPES.has(t)) return "decimal";
  if (t === "BOOLEAN" || t === "BOOL") return "bool";
  if (DATE_TYPES.has(t)) return "date";
  if (TIME_TYPES.has(t)) return "time";
  if (t === "JSON" || t === "JSONB") return "json";
  if (t === "ENUM" || t === "SET") return "enum";
  if (BINARY_TYPES.has(t)) return "binary";
  return "string";
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

/** 括弧の引数 (`varchar(255)` の `(255)`) を除いた型名。`classifyTypeName` に渡す前処理。 */
export function baseTypeName(dataType: string): string {
  return dataType.replace(/\s*\(.*?\)/g, "").trim();
}

/**
 * DB カタログの型名を {@link classifyTypeName} の語彙 (大文字・修飾なし) へ正規化する。
 * PostgreSQL の正式名 (`timestamp with time zone` / `double precision` / `bytea` …) や
 * MySQL の修飾 (`bigint unsigned zerofill`) は完全一致集合に無いので、分類の前に
 * ここで寄せる。`classifyTypeName` 側の集合は dataSearch など他の利用箇所に影響するため
 * 広げず、ER 図など表示側が使う。
 */
export function normalizeTypeForClassify(dataType: string): string {
  const base = baseTypeName(dataType)
    .toLowerCase()
    .replace(/\b(unsigned|signed|zerofill)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const alias: Record<string, string> = {
    "timestamp with time zone": "timestamp",
    "timestamp without time zone": "timestamp",
    timestamptz: "timestamp",
    "time with time zone": "time",
    "time without time zone": "time",
    timetz: "time",
    "double precision": "double",
    bytea: "blob",
    "character varying": "varchar",
    int2: "smallint",
    int4: "int",
    int8: "bigint",
    smallserial: "smallint",
    serial: "int",
    bigserial: "bigint",
    float4: "float",
    float8: "double",
    bool: "boolean",
  };
  return (alias[base] ?? base).toUpperCase();
}

/** 長い型名の短縮表記 (表示専用)。キーは小文字の括弧なし型名。 */
const TYPE_ABBREVIATIONS: Record<string, string> = {
  "character varying": "varchar",
  character: "char",
  integer: "int",
  boolean: "bool",
  "double precision": "double",
  "timestamp without time zone": "timestamp",
  "timestamp with time zone": "timestamptz",
  "time without time zone": "time",
  "time with time zone": "timetz",
};

/**
 * DB カタログの型名を ER 図などの狭い列行向けに短縮する (表示専用)。小文字化し、
 * 括弧の引数 (長さ・精度) は落として、PostgreSQL の冗長な正式名を一般的な別名へ寄せる
 * (`character varying(255)` → `varchar`、`timestamp with time zone` → `timestamptz`)。
 * 空文字は空文字を返す。
 */
export function shortTypeName(dataType: string): string {
  const base = baseTypeName(dataType).toLowerCase();
  return TYPE_ABBREVIATIONS[base] ?? base;
}
