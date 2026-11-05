import { describe, expect, it } from "vitest";
import { renderWithProviders } from "./testUtils";
import { ExplainGraphLegend, PLAN_CATEGORY_ICON, costHeatGradient } from "../components/ExplainGraphLegend";
import { PLAN_NODE_CATEGORIES } from "../components/explainPlan";

describe("ExplainGraphLegend (#2017)", () => {
  it("コストヒートの勾配バー・注意マーカー・種別アイコンを説明する", () => {
    const { getByTestId, getByRole } = renderWithProviders(<ExplainGraphLegend isDark={false} />);
    const legend = getByTestId("explain-legend");
    expect(legend.textContent).toContain("!");
    expect(getByRole("img").className).toContain("explain-legend-fill");
    // 凡例の種別数ぶんアイコンが並ぶ
    expect(legend.querySelectorAll("svg")).toHaveLength(PLAN_NODE_CATEGORIES.length);
  });

  it("勾配はライト / ダークでランプの向きが変わる", () => {
    expect(costHeatGradient(false)).toMatch(/^linear-gradient\(90deg, /);
    expect(costHeatGradient(false)).not.toBe(costHeatGradient(true));
  });

  it("全分類にアイコンがある", () => {
    for (const c of [...PLAN_NODE_CATEGORIES, "other" as const]) expect(PLAN_CATEGORY_ICON[c]).toBeTruthy();
  });
});
