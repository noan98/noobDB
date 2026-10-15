import { Box } from "@chakra-ui/react";

import { useT } from "../i18n";
import type { RefreshSample } from "../refreshPatch";
import { semanticColorVar } from "../semanticColors";
import { Tooltip } from "./Tooltip";

/** 棒の高さの割合 (%)。最大の合計を 100% として、各区間を積み上げる。 */
export function trendSegmentPercents(
  sample: RefreshSample,
  maxTotal: number,
): { added: number; changed: number; removed: number } {
  if (maxTotal <= 0) return { added: 0, changed: 0, removed: 0 };
  const pct = (n: number) => (n / maxTotal) * 100;
  return { added: pct(sample.added), changed: pct(sample.changed), removed: pct(sample.removed) };
}

/**
 * 自動リフレッシュの増減推移 (#1621): 直近数回ぶんの追加 (緑)・変更 (黄)・削除 (赤) の
 * 件数を、1 回 1 本の小さな積み上げ棒で示す。変化が無かった回は空の棒 (細い土台だけ)。
 * 正確な件数は棒ごとのツールチップと、全体の `aria-label` (最新の回) で読める。
 */
export function RefreshTrend({ samples }: { samples: readonly RefreshSample[] }) {
  const t = useT();
  const maxTotal = Math.max(0, ...samples.map((s) => s.added + s.changed + s.removed));
  const latest = samples[samples.length - 1];
  return (
    <Box
      role="img"
      aria-label={t("refreshTrendAria", {
        count: samples.length,
        added: latest.added,
        changed: latest.changed,
        removed: latest.removed,
      })}
      data-testid="refresh-trend"
      display="inline-flex"
      alignItems="flex-end"
      gap="0.5"
      height="4"
    >
      {samples.map((s) => {
        const seg = trendSegmentPercents(s, maxTotal);
        const label = t("refreshTrendBar", {
          time: new Date(s.at).toLocaleTimeString(),
          added: s.added,
          changed: s.changed,
          removed: s.removed,
        });
        return (
          <Tooltip key={s.at} label={label}>
            <Box
              data-testid="refresh-trend-bar"
              display="flex"
              flexDirection="column-reverse"
              width="1.5"
              height="100%"
              borderBottom="1px solid"
              borderColor="app.border"
            >
              <Box style={{ height: `${seg.added}%`, background: semanticColorVar("success", "solid") }} />
              <Box style={{ height: `${seg.changed}%`, background: semanticColorVar("warning", "solid") }} />
              <Box style={{ height: `${seg.removed}%`, background: semanticColorVar("danger", "solid") }} />
            </Box>
          </Tooltip>
        );
      })}
    </Box>
  );
}
