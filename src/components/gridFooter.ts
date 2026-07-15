import type { CellValue } from "../api/tauri";
import type { CellKind } from "./cellTypeMeta";
import { columnStats, isNumericStatsKind, type ColumnStats } from "./gridStats";

/**
 * 結果グリッドの集計フッター行 (#645) の純ロジック。
 *
 * 表計算ソフトのフッターに相当する、列ごとの要約値を「選択や操作なしに常に
 * 一覧で把握する」ための集計を担う。値算出は `gridStats.columnStats` を**再利用**し
 * (二重定義しない)、ここでは列ごとに 1 つ選ばれた集計関数 (`FooterAggFn`) から
 * 表示用の値を取り出すだけの純関数群と、フッター表示状態のテーブル単位永続化
 * (破損耐性つき。#566) を提供する。
 *
 * すべて副作用なし (localStorage 補助を除く) で、`ResultGrid` の `<tfoot>` 描画と
 * ヘッダーメニューの集計関数セレクタが消費する。選択サマリ (#523) / 列統計 (#524) と
 * 同じ分離方針。
 */

/**
 * フッターの列ごとに選べる集計関数。`none` は「この列は空表示」。数値系の
 * `sum/avg/min/max` は非数値列では意味を持たないため `availableFooterFns` で
 * 出し分ける。`count` は非 NULL 件数、`distinct` は一意数、`nullRate` は NULL 率。
 */
export type FooterAggFn = "none" | "count" | "distinct" | "nullRate" | "sum" | "avg" | "min" | "max";

/** 永続化バリデーション用の全関数リスト (順序は表示に使わない)。 */
const ALL_FOOTER_FNS: FooterAggFn[] = ["none", "count", "distinct", "nullRate", "sum", "avg", "min", "max"];

/** 数値列で選べる関数 (既定は先頭寄りが優先度高、UI のセレクタ順にもなる)。 */
const NUMERIC_FOOTER_FNS: FooterAggFn[] = ["sum", "avg", "min", "max", "count", "distinct", "nullRate", "none"];

/** 非数値列で選べる関数 (sum/avg/min/max は無意味なので除外)。 */
const NON_NUMERIC_FOOTER_FNS: FooterAggFn[] = ["count", "distinct", "nullRate", "none"];

/** その列の種別 (`kind`) で選べる集計関数の一覧。UI のセレクタ順にも使う。 */
export function availableFooterFns(kind: CellKind): FooterAggFn[] {
  return isNumericStatsKind(kind) ? NUMERIC_FOOTER_FNS : NON_NUMERIC_FOOTER_FNS;
}

/** 種別ごとの既定集計関数。数値列は合計、それ以外は件数。 */
export function defaultFooterFn(kind: CellKind): FooterAggFn {
  return isNumericStatsKind(kind) ? "sum" : "count";
}

/**
 * 保存済み関数をその列の種別に照らして正規化する。未知・不適用 (例: 非数値列に
 * `sum`) なら既定へフォールバックする。壊れた localStorage 耐性 (#566) の一環。
 */
export function resolveFooterFn(fn: FooterAggFn | undefined, kind: CellKind): FooterAggFn {
  if (fn && availableFooterFns(kind).includes(fn)) return fn;
  return defaultFooterFn(kind);
}

/** フッターセル 1 個の表示用結果。整形 (ロケール依存) は呼び出し側が行う。 */
export interface FooterCell {
  fn: FooterAggFn;
  /** 数値結果 (sum/avg/min/max/count/distinct)。該当しなければ null。 */
  numeric: number | null;
  /** NULL 率 (0〜100)。`nullRate` 以外は null。 */
  percent: number | null;
  /** true なら空セル表示 (`none`、または数値関数だが数値データが無い列)。 */
  blank: boolean;
}

/**
 * 列統計 (`ColumnStats`) と選択された関数から、フッターセルの表示値を取り出す。
 * 純関数で、実データ・コピー・エクスポートには一切影響しない。
 */
export function computeFooterCell(stats: ColumnStats, fn: FooterAggFn): FooterCell {
  const base: FooterCell = { fn, numeric: null, percent: null, blank: false };
  switch (fn) {
    case "count":
      return { ...base, numeric: stats.nonNullCount };
    case "distinct":
      return { ...base, numeric: stats.distinctCount };
    case "nullRate":
      return { ...base, percent: stats.count > 0 ? (stats.nullCount / stats.count) * 100 : 0 };
    case "sum":
      return { ...base, numeric: stats.sum, blank: stats.sum === null };
    case "avg":
      return { ...base, numeric: stats.avg, blank: stats.avg === null };
    case "min":
      return { ...base, numeric: stats.min, blank: stats.min === null };
    case "max":
      return { ...base, numeric: stats.max, blank: stats.max === null };
    case "none":
    default:
      return { ...base, blank: true };
  }
}

/** 列の生値から直接フッターセルを計算する便宜関数 (テスト・単発計算用)。 */
export function footerCellForColumn(values: CellValue[], kind: CellKind, fn: FooterAggFn): FooterCell {
  return computeFooterCell(columnStats(values, kind), fn);
}

// ─────────────────────────────────────────────────────────────────────────────
// テーブル単位の永続化 (#645 / #616 と方針共有、破損耐性 #566)
// ─────────────────────────────────────────────────────────────────────────────

/** テーブル単位で保存するフッター状態。全フィールド任意 (無ければ既定)。 */
export interface PersistedFooterState {
  /** フッター行を表示するか。 */
  enabled?: boolean;
  /** 列 ID (`String(originalIndex)`) → 選択された集計関数。 */
  aggs?: Record<string, FooterAggFn>;
}

/**
 * 列サイジングキー (`noobdb.colsizing.v1::…`) からフッター状態キーを導出する。
 * `colStateKeyFrom` と同じ発想で、同一のテーブル署名 (database+table+列構成) を
 * 引き継ぐ。プレビューペイン (キー無し) では undefined になり永続化しない。
 */
export function footerStateKeyFrom(sizingKey: string | undefined): string | undefined {
  return sizingKey ? sizingKey.replace("noobdb.colsizing.v1", "noobdb.gridfooter.v1") : undefined;
}

function isFooterFn(v: unknown): v is FooterAggFn {
  return typeof v === "string" && (ALL_FOOTER_FNS as string[]).includes(v);
}

/**
 * 保存済みフッター状態を読む。壊れた JSON・型不一致・未知の関数値は破棄して
 * 既定へフォールバックする (private mode / quota / 破損に耐える。#566)。
 */
export function readStoredFooterState(key: string | undefined): PersistedFooterState {
  if (!key) return {};
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: PersistedFooterState = {};
    if (typeof (parsed as { enabled?: unknown }).enabled === "boolean") {
      out.enabled = (parsed as { enabled: boolean }).enabled;
    }
    const aggs = (parsed as { aggs?: unknown }).aggs;
    if (aggs && typeof aggs === "object") {
      const clean: Record<string, FooterAggFn> = {};
      for (const [col, fn] of Object.entries(aggs as Record<string, unknown>)) {
        if (isFooterFn(fn)) clean[col] = fn;
      }
      if (Object.keys(clean).length > 0) out.aggs = clean;
    }
    return out;
  } catch {
    // ignore (corrupt entry, private mode, quota)
    return {};
  }
}

/**
 * フッター状態を保存する。実質デフォルト (非表示かつ列選択なし) のときは
 * エントリを削除して、リセットが確実に既定へ戻るようにする (`writeStoredColumnState`
 * と同じ発想)。
 */
export function writeStoredFooterState(key: string | undefined, state: PersistedFooterState): void {
  if (!key) return;
  try {
    const hasAggs = !!state.aggs && Object.keys(state.aggs).length > 0;
    if (!state.enabled && !hasAggs) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, JSON.stringify(state));
    }
  } catch {
    // ignore (private mode, quota)
  }
}
