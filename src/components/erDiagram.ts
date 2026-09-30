import dagre from "@dagrejs/dagre";

import type { ForeignKey } from "../api/tauri";

/**
 * Pure graph-building and layout for the ER diagram, kept separate
 * from `ERDiagramView.tsx` so the table→node / FK→edge mapping and the dagre
 * layout can be unit tested without React or React Flow. The view feeds the raw
 * schema (`schema_overview`) and foreign keys (`foreign_keys`) in and renders
 * the positioned nodes/edges this module returns.
 */

/** A single column row inside a table card. */
export interface ErColumn {
  name: string;
  /** True when the column is part of the table's primary key. */
  isPk: boolean;
  /** True when the column references another table (a foreign key). */
  isFk: boolean;
}

/** The data carried by one table node (React Flow `node.data`). */
export interface ErTableData {
  table: string;
  columns: ErColumn[];
  /** How many columns were dropped from `columns` by the per-card cap. */
  hiddenColumns: number;
}

export interface ErNode {
  id: string;
  data: ErTableData;
}

/** One drawn relationship: a FK column pointing at its referenced table. */
export interface ErEdge {
  id: string;
  source: string;
  target: string;
  sourceColumn: string;
  targetColumn: string | null;
}

export interface ErGraph {
  nodes: ErNode[];
  edges: ErEdge[];
  /** Number of tables in the schema before the `MAX_TABLES` cap. */
  totalTables: number;
}

export interface PositionedNode extends ErNode {
  /** Top-left corner (React Flow positions nodes by their top-left). */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PositionedGraph {
  nodes: PositionedNode[];
  edges: ErEdge[];
}

/**
 * Cap on how many tables are drawn at once. Beyond this, the most-connected
 * tables (by FK degree) are kept so the diagram stays readable on large
 * schemas; the view surfaces the truncation to the user.
 */
export const MAX_TABLES = 80;
/** Cap on column rows shown per card; the rest collapse into a "+N" footer. */
export const MAX_VISIBLE_COLUMNS = 14;

// Card geometry, shared with the view so dagre lays out using the real sizes.
// Node widths are variable (see `nodeWidth`) so a long table or column name no
// longer gets clipped by a fixed card width (#560).
/** Lower/upper bounds for the variable node width (#560). */
export const ER_NODE_MIN_WIDTH = 180;
export const ER_NODE_MAX_WIDTH = 380;
export const ER_HEADER_HEIGHT = 34;
export const ER_ROW_HEIGHT = 24;
export const ER_NODE_VPAD = 8;

/** Approx. advance width of one monospace glyph at the card font size (--text-sm). */
const ER_CHAR_WIDTH = 7.3;
/** Horizontal chrome inside a card: PK/FK icon, gap, L/R padding and ellipsis slack. */
const ER_NODE_HPAD = 48;

/** Rendered height of a card given its visible/hidden column counts. */
export function nodeHeight(visibleColumns: number, hiddenColumns: number): number {
  const rows = Math.max(1, visibleColumns) + (hiddenColumns > 0 ? 1 : 0);
  return ER_HEADER_HEIGHT + rows * ER_ROW_HEIGHT + ER_NODE_VPAD;
}

/**
 * Variable card width sized to the table name and its longest visible column so
 * long identifiers no longer get squeezed into a fixed 240px card (#560). The
 * width is clamped to `[ER_NODE_MIN_WIDTH, ER_NODE_MAX_WIDTH]`; names longer than
 * the cap still ellipsize in the view. Pure (no DOM) so the layout stays
 * unit-testable.
 */
export function nodeWidth(data: ErTableData): number {
  const longestCol = data.columns.reduce((m, c) => Math.max(m, c.name.length), 0);
  const longest = Math.max(data.table.length, longestCol);
  const raw = ER_NODE_HPAD + longest * ER_CHAR_WIDTH;
  return Math.round(Math.max(ER_NODE_MIN_WIDTH, Math.min(ER_NODE_MAX_WIDTH, raw)));
}

/** Direction the dagre rank layout flows: left-to-right or top-to-bottom (#560). */
export type ErLayoutDirection = "LR" | "TB";
/** Spacing preset between nodes/ranks (#560). */
export type ErLayoutDensity = "comfortable" | "compact";

export interface ErLayoutOptions {
  /** Rank direction. Defaults to "LR" (reads naturally for FK chains). */
  direction?: ErLayoutDirection;
  /** Node/rank separation preset. Defaults to "comfortable". */
  density?: ErLayoutDensity;
}

/** Maps the density preset to dagre node/rank separation in px. */
function separation(density: ErLayoutDensity): { nodesep: number; ranksep: number } {
  return density === "compact"
    ? { nodesep: 20, ranksep: 48 }
    : { nodesep: 40, ranksep: 90 };
}

export interface BuildErGraphInput {
  /** Tables and their column names, in declaration order (describe_database). */
  tables: { name: string; columns: string[] }[];
  /** All foreign keys in the database (foreign_keys). */
  foreignKeys: ForeignKey[];
  /** Primary-key column names per table, when known (describe_database). */
  pkByTable?: Record<string, string[]>;
}

/**
 * Builds the (un-positioned) node/edge graph from raw schema + FK metadata.
 * Marks each column as PK/FK, caps the number of tables and per-card columns,
 * and dedupes edges so a composite key draws one line per column pair without
 * repeats.
 */
export function buildErGraph(input: BuildErGraphInput): ErGraph {
  const { tables, foreignKeys, pkByTable } = input;
  const totalTables = tables.length;

  // FK degree per table (incoming + outgoing) drives which tables survive the
  // cap: the densely connected core is the most useful to see first.
  const degree = new Map<string, number>();
  const bump = (name: string) => degree.set(name, (degree.get(name) ?? 0) + 1);
  for (const fk of foreignKeys) {
    bump(fk.table);
    bump(fk.referenced_table);
  }

  let kept = tables;
  if (tables.length > MAX_TABLES) {
    kept = [...tables]
      .sort((a, b) => {
        const da = degree.get(a.name) ?? 0;
        const db = degree.get(b.name) ?? 0;
        if (da !== db) return db - da;
        return a.name.localeCompare(b.name);
      })
      .slice(0, MAX_TABLES);
  }
  const included = new Set(kept.map((t) => t.name));

  // Columns that originate a foreign key, keyed by (table, column). A naive
  // space-joined string (`${table} ${column}`) can collide for identifiers
  // that themselves contain spaces (quoted names) — e.g. table "order items"
  // column "id" produces the same joined string as table "order" column
  // "items id". `JSON.stringify` of the tuple keeps each part unambiguous
  // regardless of what characters the identifiers contain.
  const fkKey = (table: string, column: string): string => JSON.stringify([table, column]);
  const fkColumns = new Set<string>();
  for (const fk of foreignKeys) {
    fkColumns.add(fkKey(fk.table, fk.column));
  }

  const nodes: ErNode[] = kept.map((t) => {
    const pkSet = new Set(pkByTable?.[t.name] ?? []);
    const all: ErColumn[] = t.columns.map((name) => ({
      name,
      isPk: pkSet.has(name),
      isFk: fkColumns.has(fkKey(t.name, name)),
    }));
    const visible = all.slice(0, MAX_VISIBLE_COLUMNS);
    return {
      id: t.name,
      data: {
        table: t.name,
        columns: visible,
        hiddenColumns: Math.max(0, all.length - visible.length),
      },
    };
  });

  const seen = new Set<string>();
  const edges: ErEdge[] = [];
  for (const fk of foreignKeys) {
    if (!included.has(fk.table) || !included.has(fk.referenced_table)) continue;
    // A self-referencing FK is valid (e.g. employees.manager_id → employees.id)
    // and React Flow draws it as a loop; keep it.
    const target = fk.referenced_column ?? "";
    const id = JSON.stringify([fk.table, fk.column, fk.referenced_table, target]);
    if (seen.has(id)) continue;
    seen.add(id);
    edges.push({
      id,
      source: fk.table,
      target: fk.referenced_table,
      sourceColumn: fk.column,
      targetColumn: fk.referenced_column,
    });
  }

  return { nodes, edges, totalTables };
}

/**
 * Runs dagre over the graph and returns nodes with top-left positions plus the
 * (unchanged) edges. The rank direction (LR/TB) and node/rank separation are
 * configurable (#560); LR + comfortable is the default and reads naturally for
 * FK chains. Node widths are variable (`nodeWidth`) so long names aren't
 * clipped. dagre reports node centres, so we shift to top-left for React Flow.
 * Nodes dagre couldn't place (none, in practice) fall back to the origin.
 */
export function layoutErGraph(graph: ErGraph, options: ErLayoutOptions = {}): PositionedGraph {
  const direction = options.direction ?? "LR";
  const { nodesep, ranksep } = separation(options.density ?? "comfortable");
  // multigraph: composite keys (and several FKs to the same table) produce
  // more than one edge between the same node pair, each with its own id.
  const g = new dagre.graphlib.Graph({ multigraph: true });
  g.setGraph({ rankdir: direction, nodesep, ranksep, marginx: 24, marginy: 24 });
  g.setDefaultEdgeLabel(() => ({}));

  const sizes = new Map<string, { width: number; height: number }>();
  for (const node of graph.nodes) {
    const width = nodeWidth(node.data);
    const height = nodeHeight(node.data.columns.length, node.data.hiddenColumns);
    sizes.set(node.id, { width, height });
    g.setNode(node.id, { width, height });
  }
  for (const edge of graph.edges) {
    // dagre treats self-loops gracefully; still skip adding an edge to a node
    // dagre doesn't know about (shouldn't happen, but keeps layout robust).
    if (g.hasNode(edge.source) && g.hasNode(edge.target)) {
      g.setEdge(edge.source, edge.target, {}, edge.id);
    }
  }

  dagre.layout(g);

  const nodes: PositionedNode[] = graph.nodes.map((node) => {
    const size = sizes.get(node.id)!;
    const pos = g.node(node.id) as { x?: number; y?: number } | undefined;
    const cx = pos?.x ?? 0;
    const cy = pos?.y ?? 0;
    return {
      ...node,
      x: cx - size.width / 2,
      y: cy - size.height / 2,
      width: size.width,
      height: size.height,
    };
  });

  return { nodes, edges: graph.edges };
}
