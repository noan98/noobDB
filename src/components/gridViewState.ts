import type { ColumnFiltersState, SortingState } from "@tanstack/react-table";
import type { ColumnFilter, FilterNullMode, FilterOp } from "./ResultGrid";

/**
 * 結果グリッドのソート状態・列フィルタのテーブル単位永続化 (#677) の純ロジック。
 *
 * #616 で列幅・列順・表示/非表示・ピン留めは結果シェイプ単位で永続化されたが、
 * 同じグリッドのソート状態と列フィルタは素の `useState` のままで、タブを開き直す/
 * 再起動するたびにリセットされていた。「列幅は覚えているのにソートは忘れる」という
 * 非対称を解消するため、列レイアウト (`colStateKeyFrom`) / フッター (`footerStateKeyFrom`)
 * と同じ結果シェイプキー体系へ相乗りさせて保存/復元する。
 *
 * 破損耐性 (#566) の作法に従い、壊れた JSON・型不一致・未知の演算子は破棄して既定
 * (空) へフォールバックする。すべて副作用なし (localStorage 補助を除く) で、
 * `ResultGrid` が消費する。
 */

/** 永続化するソート 1 列分。TanStack の `SortingState` 要素と同型。 */
interface PersistedSort {
  id: string;
  desc: boolean;
}

/** 永続化する列フィルタ 1 件。`id` は列 ID、`value` は構造化フィルタ。 */
interface PersistedFilter {
  id: string;
  value: ColumnFilter;
}

/** テーブル単位で保存するグリッドのビュー状態。全フィールド任意 (無ければ既定)。 */
export interface PersistedGridView {
  /** 複数列ソート (優先順)。 */
  sorting?: PersistedSort[];
  /** 列フィルタ (列 ID → 構造化条件)。 */
  filters?: PersistedFilter[];
}

/**
 * 列サイジングキー (`noobdb.colsizing.v1::…`) からビュー状態キーを導出する。
 * `colStateKeyFrom` / `footerStateKeyFrom` と同じ発想で、同一のテーブル署名
 * (database+table+列構成) を引き継ぐ。プレビューペイン (キー無し) では undefined に
 * なり永続化しない。
 */
export function gridViewStateKeyFrom(sizingKey: string | undefined): string | undefined {
  return sizingKey ? sizingKey.replace("noobdb.colsizing.v1", "noobdb.gridview.v1") : undefined;
}

const FILTER_OPS: FilterOp[] = [
  "contains",
  "equals",
  "startsWith",
  "endsWith",
  "eq",
  "gt",
  "lt",
  "between",
];
const NULL_MODES: FilterNullMode[] = ["any", "only", "exclude"];

function isFilterOp(v: unknown): v is FilterOp {
  return typeof v === "string" && (FILTER_OPS as string[]).includes(v);
}

function isNullMode(v: unknown): v is FilterNullMode {
  return typeof v === "string" && (NULL_MODES as string[]).includes(v);
}

/** 構造化フィルタ値の妥当性検証。未知の演算子・型不一致は捨てる。 */
function isColumnFilter(v: unknown): v is ColumnFilter {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    isFilterOp(o.op) &&
    typeof o.value === "string" &&
    typeof o.value2 === "string" &&
    isNullMode(o.nullMode)
  );
}

function sanitizeSorting(raw: unknown): PersistedSort[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: PersistedSort[] = [];
  for (const s of raw) {
    if (s && typeof s === "object") {
      const o = s as Record<string, unknown>;
      if (typeof o.id === "string" && typeof o.desc === "boolean") {
        out.push({ id: o.id, desc: o.desc });
      }
    }
  }
  return out.length > 0 ? out : undefined;
}

function sanitizeFilters(raw: unknown): PersistedFilter[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: PersistedFilter[] = [];
  for (const f of raw) {
    if (f && typeof f === "object") {
      const o = f as Record<string, unknown>;
      if (typeof o.id === "string" && isColumnFilter(o.value)) {
        out.push({ id: o.id, value: o.value });
      }
    }
  }
  return out.length > 0 ? out : undefined;
}

/**
 * パース済み JSON を妥当なビュー状態に整える。純粋 (ストレージ非依存) なので
 * ユニットテストできる。未知の形・不正なエントリは捨てる。
 */
export function normalizeGridView(parsed: unknown): PersistedGridView {
  if (!parsed || typeof parsed !== "object") return {};
  const o = parsed as Record<string, unknown>;
  const out: PersistedGridView = {};
  const sorting = sanitizeSorting(o.sorting);
  if (sorting) out.sorting = sorting;
  const filters = sanitizeFilters(o.filters);
  if (filters) out.filters = filters;
  return out;
}

/**
 * 保存済みビュー状態を読む。壊れた JSON・型不一致・未知の演算子は破棄して既定へ
 * フォールバックする (private mode / quota / 破損に耐える。#566)。
 */
export function readStoredGridView(key: string | undefined): PersistedGridView {
  if (!key) return {};
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return {};
    return normalizeGridView(JSON.parse(raw));
  } catch {
    // ignore (corrupt entry, private mode, quota)
    return {};
  }
}

/**
 * ビュー状態を保存する。実質デフォルト (ソートも列フィルタも無し) のときはエントリを
 * 削除して、クリアが確実に既定へ戻るようにする (`writeStoredColumnState` と同じ発想)。
 */
export function writeStoredGridView(key: string | undefined, state: PersistedGridView): void {
  if (!key) return;
  try {
    const hasSorting = !!state.sorting && state.sorting.length > 0;
    const hasFilters = !!state.filters && state.filters.length > 0;
    if (!hasSorting && !hasFilters) {
      localStorage.removeItem(key);
    } else {
      const out: PersistedGridView = {};
      if (hasSorting) out.sorting = state.sorting;
      if (hasFilters) out.filters = state.filters;
      localStorage.setItem(key, JSON.stringify(out));
    }
  } catch {
    // ignore (private mode, quota)
  }
}

/**
 * TanStack の型からストア形へ落とす小さなアダプタ。`SortingState` は同型なので
 * そのまま、`ColumnFiltersState` は不正な値を捨てて `PersistedFilter[]` にする。
 */
export function toPersistedGridView(
  sorting: SortingState,
  columnFilters: ColumnFiltersState,
): PersistedGridView {
  const state: PersistedGridView = {};
  if (sorting.length > 0) {
    state.sorting = sorting.map((s) => ({ id: s.id, desc: s.desc }));
  }
  const filters: PersistedFilter[] = [];
  for (const f of columnFilters) {
    if (isColumnFilter(f.value)) filters.push({ id: f.id, value: f.value });
  }
  if (filters.length > 0) state.filters = filters;
  return state;
}
