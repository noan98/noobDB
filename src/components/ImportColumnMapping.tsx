import { chakra } from "@chakra-ui/react";
import { forwardRef, useMemo } from "react";
import type { CsvPreview, TableColumnInfo } from "../api/tauri";
import { useT } from "../i18n";
import { Callout } from "./Callout";
import { CELL_KIND_META, classifyTypeName, normalizeTypeForClassify, shortTypeName } from "./cellTypeMeta";
import { Icon, ICON_SIZES } from "./Icon";
import { missingRequiredColumns, mappingRowState, mappingSummary, sampleValue } from "./importMappingCheck";
import { ListboxSelect } from "./ListboxSelect";
import { FieldLabel } from "./modalForm";
import { Tooltip } from "./Tooltip";

/**
 * 取り込みの列対応付け (#2126)。各行は
 * `[ファイル列: 選択 + 先頭行のサンプル値] → [テーブル列: 型グリフ + 型名 + PK / NOT NULL]`
 * の 3 カラム (データ比較の `DataColumnMapping` と同じ構成)。行の状態は左端の罫線と
 * アイコンで示し、必須列 (NOT NULL かつ既定値・自動採番なし) の欠落は実行前に警告する。
 * 取り込みの可否は変えない (警告のみ。実際の検証は dry-run / バックエンド)。
 */

const rowStateColor = {
  mapped: "app.border",
  skipped: "app.borderSubtle",
  required: "app.textWarning",
} as const;

interface Props {
  driver: string;
  tableColumns: TableColumnInfo[];
  preview: CsvPreview;
  mapping: Record<string, number | null>;
  /** ファイル側の列の表示名 (`1. name` / `列 1`)。 */
  fileColumnLabel: (index: number) => string;
  onChange: (column: string, csvIndex: number | null) => void;
  disabled?: boolean;
}

export function ImportColumnMapping({
  driver,
  tableColumns,
  preview,
  mapping,
  fileColumnLabel,
  onChange,
  disabled,
}: Props) {
  const t = useT();
  const summary = useMemo(() => mappingSummary(tableColumns, mapping), [tableColumns, mapping]);
  const missing = useMemo(
    () => missingRequiredColumns(driver, tableColumns, mapping),
    [driver, tableColumns, mapping],
  );
  const options = useMemo(
    () => [
      { value: "", label: t("importSkipColumn") },
      ...preview.headers.map((_, idx) => ({ value: String(idx), label: fileColumnLabel(idx) })),
    ],
    [preview.headers, fileColumnLabel, t],
  );

  return (
    <>
      <chakra.div display="flex" alignItems="center" gap="2" flexWrap="wrap">
        <FieldLabel as="div">{t("importMappingTitle")}</FieldLabel>
        <chakra.span
          data-testid="import-mapping-summary"
          textStyle="overline"
          px="1.5"
          py="0.25"
          borderRadius="pill"
          borderWidth="1px"
          borderColor="app.border"
          color={missing.length > 0 ? "app.textWarning" : "app.textSecondary"}
          whiteSpace="nowrap"
        >
          {t("importMappingSummary", { mapped: summary.mapped, total: summary.total })}
        </chakra.span>
      </chakra.div>
      {missing.length > 0 && (
        <Callout tone="warning" role="status" data-testid="import-mapping-required-warning">
          {t("importMappingRequiredWarning", { count: missing.length, columns: missing.join(", ") })}
        </Callout>
      )}
      <chakra.div display="flex" flexDirection="column" gap="1" maxH="50vh" overflowY="auto">
        {tableColumns.map((col) => {
          const idx = mapping[col.name] ?? null;
          const state = mappingRowState(driver, col, tableColumns, idx);
          const kind = classifyTypeName(normalizeTypeForClassify(col.data_type));
          const sample = sampleValue(preview.rows, idx);
          return (
            <chakra.div
              key={col.name}
              data-testid={`import-mapping-row-${col.name}`}
              data-state={state}
              display="grid"
              gridTemplateColumns="minmax(0, 1fr) auto minmax(0, 1fr)"
              alignItems="center"
              gap="2"
              pl="2"
              pr="1"
              py="1"
              borderLeftWidth="3px"
              borderLeftStyle="solid"
              borderLeftColor={rowStateColor[state]}
              opacity={state === "skipped" ? 0.7 : 1}
            >
              <chakra.div display="flex" flexDirection="column" gap="0.5" minW="0">
                <ListboxSelect
                  css={{ width: "100%", minWidth: 0 }}
                  value={idx === null ? "" : String(idx)}
                  options={options}
                  onChange={(v) => onChange(col.name, v === "" ? null : Number(v))}
                  disabled={disabled}
                  ariaLabel={t("importMappingAria", { column: col.name })}
                />
                {idx !== null && (
                  <chakra.span
                    textStyle="caption"
                    fontFamily="mono"
                    color="app.textMuted"
                    overflow="hidden"
                    textOverflow="ellipsis"
                    whiteSpace="nowrap"
                    title={sample ?? undefined}
                    data-testid={`import-mapping-sample-${col.name}`}
                  >
                    {sample === null ? "—" : sample === "" ? t("importMappingSampleEmpty") : sample}
                  </chakra.span>
                )}
              </chakra.div>
              <chakra.span
                aria-hidden="true"
                display="inline-flex"
                alignItems="center"
                color={state === "required" ? "app.textWarning" : "app.textMuted"}
              >
                <chakra.span
                  display="inline-block"
                  width="var(--space-4)"
                  borderTopWidth="1px"
                  borderTopStyle={idx === null ? "dashed" : "solid"}
                  borderTopColor="currentColor"
                />
                <Icon name="chevron-right" size={ICON_SIZES.sm} />
              </chakra.span>
              <chakra.div display="flex" flexDirection="column" gap="0.5" minW="0">
                <chakra.div display="flex" alignItems="center" gap="1.5" minW="0">
                  <chakra.span
                    role="img"
                    aria-label={t(CELL_KIND_META[kind].labelKey)}
                    display="inline-flex"
                    flexShrink={0}
                    color="app.textSecondary"
                  >
                    <Icon name={CELL_KIND_META[kind].icon} size={ICON_SIZES.sm} />
                  </chakra.span>
                  <chakra.span
                    fontFamily="mono"
                    fontSize="md"
                    overflow="hidden"
                    textOverflow="ellipsis"
                    whiteSpace="nowrap"
                  >
                    {col.name}
                  </chakra.span>
                  <chakra.span textStyle="caption" fontFamily="mono" whiteSpace="nowrap">
                    {shortTypeName(col.data_type)}
                  </chakra.span>
                  {col.key === "PRI" && (
                    <Tooltip label={t("colPkTitle")}>
                      <Pill color="app.keyAccent">{t("indexBadgePk")}</Pill>
                    </Tooltip>
                  )}
                  {!col.nullable && <Pill color="app.text">{t("structureNullableNo")}</Pill>}
                </chakra.div>
                {state === "required" && (
                  <chakra.span
                    textStyle="caption"
                    color="app.textWarning"
                    display="inline-flex"
                    alignItems="center"
                    gap="1"
                    role="status"
                  >
                    <Icon name="warning" size={ICON_SIZES.sm} />
                    {t("importMappingRequiredRow")}
                  </chakra.span>
                )}
              </chakra.div>
            </chakra.div>
          );
        })}
      </chakra.div>
    </>
  );
}

const Pill = forwardRef<HTMLSpanElement, { color: string; children: string }>(function Pill(
  { color, children, ...rest },
  ref,
) {
  return (
    <chakra.span
      ref={ref}
      {...rest}
      textStyle="overline"
      px="1.5"
      py="0.25"
      borderRadius="pill"
      borderWidth="1px"
      borderColor="app.border"
      color={color}
      whiteSpace="nowrap"
      flexShrink={0}
    >
      {children}
    </chakra.span>
  );
});
