import type { CellValue } from "../api/tauri";
import type { CellKind } from "./cellTypeMeta";

/**
 * 結果グリッドのソート・列フィルタ・全体フィルタの**値レベルの純ロジック** (#1264)。
 *
 * `ResultGrid.tsx` は TanStack Table のコールバックからここを呼ぶだけにし、同じ判定を
 * バックエンドの結果ハンドル経由 (`result_sort_filter`, `db/result_ops.rs`) でも再現する。
 * Rust 側との一致は共有ゴールデン (`fixtures/resultOpsVectors.json`) が固定する。
 *
 * 既知の差: 文字列ソートの照合順序。フロントは `Intl.Collator` (ロケール依存)、
 * バックエンドはその近似 (`db/js_compat.rs::collation_key`)。そのためハンドル経由は
 * 行数しきい値 (`HANDLE_SORT_MIN_ROWS`) 超の結果だけに限る。
 */

export type FilterNullMode = "any" | "only" | "exclude";
export type TextFilterOp = "contains" | "equals" | "notEquals" | "startsWith" | "endsWith";
export type NumberFilterOp = "eq" | "ne" | "gt" | "lt" | "between";
export type FilterOp = TextFilterOp | NumberFilterOp;

export interface ColumnFilter {
  op: FilterOp;
  /** Primary operand (or lower bound for `between`). */
  value: string;
  /** Upper bound for `between`; ignored by every other operator. */
  value2: string;
  nullMode: FilterNullMode;
  /**
   * `equals` / `notEquals` を大小区別で比較する (省略時は従来どおり大小無視)。結果タブの
   * 「この値を除外/一致」が、PostgreSQL・SQLite のテーブルタブ (`=` / `<>` は大小区別)
   * と同じ行集合になるようにするためのもの。
   */
  caseSensitive?: boolean;
}


// Sort: nulls are pushed after non-null values for asc; flipped to top by desc inversion.
function cmpNullable<T>(a: T | null, b: T | null, cmp: (a: T, b: T) => number): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return cmp(a, b);
}


/** 数値列の比較 (`Number()` 化。NaN は NULL の手前、NULL は最後)。 */
export function compareNumericCells(av: CellValue, bv: CellValue): number {
  const an = av === null || av === undefined ? null : Number(av);
  const bn = bv === null || bv === undefined ? null : Number(bv);
  return cmpNullable(an, bn, (x, y) => {
    if (Number.isNaN(x) && Number.isNaN(y)) return 0;
    if (Number.isNaN(x)) return 1;
    if (Number.isNaN(y)) return -1;
    return x === y ? 0 : x < y ? -1 : 1;
  });
}

/** 真偽値列の比較 (false < true、解釈できない値は NULL 扱い)。 */
export function compareBoolCells(av: CellValue, bv: CellValue): number {
  const toBool = (v: CellValue): boolean | null => {
    if (v === null || v === undefined) return null;
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0;
    const s = String(v).toLowerCase();
    if (s === "true" || s === "1") return true;
    if (s === "false" || s === "0") return false;
    return null;
  };
  return cmpNullable(toBool(av), toBool(bv), (x, y) => (x === y ? 0 : x ? 1 : -1));
}

// localeCompare はオプション付き呼び出しのたびに照合設定を再構築するため、
// O(n log n) のソート比較では事前構築した Intl.Collator を使う (順序は同一で
// 10〜100 倍速い)。
const stringCollator = new Intl.Collator(undefined, { numeric: true });

/** 文字列列の比較 (`Intl.Collator` の numeric 照合)。 */
export function compareStringCells(av: CellValue, bv: CellValue): number {
  const as = av === null || av === undefined ? null : String(av);
  const bs = bv === null || bv === undefined ? null : String(bv);
  return cmpNullable(as, bs, (x, y) => stringCollator.compare(x, y));
}

/** A plain (optionally signed) base-10 integer string, safe for BigInt(). */
function isIntegerLiteral(s: string): boolean {
  return /^[+-]?\d+$/.test(s.trim());
}

/** Does the filter carry a value operand (vs. being a NULL-only condition)? */
function filterHasValue(f: ColumnFilter): boolean {
  if (f.op === "between") return f.value.trim() !== "" || f.value2.trim() !== "";
  return f.value.trim() !== "";
}

/**
 * A filter only counts as "active" when it actually narrows the result: it has
 * a value operand or a non-default NULL gate. Inactive filters are stored as
 * `undefined` so the header icon highlight and the filtered-row summary track
 * real conditions only.
 */
export function isColumnFilterActive(f: ColumnFilter | undefined): f is ColumnFilter {
  return !!f && (f.nullMode !== "any" || filterHasValue(f));
}

/**
 * 値条件 1 件を「セル値 → 真偽」の述語に一度だけコンパイルする (#1610)。
 * 小文字化したクエリ・整数判定・BigInt 化した境界値・Number 化した境界値は行をまたいで
 * 変わらないので、行ごとに再計算しない。判定結果は従来の `matchesColumnValue` と同じ。
 */
function compileValuePredicate(f: ColumnFilter): (v: Exclude<CellValue, null | undefined>) => boolean {
  switch (f.op) {
    case "contains":
    case "equals":
    case "notEquals":
    case "startsWith":
    case "endsWith": {
      const exact = f.caseSensitive === true && (f.op === "equals" || f.op === "notEquals");
      const q = exact ? f.value : f.value.toLowerCase();
      const text = (v: Exclude<CellValue, null | undefined>) =>
        exact ? String(v) : String(v).toLowerCase();
      if (f.op === "contains") return (v) => text(v).includes(q);
      if (f.op === "equals") return (v) => text(v) === q;
      if (f.op === "notEquals") return (v) => text(v) !== q;
      if (f.op === "startsWith") return (v) => text(v).startsWith(q);
      return (v) => text(v).endsWith(q);
    }
    case "eq":
    case "ne":
    case "gt":
    case "lt":
    case "between": {
      const a = f.value.trim();
      const b = f.value2.trim();
      // Big integers (e.g. BIGINT ids beyond 2^53) lose precision through
      // Number(), which would break `eq`/range on real-world key columns. When
      // the cell value and every supplied operand are plain integers, compare
      // exactly via BigInt. Fractional decimals (and anything non-integer) fall
      // back to Number — the same precision ceiling the numeric sort comparator
      // already accepts.
      const operands = f.op === "between" ? [a, b] : [a];
      const present = operands.filter((x) => x !== "");
      const allInt = present.length > 0 && present.every(isIntegerLiteral);
      const abig = allInt && a !== "" ? BigInt(a) : null;
      const bbig = allInt && b !== "" ? BigInt(b) : null;
      const an = a === "" ? NaN : Number(a);
      const bn = b === "" ? NaN : Number(b);
      const lo = Number.isNaN(an) ? -Infinity : an;
      const hi = Number.isNaN(bn) ? Infinity : bn;
      const op = f.op;
      return (v) => {
        if (allInt) {
          const raw = String(v).trim();
          if (isIntegerLiteral(raw)) {
            const n = BigInt(raw);
            if (op === "eq") return abig !== null && n === abig;
            if (op === "ne") return abig !== null && n !== abig;
            if (op === "gt") return abig !== null && n > abig;
            if (op === "lt") return abig !== null && n < abig;
            // between: an empty bound is treated as open.
            return (abig === null || n >= abig) && (bbig === null || n <= bbig);
          }
        }
        const n = Number(v);
        if (Number.isNaN(n)) return false;
        if (op === "eq") return !Number.isNaN(an) && n === an;
        if (op === "ne") return !Number.isNaN(an) && n !== an;
        if (op === "gt") return !Number.isNaN(an) && n > an;
        if (op === "lt") return !Number.isNaN(an) && n < an;
        // between: an empty bound is treated as open (-∞ / +∞).
        return n >= lo && n <= hi;
      };
    }
  }
}

/** フィルタ条件オブジェクト単位でコンパイル済み述語を使い回す (状態更新ごとに新オブジェクトになる)。 */
const compiledPredicates = new WeakMap<
  ColumnFilter,
  (v: Exclude<CellValue, null | undefined>) => boolean
>();

function matchesColumnValue(v: Exclude<CellValue, null | undefined>, f: ColumnFilter): boolean {
  let p = compiledPredicates.get(f);
  if (!p) {
    p = compileValuePredicate(f);
    compiledPredicates.set(f, p);
  }
  return p(v);
}

/** 列フィルタ 1 つをセル値 1 つに適用する (`columnFilter` の本体)。非アクティブは常に通す。 */
export function columnFilterPasses(v: CellValue, f: ColumnFilter | undefined): boolean {
  if (!isColumnFilterActive(f)) return true;
  const isNull = v === null || v === undefined;
  if (f.nullMode === "only") return isNull;
  if (f.nullMode === "exclude" && isNull) return false;
  // The NULL gate is satisfied; a bare NULL gate (no value operand) passes here.
  if (!filterHasValue(f)) return true;
  // A value condition can't be met by NULL (the "only" case already returned).
  if (isNull) return false;
  return matchesColumnValue(v, f);
}

/** 全体フィルタ 1 セルぶん (`globalIncludesFilter` の本体)。NULL は文字列 "null" として扱う。 */
export function globalCellIncludes(v: CellValue, needleLower: string): boolean {
  const s = v === null || v === undefined ? "null" : String(v);
  return s.toLowerCase().includes(needleLower);
}

// ─────────────────────────────────────────────────────────────────────────────
// 結果ハンドル経由のソート・フィルタ (#1264)
// ─────────────────────────────────────────────────────────────────────────────

/** バックエンドの比較方式 (`SortKind`)。 */
export type HandleSortKind = "numeric" | "bool" | "string";

export interface HandleSortSpec {
  col: number;
  kind: HandleSortKind;
  desc: boolean;
}

export interface HandleFilterSpec {
  col: number;
  op: FilterOp;
  value: string;
  value2: string;
  nullMode: FilterNullMode;
  /** `equals` / `notEquals` を大小区別で比較する (`ColumnFilter.caseSensitive` と同じ)。 */
  caseSensitive?: boolean;
}

/** `result_sort_filter` の条件。 */
export interface HandleSortFilterRequest {
  sort: HandleSortSpec[];
  filters: HandleFilterSpec[];
  global: string;
}

/** `sortingFnForKind` と同じ分類 (数値系 / 真偽値 / それ以外)。 */
export function handleSortKind(kind: CellKind): HandleSortKind {
  switch (kind) {
    case "number":
    case "decimal":
      return "numeric";
    case "bool":
      return "bool";
    default:
      return "string";
  }
}

/**
 * グリッドの状態 (TanStack の sorting / columnFilters / globalFilter) をバックエンドへ送る
 * 条件に変換する。非アクティブなフィルタは落とす。
 */
export function buildHandleRequest(
  sorting: ReadonlyArray<{ id: string; desc: boolean }>,
  columnFilters: ReadonlyArray<{ id: string; value: unknown }>,
  globalFilter: string | undefined,
  kinds: ReadonlyArray<CellKind>,
): HandleSortFilterRequest {
  const sort: HandleSortSpec[] = [];
  for (const s of sorting) {
    const col = Number(s.id);
    if (!Number.isInteger(col) || col < 0 || col >= kinds.length) continue;
    sort.push({ col, kind: handleSortKind(kinds[col]), desc: s.desc });
  }
  const filters: HandleFilterSpec[] = [];
  for (const f of columnFilters) {
    const col = Number(f.id);
    if (!Number.isInteger(col) || col < 0 || col >= kinds.length) continue;
    const v = f.value as ColumnFilter | undefined;
    if (!isColumnFilterActive(v)) continue;
    filters.push({
      col,
      op: v.op,
      value: v.value,
      value2: v.value2,
      nullMode: v.nullMode,
      ...(v.caseSensitive ? { caseSensitive: true } : {}),
    });
  }
  return { sort, filters, global: globalFilter ?? "" };
}

/** 条件が空 (並びも絞り込みも無い) か。空なら元の行順そのままなので IPC は不要。 */
export function isIdentityRequest(req: HandleSortFilterRequest): boolean {
  return req.sort.length === 0 && req.filters.length === 0 && req.global === "";
}

/** 条件の同一性キー (古い応答の破棄・再取得の抑止に使う)。 */
export function handleRequestKey(req: HandleSortFilterRequest): string {
  return JSON.stringify(req);
}
