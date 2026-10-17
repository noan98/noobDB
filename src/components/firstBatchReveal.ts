import { durations, staggerTiming } from "../motion";

/**
 * 結果グリッドの「初回バッチ着弾リビール」(#1579) の純ロジック。再生は
 * `useFirstBatchReveal.ts`。
 *
 * ストリーミング実行で最初の行が届いた瞬間 (スケルトン → 実データ) に、見えている行だけを
 * 1 回限り stagger でフェード / slide-up させる。追加バッチ・スクロール・ソート/フィルタ
 * (こちらは `useRowCrossfade`, #1416) では再生しない。
 */

/** リビール対象の行数の上限 (描画コストの上限)。仮想化で描画済みの行のうち画面内のものだけが対象。 */
export const FIRST_BATCH_REVEAL_MAX_ROWS = 24;

/** stagger を段階的にずらす行数の上限。これ以降の行は最終段と同時に出し、高いビューポートでも
 *  総所要時間が伸びず、遅れて出る行の手前だけ空白になる見た目も避ける。 */
export const FIRST_BATCH_REVEAL_MAX_STEPS = 12;

/**
 * 初回バッチの着弾か。直前のコミットでスケルトンを出していて (= 行が 0 件のまま
 * ストリーミング待ち)、今回のコミットで行が 1 件以上になったときだけ true。
 * 追加バッチ (行が 0 → 増えるのではなく N → N+M) や、ストリーミングでない結果は対象外。
 */
export function isFirstBatchArrival(prevSkeletonShown: boolean, rowCount: number): boolean {
  return prevSkeletonShown && rowCount > 0;
}

/**
 * リビールする行数。描画済みの行のうち、ビューポート内 (上端が `viewportBottom` より上) の
 * ものを先頭から数え、`max` で打ち切る (`viewportBottom` が未計測の 0 以下なら上限のみ)。仮想化の overscan で描画されているだけの
 * 画面外の行は数えない。`rowTops` は行の上端座標 (表示順・昇順)。
 */
export function firstBatchRevealCount(
  rowTops: readonly number[],
  viewportBottom: number,
  max: number = FIRST_BATCH_REVEAL_MAX_ROWS,
): number {
  // 未計測 (高さ 0 / jsdom / display:none) ではビューポートで絞れないので上限だけで打ち切る。
  const bounded = Number.isFinite(viewportBottom) && viewportBottom > 0;
  let n = 0;
  for (const top of rowTops) {
    if (n >= max || (bounded && top >= viewportBottom)) break;
    n++;
  }
  return n;
}

/** `index` 行目 (0 始まり) の開始遅延 (ms)。先頭行は待たず、`staggerTiming.each` 刻みで
 *  `FIRST_BATCH_REVEAL_MAX_STEPS` 段目まで増え、以降は頭打ち。 */
export function firstBatchRevealDelayMs(index: number): number {
  return Math.round(Math.min(index, FIRST_BATCH_REVEAL_MAX_STEPS - 1) * staggerTiming.each * 1000);
}

/** リビール全体の最大所要時間 (ms) = 最終行の遅延 + 1 行ぶんの再生時間。テスト・見積もり用。 */
export function firstBatchRevealTotalMs(count: number): number {
  if (count <= 0) return 0;
  return firstBatchRevealDelayMs(count - 1) + Math.round(durations.base * 1000);
}
