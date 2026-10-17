// オンボーディングツアーのコーチマーク (#1504) の純ロジック。
//
// 「どのステップがどの実 UI 要素を照らすか」の対応表と、測定済みの矩形から
// スポットライト枠・吹き出し位置を決める幾何計算だけを持つ。DOM の探索・測定
// (`querySelector` / `getBoundingClientRect`) は副作用なので
// `components/OnboardingTour.tsx` に置き、ここは Vitest で単体テストできる純関数に
// 保つ (`onboarding.ts` と同じ分担)。吹き出しの測定 → フリップ → クランプは
// 既存の `components/tooltipPosition.ts` をそのまま流用する (二重実装しない)。

import {
  computeTooltipPosition,
  type TooltipPlacement,
  type TooltipRect,
  type TooltipSize,
} from "./components/tooltipPosition";
import { TOUR_STEP_COUNT } from "./onboarding";

/** 1 つのアンカー候補。`selector` に一致する最初の「見えている」要素を照らす。 */
export interface TourAnchorCandidate {
  selector: string;
  /** 吹き出しを置きたい側。はみ出す場合は `computeTooltipPosition` がフリップする。 */
  placement: TooltipPlacement;
}

/**
 * ステップごとのアンカー候補 (優先順)。どれも見つからない・画面外・折りたたまれて
 * いるときは、従来どおり右下に浮く説明カードへフォールバックする。
 * 要素の特定は `data-tour` 属性 (ツアー専用の安定フック) か既存の `data-testid` で行う。
 */
export const TOUR_ANCHORS: readonly (readonly TourAnchorCandidate[])[] = [
  // 1. 接続する: ウェルカム画面の「接続を作成」カード → 無ければサイドバーのタブ列
  [
    { selector: '[data-tour="welcome-create"]', placement: "bottom" },
    { selector: '[data-tour="sidebar-tabs"]', placement: "right" },
  ],
  // 2. クエリを実行する: Run ボタン → 無ければエディタ本体
  [
    { selector: '[data-testid="query-editor-run"]', placement: "bottom" },
    { selector: '[data-testid="query-editor"]', placement: "bottom" },
  ],
  // 3. 結果をその場で編集する: 結果グリッド
  [{ selector: '[data-testid="result-grid"]', placement: "top" }],
  // 4. スニペット・履歴など: サイドバーのタブ列 (スニペット / 履歴 / ローカル)
  [{ selector: '[data-tour="sidebar-tabs"]', placement: "right" }],
];

/** 要素のうち、ビューポート内に最低限これだけ見えていないとアンカーにしない割合。 */
const MIN_VISIBLE_RATIO = 0.5;

/** スポットライト枠を対象より外へ広げる余白 (px)。 */
export const SPOTLIGHT_PAD = 4;

/** 吹き出しとスポットライト枠の間隔 (px)。`Tooltip` の MARGIN_PX と揃える。 */
export const COACHMARK_MARGIN = 8;

/** 矩形をビューポートでクリップする。交差が空なら null。 */
export function clipRect(rect: TooltipRect, viewport: TooltipSize): TooltipRect | null {
  const left = Math.max(rect.left, 0);
  const top = Math.max(rect.top, 0);
  const right = Math.min(rect.right, viewport.width);
  const bottom = Math.min(rect.bottom, viewport.height);
  if (right <= left || bottom <= top) return null;
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

/**
 * 測定した矩形がアンカーとして使えるか。大きさが無い (display:none / 折りたたみ)、
 * ビューポートとほぼ交差しない (画面外) 場合は false。
 */
export function isAnchorUsable(rect: TooltipRect, viewport: TooltipSize): boolean {
  if (rect.width <= 0 || rect.height <= 0) return false;
  const clipped = clipRect(rect, viewport);
  if (!clipped) return false;
  return (clipped.width * clipped.height) / (rect.width * rect.height) >= MIN_VISIBLE_RATIO;
}

/** ビューポートでクリップしたうえで、四方へ `pad` 広げたスポットライト枠を返す。 */
export function spotlightRect(
  rect: TooltipRect,
  viewport: TooltipSize,
  pad = SPOTLIGHT_PAD,
): TooltipRect | null {
  const clipped = clipRect(rect, viewport);
  if (!clipped) return null;
  const left = clipped.left - pad;
  const top = clipped.top - pad;
  const width = clipped.width + pad * 2;
  const height = clipped.height + pad * 2;
  return { left, top, width, height, right: left + width, bottom: top + height };
}

/** 2 つの矩形が重なるか (接するだけは重ならない)。 */
export function rectsOverlap(a: TooltipRect, b: TooltipRect): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/** ステップ番号を配列範囲へ丸める (範囲外でも undefined を引かない)。 */
export function anchorsForStep(step: number): readonly TourAnchorCandidate[] {
  const i = Math.min(Math.max(step, 0), TOUR_STEP_COUNT - 1);
  return TOUR_ANCHORS[i] ?? [];
}

export interface CoachmarkLayout {
  left: number;
  top: number;
  /** 吹き出しがスポットライト枠に被ってしまう (巨大なアンカーなど) 。true なら
   *  呼び出し側は枠の外に置けないものとして隅の固定位置へフォールバックする。 */
  covers: boolean;
}

/**
 * スポットライト枠 `spot` の近傍に置く吹き出しの `position: fixed` 座標。
 * 位置決めは `computeTooltipPosition` (フリップ + クランプ) に委ね、結果が枠と
 * 重なる場合は `covers` を立てる。
 */
export function computeCoachmarkLayout(
  spot: TooltipRect,
  size: TooltipSize,
  placement: TooltipPlacement,
  viewport: TooltipSize,
  margin = COACHMARK_MARGIN,
): CoachmarkLayout {
  const { left, top } = computeTooltipPosition(spot, size, placement, margin, viewport);
  const bubble: TooltipRect = {
    left,
    top,
    right: left + size.width,
    bottom: top + size.height,
    width: size.width,
    height: size.height,
  };
  return { left, top, covers: rectsOverlap(bubble, spot) };
}

/** 矩形の数値が (丸めて) 同じか。再測定のたびに state を更新して再描画しないための判定。 */
export function sameRect(a: TooltipRect | null, b: TooltipRect | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    Math.round(a.left) === Math.round(b.left) &&
    Math.round(a.top) === Math.round(b.top) &&
    Math.round(a.width) === Math.round(b.width) &&
    Math.round(a.height) === Math.round(b.height)
  );
}
