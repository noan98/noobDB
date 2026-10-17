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

describe("OnboardingTour の初期フォーカス (#1529)", () => {
  it("開いた直後のフォーカスは × ではなく「次へ」(Enter で閉じてしまわない)", () => {
    const { getByRole } = renderWithProviders(<OnboardingTour onClose={() => {}} />);
    expect(document.activeElement).toBe(getByRole("button", { name: t("onboardingNext") }));
  });
});

describe("OnboardingTour のコーチマーク (#1504)", () => {
  /** jsdom はレイアウトを持たないので、測定結果を差し込んだアンカー要素を置く。 */
  function mountAnchor(
    selectorAttr: [string, string],
    r: { left: number; top: number; width: number; height: number },
  ) {
    const el = document.createElement("div");
    el.setAttribute(selectorAttr[0], selectorAttr[1]);
    el.getBoundingClientRect = () =>
      ({
        ...r,
        right: r.left + r.width,
        bottom: r.top + r.height,
        x: r.left,
        y: r.top,
        toJSON: () => ({}),
      }) as DOMRect;
    document.body.appendChild(el);
    return el;
  }

  it("アンカーが無いときは従来の右下カード (スポットライト無し) にフォールバックする", () => {
    const { getByRole, queryByTestId } = renderWithProviders(<OnboardingTour onClose={() => {}} />);
    expect(queryByTestId("onboarding-spotlight")).toBeNull();
    expect(getByRole("dialog").getAttribute("data-anchored")).toBeNull();
  });

  it("アンカーがあるステップではスポットライトを出し、無いステップでは消える", () => {
    // ステップ 1 (接続) はサイドバーのタブ列、ステップ 2 (クエリ) の候補は置かない。
    const el = mountAnchor(["data-tour", "sidebar-tabs"], { left: 10, top: 40, width: 200, height: 30 });
    try {
      const { getByRole, getByTestId, queryByTestId } = renderWithProviders(
        <OnboardingTour onClose={() => {}} />,
      );
      const spot = getByTestId("onboarding-spotlight");
      expect(spot).toBeTruthy();
      // 4px の余白ぶん広がる。
      expect(spot.style.left).toBe("6px");
      expect(spot.style.width).toBe("208px");
      fireEvent.click(getByRole("button", { name: t("onboardingNext") }));
      expect(queryByTestId("onboarding-spotlight")).toBeNull();
    } finally {
      el.remove();
    }
  });

  it("アンカーが画面外・サイズ 0 のときもフォールバックする", () => {
    const el = mountAnchor(["data-tour", "sidebar-tabs"], { left: 10, top: 5000, width: 200, height: 30 });
    try {
      const { queryByTestId } = renderWithProviders(<OnboardingTour onClose={() => {}} />);
      expect(queryByTestId("onboarding-spotlight")).toBeNull();
    } finally {
      el.remove();
    }
  });

  it("フォーカスがカード外にあっても Esc で閉じ、二重には呼ばない", () => {
    const onClose = vi.fn();
    renderWithProviders(<OnboardingTour onClose={onClose} />);
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("カード内の Esc は 1 回だけ onClose を呼ぶ", () => {
    const onClose = vi.fn();
    const { getByRole } = renderWithProviders(<OnboardingTour onClose={onClose} />);
    fireEvent.keyDown(getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
