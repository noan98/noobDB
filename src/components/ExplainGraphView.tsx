import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import { Box, chakra, type SystemStyleObject } from "@chakra-ui/react";
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Controls,
  Handle,
  MiniMap,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  getNodesBounds,
  getSmoothStepPath,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { useReducedMotion } from "motion/react";

import { SEQUENTIAL_RAMPS, rampStops, readableInk, sampleRamp, useIsDarkTheme } from "../colorScale";
import { useT } from "../i18n";
import { semanticColorVar } from "../semanticColors";
import {
  buildPlanGraph,
  actualTotalMs,
  computeHints,
  formatDurationMs,
  formatNumber,
  heatT,
  layoutPlanGraph,
  worstSeverity,
  type PlanNode,
} from "./explainPlan";
import {
  FLOW_EDGE_ENTER_CLASS,
  FLOW_MORPH_MS,
  FLOW_NODE_ENTER_CLASS,
  flowEntranceMs,
  rankIndices,
  staggerStyle,
  useFlowMorphing,
} from "./flowMotion";
import { prefersStaticMotion } from "./revealOrigin";
import { ImageExportButton } from "./ImageExportButton";
import { elementToPngBlob, elementToSvgBytes, erExportGeometry } from "./imageExport";
import { Tooltip } from "./Tooltip";

/**
 * EXPLAIN プランのノードツリーを @xyflow/react + @dagrejs/dagre で node-link 図と
 * して描く (#623)。レイアウト/グラフ構築は純ロジック (`explainPlan.ts`) に分離し、
 * 本ファイルは React Flow のシェル。各ノードはコストを `colorScale` の sequential
 * ランプでヒート着色し (色は二重定義しない)、注意ノードに `!` マーカーを出す。
 * ER 図 (`ERDiagramView.tsx`) の React Flow 作法を踏襲。
 */

interface PlanNodeData {
  label: string;
  cost: number | null;
  /** 0–1 のヒート値。null なら中立色 (コスト無し)。 */
  heat: number | null;
  rows: number | null;
  /** 実測モード (#1164): 実測行数 / 実時間 (ms)。推定 EXPLAIN では null。 */
  actualRows: number | null;
  actualMs: number | null;
  worstHint: "info" | "caution" | "warning" | null;
  selected: boolean;
  /** ノード検索に一致 (#1628)。 */
  match: boolean;
  onSelect: () => void;
  [key: string]: unknown;
}
type PlanFlowNode = Node<PlanNodeData, "planNode">;

const cardBaseCss: SystemStyleObject = {
  width: "100%",
  height: "100%",
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-0-75)",
  justifyContent: "center",
  padding: "var(--space-2) var(--space-2-5)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-md)",
  boxShadow: "var(--elevation-raised)",
  cursor: "pointer",
  overflow: "hidden",
  fontSize: "var(--text-sm)",
};

const labelCss: SystemStyleObject = {
  fontFamily: "var(--font-mono)",
  fontWeight: 600,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const metaCss: SystemStyleObject = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-1-5)",
  fontSize: "var(--text-2xs)",
  textStyle: "numeric",
};

/** One plan-tree node. Background is the cost heat; text ink adapts to it. */
function PlanFlowNodeView({ data }: NodeProps<PlanFlowNode>) {
  const t = useT();
  // ダークテーマでは「暗→明」の向きへ切り替える (#1187)。
  const isDark = useIsDarkTheme();
  // コスト → 背景色。ヒートが null (コスト無し) のときは中立の薄色を使う。
  const fill = data.heat === null ? null : sampleRamp(data.heat, rampStops(SEQUENTIAL_RAMPS.blue, isDark));
  // 固定しきい値 (旧: heat >= 0.5) ではなく塗り色そのものとの実コントラストで
  // 選ぶ (`readableInk`、#646/#1187)。ダークの暗→明ランプでは低ヒートが暗色に
  // なるため、しきい値方式のままだと反転後にインクが誤った側になる。
  const ink = fill ? readableInk(fill) : "var(--text)";
  const css: SystemStyleObject = {
    ...cardBaseCss,
    background: fill ?? "var(--bg-elevated)",
    color: ink,
    borderColor: data.selected ? "var(--accent)" : "var(--border)",
    outline: data.selected ? "2px solid var(--accent)" : data.match ? "2px dashed var(--accent)" : "none",
    // キーボードフォーカス中は、選択リングとは別に共通のフォーカスリングを重ねる。
    "&:focus-visible": { outline: "none", boxShadow: "var(--focus-ring)" },
  };
  return (
    <Tooltip label={data.label}>
      <Box
        css={css}
        // グラフ表示でもキーボードだけで選択 (= 詳細の確認) できるようにする。
        // React Flow 既定のノードラッパーのフォーカスは `nodesFocusable={false}` で
        // 止め、タブ停止位置をこの要素 1 つに揃える。
        role="button"
        tabIndex={0}
        aria-label={data.label}
        aria-pressed={data.selected}
        data-search-match={data.match ? "true" : undefined}
        onClick={data.onSelect}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            e.stopPropagation();
            data.onSelect();
          }
        }}
      >
        <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
        <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
        <chakra.span css={labelCss}>{data.label}</chakra.span>
        <chakra.span css={metaCss} opacity={0.92}>
          {data.cost !== null && <span>{t("explainNodeCost", { cost: formatNumber(data.cost) })}</span>}
          {data.actualRows !== null ? (
            <span>
              {data.rows !== null
                ? t("explainNodeActualRows", {
                    est: formatNumber(data.rows),
                    actual: formatNumber(data.actualRows),
                  })
                : t("explainNodeRows", { rows: formatNumber(data.actualRows) })}
            </span>
          ) : (
            data.rows !== null && <span>{t("explainNodeRows", { rows: formatNumber(data.rows) })}</span>
          )}
          {data.actualMs !== null && <span>{formatDurationMs(data.actualMs)}</span>}
          {data.worstHint && data.worstHint !== "info" && (
            <chakra.span
              fontWeight={700}
              px="1"
              borderRadius="var(--radius-sm)"
              background={
                data.worstHint === "warning"
                  ? semanticColorVar("danger", "solid")
                  : semanticColorVar("warning", "solid")
              }
              color="app.onSolid"
            >
              !
            </chakra.span>
          )}
        </chakra.span>
      </Box>
    </Tooltip>
  );
}

/**
 * 親子をつなぐ線。smoothstep と同じ経路を `pathLength=1` で引き、入場時に
 * `stroke-dashoffset` で描画する (#1861, App.css の `.flow-edge-enter`)。遅延は子ノードの深さ。
 */
const PlanFlowEdge = memo(function PlanFlowEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps<Edge<{ stagger: number }>>) {
  const [path] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  return <BaseEdge id={id} path={path} pathLength={1} style={staggerStyle(data?.stagger ?? 0)} />;
});

const nodeTypes = { planNode: PlanFlowNodeView };
const edgeTypes = { planEdge: PlanFlowEdge };
const defaultEdgeOptions = { type: "planEdge" } as const;

function rowsOf(node: PlanNode): number | null {
  const find = (key: string): unknown => node.attrs.find(([k]) => k === key)?.[1];
  const raw = find("rows_produced_per_join") ?? find("rows_examined_per_scan") ?? find("Plan Rows");
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : null;
}

interface ExplainGraphViewProps {
  root: PlanNode;
  maxCost: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** ノード検索に一致した ID (#1628)。 */
  matchIds?: ReadonlySet<string>;
}

function ExplainGraphInner({ root, maxCost, selectedId, onSelect, matchIds }: ExplainGraphViewProps) {
  const reduceMotion = useReducedMotion();
  const { fitView } = useReactFlow();
  const isDark = useIsDarkTheme();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<PlanFlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  // レイアウトは root が変わったときだけ計算する (選択変更では作り直さない)。
  const positioned = useMemo(() => layoutPlanGraph(buildPlanGraph(root)), [root]);
  // 実行木の深さ (ルート=0)。dagre は TB で同じ深さのノードを同じ y 中心に置くので、それを段数に
  // 読み替える。入場スタッガーの遅延 (#1861)。レイアウトの純ロジックは触らない。
  const ranks = useMemo(() => {
    const idx = rankIndices(positioned.nodes.map((n) => n.y + n.height / 2));
    return new Map(positioned.nodes.map((n, i) => [n.id, idx[i] ?? 0] as const));
  }, [positioned]);
  const { morphing, begin: beginMorph } = useFlowMorphing();
  const didLayoutOnce = useRef(false);
  const prevPositions = useRef(new Map<string, { x: number; y: number }>());

  useEffect(() => {
    setNodes(
      positioned.nodes.map((n) => ({
        id: n.id,
        type: "planNode" as const,
        position: { x: n.x, y: n.y },
        width: n.width,
        height: n.height,
        className: FLOW_NODE_ENTER_CLASS,
        style: staggerStyle(ranks.get(n.id) ?? 0),
        data: {
          label: n.node.label,
          cost: n.node.cost,
          heat: heatT(n.node.cost, maxCost),
          rows: n.node.actual ? n.node.actual.estRows : rowsOf(n.node),
          actualRows: n.node.actual ? n.node.actual.rows : null,
          actualMs: actualTotalMs(n.node),
          worstHint: worstSeverity(computeHints(n.node)),
          selected: selectedId === n.id,
          match: matchIds?.has(n.id) ?? false,
          onSelect: () => onSelect(n.id),
        },
      })),
    );
    setEdges(
      positioned.edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        className: FLOW_EDGE_ENTER_CLASS,
        data: { stagger: ranks.get(e.target) ?? 0 },
      })),
    );
  }, [positioned, ranks, maxCost, selectedId, onSelect, matchIds, setNodes, setEdges]);

  useEffect(() => {
    // 初回は `fitView` prop が枠取り済み。以降の再配置は、ノードの入場 / 位置モーフが終わってから
    // ビューポートを合わせる (先に動かすと、入場前のノードを追いかけて画面がぶれる, #1861)。
    const relayout = didLayoutOnce.current;
    didLayoutOnce.current = true;
    const animate = relayout && !reduceMotion && !prefersStaticMotion();
    // 既存ノードが実際に動くときだけモーフ、新しい ID のノードがあるときだけ入場完了まで fit を待つ。
    const prev = prevPositions.current;
    let willMove = false;
    let hasNew = false;
    for (const n of positioned.nodes) {
      const p = prev.get(n.id);
      if (!p) hasNew = true;
      else if (Math.abs(p.x - n.x) > 0.5 || Math.abs(p.y - n.y) > 0.5) willMove = true;
    }
    prevPositions.current = new Map(positioned.nodes.map((n) => [n.id, { x: n.x, y: n.y }] as const));
    if (animate && willMove) beginMorph();
    const wait = !animate
      ? 0
      : hasNew
        ? flowEntranceMs(Math.max(0, ...ranks.values()))
        : willMove
          ? FLOW_MORPH_MS
          : 0;
    const id = window.setTimeout(() => fitView({ duration: reduceMotion ? 0 : 300 }), wait);
    return () => window.clearTimeout(id);
  }, [positioned, ranks, fitView, reduceMotion, beginMorph]);

  // ミニマップのノードはカードと同じコストヒート色で塗る (コスト無しは中立色。関数は string を返す必要がある)。
  const miniMapNodeColor = useCallback(
    (n: PlanFlowNode) =>
      n.data.heat === null
        ? "var(--border-strong)"
        : sampleRamp(n.data.heat, rampStops(SEQUENTIAL_RAMPS.blue, isDark)),
    [isDark],
  );

  // 全景エクスポート (#1628): 現在のズーム/パンに依存せず、ノード外接矩形を等倍で収める。
  const buildExportCapture = useCallback(() => {
    const viewport = wrapRef.current?.querySelector(".react-flow__viewport") as HTMLElement | null;
    if (!viewport || nodes.length === 0) {
      throw new Error("plan graph is not rendered");
    }
    const { width, height, tx, ty, scale } = erExportGeometry(getNodesBounds(nodes));
    const style: Partial<CSSStyleDeclaration> = {
      width: `${width}px`,
      height: `${height}px`,
      transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
    };
    return { viewport, width, height, style };
  }, [nodes]);

  return (
    <Box ref={wrapRef} w="100%" h="100%">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        className={morphing ? "flow-morphing" : undefined}
        defaultEdgeOptions={defaultEdgeOptions}
        nodesConnectable={false}
        nodesFocusable={false}
        edgesFocusable={false}
        fitView
        minZoom={0.1}
        colorMode={isDark ? "dark" : "light"}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
        <Controls showInteractive={false} />
        <MiniMap<PlanFlowNode> pannable zoomable nodeColor={miniMapNodeColor} />
        <Panel position="top-right">
          <ImageExportButton
            filenameBase="explain_plan"
            makePng={(opts) => {
              const c = buildExportCapture();
              return elementToPngBlob(c.viewport, {
                width: c.width,
                height: c.height,
                style: c.style,
                ...opts,
              });
            }}
            makeSvg={() => {
              const c = buildExportCapture();
              return elementToSvgBytes(c.viewport, { width: c.width, height: c.height, style: c.style });
            }}
          />
        </Panel>
      </ReactFlow>
    </Box>
  );
}

export function ExplainGraphView(props: ExplainGraphViewProps) {
  return (
    <ReactFlowProvider>
      <ExplainGraphInner {...props} />
    </ReactFlowProvider>
  );
}
