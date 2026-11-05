import type { TimelapseGenerationMeta } from "./api/tauri";

/**
 * テーブル・タイムラプスの再生ステート機 (#2015)。UI から切り離した純関数。
 *
 * 世代一覧は新しい順 (`defaultGenerationPair` と同じ) で届くので、時系列 (古い順) に
 * 並べ直して「段 (step)」を数える。段 k (1 〜 世代数-1) は隣接ペア
 * 「k-1 番目 → k 番目」の差分で、スクラバーの値・再生の進行はこの段で表す。
 */

/** 1 段を表示してから次の段へ進むまでの待ち時間 (ミリ秒)。差分の取得完了後に数え始める。 */
export const PLAYBACK_DWELL_MS = 900;

export interface PlaybackState {
  /** 現在の段 (1 〜 maxStep)。世代が 2 つ未満なら 0。 */
  step: number;
  /** 最終段 (= 世代数 - 1)。 */
  maxStep: number;
  playing: boolean;
}

export type PlaybackAction =
  | { type: "play"; reducedMotion: boolean }
  | { type: "pause" }
  /** 再生中の自動段送り。終端に達したら停止する。 */
  | { type: "advance" }
  /** 手動の段送り / 巻き戻し (±1)。再生は止める。 */
  | { type: "stepBy"; delta: number }
  /** スクラバー操作。再生は止める。 */
  | { type: "seek"; step: number };

export function clampStep(step: number, maxStep: number): number {
  if (maxStep < 1) return 0;
  if (!Number.isFinite(step)) return 1;
  return Math.min(maxStep, Math.max(1, Math.round(step)));
}

export function initialPlayback(step: number, maxStep: number): PlaybackState {
  return { step: clampStep(step, maxStep), maxStep: Math.max(0, maxStep), playing: false };
}

/**
 * 再生ステート機。
 * - play: reduced-motion のときは無効 (ステップ送りだけ)。終端で押したら最初の段から再生し直す。
 *   段が無い (世代 2 つ未満) ときも何もしない。
 * - advance: 再生中のみ 1 段進め、終端に達したらその段で停止する。
 * - stepBy / seek: 手動操作なので再生は停止する。
 */
export function playbackReducer(state: PlaybackState, action: PlaybackAction): PlaybackState {
  const { maxStep } = state;
  switch (action.type) {
    case "play": {
      if (action.reducedMotion || maxStep < 1) return { ...state, playing: false };
      if (state.playing) return state;
      const step = state.step >= maxStep ? 1 : state.step;
      // 段が 1 つしかなければ再生するものが無い。
      if (maxStep === 1) return { ...state, step, playing: false };
      return { ...state, step, playing: true };
    }
    case "pause":
      return state.playing ? { ...state, playing: false } : state;
    case "advance": {
      if (!state.playing) return state;
      if (state.step >= maxStep) return { ...state, playing: false };
      const step = state.step + 1;
      return { ...state, step, playing: step < maxStep };
    }
    case "stepBy":
      return { ...state, step: clampStep(state.step + action.delta, maxStep), playing: false };
    case "seek":
      return { ...state, step: clampStep(action.step, maxStep), playing: false };
  }
}

/** 世代一覧 (新しい順) を時系列 (古い順) に並べ直す。 */
export function chronologicalGenerations(
  generations: readonly TimelapseGenerationMeta[],
): TimelapseGenerationMeta[] {
  return [...generations].reverse();
}

/** 最終段 (= 世代数 - 1)。 */
export function playbackMaxStep(generations: readonly TimelapseGenerationMeta[]): number {
  return Math.max(0, generations.length - 1);
}

/** 段 → 隣接ペア (古い方 → 新しい方)。範囲外は null。 */
export function pairAtStep(
  generations: readonly TimelapseGenerationMeta[],
  step: number,
): { fromId: number; toId: number } | null {
  const n = generations.length;
  if (!Number.isInteger(step) || step < 1 || step > n - 1) return null;
  // generations は新しい順: 時系列 k 番目 = generations[n-1-k]。
  return { fromId: generations[n - step].id, toId: generations[n - 1 - step].id };
}

/**
 * ペアの「新しい側」の世代が時系列で何番目かを段として返す。ペアが世代に無い、または
 * 先頭 (最古) 世代が新しい側のときは null。隣接でないペア (任意選択) でも新しい側の段で
 * スクラバーの位置を示す。
 */
export function stepOfPair(
  generations: readonly TimelapseGenerationMeta[],
  pair: { fromId: number; toId: number } | null,
): number | null {
  if (!pair) return null;
  const idx = generations.findIndex((g) => g.id === pair.toId);
  if (idx < 0) return null;
  const step = generations.length - 1 - idx;
  return step >= 1 ? step : null;
}
