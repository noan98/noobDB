import { useState } from "react";
import { chakra, Flex } from "@chakra-ui/react";
import type { CellValue } from "../api/tauri";
import { useT } from "../i18n";
import type { BatchStatementResult } from "../sqlScript";
import { Button, Switch } from "./ui";
import { Icon } from "./Icon";
import { Spinner } from "./Spinner";

/**
 * SQL スクリプトのバッチ実行の結果ビュー。文ごとに「SQL / 成否 / 影響行数 or
 * 結果プレビュー / エラー」をカードで一覧する。ヘッダーで「エラーで停止 / 続行」を
 * 切り替えて再実行でき、エディタの結果表示へ戻れる。
 */
interface Props {
  results: BatchStatementResult[];
  running: boolean;
  onRerun: (stopOnError: boolean) => void;
  onClose: () => void;
}

export function BatchResultsView({ results, running, onRerun, onClose }: Props) {
  const t = useT();
  const [stopOnError, setStopOnError] = useState(true);
  const okCount = results.filter((r) => r.status === "ok").length;
  const errCount = results.filter((r) => r.status === "error").length;

  return (
    <Flex direction="column" h="100%" minH={0} minW={0}>
      <Flex align="center" gap="3" px="3" py="2" flex="none" borderBottomWidth="1px" borderBottomColor="app.border" fontSize="sm" flexWrap="wrap">
        <Button type="button" variant="secondary" size="sm" onClick={onClose}>
          <Icon name="query" size={14} /> {t("batchBackToResult")}
        </Button>
        <chakra.span color="app.text">
          {t("batchSummary", { total: results.length, ok: okCount, errors: errCount })}
        </chakra.span>
        {running && <Spinner size={13} />}
        <chakra.span flex="1" />
        <chakra.span fontSize="xs" color="app.textSecondary">
          <Switch
            size="sm"
            checked={stopOnError}
            onChange={setStopOnError}
            label={t("batchStopOnError")}
          />
        </chakra.span>
        <Button type="button" variant="secondary" size="sm" onClick={() => onRerun(stopOnError)} disabled={running}>
          {t("batchRerun")}
        </Button>
      </Flex>

      <chakra.div flex="1" minH={0} overflow="auto" p="2.5" display="flex" flexDirection="column" gap="2.5">
        {results.map((r, i) => (
          <StatementCard key={i} index={i + 1} result={r} t={t} />
        ))}
      </chakra.div>
    </Flex>
  );
}

function StatementCard({
  index,
  result,
  t,
}: {
  index: number;
  result: BatchStatementResult;
  t: ReturnType<typeof useT>;
}) {
  const tone =
    result.status === "ok" ? "#10b981" : result.status === "error" ? "var(--danger-fg, #ef4444)" : "var(--text-muted)";
  return (
    <chakra.div borderWidth="1px" borderColor="app.border" borderRadius="8px" overflow="hidden">
      <Flex align="center" gap="2" px="2.5" py="1.5" bg="app.surface" borderBottomWidth="1px" borderBottomColor="app.border">
        <chakra.span fontSize="xs" color="app.textMuted" fontFamily="mono">#{index}</chakra.span>
        <chakra.span w="9px" h="9px" borderRadius="full" bg={tone} flexShrink={0} />
        <chakra.code fontSize="xs" color="app.text" overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap" flex="1" title={result.sql}>
          {result.sql}
        </chakra.code>
        <chakra.span fontSize="xs" color="app.textMuted" whiteSpace="nowrap">
          {result.status === "skipped"
            ? t("batchSkipped")
            : result.status === "error"
              ? t("batchError")
              : result.columns
                ? t("batchRows", { rows: result.rows?.length ?? 0 })
                : t("batchAffected", { rows: result.rowsAffected ?? 0 })}
          {result.elapsedMs != null ? ` · ${result.elapsedMs}ms` : ""}
        </chakra.span>
      </Flex>
      {result.status === "error" && (
        <chakra.div px="2.5" py="1.5" fontSize="xs" color="var(--danger-fg, #ef4444)" fontFamily="mono" whiteSpace="pre-wrap">
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

function MiniTable({ columns, rows }: { columns: string[]; rows: CellValue[][] }) {
  return (
    <chakra.table fontSize="xs" width="100%" css={{ borderCollapse: "collapse" }}>
      <chakra.thead position="sticky" top="0" bg="app.surface">
        <tr>
          {columns.map((c, i) => (
            <chakra.th key={i} textAlign="left" px="2" py="1" borderBottomWidth="1px" borderColor="app.border" fontFamily="mono" color="app.textSecondary" whiteSpace="nowrap">
              {c}
            </chakra.th>
          ))}
        </tr>
      </chakra.thead>
      <tbody>
        {rows.map((row, ri) => (
          <tr key={ri}>
            {columns.map((_, ci) => (
              <chakra.td key={ci} px="2" py="3px" borderBottomWidth="1px" borderColor="app.border" fontFamily="mono" color="app.text" whiteSpace="nowrap">
                {cellText(row[ci])}
              </chakra.td>
            ))}
          </tr>
        ))}
      </tbody>
    </chakra.table>
  );
}

function cellText(v: CellValue): string {
  if (v === null || v === undefined) return "NULL";
  return String(v);
}
