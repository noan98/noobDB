import { useEffect, useMemo, useState, type ReactNode } from "react";
import { motion } from "motion/react";
import { Box, chakra, Flex, VisuallyHidden } from "@chakra-ui/react";
import { useT, type I18nKey } from "../i18n";
import { CountUp } from "./CountUp";
import { EmptyState } from "./EmptyState";
import { Icon, ICON_SIZES } from "./Icon";
import { Button } from "./ui";
import { variants } from "../motion";
import { semanticColorToken } from "../semanticColors";
import {
  ACTIVITY_SEVERITIES,
  ACTIVITY_SEVERITY_ROLE,
  clearActivity,
  countBySeverity,
  filterActivity,
  markActivityRead,
  relativeActivityTime,
  useActivityLog,
  type ActivityEntry,
  type ActivitySeverity,
} from "../activityLog";
import { clearMessages, useMessageLog } from "../messageLog";

/**
 * 重大度付きログ (アクティビティ / メッセージ) の一覧 UI (#1114)。
 *
 * タイトルバーのベルから開くアクティビティのポップオーバー (`ActivityCenter`) と、
 * Bottom Panel の「アクティビティ」「メッセージ」タブが**同じ行・同じフィルタ
 * チップ**で描かれるよう、ここに部品を集めた。画面ごとに別の一覧を書くと、同じ
 * 「エラー」が場所によって別の色・別のアイコン・別の並びで出てしまう。
 */

/** 重大度ごとのアイコン (色は意味色トークン)。 */
const SEVERITY_ICON: Record<ActivitySeverity, "check" | "warning" | "help"> = {
  success: "check",
  warning: "warning",
  error: "warning",
  info: "help",
};

/** 重大度ラベルの i18n キー (フィルタチップと読み上げに使う)。 */
export const SEVERITY_LABEL: Record<ActivitySeverity, I18nKey> = {
  success: "activitySeveritySuccess",
  warning: "activitySeverityWarning",
  error: "activitySeverityError",
  info: "activitySeverityInfo",
};

/** 相対時刻を i18n 文字列へ。1 分未満は「たった今」。 */
function formatRelative(t: ReturnType<typeof useT>, at: number, now: number): string {
  const rel = relativeActivityTime(at, now);
  switch (rel.unit) {
    case "minutes":
      return t("activityTimeMinutes", { n: rel.value });
    case "hours":
      return t("activityTimeHours", { n: rel.value });
    case "days":
      return t("activityTimeDays", { n: rel.value });
    case "now":
    default:
      return t("activityTimeNow");
  }
}

/** ログ一覧の時刻表記 (`HH:MM:SS`)。パネルは開きっぱなしにするので相対時刻にしない。 */
export function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString();
}

// motion 用 props は Chakra のスタイルプロップに飲まれないよう forwardProps で素通しする。
const MotionLi = chakra(motion.li, {}, { forwardProps: ["variants"] });

/**
 * ログの 1 行。
 *
 * - `time="relative"` はポップオーバー用 (開いた瞬間に読む)、`"clock"` はパネル用
 *   (開きっぱなしで相対時刻が古くなるため、絶対時刻を出す)。
 * - `repeat` が 2 以上なら「×N」を添える (メッセージ履歴で同じ行を畳んだ回数)。
 */
export function SeverityLogRow({
  entry,
  now,
  animated,
  time,
  repeat = 1,
}: {
  entry: ActivityEntry;
  now: number;
  /** false のときは stagger に参加させず即時表示する (#984)。 */
  animated: boolean;
  time: "relative" | "clock";
  repeat?: number;
}) {
  const t = useT();
  const role = ACTIVITY_SEVERITY_ROLE[entry.severity];
  const absolute = new Date(entry.at).toLocaleString();
  return (
    <MotionLi
      variants={animated ? variants.staggerItem : undefined}
      display="flex"
      alignItems="flex-start"
      gap="2"
      px="2.5"
      py="2"
      borderBottom="1px solid"
      borderColor="app.borderSubtle"
      _last={{ borderBottom: "none" }}
    >
      <chakra.span
        display="inline-flex"
        flexShrink={0}
        mt="0.5"
        color={semanticColorToken(role, "text")}
        aria-hidden
      >
        <Icon name={SEVERITY_ICON[entry.severity]} size={ICON_SIZES.sm} />
      </chakra.span>
      <Box flex="1" minW={0} display="flex" flexDirection="column" gap="0.5">
        <chakra.span fontSize="sm" color="app.text" lineHeight="snug" wordBreak="break-word" whiteSpace="pre-wrap">
          {entry.message}
        </chakra.span>
        <chakra.span fontSize="xs" color="app.textMuted">
          {/* 重大度は色だけに頼らずテキストでも示す (CB 配慮)。 */}
          <VisuallyHidden>{t(SEVERITY_LABEL[entry.severity])}: </VisuallyHidden>
          {time === "relative" ? (
            <>
              {formatRelative(t, entry.at, now)}
              <VisuallyHidden> ({absolute})</VisuallyHidden>
            </>
          ) : (
            <chakra.span textStyle="numeric">{clockTime(entry.at)}</chakra.span>
          )}
          {repeat > 1 && (
            <chakra.span ml="1.5" textStyle="numeric">
              {t("messagesRepeat", { count: repeat })}
            </chakra.span>
          )}
        </chakra.span>
      </Box>
    </MotionLi>
  );
}

/** フィルタチップ 1 個 (「すべて」+ 重大度ごと)。 */
export function FilterChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <chakra.button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      display="inline-flex"
      alignItems="center"
      gap="1"
      px="2"
      py="0.5"
      fontSize="xs"
      fontWeight={600}
      borderRadius="pill"
      border="1px solid"
      borderColor={active ? "app.accent" : "app.border"}
      bg={active ? "app.hover" : "transparent"}
      color={active ? "app.text" : "app.textMuted"}
      cursor="pointer"
      whiteSpace="nowrap"
      _hover={{ bg: "app.hover", color: "app.text" }}
    >
      {label}
      <chakra.span color="app.textMuted" fontWeight={500} textStyle="numeric">
        {/* 件数の変化はカウントアップで遷移させる (#1024)。 */}
        <CountUp value={count} />
      </chakra.span>
    </chakra.button>
  );
}

/**
 * Bottom Panel のログタブ共通のツールバー (左: フィルタ、右: クリア)。
 * 出力タブ (`OutputPanel`) もこの枠を使い、3 つのログタブの操作位置を揃える。
 */
export function LogToolbar({
  filterAria,
  filters,
  onClear,
  clearDisabled,
  extra,
}: {
  filterAria: string;
  filters: ReactNode;
  onClear: () => void;
  clearDisabled: boolean;
  /** クリアの左に置く補助操作 (任意)。 */
  extra?: ReactNode;
}) {
  const t = useT();
  return (
    <Flex
      align="center"
      gap="2"
      px="2.5"
      py="1.5"
      borderBottom="1px solid"
      borderColor="app.borderSubtle"
      flexShrink={0}
    >
      <Flex role="group" aria-label={filterAria} gap="1" flexWrap="wrap" flex="1" minW={0}>
        {filters}
      </Flex>
      {extra}
      <Button type="button" size="sm" variant="secondary" onClick={onClear} disabled={clearDisabled}>
        {t("activityClear")}
      </Button>
    </Flex>
  );
}

/**
 * 重大度付きログを Bottom Panel のタブとして描く本体 (フィルタ + 一覧)。
 * 見出しと閉じるボタンはタブバーが持つので、ここはツールバーから始まる
 * (`.claude/rules/ui-design-system.md` §7.1)。
 */
function SeverityLogPanel({
  entries,
  onClear,
  emptyTitle,
  emptyDescription,
  listAria,
  repeatOf,
}: {
  entries: readonly ActivityEntry[];
  onClear: () => void;
  emptyTitle: string;
  emptyDescription: string;
  listAria: string;
  repeatOf?: (e: ActivityEntry) => number;
}) {
  const t = useT();
  const [severity, setSeverity] = useState<ActivitySeverity | null>(null);
  const counts = useMemo(() => countBySeverity(entries), [entries]);
  const shown = useMemo(() => filterActivity(entries, severity), [entries, severity]);
  return (
    <Flex direction="column" h="100%" minH={0}>
      <LogToolbar
        filterAria={t("activityFilterAria")}
        onClear={onClear}
        clearDisabled={entries.length === 0}
        filters={
          <>
            <FilterChip
              label={t("activityFilterAll")}
              count={entries.length}
              active={severity === null}
              onClick={() => setSeverity(null)}
            />
            {ACTIVITY_SEVERITIES.map((s) => (
              <FilterChip
                key={s}
                label={t(SEVERITY_LABEL[s])}
                count={counts[s]}
                active={severity === s}
                onClick={() => setSeverity(severity === s ? null : s)}
              />
            ))}
          </>
        }
      />
      {shown.length === 0 ? (
        <EmptyState
          compact
          icon="list"
          title={entries.length === 0 ? emptyTitle : t("activityNoMatches")}
          description={entries.length === 0 ? emptyDescription : undefined}
        />
      ) : (
        <chakra.ul listStyleType="none" m={0} p={0} flex="1" minH={0} overflowY="auto" aria-label={listAria}>
          {shown.map((e) => (
            <SeverityLogRow
              key={e.id}
              entry={e}
              now={0}
              animated={false}
              time="clock"
              repeat={repeatOf?.(e)}
            />
          ))}
        </chakra.ul>
      )}
    </Flex>
  );
}

/**
 * Bottom Panel「アクティビティ」タブ。トーストの履歴 (ベルと同じストア) を
 * パネルで開きっぱなしにして読む。表示中は既読扱いにする (ベルの未読バッジが消える)。
 */
export function ActivityLogPanel() {
  const t = useT();
  const { entries } = useActivityLog();
  useEffect(() => {
    markActivityRead();
  }, [entries]);
  return (
    <SeverityLogPanel
      entries={entries}
      onClear={clearActivity}
      emptyTitle={t("activityEmptyTitle")}
      emptyDescription={t("activityEmpty")}
      listAria={t("activityListAria")}
    />
  );
}

/** Bottom Panel「メッセージ」タブ。ステータスバーに出たメッセージの履歴。 */
export function MessagesPanel() {
  const t = useT();
  const entries = useMessageLog();
  const repeats = useMemo(() => new Map(entries.map((e) => [e.id, e.repeat])), [entries]);
  return (
    <SeverityLogPanel
      entries={entries}
      onClear={clearMessages}
      emptyTitle={t("messagesEmptyTitle")}
      emptyDescription={t("messagesEmpty")}
      listAria={t("messagesListAria")}
      repeatOf={(e) => repeats.get(e.id) ?? 1}
    />
  );
}
