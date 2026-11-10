import { chakra } from "@chakra-ui/react";
import { motion, useReducedMotionConfig } from "motion/react";
import { durations, easings } from "../motion";

const ChakraSvg = chakra("svg");

// viewBox の座標系 (実寸は boxSize で決まる)。
const SIZE = 20;
const STROKE = 3;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** 進捗の割合 (0〜1)。total が 0 以下なら 0。 */
export function masteryFraction(done: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(1, Math.max(0, done / total));
}

/**
 * 習熟マップのグループ別進捗リング (#2216)。ブランドの teal で弧を描き、値が変わると弧が伸びる。
 * reduced-motion (OS 設定 / アプリ内設定) では補間せず確定値で静止する。装飾なので
 * `aria-hidden` で、読み上げは呼び出し側のテキストが担う。
 */
export function MasteryRing({ done, total }: { done: number; total: number }) {
  const reduced = useReducedMotionConfig() ?? false;
  const offset = CIRCUMFERENCE * (1 - masteryFraction(done, total));
  return (
    <ChakraSvg
      aria-hidden="true"
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      boxSize="4"
      flexShrink={0}
      data-testid="mastery-ring"
      data-done={done}
      data-total={total}
      data-static={reduced ? "true" : "false"}
    >
      <circle
        cx={SIZE / 2}
        cy={SIZE / 2}
        r={RADIUS}
        fill="none"
        strokeWidth={STROKE}
        stroke="var(--border)"
      />
      <motion.circle
        cx={SIZE / 2}
        cy={SIZE / 2}
        r={RADIUS}
        fill="none"
        strokeWidth={STROKE}
        strokeLinecap="round"
        stroke="var(--brand-teal)"
        strokeDasharray={CIRCUMFERENCE}
        // 12 時の位置から時計回りに伸ばす。
        transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
        initial={false}
        animate={{ strokeDashoffset: offset }}
        transition={reduced ? { duration: 0 } : { duration: durations.base * 2, ease: easings.out }}
      />
    </ChakraSvg>
  );
}
