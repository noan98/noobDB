import { chakra, Flex } from "@chakra-ui/react";
import { useT } from "../i18n";
import type { DdlRunReport } from "./onlineDdlRunner";
import { stepComment } from "./onlineDdlRunner";
import { ErrorNote } from "./modalForm";
import { SqlPreview } from "./SqlPreview";
import { Button } from "./ui";
import { DdlStageTrack } from "./DdlStageTrack";
import { failedTrackState } from "./ddlStageTrack";
import type { DdlStep } from "./onlineDdl";

/**
 * 段階実行 / CONCURRENTLY が途中で失敗したときの案内 (#2240)。どこまで適用済みか、失敗した段階とエラー、
 * ロック待ちの上限を超えたときはプロセス一覧 (待機チェーン) への導線、INVALID なインデックスが残ったか、
 * 残りの SQL と後始末の SQL (エディタへ送れる) を出す。
 */
export function DdlRunReportNotice({
  report,
  driver,
  steps,
  onSendToEditor,
  onOpenProcessList,
}: {
  report: DdlRunReport;
  driver: string;
  /** 実行した計画の段階 (段階トラックの描画用)。省略時はトラックを出さない。 */
  steps?: readonly DdlStep[];
  onSendToEditor: (sql: string) => void;
  onOpenProcessList?: () => void;
}) {
  const t = useT();
  if (report.ok || !report.failedStep || report.failedIndex === null) return null;
  const staged = report.totalSteps > 1;
  const trackState = failedTrackState(report);
  const title = staged
    ? t("ddlReportTitle", {
        stage: report.failedIndex + 1,
        total: report.totalSteps,
        done: report.completedSteps,
      })
    : t("ddlReportTitleSingle");
  return (
    <>
      {steps && trackState && <DdlStageTrack steps={steps} state={trackState} />}
      <ErrorNote role="alert" title={title} data-testid="ddl-run-report">
        <chakra.div display="flex" flexDirection="column" gap="2">
          <chakra.span fontSize="sm">
            {t("ddlReportFailedStep")}{" "}
            <chakra.code fontFamily="mono">
              {stepComment(report.failedStep, report.failedIndex, report.totalSteps)}
            </chakra.code>
          </chakra.span>
          <chakra.span fontSize="sm" wordBreak="break-word">
            {t("ddlReportError", { error: report.error ?? "" })}
          </chakra.span>
          {staged && report.completedSteps > 0 && (
            <chakra.span fontSize="sm">{t("ddlReportAppliedNote")}</chakra.span>
          )}
          {report.lockTimeout && (
            <Flex align="center" gap="2" wrap="wrap">
              <chakra.span fontSize="sm">{t("ddlReportLockTimeout")}</chakra.span>
              {onOpenProcessList && (
                <Button type="button" variant="secondary" onClick={onOpenProcessList}>
                  {t("ddlReportOpenProcesses")}
                </Button>
              )}
            </Flex>
          )}
          {report.failedStep.invalidIndex && (
            <chakra.span fontSize="sm">
              {report.invalidIndexLeft === true
                ? t("ddlReportInvalidLeft")
                : report.invalidIndexLeft === false
                  ? t("ddlReportInvalidGone")
                  : t("ddlReportInvalidUnknown")}
            </chakra.span>
          )}
          {report.cleanupSql && (
            <>
              <chakra.span fontSize="sm">{t("ddlReportCleanup")}</chakra.span>
              <SqlPreview sql={report.cleanupSql} driver={driver} wrap maxH="20vh" />
              <Flex>
                <Button type="button" variant="secondary" onClick={() => onSendToEditor(report.cleanupSql)}>
                  {t("ddlReportCleanupToEditor")}
                </Button>
              </Flex>
            </>
          )}
          {staged && report.remainingSql && (
            <>
              <chakra.span fontSize="sm">{t("ddlReportRemaining")}</chakra.span>
              <SqlPreview sql={report.remainingSql} driver={driver} wrap maxH="20vh" />
              {/CONCURRENTLY/i.test(report.remainingSql) && (
                <chakra.span fontSize="sm">{t("ddlReportConcurrentlyNote")}</chakra.span>
              )}
              <Flex>
                <Button type="button" variant="secondary" onClick={() => onSendToEditor(report.remainingSql)}>
                  {t("ddlReportRemainingToEditor")}
                </Button>
              </Flex>
            </>
          )}
        </chakra.div>
      </ErrorNote>
    </>
  );
}
