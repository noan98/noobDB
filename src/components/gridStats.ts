/**
 * 結果グリッドの「分析サマリ」純ロジック (#523 / #524)。
 *
 * - #523 範囲選択サマリ … `selectionSummary(cells)` が矩形選択されたセル群を
 *   集計し、件数・非NULL数・数値数・合計・平均・最小・最大を返す。
 * - #524 列クイック統計 … `columnStats(values, kind)` が在メモリ (取得済み行) の
 *   列値を集計し、件数・NULL率・DISTINCT 数・数値レンジ / 文字列長などを返す。
 *   さらに `buildColumnStatsSql` がドライバ方言に沿った全件集計 SQL を生成し、
 *   `parseFullColumnStats` がその単一行結果を構造化する。
 *
 * いずれも **表示専用 / 副作用なしの純関数**で、コピー・編集・エクスポートの実値には
 * 一切影響しない。数値化は条件付き書式 (`cellConditionalFormat.toNumber`) と同じ寄せ方を
 * 共有し、判定がズレないようにする。`gridStats.test.ts` で単体テストする。
 */

import type { CellValue } from "../api/tauri";
import type { CellKind } from "./cellTypeMeta";
import { toNumber } from "./cellConditionalFormat";
import { quoteIdentFor } from "./sqlDialect";

const isNullish = (v: CellValue): boolean => v === null || v === undefined;

/** 数値列か (数値統計を出す対象か)。 */
export function isNumericStatsKind(kind: CellKind): boolean {
  return kind === "number" || kind === "decimal";
}

// ─────────────────────────────────────────────────────────────────────────────
// #523 範囲選択サマリ
// ─────────────────────────────────────────────────────────────────────────────

export interface SelectionSummary {
  /** 選択セルの総数。 */
  count: number;
  /** NULL / undefined を除いたセル数。 */
  nonNullCount: number;
  /** 数値として解釈できたセル数。 */
  numericCount: number;
  /** 数値セルの合計 (数値が 0 件なら null)。 */
  sum: number | null;
  /** 数値セルの平均 (数値が 0 件なら null)。 */
  avg: number | null;
  /** 数値セルの最小 (数値が 0 件なら null)。 */
  min: number | null;
  /** 数値セルの最大 (数値が 0 件なら null)。 */
  max: number | null;
}

/**
 * 選択セル群を集計する。NULL は件数に別掲し集計対象外、文字列だが数値リテラルの
 * ものは数値として拾う (`toNumber` と同じ基準)。数値が 1 つも無ければ
 * sum/avg/min/max は null。
 */
export function selectionSummary(cells: Iterable<CellValue>): SelectionSummary {
  let count = 0;
  let nonNullCount = 0;
  let numericCount = 0;
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const v of cells) {
    count++;
    if (isNullish(v)) continue;
    nonNullCount++;
    const n = toNumber(v);
    if (n === null) continue;
    numericCount++;
    sum += n;
    if (n < min) min = n;
    if (n > max) max = n;
  }
  const hasNumeric = numericCount > 0;
  return {
    count,
    nonNullCount,
    numericCount,
    sum: hasNumeric ? sum : null,
    avg: hasNumeric ? sum / numericCount : null,
    min: hasNumeric ? min : null,
    max: hasNumeric ? max : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// #524 列クイック統計 (在メモリ)
// ─────────────────────────────────────────────────────────────────────────────

export interface ColumnStats {
  /** 取得済み行数 (= values.length)。 */
  count: number;
  /** NULL / undefined の数。 */
  nullCount: number;
  /** 非 NULL の数。 */
  nonNullCount: number;
  /** 非 NULL 値の一意件数 (文字列化して比較)。 */
  distinctCount: number;
  /** 数値として解釈できた数。 */
  numericCount: number;
  sum: number | null;
  avg: number | null;
  min: number | null;
  max: number | null;
  /** 非 NULL 値を文字列化したときの最短文字数。 */
  minLen: number | null;
  /** 同・最長文字数。 */
  maxLen: number | null;
  /** 代表値 (最頻値) とその出現数。非 NULL が無ければ null。 */
  mode: { value: string; count: number } | null;
}

/**
 * 在メモリの列値を集計する。`kind` は数値系かどうかの判定に使うが、件数 / NULL /
 * DISTINCT / 文字列長 / 代表値はすべての型で計算する (UI 側が型に応じて取捨する)。
 * DISTINCT と代表値は値の文字列表現で同一性を見る (数値 1 と "1" は同一視)。
 */
export function columnStats(values: CellValue[], _kind: CellKind): ColumnStats {
  let nullCount = 0;
  let numericCount = 0;
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  let minLen = Infinity;
  let maxLen = -Infinity;
  const freq = new Map<string, number>();
  for (const v of values) {
    if (isNullish(v)) {
      nullCount++;
      continue;
    }
    const s = String(v);
    freq.set(s, (freq.get(s) ?? 0) + 1);
    if (s.length < minLen) minLen = s.length;
    if (s.length > maxLen) maxLen = s.length;
    const n = toNumber(v);
    if (n !== null) {
      numericCount++;
      sum += n;
      if (n < min) min = n;
      if (n > max) max = n;
    }
  }
  const count = values.length;
  const nonNullCount = count - nullCount;
  const hasNumeric = numericCount > 0;
  let mode: { value: string; count: number } | null = null;
  for (const [value, c] of freq) {
    if (!mode || c > mode.count) mode = { value, count: c };
  }
  return {
    count,
    nullCount,
    nonNullCount,
    distinctCount: freq.size,
    numericCount,
    sum: hasNumeric ? sum : null,
    avg: hasNumeric ? sum / numericCount : null,
    min: hasNumeric ? min : null,
    max: hasNumeric ? max : null,
    minLen: nonNullCount > 0 ? minLen : null,
    maxLen: nonNullCount > 0 ? maxLen : null,
    mode,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// #524 全件集計 SQL
// ─────────────────────────────────────────────────────────────────────────────

export interface FullStatsRequest {
  /** "mysql" | "postgres" | "sqlite" (未知は MySQL 扱い)。 */
  driver: string;
  /** データベース/スキーマ名。SQLite では無視され空でも可。 */
  database?: string | null;
  table: string;
  column: string;
  kind: CellKind;
}

/**
 * テーブル参照をドライバ方言でクオート・修飾する。SQLite はファイル単位なので
 * データベース名を付けない (`cellEdit.ts` の `qualifiedTableRef` と同じ規約)。
 */
function qualifiedTableRef(driver: string, database: string | null | undefined, table: string): string {
  if (driver === "sqlite" || !database) return quoteIdentFor(driver, table);
  return `${quoteIdentFor(driver, database)}.${quoteIdentFor(driver, table)}`;
}

/**
 * 列の全件集計 SQL を生成する。識別子はドライバ方言でクオートする。常に
 * COUNT(*) / COUNT(col) / COUNT(DISTINCT col) / MIN / MAX を出し、数値列のときだけ
 * AVG / SUM を追加する。列の並びは `parseFullColumnStats` が位置で読むため固定。
 */
export function buildColumnStatsSql(req: FullStatsRequest): string {
  const col = quoteIdentFor(req.driver, req.column);
  const ref = qualifiedTableRef(req.driver, req.database, req.table);
  const numeric = isNumericStatsKind(req.kind);
  const parts = [
    `COUNT(*) AS total_count`,
    `COUNT(${col}) AS non_null_count`,
    `COUNT(DISTINCT ${col}) AS distinct_count`,
    `MIN(${col}) AS min_value`,
    `MAX(${col}) AS max_value`,
  ];
  if (numeric) {
    parts.push(`AVG(${col}) AS avg_value`);
    parts.push(`SUM(${col}) AS sum_value`);
  }
  return `SELECT ${parts.join(", ")} FROM ${ref}`;
}

export interface FullColumnStats {
  total: number;
  nonNull: number;
  nullCount: number;
  distinct: number;
  /** MIN/MAX は型に応じた生値 (数値列は数値、それ以外は文字列など)。 */
  min: CellValue;
  max: CellValue;
  avg: number | null;
  sum: number | null;
}

/**
 * `buildColumnStatsSql` が返した SQL の単一行結果を構造化する。列名のドライバ差
 * (大小やエイリアス展開) に依存しないよう **位置** で読む。`numeric` は SQL を
 * 生成したときと同じ値 (数値列なら true) を渡す。
 */
export function parseFullColumnStats(row: CellValue[], numeric: boolean): FullColumnStats {
  const total = Number(row[0] ?? 0);
  const nonNull = Number(row[1] ?? 0);
  const distinct = Number(row[2] ?? 0);
  const min = row[3] ?? null;
  const max = row[4] ?? null;
  return {
    total,
    nonNull,
    nullCount: total - nonNull,
    distinct,
    min,
    max,
    avg: numeric ? toNumber(row[5] ?? null) : null,
    sum: numeric ? toNumber(row[6] ?? null) : null,
  };
}
