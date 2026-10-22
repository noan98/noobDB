/**
 * 結果グリッドのページ送り演出 (#1752) の純ロジック。`usePageTurn` が前回ページと
 * 今回ページから再生内容を決めるのに使う。
 *
 * - `null`: ページが変わっていない (再生しない)。
 * - `1`: 次ページへの送り (新しい行が右から入る)。
 * - `-1`: 前ページへの送り (新しい行が左から入る)。
 * - `0`: 先頭 / 末尾 / 任意ページへの大ジャンプ。方向なしのクロスフェード。
 *
 * `directionalSlide` (#1234) の `dir` と同じ向きの規約。
 */
export type PageTurnDir = -1 | 0 | 1;

export function pageTurnDirection(prevPage: number, nextPage: number): PageTurnDir | null {
  if (!Number.isFinite(prevPage) || !Number.isFinite(nextPage)) return null;
  const delta = nextPage - prevPage;
  if (delta === 0) return null;
  if (delta === 1) return 1;
  if (delta === -1) return -1;
  return 0;
}
