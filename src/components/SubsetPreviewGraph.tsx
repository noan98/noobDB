import { type CSSProperties, useEffect, useMemo, useState } from "react";
import { chakra, Flex } from "@chakra-ui/react";
import { motion, useReducedMotion } from "motion/react";
import type { ForeignKey, SubsetPreview } from "../api/tauri";
import { rampStops, sampleRamp, SEQUENTIAL_RAMPS, useIsDarkTheme } from "../colorScale";
import { type I18nKey, useT } from "../i18n";
import { staggerContainer, staggerTiming, variants } from "../motion";
import { semanticColorToken } from "../semanticColors";
import { Callout } from "./Callout";
import { Icon, ICON_SIZES } from "./Icon";
import { StatTile } from "./StatTile";
import {
  barPercent,
  buildSubsetGraph,
  collapseLanes,
  edgeKey,
  GEOMETRY,
  geometryWidth,
  layoutEdges,
  type PlacedEdge,
  type SubsetLane,
  type SubsetNode,
  type SubsetNodeExtra,
  SUBSET_LANES,
  tracePathToRoot,
} from "./subsetPreviewModel";
import { subsetWarningMessage } from "./subsetExtract";
import { Tooltip } from "./Tooltip";
import { ToneChip } from "./ToneChip";

/**
 * サブセット抽出のプレビューを「親 ← 起点 → 子」の FK 辿り図で見せる (#2266)。
 *
 * - 上に要約タイル (総行数・表の数・最大の深さ)。値は `StatTile` の `CountUp` で再計算のたびに変化する。
 * - 3 レーン (親の方向 / 起点 / 子の方向) の各ノードに、行数に比例するバー (`colorScale` の sequential ランプ) と数値。
 * - 外部キーのエッジは SVG の曲線 (レーン・行は等間隔のグリッドなので、`subsetPreviewModel.ts` の単位座標で足りる)。
 * - 打ち切り・循環はノード上のバッジ (アイコン + 文言)。警告の帯は要約 1 つに縮める。
 * - エッジは `pathLength={1}` で描き入れる (`.subset-edge`)。遅れは終点ノードの stagger 順 (`staggerTiming`) に合わせ、
 *   ノードの入場と同期する。reduced-motion / hc-* は `App.css` 側で最初から描かれる。
 * - ノードへのホバー / フォーカスで起点までの経路 (`tracePathToRoot`) を強調し、経路上のエッジに FK の列名を出す。
 *   経路外は減光 (opacity の transition。reduced-motion は瞬時)。
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

/** エッジの線幅 (SVG の viewBox 非依存。`vectorEffect` で拡縮しない)。 */
const EDGE_STROKE = 1.5;
const EDGE_STROKE_LIT = 2.5;
const EDGE_OPACITY = 0.6;
const EDGE_OPACITY_LIT = 1;
/** 経路強調中、経路外のノード・エッジの不透明度。 */
const DIM_OPACITY = 0.35;
const EDGE_OPACITY_DIM = 0.15;

/** レーン数に応じたグリッドの列 (`レーン 溝 レーン …`)。 */
function gridColumns(laneCount: number): string {
  return Array.from({ length: laneCount }, () => `${GEOMETRY.laneWidth}fr`).join(` ${GEOMETRY.gutter}fr `);
}

/** 図の使われ方。`clone` (子行の複製 #2323) は親へ辿らないので親レーンと親の段数を出さず、文言も複製向け。 */
export type SubsetGraphVariant = "extract" | "clone";
const VARIANT_LANES: Record<SubsetGraphVariant, readonly SubsetLane[]> = {
  extract: SUBSET_LANES,
  clone: ["root", "child"],
};
/** 行の高さ (名前 + バー + バッジの 3 段が収まる)。エッジの縦座標が「1 行 = 1」なので全行で揃える。 */
const ROW_HEIGHT = "calc(var(--space-12) + var(--space-4))";

interface Props {
  preview: SubsetPreview;
  foreignKeys: readonly ForeignKey[];
  /** 条件が変わって古くなったプレビュー (図ごと淡色にする)。 */
  stale: boolean;
  /** プレビューを取り直すたびに変わる値 (入場アニメーションをやり直す)。 */
  runKey: string | null;
  /** 表名 → ノードに足すチップ・強調 (子行の複製で主キーの状態を載せる)。省略するとサブセット抽出そのまま。 */
  nodeExtras?: ReadonlyMap<string, SubsetNodeExtra>;
  /** 既定はサブセット抽出。 */
  variant?: SubsetGraphVariant;
}

function laneColumn(lane: SubsetLane, order: readonly SubsetLane[]): number {
  return order.indexOf(lane) * 2 + 1;
}

/**
 * ノード下段の印。行は 1 本で折り返さないので、打ち切りの文言 (長い) は省略表示に縮み、
 * 循環 (短い) は縮まず、どちらも切れない (`shrink`)。詳細はツールチップ。
 */
function Badge({
  icon,
  children,
  title,
  shrink = false,
}: {
  icon: "cut" | "refresh";
  children: string;
  title?: string;
  shrink?: boolean;
}) {
  const el = (
    <chakra.span
      display="inline-flex"
      alignItems="center"
      gap="1"
      minW="0"
      flexShrink={shrink ? 1 : 0}
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
      <chakra.span minW="0" truncate>
        {children}
      </chakra.span>
    </chakra.span>
  );
  return title ? <Tooltip label={title}>{el}</Tooltip> : el;
}

function GraphNode({
  node,
  row,
  barColor,
  index,
  dim,
  onHover,
  onFocusNode,
  extra,
  laneOrder,
}: {
  laneOrder: readonly SubsetLane[];
  extra?: SubsetNodeExtra;
  node: SubsetNode;
  row: number;
  barColor: string;
  index: number;
  /** 経路強調中で、この表は経路の外 (減光する)。 */
  dim: boolean;
  /** ホバー / フォーカスの出入り (離れたら null)。 */
  onHover: (table: string | null) => void;
  onFocusNode: (table: string | null) => void;
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
      gridColumn={laneColumn(node.lane, laneOrder)}
      gridRow={row + 1}
      py="0.5"
      minW="0"
      data-testid="subset-preview-node"
      data-lane={node.lane}
      data-table={node.table}
      data-dim={dim ? "true" : "false"}
      onPointerEnter={() => onHover(node.table)}
      onPointerLeave={() => onHover(null)}
      onFocus={() => onFocusNode(node.table)}
      onBlur={() => onFocusNode(null)}
    >
      <chakra.div
        role="group"
        tabIndex={0}
        opacity={dim ? DIM_OPACITY : 1}
        transition="opacity var(--dur-fast) var(--ease)"
        _focusVisible={{ outline: "none", boxShadow: "var(--focus-ring)" }}
        aria-label={
          t("subsetNodeAria", { table: node.table, rows: node.rows, roles }) +
          (node.references.length > 0
            ? ` / ${t("subsetNodeRefs", { tables: node.references.join(", ") })}`
            : "")
        }
        h="100%"
        px="2"
        py="1"
        borderRadius="md"
        borderColor={
          extra?.emphasize
            ? semanticColorToken("warning", "solid")
            : node.lane === "root"
              ? "app.accent"
              : "app.border"
        }
        borderWidth={extra?.emphasize ? "2px" : "1px"}
        data-emphasis={extra?.emphasize ? "true" : undefined}
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
          {extra?.chips.map((c) => (
            <Tooltip key={c.key} label={c.detail ?? c.label}>
              <chakra.span display="inline-flex" minW="0" flexShrink={1}>
                <ToneChip tone={c.tone} shrink testId="subset-preview-chip" ariaLabel={c.detail}>
                  {c.label}
                </ToneChip>
              </chakra.span>
            </Tooltip>
          ))}
          {node.truncations.map((tr) => (
            <Badge
              key={tr.kind}
              icon="cut"
              shrink
              title={t(tr.kind === "root" ? "subsetBadgeTruncatedRootTip" : "subsetBadgeTruncatedChildTip", {
                limit: tr.limit,
              })}
            >
              {t("subsetBadgeTruncated", { limit: tr.limit })}
            </Badge>
          ))}
          {node.cycle && (
            <Badge
              shrink={false}
              icon="refresh"
              title={t("subsetBadgeCycleTip", { tables: node.cycleTables.join(" → ") })}
            >
              {t("subsetBadgeCycle")}
            </Badge>
          )}
        </Flex>
      </chakra.div>
    </MotionDiv>
  );
}

/** 辺の描き入れ: マウント直後の 1 フレーム後に `data-lit` を立てて dashoffset を動かす。 */
function useDrawIn(): boolean {
  const [lit, setLit] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setLit(true));
    return () => cancelAnimationFrame(id);
  }, []);
  return lit;
}

/** 辺の描き入れの遅れ (秒)。終点ノード (遅いほう) の stagger 順に合わせる。 */
function edgeDelay(index: number, reduced: boolean): number {
  if (reduced || index >= STAGGER_CAP) return 0;
  return staggerTiming.delay + index * staggerTiming.each;
}

/** SVG のエッジ。`runKey` で作り直されるたびに描き入れる。 */
function EdgeLayer({
  edges,
  delays,
  litKeys,
  active,
  rowCount,
  width,
}: {
  width: number;
  edges: readonly PlacedEdge[];
  delays: ReadonlyMap<string, number>;
  litKeys: ReadonlySet<string> | null;
  active: boolean;
  rowCount: number;
}) {
  const lit = useDrawIn();
  return (
    <chakra.svg
      position="absolute"
      inset="0"
      w="100%"
      h="100%"
      color="app.textMuted"
      pointerEvents="none"
      viewBox={`0 0 ${width} ${rowCount}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      data-testid="subset-preview-edges"
    >
      {edges.map((e) => {
        const on = litKeys !== null && e.keys.some((k) => litKeys.has(k));
        return (
          <path
            key={`${e.from}>${e.to}`}
            className="subset-edge"
            d={e.d}
            pathLength={1}
            fill="none"
            stroke="currentColor"
            vectorEffect="non-scaling-stroke"
            data-from={e.from}
            data-to={e.to}
            data-lit={lit ? "true" : "false"}
            data-hl={on ? "true" : "false"}
            style={
              {
                strokeWidth: on ? EDGE_STROKE_LIT : EDGE_STROKE,
                strokeOpacity: on ? EDGE_OPACITY_LIT : active ? EDGE_OPACITY_DIM : EDGE_OPACITY,
                "--edge-delay": `${delays.get(`${e.from}>${e.to}`) ?? 0}s`,
              } as CSSProperties
            }
          />
        );
      })}
    </chakra.svg>
  );
}

export function SubsetPreviewGraph({
  preview,
  foreignKeys,
  stale,
  runKey,
  nodeExtras,
  variant = "extract",
}: Props) {
  const t = useT();
  const reduced = useReducedMotion() ?? false;
  const isDark = useIsDarkTheme();
  const stops = rampStops(SEQUENTIAL_RAMPS.teal, isDark);
  const laneOrder = VARIANT_LANES[variant];
  const isClone = variant === "clone";
  const [expanded, setExpanded] = useState<ReadonlySet<SubsetLane>>(() => new Set());

  const graph = useMemo(() => buildSubsetGraph(preview, foreignKeys), [preview, foreignKeys]);
  const keep = useMemo(
    () => new Set([...(nodeExtras ?? [])].filter(([, x]) => x.emphasize).map(([k]) => k)),
    [nodeExtras],
  );
  const lanes = useMemo(() => collapseLanes(graph.nodes, { expanded, keep }), [graph.nodes, expanded, keep]);
  const collapsible = useMemo(() => collapseLanes(graph.nodes, { keep }), [graph.nodes, keep]);
  const edges = useMemo(() => layoutEdges(lanes, graph.edges, laneOrder), [lanes, graph.edges, laneOrder]);
  const rowCount = Math.max(1, ...laneOrder.map((l) => lanes[l].length));
  const gridCols = gridColumns(laneOrder.length);

  // ホバー / フォーカス中の表と、そこから起点までの経路。再プレビューで表が消えたら強調しない。
  // ホバーとフォーカスは別々に持ち (互いに消し合わない)、ホバーを優先する。
  const [hoverTable, setHoverTable] = useState<string | null>(null);
  const [focusTable, setFocusTable] = useState<string | null>(null);
  const activeTable = hoverTable ?? focusTable;
  const path = useMemo(
    () =>
      activeTable !== null && graph.nodes.some((n) => n.table === activeTable)
        ? tracePathToRoot(graph, activeTable)
        : null,
    [graph, activeTable],
  );
  const litKeys = useMemo(
    () => (path ? new Set(path.edges.map((e) => edgeKey(e.from, e.to))) : null),
    [path],
  );
  // 表示項目 (折りたたみ含む) の入場順。辺は「遅いほうの端」のノードと同期して描き入れる。
  const delays = useMemo(() => {
    const order = new Map<string, number>();
    let i = 0;
    for (const lane of laneOrder) {
      for (const item of lanes[lane]) {
        if (item.kind === "node") order.set(item.node.table, i);
        else for (const tb of item.tables) order.set(tb, i);
        i++;
      }
    }
    const out = new Map<string, number>();
    for (const e of edges) {
      const idx = Math.max(order.get(e.from) ?? 0, order.get(e.to) ?? 0);
      out.set(`${e.from}>${e.to}`, edgeDelay(idx, reduced));
    }
    return out;
  }, [lanes, edges, reduced, laneOrder]);
  const litLabels = useMemo(
    () =>
      litKeys
        ? edges.flatMap((e) => {
            const labels = e.keys.filter((k) => litKeys.has(k)).flatMap((k) => e.labels[k] ?? []);
            return labels.length > 0 ? [{ id: `${e.from}>${e.to}`, text: labels.join(", ") }] : [];
          })
        : [],
    [litKeys, edges],
  );

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
  const maxDepth = isClone ? graph.childDepth : Math.max(graph.parentDepth, graph.childDepth);
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
        transition="opacity var(--dur-med) var(--ease)"
      >
        <Flex gap="2" wrap="wrap">
          <StatTile label={t("subsetStatRows")} value={preview.totalRows} />
          <StatTile label={t("subsetStatTables")} value={preview.tables.length} />
          <StatTile
            label={t("subsetStatDepth")}
            value={maxDepth}
            sub={
              isClone
                ? undefined
                : t("subsetStatDepthSub", { parent: graph.parentDepth, child: graph.childDepth })
            }
          />
        </Flex>

        <chakra.div
          role="group"
          aria-label={t(isClone ? "cloneGraphAria" : "subsetGraphAria")}
          borderWidth="1px"
          borderColor="app.border"
          borderRadius="md"
          px="2"
          py="2"
          display="flex"
          flexDirection="column"
          gap="1"
        >
          <chakra.div display="grid" gridTemplateColumns={gridCols} alignItems="center">
            {laneOrder.map((lane) => (
              <Flex
                key={lane}
                gridColumn={laneColumn(lane, laneOrder)}
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
                    aria-expanded="true"
                    aria-label={`${t("subsetMoreCollapse")}: ${t(LANE_LABEL[lane])}`}
                    onClick={() => toggle(lane)}
                  >
                    {t("subsetMoreCollapse")}
                  </chakra.button>
                )}
              </Flex>
            ))}
          </chakra.div>

          <chakra.div position="relative">
            <EdgeLayer
              key={`edges-${runKey ?? "none"}`}
              width={geometryWidth(laneOrder.length)}
              edges={edges}
              delays={delays}
              litKeys={litKeys}
              active={path !== null}
              rowCount={rowCount}
            />
            <MotionDiv
              key={`nodes-${runKey ?? "none"}`}
              variants={staggerContainer(reduced)}
              initial="initial"
              animate="animate"
              position="relative"
              display="grid"
              gridTemplateColumns={gridCols}
              gridAutoRows={ROW_HEIGHT}
            >
              {laneOrder.flatMap((lane) =>
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
                        extra={nodeExtras?.get(item.node.table)}
                        laneOrder={laneOrder}
                        dim={path !== null && !path.tables.has(item.node.table)}
                        onHover={setHoverTable}
                        onFocusNode={setFocusTable}
                      />
                    );
                  }
                  return (
                    <MotionDiv
                      key={item.id}
                      variants={variants.staggerItem}
                      gridColumn={laneColumn(lane, laneOrder)}
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
                          opacity={
                            path !== null && !item.tables.some((tb) => path.tables.has(tb)) ? DIM_OPACITY : 1
                          }
                          transition="opacity var(--dur-fast) var(--ease)"
                          data-testid="subset-preview-more"
                          aria-expanded="false"
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
          {/* 強調中の辺の FK 列名は図の上に重ねず、図の下の帯に並べる (ノードの名前・行数と重ならない, #2316)。 */}
          <Flex
            minH="1.75em"
            mt="1.5"
            flexWrap="wrap"
            alignItems="center"
            gap="1.5"
            data-testid="subset-preview-edge-labels"
          >
            {litLabels.map((l) => (
              <chakra.span
                key={l.id}
                px="1"
                borderRadius="sm"
                borderWidth="1px"
                borderColor="app.border"
                bg="app.surface"
                color="app.text"
                fontFamily="mono"
                textStyle="caption"
                wordBreak="break-all"
                data-testid="subset-preview-edge-label"
              >
                {l.text}
              </chakra.span>
            ))}
          </Flex>
        </chakra.div>
        <chakra.span textStyle="caption" color="app.textMuted">
          {t(isClone ? "cloneGraphHint" : "subsetGraphHint")}
        </chakra.span>
        {(cycleCount > 0 || truncatedTables > 0) && (
          <Callout tone="warning" role="status" data-testid="subset-preview-summary">
            {[
              cycleCount > 0
                ? t(isClone ? "cloneSummaryCycles" : "subsetSummaryCycles", { count: cycleCount })
                : null,
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
    </chakra.div>
  );
}
