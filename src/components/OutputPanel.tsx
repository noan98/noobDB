import { useMemo, useState } from "react";
import { Box, chakra, Flex, VisuallyHidden } from "@chakra-ui/react";
import { useT } from "../i18n";
import {
  clearOutput,
  countProblems,
  filterOutput,
  isProblemOutcome,
  outputSummary,
  sqlHeadline,
  useOutputLog,
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
export function OutputPanel({ onOpenSql }: { onOpenSql: (sql: string) => void }) {
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
}: {
  entry: OutputEntry;
  expanded: boolean;
  onToggle: () => void;
  onOpenSql: (sql: string) => void;
}) {
  const t = useT();
  const toast = useToast();
  const problem = isProblemOutcome(entry.outcome);
  const role = entry.outcome === "error" ? "danger" : problem ? "warning" : "success";
  const summary = outputSummary(entry);
  const detailsId = `output-row-${entry.id}`;
  const where = [entry.connection, entry.database].filter(Boolean).join(" / ");

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
          boxShadow: "inset 0 0 0 2px color-mix(in srgb, var(--accent) 35%, transparent)",
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
          {entry.error && (
            <CodePreview wrap maxH="160px" color="app.textError">
              {entry.error}
            </CodePreview>
          )}
          <Flex gap="2">
            <Button type="button" size="sm" variant="secondary" onClick={() => onOpenSql(entry.sql)}>
              {t("outputOpenInEditor")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={async () => {
                if (await copyToClipboard(entry.sql)) toast.success(t("outputCopied"));
              }}
            >
              <Icon name="copy" size={ICON_SIZES.sm} />
              {t("outputCopySql")}
            </Button>
          </Flex>
        </Flex>
      )}
    </chakra.li>
  );
}
