import { describe, it, expect, vi } from "vitest";
import { fireEvent, renderWithProviders } from "./testUtils";
import { OnboardingTour } from "../components/OnboardingTour";
import { TOUR_STEP_COUNT } from "../onboarding";
import { t } from "../i18n";

/**
 * オンボーディングツアーの UI (#599)。ステップ送り (次へ/戻る)・スキップ・
 * Esc での終了を固定する。`onClose` を呼ぶだけで表示済みフラグの永続化は
 * 呼び出し側 (App.tsx の `handleCloseTour`) の責務なので、ここでは検証しない。
 * 文言はロケール非依存にするため `t(...)` 経由で参照する。
 */
describe("OnboardingTour (#599)", () => {
  it("starts on the first step with Back disabled and steps through to Done", () => {
    const onClose = vi.fn();
    const { getByRole, getByText } = renderWithProviders(<OnboardingTour onClose={onClose} />);

    expect(getByText(t("onboardingStepCounter", { current: 1, total: TOUR_STEP_COUNT }))).toBeTruthy();
    expect(getByRole("button", { name: t("onboardingBack") })).toBeDisabled();

    // 次へを末尾ステップまで押し切ると「完了」ボタンに変わる。
    for (let i = 1; i < TOUR_STEP_COUNT; i++) {
      fireEvent.click(getByRole("button", { name: t("onboardingNext") }));
    }

    expect(
      getByText(t("onboardingStepCounter", { current: TOUR_STEP_COUNT, total: TOUR_STEP_COUNT })),
    ).toBeTruthy();
    expect(getByRole("button", { name: t("onboardingFinish") })).toBeTruthy();

    fireEvent.click(getByRole("button", { name: t("onboardingFinish") }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("moves back a step with Back after advancing", () => {
    const { getByRole, getByText } = renderWithProviders(<OnboardingTour onClose={() => {}} />);
    fireEvent.click(getByRole("button", { name: t("onboardingNext") }));
    expect(getByText(t("onboardingStepCounter", { current: 2, total: TOUR_STEP_COUNT }))).toBeTruthy();
    fireEvent.click(getByRole("button", { name: t("onboardingBack") }));
    expect(getByText(t("onboardingStepCounter", { current: 1, total: TOUR_STEP_COUNT }))).toBeTruthy();
  });

  it("calls onClose when Skip is clicked", () => {
    const onClose = vi.fn();
    const { getByRole } = renderWithProviders(<OnboardingTour onClose={onClose} />);
    fireEvent.click(getByRole("button", { name: t("onboardingSkip") }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("calls onClose on Escape (focus trap)", () => {
    const onClose = vi.fn();
    const { getByRole } = renderWithProviders(<OnboardingTour onClose={onClose} />);
    fireEvent.keyDown(getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
