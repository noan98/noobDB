/**
 * スクロール端影 (#1073) の判定ロジック。
 *
 * 横 (必要なら縦) にスクロールするコンテナの端に「まだ先に内容が続く」ことを示す
 * 控えめなグラデーション影を出すための、DOM 非依存の純関数群。描画は
 * `ScrollEdgeShadows.tsx` が担い、ここは「どの端に影を出すか」だけを決める。
 *
 * - 影は **その方向にまだスクロールできるときだけ** 出し、端まで到達したら消す。
 * - スクロール位置は小数になり得る (高 DPI / ズーム) ため、`threshold` (既定 1px)
 *   未満の残りは「端に到達済み」とみなしてチラつきを防ぐ。
 * - ピン留め列のように **スクロールしない帯** がビューポートの左右を占める面では、
 *   影をその帯の内側の境界に出す (`insetStart` / `insetEnd`)。帯がビューポートを
 *   ほぼ覆い尽くして影を置く余地が無いときは横方向の影を出さない。
 */

/** スクロールコンテナの寸法とスクロール位置 (`Element` の同名プロパティ)。 */
export interface ScrollMetrics {
  scrollLeft: number;
  scrollTop: number;
  scrollWidth: number;
  scrollHeight: number;
  clientWidth: number;
  clientHeight: number;
}

/** 各端に影を出すか。`start` / `end` は横 (左 / 右)、`top` / `bottom` は縦。 */
export interface ScrollEdges {
  start: boolean;
  end: boolean;
  top: boolean;
  bottom: boolean;
}

export const NO_SCROLL_EDGES: ScrollEdges = Object.freeze({
  start: false,
  end: false,
  top: false,
  bottom: false,
});

export interface ScrollEdgeOptions {
  /** 端に到達済みとみなす残りスクロール量 (px)。既定 1。 */
  threshold?: number;
  /** ビューポート左端のスクロールしない帯の幅 (行番号列 + 左ピン留め列など)。 */
  insetStart?: number;
  /** ビューポート右端のスクロールしない帯の幅 (右ピン留め列など)。 */
  insetEnd?: number;
  /**
   * 左右の帯の間に最低限残っていなければならない幅 (px)。これを下回ると影を
   * 置いても読み取れない (あるいは帯の上に重なる) ため横方向の影を出さない。
   * 既定 0。
   */
  minVisibleWidth?: number;
}

function finiteNonNegative(n: number | undefined, fallback: number): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : fallback;
}

/** スクロール状態から、影を出すべき端を求める。 */
export function computeScrollEdges(m: ScrollMetrics, opts: ScrollEdgeOptions = {}): ScrollEdges {
  const threshold = finiteNonNegative(opts.threshold, 1);
  const insetStart = finiteNonNegative(opts.insetStart, 0);
  const insetEnd = finiteNonNegative(opts.insetEnd, 0);
  const minVisible = finiteNonNegative(opts.minVisibleWidth, 0);

  const maxX = Math.max(0, m.scrollWidth - m.clientWidth);
  const maxY = Math.max(0, m.scrollHeight - m.clientHeight);
  // スクロール位置はオーバースクロール (弾性スクロール) で範囲外に出ることがあるので丸める。
  const x = Math.min(Math.max(m.scrollLeft, 0), maxX);
  const y = Math.min(Math.max(m.scrollTop, 0), maxY);

  const xRoom = m.clientWidth - insetStart - insetEnd;
  const xAllowed = maxX >= threshold && xRoom > minVisible;

  return {
    start: xAllowed && x >= threshold,
    end: xAllowed && maxX - x >= threshold,
    top: maxY >= threshold && y >= threshold,
    bottom: maxY >= threshold && maxY - y >= threshold,
  };
}

/** 2 つの判定結果が等しいか (等しければ再レンダーを省く)。 */
export function sameScrollEdges(a: ScrollEdges, b: ScrollEdges): boolean {
  return a.start === b.start && a.end === b.end && a.top === b.top && a.bottom === b.bottom;
}
