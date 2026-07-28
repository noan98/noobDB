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

  // ドット式の視覚的プログレスインジケータ (#819)。テキストの「1 / 4」に加えて
  // ステップ数ぶんのドットが描画され、現在ステップだけが `data-active` で
  // 区別できることを固定する。
  describe("progress dots (#819)", () => {
    // `OnboardingTour` は `createPortal` で document.body 直下に描画されるため、
    // render() が返す `container` 配下には現れない。要素探索は role で拾った
    // グループ (実 DOM ノード) 自身を起点にする。
    it("renders one dot per step with only the current step marked active", () => {
      const { getByRole } = renderWithProviders(<OnboardingTour onClose={() => {}} />);
      const group = getByRole("group", {
        name: t("onboardingProgressAria", { current: 1, total: TOUR_STEP_COUNT }),
      });
      const dots = group.querySelectorAll("[aria-hidden]");
      expect(dots).toHaveLength(TOUR_STEP_COUNT);
      expect(group.querySelectorAll('[data-active="true"]')).toHaveLength(1);
      expect(dots[0].getAttribute("data-active")).toBe("true");
      for (let i = 1; i < dots.length; i++) {
        expect(dots[i].getAttribute("data-active")).toBeNull();
      }
    });

    it("moves the active dot forward when advancing to the next step", () => {
      const { getByRole } = renderWithProviders(<OnboardingTour onClose={() => {}} />);
      fireEvent.click(getByRole("button", { name: t("onboardingNext") }));

      const group = getByRole("group", {
        name: t("onboardingProgressAria", { current: 2, total: TOUR_STEP_COUNT }),
      });
      const dots = group.querySelectorAll('[data-active="true"]');
      expect(dots).toHaveLength(1);
      expect(Array.from(group.querySelectorAll("[aria-hidden]")).indexOf(dots[0])).toBe(1);
    });
  });
});
