import { useEffect, useMemo } from "react";
import { Box, chakra, type SystemStyleObject } from "@chakra-ui/react";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { useReducedMotion } from "motion/react";

import { INK_DARK, INK_LIGHT, SEQUENTIAL_RAMPS, sampleRamp } from "../colorScale";
import {
  buildPlanGraph,
  computeHints,
  formatNumber,
  heatT,
  layoutPlanGraph,
  worstSeverity,
  type PlanNode,
} from "./explainPlan";

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
  worstHint: "info" | "caution" | "warning" | null;
  selected: boolean;
  onSelect: () => void;
  [key: string]: unknown;
}
type PlanFlowNode = Node<PlanNodeData, "planNode">;

const SEQ_STOPS = SEQUENTIAL_RAMPS.blue.stops;

const cardBaseCss: SystemStyleObject = {
  width: "100%",
  height: "100%",
  display: "flex",
  flexDirection: "column",
  gap: "3px",
  justifyContent: "center",
  padding: "8px 10px",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-md)",
  boxShadow: "var(--shadow-sm)",
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
  gap: "6px",
  fontSize: "var(--text-2xs)",
  fontVariantNumeric: "tabular-nums",
};

/** One plan-tree node. Background is the cost heat; text ink adapts to it. */
function PlanFlowNodeView({ data }: NodeProps<PlanFlowNode>) {
  // コスト → 背景色。ヒートが null (コスト無し) のときは中立の薄色を使う。
  const fill = data.heat === null ? null : sampleRamp(data.heat, SEQ_STOPS);
  const ink = data.heat !== null && data.heat >= 0.5 ? INK_LIGHT : INK_DARK;
  const css: SystemStyleObject = {
    ...cardBaseCss,
    background: fill ?? "var(--bg-elevated)",
    color: fill ? ink : "var(--text)",
    borderColor: data.selected ? "var(--accent)" : "var(--border)",
    outline: data.selected ? "2px solid var(--accent)" : "none",
  };
  return (
    <Box css={css} onClick={data.onSelect} title={data.label}>
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
      <chakra.span css={labelCss}>{data.label}</chakra.span>
      <chakra.span css={metaCss} opacity={0.92}>
        {data.cost !== null && <span>cost {formatNumber(data.cost)}</span>}
        {data.rows !== null && <span>{formatNumber(data.rows)} rows</span>}
        {data.worstHint && data.worstHint !== "info" && (
          <chakra.span
            fontWeight={700}
            px="4px"
            borderRadius="var(--radius-sm)"
            background={data.worstHint === "warning" ? "var(--status-error)" : "var(--status-warning)"}
            color="#fff"
          >
            !
          </chakra.span>
        )}
      </chakra.span>
    </Box>
  );
}

const nodeTypes = { planNode: PlanFlowNodeView };
const defaultEdgeOptions = { type: "smoothstep" } as const;

function rowsOf(node: PlanNode): number | null {
  const find = (key: string): unknown => node.attrs.find(([k]) => k === key)?.[1];
  const raw =
    find("rows_produced_per_join") ??
    find("rows_examined_per_scan") ??
    find("Plan Rows");
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : null;
}

interface ExplainGraphViewProps {
  root: PlanNode;
  maxCost: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
}

function ExplainGraphInner({ root, maxCost, selectedId, onSelect }: ExplainGraphViewProps) {
  const reduceMotion = useReducedMotion();
  const { fitView } = useReactFlow();
  const [nodes, setNodes, onNodesChange] = useNodesState<PlanFlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  // レイアウトは root が変わったときだけ計算する (選択変更では作り直さない)。
  const positioned = useMemo(() => layoutPlanGraph(buildPlanGraph(root)), [root]);

  useEffect(() => {
    setNodes(
      positioned.nodes.map((n) => ({
        id: n.id,
        type: "planNode" as const,
        position: { x: n.x, y: n.y },
        width: n.width,
        height: n.height,
        data: {
          label: n.node.label,
          cost: n.node.cost,
          heat: heatT(n.node.cost, maxCost),
          rows: rowsOf(n.node),
          worstHint: worstSeverity(computeHints(n.node)),
          selected: selectedId === n.id,
          onSelect: () => onSelect(n.id),
        },
      })),
    );
    setEdges(
      positioned.edges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
    );
  }, [positioned, maxCost, selectedId, onSelect, setNodes, setEdges]);

  useEffect(() => {
    const id = window.setTimeout(() => fitView({ duration: reduceMotion ? 0 : 300 }), 0);
    return () => window.clearTimeout(id);
  }, [positioned, fitView, reduceMotion]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      nodeTypes={nodeTypes}
      defaultEdgeOptions={defaultEdgeOptions}
      nodesConnectable={false}
      edgesFocusable={false}
      fitView
      minZoom={0.1}
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
      <Controls showInteractive={false} />
      <MiniMap pannable zoomable />
    </ReactFlow>
  );
}

export function ExplainGraphView(props: ExplainGraphViewProps) {
  return (
    <ReactFlowProvider>
      <ExplainGraphInner {...props} />
    </ReactFlowProvider>
  );
}
