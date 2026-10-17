import { durations, staggerTiming } from "../motion";

/**
 * 結果グリッドの「初回バッチ着弾リビール」(#1579) の純ロジック。再生は
 * `useFirstBatchReveal.ts`。
 *
 * ストリーミング実行で最初の行が届いた瞬間 (スケルトン → 実データ) に、見えている行だけを
 * 1 回限り stagger でフェード / slide-up させる。追加バッチ・スクロール・ソート/フィルタ
 * (こちらは `useRowCrossfade`, #1416) では再生しない。
 */

/** stagger を段階的にずらす行数の上限。これ以降の行は最終段と同時に出し、高いビューポートでも
 *  総所要時間が伸びず、遅れて出る行の手前だけ空白になる見た目も避ける。 */
export const FIRST_BATCH_REVEAL_MAX_STEPS = 12;

/** ビューポートが未計測のときに演出する行数の上限 (数千行を一斉にアニメーションさせない)。 */
export const FIRST_BATCH_REVEAL_FALLBACK_ROWS = 50;

/**
 * 初回バッチの着弾か。直前のコミットでスケルトンを出していて (= 行が 0 件のまま
 * ストリーミング待ち)、今回のコミットで行が 1 件以上になったときだけ true。
 * 追加バッチ (行が 0 → 増えるのではなく N → N+M) や、ストリーミングでない結果は対象外。
 */
export function isFirstBatchArrival(prevSkeletonShown: boolean, rowCount: number): boolean {
  return prevSkeletonShown && rowCount > 0;
}

/**
 * リビールする行数。描画済みの `total` 行のうち、先頭から上端が `viewportBottom` より上の
 * ものを数える (仮想化の overscan で描画されているだけの画面外の行は数えない)。上限は設けず
 * 画面内の全行が対象 (描画済みの行数は仮想化が抑えている)。`topAt(i)` は i 行目の上端座標で、
 * 画面外に達した時点で打ち切るため、読み取り (レイアウト計測) は対象行 + 1 回だけになる。
 * `viewportBottom` が未計測の 0 以下 / 非有限なら先頭 `FIRST_BATCH_REVEAL_FALLBACK_ROWS` 行まで。
 */
export function firstBatchRevealCount(
  total: number,
  topAt: (index: number) => number,
  viewportBottom: number,
): number {
  if (!Number.isFinite(viewportBottom) || viewportBottom <= 0)
    return Math.min(total, FIRST_BATCH_REVEAL_FALLBACK_ROWS);
  let n = 0;
  while (n < total && topAt(n) < viewportBottom) n++;
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
