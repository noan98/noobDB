import { useRef } from "react";
import { Box, chakra } from "@chakra-ui/react";
import { motion, useReducedMotion } from "motion/react";
import type { TimelapseGenerationMeta } from "../api/tauri";
import { useLocale, useT } from "../i18n";
import { springs } from "../motion";
import { semanticColorVar } from "../semanticColors";
import { formatCaptured, nearestStep, scrubberTicks } from "../timelapseScrubber";
import { Tooltip } from "./Tooltip";

const MotionThumb = chakra(motion.div, {}, { forwardProps: ["transition"] });

// スパークラインの描画領域 (viewBox の座標系)。実寸は CSS 側で決まる。
const W = 100;
const H = 20;

/** truncated の世代を示すハッチ (斜線)。色は意味色の solid、間隔は余白トークン。 */
const HATCH = `repeating-linear-gradient(135deg, ${semanticColorVar("warning", "solid")} 0 var(--space-0-5), transparent var(--space-0-5) var(--space-1))`;

/**
 * タイムラプスのスクラバー (#2095)。取得時刻に比例した目盛り + 行数スパークラインの専用トラック。
 * キーボード操作 (←→ / Home / End) と読み上げは、トラックに重ねた透明な
 * `<input type="range">` (slider ロール) が担い、見た目のつまみは spring で追従する。
 */
export function TimelapseScrubber({
  generations,
  step,
  maxStep,
  onSeek,
}: {
  generations: readonly TimelapseGenerationMeta[];
  step: number;
  maxStep: number;
  onSeek: (step: number) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const reduced = useReducedMotion();
  const trackRef = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const ticks = scrubberTicks(generations);
  const current = ticks[step];
  if (!current) return null;

  const when = formatCaptured(current.capturedAt, locale);
  const valueText = `${t("timelapseScrubStep", { step, max: maxStep })} · ${when} · ${t("timelapseRows", {
    count: current.rowCount,
  })}${current.truncated ? ` · ${t("timelapsePartial")}` : ""}`;

  const seekFromPointer = (clientX: number) => {
    const el = trackRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width <= 0) return;
    const s = nearestStep(ticks, Math.min(1, Math.max(0, (clientX - r.left) / r.width)));
    if (s !== null && s !== step) onSeek(s);
  };

  // 行数の折れ線 (面) の座標。x は取得時刻、y は行数 (上が多い)。
  const pts = ticks.map((tk) => `${(tk.x * W).toFixed(2)},${(H - tk.y * (H - 2) - 1).toFixed(2)}`);
  const line = `M${pts.join(" L")}`;
  const area = `${line} L${(ticks[ticks.length - 1].x * W).toFixed(2)},${H} L${(ticks[0].x * W).toFixed(2)},${H} Z`;

  return (
    <Box flex="1" minW="48" maxW="96" px="2">
      <Box
        ref={trackRef}
        position="relative"
        h="8"
        cursor="pointer"
        borderRadius="sm"
        borderWidth="1px"
        borderColor="app.border"
        bg="app.surface"
        css={{ touchAction: "none", "&:has(input:focus-visible)": { boxShadow: "var(--focus-ring)" } }}
        data-testid="timelapse-track"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          // 透明な range にフォーカスを移し、直後の矢印キーが効くようにする。
          inputRef.current?.focus({ preventScroll: true });
          dragging.current = true;
          e.currentTarget.setPointerCapture?.(e.pointerId);
          seekFromPointer(e.clientX);
        }}
        onPointerMove={(e) => {
          if (dragging.current) seekFromPointer(e.clientX);
        }}
        onPointerUp={() => {
          dragging.current = false;
        }}
        onPointerCancel={() => {
          dragging.current = false;
        }}
      >
        <chakra.svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          aria-hidden="true"
          position="absolute"
          inset="0"
          w="100%"
          h="100%"
          data-testid="timelapse-sparkline"
        >
          {ticks.length >= 2 && (
            <>
              <path d={area} fill="var(--accent)" fillOpacity={0.16} stroke="none" />
              <path
                d={line}
                fill="none"
                stroke="var(--text-muted)"
                strokeWidth={1.5}
                vectorEffect="non-scaling-stroke"
              />
            </>
          )}
        </chakra.svg>
        {ticks.map((tk) => (
          <Tooltip
            key={tk.id}
            label={
              <>
                <chakra.div>{formatCaptured(tk.capturedAt, locale)}</chakra.div>
                <chakra.div>
                  {t("timelapseRows", { count: tk.rowCount })}
                  {tk.truncated ? ` · ${t("timelapsePartial")}` : ""}
                </chakra.div>
              </>
            }
          >
            <chakra.span
              position="absolute"
              top="0"
              bottom="0"
              w="2"
              data-testid="timelapse-tick"
              data-truncated={tk.truncated ? "true" : "false"}
              style={{ left: `${tk.x * 100}%`, transform: "translateX(-50%)" }}
            >
              <chakra.span
                position="absolute"
                top="0"
                bottom="0"
                left="50%"
                w={tk.truncated ? "1.5" : "0.5"}
                style={{
                  transform: "translateX(-50%)",
                  background: tk.truncated ? HATCH : "var(--border-strong)",
                }}
              />
            </chakra.span>
          </Tooltip>
        ))}
        <MotionThumb
          aria-hidden="true"
          position="absolute"
          top="0"
          bottom="0"
          w="1"
          borderRadius="pill"
          bg="var(--accent)"
          data-testid="timelapse-thumb"
          style={{ pointerEvents: "none", transform: "translateX(-50%)" }}
          initial={false}
          animate={{ left: `${current.x * 100}%` }}
          transition={reduced ? { duration: 0 } : springs.snappy}
        />
        <chakra.input
          ref={inputRef}
          type="range"
          min={1}
          max={maxStep}
          step={1}
          value={step}
          aria-label={t("timelapseScrubAria")}
          aria-valuetext={valueText}
          onChange={(e) => onSeek(Number(e.currentTarget.value))}
          position="absolute"
          inset="0"
          w="100%"
          h="100%"
          m="0"
          opacity={0}
          style={{ pointerEvents: "none" }}
        />
      </Box>
    </Box>
  );
}
