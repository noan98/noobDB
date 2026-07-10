import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  beenShown,
  INITIAL_TOUR_STATE,
  isFirstStep,
  isLastStep,
  markShown,
  nextStep,
  prevStep,
  TOUR_STEP_COUNT,
} from "../onboarding";

// 初回起動オンボーディングツアー (#599) の純ロジック。ステップ遷移 (境界での
// クランプ) と、表示済みフラグの localStorage 永続化 (壊れた/欠損値への耐性)
// を固定する。`storageResilience.test.ts` と同じ「例外を投げず安全な既定へ
// フォールバックする」方針を検証する。

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe("ステップ遷移 (nextStep / prevStep)", () => {
  it("初期状態は先頭ステップ", () => {
    expect(INITIAL_TOUR_STATE.step).toBe(0);
    expect(isFirstStep(INITIAL_TOUR_STATE)).toBe(true);
    expect(isLastStep(INITIAL_TOUR_STATE)).toBe(false);
  });

  it("nextStep で 1 つ進む", () => {
    const s1 = nextStep(INITIAL_TOUR_STATE);
    expect(s1.step).toBe(1);
    expect(isFirstStep(s1)).toBe(false);
  });

  it("nextStep は末尾ステップを超えない (クランプ)", () => {
    let s = INITIAL_TOUR_STATE;
    for (let i = 0; i < TOUR_STEP_COUNT + 5; i++) s = nextStep(s);
    expect(s.step).toBe(TOUR_STEP_COUNT - 1);
    expect(isLastStep(s)).toBe(true);
  });

  it("prevStep は先頭ステップを下回らない (クランプ)", () => {
    const s = prevStep(INITIAL_TOUR_STATE);
    expect(s.step).toBe(0);
    expect(isFirstStep(s)).toBe(true);
  });

  it("末尾まで進んでから 1 つ戻ると末尾の 1 つ手前になる", () => {
    let s = INITIAL_TOUR_STATE;
    for (let i = 0; i < TOUR_STEP_COUNT + 5; i++) s = nextStep(s);
    s = prevStep(s);
    expect(s.step).toBe(TOUR_STEP_COUNT - 2);
  });
});

describe("表示済みフラグの永続化 (beenShown / markShown)", () => {
  it("既定 (未設定) では未表示扱い", () => {
    expect(beenShown()).toBe(false);
  });

  it("markShown 後は表示済みになる", () => {
    markShown();
    expect(beenShown()).toBe(true);
  });

  it("壊れた値が入っていても例外を投げず未表示扱いにする", () => {
    localStorage.setItem("noobdb.onboarding.done", "not-a-valid-flag");
    expect(() => beenShown()).not.toThrow();
    expect(beenShown()).toBe(false);
  });

  it("localStorage が使えない環境でも例外を投げない", () => {
    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = () => {
      throw new Error("disabled");
    };
    try {
      expect(() => beenShown()).not.toThrow();
      expect(beenShown()).toBe(false);
    } finally {
      Storage.prototype.getItem = original;
    }
  });

  it("localStorage への書き込み失敗も無視する (markShown は例外を投げない)", () => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error("quota exceeded");
    };
    try {
      expect(() => markShown()).not.toThrow();
    } finally {
      Storage.prototype.setItem = original;
    }
  });
});
