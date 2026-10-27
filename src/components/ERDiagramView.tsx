import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { Box, chakra, type SystemStyleObject } from "@chakra-ui/react";
import {
  Background,
  BackgroundVariant,
  Controls,
  BaseEdge,
  Handle,
  MiniMap,
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

import { api, type DriverKind } from "../api/tauri";
import { useT } from "../i18n";
import { useIsDarkTheme } from "../colorScale";
import { driverColor } from "../profileIdentity";
import { semanticColorToken } from "../semanticColors";
import {
  buildErGraph,
  endGlyph,
  type BuildErGraphInput,
  type ErFocus,
  erHighlight,
  layoutErGraph,
  sourceEndKind,
  targetEndKind,
  type ErCardinality,
  type ErEndSide,
  type ErGraph,
  type ErLayoutDensity,
  type ErLayoutDirection,
  type ErTableData,
} from "./erDiagram";
import { EmptyState } from "./EmptyState";
import { Icon, ICON_SIZES } from "./Icon";
import { cellKindIcon } from "./cellTypeMeta";
import { errorIllustration } from "./illustrations";
import { Tooltip, TooltipBubble, useDelegatedTooltip } from "./Tooltip";
import { Button, Heading, Select } from "./ui";
import { ErGraphSkeleton } from "./Skeleton";
import { ContextMenu, type ContextMenuEntry } from "./ContextMenu";
import { copyToClipboard } from "./clipboard";
import { clearErLayout, readErLayout, writeErLayout } from "./erPositions";
import { qualifiedTableSql } from "./sqlDialect";
import { TABLE_DDL_KIND } from "./tableDdl";
import {
  FLOW_EDGE_ENTER_CLASS,
  FLOW_MORPH_MS,
  FLOW_NODE_ENTER_CLASS,
  rankIndices,
  staggerStyle,
  useFlowMorphing,
} from "./flowMotion";
import { ImageExportButton } from "./ImageExportButton";
import { useToast } from "./Toast";
import { elementToPngBlob, elementToSvgBytes, erExportGeometry } from "./imageExport";

/**
 * ER diagram: renders the connected database's tables and their
 * foreign-key relationships as a draggable, zoomable graph. Data comes from two
 * bulk calls — `schema_overview` (tables + columns) and `foreign_keys` (edges)
 * — plus best-effort per-table `describe_table` to mark primary keys. The graph
 * layout/building is pure (`erDiagram.ts`); this file is the React Flow shell.
 *
 * Modelled as a full-screen overlay like SchemaCompareView rather than a query
 * tab, since it is schema-wide and carries no query result. Clicking a table's
 * header opens it as a real table tab via `onOpenTable` (and closes the view).
 */

/**
 * Node data = the pure table data plus the view's click handler/labels. The
 * index signature satisfies React Flow's `Record<string, unknown>` constraint
 * on node data while keeping the named fields strongly typed.
 */
interface ErNodeData extends ErTableData {
  onOpen: () => void;
  openTitle: string;
  pkTitle: string;
  fkTitle: string;
  /** Rank direction, so handles anchor on the correct edges (#560). */
  direction: ErLayoutDirection;
  /** ヘッダの帯に使うドライバ色 (CSS 変数 `--er-accent` として流す)。 */
  accent: string;
  [key: string]: unknown;
}
type ErFlowNode = Node<ErNodeData, "erTable">;

const cardCss: SystemStyleObject = {
  // Width comes from the React Flow node (variable per table; see nodeWidth in
  // erDiagram.ts) so long names aren't clipped (#560).
  width: "100%",
  background: "var(--bg-elevated)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-md)",
  boxShadow: "var(--elevation-raised)",
  overflow: "hidden",
  fontSize: "var(--text-sm)",
  // 連動ハイライト中 (`.er-hl`) は枠を accent にして関連テーブルを際立たせる (App.css 側の
  // `.react-flow__node.er-hl .er-card`)。
};
const cardHeaderCss: SystemStyleObject = {
  display: "flex",
  alignItems: "center",
  gap: "1.5",
  width: "100%",
  padding: "var(--space-1-75) var(--space-2-5)",
  background: "var(--bg-muted)",
  // ドライバ色の控えめな帯 (上辺)。ヘッダ自体の面はテーマの --bg-muted のまま。
  borderTop: "2px solid var(--er-accent, var(--border))",
  borderBottom: "1px solid var(--border)",
  fontFamily: "var(--font-mono)",
  textStyle: "subheading",
  color: "var(--text)",
  cursor: "pointer",
  textAlign: "left",
  _hover: { background: "var(--bg-hover, var(--bg-muted))", color: "var(--accent)" },
};
const colRowCss: SystemStyleObject = {
  display: "flex",
  alignItems: "center",
  gap: "1.5",
  height: "24px",
  padding: "0 var(--space-2-5)",
  fontFamily: "var(--font-mono)",
  color: "var(--text-secondary)",
  borderTop: "1px solid var(--border-subtle, transparent)",
};
// PK 行は薄い琥珀の地 + 太めの列名で、FK/通常列より一段優位に見せる。
const pkRowCss: SystemStyleObject = {
  background: "color-mix(in srgb, var(--key-accent) 10%, transparent)",
};
// 列行右端の型ラベル (アイコン + 短縮型名)。名前が長いときは名前側が先に省略される。
const colTypeCss: SystemStyleObject = {
  display: "inline-flex",
  alignItems: "center",
  gap: "var(--space-1)",
  flexShrink: 0,
  marginLeft: "auto",
  fontSize: "var(--text-xs)",
  color: "var(--text-muted)",
};
const colNameCss: SystemStyleObject = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const moreRowCss: SystemStyleObject = {
  ...colRowCss,
  color: "var(--text-muted)",
  fontStyle: "italic",
};

/** One table card. React Flow drags it; the header opens the table tab. */
const ErTableNode = memo(function ErTableNode({ data }: NodeProps<ErFlowNode>) {
  // Anchor handles on the edges the rank flows along so connectors stay tidy
  // when the layout direction changes (#560): LR → left/right, TB → top/bottom.
  const targetPos = data.direction === "TB" ? Position.Top : Position.Left;
  const sourcePos = data.direction === "TB" ? Position.Bottom : Position.Right;
  // PK/FK アイコンは 1 ノードあたり最大 `MAX_VISIBLE_COLUMNS` 行 × 最大
  // `MAX_TABLES` ノード描画されうるため、行ごとに `Tooltip` を積まず「1 つの
  // 共有ツールチップ + イベント委譲」(`useDelegatedTooltip`、#884) を使う。
  // これらのアイコンは元々フォーカス対象ではない (行はキーボード操作対象外) ので、
  // hover のみ対応でも native title からの後退はない。
  const { hovered, bind } = useDelegatedTooltip();
  return (
    <Box css={cardCss} className="er-card" style={{ ["--er-driver" as string]: data.accent }}>
      {/* Handles are invisible anchors edges attach to. */}
      <Handle type="target" position={targetPos} style={{ opacity: 0 }} />
      <Handle type="source" position={sourcePos} style={{ opacity: 0 }} />
      <Tooltip label={data.openTitle}>
        <chakra.button
          type="button"
          css={cardHeaderCss}
          onClick={data.onOpen}
          className="nodrag"
          aria-label={data.openTitle}
        >
          <chakra.span color="var(--text-secondary)" display="inline-flex">
            <Icon name="table" size={ICON_SIZES.sm} />
          </chakra.span>
          <chakra.span css={colNameCss} flex="1">
            {data.table}
          </chakra.span>
        </chakra.button>
      </Tooltip>
      {data.columns.map((col) => (
        <Box key={col.name} css={col.isPk ? { ...colRowCss, ...pkRowCss } : colRowCss}>
          {/* PK の鍵アイコンは接続ツリー (ConnectionList) と同じ --key-accent の
              琥珀で統一する (FK は両者とも accent)。--key-accent は PK 表示専用の
              意味トークンで、--cell-date (日付型セル色) とは独立している (#717)。 */}
          {col.isPk ? (
            <chakra.span color="var(--key-accent)" display="inline-flex" {...bind(data.pkTitle)}>
              <Icon name="key" size={ICON_SIZES.sm} />
            </chakra.span>
          ) : col.isFk ? (
            <chakra.span color="var(--accent)" display="inline-flex" {...bind(data.fkTitle)}>
              <Icon name="link" size={ICON_SIZES.sm} />
            </chakra.span>
          ) : (
            <chakra.span width="12px" flexShrink={0} />
          )}
          <chakra.span
            css={colNameCss}
            flex="1"
            color={col.isPk ? "var(--text)" : undefined}
            fontWeight={col.isPk ? "semibold" : undefined}
          >
            {col.name}
          </chakra.span>
          {col.kind !== null && col.typeName !== "" && (
            <chakra.span css={colTypeCss}>
              <Icon name={cellKindIcon(col.kind)} size={ICON_SIZES.sm} />
              {col.typeName}
            </chakra.span>
          )}
        </Box>
      ))}
      {data.hiddenColumns > 0 && <Box css={moreRowCss}>+{data.hiddenColumns}</Box>}
      {hovered && <TooltipBubble label={hovered.label} anchor={hovered.rect} />}
    </Box>
  );
});

interface ErRelationData {
  cardinality: ErCardinality;
  optional: boolean;
  /** 入場スタッガーの段数 (参照先ノードの深さ, #1861)。 */
  stagger?: number;
  [key: string]: unknown;
}

/**
 * リレーション線: smoothstep の線の両端にクロウフット記法の記号を描く。記号は端点の
 * 座標から直接組み立てた `<path>` / `<circle>` で、`<defs>` のマーカーを使わないので
 * 複数の図が同時にあっても id が衝突しない (幾何は `endGlyph`、純関数)。
 */
const ErRelationEdge = memo(function ErRelationEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps<Edge<ErRelationData, "erRelation">>) {
  const stagger = staggerStyle(data?.stagger ?? 0);
  const [path] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });
  const src = endGlyph(
    sourceEndKind(data?.cardinality ?? "many-to-one"),
    sourcePosition as ErEndSide,
    sourceX,
    sourceY,
  );
  const dst = endGlyph(targetEndKind(data?.optional ?? false), targetPosition as ErEndSide, targetX, targetY);
  return (
    <>
      <BaseEdge id={id} path={path} pathLength={1} style={stagger} />
      {[src, dst].map((g, i) => (
        <g key={i === 0 ? "source" : "target"} className="er-rel-glyph" style={stagger}>
          {g.paths.map((d) => (
            <path key={d} d={d} />
          ))}
          {g.circle && <circle cx={g.circle.cx} cy={g.circle.cy} r={g.circle.r} />}
        </g>
      ))}
    </>
  );
});

/**
 * ハイライト用クラス (`er-hl` / `er-dim`) に入場クラスを足す。入場クラスを外すと再生中の
 * アニメが途切れるので、ハイライトの付け外しでも常に残す (#1861)。
 */
function withEnter(enter: string, highlight: string | undefined): string {
  return highlight ? `${enter} ${highlight}` : enter;
}

// Stable reference so React Flow doesn't warn about a new nodeTypes each render.
const nodeTypes = { erTable: ErTableNode };
const edgeTypes = { erRelation: ErRelationEdge };
const defaultEdgeOptions = { type: "erRelation" } as const;

interface ERDiagramViewProps {
  sessionId: string;
  driver: DriverKind;
  initialDatabase: string | null;
  onOpenTable: (database: string, table: string) => void;
  /**
   * AI でスキーマドキュメントを生成する (#696)。渡されたときだけツールバーにボタンを出す
   * (AI 利用可のときだけ親が渡す)。選択中のノードのテーブル名を一緒に渡す。
   */
  onGenerateDoc?: (database: string, selectedTables: string[]) => void;
  /**
   * ノード位置の保存先を分ける接続の識別子 (プロファイル ID, #1628)。無いときは位置を保存しない。
   */
  connectionKey?: string | null;
  /**
   * テーブルノードの右クリックメニュー『SELECT 文をエディタへ』(#1628)。SQL をエディタ (無ければ新しい
   * クエリタブ) へ差し込む。渡されたときだけ項目を出す。実行はしない。
   */
  onInsertSql?: (sql: string) => void;
  onClose: () => void;
}

function ERDiagramInner({
  sessionId,
  driver,
  initialDatabase,
  onOpenTable,
  onGenerateDoc,
  connectionKey,
  onInsertSql,
  onClose,
}: ERDiagramViewProps) {
  const t = useT();
  const toast = useToast();
  const reduceMotion = useReducedMotion();
  const { fitView } = useReactFlow();
  const isDark = useIsDarkTheme();
  const [databases, setDatabases] = useState<string[]>(initialDatabase ? [initialDatabase] : []);
  const [database, setDatabase] = useState<string | null>(initialDatabase);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The built (un-positioned) graph is fetched once per database; the layout
  // (positions) is recomputed whenever direction/density change without a
  // refetch (#560).
  // 取得した生データ。フォーカス (#1540) はこれから `buildErGraph` を組み直すだけで、
  // DB への再アクセスは要らない。
  const [source, setSource] = useState<Omit<BuildErGraphInput, "focus"> | null>(null);
  const [focusTable, setFocusTable] = useState<string | null>(null);
  const [focusHops, setFocusHops] = useState(1);
  const focus: ErFocus | null = useMemo(
    () => (focusTable ? { table: focusTable, hops: focusHops } : null),
    [focusTable, focusHops],
  );
  const graph: ErGraph | null = useMemo(
    () => (source ? buildErGraph({ ...source, focus }) : null),
    [source, focus],
  );
  const summary = useMemo(
    () => (graph ? { shown: graph.nodes.length, total: graph.totalTables, rels: graph.edges.length } : null),
    [graph],
  );
  // フォーカスの対象に選べるテーブル (上限で図から落ちているものも含む)。
  const focusChoices = useMemo(
    () => (source ? source.tables.map((tb) => tb.name).sort((a, b) => a.localeCompare(b)) : []),
    [source],
  );
  const [direction, setDirection] = useState<ErLayoutDirection>("LR");
  const [density, setDensity] = useState<ErLayoutDensity>("comfortable");
  const [nodes, setNodes, onNodesChange] = useNodesState<ErFlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  // 連動ハイライト用: ホバー中のテーブル ID は 1 つだけ。関連判定は純関数 `erHighlight`。
  const [hoverId, setHoverId] = useState<string | null>(null);
  // 右クリックメニューの『参照元・参照先を強調』で固定した強調対象 (#1628)。ホバー中はホバーが優先。
  const [pinId, setPinId] = useState<string | null>(null);
  // 再取得ボタン用のカウンタ (#848)。データベース一覧・グラフ取得のどちらの
  // 失敗でも、これをインクリメントして両 effect を再実行させれば復旧できる。
  const [retryAttempt, setRetryAttempt] = useState(0);
  const [hasSavedLayout, setHasSavedLayout] = useState(false);
  const [layoutResetTick, setLayoutResetTick] = useState(0);
  const retry = useCallback(() => setRetryAttempt((n) => n + 1), []);
  // Skip the fit-view animation on the first layout (initial mount already
  // fits via the `fitView` prop); animate only subsequent relayouts.
  const didLayoutOnce = useRef(false);
  // 再レイアウト中はエッジを隠す (ノードが滑る間、線だけ最終位置にあるとずれるため, #1861)。
  const { morphing, begin: beginMorph } = useFlowMorphing();
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  // ReactFlow のラッパ参照 — 画像エクスポート (#643) でビューポート要素を取得する。
  const flowWrapRef = useRef<HTMLDivElement>(null);

  // 全景エクスポート用に、現在のズーム/パンに依存しないビューポート変換を組み立てる。
  // ノードの外接矩形を求め、scale(1) で内容全体が収まるよう平行移動 + 出力サイズを返す。
  const buildExportCapture = useCallback(() => {
    const viewport = flowWrapRef.current?.querySelector(".react-flow__viewport") as HTMLElement | null;
    if (!viewport || nodes.length === 0) {
      throw new Error("diagram is not rendered");
    }
    const bounds = getNodesBounds(nodes);
    const { width, height, tx, ty, scale } = erExportGeometry(bounds);
    const style: Partial<CSSStyleDeclaration> = {
      width: `${width}px`,
      height: `${height}px`,
      transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
    };
    return { viewport, width, height, style };
  }, [nodes]);

  // SQLite has the single "main" namespace; offering a picker would be noise.
  const showDbPicker = driver !== "sqlite" && databases.length > 1;

  // Load the database list so the picker can offer alternatives and so a
  // database is chosen even when none was passed in (e.g. SQLite's "main").
  // Never overrides an already-chosen database.
  // biome-ignore lint/correctness/useExhaustiveDependencies: retryAttempt の変化で再取得するトリガ依存 (effect 内では参照しない)
  useEffect(() => {
    let cancelled = false;
    api
      .listDatabases(sessionId)
      .then((dbs) => {
        if (cancelled) return;
        setDatabases(dbs);
        setDatabase((cur) => cur ?? dbs[0] ?? null);
      })
      .catch((e) => {
        if (cancelled) return;
        // With an initialDatabase the load effect still runs and surfaces real
        // errors. Without one, `database` would stay null and the load effect
        // (guarded by `if (!database) return`) would never run, silently
        // showing an empty diagram — so report the failure here instead.
        if (!initialDatabase) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
    // retryAttempt は再取得ボタン専用の依存 (#848): sessionId/initialDatabase を
    // 変えずに同じ一覧取得をやり直したいだけ。
  }, [sessionId, initialDatabase, retryAttempt]);

  // onOpenTable / onClose は親の再レンダーごとに新しい関数になりうる。依存に入れると
  // レイアウト effect が再実行されて手動配置・ズームが初期化されるため、ref 経由で
  // 最新の関数を呼び、handleOpen 自体は安定させる。
  const openHandlersRef = useRef({ onOpenTable, onClose });
  openHandlersRef.current = { onOpenTable, onClose };
  const handleOpen = useCallback((db: string, table: string) => {
    openHandlersRef.current.onOpenTable(db, table);
    openHandlersRef.current.onClose();
  }, []);

  // Fetch + build the graph for the chosen database. Layout (positions) is a
  // separate effect so direction/density changes re-layout without refetching.
  // biome-ignore lint/correctness/useExhaustiveDependencies: retryAttempt の変化で再取得するトリガ依存 (effect 内では参照しない)
  useEffect(() => {
    if (!database) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setFocusTable(null);
    didLayoutOnce.current = false;
    (async () => {
      // 列名と PK 列は DB 全体を 1 回で取得する (#1255)。以前は列名を
      // schemaOverview、PK を表示テーブルごとの describeTable (最大 80 回) で
      // 取っていた。
      const [described, foreignKeys] = await Promise.all([
        api.describeDatabase(sessionId, database),
        api.foreignKeys(sessionId, database),
      ]);
      if (cancelled) return;
      const tables = described.map((tb) => ({
        name: tb.name,
        columns: tb.columns.map((c) => c.name),
      }));
      const columnMeta = Object.fromEntries(
        described.map((tb) => [
          tb.name,
          Object.fromEntries(
            tb.columns.map((c) => [
              c.name,
              {
                dataType: c.data_type,
                nullable: c.nullable,
                unique: c.key.toUpperCase() === "UNI",
              },
            ]),
          ),
        ]),
      );
      const pkByTable = Object.fromEntries(
        described.map((tb) => [tb.name, tb.columns.filter((c) => c.key === "PRI").map((c) => c.name)]),
      );

      setSource({ tables, foreignKeys, pkByTable, columnMeta });
    })()
      .catch((e) => {
        if (!cancelled) {
          setError(String(e));
          setSource(null);
          setNodes([]);
          setEdges([]);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // retryAttempt は再取得ボタン専用の依存 (#848): database を変えずに同じ
    // グラフ取得をやり直したいだけ。
  }, [sessionId, database, setNodes, setEdges, retryAttempt]);

  // Position the graph and feed React Flow. Re-runs when the layout direction or
  // density changes (cheap, no DB round-trip) and animates the viewport to the
  // new layout — unless the user prefers reduced motion (#560).
  // biome-ignore lint/correctness/useExhaustiveDependencies: layoutResetTick は「配置をリセット」で再レイアウトさせるトリガ依存 (effect 内では参照しない)
  useEffect(() => {
    if (!graph || !database) return;
    const positioned = layoutErGraph(graph, { direction, density });
    // 保存済みの手動配置があれば自動レイアウトの位置に重ねる (#1628)。
    const saved = connectionKey ? readErLayout(connectionKey, database, direction, density) : null;
    setHasSavedLayout(saved !== null);
    // 再レイアウトでノードを作り直すのでホバー状態も捨てる (className が落ちるため)。
    // 直後のハイライト effect が hoverId=null を反映して整合を取る。
    setHoverId(null);
    // 入場スタッガーの深さ (#1861)。dagre は同じランクを、LR なら同じ x 中心・TB なら同じ y 中心に置く。
    const rankIdx = rankIndices(
      positioned.nodes.map((n) => (direction === "LR" ? n.x + n.width / 2 : n.y + n.height / 2)),
    );
    // 既存ノードが実際に別の位置へ動くときだけモーフ扱いにする (同じ配置での再実行ではエッジを隠さない)。
    const prevPos = new Map(nodesRef.current.map((n) => [n.id, n.position] as const));
    const willMove = positioned.nodes.some((n) => {
      const cur = saved?.[n.data.table] ?? { x: n.x, y: n.y };
      const prev = prevPos.get(n.id);
      return prev !== undefined && (Math.abs(prev.x - cur.x) > 0.5 || Math.abs(prev.y - cur.y) > 0.5);
    });
    const rankOf = new Map(positioned.nodes.map((n, i) => [n.id, rankIdx[i] ?? 0] as const));
    setNodes(
      positioned.nodes.map((n) => ({
        id: n.id,
        type: "erTable" as const,
        className: FLOW_NODE_ENTER_CLASS,
        style: staggerStyle(rankOf.get(n.id) ?? 0),
        position: saved?.[n.data.table] ?? { x: n.x, y: n.y },
        width: n.width,
        data: {
          ...n.data,
          direction,
          accent: driverColor(driver),
          onOpen: () => handleOpen(database, n.data.table),
          openTitle: t("erDiagramOpenTable", { table: n.data.table }),
          pkTitle: t("erDiagramPk"),
          fkTitle: t("erDiagramFk"),
        },
      })),
    );
    setEdges(
      positioned.edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        className: FLOW_EDGE_ENTER_CLASS,
        data: { cardinality: e.cardinality, optional: e.optional, stagger: rankOf.get(e.target) ?? 0 },
      })),
    );
    // Animate the fit only on relayout, not the initial render (the `fitView`
    // prop already frames the first layout). Defer so React Flow has the new
    // nodes before fitting.
    const animate = didLayoutOnce.current && !reduceMotion;
    didLayoutOnce.current = true;
    if (animate && willMove) beginMorph();
    // ビューポートはノードの位置モーフ (CSS の --dur-med) と同じ長さで同時に動かす。
    const id = window.setTimeout(() => {
      void fitView({ duration: animate ? FLOW_MORPH_MS : 0 });
    }, 0);
    return () => window.clearTimeout(id);
    // layoutResetTick: 「配置をリセット」で自動レイアウトを再計算させるトリガ依存。
  }, [
    graph,
    direction,
    density,
    database,
    driver,
    handleOpen,
    t,
    reduceMotion,
    fitView,
    beginMorph,
    setNodes,
    setEdges,
    connectionKey,
    layoutResetTick,
  ]);

  // ドラッグ終了時に全ノードの位置を保存する (#1628)。ドラッグ中のノードは引数の最新位置を使う。
  const onNodeDragStop = useCallback(
    (_: unknown, __: unknown, dragged: Node[]) => {
      if (!connectionKey || !database) return;
      const positions: Record<string, { x: number; y: number }> = {};
      for (const n of nodesRef.current) positions[n.data.table] = n.position;
      for (const n of dragged) {
        const table = (n.data as ErNodeData | undefined)?.table;
        if (table) positions[table] = n.position;
      }
      writeErLayout(connectionKey, database, direction, density, positions);
      setHasSavedLayout(true);
    },
    [connectionKey, database, direction, density],
  );
  const resetLayout = useCallback(() => {
    if (!connectionKey || !database) return;
    clearErLayout(connectionKey, database);
    setHasSavedLayout(false);
    setLayoutResetTick((n) => n + 1);
  }, [connectionKey, database]);

  // テーブルノードの右クリックメニュー (#1628)。
  const [nodeMenu, setNodeMenu] = useState<{ x: number; y: number; table: string } | null>(null);
  const onNodeContextMenu = useCallback((e: ReactMouseEvent, n: Node) => {
    e.preventDefault();
    const table = (n.data as ErNodeData | undefined)?.table;
    if (table) setNodeMenu({ x: e.clientX, y: e.clientY, table });
  }, []);

  const erNodeMenuItems = (table: string): ContextMenuEntry[] => {
    const items: ContextMenuEntry[] = [
      {
        label: t("erDiagramMenuOpenTable"),
        icon: "table",
        onSelect: () => database && handleOpen(database, table),
      },
    ];
    if (onInsertSql && database) {
      items.push({
        label: t("erDiagramMenuSelectSql"),
        icon: "query",
        onSelect: () => {
          onInsertSql(qualifiedTableSql(driver, database, table));
          openHandlersRef.current.onClose();
        },
      });
    }
    if (database) {
      items.push({
        label: t("erDiagramMenuCopyDdl"),
        onSelect: () => {
          api
            .getObjectDefinition(sessionId, database, TABLE_DDL_KIND, table, null)
            .then(async (ddl) => {
              if (await copyToClipboard(ddl)) toast.success(t("tableDdlCopied", { table }));
              else toast.error(t("clipboardCopyFailed"));
            })
            .catch((e) => toast.error(t("objDefinitionError", { error: String(e) })));
        },
      });
    }
    items.push(
      {
        label: pinId === table ? t("erDiagramMenuUnpin") : t("erDiagramMenuPin"),
        onSelect: () => setPinId((cur) => (cur === table ? null : table)),
      },
      {
        label: t("erDiagramMenuFocusTable"),
        disabled: focusTable === table,
        onSelect: () => setFocusTable(table),
      },
      {
        label: t("contextMenuCopyTableName"),
        onSelect: () => {
          void copyToClipboard(table).then((ok) => {
            if (!ok) toast.error(t("clipboardCopyFailed"));
          });
        },
      },
    );
    if (onGenerateDoc && database) {
      items.push({ separator: true });
      items.push({
        label: t("erDiagramMenuDocTable"),
        icon: "sparkles",
        onSelect: () => onGenerateDoc(database, [table]),
      });
    }
    return items;
  };

  const onNodeMouseEnter = useCallback((_: unknown, n: { id: string }) => setHoverId(n.id), []);
  const onNodeMouseLeave = useCallback(() => setHoverId(null), []);

  // ホバー連動ハイライト: 関連テーブル / 線に `er-hl`、それ以外に `er-dim` を付ける。
  // className が変わらないノード / 線は同じオブジェクトを返すので、React Flow は変化した
  // 要素だけを再描画する (大きなスキーマでも全ノード再レンダーにならない)。見た目は
  // App.css の `.er-hl` / `.er-dim` (減光の遷移は reduced-motion で自動的に止まる)。
  useEffect(() => {
    const hl = graph ? erHighlight(hoverId ?? pinId, graph.edges) : null;
    const cls = (related: boolean): string | undefined =>
      hl === null ? undefined : related ? "er-hl" : "er-dim";
    setNodes((ns) =>
      ns.map((n) => {
        const c = withEnter(FLOW_NODE_ENTER_CLASS, cls(hl?.nodeIds.has(n.id) ?? false));
        return n.className === c ? n : { ...n, className: c };
      }),
    );
    setEdges((es) =>
      es.map((e) => {
        const c = withEnter(FLOW_EDGE_ENTER_CLASS, cls(hl?.edgeIds.has(e.id) ?? false));
        return e.className === c ? e : { ...e, className: c };
      }),
    );
  }, [hoverId, pinId, graph, setNodes, setEdges]);

  const truncated = graph?.capped === true;
  const selectedTable = nodes.filter((n) => n.selected).map((n) => n.data.table);

  return (
    <Box flex="1" display="flex" flexDirection="column" minHeight={0}>
      <chakra.header
        display="flex"
        alignItems="center"
        gap="3"
        flexWrap="wrap"
        py="3.5"
        px="6"
        borderBottom="1px solid"
        borderColor="app.border"
      >
        <Heading>{t("erDiagramTitle")}</Heading>
        {showDbPicker && (
          <chakra.label display="inline-flex" alignItems="center" gap="2" fontSize="sm" color="app.textMuted">
            {t("erDiagramDatabase")}
            <Select
              value={database ?? ""}
              onChange={(e) => setDatabase(e.target.value || null)}
              minWidth="160px"
            >
              {databases.map((db) => (
                <option key={db} value={db}>
                  {db}
                </option>
              ))}
            </Select>
          </chakra.label>
        )}
        <chakra.label display="inline-flex" alignItems="center" gap="2" fontSize="sm" color="app.textMuted">
          {t("erDiagramLayout")}
          <Select
            value={direction}
            onChange={(e) => setDirection(e.target.value as ErLayoutDirection)}
            minWidth="130px"
            aria-label={t("erDiagramLayout")}
          >
            <option value="LR">{t("erDiagramLayoutLR")}</option>
            <option value="TB">{t("erDiagramLayoutTB")}</option>
          </Select>
        </chakra.label>
        <chakra.label display="inline-flex" alignItems="center" gap="2" fontSize="sm" color="app.textMuted">
          {t("erDiagramDensity")}
          <Select
            value={density}
            onChange={(e) => setDensity(e.target.value as ErLayoutDensity)}
            minWidth="130px"
            aria-label={t("erDiagramDensity")}
          >
            <option value="comfortable">{t("erDiagramDensityComfortable")}</option>
            <option value="compact">{t("erDiagramDensityCompact")}</option>
          </Select>
        </chakra.label>
        {focusChoices.length > 0 && !loading && !error && (
          <>
            <chakra.label
              display="inline-flex"
              alignItems="center"
              gap="2"
              fontSize="sm"
              color="app.textMuted"
            >
              {t("erDiagramFocus")}
              <Select
                value={focusTable ?? ""}
                onChange={(e) => setFocusTable(e.target.value || null)}
                minWidth="150px"
                aria-label={t("erDiagramFocus")}
              >
                <option value="">{t("erDiagramFocusOff")}</option>
                {focusChoices.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </Select>
            </chakra.label>
            {focusTable && (
              <chakra.label
                display="inline-flex"
                alignItems="center"
                gap="2"
                fontSize="sm"
                color="app.textMuted"
              >
                {t("erDiagramFocusHops")}
                <Select
                  value={String(focusHops)}
                  onChange={(e) => setFocusHops(Number(e.target.value))}
                  minWidth="90px"
                  aria-label={t("erDiagramFocusHops")}
                >
                  <option value="1">{t("erDiagramFocusHopsN", { n: 1 })}</option>
                  <option value="2">{t("erDiagramFocusHopsN", { n: 2 })}</option>
                </Select>
              </chakra.label>
            )}
            {selectedTable.length === 1 && selectedTable[0] !== focusTable && (
              <Tooltip label={t("erDiagramFocusSelectedTip")}>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => setFocusTable(selectedTable[0])}
                >
                  {t("erDiagramFocusSelected", { table: selectedTable[0] })}
                </Button>
              </Tooltip>
            )}
          </>
        )}
        {summary && !loading && !error && (
          <chakra.span fontSize="sm" color="app.textMuted">
            {t("erDiagramSummary", { tables: summary.shown, relationships: summary.rels })}
          </chakra.span>
        )}
        {!loading && !error && nodes.length > 0 && (
          <chakra.span marginLeft="auto" display="inline-flex" alignItems="center" gap="2">
            {onGenerateDoc && database && (
              <Tooltip label={t("erDiagramAiDocTooltip")}>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() =>
                    onGenerateDoc(
                      database,
                      nodes.filter((n) => n.selected).map((n) => n.data.table),
                    )
                  }
                >
                  <Icon name="sparkles" size={ICON_SIZES.md} />
                  <span style={{ marginInlineStart: "var(--space-1-5)" }}>{t("erDiagramAiDoc")}</span>
                </Button>
              </Tooltip>
            )}
            {hasSavedLayout && (
              <Tooltip label={t("erDiagramResetLayoutTip")}>
                <Button type="button" variant="secondary" size="sm" onClick={resetLayout}>
                  {t("erDiagramResetLayout")}
                </Button>
              </Tooltip>
            )}
            <ImageExportButton
              filenameBase={`er_${database ?? "diagram"}`}
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
                return elementToSvgBytes(c.viewport, {
                  width: c.width,
                  height: c.height,
                  style: c.style,
                });
              }}
            />
          </chakra.span>
        )}
        <Tooltip label={t("erDiagramClose")}>
          <Button
            marginLeft={!loading && !error && nodes.length > 0 ? undefined : "auto"}
            minWidth="28px"
            px="2"
            py="1"
            lineHeight={1}
            onClick={onClose}
            aria-label={t("erDiagramClose")}
          >
            <Icon name="close" size={ICON_SIZES.sm} />
          </Button>
        </Tooltip>
      </chakra.header>

      <chakra.p margin={0} pt="2" px="6" pb="0" fontSize="sm" color="app.textMuted">
        {t("erDiagramDesc")}
      </chakra.p>
      {truncated && (
        <chakra.p
          margin={0}
          pt="1.5"
          px="6"
          pb="0"
          fontSize="sm"
          color={semanticColorToken("warning", "text")}
        >
          {focus
            ? t("erDiagramFocusCapped", { shown: summary!.shown })
            : `${t("erDiagramTruncated", { shown: summary!.shown, total: summary!.total })} ${t("erDiagramTruncatedFocusHint")}`}
        </chakra.p>
      )}

      <Box ref={flowWrapRef} flex="1" position="relative" minHeight={0} mt="3" mx="0" mb="0">
        {loading ? (
          // 取得中はノードグラフ風のシマー骨格 (#1834)。文言は支援技術向けの
          // role="status" として残し、骨格は aria-hidden の視覚プレースホルダ。
          <Box position="absolute" inset={0} aria-busy="true">
            <ErGraphSkeleton />
            <Box
              position="absolute"
              top="50%"
              left="50%"
              transform="translate(-50%, -50%)"
              role="status"
              px="4"
              py="2"
              bg="app.surface"
              borderRadius="md"
              fontSize="sm"
              color="app.textMuted"
            >
              {t("erDiagramLoading")}
            </Box>
          </Box>
        ) : error ? (
          // 取得失敗 (データベース一覧 or グラフ本体): errorHints の分類結果から
          // 共有イラストを割り当て、再取得導線を添える (#848)。図の描画領域全体を
          // 占めるため、ローディング表示と同じ中央寄せの absolute レイアウトにする。
          <Box
            position="absolute"
            inset={0}
            display="flex"
            alignItems="center"
            justifyContent="center"
            overflowY="auto"
            py="4"
          >
            <EmptyState
              illustration={errorIllustration(error)}
              icon="warning"
              title={t("erDiagramError", { error })}
              action={{ label: t("erDiagramRetry"), onClick: retry }}
            />
          </Box>
        ) : nodes.length === 0 ? (
          <Box py="4" px="6" color="app.textMuted" fontSize="sm">
            {t("erDiagramEmpty")}
          </Box>
        ) : (
          <ReactFlow
            key={database ?? ""}
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            className={morphing ? "er-flow flow-morphing" : "er-flow"}
            onNodeDragStop={onNodeDragStop}
            onNodeContextMenu={onNodeContextMenu}
            onNodeMouseEnter={onNodeMouseEnter}
            onNodeMouseLeave={onNodeMouseLeave}
            defaultEdgeOptions={defaultEdgeOptions}
            nodesConnectable={false}
            edgesFocusable={false}
            fitView
            minZoom={0.1}
            colorMode={isDark ? "dark" : "light"}
            defaultMarkerColor="var(--border-strong)"
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable nodeColor={driverColor(driver)} />
          </ReactFlow>
        )}
      </Box>
      {nodeMenu && database && (
        <ContextMenu
          x={nodeMenu.x}
          y={nodeMenu.y}
          items={erNodeMenuItems(nodeMenu.table)}
          onClose={() => setNodeMenu(null)}
        />
      )}
    </Box>
  );
}

export function ERDiagramView(props: ERDiagramViewProps) {
  // ReactFlowProvider scopes the flow's internal store to this view instance.
  return (
    <ReactFlowProvider>
      <ERDiagramInner {...props} />
    </ReactFlowProvider>
  );
}
