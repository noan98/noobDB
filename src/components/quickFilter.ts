/**
 * セル右クリックの「この値で絞り込む / 除外する」(#914) の純ロジック。
 *
 * 探索作業で最頻用の「この値で絞る」を右クリック 1 手にするための橋渡しで、
 * **新しいフィルタモデルは一切増やさない**。クリックしたセルの値を、既存の
 * 2 経路 —
 *
 * - テーブルタブ (サーバ側ブラウズ): `serverBrowse.ts` の `ServerFilter`
 *   (`onSetServerFilter` → `applyServerBrowse` が WHERE を組む)
 * - クエリ結果タブ (クライアント側): `ResultGrid` の `ColumnFilter`
 *   (TanStack の `ColumnFiltersState` に載る)
 *
 * — のどちらの表現へも変換できるようにするだけで、絞り込みの実行・表示
 * (フィルタチップ / ヘッダーのアクティブ表示) は既存の仕組みがそのまま担う。
 *
 * ## NULL と「除外」の意味論
 *
 * NULL セルは値の比較ではなく NULL 判定に倒す (`IS NULL` / `IS NOT NULL`、
 * クライアントは `nullMode: only / exclude`)。非 NULL 値の「除外」(`ne`) は
 * 両経路とも **NULL 行にマッチしない**: SQL の `col <> 'x'` は三値論理で
 * NULL を落とし、クライアント側の `columnFilter` も値条件のある行では NULL を
 * 弾く。意図的に揃えてあり、テーブルブラウズとクエリ結果で見え方が変わらない。
 *
 * 副作用のない純関数だけを置き、`quickFilter.test.ts` で単体テストする。
 */

import type { CellValue } from "../api/tauri";
import type { ColumnFilter } from "./ResultGrid";
import type { ServerFilterOp } from "./serverBrowse";

/** クイックフィルタの向き: この値に一致 / この値以外。 */
export type QuickFilterMode = "eq" | "ne";

/**
 * セル値が NULL か。`CellValue` は `null` を含むが、行配列の穴 (列数より短い行)
 * では `undefined` が読み出されうるため、`ResultGrid` のセル描画と同じく両方を
 * NULL として扱う。
 */
export function isNullCell(v: CellValue | undefined): boolean {
  return v === null || v === undefined;
}

/** メニューラベルに埋め込む値の表示用文字列の既定の最大長。 */
export const QUICK_FILTER_LABEL_MAX = 24;

/**
 * メニューラベル用にセル値を短縮する。長い値は末尾を省略記号に畳み (メニュー幅が
 * 値の長さで暴れないように)、改行/タブは 1 つの空白へ潰す (メニュー項目は 1 行で
 * 表示されるため、生の改行はレイアウトを崩すだけで情報にならない)。NULL は
 * 呼び出し側が専用の文言を出すので、ここでは空文字を返す。
 */
export function quickFilterValueLabel(
  v: CellValue | undefined,
  max = QUICK_FILTER_LABEL_MAX,
): string {
  if (isNullCell(v)) return "";
  const flat = String(v).replace(/\s+/g, " ").trim();
  if (max <= 1) return flat.length > max ? "…" : flat;
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * サーバ側ブラウズ (table タブ) 用のフィルタ指定へ変換する。値のリテラル化 /
 * 識別子クオートは `buildServerFilterClause` が方言別に行うので、ここでは生値の
 * ままで渡す (エスケープを二重に持たない)。
 */
export function serverQuickFilter(
  v: CellValue | undefined,
  mode: QuickFilterMode,
  numeric: boolean,
): { op: ServerFilterOp; value: string; numeric: boolean } {
  if (isNullCell(v)) {
    return { op: mode === "eq" ? "isNull" : "isNotNull", value: "", numeric };
  }
  return { op: mode, value: String(v), numeric };
}

/**
 * クライアント側 (クエリ結果タブ) 用の `ColumnFilter` へ変換する。数値列は
 * `eq`/`ne` (BigInt を含む数値比較)、それ以外は `equals`/`notEquals` (大小無視の
 * 文字列比較) を使い、列ヘッダのポップアップから同じ条件を組んだときと完全に
 * 同じ値になるようにする。
 */
export function clientQuickFilter(
  v: CellValue | undefined,
  mode: QuickFilterMode,
  numeric: boolean,
): ColumnFilter {
  if (isNullCell(v)) {
    return {
      op: numeric ? "eq" : "contains",
      value: "",
      value2: "",
      nullMode: mode === "eq" ? "only" : "exclude",
    };
  }
  return {
    op: numeric ? mode : mode === "eq" ? "equals" : "notEquals",
    value: String(v),
    value2: "",
    nullMode: "any",
  };
}
