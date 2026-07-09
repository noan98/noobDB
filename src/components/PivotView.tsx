import { useMemo, useState } from "react";
import { Box, chakra, Flex, type SystemStyleObject } from "@chakra-ui/react";

import type { QueryResult } from "../api/tauri";
import { useT } from "../i18n";
import { SEQUENTIAL_RAMPS, sampleRamp } from "../colorScale";
import { Button, Checkbox, Select } from "./ui";
import { Icon } from "./Icon";
import {
  buildPivotModel,
  buildPivotSql,
  defaultPivotConfig,
  firstNumericColumnIndex,
  type PivotAgg,
  type PivotConfig,
  type PivotModel,
} from "./pivotData";

/**
 * 結果グリッドのピボット / クロス集計ビュー (#661)。取得済みの結果セットを、行/列/値
 * フィールド + 集計関数でクロス集計し、小計・総計つきの表として描く。数値化・NULL の
 * 扱いは安全網・統計と共有する `pivotData.ts` (→ `cellConditionalFormat.toNumber`) に
 * 委ねる。値の強弱はヒートマップ (可視化共通スケール `colorScale.ts` #525) で任意に
 * 可視化する (表示専用)。**在メモリ (取得済み行) が対象**である点を明示し、全行を
 * DB 側で集計し直す GROUP BY SQL への変換導線 (エディタへ送る) を備える。
 * 計算ロジックは pivotData.ts に分離してテスト済み。
 */
interface Props {
  result: QueryResult;
  driver: string;
  /** ピボット元の実行 SQL。GROUP BY 変換導線で使う (無ければ導線を出さない)。 */
  sourceSql?: string;
  onSendToEditor?: (sql: string) => void;
  onClose: () => void;
}

const AGGS: PivotAgg[] = ["sum", "avg", "count", "min", "max"];
// ヒートマップの塗り不透明度 (テーマの背景を透かし、既定文字色の可読性を保つ)。
const HEAT_OPACITY = 45;
const RAMP = SEQUENTIAL_RAMPS.teal.stops;

const numFmt = new Intl.NumberFormat("en", { maximumFractionDigits: 2 });
function formatValue(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "";
  return numFmt.format(n);
}

const cellCss: SystemStyleObject = {
  border: "1px solid var(--border-subtle, var(--border))",
  padding: "4px 10px",
  fontSize: "var(--text-sm)",
  fontFamily: "var(--font-mono)",
  color: "var(--text)",
  whiteSpace: "nowrap",
  textAlign: "right",
};
const headCss: SystemStyleObject = {
  ...cellCss,
  background: "var(--bg-muted)",
  fontWeight: 600,
  color: "var(--text-secondary)",
  position: "sticky",
  top: 0,
  zIndex: 1,
};
const rowHeadCss: SystemStyleObject = {
  ...cellCss,
  textAlign: "left",
  fontWeight: 600,
  color: "var(--text)",
};
const totalCss: SystemStyleObject = {
  ...cellCss,
  fontWeight: 600,
  color: "var(--text-secondary)",
  borderTop: "2px solid var(--border)",
};

export function PivotView({ result, driver, sourceSql, onSendToEditor, onClose }: Props) {
  const t = useT();
  const [config, setConfig] = useState<PivotConfig | null>(() =>
    defaultPivotConfig(result.columns, result.rows),
  );
  const [heatmap, setHeatmap] = useState(true);
  const numericFieldIdx = useMemo(
    () => firstNumericColumnIndex(result.columns, result.rows),
    [result.columns, result.rows],
  );

  const model = useMemo<PivotModel | null>(
    () => (config ? buildPivotModel(result.columns, result.rows, config) : null),
    [config, result.columns, result.rows],
  );

  // ヒートマップの正規化レンジ (非 NULL セルの最小/最大)。行/列の小計・総計は含めない
  // (桁が大きく色が偏るため、セル本体だけを基準にする)。
  const heatRange = useMemo(() => {
    if (!model) return null;
    let min = Infinity;
    let max = -Infinity;
    for (const rowCells of model.cells) {
      for (const v of rowCells) {
        if (v == null || !Number.isFinite(v)) continue;
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    return Number.isFinite(min) && Number.isFinite(max) ? { min, max } : null;
  }, [model]);

  const cellBg = (v: number | null): string | undefined => {
    if (!heatmap || v == null || !Number.isFinite(v) || !heatRange) return undefined;
    const { min, max } = heatRange;
    const t01 = max > min ? (v - min) / (max - min) : 0.5;
    return `color-mix(in srgb, ${sampleRamp(t01, RAMP)} ${HEAT_OPACITY}%, transparent)`;
  };

  if (!config || !model) {
    return (
      <Flex direction="column" h="100%" align="center" justify="center" gap="3" color="app.textMuted">
        <Icon name="table" size={28} />
        <chakra.span>{t("pivotNoData")}</chakra.span>
        <Button type="button" variant="secondary" onClick={onClose}>
          {t("chartBackToTable")}
        </Button>
      </Flex>
    );
  }

  const hasValueField = config.valueField !== null && config.valueField >= 0;
  const rowColName = result.columns[config.rowField]?.name ?? "";
  const colColName = config.colField != null ? (result.columns[config.colField]?.name ?? "") : null;
  const valueColName = hasValueField ? (result.columns[config.valueField as number]?.name ?? "") : null;
  // GROUP BY 導線は、必要な列に名前があり (別名なし計算列などを除外)、元 SQL があるときだけ。
  const canSendSql =
    !!onSendToEditor &&
    !!sourceSql &&
    rowColName.length > 0 &&
    (config.colField == null || (colColName ?? "").length > 0) &&
    (config.agg === "count" || (valueColName ?? "").length > 0);

  const setRowField = (rowField: number) => setConfig({ ...config, rowField });
  const setColField = (v: string) => setConfig({ ...config, colField: v === "" ? null : Number(v) });
  const setValueField = (v: string) =>
    setConfig({ ...config, valueField: v === "" ? null : Number(v) });
  const setAgg = (agg: PivotAgg) => {
    // count 以外は値列が必須。未選択のまま切り替えると全セルが空になるため、
    // 最初の数値列を自動選択する (数値列が無ければ据え置き)。
    const needsValue = agg !== "count" && (config.valueField == null || config.valueField < 0);
    setConfig({
      ...config,
      agg,
      valueField: needsValue && numericFieldIdx != null ? numericFieldIdx : config.valueField,
    });
  };

  const sendSql = () => {
    if (!canSendSql || !onSendToEditor || !sourceSql) return;
    onSendToEditor(
      buildPivotSql({
        driver,
        sourceSql,
        rowColumn: rowColName,
        colColumn: colColName,
        valueColumn: valueColName,
        agg: config.agg,
      }),
    );
  };

  const effectiveColKeys = model.colFieldName == null ? [model.valueLabel] : model.colKeys;

  return (
    <Flex direction="column" h="100%" minH={0} minW={0}>
      {/* 設定バー */}
      <Flex
        align="center"
        gap="2.5"
        px="3"
        py="2"
        flex="none"
        borderBottomWidth="1px"
        borderBottomColor="app.border"
        flexWrap="wrap"
        fontSize="sm"
      >
        <Button type="button" variant="secondary" size="sm" onClick={onClose}>
          <Icon name="table" size={14} /> {t("chartBackToTable")}
        </Button>
        <Field label={t("pivotRowField")}>
          <Select value={config.rowField} onChange={(e) => setRowField(Number(e.target.value))} width="auto">
            {result.columns.map((c, i) => (
              <option key={i} value={i}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t("pivotColField")}>
          <Select value={config.colField ?? ""} onChange={(e) => setColField(e.target.value)} width="auto">
            <option value="">{t("pivotNone")}</option>
            {result.columns.map((c, i) => (
              <option key={i} value={i}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t("pivotAgg")}>
          <Select value={config.agg} onChange={(e) => setAgg(e.target.value as PivotAgg)} width="auto">
            {AGGS.map((a) => (
              <option key={a} value={a}>
                {t(`pivotAgg_${a}` as `pivotAgg_${PivotAgg}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t("pivotValueField")}>
          <Select value={config.valueField ?? ""} onChange={(e) => setValueField(e.target.value)} width="auto">
            <option value="">{config.agg === "count" ? "*" : t("pivotNone")}</option>
            {result.columns.map((c, i) => (
              <option key={i} value={i}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <chakra.label display="inline-flex" alignItems="center" gap="1" fontSize="xs" cursor="pointer">
          <Checkbox checked={heatmap} onChange={(e) => setHeatmap(e.target.checked)} />
          {t("pivotHeatmap")}
        </chakra.label>
        {canSendSql && (
          <Button type="button" variant="secondary" size="sm" onClick={sendSql} title={t("pivotSendSql")}>
            <Icon name="query" size={14} /> {t("pivotSendSql")}
          </Button>
        )}
      </Flex>

      {/* 在メモリの明示 + 間引き警告 */}
      <chakra.p margin={0} px="3" py="1.5" flex="none" fontSize="xs" color="app.textMuted">
        {t("pivotInMemoryNote", { count: result.rows.length })}
        {model.truncated && (
          <>
            {" "}
            <chakra.span color="var(--status-warning, var(--text-secondary))">
              {t("pivotTruncated", { rows: model.rowKeys.length, cols: model.colKeys.length })}
            </chakra.span>
          </>
        )}
      </chakra.p>

      <Box flex="1" overflow="auto" px="3" py="2">
        <chakra.table css={{ borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <chakra.th css={{ ...headCss, textAlign: "left" }}>
                {/* 行軸 × 列軸 の見出しコーナー */}
                {model.colFieldName ? `${model.rowFieldName} \\ ${model.colFieldName}` : model.rowFieldName}
              </chakra.th>
              {effectiveColKeys.map((ck, ci) => (
                <chakra.th key={ci} css={headCss}>
                  {ck}
                </chakra.th>
              ))}
              <chakra.th css={{ ...headCss, borderLeft: "2px solid var(--border)" }}>
                {t("pivotTotal")}
              </chakra.th>
            </tr>
          </thead>
          <tbody>
            {model.rowKeys.map((rk, ri) => (
              <tr key={ri}>
                <chakra.td css={rowHeadCss}>{rk}</chakra.td>
                {model.cells[ri].map((v, ci) => (
                  <chakra.td key={ci} css={cellCss} style={{ background: cellBg(v) }}>
                    {formatValue(v)}
                  </chakra.td>
                ))}
                <chakra.td css={{ ...cellCss, fontWeight: 600, borderLeft: "2px solid var(--border)" }}>
                  {formatValue(model.rowTotals[ri])}
                </chakra.td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <chakra.td css={{ ...totalCss, textAlign: "left" }}>{t("pivotTotal")}</chakra.td>
              {model.colTotals.map((v, ci) => (
                <chakra.td key={ci} css={totalCss}>
                  {formatValue(v)}
                </chakra.td>
              ))}
              <chakra.td css={{ ...totalCss, borderLeft: "2px solid var(--border)" }}>
                {formatValue(model.grandTotal)}
              </chakra.td>
            </tr>
          </tfoot>
        </chakra.table>
      </Box>
    </Flex>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Flex align="center" gap="1.5">
      <chakra.span color="app.textMuted" fontSize="xs">
        {label}
      </chakra.span>
      {children}
    </Flex>
  );
}
