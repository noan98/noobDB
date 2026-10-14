import { useMemo } from "react";
import { Box, chakra, Flex } from "@chakra-ui/react";
import type { QueryResult } from "../api/tauri";
import { useT, type I18nKey } from "../i18n";
import { formatDurationMs, formatNumber } from "./explainPlan";
import { Callout } from "./Callout";
import { ExplainViewer, scoreBandLabelKey } from "./ExplainViewer";
import { Icon, ICON_SIZES } from "./Icon";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import {
  comparePlanSummaries,
  PLAN_CHANGE_I18N_KEY,
  summarizePlanResult,
  type PlanComparisonView,
  type PlanSummary,
} from "./planCompare";
import { Button } from "./ui";

/**
 * EXPLAIN タブで固定した計画 (before) と今の計画 (after) の比較 (#1539)。
 *
 * 置き場は Modal: 「固定 → SQL / インデックスを変更 → EXPLAIN をやり直す」の作業そのものは
 * 通常の EXPLAIN タブで行い、ここは結果を見比べて閉じるだけの閲覧画面のため
 * (`.claude/rules/ui-design-system.md` §7.1)。上段に要約表と差分、下段に 2 つの計画を並置する。
 * 比較は純ロジック (`planCompare.ts`) が行い、ここは描画に徹する。
 */

interface Props {
  driver: string;
  before: QueryResult;
  after: QueryResult;
  /** 固定した時刻の表示用文字列。 */
  beforeLabel: string;
  /** 各計画が実測 (EXPLAIN ANALYZE) で取得されたか。食い違うときは注意を出す。 */
  beforeAnalyze?: boolean;
  afterAnalyze?: boolean;
  onClose: () => void;
}

/** 差分の符号付き表記。0 は "±0"。 */
function signed(n: number, format: (v: number) => string = String): string {
  if (n === 0) return "±0";
  return `${n > 0 ? "+" : "−"}${format(Math.abs(n))}`;
}

function Metric({
  label,
  before,
  after,
  delta,
  lowerIsBetter = true,
  neutral = false,
}: {
  label: string;
  before: string;
  after: string;
  delta: { text: string; sign: number } | null;
  lowerIsBetter?: boolean;
  /** 増減に良し悪しが無い指標 (ノード数など)。色を付けない。 */
  neutral?: boolean;
}) {
  const good = neutral ? null : delta && delta.sign !== 0 ? delta.sign < 0 === lowerIsBetter : null;
  return (
    <chakra.tr>
      <chakra.th scope="row" textAlign="left" fontWeight={500} color="app.textSecondary" px="2.5" py="1">
        {label}
      </chakra.th>
      <chakra.td textAlign="right" textStyle="numeric" px="2.5" py="1">
        {before}
      </chakra.td>
      <chakra.td textAlign="right" textStyle="numeric" px="2.5" py="1">
        {after}
      </chakra.td>
      <chakra.td
        textAlign="right"
        textStyle="numeric"
        px="2.5"
        py="1"
        color={good === null ? "app.textMuted" : good ? "app.textSuccess" : "app.textError"}
      >
        {delta ? delta.text : "—"}
      </chakra.td>
    </chakra.tr>
  );
}

const VERDICT_KEY: Record<PlanComparisonView["verdict"], I18nKey> = {
  improved: "planCompareVerdictImproved",
  regressed: "planCompareVerdictRegressed",
  same: "planCompareVerdictSame",
};

export function PlanCompareModal({
  driver,
  before,
  after,
  beforeLabel,
  beforeAnalyze,
  afterAnalyze,
  onClose,
}: Props) {
  const t = useT();
  const view = useMemo<{ cmp: PlanComparisonView; b: PlanSummary; a: PlanSummary } | null>(() => {
    const b = summarizePlanResult(driver, before, t);
    const a = summarizePlanResult(driver, after, t);
    if (!b || !a) return null;
    return { cmp: comparePlanSummaries(b, a), b, a };
  }, [driver, before, after, t]);

  const num = (v: number | null) => (v === null ? "—" : formatNumber(v));

  return (
    <Modal
      // no-submit: 2 つの計画を見比べるだけの閲覧画面で、確定する主アクションが無い
      onClose={onClose}
      width="min(1400px, 96vw)"
    >
      <ModalHeader onClose={onClose} closeLabel={t("planCompareClose")}>
        {t("planCompareTitle")}
      </ModalHeader>
      <ModalBody display="flex" flexDirection="column" gap="3" minHeight="60vh">
        {view === null ? (
          <Callout tone="warning">{t("planCompareUnparsable")}</Callout>
        ) : (
          <>
            <Callout
              tone={
                view.cmp.verdict === "improved"
                  ? "success"
                  : view.cmp.verdict === "regressed"
                    ? "warning"
                    : "info"
              }
            >
              {t(VERDICT_KEY[view.cmp.verdict], {
                before: view.b.score.score,
                after: view.a.score.score,
              })}
            </Callout>

            {beforeAnalyze !== undefined && afterAnalyze !== undefined && beforeAnalyze !== afterAnalyze && (
              <Callout tone="warning">{t("planCompareAnalyzeMismatch")}</Callout>
            )}

            <Flex gap="4" align="flex-start" flexWrap="wrap">
              <chakra.table
                fontSize="sm"
                style={{ borderCollapse: "collapse" }}
                aria-label={t("planCompareSummaryAria")}
              >
                <thead>
                  <chakra.tr borderBottom="1px solid" borderColor="app.border">
                    <chakra.th px="2.5" py="1" />
                    <chakra.th textStyle="overline" textAlign="right" px="2.5" py="1">
                      {t("planCompareColBefore")}
                    </chakra.th>
                    <chakra.th textStyle="overline" textAlign="right" px="2.5" py="1">
                      {t("planCompareColAfter")}
                    </chakra.th>
                    <chakra.th textStyle="overline" textAlign="right" px="2.5" py="1">
                      {t("planCompareColDelta")}
                    </chakra.th>
                  </chakra.tr>
                </thead>
                <tbody>
                  <Metric
                    label={t("explainScoreLabel")}
                    before={`${view.b.score.score} ${t(scoreBandLabelKey(view.b.score.band))}`}
                    after={`${view.a.score.score} ${t(scoreBandLabelKey(view.a.score.band))}`}
                    delta={{ text: signed(view.cmp.scoreDelta), sign: view.cmp.scoreDelta }}
                  />
                  <Metric
                    label={t("planCompareMetricCost")}
                    before={num(view.b.totalCost)}
                    after={num(view.a.totalCost)}
                    delta={
                      view.cmp.costDelta === null
                        ? null
                        : {
                            text:
                              signed(view.cmp.costDelta, formatNumber) +
                              (view.cmp.costRatio !== null ? ` (×${view.cmp.costRatio.toFixed(2)})` : ""),
                            sign: view.cmp.costDelta,
                          }
                    }
                  />
                  {view.cmp.actualMsDelta !== null && (
                    <Metric
                      label={t("planCompareMetricActual")}
                      before={formatDurationMs(view.b.actualMs ?? 0)}
                      after={formatDurationMs(view.a.actualMs ?? 0)}
                      delta={{
                        text: signed(view.cmp.actualMsDelta, formatDurationMs),
                        sign: view.cmp.actualMsDelta,
                      }}
                    />
                  )}
                  <Metric
                    label={t("planCompareMetricWarnings")}
                    before={String(view.b.hints.warning)}
                    after={String(view.a.hints.warning)}
                    delta={{ text: signed(view.cmp.warningDelta), sign: view.cmp.warningDelta }}
                  />
                  <Metric
                    label={t("planCompareMetricCautions")}
                    before={String(view.b.hints.caution)}
                    after={String(view.a.hints.caution)}
                    delta={{ text: signed(view.cmp.cautionDelta), sign: view.cmp.cautionDelta }}
                  />
                  <Metric
                    label={t("planCompareMetricNodes")}
                    before={String(view.b.nodeCount)}
                    after={String(view.a.nodeCount)}
                    delta={{
                      text: signed(view.a.nodeCount - view.b.nodeCount),
                      sign: view.a.nodeCount - view.b.nodeCount,
                    }}
                    neutral
                  />
                </tbody>
              </chakra.table>

              <Box
                flex="1"
                minWidth="280px"
                border="1px solid"
                borderColor="app.border"
                borderRadius="md"
                px="3"
                py="2"
                maxHeight="160px"
                overflowY="auto"
              >
                {view.cmp.changes.length === 0 ? (
                  <chakra.p m={0} fontSize="sm" color="app.textMuted">
                    {t("planWatchNoChanges")}
                  </chakra.p>
                ) : (
                  <chakra.ul m={0} p={0} listStyleType="none" display="flex" flexDirection="column" gap="1">
                    {view.cmp.changes.map((c, i) => (
                      <chakra.li
                        key={`${c.path}-${c.kind}-${i}`}
                        fontSize="sm"
                        display="flex"
                        alignItems="center"
                        gap="1.5"
                        color={c.severity === "warning" ? "app.textError" : "app.text"}
                      >
                        {c.severity === "warning" && <Icon name="warning" size={ICON_SIZES.sm} />}
                        {t(PLAN_CHANGE_I18N_KEY[c.kind], {
                          object: c.object,
                          before: c.before ?? "—",
                          after: c.after ?? "—",
                        })}
                      </chakra.li>
                    ))}
                  </chakra.ul>
                )}
              </Box>
            </Flex>

            <Flex flex="1" minHeight="320px" gap="2.5">
              {[
                { result: before, label: t("planCompareBeforePane", { at: beforeLabel }) },
                { result: after, label: t("planCompareAfterPane") },
              ].map((pane) => (
                <Flex
                  key={pane.label}
                  flex="1"
                  minWidth={0}
                  direction="column"
                  border="1px solid"
                  borderColor="app.border"
                  borderRadius="md"
                  overflow="hidden"
                >
                  <Flex
                    px="2.5"
                    py="1.5"
                    fontSize="xs"
                    color="app.textSecondary"
                    bg="app.toolbar"
                    borderBottom="1px solid"
                    borderBottomColor="app.borderSubtle"
                  >
                    <chakra.span textStyle="subheading" fontSize="xs">
                      {pane.label}
                    </chakra.span>
                  </Flex>
                  <Flex flex="1" minHeight={0} direction="column">
                    <ExplainViewer result={pane.result} driver={driver} />
                  </Flex>
                </Flex>
              ))}
            </Flex>
          </>
        )}
      </ModalBody>
      <ModalFooter>
        <Box flex="1" />
        <Button variant="primary" onClick={onClose}>
          {t("planCompareClose")}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
