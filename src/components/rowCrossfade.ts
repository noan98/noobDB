/**
 * 結果グリッドのクライアント側ソート / フィルタ適用時のクロスフェード (#1416) の
 * 再生判定キー。`useRowCrossfade` が前回と違うキーのときだけ `<tbody>` の opacity を
 * 1 回再生する。列幅・列順・選択など、行の並びを変えない状態は含めない。
 *
 * - `sort`: ソート状態。クリック 1 回ごとの離散操作なので即時に再生する。
 * - `filter`: 列フィルタ + グローバルフィルタ。入力中は 1 文字ごとに変わるため、
 *   `useRowCrossfade` が入力の落ち着きを待ってから 1 回だけ再生する。
 */
export interface RowCrossfadeKeys {
  sort: string;
  filter: string;
}

export function rowCrossfadeKeys(
  sorting: unknown,
  columnFilters: unknown,
  globalFilter: string | undefined | null,
): RowCrossfadeKeys {
  return {
    sort: JSON.stringify(sorting),
    filter: JSON.stringify([columnFilters, (globalFilter ?? "").trim()]),
  };
}
