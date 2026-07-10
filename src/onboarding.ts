// 初回起動オンボーディングツアー (#599) の純ロジック。
//
// `tableQuickAccess.ts` / `planWatch.ts` と同じ方針で、状態遷移は副作用なしの
// 純関数として提供し (Vitest でユニットテスト)、localStorage への読み書きだけ
// を薄い副作用関数 (`beenShown` / `markShown`) に分離する。壊れた値・ストレージ
// 無効環境でも例外を投げず安全な既定へフォールバックする (他ストアと同じ防御的
// パース方針)。ステップの文言 (タイトル/説明) は i18n 依存のため UI 側
// (`components/OnboardingTour.tsx`) が持ち、ここではステップ数と進行状態のみを
// 扱う。

/** ツアーの総ステップ数。 */
export const TOUR_STEP_COUNT = 4;

/** ツアーの進行状態。 */
export interface TourState {
  /** 現在表示中のステップ (0-indexed)。 */
  step: number;
}

export const INITIAL_TOUR_STATE: TourState = { step: 0 };

/** 先頭ステップかどうか ("戻る" を無効化する判定に使う)。 */
export function isFirstStep(state: TourState): boolean {
  return state.step <= 0;
}

/** 末尾ステップかどうか ("次へ" を "完了" に切り替える判定に使う)。 */
export function isLastStep(state: TourState): boolean {
  return state.step >= TOUR_STEP_COUNT - 1;
}

/** 次のステップへ進む (純粋: 末尾を超えない)。 */
export function nextStep(state: TourState): TourState {
  return { step: Math.min(state.step + 1, TOUR_STEP_COUNT - 1) };
}

/** 前のステップへ戻る (純粋: 先頭を下回らない)。 */
export function prevStep(state: TourState): TourState {
  return { step: Math.max(state.step - 1, 0) };
}

const DONE_STORAGE_KEY = "noobdb.onboarding.done";

/**
 * オンボーディングツアーが既に (スキップ/完了によって) 表示済みかどうか。
 * 破損した値や localStorage が使えない環境でも例外を投げず `false` を返す
 * (= 未表示扱い。安全側へのフォールバック)。
 */
export function beenShown(): boolean {
  try {
    return localStorage.getItem(DONE_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * ツアーを表示済みとして記録する。スキップ・完了のどちらから閉じても呼ぶことで
 * 以後は自動表示されなくなる。書き込み失敗 (quota / 無効環境) は無視する
 * (再表示されるだけで致命的ではないため)。
 */
export function markShown(): void {
  try {
    localStorage.setItem(DONE_STORAGE_KEY, "1");
  } catch {
    // ignore (quota / disabled storage)
  }
}
