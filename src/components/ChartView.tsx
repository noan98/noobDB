import { useMemo, useState } from "react";
import { chakra, Flex } from "@chakra-ui/react";
import type { QueryResult } from "../api/tauri";
import { useT } from "../i18n";
import { Button, Select } from "./ui";
import { Icon } from "./Icon";
import {
  buildChartModel,
  defaultChartConfig,
  inferNumericColumns,
  valueExtent,
  type Aggregation,
  type ChartType,
  type ChartConfig,
  type ChartModel,
} from "./chartData";

/**
 * クエリ結果のチャート可視化 (#440)。取得済みの結果セットを入力に、棒/折れ線/面/円
 * グラフを SVG で描画する (チャートライブラリ非依存でバンドル増を避ける)。X/Y 軸と
 * 集計はユーザが選べる。色は CSS 変数 (--accent ほか) を参照しテーマに追従する。
 * データ整形の純ロジックは chartData.ts に分離してテスト済み。
 */
interface Props {
  result: QueryResult;
  onClose: () => void;
}

// 系列の配色 (アクセント + 区別しやすい固定パレット)。テーマ非依存に視認できる色。
const SERIES_COLORS = [
  "var(--accent)",
  "#10b981",
  "#f59e0b",
  "#6366f1",
  "#ec4899",
  "#14b8a6",
  "#ef4444",
  "#8b5cf6",
];

export function ChartView({ result, onClose }: Props) {
  const t = useT();
  const numericCols = useMemo(
    () => inferNumericColumns(result.columns, result.rows),
    [result.columns, result.rows],
  );
  const [config, setConfig] = useState<ChartConfig | null>(() =>
    defaultChartConfig(result.columns, result.rows),
  );

  const model = useMemo<ChartModel | null>(
    () => (config ? buildChartModel(result.columns, result.rows, config) : null),
    [config, result.columns, result.rows],
  );

  if (!config || !model) {
    return (
      <Flex direction="column" h="100%" align="center" justify="center" gap="12px" color="app.textMuted">
        <Icon name="query" size={28} />
        <chakra.span>{t("chartNoNumeric")}</chakra.span>
        <Button type="button" variant="secondary" onClick={onClose}>
          {t("chartBackToTable")}
        </Button>
      </Flex>
    );
  }

  const setType = (type: ChartType) => setConfig({ ...config, type });
  const setX = (xCol: number) => setConfig({ ...config, xCol });
  const setAgg = (aggregation: Aggregation) => setConfig({ ...config, aggregation });
  const toggleY = (c: number) =>
    setConfig({
      ...config,
      yCols: config.yCols.includes(c)
        ? config.yCols.filter((y) => y !== c)
        : [...config.yCols, c],
    });

  return (
    <Flex direction="column" h="100%" minH={0} minW={0}>
      {/* 設定バー */}
      <Flex align="center" gap="10px" px="12px" py="8px" flex="none" borderBottomWidth="1px" borderBottomColor="app.border" flexWrap="wrap" fontSize="sm">
        <Button type="button" variant="secondary" size="sm" onClick={onClose}>
          <Icon name="table" size={14} /> {t("chartBackToTable")}
        </Button>
        <Field label={t("chartType")}>
          <Select value={config.type} onChange={(e) => setType(e.target.value as ChartType)} width="auto">
            <option value="bar">{t("chartTypeBar")}</option>
            <option value="line">{t("chartTypeLine")}</option>
            <option value="area">{t("chartTypeArea")}</option>
            <option value="pie">{t("chartTypePie")}</option>
          </Select>
        </Field>
        <Field label={t("chartXAxis")}>
          <Select value={config.xCol} onChange={(e) => setX(Number(e.target.value))} width="auto">
            {result.columns.map((c, i) => (
              <option key={i} value={i}>{c.name}</option>
            ))}
          </Select>
        </Field>
        <Field label={t("chartAggregation")}>
          <Select value={config.aggregation} onChange={(e) => setAgg(e.target.value as Aggregation)} width="auto">
            <option value="none">{t("chartAggNone")}</option>
            <option value="sum">SUM</option>
            <option value="avg">AVG</option>
            <option value="count">COUNT</option>
          </Select>
        </Field>
        <Field label={t("chartYAxis")}>
          <Flex gap="8px" flexWrap="wrap">
            {result.columns.map((c, i) =>
              numericCols[i] && i !== config.xCol ? (
                <chakra.label key={i} display="inline-flex" alignItems="center" gap="4px" fontSize="xs" cursor="pointer">
                  <input type="checkbox" checked={config.yCols.includes(i)} onChange={() => toggleY(i)} />
                  {c.name}
                </chakra.label>
              ) : null,
            )}
          </Flex>
        </Field>
      </Flex>

      {model.sampledFrom != null && (
        <chakra.div px="12px" py="4px" fontSize="xs" color="app.textMuted" flex="none">
          {t("chartSampled", { shown: model.labels.length, total: model.sampledFrom })}
        </chakra.div>
      )}

      {/* 凡例 */}
      {config.type !== "pie" && model.series.length > 0 && (
        <Flex gap="12px" px="12px" py="4px" flex="none" flexWrap="wrap" fontSize="xs" color="app.textSecondary">
          {model.series.map((s, i) => (
            <Flex key={s.name} align="center" gap="5px">
              <chakra.span w="10px" h="10px" borderRadius="2px" bg={SERIES_COLORS[i % SERIES_COLORS.length]} />
              {s.name}
            </Flex>
          ))}
        </Flex>
      )}

      <chakra.div flex="1" minH={0} overflow="auto" p="12px">
        {model.labels.length === 0 ? (
          <chakra.div color="app.textMuted" fontSize="sm">{t("chartNoData")}</chakra.div>
        ) : config.yCols.length === 0 ? (
          <chakra.div color="app.textMuted" fontSize="sm">{t("chartPickY")}</chakra.div>
        ) : config.type === "pie" ? (
          <PieChart model={model} />
        ) : (
          <CartesianChart model={model} type={config.type} />
        )}
      </chakra.div>
    </Flex>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Flex align="center" gap="6px">
      <chakra.span color="app.textMuted" fontSize="xs">{label}</chakra.span>
      {children}
    </Flex>
  );
}

const W = 900;
const H = 420;
const PAD = { left: 56, right: 16, top: 12, bottom: 56 };

function CartesianChart({ model, type }: { model: ChartModel; type: ChartType }) {
  const { min, max } = valueExtent(model);
  const span = max - min || 1;
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const n = model.labels.length;
  // ラベル間隔。X 位置はバンド中央。
  const bandW = plotW / Math.max(1, n);
  const xAt = (i: number) => PAD.left + bandW * i + bandW / 2;
  const yAt = (v: number) => PAD.top + plotH - ((v - min) / span) * plotH;
  const zeroY = yAt(0);

  // X 軸ラベルは多すぎると間引く。
  const labelStep = Math.ceil(n / 16);

  return (
    <chakra.svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ maxHeight: "100%" }} role="img">
      {/* 軸 */}
      <line x1={PAD.left} y1={PAD.top} x2={PAD.left} y2={PAD.top + plotH} stroke="var(--border)" />
      <line x1={PAD.left} y1={zeroY} x2={PAD.left + plotW} y2={zeroY} stroke="var(--border)" />
      {/* Y 軸の目盛 (min/0/max) */}
      {[min, 0, max].map((v, i) => (
        <text key={i} x={PAD.left - 6} y={yAt(v) + 3} textAnchor="end" fontSize="10" fill="var(--text-muted)">
          {formatTick(v)}
        </text>
      ))}
      {/* X 軸ラベル */}
      {model.labels.map((lab, i) =>
        i % labelStep === 0 ? (
          <text key={i} x={xAt(i)} y={H - PAD.bottom + 16} textAnchor="end" fontSize="10" fill="var(--text-muted)"
            transform={`rotate(-30 ${xAt(i)} ${H - PAD.bottom + 16})`}>
            {truncate(lab)}
          </text>
        ) : null,
      )}
      {/* 系列 */}
      {model.series.map((s, si) => {
        const color = SERIES_COLORS[si % SERIES_COLORS.length];
        if (type === "bar") {
          const seriesCount = model.series.length;
          const barW = (bandW * 0.7) / seriesCount;
          return (
            <g key={si}>
              {s.values.map((v, i) => {
                const x = PAD.left + bandW * i + bandW * 0.15 + barW * si;
                const y = Math.min(yAt(v), zeroY);
                const h = Math.abs(yAt(v) - zeroY);
                return <rect key={i} x={x} y={y} width={Math.max(1, barW)} height={Math.max(0, h)} fill={color} />;
              })}
            </g>
          );
        }
        // line / area
        const pts = s.values.map((v, i) => `${xAt(i)},${yAt(v)}`).join(" ");
        const areaPath = `M ${xAt(0)},${zeroY} L ${s.values.map((v, i) => `${xAt(i)},${yAt(v)}`).join(" L ")} L ${xAt(n - 1)},${zeroY} Z`;
        return (
          <g key={si}>
            {type === "area" && <path d={areaPath} fill={color} fillOpacity={0.18} />}
            <polyline points={pts} fill="none" stroke={color} strokeWidth={2} />
          </g>
        );
      })}
    </chakra.svg>
  );
}

function PieChart({ model }: { model: ChartModel }) {
  // 円グラフは先頭系列のみ。負値は 0 にクランプ。
  const series = model.series[0];
  const values = series.values.map((v) => Math.max(0, v));
  const total = values.reduce((a, b) => a + b, 0);
  const cx = 220;
  const cy = 210;
  const r = 170;
  let angle = -Math.PI / 2;
  return (
    <chakra.svg viewBox="0 0 720 420" width="100%" style={{ maxHeight: "100%" }} role="img">
      {total === 0 ? (
        <text x={cx} y={cy} textAnchor="middle" fontSize="12" fill="var(--text-muted)">∅</text>
      ) : (
        values.map((v, i) => {
          const frac = v / total;
          const start = angle;
          const end = angle + frac * Math.PI * 2;
          angle = end;
          const large = end - start > Math.PI ? 1 : 0;
          const x1 = cx + r * Math.cos(start);
          const y1 = cy + r * Math.sin(start);
          const x2 = cx + r * Math.cos(end);
          const y2 = cy + r * Math.sin(end);
          const color = SERIES_COLORS[i % SERIES_COLORS.length];
          return (
            <path key={i} d={`M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`} fill={color} stroke="var(--bg-surface)" strokeWidth={1} />
          );
        })
      )}
      {/* 凡例 (ラベル + 値) */}
      {model.labels.map((lab, i) => (
        <g key={i} transform={`translate(440 ${28 + i * 20})`}>
          <rect width="12" height="12" rx="2" fill={SERIES_COLORS[i % SERIES_COLORS.length]} />
          <text x="18" y="11" fontSize="11" fill="var(--text)">
            {truncate(lab)} ({values[i]})
          </text>
        </g>
      ))}
    </chakra.svg>
  );
}

function formatTick(v: number): string {
  if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

function truncate(s: string, max = 16): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
