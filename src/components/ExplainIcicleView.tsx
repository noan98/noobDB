import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Box, chakra } from "@chakra-ui/react";
import { motion, useReducedMotion } from "motion/react";

import { SEQUENTIAL_RAMPS, rampStops, readableInk, sampleRamp, useIsDarkTheme } from "../colorScale";
import { useT } from "../i18n";
import { transitions } from "../motion";
import { formatDurationMs, formatNumber, type PlanNode } from "./explainPlan";
import {
  ICICLE_MIN_VISIBLE_WIDTH,
  icicleBasis,
  icicleBreadcrumb,
  icicleHasNode,
  layoutIcicle,
  type IcicleBasis,
  type IcicleRect,
} from "./explainIcicle";
import { ImageExportButton } from "./ImageExportButton";
import { elementToPngBlob, elementToSvgBytes } from "./imageExport";
import { Button } from "./ui";

/**
 * EXPLAIN プランの「時間配分」アイシクル図 (#2407)。横幅 = 包含時間 (実測が無ければ推定コスト)、
 * 縦 = 木の深さ、色 = 自己時間の割合 (`colorScale` の sequential ランプ)。ノードのクリックで
 * 部分木へズームし (Motion で x / 幅をアニメーション、reduced-motion では即時)、選択はツリー /
 * ダイアグラムと共有する。配置と自己時間の計算は純ロジック (`explainIcicle.ts`)。
 */

/** SVG の座標系 (viewBox の単位)。実寸ではなく幅に合わせて縮尺される。 */
const VIEW_W = 960;
const ROW_H = 28;
const ROW_GAP = 2;
const LABEL_PAD = 6;
/** 1 文字あたりの概算幅 (viewBox 単位)。ラベルの切り詰めに使う。 */
const CHAR_W = 7;

function formatValue(v: number, basis: IcicleBasis): string {
  return basis === "actual" ? formatDurationMs(v) : formatNumber(v);
}

function pct(share: number): string {
  const p = share * 100;
  return p >= 10 ? p.toFixed(0) : p.toFixed(1);
}

function clip(label: string, widthUnits: number): string {
  const max = Math.floor((widthUnits - LABEL_PAD * 2) / CHAR_W);
  if (max < 2) return "";
  return label.length <= max ? label : `${label.slice(0, max - 1)}…`;
}

const barCss = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "var(--space-2)",
  padding: "var(--space-1-5) var(--space-2)",
  borderBottom: "1px solid var(--border-subtle)",
  fontSize: "var(--text-sm)",
} as const;

export function ExplainIcicleView({
  root,
  selectedId,
  onSelect,
}: {
  root: PlanNode;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const t = useT();
  const isDark = useIsDarkTheme();
  const reduced = useReducedMotion() ?? false;
  const svgRef = useRef<SVGSVGElement>(null);
  const basis = useMemo(() => icicleBasis(root), [root]);
  const [focusId, setFocusId] = useState(root.id);
  const [hoverId, setHoverId] = useState<string | null>(null);

  // 新しい計画が来たらズームを解除する。
  useEffect(() => {
    setFocusId(root.id);
  }, [root]);

  const layout = useMemo(() => layoutIcicle(root, basis, focusId), [root, basis, focusId]);

  // ツリー側などで選択がズーム範囲外へ移ったら、全景へ戻して選択ノードが見えるようにする。
  useEffect(() => {
    if (layout && selectedId && !icicleHasNode(layout, selectedId)) setFocusId(root.id);
  }, [layout, selectedId, root.id]);

  if (!layout) {
    return (
      <Box p="4" color="app.textMuted" fontSize="sm">
        {t("explainIcicleEmpty")}
      </Box>
    );
  }

  const stops = rampStops(SEQUENTIAL_RAMPS.blue, isDark);
  const visible = layout.rects.filter((r) => r.w >= ICICLE_MIN_VISIBLE_WIDTH);
  const byId = new Map(layout.rects.map((r) => [r.id, r]));
  const height = (layout.maxDepth + 1) * ROW_H;
  const move = reduced ? { duration: 0 } : transitions.emphasized;
  const tabStop = selectedId && byId.has(selectedId) ? selectedId : layout.focusId;
  const shown = byId.get(hoverId ?? selectedId ?? "") ?? byId.get(layout.focusId);

  const describe = (r: IcicleRect) =>
    t("explainIcicleNodeLabel", {
      label: r.label,
      inclusive: formatValue(r.inclusive, basis),
      self: formatValue(r.self, basis),
      pct: pct(r.share),
    });

  const choose = (id: string) => {
    setFocusId(id);
    onSelect(id);
  };

  const focusRect = (id: string | undefined) => {
    if (!id) return;
    svgRef.current?.querySelector<SVGGElement>(`[data-icicle-id="${CSS.escape(id)}"]`)?.focus();
  };

  const onKeyDown = (e: ReactKeyboardEvent<SVGSVGElement>) => {
    const id = (e.target as Element).getAttribute?.("data-icicle-id");
    const r = id ? byId.get(id) : undefined;
    if (!r) return;
    const siblings = r.parentId ? (byId.get(r.parentId)?.childIds ?? []) : [];
    const at = siblings.indexOf(r.id);
    const pick = (ids: string[]) =>
      ids.find((x) => byId.has(x) && (byId.get(x)?.w ?? 0) >= ICICLE_MIN_VISIBLE_WIDTH);
    let next: string | undefined;
    switch (e.key) {
      case "ArrowRight":
        next = pick(siblings.slice(at + 1));
        break;
      case "ArrowLeft":
        next = pick(siblings.slice(0, Math.max(0, at)).reverse());
        break;
      case "ArrowDown":
        next = pick(r.childIds);
        break;
      case "ArrowUp":
        next = r.parentId ?? undefined;
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        choose(r.id);
        return;
      case "Escape":
      case "Backspace": {
        const crumbs = icicleBreadcrumb(root, layout.focusId);
        if (crumbs.length > 1) {
          e.preventDefault();
          setFocusId(crumbs[crumbs.length - 2].id);
        }
        return;
      }
      default:
        return;
    }
    if (next) {
      e.preventDefault();
      focusRect(next);
    }
  };

  const crumbs = icicleBreadcrumb(root, layout.focusId);
  const legendGradient = `linear-gradient(to right, ${stops.map((c, i) => `${c} ${(i / (stops.length - 1)) * 100}%`).join(", ")})`;
  const exportSize = { width: VIEW_W, height };

  return (
    <Box flex="1" minHeight={0} minWidth={0} display="flex" flexDirection="column" overflow="hidden">
      <Box css={barCss}>
        <chakra.span color="app.textSecondary">
          {t(basis === "actual" ? "explainIcicleBasisActual" : "explainIcicleBasisCost")}
        </chakra.span>
        <Box flex="1" />
        <ImageExportButton
          filenameBase="explain_time_breakdown"
          makePng={(opts) =>
            elementToPngBlob(svgRef.current as unknown as HTMLElement, { ...exportSize, ...opts })
          }
          makeSvg={() => elementToSvgBytes(svgRef.current as unknown as HTMLElement, exportSize)}
        />
      </Box>
      <Box css={barCss} role="group" aria-label={t("explainIcicleHotspots")}>
        <chakra.span textStyle="overline" color="app.textMuted">
          {t("explainIcicleHotspots")}
        </chakra.span>
        {layout.hotspots.map((h) => (
          <Button key={h.id} size="sm" variant="secondary" onClick={() => choose(h.id)}>
            {t("explainIcicleHotspotBadge", {
              name: h.label,
              value: formatValue(h.self, basis),
              pct: pct(h.share),
            })}
          </Button>
        ))}
      </Box>
      <Box css={barCss} as="nav" aria-label={t("explainIcicleBreadcrumb")}>
        {crumbs.map((c, i) => (
          <chakra.span key={c.id} display="inline-flex" alignItems="center" gap="1.5">
            {i > 0 && <chakra.span color="app.textMuted">/</chakra.span>}
            {i === crumbs.length - 1 ? (
              <chakra.span fontWeight="600" aria-current="location">
                {c.label}
              </chakra.span>
            ) : (
              <Button size="sm" variant="secondary" onClick={() => setFocusId(c.id)}>
                {c.label}
              </Button>
            )}
          </chakra.span>
        ))}
      </Box>
      <Box flex="1" minHeight={0} overflow="auto" p="2">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${VIEW_W} ${height}`}
          width="100%"
          role="group"
          aria-label={t("explainIcicleSvgLabel")}
          onKeyDown={onKeyDown}
          style={{ display: "block" }}
        >
          {visible.map((r) => {
            const x = r.x * VIEW_W;
            const w = r.w * VIEW_W;
            const y = r.depth * ROW_H;
            const fill = sampleRamp(r.heat, stops);
            const ink = readableInk(fill);
            const sel = r.id === selectedId;
            const label = clip(r.label, w);
            return (
              <g
                key={r.id}
                data-icicle-id={r.id}
                role="button"
                tabIndex={r.id === tabStop ? 0 : -1}
                aria-label={describe(r)}
                aria-pressed={sel}
                style={{ cursor: "pointer", outline: "none" }}
                onClick={() => choose(r.id)}
                onMouseEnter={() => setHoverId(r.id)}
                onMouseLeave={() => setHoverId(null)}
                onFocus={() => setHoverId(r.id)}
                onBlur={() => setHoverId(null)}
              >
                <motion.rect
                  initial={false}
                  animate={{ attrX: x, attrY: y, width: Math.max(0, w - ROW_GAP), height: ROW_H - ROW_GAP }}
                  transition={move}
                  rx={3}
                  fill={fill}
                  stroke={sel || r.id === hoverId ? "var(--accent)" : "var(--border-subtle)"}
                  strokeWidth={sel ? 2 : 1}
                />
                {label && (
                  <motion.text
                    initial={false}
                    animate={{ attrX: x + LABEL_PAD, attrY: y + ROW_H / 2 }}
                    transition={move}
                    dominantBaseline="central"
                    fill={ink}
                    style={{ fontSize: "var(--text-xs)", pointerEvents: "none" }}
                  >
                    {label}
                  </motion.text>
                )}
              </g>
            );
          })}
        </svg>
      </Box>
      <Box css={barCss} borderTop="1px solid var(--border-subtle)" borderBottom="none">
        {shown && (
          <chakra.span textStyle="numeric" role="status" aria-live="polite">
            {describe(shown)}
          </chakra.span>
        )}
        <Box flex="1" />
        <chakra.span textStyle="caption">{t("explainIcicleLegendLow")}</chakra.span>
        <Box
          aria-hidden
          w="24"
          h="2"
          borderRadius="sm"
          border="1px solid var(--border-subtle)"
          style={{ background: legendGradient }}
        />
        <chakra.span textStyle="caption">{t("explainIcicleLegendHigh")}</chakra.span>
      </Box>
      {layout.estimated && (
        <Box css={barCss} borderTop="1px solid var(--border-subtle)" borderBottom="none">
          <chakra.span textStyle="caption" color="app.textWarning">
            {t("explainIcicleEstimatedNote")}
          </chakra.span>
        </Box>
      )}
      <Box px="2" py="1" textStyle="caption">
        {t("explainIcicleZoomHint")}
      </Box>
    </Box>
  );
}
