import { useEffect, useMemo } from "react";
import { animate, motion, useMotionValue, useReducedMotionConfig, useTransform } from "motion/react";
import { durations, easings, transitions } from "../motion";
import { revealClipPath, revealRadius, type RevealPoint } from "./revealOrigin";

/**
 * トリガー点 `origin` を原点とする円形のオーバーレイ (#1582)。`ThemeTransition` /
 * `AccentWash` が共有する。2 つの形がある。
 *
 * - `disc` (接続切替): `color` の円が `clip-path: circle()` で広がり、後半で opacity を
 *   0 へ落として残さない。
 * - `hole` (テーマ切替): data-theme は即座に全画面へ反映されるので、旧テーマの地色
 *   `color` で全画面を覆い、原点に開けた円形の「穴」を `mask-image` の半径で広げて
 *   新テーマを見せる。穴が画面を覆い切ったら終了。
 *
 * `reduced` (アプリ内モーション量 / OS の reduced-motion) と `plain` (高コントラスト
 * テーマ) のときは円を使わず、従来どおりの全画面クロスフェード (`flatColor` /
 * `flatOpacity`、省略時は `color` / `opacity`) にする。クリップ/マスクは motion の
 * reducedMotion 抑制の対象外なので、ここで明示的に分岐する。
 */
export function CircularReveal({
  origin,
  variant,
  color,
  opacity = 1,
  flatColor,
  flatOpacity,
  plain = false,
  onDone,
}: {
  origin: RevealPoint;
  variant: "disc" | "hole";
  color: string;
  /** disc の開始時の不透明度 (hole では使わない)。 */
  opacity?: number;
  /** 平坦分岐の色 (既定は `color`)。 */
  flatColor?: string;
  /** 平坦分岐の開始不透明度 (既定は `opacity`)。 */
  flatOpacity?: number;
  /** true なら円にせず従来のクロスフェード (高コントラスト用)。 */
  plain?: boolean;
  onDone: () => void;
}) {
  const reduced = useReducedMotionConfig() ?? false;
  const flat = plain || reduced;

  const radius = useMemo(
    () => revealRadius(origin, { width: window.innerWidth, height: window.innerHeight }),
    [origin],
  );

  const base = {
    "aria-hidden": true,
    "data-reveal": flat ? "flat" : variant,
    style: {
      position: "fixed" as const,
      inset: 0,
      pointerEvents: "none" as const,
      zIndex: "var(--z-toast)" as unknown as number,
    },
  };

  if (flat) {
    return (
      <motion.div
        {...base}
        style={{ ...base.style, background: flatColor ?? color }}
        initial={{ opacity: flatOpacity ?? opacity }}
        animate={{ opacity: 0 }}
        exit={{ opacity: 0, transition: transitions.fade }}
        transition={transitions.emphasized}
        onAnimationComplete={onDone}
      />
    );
  }

  if (variant === "hole") {
    return <HoleReveal origin={origin} radius={radius} color={color} onDone={onDone} />;
  }

  const total = durations.slow + durations.med;
  return (
    <motion.div
      {...base}
      style={{ ...base.style, background: color }}
      initial={{ opacity, clipPath: revealClipPath(origin, 0) }}
      animate={{ opacity: [opacity, opacity, 0], clipPath: revealClipPath(origin, radius) }}
      exit={{ opacity: 0, transition: transitions.fade }}
      transition={{
        duration: total,
        ease: easings.out,
        opacity: { duration: total, times: [0, 0.55, 1], ease: "linear" },
      }}
      onAnimationComplete={onDone}
    />
  );
}

function HoleReveal({
  origin,
  radius,
  color,
  onDone,
}: {
  origin: RevealPoint;
  radius: number;
  color: string;
  onDone: () => void;
}) {
  const r = useMotionValue(0);
  const mask = useTransform(
    r,
    (v) =>
      `radial-gradient(circle at ${Math.round(origin.x)}px ${Math.round(origin.y)}px, transparent ${v}px, #000 ${v}px)`,
  );

  useEffect(() => {
    const controls = animate(r, radius, {
      duration: durations.slow + durations.med,
      ease: easings.out,
      onComplete: onDone,
    });
    return () => controls.stop();
  }, [r, radius, onDone]);

  return (
    <motion.div
      aria-hidden
      data-reveal="hole"
      exit={{ opacity: 0, transition: transitions.fade }}
      style={{
        position: "fixed",
        inset: 0,
        background: color,
        pointerEvents: "none",
        zIndex: "var(--z-toast)" as unknown as number,
        maskImage: mask,
        WebkitMaskImage: mask,
      }}
    />
  );
}
