import { useEffect, useRef, useState } from "react";
import { chakra, Flex } from "@chakra-ui/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { CellValue } from "../api/tauri";
import { useT } from "../i18n";
import { semanticColorVar } from "../semanticColors";
import type { BatchStatementResult } from "../sqlScript";
import { springs, staggerTiming, transitions, variants } from "../motion";
import { FIRST_BATCH_REVEAL_MAX_STEPS } from "./firstBatchReveal";
import { Button, Switch } from "./ui";
import { CountUpText } from "./CountUp";
import { prefersStaticMotion } from "./revealOrigin";
import { Icon, ICON_SIZES } from "./Icon";
import { Spinner } from "./Spinner";
import { Tooltip } from "./Tooltip";

/**
 * SQL スクリプトのバッチ実行の結果ビュー。文ごとに「SQL / 成否 / 影響行数 or
 * 結果プレビュー / エラー」をカードで一覧する。ヘッダーで「エラーで停止 / 続行」を
 * 切り替えて再実行でき、エディタの結果表示へ戻れる。
 *
 * ## Motion (#1873)
 *
 * - 実行中に文が完了して増えるカードは `AnimatePresence initial={false}` +
 *   `variants.collapse` で下へ積み上がる。同じ描画で複数枚増えたときは
 *   `staggerTiming.each` ずつずらす (`batchEnterDelay`)。表示した時点で既にあるカードは動かさない。
 * - ヘッダの文数 / 成功 / エラー件数は `CountUpText` で連続更新する。
 * - 成否ドットは `variants.fadeScale` + `springs.gentle` で pop する。
 * - reduced-motion (OS / アプリ設定) とハイコントラスト (`prefersStaticMotion`) では
 *   transition を 0 秒にして静止する。height / opacity は `MotionConfig` では止まらないため。
 */

const MotionDiv = chakra(
  motion.div,
  {},
  { forwardProps: ["variants", "initial", "animate", "exit", "transition", "custom"] },
);
const MotionSpan = chakra(
  motion.span,
  {},
  { forwardProps: ["variants", "initial", "animate", "exit", "transition"] },
);

/** 即時化した transition (静止モード)。 */
const INSTANT = { duration: 0 } as const;

/** 同じ描画で増えたカードの入場遅延 (秒)。前回の枚数より後ろのカードだけ順にずらし、`FIRST_BATCH_REVEAL_MAX_STEPS` 段で頭打ちにする。 */
export function batchEnterDelay(index: number, prevCount: number): number {
  return Math.min(Math.max(0, index - prevCount), FIRST_BATCH_REVEAL_MAX_STEPS - 1) * staggerTiming.each;
}

interface Props {
  results: BatchStatementResult[];
  running: boolean;
  onRerun: (stopOnError: boolean) => void;
  onClose: () => void;
  /** 実行中のバッチを止める。 */
  onStop?: () => void;
}

export function BatchResultsView({ results, running, onRerun, onClose, onStop }: Props) {
  const t = useT();
  const [stopOnError, setStopOnError] = useState(true);
  const okCount = results.filter((r) => r.status === "ok").length;
  const errCount = results.filter((r) => r.status === "error").length;
  const reduced = useReducedMotion() ?? false;
  const still = reduced || prefersStaticMotion();
  // 直前の描画までに表示済みの枚数。今回増えた分だけを順にずらすために使う。
  const prevCount = useRef(results.length);
  const seenCount = prevCount.current;
  useEffect(() => {
    prevCount.current = results.length;
  }, [results.length]);

  return (
    <Flex direction="column" h="100%" minH={0} minW={0}>
      <Flex
        align="center"
        gap="3"
        px="3"
        py="2"
        flex="none"
        borderBottomWidth="1px"
        borderBottomColor="app.border"
        fontSize="sm"
        flexWrap="wrap"
      >
        <Button type="button" variant="secondary" size="sm" onClick={onClose}>
          <Icon name="query" size={ICON_SIZES.md} /> {t("batchBackToResult")}
        </Button>
        <chakra.span color="app.text">
          <CountUpText
            values={[results.length, okCount, errCount]}
            render={([total, ok, errors]) => t("batchSummary", { total, ok, errors })}
          />
        </chakra.span>
        {running && <Spinner size={13} />}
        {running && onStop && (
          <Button type="button" variant="secondary" size="sm" onClick={onStop} data-testid="batch-stop">
            {t("gridStopButton")}
          </Button>
        )}
        <chakra.span flex="1" />
        <chakra.span fontSize="xs" color="app.textSecondary">
          <Switch size="sm" checked={stopOnError} onChange={setStopOnError} label={t("batchStopOnError")} />
        </chakra.span>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => onRerun(stopOnError)}
          disabled={running}
        >
          {t("batchRerun")}
        </Button>
      </Flex>

      <chakra.div flex="1" minH={0} overflow="auto" p="2.5" display="flex" flexDirection="column" gap="2.5">
        <AnimatePresence initial={false}>
          {results.map((r, i) => (
            <MotionDiv
              key={i}
              variants={variants.collapse}
              initial="initial"
              animate="animate"
              exit="exit"
              transition={still ? INSTANT : { ...transitions.enter, delay: batchEnterDelay(i, seenCount) }}
              flex="none"
            >
              <StatementCard
                index={i + 1}
                result={r}
                t={t}
                still={still}
                delay={batchEnterDelay(i, seenCount)}
              />
            </MotionDiv>
          ))}
        </AnimatePresence>
      </chakra.div>
    </Flex>
  );
}

function StatementCard({
  index,
  result,
  t,
  still,
  delay,
}: {
  index: number;
  result: BatchStatementResult;
  t: ReturnType<typeof useT>;
  still: boolean;
  /** カードの入場遅延 (秒)。ドットの pop もそれに揃える。 */
  delay: number;
}) {
  const tone =
    result.status === "ok"
      ? semanticColorVar("success", "solid")
      : result.status === "error"
        ? semanticColorVar("danger", "solid")
        : "var(--text-muted)";
  return (
    <chakra.div borderWidth="1px" borderColor="app.border" borderRadius="lg" overflow="hidden">
      <Flex
        align="center"
        gap="2"
        px="2.5"
        py="1.5"
        bg="app.surface"
        borderBottomWidth="1px"
        borderBottomColor="app.border"
      >
        <chakra.span fontSize="xs" color="app.textMuted" fontFamily="mono">
          #{index}
        </chakra.span>
        <MotionSpan
          key={result.status}
          display="inline-block"
          w="9px"
          h="9px"
          borderRadius="full"
          bg={tone}
          flexShrink={0}
          variants={variants.fadeScale}
          initial="initial"
          animate="animate"
          transition={still ? INSTANT : { ...springs.gentle, delay }}
          data-testid="batch-status-dot"
        />
        <Tooltip label={result.sql}>
          <chakra.code
            fontSize="xs"
            color="app.text"
            overflow="hidden"
            textOverflow="ellipsis"
            whiteSpace="nowrap"
            flex="1"
          >
            {result.sql}
          </chakra.code>
        </Tooltip>
        <chakra.span fontSize="xs" color="app.textMuted" whiteSpace="nowrap">
          {result.status === "skipped"
            ? t("batchSkipped")
            : result.status === "error"
              ? t("batchError")
              : result.columns
                ? batchRowsLabel(result, t)
                : t("batchAffected", { rows: result.rowsAffected ?? 0 })}
          {result.elapsedMs != null ? ` · ${result.elapsedMs}ms` : ""}
        </chakra.span>
      </Flex>
      {result.status === "error" && (
        <chakra.div
          px="2.5"
          py="1.5"
          fontSize="xs"
          color="app.textError"
          fontFamily="mono"
          whiteSpace="pre-wrap"
        >
          {result.error}
        </chakra.div>
      )}
      {result.columns && result.rows && result.rows.length > 0 && (
        <chakra.div overflow="auto" maxH="240px">
          <MiniTable columns={result.columns.map((c) => c.name)} rows={result.rows} />
        </chakra.div>
      )}
    </chakra.div>
  );
}

/** SELECT の件数表示。プレビュー上限で切り詰めたときは「先頭 N 行 / 全 M 行」(総数が分かる
 *  場合) か「先頭 N 行のみ」と注記して、全件に見えないようにする (#1534)。 */
function batchRowsLabel(result: BatchStatementResult, t: ReturnType<typeof useT>): string {
  const shown = result.rows?.length ?? 0;
  if (!result.truncated) return t("batchRows", { rows: shown });
  return result.totalRows != null
    ? t("batchRowsTruncatedOfTotal", { shown, total: result.totalRows.toLocaleString() })
    : t("batchRowsTruncated", { shown });
}

/** カード 1 枚で最初に DOM へ出す行数。残りは「さらに表示」で段階的に広げる。 */
const MINI_TABLE_PAGE = 100;

function MiniTable({ columns, rows }: { columns: string[]; rows: CellValue[][] }) {
  const t = useT();
  const [limit, setLimit] = useState(MINI_TABLE_PAGE);
  const visible = rows.length > limit ? rows.slice(0, limit) : rows;
  const remaining = rows.length - visible.length;
  return (
    <>
      <chakra.table fontSize="xs" width="100%" css={{ borderCollapse: "collapse" }}>
        <chakra.thead position="sticky" top="0" bg="app.surface">
          <tr>
            {columns.map((c, i) => (
              <chakra.th
                key={i}
                textAlign="left"
                px="2"
                py="1"
                borderBottomWidth="1px"
                borderColor="app.border"
                fontFamily="mono"
                color="app.textSecondary"
                whiteSpace="nowrap"
              >
                {c}
              </chakra.th>
            ))}
          </tr>
        </chakra.thead>
        <tbody>
          {visible.map((row, ri) => (
            <tr key={ri}>
              {columns.map((_, ci) => (
                <chakra.td
                  key={ci}
                  px="2"
                  py="0.75"
                  borderBottomWidth="1px"
                  borderColor="app.border"
                  fontFamily="mono"
                  color="app.text"
                  whiteSpace="nowrap"
                >
                  {cellText(row[ci])}
                </chakra.td>
              ))}
            </tr>
          ))}
        </tbody>
      </chakra.table>
      {remaining > 0 && (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => setLimit((l) => l + MINI_TABLE_PAGE)}
        >
          {t("batchShowMore", { n: Math.min(MINI_TABLE_PAGE, remaining), remaining })}
        </Button>
      )}
    </>
  );
}

function cellText(v: CellValue): string {
  if (v === null || v === undefined) return "NULL";
  return String(v);
}
