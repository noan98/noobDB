import { useEffect, useMemo, useState } from "react";
import { chakra, Flex } from "@chakra-ui/react";

import { api } from "../api/tauri";
import { useLocale, useT } from "../i18n";
import {
  ALL_WEEKDAYS_MASK,
  deviceTimeZone,
  flagsToWeekdays,
  formatRunPreview,
  scheduleFromDraft,
  timeZoneChoices,
  weekdayLabels,
  WORKDAYS_MASK,
  weekdaysToFlags,
  type ScheduleDraft,
} from "../taskFormat";
import { FieldError } from "./modalForm";
import { Button, Checkbox, Input, Select } from "./ui";

/** プレビューの再計算を入力の連打から間引く (ms)。 */
const PREVIEW_DEBOUNCE_MS = 200;
const PREVIEW_COUNT = 5;
const JST = "Asia/Tokyo";

/**
 * タスクのスケジュール入力 (#1621)。間隔 / 日次の切り替え、日次の時刻・タイムゾーン・曜日、
 * 保存前に確かめる「次の 5 回」(端末のローカル時刻と JST を併記)。プレビューはバックエンドの
 * `preview_task_schedule` で実際の計算 (DST・曜日マスク) をそのまま使う。
 */
export function TaskScheduleEditor({
  draft,
  onChange,
  legacyUtc,
}: {
  draft: ScheduleDraft;
  onChange: (next: ScheduleDraft) => void;
  /** 旧データ (UTC 保存) を開いたときの注記を出す。 */
  legacyUtc: boolean;
}) {
  const t = useT();
  const locale = useLocale();
  const device = useMemo(() => deviceTimeZone(), []);
  const zones = useMemo(() => timeZoneChoices(device, draft.timezone), [device, draft.timezone]);
  const labels = useMemo(() => weekdayLabels(locale), [locale]);
  const set = (patch: Partial<ScheduleDraft>) => onChange({ ...draft, ...patch });

  const built = scheduleFromDraft(draft);
  const weekdaysInvalid = draft.kind === "daily" && !built.ok;

  // 次回実行予定のプレビュー。入力が変わるたびに取り直し、古い応答は捨てる。
  const [runs, setRuns] = useState<string[] | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const scheduleKey = built.ok ? JSON.stringify(built.schedule) : "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: built は scheduleKey から導出されるため、キーだけを依存にする
  useEffect(() => {
    if (!built.ok) {
      setRuns(null);
      setPreviewError(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      api
        .previewTaskSchedule(built.schedule, PREVIEW_COUNT)
        .then((r) => {
          if (cancelled) return;
          setRuns(r);
          setPreviewError(null);
        })
        .catch((e) => {
          if (cancelled) return;
          setRuns(null);
          setPreviewError(String(e));
        });
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [scheduleKey]);

  const showJst = device !== JST;
  const flagsMask = flagsToWeekdays(draft.days);

  return (
    <chakra.div display="flex" flexDirection="column" gap="2.5">
      <Flex gap="3" align="center" flexWrap="wrap">
        <Select
          value={draft.kind}
          onChange={(e) => set({ kind: e.target.value as ScheduleDraft["kind"] })}
          width="auto"
        >
          <option value="interval">{t("taskScheduleInterval")}</option>
          <option value="daily">{t("taskScheduleDaily")}</option>
        </Select>
        {draft.kind === "interval" ? (
          <Flex align="center" gap="1.5">
            <Input
              type="number"
              min={1}
              width="90px"
              value={draft.intervalMinutes}
              onChange={(e) => set({ intervalMinutes: e.target.value })}
            />
            <chakra.span fontSize="sm" color="app.textMuted">
              {t("taskScheduleMinutes")}
            </chakra.span>
          </Flex>
        ) : (
          <Flex align="center" gap="1.5">
            <Input
              type="number"
              min={0}
              max={23}
              width="70px"
              aria-label={t("taskScheduleHour")}
              value={draft.hour}
              onChange={(e) => set({ hour: e.target.value })}
            />
            <chakra.span>:</chakra.span>
            <Input
              type="number"
              min={0}
              max={59}
              width="70px"
              aria-label={t("taskScheduleMinute")}
              value={draft.minute}
              onChange={(e) => set({ minute: e.target.value })}
            />
          </Flex>
        )}
      </Flex>

      {draft.kind === "daily" && (
        <>
          <Flex gap="2" align="center" flexWrap="wrap">
            <chakra.label htmlFor="task-timezone" fontSize="sm" color="app.textSecondary">
              {t("taskScheduleTimezone")}
            </chakra.label>
            <Select
              id="task-timezone"
              value={draft.timezone}
              onChange={(e) => set({ timezone: e.target.value })}
              width="auto"
              maxW="320px"
            >
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </Select>
          </Flex>
          <chakra.p margin={0} textStyle="caption">
            {legacyUtc ? t("taskScheduleLegacyUtcNote") : t("taskScheduleTimezoneHint")}
          </chakra.p>

          <Flex gap="3" align="center" flexWrap="wrap" role="group" aria-label={t("taskScheduleWeekdays")}>
            <chakra.span fontSize="sm" color="app.textSecondary">
              {t("taskScheduleWeekdays")}
            </chakra.span>
            {labels.map((label, i) => (
              <chakra.label key={label} display="inline-flex" alignItems="center" gap="1" fontSize="sm">
                <Checkbox
                  checked={draft.days[i] ?? false}
                  onChange={(e) =>
                    set({ days: draft.days.map((on, j) => (j === i ? e.target.checked : on)) })
                  }
                />
                {label}
              </chakra.label>
            ))}
            <Button
              type="button"
              size="sm"
              aria-pressed={flagsMask === WORKDAYS_MASK}
              onClick={() => set({ days: weekdaysToFlags(WORKDAYS_MASK) })}
            >
              {t("taskScheduleWorkdaysPreset")}
            </Button>
            <Button
              type="button"
              size="sm"
              aria-pressed={flagsMask === 0}
              onClick={() => set({ days: weekdaysToFlags(ALL_WEEKDAYS_MASK) })}
            >
              {t("taskScheduleEveryDayPreset")}
            </Button>
          </Flex>
          {weekdaysInvalid && <FieldError>{t("taskScheduleWeekdaysRequired")}</FieldError>}
        </>
      )}

      {built.ok && (
        <chakra.div data-testid="task-schedule-preview" display="flex" flexDirection="column" gap="1">
          <chakra.div textStyle="overline" color="app.textMuted">
            {t("taskSchedulePreviewTitle")}
          </chakra.div>
          {previewError ? (
            <FieldError>{t("taskSchedulePreviewError", { error: previewError })}</FieldError>
          ) : runs === null ? null : (
            <chakra.table fontSize="sm" style={{ borderCollapse: "collapse" }}>
              <chakra.thead>
                <chakra.tr>
                  <chakra.th textAlign="left" fontWeight={500} color="app.textMuted" pr="4">
                    {t("taskSchedulePreviewLocal", { tz: device })}
                  </chakra.th>
                  {showJst && (
                    <chakra.th textAlign="left" fontWeight={500} color="app.textMuted">
                      {t("taskSchedulePreviewJst")}
                    </chakra.th>
                  )}
                </chakra.tr>
              </chakra.thead>
              <chakra.tbody>
                {runs.map((iso) => (
                  <chakra.tr key={iso}>
                    <chakra.td pr="4" textStyle="numeric">
                      {formatRunPreview(iso, locale)}
                    </chakra.td>
                    {showJst && (
                      <chakra.td textStyle="numeric">{formatRunPreview(iso, locale, JST)}</chakra.td>
                    )}
                  </chakra.tr>
                ))}
              </chakra.tbody>
            </chakra.table>
          )}
        </chakra.div>
      )}
    </chakra.div>
  );
}
