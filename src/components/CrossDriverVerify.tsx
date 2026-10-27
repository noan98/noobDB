import { Box, chakra } from "@chakra-ui/react";

import type { CellValue, DataDiff, NormalizedColumn, NormalizeKind, RowDiff } from "../api/tauri";
import { type I18nKey, useT } from "../i18n";
import { Callout } from "./Callout";

/** 検証結果に並べる差分行の上限 (画面の都合。件数の集計は全行ぶん)。 */
export const CROSS_VERIFY_ROW_LIMIT = 100;
/** 1 セルの表示文字数の上限。長い値は省略する。 */
const CELL_MAX_CHARS = 60;

const NORMALIZE_MESSAGE_KEYS: Record<NormalizeKind, I18nKey> = {
  boolean: "schemaCompareCrossNormBoolean",
  decimal_scale: "schemaCompareCrossNormDecimalScale",
  decimal_float: "schemaCompareCrossNormDecimalFloat",
  decimal_clamped: "schemaCompareCrossNormDecimalClamped",
  timestamp_tz_degraded: "schemaCompareCrossNormTimestampTz",
  timestamp_format: "schemaCompareCrossNormTimestampFormat",
  json: "schemaCompareCrossNormJson",
  float_compare: "schemaCompareCrossNormFloatCompare",
};

const ROW_LABEL_KEYS = {
  source_only: "schemaCompareCrossRowSourceOnly",
  target_only: "schemaCompareCrossRowTargetOnly",
  different: "schemaCompareCrossRowDifferent",
} as const satisfies Record<RowDiff["status"], I18nKey>;

/** セルを 1 行の文字列にする (NULL は NULL、長い値は省略)。 */
export function formatCrossCell(v: CellValue | undefined): string {
  if (v === null || v === undefined) return "NULL";
  const text = typeof v === "string" ? JSON.stringify(v) : String(v);
  return text.length > CELL_MAX_CHARS ? `${text.slice(0, CELL_MAX_CHARS)}…` : text;
}

/** 比較前から出す「検証専用」の案内。 */
export function CrossDriverNotice() {
  const t = useT();
  return (
    <Callout tone="info" title={t("schemaCompareCrossTitle")} role="status">
      {t("schemaCompareCrossBody")}
    </Callout>
  );
}

function RowItem({ row, diff }: { row: RowDiff; diff: DataDiff }) {
  const t = useT();
  const key = row.key.map(formatCrossCell).join(", ");
  const changes =
    row.status === "different"
      ? row.changed_columns.map((col) => {
          const i = diff.columns.indexOf(col);
          return `${col}: ${formatCrossCell(row.source?.[i])} → ${formatCrossCell(row.target?.[i])}`;
        })
      : [];
  return (
    <chakra.li display="flex" flexWrap="wrap" gap="2" alignItems="baseline">
      <chakra.span fontWeight={600}>{t(ROW_LABEL_KEYS[row.status])}</chakra.span>
      <chakra.span textStyle="numeric">
        {diff.primary_key.join(", ")} = {key}
      </chakra.span>
      {changes.length > 0 && (
        <chakra.span textStyle="numeric" color="app.textMuted" wordBreak="break-all">
          {changes.join(" / ")}
        </chakra.span>
      )}
    </chakra.li>
  );
}

/**
 * ドライバをまたぐデータ比較の結果 (検証専用, #1869)。同期 SQL は出さず、一致の可否・差分行・
 * 表現の違いを同一視した列を見せる。
 */
export function CrossDriverResult({ diff, normalized }: { diff: DataDiff; normalized: NormalizedColumn[] }) {
  const t = useT();
  const counts = { source_only: 0, target_only: 0, different: 0 };
  for (const r of diff.rows) counts[r.status] += 1;
  const shown = diff.rows.slice(0, CROSS_VERIFY_ROW_LIMIT);
  return (
    <Box display="flex" flexDirection="column" gap="2">
      {diff.rows.length === 0 && !diff.truncated ? (
        <Callout tone="success" title={t("schemaCompareCrossMatchTitle")} role="status">
          {t("schemaCompareCrossMatchBody", {
            count: diff.source_count.toLocaleString(),
            target: diff.target_count.toLocaleString(),
          })}
        </Callout>
      ) : (
        diff.rows.length > 0 && (
          <Callout tone="danger" title={t("schemaCompareCrossDiffTitle")} role="status">
            {t("schemaCompareCrossSummary", {
              sourceOnly: counts.source_only.toLocaleString(),
              targetOnly: counts.target_only.toLocaleString(),
              different: counts.different.toLocaleString(),
            })}
          </Callout>
        )
      )}
      {normalized.length > 0 && (
        <Callout tone="warning" title={t("schemaCompareCrossNormalizedTitle")} role="status">
          <chakra.ul listStyleType="disc" pl="4" m="0">
            {normalized.map((n) => (
              <li key={`${n.column}:${n.kind}`}>
                {t(NORMALIZE_MESSAGE_KEYS[n.kind], {
                  column: n.column,
                  source: n.source_type,
                  target: n.target_type,
                })}
              </li>
            ))}
          </chakra.ul>
        </Callout>
      )}
      {shown.length > 0 && (
        <chakra.ul
          listStyleType="none"
          m="0"
          p="0"
          display="flex"
          flexDirection="column"
          gap="1"
          fontSize="sm"
        >
          {shown.map((row, i) => (
            <RowItem key={`${i}:${row.key.join("|")}`} row={row} diff={diff} />
          ))}
        </chakra.ul>
      )}
      {diff.rows.length > shown.length && (
        <chakra.p m="0" textStyle="caption" color="app.textMuted">
          {t("schemaCompareCrossRowsMore", {
            count: (diff.rows.length - shown.length).toLocaleString(),
            shown: shown.length,
          })}
        </chakra.p>
      )}
    </Box>
  );
}

/**
 * ドライバをまたぐ比較で返るバックエンドの主なエラーを、画面の言語の案内にする (#1869)。
 * 該当しないエラーは元の文言のまま返す。
 */
export function crossDriverErrorKey(message: string): I18nKey | null {
  if (message.includes("supports integer primary keys only")) return "schemaCompareCrossErrIntegerKey";
  if (message.includes("matches multiple columns on the target"))
    return "schemaCompareCrossErrAmbiguousColumn";
  if (message.includes("is missing column(s)")) return "schemaCompareCrossErrMissingColumns";
  return null;
}
