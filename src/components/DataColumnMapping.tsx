import { Box, chakra, type SystemStyleObject } from "@chakra-ui/react";
import { useEffect, useMemo, useState } from "react";

import { api } from "../api/tauri";
import { useT } from "../i18n";
import { assignableTargetColumns, type ColumnMapping, unmatchedSourceColumns } from "./columnMapping";
import { ListboxSelect } from "./ListboxSelect";

// データ比較の列の対応付け (#2099)。列名を変えた移行 (user_name → username など) の検証用。
// 同名の列は自動で対応付くので、ターゲットに相手がいない列だけを並べて割り当てを選ばせる。

const rootCss: SystemStyleObject = {
  display: "flex",
  flexDirection: "column",
  gap: "2",
  width: "100%",
  margin: "var(--space-2) 0",
};
const rowCss: SystemStyleObject = {
  display: "grid",
  gridTemplateColumns: "1fr auto 1fr",
  alignItems: "center",
  gap: "3",
};
const nameCss: SystemStyleObject = { fontFamily: "var(--font-mono)", fontSize: "sm", wordBreak: "break-all" };

interface Props {
  sourceSessionId: string;
  sourceDatabase: string;
  sourceTable: string;
  targetSessionId: string;
  targetDatabase: string;
  /** 比較に使うターゲット表 (同名指定なら `sourceTable`)。 */
  targetTable: string;
  /** 同名の照合規則 (MySQL / SQLite とドライバをまたぐ比較は true、PostgreSQL 同士は false)。 */
  caseInsensitive: boolean;
  mapping: ColumnMapping;
  onChange: (mapping: ColumnMapping) => void;
  /** 未割り当て (同名の相手がおらず対応表にも無い) のソース列の数が変わったら通知する。 */
  onUnassignedChange?: (count: number) => void;
  disabled?: boolean;
}

export function DataColumnMapping({
  sourceSessionId,
  sourceDatabase,
  sourceTable,
  targetSessionId,
  targetDatabase,
  targetTable,
  caseInsensitive,
  mapping,
  onChange,
  onUnassignedChange,
  disabled,
}: Props) {
  const t = useT();
  const [columns, setColumns] = useState<{ source: string[]; target: string[] } | null>(null);

  useEffect(() => {
    setColumns(null);
    if (!sourceTable || !targetTable) return;
    let cancelled = false;
    // 列が取れないときは何も出さない (比較そのものが同じ理由でエラーを返す)。
    void Promise.all([
      api.describeTable(sourceSessionId, sourceDatabase, sourceTable),
      api.describeTable(targetSessionId, targetDatabase, targetTable),
    ])
      .then(([s, tg]) => {
        if (!cancelled) setColumns({ source: s.map((c) => c.name), target: tg.map((c) => c.name) });
      })
      // 意図的に握りつぶす: 列が取れないときは対応付けの UI を出さないだけで、比較そのものが
      // 同じ理由でエラーを返してユーザーに見える。
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [sourceSessionId, sourceDatabase, sourceTable, targetSessionId, targetDatabase, targetTable]);

  const unmatched = useMemo(
    () => (columns ? unmatchedSourceColumns(columns.source, columns.target, mapping, caseInsensitive) : []),
    [columns, mapping, caseInsensitive],
  );
  const unassignedCount = unmatched.length;
  useEffect(() => {
    onUnassignedChange?.(unassignedCount);
  }, [unassignedCount, onUnassignedChange]);
  // アンマウント時 (表が未選択など) は未割り当てなしに戻す。
  useEffect(() => () => onUnassignedChange?.(0), [onUnassignedChange]);
  if (!columns) return null;
  const rows = columns.source.filter((c) => c in mapping || unmatched.includes(c));
  if (rows.length === 0) return null;

  return (
    <Box css={rootCss} role="group" aria-label={t("schemaCompareColMapTitle")}>
      <chakra.div textStyle="overline">{t("schemaCompareColMapTitle")}</chakra.div>
      <chakra.p margin={0} textStyle="caption" color="app.textMuted">
        {t("schemaCompareColMapHint")}
      </chakra.p>
      {rows.map((col) => (
        <Box key={col} css={rowCss}>
          <chakra.span css={nameCss}>{col}</chakra.span>
          <chakra.span textStyle="caption" aria-hidden="true">
            →
          </chakra.span>
          <ListboxSelect
            ariaLabel={t("schemaCompareColMapTarget", { column: col })}
            value={mapping[col] ?? ""}
            disabled={disabled}
            options={[
              { value: "", label: t("schemaCompareColMapNone") },
              ...assignableTargetColumns(
                columns.source,
                columns.target,
                mapping,
                caseInsensitive,
                mapping[col],
              ).map((name) => ({ value: name })),
            ]}
            onChange={(v) => {
              const next = { ...mapping };
              if (v === "") delete next[col];
              else next[col] = v;
              onChange(next);
            }}
            css={{ width: "100%" }}
          />
        </Box>
      ))}
      {unmatched.length > 0 && (
        <chakra.p margin={0} textStyle="caption" color="app.textWarning" role="status">
          {t("schemaCompareColMapUnassigned", { columns: unmatched.join(", ") })}
        </chakra.p>
      )}
    </Box>
  );
}
