import { Box, chakra } from "@chakra-ui/react";

import { SEQUENTIAL_RAMPS, rampStops, sampleRamp } from "../colorScale";
import { useT } from "../i18n";
import { semanticColorVar } from "../semanticColors";
import { PLAN_NODE_CATEGORIES, type PlanNodeCategory } from "./explainPlan";
import { ICON_SIZES, ICON_STROKE, Icon, type IconName } from "./Icon";

/**
 * EXPLAIN グラフの凡例 (#2017)。ノード背景のコストヒート (低→高) の勾配バーと、注意ノードの
 * `!` マーカー、ノード頭のアイコンの意味を示す。色はグラフのノードと同じ blue ランプから
 * 引く (`colorScale.ts`、二重定義しない)。勾配バーはマウント時に左→右へ満ちる
 * (App.css の `.explain-legend-fill`、reduced-motion は全体規則で即時)。
 */

/** 分類 → アイコン。`Icon.tsx` の既存セットから選ぶ (ノード頭と凡例で同じ表を使う)。 */
export const PLAN_CATEGORY_ICON: Record<PlanNodeCategory, IconName> = {
  scan: "table",
  index: "key",
  join: "link",
  sort: "sort",
  aggregate: "pivot",
  other: "explain",
};

export const PLAN_CATEGORY_LABEL_KEY = {
  scan: "explainLegendCategoryScan",
  index: "explainLegendCategoryIndex",
  join: "explainLegendCategoryJoin",
  sort: "explainLegendCategorySort",
  aggregate: "explainLegendCategoryAggregate",
} as const;

/** ヒート 0–1 を blue ランプで等間隔に 5 点サンプリングした左→右の勾配。 */
export function costHeatGradient(isDark: boolean): string {
  const stops = rampStops(SEQUENTIAL_RAMPS.blue, isDark);
  const steps = 4;
  const parts = Array.from(
    { length: steps + 1 },
    (_, i) => `${sampleRamp(i / steps, stops)} ${(i / steps) * 100}%`,
  );
  return `linear-gradient(90deg, ${parts.join(", ")})`;
}

export function ExplainGraphLegend({ isDark }: { isDark: boolean }) {
  const t = useT();
  return (
    <Box
      data-testid="explain-legend"
      display="flex"
      flexDirection="column"
      gap="var(--space-1-5)"
      padding="var(--space-2) var(--space-2-5)"
      background="var(--bg-elevated)"
      border="1px solid var(--border)"
      borderRadius="var(--radius-md)"
      boxShadow="var(--elevation-raised)"
      color="var(--text-muted)"
      fontSize="var(--text-2xs)"
    >
      <Box display="flex" alignItems="center" gap="var(--space-1-5)">
        <span>{t("explainLegendCostLow")}</span>
        <Box
          className="explain-legend-fill"
          role="img"
          aria-label={t("explainLegendCostAria")}
          w="calc(72 * var(--space-1))"
          h="var(--space-2)"
          borderRadius="var(--radius-sm)"
          border="1px solid var(--border)"
          background={costHeatGradient(isDark)}
        />
        <span>{t("explainLegendCostHigh")}</span>
      </Box>
      <Box display="flex" alignItems="center" gap="var(--space-1-5)">
        <chakra.span
          fontWeight={700}
          px="1"
          borderRadius="var(--radius-sm)"
          background={semanticColorVar("warning", "solid")}
          color="app.onSolid"
          aria-hidden="true"
        >
          !
        </chakra.span>
        <span>{t("explainLegendAttention")}</span>
      </Box>
      <Box display="flex" flexWrap="wrap" columnGap="var(--space-2-5)" rowGap="var(--space-1)">
        {PLAN_NODE_CATEGORIES.map((c) => (
          <Box key={c} display="inline-flex" alignItems="center" gap="var(--space-1)">
            <Icon name={PLAN_CATEGORY_ICON[c]} size={ICON_SIZES.sm} strokeWidth={ICON_STROKE.regular} />
            <span>{t(PLAN_CATEGORY_LABEL_KEY[c])}</span>
          </Box>
        ))}
      </Box>
    </Box>
  );
}
