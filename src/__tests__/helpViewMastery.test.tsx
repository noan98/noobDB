import { beforeEach, describe, expect, it, vi } from "vitest";
import { MotionConfig } from "motion/react";
import { renderWithProviders, screen, fireEvent, within, waitFor } from "./testUtils";
import { HelpView } from "../components/HelpView";
import { MasteryRing, masteryFraction } from "../components/MasteryRing";
import { MASTERY_GROUPS } from "../mastery";
import { getSettings, markFeatureTried, resetMasteryProgress, setMasteryTrackingEnabled } from "../settings";
import { t, type I18nKey } from "../i18n";

function navItem(title: string) {
  const nav = screen.getByRole("navigation", { name: t("helpTitle") });
  return within(nav).getByRole("button", {
    name: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
  });
}

beforeEach(() => {
  setMasteryTrackingEnabled(true);
  resetMasteryProgress();
});

describe("習熟マップの記録 (#2216)", () => {
  it("markFeatureTried は記録し、未知 ID・オフでは何もしない。リセットで消える", () => {
    markFeatureTried("helpRunTitle");
    markFeatureTried("helpRunTitle");
    markFeatureTried("bogus");
    expect(getSettings().masteryTried).toEqual(["helpRunTitle"]);
    setMasteryTrackingEnabled(false);
    markFeatureTried("helpExplainTitle");
    expect(getSettings().masteryTried).toEqual(["helpRunTitle"]);
    resetMasteryProgress();
    expect(getSettings().masteryTried).toEqual([]);
  });
});

describe("HelpView の習熟マップ (#2216)", () => {
  it.each(MASTERY_GROUPS.map((g) => [g.id, g.features] as const))(
    "%s の全項目に『試す』ボタンか「試せない理由」のどちらかがある",
    async (_group, features) => {
      // 30 回の切り替えを待てるよう、アニメーションを無効にして描画する。
      renderWithProviders(
        <MotionConfig reducedMotion="always">
          <HelpView onClose={() => {}} onOpenFeature={vi.fn()} />
        </MotionConfig>,
      );
      for (const id of features) {
        fireEvent.click(navItem(t(id as I18nKey)));
        await waitFor(() =>
          expect(
            within(screen.getByTestId("help-detail")).getByRole("heading", { level: 3 }),
          ).toHaveTextContent(t(id as I18nKey)),
        );
        const detail = screen.getByTestId("help-detail");
        const hasTry = within(detail).queryByTestId("help-try") !== null;
        const hasReason = within(detail).queryByText(t("helpNoTryTitle")) !== null;
        expect(hasTry || hasReason, id).toBe(true);
      }
    },
  );

  it("試した項目に印が付き、グループと全体の進捗が増える", () => {
    markFeatureTried("helpRunTitle");
    markFeatureTried("helpExplainTitle");
    renderWithProviders(<HelpView onClose={() => {}} />);
    expect(within(navItem(t("helpRunTitle"))).getByTestId("mastery-tried-mark")).toBeInTheDocument();
    expect(within(navItem(t("helpDryRunTitle"))).queryByTestId("mastery-tried-mark")).toBeNull();
    expect(screen.getByTestId("mastery-overall")).toHaveTextContent(
      t("helpMasteryOverall", { done: "2", total: "30" }),
    );
    const rings = screen.getAllByTestId("mastery-ring");
    expect(
      rings.some((r) => r.getAttribute("data-done") === "2" && r.getAttribute("data-total") === "8"),
    ).toBe(true);
  });

  it("詳細に次のおすすめが出て、押すとその項目へ移る", async () => {
    renderWithProviders(<HelpView onClose={() => {}} />);
    const rec = screen.getByTestId("help-next-recommend");
    fireEvent.click(within(rec).getByRole("button", { name: t("helpDryRunTitle") }));
    await waitFor(() =>
      expect(within(screen.getByTestId("help-detail")).getByRole("heading", { level: 3 })).toHaveTextContent(
        t("helpDryRunTitle"),
      ),
    );
  });

  it("記録がオフなら印・リング・おすすめを出さない", () => {
    markFeatureTried("helpRunTitle");
    setMasteryTrackingEnabled(false);
    renderWithProviders(<HelpView onClose={() => {}} />);
    expect(screen.queryByTestId("mastery-overall")).toBeNull();
    expect(screen.queryByTestId("mastery-tried-mark")).toBeNull();
    expect(screen.queryByTestId("help-next-recommend")).toBeNull();
  });

  it("markOnOpen の項目は『試す』で記録される", async () => {
    renderWithProviders(<HelpView onClose={() => {}} onOpenFeature={vi.fn()} />);
    fireEvent.click(navItem(t("helpHistoryTitle")));
    await waitFor(() =>
      expect(within(screen.getByTestId("help-detail")).getByRole("heading", { level: 3 })).toHaveTextContent(
        t("helpHistoryTitle"),
      ),
    );
    fireEvent.click(screen.getByTestId("help-try"));
    expect(getSettings().masteryTried).toContain("helpHistoryTitle");
  });

  it("比較・タスクは openFullView 側で記録するので、ヘルプの『試す』だけでは記録しない", async () => {
    renderWithProviders(<HelpView onClose={() => {}} onOpenFeature={vi.fn()} />);
    fireEvent.click(navItem(t("helpSchemaCompareTitle")));
    await waitFor(() =>
      expect(within(screen.getByTestId("help-detail")).getByRole("heading", { level: 3 })).toHaveTextContent(
        t("helpSchemaCompareTitle"),
      ),
    );
    fireEvent.click(screen.getByTestId("help-try"));
    expect(getSettings().masteryTried).not.toContain("helpSchemaCompareTitle");
  });

  it("7 グループすべてに進捗リングが出て、グループの aria-label に進捗が入る。全体進捗は aria-live にしない", () => {
    markFeatureTried("helpRunTitle");
    renderWithProviders(<HelpView onClose={() => {}} />);
    expect(screen.getAllByTestId("mastery-ring").length).toBe(MASTERY_GROUPS.length + 1);
    const nav = screen.getByRole("navigation", { name: t("helpTitle") });
    const groups = within(nav).getAllByRole("group");
    expect(groups).toHaveLength(MASTERY_GROUPS.length);
    expect(groups[0]).toHaveAttribute(
      "aria-label",
      expect.stringContaining(t("helpMasteryGroupProgress", { done: "1", total: "8" })),
    );
    expect(screen.getByTestId("mastery-overall").querySelector("[aria-live]")).toBeNull();
  });
});

describe("MasteryRing (#2216)", () => {
  it("割合は 0〜1 に収まる", () => {
    expect(masteryFraction(0, 0)).toBe(0);
    expect(masteryFraction(3, 8)).toBeCloseTo(0.375);
    expect(masteryFraction(9, 8)).toBe(1);
  });

  it("reduced-motion では静止する (data-static)", () => {
    renderWithProviders(
      <MotionConfig reducedMotion="always">
        <MasteryRing done={2} total={8} />
      </MotionConfig>,
    );
    expect(screen.getByTestId("mastery-ring")).toHaveAttribute("data-static", "true");
  });
});
