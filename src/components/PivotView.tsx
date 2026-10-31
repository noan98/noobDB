import { useMemo, useRef, useState } from "react";
import { Box, chakra, Flex, type SystemStyleObject } from "@chakra-ui/react";

import type { QueryResult } from "../api/tauri";
import { useT } from "../i18n";
import { SEQUENTIAL_RAMPS, rampStops, sampleRamp, useIsDarkTheme } from "../colorScale";
import { semanticColorToken } from "../semanticColors";
import { Button, Checkbox } from "./ui";
import { Icon, ICON_SIZES } from "./Icon";
import { ImageExportButton } from "./ImageExportButton";
import { TextExportButton } from "./TextExportButton";
import { tableToCsv, tableToMarkdown } from "./tabularText";
import { elementToPngBlob, elementToSvgBytes } from "./imageExport";
import { ListboxSelect } from "./ListboxSelect";
import { ResultViewSwitch, type ResultViewKind } from "./ResultViewSwitch";
import { useRowCrossfade } from "./useRowCrossfade";
import { integerCountUpTarget, useCountUp } from "../useCountUp";
import {
  buildPivotModel,
  buildPivotSql,
  defaultPivotConfig,
  firstNumericColumnIndex,
  pivotModelTable,
  pivotConfigKeyFrom,
  readStoredPivotConfig,
  writeStoredPivotConfig,
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
 *
 * **設定の永続化 (#909)**: 行/列/値フィールドと集計関数は `sourceSql` の
 * フィンガープリント単位で localStorage に保存し、同じクエリの再実行・タブ切替・
 * タブ復元・再起動をまたいで復元する (`pivotData.ts` の
 * `readStoredPivotConfig`/`writeStoredPivotConfig`)。列構成が変わって保存済みの
 * 参照が成立しなくなった場合は `sanitizePivotConfig` が検出して安全に既定値へ
 * 縮退する。
 */
interface Props {
  result: QueryResult;
  driver: string;
  /** ピボット元の実行 SQL。GROUP BY 変換導線で使う (無ければ導線を出さない)。 */
  sourceSql?: string;
  onSendToEditor?: (sql: string) => void;
  /**
   * 結果パネルの表示切替 (グリッド / ピボット / チャート)。設定バー先頭の
   * `ResultViewSwitch` と、集計できるデータが無いときの空状態から呼ばれる。
   */
  onChangeView: (view: ResultViewKind) => void;
}

const AGGS: PivotAgg[] = ["sum", "avg", "count", "min", "max"];
// ヒートマップの塗り不透明度 (テーマの背景を透かし、既定文字色の可読性を保つ)。
const HEAT_OPACITY = 45;

const numFmt = new Intl.NumberFormat("en", { maximumFractionDigits: 2 });
function formatValue(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "";
  return numFmt.format(n);
}

// 集計セルをカウントアップ補間する上限セル数。セルごとに補間用の state を持つため、
// 上限 (200 行 x 100 列) いっぱいの大きな表では静的表示に留めて描画負荷を抑える。
const COUNT_UP_MAX_CELLS = 600;

const cellCss: SystemStyleObject = {
  border: "1px solid var(--border-subtle, var(--border))",
  padding: "var(--space-1) var(--space-2-5)",
  fontSize: "var(--text-sm)",
  fontFamily: "var(--font-mono)",
  color: "var(--text)",
  whiteSpace: "nowrap",
  textAlign: "right",
};
// ヒートが載る本体セルだけ背景色を補間する (見出し・合計には付けない)。reduced-motion は App.css が一括で即時化。
const heatCellCss: SystemStyleObject = {
  ...cellCss,
  transition: "background-color var(--dur-med) var(--ease)",
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

export function PivotView({ result, driver, sourceSql, onSendToEditor, onChangeView }: Props) {
  const t = useT();
  // ダークテーマでは「暗→明」の向きへ切り替える (#1187)。
  const isDark = useIsDarkTheme();
  const ramp = rampStops(SEQUENTIAL_RAMPS.teal, isDark);
  // 永続化キーは実行 SQL のフィンガープリント (#909)。クエリ再実行のたびに
  // PivotView はストリーミング状態を経由して remount されるため (App.tsx の
  // `!tab.streaming` 条件)、useState の初期化関数だけで再実行時の復元が完結する。
  const persistKey = useMemo(() => pivotConfigKeyFrom(sourceSql), [sourceSql]);
  const [config, setConfigState] = useState<PivotConfig | null>(
    () =>
      readStoredPivotConfig(persistKey, result.columns) ?? defaultPivotConfig(result.columns, result.rows),
  );
  const setConfig = (next: PivotConfig) => {
    setConfigState(next);
    writeStoredPivotConfig(persistKey, next);
  };
  const [heatmap, setHeatmap] = useState(true);
  const numericFieldIdx = useMemo(
    () => firstNumericColumnIndex(result.columns, result.rows),
    [result.columns, result.rows],
  );

  const model = useMemo<PivotModel | null>(
    () => (config ? buildPivotModel(result.columns, result.rows, config) : null),
    [config, result.columns, result.rows],
  );

  // 設定 (行/列/値/集計/ヒートマップ) の確定で再集計されたコミットの 1 回だけ、<tbody> を
  // クロスフェードする (#1862)。結果グリッドのソート (#1416) と同じ「要素単位で 1 回・再マウント
  // なし」の方針なのでスクロール位置は保たれる。設定は離散操作なので sort 側 (即時再生) に載せる。
  const tbodyRef = useRef<HTMLTableSectionElement>(null);
  // 画像エクスポート (#1956) で捕捉する <table> への参照。
  const tableRef = useRef<HTMLTableElement>(null);
  const fadeKeys = useMemo(
    () => ({ sort: JSON.stringify([config, heatmap]), filter: "" }),
    [config, heatmap],
  );
  useRowCrossfade(tbodyRef, fadeKeys, persistKey ?? "");

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
    return `color-mix(in srgb, ${sampleRamp(t01, ramp)} ${HEAT_OPACITY}%, transparent)`;
  };

  if (!config || !model) {
    // 集計できるデータが無い空状態でも、設定バーの位置に切替セグメントを残す
    // (チャートへ直接移れるようにし、往復の導線をビューの状態に依らず一定にする)。
    return (
      <Flex direction="column" h="100%" minH={0} minW={0}>
        <Flex align="center" px="3" py="2" flex="none" borderBottomWidth="1px" borderBottomColor="app.border">
          <ResultViewSwitch value="pivot" onChange={onChangeView} />
        </Flex>
        <Flex
          flex="1"
          minH={0}
          direction="column"
          align="center"
          justify="center"
          gap="3"
          color="app.textMuted"
        >
          <Icon name="table" size={ICON_SIZES.xl} />
          <chakra.span>{t("pivotNoData")}</chakra.span>
          <Button type="button" variant="secondary" onClick={() => onChangeView("grid")}>
            {t("chartBackToTable")}
          </Button>
        </Flex>
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
  const setValueField = (v: string) => setConfig({ ...config, valueField: v === "" ? null : Number(v) });
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

  const getTableForExport = (): HTMLElement => {
    if (!tableRef.current) throw new Error("pivot is not rendered");
    return tableRef.current;
  };
  // スクロール領域に隠れた部分も含め、表の全体を画像にする。
  const tableExportSize = (el: HTMLElement) => ({ width: el.scrollWidth, height: el.scrollHeight });

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
  const countUpEnabled = model.rowKeys.length * (effectiveColKeys.length + 1) <= COUNT_UP_MAX_CELLS;
  // 整数の数値セルは前値→新値を補間する (`slot` は意味のキー: 軸が変わったら別セルとして
  // 作り直され、別グループ同士の値は補間せずジャンプする)。小数 (平均など)・NULL・
  // 上限超過は静的表示。
  const renderValue = (v: number | null, slot: string) =>
    countUpEnabled && integerCountUpTarget(v) != null ? (
      <PivotNumber key={slot} value={v as number} />
    ) : (
      formatValue(v)
    );

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
        <ResultViewSwitch value="pivot" onChange={onChangeView} />
        <Field label={t("pivotRowField")}>
          <ListboxSelect
            value={String(config.rowField)}
            ariaLabel={t("pivotRowField")}
            onChange={(v) => setRowField(Number(v))}
            options={result.columns.map((c, i) => ({ value: String(i), label: c.name }))}
          />
        </Field>
        <Field label={t("pivotColField")}>
          <ListboxSelect
            value={config.colField != null ? String(config.colField) : ""}
            ariaLabel={t("pivotColField")}
            onChange={(v) => setColField(v)}
            options={[
              { value: "", label: t("pivotNone") },
              ...result.columns.map((c, i) => ({ value: String(i), label: c.name })),
            ]}
          />
        </Field>
        <Field label={t("pivotAgg")}>
          <ListboxSelect
            value={config.agg}
            ariaLabel={t("pivotAgg")}
            onChange={(v) => setAgg(v as PivotAgg)}
            options={AGGS.map((a) => ({
              value: a,
              label: t(`pivotAgg_${a}` as `pivotAgg_${PivotAgg}`),
            }))}
          />
        </Field>
        <Field label={t("pivotValueField")}>
          <ListboxSelect
            value={config.valueField != null ? String(config.valueField) : ""}
            ariaLabel={t("pivotValueField")}
            onChange={(v) => setValueField(v)}
            options={[
              { value: "", label: config.agg === "count" ? "*" : t("pivotNone") },
              ...result.columns.map((c, i) => ({ value: String(i), label: c.name })),
            ]}
          />
        </Field>
        <ImageExportButton
          filenameBase="pivot"
          makePng={(opts) =>
            elementToPngBlob(getTableForExport(), { ...tableExportSize(getTableForExport()), ...opts })
          }
          makeSvg={() => elementToSvgBytes(getTableForExport(), tableExportSize(getTableForExport()))}
        />
        {/* 集計した表そのものを、画像ではなくデータとして CSV / Markdown に出す (#1956)。 */}
        <TextExportButton
          filenameBase="pivot"
          label={t("chartDataExport")}
          formats={[
            {
              id: "csv",
              label: "CSV",
              build: () => {
                const { header, rows } = pivotModelTable(model, t("pivotTotal"));
                return tableToCsv(header, rows);
              },
            },
            {
              id: "markdown",
              label: "Markdown",
              build: () => {
                const { header, rows } = pivotModelTable(model, t("pivotTotal"));
                return tableToMarkdown(header, rows);
              },
            },
          ]}
        />
        <chakra.label display="inline-flex" alignItems="center" gap="1" fontSize="xs" cursor="pointer">
          <Checkbox checked={heatmap} onChange={(e) => setHeatmap(e.target.checked)} />
          {t("pivotHeatmap")}
        </chakra.label>
        {canSendSql && (
          // ラベルはボタン内に可視テキストとして出ているため、native `title=` は
          // 同じ文字列の重複だった (#884)。
          <Button type="button" variant="secondary" size="sm" onClick={sendSql}>
            <Icon name="query" size={ICON_SIZES.md} /> {t("pivotSendSql")}
          </Button>
        )}
      </Flex>

      {/* 在メモリの明示 + 間引き警告 */}
      <chakra.p margin={0} px="3" py="1.5" flex="none" fontSize="xs" color="app.textMuted">
        {t("pivotInMemoryNote", { count: result.rows.length })}
        {model.truncated && (
          <>
            {" "}
            <chakra.span color={semanticColorToken("warning", "text")}>
              {t("pivotTruncated", { rows: model.rowKeys.length, cols: model.colKeys.length })}
            </chakra.span>
          </>
        )}
      </chakra.p>

      <Box flex="1" overflow="auto" px="3" py="2">
        <chakra.table ref={tableRef} css={{ borderCollapse: "collapse" }}>
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
          <tbody ref={tbodyRef}>
            {model.rowKeys.map((rk, ri) => (
              <tr key={ri}>
                <chakra.td css={rowHeadCss}>{rk}</chakra.td>
                {model.cells[ri].map((v, ci) => (
                  <chakra.td key={ci} css={heatCellCss} style={{ background: cellBg(v) }}>
                    {renderValue(v, `${rk}\u0000${effectiveColKeys[ci]}`)}
                  </chakra.td>
                ))}
                <chakra.td css={{ ...cellCss, fontWeight: 600, borderLeft: "2px solid var(--border)" }}>
                  {renderValue(model.rowTotals[ri], `${rk}\u0000total`)}
                </chakra.td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <chakra.td css={{ ...totalCss, textAlign: "left" }}>{t("pivotTotal")}</chakra.td>
              {model.colTotals.map((v, ci) => (
                <chakra.td key={ci} css={totalCss}>
                  {renderValue(v, `total\u0000${effectiveColKeys[ci]}`)}
                </chakra.td>
              ))}
              <chakra.td css={{ ...totalCss, borderLeft: "2px solid var(--border)" }}>
                {renderValue(model.grandTotal, "total")}
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

/**
 * 整数セルのカウントアップ表示。見える桁 1 つだけを描く (`CountUp` は読み上げ用の
 * VisuallyHidden も描くため、表のドラッグ選択コピーで値が二重になる)。`td` は aria-live
 * ではないので、補間中の途中値が連続で読み上げられることはない。
 */
function PivotNumber({ value }: { value: number }) {
  const { display } = useCountUp(value);
  return <chakra.span textStyle="numeric">{numFmt.format(display)}</chakra.span>;
}
