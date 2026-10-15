// 結果セットのページネーションの純ロジック。
//
// table タブは `paginatable` (LIMIT/OFFSET を持たない素の SELECT) を保持しており、
// ここではその base SQL から「N ページ目」の SQL を組み立て、行数推定から総ページ数の
// 目安を算出する。状態管理と再フェッチは App.tsx、UI は PaginationBar が担当する。
// 副作用がないので Vitest でユニットテストする。

/** ページサイズセレクタの選択肢。 */
export const PAGE_SIZE_OPTIONS = [50, 100, 250, 500, 1000] as const;

/**
 * paginatable な base SQL から `page` ページ目 (1 始まり) の SQL を組み立てる。
 * `LIMIT pageSize OFFSET pageSize*(page-1)` を付与する。
 */
export function buildPageSql(base: string, pageSize: number, page: number): string {
  const size = Math.max(1, Math.floor(pageSize));
  const p = Math.max(1, Math.floor(page));
  const offset = size * (p - 1);
  return `${base} LIMIT ${size} OFFSET ${offset}`;
}

/**
 * 行数推定から総ページ数の目安を返す。推定が不明 (null/非有限/0 以下) なら null。
 */
export function estimatedTotalPages(rowEstimate: number | null | undefined, pageSize: number): number | null {
  if (rowEstimate == null || !Number.isFinite(rowEstimate) || rowEstimate <= 0) return null;
  const size = Math.max(1, Math.floor(pageSize));
  return Math.max(1, Math.ceil(rowEstimate / size));
}

/** ページ番号を [1, totalPages] にクランプする。total が null なら下限のみ。 */
export function clampPage(page: number, totalPages: number | null): number {
  const p = Math.max(1, Math.floor(Number.isFinite(page) ? page : 1));
  if (totalPages != null) return Math.min(p, Math.max(1, totalPages));
  return p;
}

/**
 * 「次ページへ進めるか」を判定する。総ページ数が分かっていればそれ (推定が小さい場合に備え、満杯なら続行可) で判断し、不明なら
 * 「直近のページがちょうど pageSize 件返ってきた = まだ続きがありそう」で判断する
 * (apply_auto_limit と同じく保守的: 満杯でなければ最終ページとみなす)。
 */
export function canGoNext(
  page: number,
  totalPages: number | null,
  lastPageRowCount: number,
  pageSize: number,
  confirmed = false,
): boolean {
  // 正確な件数 (#1627) で確定した総ページ数なら、最終ページで満杯でも続きは無い。
  if (confirmed && totalPages != null) return page < totalPages;
  const full = lastPageRowCount >= Math.max(1, Math.floor(pageSize));
  // 総ページ数は統計由来の推定 (InnoDB の TABLE_ROWS 等) で実数より小さいことがある。
  // 推定の最終ページでも満杯なら続きがありうるので、次へは止めない。
  if (totalPages != null) return page < totalPages || full;
  return full;
}

/**
 * ページ移動のクランプに使う総ページ数。推定 (統計由来) は実数より小さいことがあるので、
 * 現在ページ (推定を超えて表示中でもよい) を下限にし、満杯なら 1 ページ先まで許す。
 */
export function effectiveTotalPages(
  estimated: number | null,
  currentPage: number,
  currentPageFull: boolean,
  confirmed = false,
): number | null {
  if (estimated == null) return null;
  if (confirmed) return estimated;
  return Math.max(estimated, currentPage + (currentPageFull ? 1 : 0));
}

/** 「前ページへ戻れるか」。1 ページ目より大きいかどうか。 */
export function canGoPrev(page: number): boolean {
  return page > 1;
}

/** このページの先頭・末尾の行番号 (1 始まり) を返す。表示用。 */
export function pageRange(page: number, pageSize: number, rowsOnPage: number): { from: number; to: number } {
  const size = Math.max(1, Math.floor(pageSize));
  const p = Math.max(1, Math.floor(page));
  if (rowsOnPage <= 0) return { from: 0, to: 0 };
  const from = size * (p - 1) + 1;
  return { from, to: from + rowsOnPage - 1 };
}

// ---------------------------------------------------------------------------
// 正確な総件数 (#1627)
// ---------------------------------------------------------------------------

/** 数え終えた正確な件数。`key` が今の表示条件と一致するときだけ有効 (条件が変われば無視)。 */
export interface ExactRowCount {
  total: number;
  key: string;
}

/** 件数の有効条件。ベース SQL とサーバ側フィルタが同じなら同じ母数。ソートは件数に影響しない。 */
export function exactCountKey(base: string, filter: unknown): string {
  return `${base}\u0000${JSON.stringify(filter ?? null)}`;
}

/**
 * ベース SELECT (フィルタ適用済み・ソートなし) を包んだ件数取得 SQL。3 ドライバ共通の
 * 標準 SQL で、派生テーブルに別名を付ける (MySQL / PostgreSQL は必須)。末尾の `;` は落とす。
 */
export function buildCountSql(effectiveBase: string): string {
  const base = effectiveBase.trim().replace(/;+\s*$/, "");
  return `SELECT COUNT(*) FROM (${base}) AS noobdb_count`;
}

/**
 * 件数取得結果の先頭セルを非負の安全整数にする。数値でも (64bit の lossless 変換で)
 * 文字列でも受け、整数として読めないもの・安全整数を超えるものは null。
 */
export function parseCountCell(cell: unknown): number | null {
  const n =
    typeof cell === "number"
      ? cell
      : typeof cell === "string" && cell.trim() !== ""
        ? Number(cell.trim())
        : Number.NaN;
  if (!Number.isSafeInteger(n) || n < 0) return null;
  return n;
}

/** 正確な件数から総ページ数を出す。0 件でも 1 ページ。 */
export function totalPagesFromCount(total: number, pageSize: number): number {
  const size = Math.max(1, Math.floor(pageSize));
  return Math.max(1, Math.ceil(total / size));
}

/** 条件 (`key`) が一致する正確な件数だけを返す。不一致・未取得は null。 */
export function matchingExactCount(exact: ExactRowCount | null | undefined, key: string): number | null {
  return exact && exact.key === key ? exact.total : null;
}
