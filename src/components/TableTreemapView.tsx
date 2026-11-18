import { useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Box, chakra } from "@chakra-ui/react";
import { motion, useReducedMotion } from "motion/react";

import { SEQUENTIAL_RAMPS, rampStops, readableInk, sampleRamp, useIsDarkTheme } from "../colorScale";
import { useT } from "../i18n";
import { transitions } from "../motion";
import { semanticColorVar } from "../semanticColors";
import { ImageExportButton } from "./ImageExportButton";
import { elementToPngBlob, elementToSvgBytes } from "./imageExport";
import { formatBytes, formatDelta, formatRowCount, type TableStatRow } from "./tableSize";
import {
  layoutTableTreemap,
  layoutTileLabel,
  neighborTile,
  TREEMAP_OTHER_ID,
  TREEMAP_PAD,
  type TreemapDirection,
  type TreemapTile,
} from "./tableTreemap";
import { ToneChip } from "./ToneChip";
import { Button } from "./ui";

/**
 * テーブルサイズのツリーマップ (#2408)。面積 = 合計サイズ、タイルを data (上) / index (下) の
 * 比率で 2 段に塗り分ける。肥大・インデックス過大の表は警告色の枠 (+ ホバーカードの ToneChip)、
 * 前回取得からの増加は右上の ▲ で示す。サイズ不明の表は別枠、小さすぎる表は「その他」へ集約する。
 * 配置・集約・巡回の計算は純ロジック (`tableTreemap.ts`)、色は `colorScale` とトークンだけ。
 * ホバー / フォーカスで詳細カード、クリック / Enter でテーブルを開く。
 */

/** SVG の座標系 (viewBox の単位)。実寸ではなく幅に合わせて縮尺される。 */
const VIEW_W = 960;
const VIEW_H = 480;
const TILE_GAP = 1;
const PAD = TREEMAP_PAD;
/** 別枠に並べるボタン数の上限 (超えた分は件数で示す)。 */
const STRIP_LIMIT = 30;

const barCss = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "var(--space-2)",
  padding: "var(--space-1-5) var(--space-2)",
  borderBottom: "1px solid var(--border-subtle)",
  fontSize: "var(--text-sm)",
} as const;

function pct(share: number): string {
  const p = share * 100;
  return p >= 10 ? p.toFixed(0) : p.toFixed(1);
}

export function TableTreemapView({
  rows,
  onOpenTable,
  database,
}: {
  /** フィルタ済みの行。表と同じ集合を渡す。 */
  rows: readonly TableStatRow[];
  onOpenTable?: (table: string) => void;
  database: string;
}) {
  const t = useT();
  const isDark = useIsDarkTheme();
  const reduced = useReducedMotion() ?? false;
  const svgRef = useRef<SVGSVGElement>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  /** フォーカス中のタイル。activeId (ロービング tabStop 用) は blur しても残るため別に持つ。 */
  const [focusId, setFocusId] = useState<string | null>(null);

  const layout = useMemo(
    () => layoutTableTreemap(rows, { width: VIEW_W, height: VIEW_H }, Date.now()),
    [rows],
  );
  const dataFill = sampleRamp(0.6, rampStops(SEQUENTIAL_RAMPS.blue, isDark));
  const indexFill = sampleRamp(0.6, rampStops(SEQUENTIAL_RAMPS.teal, isDark));
  const move = reduced ? { duration: 0 } : transitions.emphasized;
  const exportSize = { width: VIEW_W, height: VIEW_H };

  const tiles = layout.tiles;
  const byId = new Map(tiles.map((x) => [x.id, x]));
  const tabStop = activeId && byId.has(activeId) ? activeId : (tiles[0]?.id ?? null);
  const shown = byId.get(hoverId ?? "") ?? null;

  const nameOf = (x: TreemapTile) =>
    x.id === TREEMAP_OTHER_ID ? t("sizeTreemapOther", { count: x.count }) : x.id;

  const describe = (x: TreemapTile) => {
    const parts = [
      t("sizeTreemapTileLabel", { name: nameOf(x), total: formatBytes(x.value), pct: pct(x.share) }),
    ];
    if (x.row) {
      parts.push(
        x.dataShare == null
          ? t("sizeTreemapSplitUnknown")
          : t("sizeTreemapSplit", {
              data: formatBytes(x.row.data_bytes),
              index: formatBytes(x.row.index_bytes),
            }),
      );
    }
    if (x.bloated) parts.push(t("sizeBloatedBadge"));
    if (x.indexHeavy) parts.push(t("sizeTreemapIndexHeavy"));
    if (x.staleStats) parts.push(t("sizeStaleStatsBadge"));
    if (x.growth != null) parts.push(t("sizeTreemapGrowth", { pct: pct(x.growth) }));
    return parts.join(", ");
  };

  const open = (x: TreemapTile) => {
    if (x.row && onOpenTable) onOpenTable(x.row.name);
  };

  const focusTile = (id: string | null) => {
    if (!id) return;
    setActiveId(id);
    svgRef.current?.querySelector<SVGGElement>(`[data-treemap-id="${CSS.escape(id)}"]`)?.focus();
  };

  const KEY_DIR: Record<string, TreemapDirection> = {
    ArrowLeft: "left",
    ArrowRight: "right",
    ArrowUp: "up",
    ArrowDown: "down",
  };
  const onKeyDown = (e: ReactKeyboardEvent<SVGSVGElement>) => {
    const id = (e.target as Element).getAttribute?.("data-treemap-id");
    const cur = id ? byId.get(id) : undefined;
    if (!cur) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      open(cur);
      return;
    }
    if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      focusTile(tiles[e.key === "Home" ? 0 : tiles.length - 1]?.id ?? null);
      return;
    }
    const dir = KEY_DIR[e.key];
    if (!dir) return;
    e.preventDefault();
    focusTile(neighborTile(tiles, cur.id, dir));
  };

  const strip = (names: string[], label: string) =>
    names.length === 0 ? null : (
      <Box css={barCss} role="group" aria-label={label}>
        <chakra.span textStyle="overline" color="app.textMuted">
          {label} ({names.length})
        </chakra.span>
        {names.slice(0, STRIP_LIMIT).map((n) => (
          <Button
            key={n}
            size="sm"
            variant="secondary"
            disabled={!onOpenTable}
            onClick={() => onOpenTable?.(n)}
          >
            {n}
          </Button>
        ))}
        {names.length > STRIP_LIMIT && (
          <chakra.span textStyle="caption">
            {t("sizeTreemapStripMore", { count: names.length - STRIP_LIMIT })}
          </chakra.span>
        )}
      </Box>
    );

  return (
    <Box display="flex" flexDirection="column" minWidth={0} border="1px solid var(--border-subtle)">
      <Box css={barCss}>
        <chakra.span color="app.textSecondary">{t("sizeTreemapBasis")}</chakra.span>
        <Box flex="1" />
        <chakra.span display="inline-flex" alignItems="center" gap="1" textStyle="caption">
          <Box aria-hidden w="3" h="3" borderRadius="sm" style={{ background: dataFill }} />
          {t("sizeColData")}
        </chakra.span>
        <chakra.span display="inline-flex" alignItems="center" gap="1" textStyle="caption">
          <Box aria-hidden w="3" h="3" borderRadius="sm" style={{ background: indexFill }} />
          {t("sizeColIndex")}
        </chakra.span>
        {tiles.length > 0 && (
          <ImageExportButton
            filenameBase={`table_size_treemap_${database}`}
            makePng={(opts) =>
              elementToPngBlob(svgRef.current as unknown as HTMLElement, { ...exportSize, ...opts })
            }
            makeSvg={() => elementToSvgBytes(svgRef.current as unknown as HTMLElement, exportSize)}
          />
        )}
      </Box>
      {tiles.length === 0 ? (
        <Box p="4" color="app.textMuted" fontSize="sm">
          {t("sizeTreemapEmpty")}
        </Box>
      ) : (
        <Box p="2">
          <svg
            ref={svgRef}
            viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
            width="100%"
            role="listbox"
            aria-label={t("sizeTreemapSvgLabel")}
            onKeyDown={onKeyDown}
            style={{ display: "block" }}
          >
            {tiles.map((x) => {
              const rx = x.x + TILE_GAP;
              const ry = x.y + TILE_GAP;
              const rw = Math.max(0, x.w - TILE_GAP * 2);
              const rh = Math.max(0, x.h - TILE_GAP * 2);
              const other = x.id === TREEMAP_OTHER_ID;
              const split = x.dataShare;
              const dataH = split == null ? rh : rh * split;
              const topFill = other || split == null ? "var(--bg-muted)" : dataFill;
              const ink =
                other || split == null ? "var(--text)" : readableInk(dataH >= rh / 2 ? dataFill : indexFill);
              const emphasized = x.id === hoverId || x.id === focusId;
              const warn = x.bloated || x.indexHeavy;
              const growthSrc = x.growth != null && rh >= 24 ? `${pct(x.growth)}%` : "";
              const {
                name: label,
                growth: growthText,
                growthTriangleX,
              } = layoutTileLabel(nameOf(x), rw, growthSrc);
              const labelY = split != null && dataH < rh / 2 ? ry + dataH + 14 : ry + 14;
              return (
                <g
                  key={x.id}
                  data-treemap-id={x.id}
                  role="option"
                  tabIndex={x.id === tabStop ? 0 : -1}
                  aria-label={describe(x)}
                  aria-selected={false}
                  aria-disabled={other || !onOpenTable || undefined}
                  style={{ cursor: !other && onOpenTable ? "pointer" : "default", outline: "none" }}
                  onClick={() => {
                    setActiveId(x.id);
                    open(x);
                  }}
                  onMouseEnter={() => setHoverId(x.id)}
                  onMouseLeave={() => setHoverId(null)}
                  onFocus={() => {
                    setHoverId(x.id);
                    setActiveId(x.id);
                    setFocusId(x.id);
                  }}
                  onBlur={() => {
                    setHoverId(null);
                    setFocusId(null);
                  }}
                >
                  <motion.rect
                    initial={false}
                    animate={{ attrX: rx, attrY: ry, width: rw, height: rh }}
                    transition={move}
                    rx={3}
                    fill={topFill}
                  />
                  {split != null && !other && (
                    <motion.rect
                      initial={false}
                      animate={{ attrX: rx, attrY: ry + dataH, width: rw, height: Math.max(0, rh - dataH) }}
                      transition={move}
                      fill={indexFill}
                    />
                  )}
                  <motion.rect
                    initial={false}
                    animate={{ attrX: rx, attrY: ry, width: rw, height: rh }}
                    transition={move}
                    rx={3}
                    fill="none"
                    stroke={
                      emphasized
                        ? "var(--accent)"
                        : warn
                          ? semanticColorVar("warning", "solid")
                          : "var(--border-subtle)"
                    }
                    strokeWidth={emphasized || warn ? 2 : 1}
                    strokeDasharray={x.indexHeavy && !x.bloated && !emphasized ? "4 3" : undefined}
                  />
                  {x.staleStats && rw >= 16 && rh >= 16 && (
                    // 統計が古い表の目印 (左上の小さな info 色の三角)。詳細はホバーカード / aria-label。
                    <path
                      aria-hidden
                      d={`M ${rx + 1} ${ry + 1} h 6 l -6 6 z`}
                      fill={semanticColorVar("info", "solid")}
                      style={{ pointerEvents: "none" }}
                    />
                  )}
                  {label && rh >= 18 && (
                    <text
                      x={rx + PAD}
                      y={labelY}
                      fill={ink}
                      style={{ fontSize: "var(--text-xs)", pointerEvents: "none" }}
                    >
                      {label}
                    </text>
                  )}
                  {label && rh >= 38 && labelY + 14 <= ry + rh - 2 && (
                    <text
                      x={rx + PAD}
                      y={labelY + 14}
                      fill={ink}
                      style={{ fontSize: "var(--text-xs)", pointerEvents: "none", opacity: 0.85 }}
                    >
                      {formatBytes(x.value)}
                    </text>
                  )}
                  {growthText && (
                    <g aria-hidden style={{ pointerEvents: "none" }}>
                      {/* 前回取得からの増加を示す小さな上向き三角 (文字グリフではなく図形で描く)。 */}
                      <path d={`M ${rx + growthTriangleX} ${labelY} l 4 -8 l 4 8 z`} fill={ink} />
                      <text
                        x={rx + rw - PAD}
                        y={labelY}
                        textAnchor="end"
                        fill={ink}
                        style={{ fontSize: "var(--text-xs)" }}
                      >
                        {growthText}
                      </text>
                    </g>
                  )}
                </g>
              );
            })}
          </svg>
        </Box>
      )}
      <TreemapDetail tile={shown} />
      {strip(layout.unknown, t("sizeTreemapUnknown"))}
      {strip(layout.empty, t("sizeTreemapEmptyTables"))}
      <Box px="2" py="1" textStyle="caption">
        {t("sizeTreemapHint")}
      </Box>
    </Box>
  );
}

/** ホバー / フォーカス中のタイルの詳細カード (StatTile と同じ面・枠のトーン)。 */
function TreemapDetail({ tile }: { tile: TreemapTile | null }) {
  const t = useT();
  const body = !tile ? (
    <chakra.span textStyle="caption">{t("sizeTreemapDetailIdle")}</chakra.span>
  ) : (
    <Box display="flex" flexWrap="wrap" alignItems="center" columnGap="3" rowGap="1">
      <chakra.span fontWeight="600">
        {tile.id === TREEMAP_OTHER_ID ? t("sizeTreemapOther", { count: tile.count }) : tile.id}
      </chakra.span>
      <chakra.span textStyle="numeric">
        {t("sizeColTotal")}: {formatBytes(tile.value)} ({pct(tile.share)}%)
      </chakra.span>
      {tile.row && (
        <>
          <chakra.span textStyle="numeric">
            {t("sizeColRows")}: {formatRowCount(tile.row.row_estimate)}
          </chakra.span>
          <chakra.span textStyle="numeric">
            {t("sizeColData")}: {formatBytes(tile.row.data_bytes)}
          </chakra.span>
          <chakra.span textStyle="numeric">
            {t("sizeColIndex")}: {formatBytes(tile.row.index_bytes)}
          </chakra.span>
          {tile.row.change && formatDelta(tile.row.change.totalBytes, "bytes") && (
            <chakra.span textStyle="numeric">
              {t("sizeTreemapDelta", {
                delta: formatDelta(tile.row.change.totalBytes, "bytes") ?? "",
              })}
            </chakra.span>
          )}
        </>
      )}
      {tile.bloated && <ToneChip tone="warning">{t("sizeBloatedBadge")}</ToneChip>}
      {tile.indexHeavy && <ToneChip tone="warning">{t("sizeTreemapIndexHeavy")}</ToneChip>}
      {tile.staleStats && <ToneChip tone="info">{t("sizeStaleStatsBadge")}</ToneChip>}
      {tile.growth != null && (
        <ToneChip tone="warning">{t("sizeTreemapGrowth", { pct: pct(tile.growth) })}</ToneChip>
      )}
      {tile.id === TREEMAP_OTHER_ID && (
        <chakra.span textStyle="caption">
          {tile.members.slice(0, 8).join(", ")}
          {tile.members.length > 8 ? "…" : ""}
        </chakra.span>
      )}
    </Box>
  );
  return (
    <Box
      px="3"
      py="2"
      minH="10"
      borderTop="1px solid var(--border-subtle)"
      bg="app.surface"
      aria-live="polite"
      fontSize="sm"
    >
      {body}
    </Box>
  );
}
