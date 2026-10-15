import { useEffect, useMemo, useState } from "react";
import { chakra, Flex } from "@chakra-ui/react";

import { api, type TimelapseRowHistory } from "../api/tauri";
import type { CellValue } from "../api/tauri";
import { useT } from "../i18n";
import { semanticColorVar } from "../semanticColors";
import { useSettings } from "../settings";
import { formatTimelapseValue } from "../tableTimelapse";
import { resolveMaskedColumns } from "./columnMask";
import { ErrorNote } from "./modalForm";
import { Spinner } from "./Spinner";
import { Button } from "./ui";

const MASK_TEXT = "••••";

function formatCaptured(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/**
 * 主キーを指定した 1 行の値の推移 (#1621)。保存済みの全世代を走査し、その行に変化が
 * あった世代だけを古い順に並べる (初出・値の変化・消滅・再出現)。マスク設定 (#1069) は
 * 差分表と同じく表示だけ伏せる。
 */
export function TimelapseRowHistoryView({
  watchId,
  rowKey,
  onClose,
}: {
  watchId: number;
  rowKey: CellValue[];
  onClose: () => void;
}) {
  const t = useT();
  const { columnMaskEnabled, columnMaskPatterns } = useSettings();
  const [history, setHistory] = useState<TimelapseRowHistory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const keyText = JSON.stringify(rowKey);

  // biome-ignore lint/correctness/useExhaustiveDependencies: rowKey は keyText で追跡する (配列の同一性では再取得しない)
  useEffect(() => {
    let cancelled = false;
    setHistory(null);
    setError(null);
    api
      .timelapseRowHistory(watchId, rowKey)
      .then((h) => {
        if (!cancelled) setHistory(h);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [watchId, keyText]);

  const masked = useMemo(
    () =>
      history
        ? resolveMaskedColumns(history.columns, {
            enabled: columnMaskEnabled,
            patterns: columnMaskPatterns,
            overrides: {},
          })
        : null,
    [history, columnMaskEnabled, columnMaskPatterns],
  );

  const cellCss = {
    borderBottom: "1px solid var(--border)",
    padding: "var(--space-1) var(--space-2)",
    fontSize: "var(--text-sm)",
    fontFamily: "var(--font-mono)",
    whiteSpace: "nowrap" as const,
  };

  return (
    <chakra.section
      aria-label={t("timelapseRowHistoryAria")}
      data-testid="timelapse-row-history"
      display="flex"
      flexDirection="column"
      gap="2"
      borderWidth="1px"
      borderColor="app.border"
      borderRadius="md"
      p="3"
    >
      <Flex align="center" gap="2" flexWrap="wrap">
        <chakra.strong fontSize="sm">
          {t("timelapseRowHistoryTitle", { key: rowKey.map(formatTimelapseValue).join(", ") })}
        </chakra.strong>
        <chakra.span flex="1" />
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          {t("timelapseRowHistoryClose")}
        </Button>
      </Flex>
      {error && <ErrorNote role="alert">{error}</ErrorNote>}
      {!history && !error && (
        <Flex align="center" gap="2" role="status">
          <Spinner size={12} decorative />
          <chakra.span textStyle="caption">{t("timelapseRowHistoryLoading")}</chakra.span>
        </Flex>
      )}
      {history && (
        <>
          <chakra.p fontSize="xs" color="app.textSecondary">
            {history.entries.length === 0
              ? t("timelapseRowHistoryNone", { count: history.generations_scanned })
              : t("timelapseRowHistorySummary", {
                  changes: history.entries.length,
                  count: history.generations_scanned,
                })}
          </chakra.p>
          {history.partial && (
            <chakra.p fontSize="xs" color="app.textWarning">
              {t("timelapseRowHistoryPartial")}
            </chakra.p>
          )}
          {history.entries.length > 0 && (
            <chakra.div overflowX="auto">
              <chakra.table style={{ borderCollapse: "collapse" }}>
                <chakra.thead>
                  <chakra.tr>
                    <chakra.th css={cellCss} textAlign="left">
                      {t("timelapseRowHistoryColTime")}
                    </chakra.th>
                    {history.columns.map((c) => (
                      <chakra.th key={c} css={cellCss} textAlign="left">
                        {c}
                      </chakra.th>
                    ))}
                  </chakra.tr>
                </chakra.thead>
                <chakra.tbody>
                  {history.entries.map((e) => (
                    <chakra.tr key={e.generation_id} data-present={e.present}>
                      <chakra.td css={cellCss}>
                        {formatCaptured(e.captured_at)}
                        {!e.present && (
                          <chakra.span marginLeft="2" color="app.textError">
                            {t("timelapseRowHistoryGone")}
                          </chakra.span>
                        )}
                      </chakra.td>
                      {history.columns.map((c, i) => {
                        const changed = e.changed_columns.includes(c);
                        return (
                          <chakra.td
                            key={c}
                            css={cellCss}
                            data-changed={changed || undefined}
                            style={
                              changed ? { background: semanticColorVar("warning", "subtle") } : undefined
                            }
                            color={masked?.[i] ? "app.textMuted" : undefined}
                          >
                            {e.row ? (masked?.[i] ? MASK_TEXT : formatTimelapseValue(e.row[i])) : ""}
                          </chakra.td>
                        );
                      })}
                    </chakra.tr>
                  ))}
                </chakra.tbody>
              </chakra.table>
            </chakra.div>
          )}
        </>
      )}
    </chakra.section>
  );
}
