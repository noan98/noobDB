import { useMemo, useState } from "react";
import { chakra, Flex } from "@chakra-ui/react";
import { motion, useReducedMotion } from "motion/react";
import type { ForeignKey, SubsetPreview } from "../api/tauri";
import { rampStops, sampleRamp, SEQUENTIAL_RAMPS, useIsDarkTheme } from "../colorScale";
import { type I18nKey, useT } from "../i18n";
import { staggerContainer, variants } from "../motion";
import { semanticColorToken } from "../semanticColors";
import { Callout } from "./Callout";
import { Icon, ICON_SIZES } from "./Icon";
import { StatTile } from "./StatTile";
import {
  barPercent,
  buildSubsetGraph,
  collapseLanes,
  GEOMETRY,
  layoutEdges,
  type SubsetLane,
  type SubsetNode,
  SUBSET_LANES,
} from "./subsetPreviewModel";
import { subsetWarningMessage } from "./subsetExtract";
import { Tooltip } from "./Tooltip";

/**
 * サブセット抽出のプレビューを「親 ← 起点 → 子」の FK 辿り図で見せる (#2266)。
 *
 * - 上に要約タイル (総行数・表の数・最大の深さ)。値は `StatTile` の `CountUp` で再計算のたびに変化する。
 * - 3 レーン (親の方向 / 起点 / 子の方向) の各ノードに、行数に比例するバー (`colorScale` の sequential ランプ) と数値。
 * - 外部キーのエッジは SVG の曲線 (レーン・行は等間隔のグリッドなので、`subsetPreviewModel.ts` の単位座標で足りる)。
 * - 打ち切り・循環はノード上のバッジ (アイコン + 文言)。警告の帯は要約 1 つに縮める。
 * - 条件を変えた後の古いプレビューは図ごと淡色。再プレビューのたびにノードを stagger で入場させる
 *   (`runKey` で作り直す。reduced-motion では即時)。
 * - 表が多いとき (`COLLAPSE_THRESHOLD` 以上) はレーンの中を `+N` へ折りたたみ、押すと広げる。
 */

const MotionDiv = chakra(motion.div, {}, { forwardProps: ["variants", "initial", "animate"] });

/** 図の入場を順次にする先頭ノード数 (多い図を全件遅延させない)。 */
const STAGGER_CAP = 20;

const LANE_LABEL: Record<SubsetLane, I18nKey> = {
  parent: "subsetLaneParent",
  root: "subsetLaneRoot",
  child: "subsetLaneChild",
};
const LANE_ICON = { parent: "fk-parent", root: "table", child: "fk-child" } as const;

const GRID_COLUMNS = `${GEOMETRY.laneWidth}fr ${GEOMETRY.gutter}fr ${GEOMETRY.laneWidth}fr ${GEOMETRY.gutter}fr ${GEOMETRY.laneWidth}fr`;
/** 行の高さ (名前 + バー + バッジの 3 段が収まる)。エッジの縦座標が「1 行 = 1」なので全行で揃える。 */
const ROW_HEIGHT = "calc(var(--space-12) + var(--space-4))";

interface Props {
  preview: SubsetPreview;
  foreignKeys: readonly ForeignKey[];
  /** 条件が変わって古くなったプレビュー (図ごと淡色にする)。 */
  stale: boolean;
  /** プレビューを取り直すたびに変わる値 (入場アニメーションをやり直す)。 */
  runKey: string | null;
}

function laneColumn(lane: SubsetLane): number {
  return SUBSET_LANES.indexOf(lane) * 2 + 1;
}

function Badge({ icon, children, title }: { icon: "cut" | "refresh"; children: string; title?: string }) {
  const el = (
    <chakra.span
      display="inline-flex"
      alignItems="center"
      gap="1"
      px="1.5"
      borderRadius="sm"
      borderWidth="1px"
      borderColor={semanticColorToken("warning", "border")}
      bg={semanticColorToken("warning", "subtle")}
      color={semanticColorToken("warning", "text")}
      textStyle="caption"
      whiteSpace="nowrap"
    >
      <Icon name={icon} size={ICON_SIZES.sm} />
      {children}
    </chakra.span>
  );
  return title ? <Tooltip label={title}>{el}</Tooltip> : el;
}

function GraphNode({
  node,
  row,
  barColor,
  index,
}: {
  node: SubsetNode;
  row: number;
  barColor: string;
  index: number;
}) {
  const t = useT();
  const roles = t("subsetPreviewRoles", {
    root: node.rootRows,
    child: node.childRows,
    parent: node.parentRows,
  });
  return (
    <MotionDiv
      variants={index < STAGGER_CAP ? variants.staggerItem : undefined}
      gridColumn={laneColumn(node.lane)}
      gridRow={row + 1}
      py="0.5"
      minW="0"
      data-testid="subset-preview-node"
      data-lane={node.lane}
      data-table={node.table}
    >
      <chakra.div
        role="group"
        aria-label={t("subsetNodeAria", { table: node.table, rows: node.rows, roles })}
        h="100%"
        px="2"
        py="1"
        borderRadius="md"
        borderWidth="1px"
        borderColor={node.lane === "root" ? "app.accent" : "app.border"}
        bg="app.surface"
        display="flex"
        flexDirection="column"
        justifyContent="center"
        gap="0.5"
        overflow="hidden"
      >
        <Flex align="baseline" gap="2" minW="0">
          <Tooltip label={`${node.table} (${roles})`}>
            <chakra.span flex="1" minW="0" fontFamily="mono" fontSize="sm" truncate>
              {node.table}
            </chakra.span>
          </Tooltip>
          <chakra.span fontFamily="mono" textStyle="numeric" fontSize="sm" data-testid="subset-preview-rows">
            {node.rows.toLocaleString()}
          </chakra.span>
        </Flex>
        <chakra.div h="1" borderRadius="pill" bg="app.bgInput" overflow="hidden" aria-hidden="true">
          <chakra.div
            h="100%"
            borderRadius="pill"
            data-testid="subset-preview-bar"
            style={{ width: `${barPercent(node.share)}%`, backgroundColor: barColor }}
          />
        </chakra.div>
        <Flex align="center" gap="1.5" minW="0" overflow="hidden">
          {node.lane !== "root" && node.truncations.length === 0 && !node.cycle && (
            <chakra.span textStyle="caption" color="app.textMuted" whiteSpace="nowrap">
              {t("subsetNodeDepth", { depth: node.depth })}
            </chakra.span>
          )}
          {node.truncations.map((tr) => (
            <Badge key={tr.kind} icon="cut">
              {t("subsetBadgeTruncated", { limit: tr.limit })}
            </Badge>
          ))}
          {node.cycle && (
            <Badge icon="refresh" title={t("subsetBadgeCycleTip")}>
              {t("subsetBadgeCycle")}
            </Badge>
          )}
        </Flex>
      </chakra.div>
    </MotionDiv>
  );
}

export function SubsetPreviewGraph({ preview, foreignKeys, stale, runKey }: Props) {
  const t = useT();
  const reduced = useReducedMotion() ?? false;
  const isDark = useIsDarkTheme();
  const stops = rampStops(SEQUENTIAL_RAMPS.teal, isDark);
  const [expanded, setExpanded] = useState<ReadonlySet<SubsetLane>>(() => new Set());

  const graph = useMemo(() => buildSubsetGraph(preview, foreignKeys), [preview, foreignKeys]);
  const lanes = useMemo(() => collapseLanes(graph.nodes, { expanded }), [graph.nodes, expanded]);
  const collapsible = useMemo(() => collapseLanes(graph.nodes), [graph.nodes]);
  const edges = useMemo(() => layoutEdges(lanes, graph.edges), [lanes, graph.edges]);
  const rowCount = Math.max(1, ...SUBSET_LANES.map((l) => lanes[l].length));

  const toggle = (lane: SubsetLane) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(lane)) next.delete(lane);
      else next.add(lane);
      return next;
    });

  const cycleCount = preview.cycles.length;
  const truncatedTables = graph.nodes.filter((n) => n.truncations.length > 0).length;
  const unresolved = preview.warnings.filter((w) => w.kind === "unresolvedForeignKey");
  const maxDepth = Math.max(graph.parentDepth, graph.childDepth);
  let nodeIndex = 0;

  return (
    <chakra.div
      data-testid="subset-preview"
      data-stale={stale ? "true" : "false"}
      display="flex"
      flexDirection="column"
      gap="2"
    >
      <chakra.div
        display="flex"
        flexDirection="column"
        gap="2"
        opacity={stale ? 0.5 : 1}
        transition="opacity 0.2s ease"
      >
        <Flex gap="2" wrap="wrap">
          <StatTile label={t("subsetStatRows")} value={preview.totalRows} />
          <StatTile label={t("subsetStatTables")} value={preview.tables.length} />
          <StatTile
            label={t("subsetStatDepth")}
            value={maxDepth}
            sub={t("subsetStatDepthSub", { parent: graph.parentDepth, child: graph.childDepth })}
          />
        </Flex>

        <chakra.div
          role="group"
          aria-label={t("subsetGraphAria")}
          borderWidth="1px"
          borderColor="app.border"
          borderRadius="md"
          px="2"
          py="2"
          display="flex"
          flexDirection="column"
          gap="1"
        >
          <chakra.div display="grid" gridTemplateColumns={GRID_COLUMNS} alignItems="center">
            {SUBSET_LANES.map((lane) => (
              <Flex
                key={lane}
                gridColumn={laneColumn(lane)}
                align="center"
                gap="1.5"
                color="app.textMuted"
                textStyle="overline"
              >
                <Icon name={LANE_ICON[lane]} size={ICON_SIZES.sm} />
                {t(LANE_LABEL[lane])}
                {expanded.has(lane) && collapsible[lane].some((i) => i.kind === "more") && (
                  <chakra.button
                    type="button"
                    textStyle="caption"
                    color="app.accent"
                    cursor="pointer"
                    onClick={() => toggle(lane)}
                  >
                    {t("subsetMoreCollapse")}
                  </chakra.button>
                )}
              </Flex>
            ))}
          </chakra.div>

          <chakra.div position="relative">
            <chakra.svg
              position="absolute"
              inset="0"
              w="100%"
              h="100%"
              color="app.textMuted"
              pointerEvents="none"
              viewBox={`0 0 ${GEOMETRY.width} ${rowCount}`}
              preserveAspectRatio="none"
              aria-hidden="true"
              data-testid="subset-preview-edges"
            >
              {edges.map((e) => (
                <path
                  key={`${e.from}>${e.to}`}
                  d={e.d}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.5}
                  strokeOpacity={0.6}
                  vectorEffect="non-scaling-stroke"
                  data-from={e.from}
                  data-to={e.to}
                />
              ))}
            </chakra.svg>
            <MotionDiv
              key={runKey ?? "none"}
              variants={staggerContainer(reduced)}
              initial="initial"
              animate="animate"
              position="relative"
              display="grid"
              gridTemplateColumns={GRID_COLUMNS}
              gridAutoRows={ROW_HEIGHT}
            >
              {SUBSET_LANES.flatMap((lane) =>
                lanes[lane].map((item, row) => {
                  if (item.kind === "node") {
                    const barColor = sampleRamp(0.35 + 0.65 * item.node.share, stops);
                    return (
                      <GraphNode
                        key={item.id}
                        node={item.node}
                        row={row}
                        barColor={barColor}
                        index={nodeIndex++}
                      />
                    );
                  }
                  return (
                    <MotionDiv
                      key={item.id}
                      variants={variants.staggerItem}
                      gridColumn={laneColumn(lane)}
                      gridRow={row + 1}
                      py="0.5"
                      minW="0"
                    >
                      <Tooltip label={item.tables.join(", ")}>
                        <chakra.button
                          type="button"
                          h="100%"
                          w="100%"
                          px="2"
                          borderRadius="md"
                          borderWidth="1px"
                          borderStyle="dashed"
                          borderColor="app.border"
                          bg="app.surface"
                          cursor="pointer"
                          display="flex"
                          alignItems="center"
                          justifyContent="space-between"
                          gap="2"
                          fontSize="sm"
                          data-testid="subset-preview-more"
                          aria-label={t("subsetMoreAria", { count: item.count, rows: item.rows })}
                          onClick={() => toggle(lane)}
                        >
                          <chakra.span>{t("subsetMoreLabel", { count: item.count })}</chakra.span>
                          <chakra.span fontFamily="mono" textStyle="numeric">
                            {item.rows.toLocaleString()}
                          </chakra.span>
                        </chakra.button>
                      </Tooltip>
                    </MotionDiv>
                  );
                }),
              )}
            </MotionDiv>
          </chakra.div>
        </chakra.div>
        <chakra.span textStyle="caption" color="app.textMuted">
          {t("subsetGraphHint")}
        </chakra.span>
      </chakra.div>

      {(cycleCount > 0 || truncatedTables > 0) && (
        <Callout tone="warning" role="status" data-testid="subset-preview-summary">
          {[
            cycleCount > 0 ? t("subsetSummaryCycles", { count: cycleCount }) : null,
            truncatedTables > 0 ? t("subsetSummaryTruncated", { count: truncatedTables }) : null,
            t("subsetSummaryHint"),
          ]
            .filter((s) => s !== null)
            .join(" ")}
        </Callout>
      )}
      {unresolved.map((w) => (
        <Callout key={JSON.stringify(w)} tone="warning" role="status">
          {t(subsetWarningMessage(w).key, subsetWarningMessage(w).params)}
        </Callout>
      ))}
    </chakra.div>
  );
}
