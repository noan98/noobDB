/**
 * エクスポート時のデータマスキング (#733) のフロント側純ロジック。
 *
 * 表示用の機微カラムマスク (#1069, `columnMask.ts`) とは目的が違う:
 *   - #1069 は**画面上の伏せ字**で、実値・エクスポート内容は変えない。
 *   - 本モジュールは**書き出すファイルの中身**を変換する (DB には一切書き込まない)。
 * ただし「どの列が PII か」の判定 (列名パターンの部分一致 / グロブ) は同じ規則で
 * あるべきなので、`columnMask.ts::matchesMaskPattern` をそのまま共有する。
 *
 * 値の変換そのもの (伏せ字 / 部分マスク / 仮名化 / NULL 化) は**バックエンドの
 * `db/masking.rs` だけ**が行う。仮名化は keyring に置いた秘密ソルトを鍵にした
 * HMAC-SHA256 で、ソルトをフロントへ出さないためにプレビューも `mask_export_rows`
 * IPC を通す (= 変換の二重実装を持たない)。フロントが持つのは:
 *   - ルールの正規化 (`sanitizeMaskRule`) — 設定 (localStorage) から読み戻した値や
 *     入力欄の値を、バックエンドと同じ上限・既定値に揃える。共有ゴールデン
 *     `fixtures/exportMaskingVectors.json` の `normalize` でバックと一致を固定。
 *   - 列名パターンのプリセット (`ExportMaskPreset`) と列単位の上書きから、列ごとの
 *     ルールを解決する (`resolveExportMasks`)。
 */
import { matchesMaskPattern } from "./columnMask";

/** 列 1 つに掛けるルール。バックエンドの `db::masking::MaskRule` と同形。 */
export type ExportMaskRule =
  | { kind: "fixed"; value: string }
  | { kind: "partial"; keepStart: number; keepEnd: number }
  | { kind: "hash"; length: number }
  | { kind: "null" };

export type ExportMaskRuleKind = ExportMaskRule["kind"];

/** UI の選択肢の並び順。 */
export const EXPORT_MASK_RULE_KINDS: readonly ExportMaskRuleKind[] = ["fixed", "partial", "hash", "null"];

/** IPC に渡す列単位の指定。バックエンドの `db::masking::ColumnMask` と同形。 */
export interface ExportColumnMask {
  column: string;
  rule: ExportMaskRule;
}

/** 列名パターン → 既定ルールのプリセット (プロファイル非依存の設定として保存)。 */
export interface ExportMaskPreset {
  /** `columnMask.ts` と同じ書式 (部分一致・大文字小文字無視。`*` / `?` でグロブ)。 */
  pattern: string;
  rule: ExportMaskRule;
}

/** 列単位の上書き (列名 → ルール、`null` は「この列はマスクしない」)。 */
export type ExportMaskOverrides = Record<string, ExportMaskRule | null>;

// ── バックエンド (`db/masking.rs`) と揃える定数。共有ゴールデンで固定 ──
export const DEFAULT_FIXED_VALUE = "***";
export const MAX_FIXED_VALUE_CHARS = 200;
export const MAX_KEEP_CHARS = 64;
export const DEFAULT_HASH_LENGTH = 16;
export const MIN_HASH_LENGTH = 4;
export const MAX_HASH_LENGTH = 64;

/** プリセットの最大件数・パターンの最大長 (設定ファイル破損への耐性)。 */
const MAX_PRESETS = 100;
const MAX_PATTERN_LENGTH = 100;

/**
 * 同梱のプリセット (よくある PII 列名)。部分一致なので `user_email` /
 * `EmailAddress` / `phone_number` / `last_name` などにも効く。
 */
export const BUILTIN_EXPORT_MASK_PRESETS: readonly ExportMaskPreset[] = [
  { pattern: "email", rule: { kind: "partial", keepStart: 2, keepEnd: 4 } },
  { pattern: "phone", rule: { kind: "partial", keepStart: 0, keepEnd: 4 } },
  { pattern: "mobile", rule: { kind: "partial", keepStart: 0, keepEnd: 4 } },
  { pattern: "first_name", rule: { kind: "hash", length: DEFAULT_HASH_LENGTH } },
  { pattern: "last_name", rule: { kind: "hash", length: DEFAULT_HASH_LENGTH } },
  { pattern: "full_name", rule: { kind: "hash", length: DEFAULT_HASH_LENGTH } },
];

/** 非負整数への丸め。数値でないもの (文字列・NaN など) は `fallback`。 */
function toCount(raw: unknown, fallback: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
  return Math.max(0, Math.floor(raw));
}

/**
 * ルールを正規形にする。形が壊れていれば `null`。上限・既定値はバックエンドの
 * `MaskRule::normalized` と同じ (共有ゴールデンの `normalize` で固定):
 *   - fixed: 値は文字列でなければ既定 `***`、`MAX_FIXED_VALUE_CHARS` コードポイントで切る
 *   - partial: keepStart / keepEnd は非負整数 (既定 0)、各 `MAX_KEEP_CHARS` で頭打ち
 *   - hash: length は整数 (既定 16)、`[MIN_HASH_LENGTH, MAX_HASH_LENGTH]` に収める
 */
export function sanitizeMaskRule(raw: unknown): ExportMaskRule | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  switch (r.kind) {
    case "fixed": {
      const value = typeof r.value === "string" ? r.value : DEFAULT_FIXED_VALUE;
      return { kind: "fixed", value: Array.from(value).slice(0, MAX_FIXED_VALUE_CHARS).join("") };
    }
    case "partial":
      return {
        kind: "partial",
        keepStart: Math.min(toCount(r.keepStart, 0), MAX_KEEP_CHARS),
        keepEnd: Math.min(toCount(r.keepEnd, 0), MAX_KEEP_CHARS),
      };
    case "hash":
      return {
        kind: "hash",
        length: Math.min(Math.max(toCount(r.length, DEFAULT_HASH_LENGTH), MIN_HASH_LENGTH), MAX_HASH_LENGTH),
      };
    case "null":
      return { kind: "null" };
    default:
      return null;
  }
}

/** ルール種別を切り替えたときの既定ルール。 */
export function defaultMaskRule(kind: ExportMaskRuleKind): ExportMaskRule {
  switch (kind) {
    case "fixed":
      return { kind: "fixed", value: DEFAULT_FIXED_VALUE };
    case "partial":
      return { kind: "partial", keepStart: 1, keepEnd: 1 };
    case "hash":
      return { kind: "hash", length: DEFAULT_HASH_LENGTH };
    case "null":
      return { kind: "null" };
  }
}

/**
 * プリセット配列を正規化する: パターンは前後空白除去 + 小文字化 (`columnMask.ts` と
 * 同じ)、空・長すぎ・ルール不正は捨て、同じパターンは先勝ちで重複除去。`raw` が
 * 配列でなければ `fallback`。
 */
export function sanitizeMaskPresets(
  raw: unknown,
  fallback: readonly ExportMaskPreset[],
): ExportMaskPreset[] {
  if (!Array.isArray(raw)) return fallback.map((p) => ({ ...p }));
  const out: ExportMaskPreset[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const { pattern, rule } = item as { pattern?: unknown; rule?: unknown };
    if (typeof pattern !== "string") continue;
    const p = pattern.trim().toLowerCase();
    if (p.length === 0 || p.length > MAX_PATTERN_LENGTH || seen.has(p)) continue;
    const r = sanitizeMaskRule(rule);
    if (!r) continue;
    seen.add(p);
    out.push({ pattern: p, rule: r });
    if (out.length >= MAX_PRESETS) break;
  }
  return out;
}

/** 列名に最初に一致したプリセットのルール (無ければ `null`)。 */
export function presetRuleFor(
  columnName: string,
  presets: readonly ExportMaskPreset[],
): ExportMaskRule | null {
  for (const p of presets) {
    if (matchesMaskPattern(columnName, [p.pattern])) return p.rule;
  }
  return null;
}

/** 列ごとの実効ルール (上書き優先、無ければプリセット)。 */
export function effectiveMaskRule(
  columnName: string,
  presets: readonly ExportMaskPreset[],
  overrides: ExportMaskOverrides,
): ExportMaskRule | null {
  if (Object.prototype.hasOwnProperty.call(overrides, columnName)) {
    return overrides[columnName] ?? null;
  }
  return presetRuleFor(columnName, presets);
}

/** 重複を除いた列名 (初出順)。IPC は列名で対応付けるので同名列は 1 件にまとめる。 */
export function uniqueColumnNames(columnNames: readonly string[]): string[] {
  return Array.from(new Set(columnNames));
}

/** IPC へ渡す列単位の指定を解決する。マスクしない列は含めない。 */
export function resolveExportMasks(
  columnNames: readonly string[],
  presets: readonly ExportMaskPreset[],
  overrides: ExportMaskOverrides,
): ExportColumnMask[] {
  const out: ExportColumnMask[] = [];
  for (const column of uniqueColumnNames(columnNames)) {
    const rule = effectiveMaskRule(column, presets, overrides);
    if (rule) out.push({ column, rule });
  }
  return out;
}

/**
 * マスクされる列の数 (位置単位。同名列が 2 つあれば 2 と数える — バックエンドは
 * 同名列すべてに同じルールを掛けるので、出力に効く列数と一致させる)。
 */
export function countMaskedColumns(
  columnNames: readonly string[],
  masks: readonly ExportColumnMask[],
): number {
  const names = new Set(masks.map((m) => m.column));
  return columnNames.filter((n) => names.has(n)).length;
}

/**
 * 列のルールをプリセットとして保存する。パターンは列名 (小文字化。部分一致なので
 * その列名を含む列にも効く)。同じパターンの既存プリセットは置き換え、
 * `rule === null` なら削除する。
 */
export function upsertMaskPreset(
  presets: readonly ExportMaskPreset[],
  columnName: string,
  rule: ExportMaskRule | null,
): ExportMaskPreset[] {
  const pattern = columnName.trim().toLowerCase();
  if (pattern.length === 0) return [...presets];
  const rest = presets.filter((p) => p.pattern !== pattern);
  // 先頭に置く: プリセットは先勝ちなので、列名そのものの指定が `email` のような
  // 広いパターンより優先されるようにする。
  return rule ? [{ pattern, rule }, ...rest] : rest;
}

/** 2 つのルールが同じか (UI の「プリセットと同じ」判定)。 */
export function sameMaskRule(a: ExportMaskRule | null, b: ExportMaskRule | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
