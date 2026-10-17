import { useMemo } from "react";
import { motion, useReducedMotionConfig } from "motion/react";
import { durations, easings } from "../motion";
import { revealClipPath, revealRadius, type RevealPoint } from "./revealOrigin";

/**
 * トリガー点 `origin` から円状に広がるオーバーレイ (#1582)。`ThemeTransition` /
 * `AccentWash` が共有する。`clip-path: circle()` の半径を 0 → 画面を覆う半径まで
 * アニメーションし、後半で `opacity` を 0 へ落として残さない。
 *
 * `reduced` (アプリ内モーション量 / OS の reduced-motion) と `plain` (高コントラスト
 * テーマ) のときは円を使わず、従来どおりの全画面クロスフェードにする。クリップは
 * motion の reducedMotion 抑制の対象外なので、ここで明示的に分岐する。
 */
export function CircularReveal({
  origin,
  color,
  opacity,
  plain = false,
  onDone,
}: {
  origin: RevealPoint;
  color: string;
  /** 開始時の不透明度。 */
  opacity: number;
  /** true なら円形にせず従来のクロスフェード (高コントラスト用)。 */
  plain?: boolean;
  onDone: () => void;
}) {
  const reduced = useReducedMotionConfig() ?? false;
  const flat = plain || reduced;

  const clip = useMemo(() => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const r = revealRadius(origin, viewport);
    return { from: revealClipPath(origin, 0), to: revealClipPath(origin, r) };
  }, [origin]);

  const common = {
    "aria-hidden": true,
    onAnimationComplete: onDone,
    style: {
      position: "fixed" as const,
      inset: 0,
      background: color,
      pointerEvents: "none" as const,
      zIndex: "var(--z-toast)" as unknown as number,
    },
  };

  if (flat) {
    return (
      <motion.div
        {...common}
        initial={{ opacity }}
        animate={{ opacity: 0 }}
        exit={{ opacity: 0 }}
        transition={{ duration: durations.med, ease: easings.out }}
      />
    );
  }

  return (
    <motion.div
      {...common}
      initial={{ opacity, clipPath: clip.from }}
      animate={{ opacity: [opacity, opacity, 0], clipPath: clip.to }}
      exit={{ opacity: 0 }}
      transition={{
        duration: durations.slow + durations.med,
        ease: easings.out,
        opacity: { duration: durations.slow + durations.med, times: [0, 0.55, 1], ease: "linear" },
      }}
    />
  );
}
