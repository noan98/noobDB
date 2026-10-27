import { chakra } from "@chakra-ui/react";
import { motion, useReducedMotion } from "motion/react";
import { useState } from "react";
import { useT } from "../i18n";
import { durations, easings, reducedMotionActive } from "../motion";
import { semanticColorVar } from "../semanticColors";
import {
  LATENCY_HISTORY_MAX,
  sparklineGeometry,
  type LatencySample,
  type SparklineGeometry,
} from "./connectionHealth";
import { prefersStaticMotion } from "./revealOrigin";

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
export function LatencySparkline({
  samples,
  neutral = false,
  format,
  animateLatest = false,
}: {
  samples: readonly LatencySample[] | undefined;
  /** true: ms 以外の汎用推移 (件数・レートなど, #1833)。閾値線と段階色を出さず、最小〜最大に張る。 */
  neutral?: boolean;
  /** neutral の読み上げ文言で最小・最大に通す整形関数 (生の浮動小数を読ませない)。 */
  format?: (n: number) => string;
  /** true: サンプルの中身が変わるたびに最新区間を描き入れる (#1874)。既定は静止。 */
  animateLatest?: boolean;
}) {
  const t = useT();
  const reduced = useReducedMotion();
  // サンプルの中身が変わった世代。最新セグメントの key に混ぜ、更新のたびに描き入れを再生する (#1874)。
  // 親が同じ中身の配列を作り直しただけでは増えない。初回表示 (世代 0) は描き入れない。
  const sig = samples ? samples.join(",") : "";
  const [gen, setGen] = useState({ sig, n: 0 });
  if (gen.sig !== sig) setGen({ sig, n: gen.n + 1 });
  const animateLast =
    animateLatest && gen.n > 0 && !reduced && !reducedMotionActive() && !prefersStaticMotion();
  // neutral では NaN / Infinity も欠測として数える (sparklineGeometry と同じ扱い)。
  const usable = (s: LatencySample): s is number => s !== null && (!neutral || Number.isFinite(s));
  if (!samples || samples.filter(usable).length < 2) {
    return <chakra.span color="app.textMuted">–</chakra.span>;
  }
  const g = sparklineGeometry(samples, SPARK_W, SPARK_H, LATENCY_HISTORY_MAX, neutral);
  const values = samples.filter(usable);
  const label = t(neutral ? "sparklineTrendAria" : "healthTrendAria", {
    count: samples.length,
    min: neutral && format ? format(Math.min(...values)) : Math.min(...values),
    max: neutral && format ? format(Math.max(...values)) : Math.max(...values),
  });
  return (
    <chakra.svg
      role="img"
      aria-label={label}
      data-testid={neutral ? "neutral-sparkline" : "health-sparkline"}
      viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
      w="20"
      h="5"
      overflow="visible"
    >
      <title>{label}</title>
      {!neutral && (
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
      )}
      {g.segments.map((s, i) => {
        const common = {
          x1: s.x1,
          y1: s.y1,
          x2: s.x2,
          y2: s.y2,
          stroke: sparkStroke(s.level),
          strokeWidth: 1.5,
          strokeLinecap: "round" as const,
          "data-level": s.level,
        };
        // 最新の区間だけ左から右へ描き入れる (ChartView の折線と同じ pathLength 0→1)。
        // 描き入れ中は non-scaling-stroke を外す (pathLength と併用すると最終フレームで線が欠ける)。
        if (animateLast && i === g.segments.length - 1 && s.x2 === SPARK_W) {
          return (
            <motion.line
              key={`last${gen.n}`}
              {...common}
              data-testid="sparkline-latest"
              initial={{ pathLength: 0, opacity: 0 }}
              animate={{ pathLength: 1, opacity: 1 }}
              transition={{ duration: durations.slow, ease: easings.out }}
            />
          );
        }
        return <line key={`${s.x1}:${s.x2}`} {...common} vectorEffect="non-scaling-stroke" />;
      })}
      {g.points.map((p) => (
        <circle key={`p${p.x}`} cx={p.x} cy={p.y} r={1.5} fill={sparkStroke(p.level)} />
      ))}
      {!neutral &&
        g.gaps.map((p) => (
          <circle key={`g${p.x}`} cx={p.x} cy={p.y} r={1.5} fill={semanticColorVar("danger", "solid")} />
        ))}
    </chakra.svg>
  );
}
