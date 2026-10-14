// 設定画面 AI セクションの「使用量の履歴と概算コスト」(#1540)。Rust の使用量台帳
// (`get_ai_usage_history`: 日 JST × タスク × モデルのトークン数のみ) を読み、期間で絞って
// モデル別 / タスク別 / 日別に集計し、`aiModels.ts` の単価表で概算コストを出す。
import { useCallback, useEffect, useMemo, useState } from "react";
import { chakra, Flex } from "@chakra-ui/react";
import { api, type AiUsageRecord } from "../api/tauri";
import { formatTokens, modelLabel } from "../ai/aiUsage";
import {
  buildUsageReport,
  formatUsd,
  monthStartKey,
  sinceDayKey,
  type UsageAggregate,
} from "../ai/aiUsageCost";
import { useT } from "../i18n";
import { cacheUsageSuffix } from "./AiUsageNote";
import { useConfirm } from "./ConfirmDialog";
import { ErrorNote, FieldLabel, FormSection } from "./modalForm";
import { SettingsInfo } from "./settingsLayout";
import { useToast } from "./Toast";
import { Button, Select } from "./ui";

type Range = "month" | "7" | "30" | "all";

/** 日別の表を畳んだときに見せる日数 (最新から)。残りは「さらに N 日を表示」で開く。 */
const DAY_ROWS_COLLAPSED = 7;

interface Props {
  /** タスク種別 ID の表示名 (未知の ID はそのまま返す)。 */
  taskLabel: (task: string) => string;
  /** この値が変わったら読み直す (接続テスト / サンプル実行の完了など)。 */
  reloadKey?: string;
}

export function AiUsageHistory({ taskLabel, reloadKey }: Props) {
  const t = useT();
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const [records, setRecords] = useState<AiUsageRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<Range>("month");
  const [allDays, setAllDays] = useState(false);

  const load = useCallback(() => {
    api
      .getAiUsageHistory()
      .then((r) => {
        setRecords(r);
        setError(null);
      })
      .catch((e) => setError(t("aiLedgerLoadFailed", { error: String(e) })));
  }, [t]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey は再読み込みの合図
  useEffect(() => {
    load();
  }, [load, reloadKey]);

  const report = useMemo(
    () => {
      const now = new Date();
      const since =
        range === "all" ? undefined : range === "month" ? monthStartKey(now) : sinceDayKey(now, Number(range));
      return buildUsageReport(records, since);
    },
    [records, range],
  );
  const { total } = report;
  const cache = cacheUsageSuffix(
    t,
    total.cacheCreationInputTokens > 0 ? formatTokens(total.cacheCreationInputTokens) : null,
    total.cacheReadInputTokens > 0 ? formatTokens(total.cacheReadInputTokens) : null,
  );

  const row = (name: string, a: UsageAggregate) => (
    <chakra.span key={a.key} fontSize="sm" color="app.text">
      {t("aiLedgerRow", {
        name,
        calls: a.calls,
        input: formatTokens(a.inputTokens),
        output: formatTokens(a.outputTokens),
        cost: formatUsd(a.costUsd),
      })}
    </chakra.span>
  );

  const clear = () => {
    void confirm({
      title: t("aiLedgerClearConfirmTitle"),
      message: t("aiLedgerClearConfirmBody"),
      confirmLabel: t("aiLedgerClear"),
      tone: "warning",
    }).then(async (ok) => {
      if (!ok) return;
      try {
        await api.clearAiUsageHistory();
        setRecords([]);
        toast.success(t("aiLedgerCleared"));
      } catch (e) {
        setError(t("aiLedgerLoadFailed", { error: String(e) }));
      }
    });
  };

  return (
    <FormSection data-testid="ai-usage-ledger">
      <Flex align="center" gap="2" wrap="wrap">
        <FieldLabel as="div">{t("aiLedgerTitle")}</FieldLabel>
        <SettingsInfo>{t("aiLedgerHelp")}</SettingsInfo>
        <Select
          aria-label={t("aiLedgerRange")}
          width="auto"
          value={range}
          onChange={(e) => setRange(e.target.value as Range)}
        >
          <option value="month">{t("aiLedgerRangeMonth")}</option>
          <option value="7">{t("aiLedgerRange7")}</option>
          <option value="30">{t("aiLedgerRange30")}</option>
          <option value="all">{t("aiLedgerRangeAll")}</option>
        </Select>
        <Button type="button" variant="secondary" size="sm" onClick={load}>
          {t("aiLedgerRefresh")}
        </Button>
        <Button
          type="button"
          variant="dangerOutline"
          size="sm"
          disabled={records.length === 0}
          onClick={clear}
        >
          {t("aiLedgerClear")}
        </Button>
      </Flex>
      {error && <ErrorNote role="alert">{error}</ErrorNote>}
      {total.calls === 0 ? (
        <chakra.span fontSize="sm" color="app.textMuted">
          {t("aiLedgerEmpty")}
        </chakra.span>
      ) : (
        <>
          <chakra.span fontSize="sm" fontWeight={500} color="app.text">
            {t("aiLedgerTotal", {
              calls: total.calls,
              input: formatTokens(total.inputTokens),
              output: formatTokens(total.outputTokens),
              cache,
              cost: formatUsd(total.costUsd),
            })}
          </chakra.span>
          {total.unpricedCalls > 0 && (
            <chakra.span textStyle="caption">
              {t("aiLedgerUnpriced", { count: total.unpricedCalls })}
            </chakra.span>
          )}
          <chakra.span textStyle="caption">
            {t("aiLedgerByModel")}
          </chakra.span>
          {report.byModel.map((a) => row(modelLabel(a.key), a))}
          <chakra.span textStyle="caption">
            {t("aiLedgerByTask")}
          </chakra.span>
          {report.byTask.map((a) => row(taskLabel(a.key), a))}
          <chakra.span textStyle="caption">
            {t("aiLedgerByDay")}
          </chakra.span>
          {(allDays ? report.byDay : report.byDay.slice(0, DAY_ROWS_COLLAPSED)).map((a) => row(a.key, a))}
          {report.byDay.length > DAY_ROWS_COLLAPSED && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              alignSelf="flex-start"
              aria-expanded={allDays}
              onClick={() => setAllDays((v) => !v)}
            >
              {allDays
                ? t("aiLedgerDayLess", { count: DAY_ROWS_COLLAPSED })
                : t("aiLedgerDayMore", { count: report.byDay.length - DAY_ROWS_COLLAPSED })}
            </Button>
          )}
        </>
      )}
      {dialog}
    </FormSection>
  );
}
