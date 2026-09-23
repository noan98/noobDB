import type { Density } from "../settings";

/**
 * 結果ペインの初回実行スケルトン (#1071) の純ロジック。
 *
 * 副次パネル (`ProcessListPanel` / `ServerInfoPanel` / `TableStatisticsPanel` /
 * `UsersPanel`) は初回ロードで共有の `SkeletonTableRows` を出す。結果ペインも
 * 最初の行が届くまでの間 (ResultGrid の遅延ロード中 / `query-stream:columns` 受信前)
 * に同じ骨格を出すため、骨格の「形」(列数・行数) だけをここで決める。
 * 描画は `ResultPaneSkeleton.tsx`。
 */

/** 仮想スクロールの初回描画に使う、密度ごとの推定行高 (px)。App.css の
 *  `--density-row-h` と揃える。スケルトンの行数見積もりと共有する。 */
export const DENSITY_ROW_ESTIMATE: Record<Density, number> = {
  compact: 24,
  normal: 30,
  spacious: 40,
};

/** 列数が未知 (`query-stream:columns` 未着) の間に出す既定の列数。 */
export const RESULT_SKELETON_DEFAULT_COLUMNS = 5;
/** 骨格に並べる列数の上限。広い結果でも骨格は画面幅に収まる程度に留める。 */
export const RESULT_SKELETON_MAX_COLUMNS = 8;

/**
 * 骨格の列数。列数が既知 (1 以上の有限整数) ならそれに合わせ (上限でクランプ)、
 * 未知・0・不正値なら既定列数にする。
 */
export function resultSkeletonColumns(knownColumns: number | null | undefined): number {
  if (knownColumns == null || !Number.isFinite(knownColumns) || knownColumns < 1) {
    return RESULT_SKELETON_DEFAULT_COLUMNS;
  }
  return Math.min(Math.floor(knownColumns), RESULT_SKELETON_MAX_COLUMNS);
}

/**
 * 骨格の行数。表示領域の目安高さ (320px) / 密度ごとの推定行高から概算し、
 * 3〜8 行にクランプする (空白が目立たず、かつ多すぎない程度)。
 */
export function resultSkeletonRows(density: Density): number {
  return Math.min(8, Math.max(3, Math.round(320 / DENSITY_ROW_ESTIMATE[density])));
}

/**
 * 結果ペインの `Suspense` fallback に骨格を出すべきか (#1071)。
 *
 * 初回実行では `ResultGrid` / `PreviewGrid` のチャンクを遅延ロードする間、
 * fallback が表示される。表の結果を待っている (ストリーミング中) ならグリッドの
 * 骨格を、それ以外 (EXPLAIN / バッチ結果 / 非実行中のパネル切替) は結果が表で
 * ないか実行中でないため従来の Spinner を出す。
 */
export function showsResultSkeletonFallback(tab: {
  streaming?: boolean;
  kind: string;
  batchResults?: unknown;
}): boolean {
  return !!tab.streaming && tab.kind !== "explain" && !tab.batchResults;
}
