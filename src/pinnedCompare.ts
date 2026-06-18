// 結果セットのピン留め / 並列比較 (#622) の純ロジック。
//
// 任意の結果セットを破棄せず保持し (メモリ・上限あり)、2 つを並べて見比べる。
// 同一カラム構成の 2 結果は `resultDiff.ts` の PK ペアリングで行差分をハイライト
// できる (比較ビューがキー列を選んで再利用する)。ここは保持・比較可否判定の
// 副作用なし純ロジックで、UI (`PinnedComparisonView.tsx`) と分離してテストする。

import type { CellValue, Column } from "./api/tauri";

/** メモリに保持するピン留め結果 1 件 (結果セットのスナップショット)。 */
export interface PinnedResult {
  id: string;
  /** ピン留め時のタブタイトル等 (一覧での識別用)。 */
  title: string;
  /** 実行した SQL (比較時のコンテキスト表示用)。 */
  sql: string;
  columns: Column[];
  rows: CellValue[][];
  rowsAffected: number;
  elapsedMs: number;
  /** ピン留めした時刻 (ms)。古い順の破棄に使う。 */
  pinnedAt: number;
}

/** メモリ肥大を防ぐ保持上限。超過分は古いものから破棄する。 */
export const MAX_PINNED = 6;

/**
 * 2 つの結果が行差分を取れる「同一カラム構成」か。列数とすべての列名 (順序込み) が
 * 一致するときだけ true。空 (列なし) は比較不能として false。
 */
export function resultsComparable(
  a: { columns: Column[] },
  b: { columns: Column[] },
): boolean {
  if (a.columns.length === 0 || a.columns.length !== b.columns.length) return false;
  return a.columns.every((c, i) => c.name === b.columns[i].name);
}

/**
 * ピン留め一覧に 1 件追加する。上限 `max` を超えたら**古いものから**破棄する
 * (一覧は古い→新しいの順)。元配列は変更しない。
 */
export function addPinned(
  list: PinnedResult[],
  item: PinnedResult,
  max = MAX_PINNED,
): PinnedResult[] {
  const next = [...list, item];
  return next.length > max ? next.slice(next.length - max) : next;
}
