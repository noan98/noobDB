import { useMemo, useState } from "react";
import { Box, chakra, Flex, VisuallyHidden } from "@chakra-ui/react";
import { useT } from "../i18n";
import {
  clearOutput,
  countProblems,
  filterOutput,
  isProblemOutcome,
  isSqlTruncated,
  outputSummary,
  SERVER_SEVERITY_LABEL,
  SERVER_SEVERITY_ROLE,
  sqlHeadline,
  useOutputLog,
  worstServerSeverity,
  type OutputEntry,
  type OutputFilter,
} from "../outputLog";
import { semanticColorToken } from "../semanticColors";
import { copyToClipboard } from "./clipboard";
import { EmptyState } from "./EmptyState";
import { Icon, ICON_SIZES } from "./Icon";
import { CodePreview } from "./modalForm";
import { clockTime, FilterChip, LogToolbar } from "./SeverityLog";
import { useToast } from "./Toast";
import { Tooltip } from "./Tooltip";
import { Button } from "./ui";

/**
 * Bottom Panel「出力」タブ (#1114)。このセッションで実行した文ごとの結末
 * (件数・所要時間・エラー) を時系列で並べる。記録と整形の純ロジックは
 * `outputLog.ts`、ツールバーとフィルタチップはアクティビティ / メッセージの
 * タブと共通 (`SeverityLog.tsx`)。
 *
 * 行を押すと SQL の全文とエラー本文を展開し、そこから「エディタで開く」
 * 「SQL をコピー」ができる (開くのは新しいタブ — 今のエディタを上書きしない)。
 */
export function OutputPanel({
  onOpenSql,
  onInsertSql,
  onRunSql,
  canRun = false,
  currentConnectionId = null,
}: {
  onOpenSql: (sql: string) => void;
  /** フォーカス中のエディタへ挿入する (#1541)。省略時はボタンを出さない。 */
  onInsertSql?: (sql: string) => void;
  /** 新しいタブで再実行する (#1541)。実行は通常の実行経路 (安全網つき) に委ねる。省略時は出さない。 */
  onRunSql?: (sql: string, execDatabase: string | null) => void;
  /** 接続中か。再実行に必要 (挿入は未接続でも使える)。 */
  canRun?: boolean;
  /** いま接続しているプロファイル id。記録時の接続 (id) と違う行、id を持たない行は再実行を無効にする。 */
  currentConnectionId?: string | null;
}) {
  const t = useT();
  const entries = useOutputLog();
  const [filter, setFilter] = useState<OutputFilter>("all");
  const [expanded, setExpanded] = useState<number | null>(null);
  const problems = useMemo(() => countProblems(entries), [entries]);
  const shown = useMemo(() => filterOutput(entries, filter), [entries, filter]);

  return (
    <Flex direction="column" h="100%" minH={0}>
      <LogToolbar
        filterAria={t("outputFilterAria")}
        onClear={clearOutput}
        clearDisabled={entries.length === 0}
        filters={
          <>
            <FilterChip
              label={t("activityFilterAll")}
              count={entries.length}
              active={filter === "all"}
              onClick={() => setFilter("all")}
            />
            <FilterChip
              label={t("outputFilterProblems")}
              count={problems}
              active={filter === "problems"}
              onClick={() => setFilter(filter === "problems" ? "all" : "problems")}
            />
          </>
        }
      />
      {shown.length === 0 ? (
        <EmptyState
          compact
          icon="query"
          title={entries.length === 0 ? t("outputEmptyTitle") : t("activityNoMatches")}
          description={entries.length === 0 ? t("outputEmpty") : undefined}
        />
      ) : (
        <chakra.ul listStyleType="none" m={0} p={0} flex="1" minH={0} overflowY="auto" aria-label={t("outputListAria")}>
          {shown.map((e) => (
            <OutputRow
              key={e.id}
              entry={e}
              expanded={expanded === e.id}
              onToggle={() => setExpanded((cur) => (cur === e.id ? null : e.id))}
              onOpenSql={onOpenSql}
              onInsertSql={onInsertSql}
              onRunSql={onRunSql}
              canRun={canRun}
              currentConnectionId={currentConnectionId}
            />
          ))}
        </chakra.ul>
      )}
    </Flex>
  );
}

function OutputRow({
  entry,
  expanded,
  onToggle,
  onOpenSql,
  onInsertSql,
  onRunSql,
  canRun,
  currentConnectionId,
}: {
  entry: OutputEntry;
  expanded: boolean;
  onToggle: () => void;
  onOpenSql: (sql: string) => void;
  onInsertSql?: (sql: string) => void;
  onRunSql?: (sql: string, execDatabase: string | null) => void;
  canRun: boolean;
  currentConnectionId: string | null;
}) {
  const t = useT();
  const toast = useToast();
  const problem = isProblemOutcome(entry.outcome);
  const role = entry.outcome === "error" ? "danger" : problem ? "warning" : "success";
  const summary = outputSummary(entry);
  const truncated = isSqlTruncated(entry);
  const detailsId = `output-row-${entry.id}`;
  const where = [entry.connection, entry.database].filter(Boolean).join(" / ");
  // 再実行できない理由 (#1541)。記録時と別の接続へは流さない (別環境への誤実行を防ぐ)。
  const rerunBlock = truncated
    ? t("outputOpenTruncatedDisabled")
    : !canRun
      ? t("outputNeedsConnection")
      : entry.connectionId === null || entry.connectionId !== currentConnectionId
        ? t("outputRerunOtherConnection", { name: entry.connection ?? "?" })
        : null;
  const serverMessages = entry.serverMessages ?? [];
  const worstServer = worstServerSeverity(serverMessages);

  return (
    <chakra.li borderBottom="1px solid" borderColor="app.borderSubtle" _last={{ borderBottom: "none" }}>
      <chakra.button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={detailsId}
        display="flex"
        alignItems="flex-start"
        gap="2"
        w="100%"
        px="2.5"
        py="1.5"
        bg={expanded ? "app.hover" : "transparent"}
        border="none"
        textAlign="left"
        color="app.text"
        cursor="pointer"
        _hover={{ bg: "app.hover" }}
        _focusVisible={{
          outline: "none",
          boxShadow: "inset var(--focus-ring)",
        }}
      >
        <chakra.span display="inline-flex" flexShrink={0} mt="0.5" color={semanticColorToken(role, "text")} aria-hidden>
          <Icon name={problem ? "warning" : "check"} size={ICON_SIZES.sm} />
        </chakra.span>
        <chakra.span flexShrink={0} fontSize="xs" color="app.textMuted" textStyle="numeric" mt="0.25">
          {clockTime(entry.at)}
        </chakra.span>
        <Box flex="1" minW={0} display="flex" flexDirection="column" gap="0.5">
          <chakra.span
            fontFamily="mono"
            fontSize="sm"
            whiteSpace="nowrap"
            overflow="hidden"
            textOverflow="ellipsis"
          >
            {sqlHeadline(entry.sql)}
          </chakra.span>
          <chakra.span
            fontSize="xs"
            color={problem ? semanticColorToken(role, "text") : "app.textMuted"}
            wordBreak="break-word"
          >
            <VisuallyHidden>{t(problem ? "activitySeverityError" : "activitySeveritySuccess")}: </VisuallyHidden>
            {t(summary.key, summary.vars)}
            {worstServer && (
              <chakra.span color={semanticColorToken(SERVER_SEVERITY_ROLE[worstServer], "text")} ml="2">
                {t("outputServerMessages", { count: serverMessages.length })}
              </chakra.span>
            )}
            {where && (
              <chakra.span color="app.textMuted" ml="2">
                {where}
              </chakra.span>
            )}
          </chakra.span>
        </Box>
      </chakra.button>
      {expanded && (
        <Flex id={detailsId} direction="column" gap="2" px="2.5" pb="2.5" pl="8">
          <CodePreview wrap maxH="200px">{entry.sql}</CodePreview>
          {truncated && (
            <chakra.span textStyle="caption">
              {t("outputSqlTruncated", { kept: entry.sql.length, total: entry.sqlLength })}
            </chakra.span>
          )}
          {serverMessages.length > 0 && (
            <chakra.ul
              listStyleType="none"
              m={0}
              p={0}
              display="flex"
              flexDirection="column"
              gap="1"
              aria-label={t("outputServerMessagesAria")}
            >
              {serverMessages.map((m, i) => (
                <chakra.li key={i} fontFamily="mono" fontSize="sm" wordBreak="break-word" whiteSpace="pre-wrap">
                  <chakra.span
                    color={semanticColorToken(SERVER_SEVERITY_ROLE[m.severity], "text")}
                    fontWeight="semibold"
                    mr="2"
                  >
                    {t(SERVER_SEVERITY_LABEL[m.severity])}
                  </chakra.span>
                  {m.text}
                </chakra.li>
              ))}
            </chakra.ul>
          )}
          {entry.error && (
            <CodePreview wrap maxH="160px" color="app.textError">
              {entry.error}
            </CodePreview>
          )}
          <Flex gap="2">
            {/* 切り詰めた断片を開くと、欠けた DML をそのまま実行できてしまうので無効にする。 */}
            <Tooltip label={truncated ? t("outputOpenTruncatedDisabled") : undefined} focusableWrapper={truncated}>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={truncated}
                onClick={() => onOpenSql(entry.sql)}
              >
                {t("outputOpenInEditor")}
              </Button>
            </Tooltip>
            {onInsertSql && (
              <Tooltip
                label={truncated ? t("outputOpenTruncatedDisabled") : undefined}
                focusableWrapper={truncated}
              >
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={truncated}
                  onClick={() => onInsertSql(entry.sql)}
                >
                  {t("outputInsertInEditor")}
                </Button>
              </Tooltip>
            )}
            {onRunSql && (
              <Tooltip label={rerunBlock ?? t("outputRerunHint")} focusableWrapper={rerunBlock !== null}>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={rerunBlock !== null}
                  onClick={() => onRunSql(entry.sql, entry.execDatabase)}
                >
                  <Icon name="play" size={ICON_SIZES.md} />
                  {t("outputRerun")}
                </Button>
              </Tooltip>
            )}
            <Tooltip label={t("outputCopySql")}>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                aria-label={t("outputCopySql")}
                onClick={async () => {
                  if (!(await copyToClipboard(entry.sql))) {
                    toast.error(t("outputCopyFailed"));
                  } else if (truncated) {
                    toast.info(t("outputCopiedTruncated", { kept: entry.sql.length, total: entry.sqlLength }));
                  } else {
                    toast.success(t("outputCopied"));
                  }
                }}
              >
                <Icon name="copy" size={ICON_SIZES.md} />
              </Button>
            </Tooltip>
          </Flex>
        </Flex>
      )}
    </chakra.li>
  );
}
