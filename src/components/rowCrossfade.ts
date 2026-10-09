/**
 * 結果グリッドのクライアント側ソート / フィルタ適用時のクロスフェード (#1416) の
 * 再生判定キー。ソート・列フィルタ・グローバルフィルタの状態を 1 本の文字列にし、
 * 前回と違うときだけ `useRowCrossfade` が `<tbody>` の opacity を 1 回再生する。
 * (列幅・列順・選択など、行の並びを変えない状態はキーに含めない。)
 */
export function rowCrossfadeKey(
  sorting: unknown,
  columnFilters: unknown,
  globalFilter: string | undefined | null,
): string {
  return JSON.stringify([sorting, columnFilters, (globalFilter ?? "").trim()]);
}
