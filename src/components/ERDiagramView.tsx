import { useCallback, useEffect, useState } from "react";
import { Box, chakra, type SystemStyleObject } from "@chakra-ui/react";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { api, type DriverKind } from "../api/tauri";
import { useT } from "../i18n";
import {
  buildErGraph,
  layoutErGraph,
  ER_NODE_WIDTH,
  type ErTableData,
} from "./erDiagram";
import { Icon } from "./Icon";
import { Button, Select } from "./ui";
import { Spinner } from "./Spinner";

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
  [key: string]: unknown;
}
type ErFlowNode = Node<ErNodeData, "erTable">;

// Concurrency-bounded map so PK lookups don't open dozens of simultaneous
// queries on large schemas. Order of results matches `items`.
async function mapLimited<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

const cardCss: SystemStyleObject = {
  width: `${ER_NODE_WIDTH}px`,
  background: "var(--bg-elevated)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-md)",
  boxShadow: "var(--shadow-sm, 0 1px 2px rgba(0,0,0,0.12))",
  overflow: "hidden",
  fontSize: "var(--text-sm)",
};
const cardHeaderCss: SystemStyleObject = {
  display: "flex",
  alignItems: "center",
  gap: "1.5",
  width: "100%",
  padding: "7px 10px",
  background: "var(--bg-muted)",
  borderBottom: "1px solid var(--border)",
  fontFamily: "var(--font-mono)",
  fontWeight: 600,
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
  padding: "0 10px",
  fontFamily: "var(--font-mono)",
  color: "var(--text-secondary)",
  borderTop: "1px solid var(--border-subtle, transparent)",
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
function ErTableNode({ data }: NodeProps<ErFlowNode>) {
  return (
    <Box css={cardCss}>
      {/* Handles are invisible anchors edges attach to (LR layout). */}
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
      <chakra.button
        type="button"
        css={cardHeaderCss}
        onClick={data.onOpen}
        className="nodrag"
        title={data.openTitle}
        aria-label={data.openTitle}
      >
        <Icon name="table" size={13} />
        <chakra.span css={colNameCss} flex="1">
          {data.table}
        </chakra.span>
      </chakra.button>
      {data.columns.map((col) => (
        <Box key={col.name} css={colRowCss}>
          {col.isPk ? (
            <chakra.span color="var(--status-warning, #f59e0b)" title={data.pkTitle} display="inline-flex">
              <Icon name="key" size={12} />
            </chakra.span>
          ) : col.isFk ? (
            <chakra.span color="var(--accent)" title={data.fkTitle} display="inline-flex">
              <Icon name="link" size={12} />
            </chakra.span>
          ) : (
            <chakra.span width="12px" flexShrink={0} />
          )}
          <chakra.span css={colNameCss} flex="1" color={col.isPk ? "var(--text)" : undefined}>
            {col.name}
          </chakra.span>
        </Box>
      ))}
      {data.hiddenColumns > 0 && (
        <Box css={moreRowCss}>+{data.hiddenColumns}</Box>
      )}
    </Box>
  );
}

// Stable reference so React Flow doesn't warn about a new nodeTypes each render.
const nodeTypes = { erTable: ErTableNode };
const defaultEdgeOptions = {
  type: "smoothstep",
  markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
} as const;

interface ERDiagramViewProps {
  sessionId: string;
  driver: DriverKind;
  initialDatabase: string | null;
  onOpenTable: (database: string, table: string) => void;
  onClose: () => void;
}

function ERDiagramInner({
  sessionId,
  driver,
  initialDatabase,
  onOpenTable,
  onClose,
}: ERDiagramViewProps) {
  const t = useT();
  const [databases, setDatabases] = useState<string[]>(
    initialDatabase ? [initialDatabase] : [],
  );
  const [database, setDatabase] = useState<string | null>(initialDatabase);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<{ shown: number; total: number; rels: number } | null>(
    null,
  );
  const [nodes, setNodes, onNodesChange] = useNodesState<ErFlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  // SQLite has the single "main" namespace; offering a picker would be noise.
  const showDbPicker = driver !== "sqlite" && databases.length > 1;

  // Load the database list so the picker can offer alternatives and so a
  // database is chosen even when none was passed in (e.g. SQLite's "main").
  // Never overrides an already-chosen database.
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
  }, [sessionId, initialDatabase]);

  const handleOpen = useCallback(
    (db: string, table: string) => {
      onOpenTable(db, table);
      onClose();
    },
    [onOpenTable, onClose],
  );

  useEffect(() => {
    if (!database) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      const [tables, foreignKeys] = await Promise.all([
        api.schemaOverview(sessionId, database),
        api.foreignKeys(sessionId, database),
      ]);
      if (cancelled) return;

      // Build once (no PK) just to learn which tables survive the cap, then
      // fetch PK metadata only for those — bounded work on large schemas.
      const capped = buildErGraph({
        tables: tables.map((tb) => ({ name: tb.name, columns: tb.columns })),
        foreignKeys,
      });
      const shownTables = capped.nodes.map((n) => n.data.table);
      const pkPairs = await mapLimited(shownTables, 8, async (name) => {
        try {
          const cols = await api.describeTable(sessionId, database, name);
          return [name, cols.filter((c) => c.key === "PRI").map((c) => c.name)] as const;
        } catch {
          return [name, [] as string[]] as const;
        }
      });
      if (cancelled) return;
      const pkByTable = Object.fromEntries(pkPairs);

      const graph = buildErGraph({
        tables: tables.map((tb) => ({ name: tb.name, columns: tb.columns })),
        foreignKeys,
        pkByTable,
      });
      const positioned = layoutErGraph(graph);

      setNodes(
        positioned.nodes.map((n) => ({
          id: n.id,
          type: "erTable" as const,
          position: { x: n.x, y: n.y },
          width: n.width,
          data: {
            ...n.data,
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
        })),
      );
      setSummary({
        shown: graph.nodes.length,
        total: graph.totalTables,
        rels: graph.edges.length,
      });
    })()
      .catch((e) => {
        if (!cancelled) {
          setError(String(e));
          setNodes([]);
          setEdges([]);
          setSummary(null);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, database, handleOpen, setNodes, setEdges, t]);

  const truncated = summary != null && summary.shown < summary.total;

  return (
    <Box flex="1" display="flex" flexDirection="column" minHeight={0}>
      <chakra.header
        display="flex"
        alignItems="center"
        gap="3"
        flexWrap="wrap"
        py="3.5" px="6"
        borderBottom="1px solid"
        borderColor="app.border"
      >
        <chakra.h2 margin={0} fontSize="lg" fontWeight={600} color="app.text">
          {t("erDiagramTitle")}
        </chakra.h2>
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
        {summary && !loading && !error && (
          <chakra.span fontSize="sm" color="app.textMuted">
            {t("erDiagramSummary", { tables: summary.shown, relationships: summary.rels })}
          </chakra.span>
        )}
        <Button
          marginLeft="auto"
          minWidth="28px"
          px="2"
          py="1"
          lineHeight={1}
          onClick={onClose}
          aria-label={t("erDiagramClose")}
          title={t("erDiagramClose")}
        >
          <Icon name="close" size={13} />
        </Button>
      </chakra.header>

      <chakra.p margin={0} padding="8px 24px 0" fontSize="sm" color="app.textMuted">
        {t("erDiagramDesc")}
      </chakra.p>
      {truncated && (
        <chakra.p margin={0} padding="6px 24px 0" fontSize="sm" color="var(--status-warning, #f59e0b)">
          {t("erDiagramTruncated", { shown: summary!.shown, total: summary!.total })}
        </chakra.p>
      )}

      <Box flex="1" position="relative" minHeight={0} margin="12px 0 0">
        {loading ? (
          <Box position="absolute" inset={0} display="flex" alignItems="center" justifyContent="center" gap="3" color="app.textMuted">
            <Spinner size={18} />
            {t("erDiagramLoading")}
          </Box>
        ) : error ? (
          <Box py="4" px="6" color="var(--status-error)" fontSize="sm">
            {t("erDiagramError", { error })}
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
        )}
      </Box>
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
