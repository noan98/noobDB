import { useMemo, useState } from "react";
import { chakra, Flex } from "@chakra-ui/react";
import { motion } from "motion/react";
import type { QueryResult } from "../api/tauri";
import { useT } from "../i18n";
import { CATEGORICAL, readableInk } from "../colorScale";
import { durations, easings } from "../motion";
import { Button, Checkbox, Select } from "./ui";
import { Icon } from "./Icon";
import {
  buildChartModel,
  defaultChartConfig,
  inferNumericColumns,
  niceTicks,
  valueExtent,
  type Aggregation,
  type ChartType,
  type ChartConfig,
  type ChartModel,
} from "./chartData";

/**
 * クエリ結果のチャート可視化。取得済みの結果セットを入力に、棒/折れ線/面/円
 * グラフを SVG で描画する (チャートライブラリ非依存でバンドル増を避ける)。X/Y 軸と
 * 集計はユーザが選べる。軸/グリッド/凡例/ツールチップの色は CSS 変数 (--text-muted /
 * --border ほか) を参照しテーマに追従し、系列色は可視化共通のカテゴリスケール
 * (`colorScale.ts`、#525) を参照する。描画・系列の出現アニメーションは共有モーション
 * プリセット (`motion.ts`、#526) に沿い、reduced-motion では自動抑制される。
 * データ整形の純ロジックは chartData.ts に分離してテスト済み。
 */
interface Props {
  result: QueryResult;
  onClose: () => void;
}

// 系列の配色は可視化共通のカテゴリスケール (CB セーフな順序付き離散色)。系列数が
// パレット長を超えたら呼び出し側で `% length` により循環させる。
const SERIES_COLORS = CATEGORICAL;

// 系列の出現アニメーションを行う要素数の上限。これを超えると数百〜数千の要素を
// 同時にアニメートすることになり描画コストが嵩むため、静的描画に切り替える。
const ANIM_MAX_ELEMENTS = 200;

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
      <Flex direction="column" h="100%" align="center" justify="center" gap="3" color="app.textMuted">
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
      <Flex align="center" gap="2.5" px="3" py="2" flex="none" borderBottomWidth="1px" borderBottomColor="app.border" flexWrap="wrap" fontSize="sm">
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
          <Flex gap="2" flexWrap="wrap">
            {result.columns.map((c, i) =>
              numericCols[i] && i !== config.xCol ? (
                <chakra.label key={i} display="inline-flex" alignItems="center" gap="1" fontSize="xs" cursor="pointer">
                  <Checkbox checked={config.yCols.includes(i)} onChange={() => toggleY(i)} />
                  {c.name}
                </chakra.label>
              ) : null,
            )}
          </Flex>
        </Field>
      </Flex>

      {model.sampledFrom != null && (
        <chakra.div px="3" py="1" fontSize="xs" color="app.textMuted" flex="none">
          {t("chartSampled", { shown: model.labels.length, total: model.sampledFrom })}
        </chakra.div>
      )}

      {/* 凡例 */}
      {config.type !== "pie" && model.series.length > 0 && (
        <Flex gap="3" px="3" py="1" flex="none" flexWrap="wrap" fontSize="xs" color="app.textSecondary">
          {model.series.map((s, i) => (
            <Flex key={s.name} align="center" gap="5px">
              <chakra.span w="10px" h="10px" borderRadius="2px" bg={SERIES_COLORS[i % SERIES_COLORS.length]} />
              {s.name}
            </Flex>
          ))}
        </Flex>
      )}

      <chakra.div flex="1" minH={0} overflow="auto" p="3">
        {model.labels.length === 0 ? (
          <chakra.div color="app.textMuted" fontSize="sm">{t("chartNoData")}</chakra.div>
        ) : config.yCols.length === 0 ? (
          <chakra.div color="app.textMuted" fontSize="sm">{t("chartPickY")}</chakra.div>
        ) : config.type === "pie" ? (
          <PieChart model={model} colors={SERIES_COLORS} />
        ) : (
          <CartesianChart
            model={model}
            type={config.type}
            xName={result.columns[config.xCol]?.name ?? ""}
            colors={SERIES_COLORS}
          />
        )}
      </chakra.div>
    </Flex>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Flex align="center" gap="1.5">
      <chakra.span color="app.textMuted" fontSize="xs">{label}</chakra.span>
      {children}
    </Flex>
  );
}

const W = 900;
const H = 440;
const PAD = { left: 60, right: 20, top: 16, bottom: 66 };

function CartesianChart({
  model,
  type,
  xName,
  colors,
}: {
  model: ChartModel;
  type: ChartType;
  xName: string;
  colors: string[];
}) {
  // ホバー中のバンド (X インデックス)。値を読み取るためのガイド/ツールチップに使う。
  const [hover, setHover] = useState<number | null>(null);
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
  // キリの良い目盛り値でグリッド線を引き、値を読み取りやすくする。
  const ticks = niceTicks(min, max, 5);
  // X 軸ラベルは多すぎると間引く。
  const labelStep = Math.ceil(n / 16);
  // 点が少ないときだけマーカーを描く (多いとつぶれて逆に読みにくい)。
  const showMarkers = type !== "bar" && n <= 60;
  // 出現アニメーションは要素数が一定以下のときだけ行う (大量要素の同時アニメは
  // 描画コストが嵩むため静的描画にフォールバック)。reduced-motion 時はルートの
  // MotionConfig が自動的に即時化するため、ここでは分岐不要。
  const animate = model.series.length * n <= ANIM_MAX_ELEMENTS;

  // ポインタの X からバンドインデックスを逆算する。SVG は viewBox + width:100% +
  // maxHeight:100% のため、高さ制約時は preserveAspectRatio (既定 xMidYMid meet) で
  // 内容が縮小・水平方向にレターボックスされる。getBoundingClientRect().width は
  // 余白を含む要素幅で実際の描画幅と一致しないため、CTM の逆変換でスクリーン座標を
  // SVG ユーザ座標へ写し、スケール/オフセットを正しく吸収する。
  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const svg = e.currentTarget;
    const ctm = svg.getScreenCTM();
    if (!ctm) return;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const svgX = pt.matrixTransform(ctm.inverse()).x;
    const idx = Math.floor((svgX - PAD.left) / bandW);
    setHover(idx >= 0 && idx < n ? idx : null);
  };

  return (
    <chakra.svg
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      style={{ maxHeight: "100%" }}
      role="img"
      onMouseMove={onMove}
      onMouseLeave={() => setHover(null)}
    >
      {/* 水平グリッド線 + Y 目盛ラベル。0 基線だけ濃く実線にする。 */}
      {ticks.map((v, i) => {
        const y = yAt(v);
        const baseline = v === 0;
        return (
          <g key={i}>
            <line
              x1={PAD.left}
              y1={y}
              x2={PAD.left + plotW}
              y2={y}
              stroke={baseline ? "var(--border)" : "var(--border-subtle)"}
              strokeDasharray={baseline ? undefined : "3 4"}
            />
            <text x={PAD.left - 8} y={y + 3} textAnchor="end" fontSize="11" fill="var(--text-muted)">
              {formatTick(v)}
            </text>
          </g>
        );
      })}
      {/* Y 軸線 */}
      <line x1={PAD.left} y1={PAD.top} x2={PAD.left} y2={PAD.top + plotH} stroke="var(--border)" />

      {/* ホバー中バンドの強調 + 縦ガイド */}
      {hover != null && (
        <>
          <rect
            x={PAD.left + bandW * hover}
            y={PAD.top}
            width={bandW}
            height={plotH}
            fill="var(--accent)"
            fillOpacity={0.08}
          />
          <line
            x1={xAt(hover)}
            y1={PAD.top}
            x2={xAt(hover)}
            y2={PAD.top + plotH}
            stroke="var(--accent)"
            strokeOpacity={0.5}
            strokeDasharray="2 3"
          />
        </>
      )}

      {/* X 軸ラベル */}
      {model.labels.map((lab, i) =>
        i % labelStep === 0 ? (
          <text key={i} x={xAt(i)} y={H - PAD.bottom + 16} textAnchor="end" fontSize="10" fill="var(--text-muted)"
            transform={`rotate(-30 ${xAt(i)} ${H - PAD.bottom + 16})`}>
            {truncate(lab)}
          </text>
        ) : null,
      )}
      {/* X 軸タイトル (どの列が横軸かを明示) */}
      {xName && (
        <text x={PAD.left + plotW / 2} y={H - 6} textAnchor="middle" fontSize="11" fontWeight={600} fill="var(--text-secondary)">
          {truncate(xName, 48)}
        </text>
      )}

      {/* 系列 */}
      {model.series.map((s, si) => {
        const color = colors[si % colors.length];
        if (type === "bar") {
          const seriesCount = model.series.length;
          const barW = (bandW * 0.7) / seriesCount;
          return (
            <g key={si}>
              {s.values.map((v, i) => {
                const x = PAD.left + bandW * i + bandW * 0.15 + barW * si;
                const y = Math.min(yAt(v), zeroY);
                const h = Math.abs(yAt(v) - zeroY);
                // 棒は 0 基線から伸びるように出現させる (y/height を基線 → 値へ補間)。
                return (
                  <motion.rect
                    key={i}
                    x={x}
                    width={Math.max(1, barW)}
                    fill={color}
                    fillOpacity={hover == null || hover === i ? 1 : 0.5}
                    initial={animate ? { y: zeroY, height: 0 } : false}
                    animate={{ y, height: Math.max(0, h) }}
                    transition={
                      animate
                        ? { duration: durations.slow, ease: easings.out, delay: Math.min(i, 24) * 0.006 }
                        : { duration: 0 }
                    }
                  />
                );
              })}
            </g>
          );
        }
        // line / area
        const pts = s.values.map((v, i) => `${xAt(i)},${yAt(v)}`).join(" ");
        const areaPath = `M ${xAt(0)},${zeroY} L ${s.values.map((v, i) => `${xAt(i)},${yAt(v)}`).join(" L ")} L ${xAt(n - 1)},${zeroY} Z`;
        return (
          <g key={si}>
            {type === "area" && (
              <motion.path
                d={areaPath}
                fill={color}
                fillOpacity={0.18}
                initial={animate ? { opacity: 0 } : false}
                animate={{ opacity: 1 }}
                transition={animate ? { duration: durations.slow, ease: easings.out } : { duration: 0 }}
              />
            )}
            {/* 折れ線は左から描き進むように pathLength を 0 → 1 へ補間する。 */}
            <motion.polyline
              points={pts}
              fill="none"
              stroke={color}
              strokeWidth={2}
              initial={animate ? { pathLength: 0 } : false}
              animate={{ pathLength: 1 }}
              transition={animate ? { duration: durations.slow, ease: easings.out } : { duration: 0 }}
            />
            {showMarkers &&
              s.values.map((v, i) => (
                <circle
                  key={i}
                  cx={xAt(i)}
                  cy={yAt(v)}
                  r={hover === i ? 4.5 : 2.5}
                  fill={color}
                  stroke="var(--bg-surface)"
                  strokeWidth={1}
                />
              ))}
            {/* マーカー非表示時もホバー点だけは強調する。 */}
            {!showMarkers && hover != null && (
              <circle cx={xAt(hover)} cy={yAt(s.values[hover])} r={4} fill={color} stroke="var(--bg-surface)" strokeWidth={1} />
            )}
          </g>
        );
      })}

      {/* ツールチップ (ホバー中バンドの全系列の値) */}
      {hover != null && <HoverTooltip model={model} index={hover} gx={xAt(hover)} colors={colors} />}
    </chakra.svg>
  );
}

/** カルテシアンチャートのホバーツールチップ。X ラベルと各系列の値を一覧表示する。 */
function HoverTooltip({
  model,
  index,
  gx,
  colors,
}: {
  model: ChartModel;
  index: number;
  gx: number;
  colors: string[];
}) {
  const header = truncate(model.labels[index], 26);
  const rows = model.series.map((s, si) => ({
    name: truncate(s.name, 22),
    value: formatValue(s.values[index]),
    color: colors[si % colors.length],
  }));
  const charW = 6.2;
  const longest = Math.max(header.length, ...rows.map((r) => r.name.length + r.value.length + 4));
  const boxW = Math.min(320, Math.max(120, longest * charW + 24));
  const rowH = 17;
  const boxH = 12 + rowH + rows.length * rowH + 6;
  // ガイドの右に置くと右端からはみ出す場合は左側へ寄せる。
  const left = gx + 14 + boxW > W ? gx - 14 - boxW : gx + 14;
  const top = PAD.top + 6;
  return (
    <g pointerEvents="none">
      <rect
        x={left}
        y={top}
        width={boxW}
        height={boxH}
        rx={6}
        fill="var(--bg-elevated)"
        stroke="var(--border)"
        opacity={0.98}
      />
      <text x={left + 10} y={top + 18} fontSize="11" fontWeight={700} fill="var(--text)">
        {header}
      </text>
      {rows.map((r, i) => {
        const ry = top + 12 + rowH + i * rowH;
        return (
          <g key={i}>
            <rect x={left + 10} y={ry - 8} width="9" height="9" rx="2" fill={r.color} />
            <text x={left + 24} y={ry} fontSize="11" fill="var(--text-secondary)">
              {r.name}
            </text>
            <text x={left + boxW - 10} y={ry} textAnchor="end" fontSize="11" fontWeight={600} fill="var(--text)">
              {r.value}
            </text>
          </g>
        );
      })}
    </g>
  );
}

function PieChart({ model, colors }: { model: ChartModel; colors: string[] }) {
  // 円グラフは先頭系列のみ。負値は 0 にクランプ。
  const [hover, setHover] = useState<number | null>(null);
  const series = model.series[0];
  const values = series.values.map((v) => Math.max(0, v));
  const total = values.reduce((a, b) => a + b, 0);
  // スライスは数が限られるため常に出現アニメーション可。reduced-motion は
  // ルートの MotionConfig が自動抑制する。
  const animate = values.length <= ANIM_MAX_ELEMENTS;
  const cx = 220;
  const cy = 210;
  const r = 170;
  let angle = -Math.PI / 2;
  return (
    <chakra.svg viewBox="0 0 720 440" width="100%" style={{ maxHeight: "100%" }} role="img">
      {total === 0 ? (
        <text x={cx} y={cy} textAnchor="middle" fontSize="12" fill="var(--text-muted)">∅</text>
      ) : (
        values.map((v, i) => {
          const frac = v / total;
          const start = angle;
          const end = angle + frac * Math.PI * 2;
          angle = end;
          const large = end - start > Math.PI ? 1 : 0;
          const mid = (start + end) / 2;
          // ホバー中のスライスは中心から少し飛び出させて強調する。
          const pop = hover === i ? 10 : 0;
          const ox = Math.cos(mid) * pop;
          const oy = Math.sin(mid) * pop;
          const x1 = cx + ox + r * Math.cos(start);
          const y1 = cy + oy + r * Math.sin(start);
          const x2 = cx + ox + r * Math.cos(end);
          const y2 = cy + oy + r * Math.sin(end);
          const color = colors[i % colors.length];
          const pct = frac * 100;
          // ラベルは十分大きいスライスにだけ重ねる (小さいと文字がはみ出す)。
          const lx = cx + ox + r * 0.62 * Math.cos(mid);
          const ly = cy + oy + r * 0.62 * Math.sin(mid);
          return (
            <g key={i} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} style={{ cursor: "default" }}>
              <motion.path
                d={`M ${cx + ox} ${cy + oy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`}
                fill={color}
                stroke="var(--bg-surface)"
                strokeWidth={1}
                initial={animate ? { opacity: 0 } : false}
                animate={{ opacity: 1 }}
                transition={
                  animate
                    ? { duration: durations.med, ease: easings.out, delay: Math.min(i, 24) * 0.02 }
                    : { duration: 0 }
                }
              >
                <title>{`${model.labels[i]}: ${formatValue(values[i])} (${pct.toFixed(1)}%)`}</title>
              </motion.path>
              {frac >= 0.05 && (
                <text x={lx} y={ly} textAnchor="middle" fontSize="12" fontWeight={700} fill={readableInk(color)} pointerEvents="none">
                  {pct.toFixed(0)}%
                </text>
              )}
            </g>
          );
        })
      )}
      {/* 凡例 (ラベル + 値 + 割合) */}
      {model.labels.map((lab, i) => {
        const pct = total > 0 ? (values[i] / total) * 100 : 0;
        return (
          <g
            key={i}
            transform={`translate(440 ${28 + i * 20})`}
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
            style={{ cursor: "default" }}
          >
            <rect width="12" height="12" rx="2" fill={colors[i % colors.length]} fillOpacity={hover == null || hover === i ? 1 : 0.5} />
            <text x="18" y="11" fontSize="11" fontWeight={hover === i ? 700 : 400} fill="var(--text)">
              {truncate(lab)} — {formatValue(values[i])} ({pct.toFixed(1)}%)
            </text>
          </g>
        );
      })}
    </chakra.svg>
  );
}

function formatTick(v: number): string {
  if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

/** ツールチップ/凡例向けの値整形。整数は桁区切り、小数は最大 3 桁。 */
function formatValue(v: number): string {
  if (Number.isInteger(v)) return v.toLocaleString();
  return v.toLocaleString(undefined, { maximumFractionDigits: 3 });
}

function truncate(s: string, max = 16): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
