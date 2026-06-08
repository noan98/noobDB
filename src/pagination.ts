// 結果セットのページネーション (#484) の純ロジック。
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
export function estimatedTotalPages(
  rowEstimate: number | null | undefined,
  pageSize: number,
): number | null {
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
 * 「次ページへ進めるか」を判定する。総ページ数が分かっていればそれで判断し、不明なら
 * 「直近のページがちょうど pageSize 件返ってきた = まだ続きがありそう」で判断する
 * (apply_auto_limit と同じく保守的: 満杯でなければ最終ページとみなす)。
 */
export function canGoNext(
  page: number,
  totalPages: number | null,
  lastPageRowCount: number,
  pageSize: number,
): boolean {
  if (totalPages != null) return page < totalPages;
  return lastPageRowCount >= Math.max(1, Math.floor(pageSize));
}

/** 「前ページへ戻れるか」。1 ページ目より大きいかどうか。 */
export function canGoPrev(page: number): boolean {
  return page > 1;
}

/** このページの先頭・末尾の行番号 (1 始まり) を返す。表示用。 */
export function pageRange(
  page: number,
  pageSize: number,
  rowsOnPage: number,
): { from: number; to: number } {
  const size = Math.max(1, Math.floor(pageSize));
  const p = Math.max(1, Math.floor(page));
  if (rowsOnPage <= 0) return { from: 0, to: 0 };
  const from = size * (p - 1) + 1;
  return { from, to: from + rowsOnPage - 1 };
}
