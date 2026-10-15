import { chakra } from "@chakra-ui/react";
import { useT } from "../i18n";
import { semanticColorVar } from "../semanticColors";
import {
  LATENCY_HISTORY_MAX,
  sparklineGeometry,
  type LatencySample,
  type SparklineGeometry,
} from "./connectionHealth";

// スパークラインの描画領域 (viewBox の座標系)。実寸は CSS 側の幅・高さで決まる。
const SPARK_W = 90;
const SPARK_H = 20;

function sparkStroke(level: SparklineGeometry["segments"][number]["level"]): string {
  if (level === "critical") return semanticColorVar("danger", "solid");
  if (level === "slow") return semanticColorVar("warning", "solid");
  return "var(--text-muted)";
}

/**
 * 直近のレイテンシ推移 (#1630)。閾値 (遅い) を超えた区間は意味色で塗り、計測できなかった回は
 * 下端の印で示す。2 サンプル未満は線が引けないので何も出さない (空セル)。
 */
export function LatencySparkline({ samples }: { samples: readonly LatencySample[] | undefined }) {
  const t = useT();
  if (!samples || samples.filter((s) => s !== null).length < 2) {
    return <chakra.span color="app.textMuted">–</chakra.span>;
  }
  const g = sparklineGeometry(samples, SPARK_W, SPARK_H, LATENCY_HISTORY_MAX);
  const values = samples.filter((s): s is number => s !== null);
  const label = t("healthTrendAria", {
    count: samples.length,
    min: Math.min(...values),
    max: Math.max(...values),
  });
  return (
    <chakra.svg
      role="img"
      aria-label={label}
      data-testid="health-sparkline"
      viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
      w="20"
      h="5"
      overflow="visible"
    >
      <title>{label}</title>
      <line
        x1={0}
        x2={SPARK_W}
        y1={g.thresholdY}
        y2={g.thresholdY}
        stroke="var(--border)"
        strokeDasharray="2 2"
        strokeWidth={1}
        vectorEffect="non-scaling-stroke"
      />
      {g.segments.map((s) => (
        <line
          key={`${s.x1}:${s.x2}`}
          x1={s.x1}
          y1={s.y1}
          x2={s.x2}
          y2={s.y2}
          stroke={sparkStroke(s.level)}
          strokeWidth={1.5}
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
          data-level={s.level}
        />
      ))}
      {g.points.map((p) => (
        <circle key={`p${p.x}`} cx={p.x} cy={p.y} r={1.5} fill={sparkStroke(p.level)} />
      ))}
      {g.gaps.map((p) => (
        <circle key={`g${p.x}`} cx={p.x} cy={p.y} r={1.5} fill={semanticColorVar("danger", "solid")} />
      ))}
    </chakra.svg>
  );
}
