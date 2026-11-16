import { Box, chakra } from "@chakra-ui/react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useT, type I18nKey } from "../i18n";
import {
  computeRulerTicks,
  hitTestRuler,
  laneAtX,
  RULER_LANE_COUNT,
  rowSpanToY,
  yToRow,
  type RulerKind,
} from "./gridOverviewRuler";
import { TooltipBubble } from "./Tooltip";
import type { TooltipRect } from "./tooltipPosition";

/**
 * 結果グリッドの位置マーカーの帯 (#2381)。集約と座標変換は純モジュール `gridOverviewRuler.ts`、
 * ここは単一の Canvas への描画とポインタ操作だけを持つ (行ごとの DOM は作らない)。
 * マスクかサイズが変わったときだけ描き直す。
 */
const KIND_LABEL_KEY: Record<RulerKind, I18nKey> = {
  find: "gridRulerFind",
  edit: "gridRulerEdit",
  delete: "gridRulerDelete",
  added: "gridRulerAdded",
  changed: "gridRulerChanged",
};

/** ホバー判定の許容 (ティックの上下にこの px 分のゆとり)。 */
const HOVER_TOLERANCE_PX = 3;

interface Props {
  /** 表示位置ごとのマスク (`buildRowMasks`)。 */
  masks: Uint8Array;
  /** 選択範囲 (表示位置の両端)。枠として描く。 */
  selection: { first: number; last: number } | null;
  /** 現在行 (アクティブセルの行)。 */
  currentRow: number | null;
  /** 帯のクリック / ドラッグで、その表示位置の行へ移動する。 */
  onJump: (visPos: number) => void;
}

interface Size {
  height: number;
  tickMin: number;
}

export function GridOverviewRuler({ masks, selection, currentRow, onJump }: Props) {
  const t = useT();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState<Size>({ height: 0, tickMin: 1 });
  const [themeSeq, setThemeSeq] = useState(0);
  const [hover, setHover] = useState<{ label: string; anchor: TooltipRect } | null>(null);
  const draggingRef = useRef(false);

  // 高さ (と最小ティック高さ) の追従。`scroll-margin-top` は calc() を解決済みの px で読める。
  useLayoutEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const measure = () => {
      const tickMin = Number.parseFloat(getComputedStyle(el).scrollMarginTop) || 1;
      setSize((prev) =>
        prev.height === el.clientHeight && prev.tickMin === tickMin
          ? prev
          : { height: el.clientHeight, tickMin },
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // テーマ切替 (data-theme / class / style の変化) で色を読み直す。
  useEffect(() => {
    if (typeof MutationObserver === "undefined") return;
    const mo = new MutationObserver(() => setThemeSeq((n) => n + 1));
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "class", "style"],
    });
    return () => mo.disconnect();
  }, []);

  const lanes = useMemo(
    () => computeRulerTicks(masks, size.height, size.tickMin),
    [masks, size.height, size.tickMin],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: themeSeq は色を読み直すためのトリガー
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.height <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = size.height;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const cs = getComputedStyle(canvas);
    const color = (name: string) => cs.getPropertyValue(name).trim();
    const laneW = w / RULER_LANE_COUNT;
    for (let lane = 0; lane < RULER_LANE_COUNT; lane++) {
      for (const tick of lanes[lane]) {
        const c = color(`--ruler-${tick.kind}`);
        if (c) ctx.fillStyle = c;
        ctx.fillRect(lane * laneW, tick.y, laneW, tick.h);
      }
    }
    // 選択範囲・現在行は枠のみ (ティックの色を覆わない)。
    const frame = color("--ruler-frame");
    if (frame) ctx.strokeStyle = frame;
    ctx.lineWidth = 1;
    const strokeSpan = (first: number, last: number) => {
      const { y, h: sh } = rowSpanToY(first, last, masks.length, h);
      const hh = Math.max(sh, size.tickMin);
      ctx.strokeRect(0.5, y + 0.5, w - 1, Math.max(hh - 1, 0));
    };
    if (selection) strokeSpan(selection.first, selection.last);
    else if (currentRow !== null) strokeSpan(currentRow, currentRow);
  }, [lanes, masks.length, selection, currentRow, size, themeSeq]);

  const localPoint = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top, rect };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    draggingRef.current = true;
    setHover(null);
    e.currentTarget.setPointerCapture(e.pointerId);
    const { y } = localPoint(e);
    onJump(yToRow(y, masks.length, size.height));
  };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const { x, y, rect } = localPoint(e);
    if (draggingRef.current) {
      onJump(yToRow(y, masks.length, size.height));
      return;
    }
    const lane = laneAtX(x, rect.width);
    const tick = hitTestRuler(lanes, lane, y, HOVER_TOLERANCE_PX);
    if (!tick) {
      setHover(null);
      return;
    }
    const label = t(KIND_LABEL_KEY[tick.kind], {
      n: tick.count.toLocaleString(),
      from: (tick.firstRow + 1).toLocaleString(),
      to: (tick.lastRow + 1).toLocaleString(),
    });
    const top = rect.top + tick.y;
    setHover((prev) =>
      prev?.label === label && prev.anchor.top === top
        ? prev
        : {
            label,
            anchor: {
              top,
              bottom: top + tick.h,
              left: rect.left,
              right: rect.right,
              width: rect.width,
              height: tick.h,
            },
          },
    );
  };
  const endDrag = (e: React.PointerEvent<HTMLCanvasElement>) => {
    draggingRef.current = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  return (
    <Box
      className="grid-ruler"
      flex="none"
      w="var(--ruler-w)"
      borderLeft="1px solid"
      borderColor="app.borderSubtle"
      bg="app.surfaceMuted"
    >
      <chakra.canvas
        ref={canvasRef}
        role="img"
        aria-label={t("gridRulerLabel")}
        display="block"
        w="100%"
        h="100%"
        cursor="pointer"
        style={{ scrollMarginTop: "var(--ruler-tick-min)", touchAction: "none" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={() => setHover(null)}
      />
      {hover && <TooltipBubble label={hover.label} anchor={hover.anchor} placement="left" />}
    </Box>
  );
}
