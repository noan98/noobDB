import { useEffect, useMemo, useState } from "react";
import { QueryResult } from "../api/tauri";
import { useT } from "../i18n";

interface Props {
  /** EXPLAIN FORMAT=JSON result — a single row / single column JSON string. */
  result: QueryResult | null;
  /** True while the EXPLAIN command is still streaming its (single) row. */
  streaming?: boolean;
}

/**
 * A parsed node of the MySQL EXPLAIN plan tree. `attrs` keeps the scalar
 * fields (and flattened `cost_info.*`) for the detail panel; `children` are
 * the structural sub-plans (nested_loop tables, ordering/grouping operations,
 * sub-queries, ...).
 */
interface PlanNode {
  id: string;
  kind: string;
  label: string;
  cost: number | null;
  attrs: [string, unknown][];
  children: PlanNode[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isScalarArray(v: unknown[]): boolean {
  return v.every((x) => x === null || typeof x !== "object");
}

function parseNum(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Pick the most representative cost for a node. `query_block`/operation nodes
 * carry a `query_cost` (whole-subtree cost); `table` nodes carry a cumulative
 * `prefix_cost`. We fall back to read_cost + eval_cost when neither is set.
 */
function nodeCost(costInfo: Record<string, unknown> | undefined): number | null {
  if (!costInfo) return null;
  const qc = parseNum(costInfo.query_cost);
  if (qc !== null) return qc;
  const pc = parseNum(costInfo.prefix_cost);
  if (pc !== null) return pc;
  const rc = parseNum(costInfo.read_cost);
  const ec = parseNum(costInfo.eval_cost);
  if (rc !== null || ec !== null) return (rc ?? 0) + (ec ?? 0);
  return null;
}

const KIND_LABELS: Record<string, string> = {
  query_block: "Query block",
  nested_loop: "Nested loop",
  ordering_operation: "Ordering",
  grouping_operation: "Grouping",
  duplicates_removal: "Duplicates removal",
  buffer_result: "Buffer result",
  materialized_from_subquery: "Materialized subquery",
  union_result: "Union result",
  query_specifications: "Query specifications",
  attached_subqueries: "Attached subqueries",
  optimized_away_subqueries: "Optimized-away subqueries",
  select_list_subqueries: "Select-list subqueries",
  group_by_subqueries: "GROUP BY subqueries",
  order_by_subqueries: "ORDER BY subqueries",
  windowing: "Windowing",
  table: "Table",
};

function humanize(key: string): string {
  return KIND_LABELS[key] ?? key.replace(/_/g, " ");
}

function labelFor(key: string, obj: Record<string, unknown> | null): string {
  if (key === "table" && obj && typeof obj.table_name === "string") {
    return `table: ${obj.table_name}`;
  }
  return humanize(key);
}

// `cost_info` is an object but it is an attribute, not a sub-plan, so it is
// flattened into `attrs` rather than walked as a child.
const ATTR_OBJECT_KEYS = new Set(["cost_info"]);

function buildNode(key: string, obj: Record<string, unknown>, path: string): PlanNode {
  const attrs: [string, unknown][] = [];
  let costInfo: Record<string, unknown> | undefined;
  for (const [k, v] of Object.entries(obj)) {
    if (k === "cost_info" && isPlainObject(v)) {
      costInfo = v;
      for (const [ck, cv] of Object.entries(v)) attrs.push([`cost_info.${ck}`, cv]);
      continue;
    }
    if (isPlainObject(v)) continue; // structural child
    if (Array.isArray(v)) {
      if (isScalarArray(v)) attrs.push([k, v]); // scalar array → attribute
      continue; // structural array → child
    }
    attrs.push([k, v]); // scalar attribute
  }
  return {
    id: path,
    kind: key,
    label: labelFor(key, obj),
    cost: nodeCost(costInfo),
    attrs,
    children: buildChildren(obj, path),
  };
}

function buildChildren(obj: Record<string, unknown>, path: string): PlanNode[] {
  const out: PlanNode[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (ATTR_OBJECT_KEYS.has(k)) continue;
    if (isPlainObject(v)) {
      out.push(buildNode(k, v, `${path}/${k}`));
    } else if (Array.isArray(v) && v.some(isPlainObject)) {
      // Structural arrays (nested_loop, query_specifications, *_subqueries).
      // Each element typically wraps a single sub-plan (e.g. nested_loop
      // elements are `{ table: {...} }`), so we splice the element's own
      // children in to avoid an empty intermediate wrapper per element.
      const arrPath = `${path}/${k}`;
      const children: PlanNode[] = [];
      v.forEach((el, i) => {
        if (isPlainObject(el)) children.push(...buildChildren(el, `${arrPath}/${i}`));
      });
      out.push({ id: arrPath, kind: k, label: humanize(k), cost: null, attrs: [], children });
    }
  }
  return out;
}

function parsePlan(json: string): { root: PlanNode | null; error: string | null } {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (e) {
    return { root: null, error: e instanceof Error ? e.message : String(e) };
  }
  if (!isPlainObject(data)) return { root: null, error: "unexpected plan shape" };
  if (isPlainObject(data.query_block)) {
    return { root: buildNode("query_block", data.query_block, "query_block"), error: null };
  }
  return { root: buildNode("plan", data, "plan"), error: null };
}

function maxCost(node: PlanNode): number {
  let m = node.cost ?? 0;
  for (const c of node.children) m = Math.max(m, maxCost(c));
  return m;
}

function collectIds(node: PlanNode, into: string[]): void {
  into.push(node.id);
  for (const c of node.children) collectIds(c, into);
}

function findNode(node: PlanNode, id: string): PlanNode | null {
  if (node.id === id) return node;
  for (const c of node.children) {
    const hit = findNode(c, id);
    if (hit) return hit;
  }
  return null;
}

type Heat = "" | "warm" | "hot";

function heatFor(cost: number | null, max: number): Heat {
  if (cost === null || max <= 0) return "";
  const r = cost / max;
  if (r >= 0.66) return "hot";
  if (r >= 0.33) return "warm";
  return "";
}

function attrVal(node: PlanNode, key: string): unknown {
  const hit = node.attrs.find(([k]) => k === key);
  return hit ? hit[1] : undefined;
}

function formatNumber(n: number): string {
  if (Number.isInteger(n)) return n.toLocaleString();
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (Array.isArray(v)) return v.map((x) => formatValue(x)).join(", ");
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return formatNumber(v);
  return String(v);
}

interface NodeRowProps {
  node: PlanNode;
  depth: number;
  max: number;
  collapsed: Set<string>;
  selectedId: string | null;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
  expandLabel: string;
  collapseLabel: string;
}

function NodeRow({
  node,
  depth,
  max,
  collapsed,
  selectedId,
  onToggle,
  onSelect,
  expandLabel,
  collapseLabel,
}: NodeRowProps) {
  const isCollapsed = collapsed.has(node.id);
  const hasChildren = node.children.length > 0;
  const heat = heatFor(node.cost, max);
  const access = attrVal(node, "access_type");
  const rows = attrVal(node, "rows_produced_per_join") ?? attrVal(node, "rows_examined_per_scan");
  const usingIndex = attrVal(node, "using_index") === true;
  const selected = selectedId === node.id;
  return (
    <>
      <div
        className={`explain-node ${heat} ${selected ? "selected" : ""}`}
        style={{ paddingLeft: 6 + depth * 16 }}
        role="treeitem"
        aria-selected={selected}
        aria-expanded={hasChildren ? !isCollapsed : undefined}
        onClick={() => onSelect(node.id)}
      >
        {hasChildren ? (
          <button
            className="explain-caret"
            title={isCollapsed ? expandLabel : collapseLabel}
            aria-label={isCollapsed ? expandLabel : collapseLabel}
            onClick={(e) => {
              e.stopPropagation();
              onToggle(node.id);
            }}
          >
            {isCollapsed ? "▸" : "▾"}
          </button>
        ) : (
          <span className="explain-caret-spacer" aria-hidden />
        )}
        <span className="explain-node-label">{node.label}</span>
        <span className="explain-node-badges">
          {typeof access === "string" && (
            <span className={`explain-badge access ${access === "ALL" ? "bad" : ""}`}>{access}</span>
          )}
          {usingIndex && <span className="explain-badge index">index</span>}
          {node.cost !== null && (
            <span className={`explain-badge cost ${heat}`}>{formatNumber(node.cost)}</span>
          )}
          {parseNum(rows) !== null && (
            <span className="explain-badge rows">{formatNumber(parseNum(rows) as number)} rows</span>
          )}
        </span>
      </div>
      {hasChildren &&
        !isCollapsed &&
        node.children.map((c) => (
          <NodeRow
            key={c.id}
            node={c}
            depth={depth + 1}
            max={max}
            collapsed={collapsed}
            selectedId={selectedId}
            onToggle={onToggle}
            onSelect={onSelect}
            expandLabel={expandLabel}
            collapseLabel={collapseLabel}
          />
        ))}
    </>
  );
}

export function ExplainViewer({ result, streaming }: Props) {
  const t = useT();
  const raw =
    result && result.rows.length > 0 && result.rows[0].length > 0
      ? String(result.rows[0][0] ?? "")
      : null;

  const { root, error } = useMemo(
    () => (raw ? parsePlan(raw) : { root: null, error: null }),
    [raw],
  );
  const max = useMemo(() => (root ? maxCost(root) : 0), [root]);
  const allIds = useMemo(() => {
    if (!root) return [];
    const ids: string[] = [];
    collectIds(root, ids);
    return ids;
  }, [root]);

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Reset transient UI (selection, collapse) and select the root whenever a
  // new plan arrives.
  useEffect(() => {
    setCollapsed(new Set());
    setSelectedId(root ? root.id : null);
  }, [root]);

  const selected = useMemo(
    () => (root && selectedId ? findNode(root, selectedId) : null),
    [root, selectedId],
  );

  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (streaming && !root) {
    return <div className="explain-viewer-empty">{t("explainLoading")}</div>;
  }
  if (!raw) {
    return <div className="explain-viewer-empty">{t("explainEmpty")}</div>;
  }
  if (error || !root) {
    return (
      <div className="explain-viewer-error">
        <p>{t("explainParseError", { error: error ?? "unknown" })}</p>
        <pre>{raw}</pre>
      </div>
    );
  }

  return (
    <div className="explain-viewer">
      <div className="explain-tree-pane">
        <div className="explain-toolbar">
          {root.cost !== null && (
            <span className="explain-total-cost">
              {t("explainTotalCost", { cost: formatNumber(root.cost) })}
            </span>
          )}
          <span className="explain-toolbar-spacer" />
          <button
            className="results-toolbar-btn"
            onClick={() => setCollapsed(new Set())}
            title={t("explainExpandAll")}
          >
            {t("explainExpandAll")}
          </button>
          <button
            className="results-toolbar-btn"
            onClick={() => setCollapsed(new Set(allIds))}
            title={t("explainCollapseAll")}
          >
            {t("explainCollapseAll")}
          </button>
        </div>
        <div className="explain-tree" role="tree">
          <NodeRow
            node={root}
            depth={0}
            max={max}
            collapsed={collapsed}
            selectedId={selectedId}
            onToggle={toggle}
            onSelect={setSelectedId}
            expandLabel={t("explainExpandNode")}
            collapseLabel={t("explainCollapseNode")}
          />
        </div>
      </div>
      <div className="explain-detail">
        <div className="explain-detail-header">{t("explainDetailTitle")}</div>
        {selected ? (
          <div className="explain-detail-body">
            <div className="explain-detail-label">{selected.label}</div>
            {selected.attrs.length === 0 ? (
              <p className="explain-detail-hint">{t("explainNoAttrs")}</p>
            ) : (
              <table className="explain-detail-table">
                <tbody>
                  {selected.attrs.map(([k, v]) => (
                    <tr key={k}>
                      <th>{k}</th>
                      <td>{formatValue(v)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ) : (
          <p className="explain-detail-hint">{t("explainSelectHint")}</p>
        )}
      </div>
    </div>
  );
}
