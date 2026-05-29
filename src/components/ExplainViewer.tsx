import { useEffect, useMemo, useState } from "react";
import { Box, chakra, type SystemStyleObject } from "@chakra-ui/react";
import { QueryResult } from "../api/tauri";
import { useT, type I18nKey } from "../i18n";
import { Button } from "./ui";

/**
 * EXPLAIN プラン可視化のツリー/詳細パネルのスタイル。以前は `.explain-*` の
 * className + 子孫セレクタで `App.css` 〜コンポーネント内 `css` を当てていたが、
 * className を撤去し、各要素へ直接 `css` (状態依存はヘルパで分岐) を適用する形へ
 * 移行した。ヒート (warm/hot) のハードコード色とダークテーマ上書きはそのまま維持する。
 */
const treePaneCss: SystemStyleObject = {
  flex: 1,
  display: "flex",
  flexDirection: "column",
  minWidth: 0,
  overflow: "hidden",
};
const toolbarCss: SystemStyleObject = {
  display: "flex",
  alignItems: "center",
  gap: "6px",
  padding: "4px 8px",
  background: "var(--bg-toolbar)",
  borderBottom: "1px solid var(--border-subtle)",
  flexShrink: 0,
};
const totalCostCss: SystemStyleObject = {
  fontSize: "var(--text-sm)",
  color: "var(--text-secondary)",
  fontWeight: 500,
};
const treeCss: SystemStyleObject = {
  flex: 1,
  overflow: "auto",
  minHeight: 0,
  padding: "4px 0",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-sm)",
};

/** ツリー行 (旧 `.explain-node`)。ヒートと選択状態で背景/ホバーを切り替える。 */
function nodeCss(heat: Heat, selected: boolean): SystemStyleObject {
  const base: SystemStyleObject = {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    padding: "3px 10px 3px 0",
    cursor: "pointer",
    whiteSpace: "nowrap",
    borderLeft: "2px solid transparent",
  };
  if (selected) {
    const bg =
      heat === "hot"
        ? "color-mix(in srgb, #dc2626 24%, var(--bg-active))"
        : heat === "warm"
          ? "color-mix(in srgb, #f59e0b 22%, var(--bg-active))"
          : "var(--bg-active)";
    // 選択行はホバーしても選択色を維持する (旧 CSS の specificity 順を踏襲)。
    return { ...base, background: bg, borderLeftColor: "var(--accent)", _hover: { background: bg } };
  }
  if (heat === "hot") {
    return {
      ...base,
      background: "color-mix(in srgb, #dc2626 16%, transparent)",
      _hover: { background: "color-mix(in srgb, #dc2626 24%, transparent)" },
    };
  }
  if (heat === "warm") {
    return {
      ...base,
      background: "color-mix(in srgb, #f59e0b 14%, transparent)",
      _hover: { background: "color-mix(in srgb, #f59e0b 22%, transparent)" },
    };
  }
  return { ...base, _hover: { background: "var(--bg-row-hover)" } };
}

const caretBoxCss: SystemStyleObject = {
  flexShrink: 0,
  width: "16px",
  height: "16px",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
};
const caretButtonCss: SystemStyleObject = {
  ...caretBoxCss,
  padding: 0,
  border: "none",
  background: "none",
  color: "var(--text-muted)",
  fontSize: "var(--text-2xs)",
  lineHeight: 1,
  borderRadius: "var(--radius-sm)",
  _hover: { background: "var(--bg-hover)", color: "var(--text)" },
};
const nodeLabelCss: SystemStyleObject = {
  color: "var(--text)",
  overflow: "hidden",
  textOverflow: "ellipsis",
};
const nodeBadgesCss: SystemStyleObject = {
  display: "inline-flex",
  alignItems: "center",
  gap: "var(--space-1)",
  flexShrink: 0,
};

const badgeBaseCss: SystemStyleObject = {
  fontSize: "var(--text-2xs)",
  lineHeight: 1,
  padding: "2px 5px",
  borderRadius: "var(--radius-sm)",
  background: "var(--bg-muted)",
  border: "1px solid var(--border)",
  color: "var(--text-secondary)",
  whiteSpace: "nowrap",
};
/** access バッジ。`ALL` (フルスキャン) のときだけ警告色にする。 */
function accessBadgeCss(bad: boolean): SystemStyleObject {
  if (bad) {
    return {
      ...badgeBaseCss,
      fontWeight: 600,
      background: "color-mix(in srgb, #dc2626 16%, transparent)",
      borderColor: "color-mix(in srgb, #dc2626 40%, transparent)",
      color: "var(--text-error)",
    };
  }
  return { ...badgeBaseCss, fontWeight: 600 };
}
const indexBadgeCss: SystemStyleObject = {
  ...badgeBaseCss,
  background: "color-mix(in srgb, var(--accent) 14%, transparent)",
  borderColor: "color-mix(in srgb, var(--accent) 35%, transparent)",
  color: "var(--accent)",
};
/** cost バッジ。ヒートに応じて文字/枠色を上げる。 */
function costBadgeCss(heat: Heat): SystemStyleObject {
  if (heat === "warm") {
    return {
      ...badgeBaseCss,
      color: "#b45309",
      borderColor: "color-mix(in srgb, #f59e0b 40%, transparent)",
      _dark: { color: "#fbbf24" },
    };
  }
  if (heat === "hot") {
    return {
      ...badgeBaseCss,
      color: "var(--text-error)",
      borderColor: "color-mix(in srgb, #dc2626 40%, transparent)",
    };
  }
  return badgeBaseCss;
}
/** ヒント有無を示す `!` マーカーバッジ (caution / warning)。 */
function hintBadgeCss(sev: "caution" | "warning"): SystemStyleObject {
  const base: SystemStyleObject = {
    ...badgeBaseCss,
    fontWeight: 700,
    minWidth: "14px",
    textAlign: "center",
    padding: "2px 4px",
  };
  if (sev === "caution") {
    return {
      ...base,
      background: "color-mix(in srgb, #f59e0b 16%, transparent)",
      borderColor: "color-mix(in srgb, #f59e0b 45%, transparent)",
      color: "#b45309",
      _dark: { color: "#fbbf24" },
    };
  }
  return {
    ...base,
    background: "color-mix(in srgb, #dc2626 16%, transparent)",
    borderColor: "color-mix(in srgb, #dc2626 45%, transparent)",
    color: "var(--text-error)",
  };
}

const hintsListCss: SystemStyleObject = {
  listStyle: "none",
  margin: "0 0 10px",
  padding: 0,
  display: "flex",
  flexDirection: "column",
  gap: "6px",
};
/** 詳細パネルのヒント 1 件 (旧 `.explain-hint`)。重大度で左枠色を変える。 */
function hintItemCss(sev: HintSeverity): SystemStyleObject {
  const borderLeftColor = sev === "info" ? "var(--accent)" : sev === "caution" ? "#f59e0b" : "#dc2626";
  return {
    display: "flex",
    flexDirection: "column",
    gap: "3px",
    padding: "7px 9px",
    borderRadius: "var(--radius-sm)",
    border: "1px solid var(--border)",
    borderLeftWidth: "3px",
    borderLeftColor,
    background: "var(--bg-subtle, var(--bg-muted))",
    fontSize: "var(--text-sm)",
    lineHeight: 1.45,
  };
}
/** ヒントの重大度ラベル (旧 `.explain-hint-sev`)。 */
function hintSevCss(sev: HintSeverity): SystemStyleObject {
  const color = sev === "info" ? "var(--accent)" : sev === "warning" ? "var(--text-error)" : "#b45309";
  const base: SystemStyleObject = {
    fontWeight: 600,
    fontSize: "var(--text-2xs)",
    letterSpacing: "0.04em",
    textTransform: "uppercase",
    color,
  };
  if (sev === "caution") return { ...base, _dark: { color: "#fbbf24" } };
  return base;
}
const hintTextCss: SystemStyleObject = { color: "var(--text)" };

const detailCss: SystemStyleObject = {
  width: "320px",
  flexShrink: 0,
  display: "flex",
  flexDirection: "column",
  borderLeft: "1px solid var(--border)",
  background: "var(--bg-muted)",
  overflow: "hidden",
};
const detailHeaderCss: SystemStyleObject = {
  padding: "6px 12px",
  fontSize: "var(--text-sm)",
  fontWeight: 600,
  color: "var(--text-secondary)",
  borderBottom: "1px solid var(--border-subtle)",
  background: "var(--bg-toolbar)",
  flexShrink: 0,
};
const detailBodyCss: SystemStyleObject = { overflow: "auto", padding: "10px 12px" };
const detailHintCss: SystemStyleObject = {
  padding: "var(--space-3)",
  color: "var(--text-muted)",
  fontSize: "var(--text-sm)",
};
const detailLabelCss: SystemStyleObject = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-md)",
  fontWeight: 600,
  color: "var(--text)",
  marginBottom: "8px",
  wordBreak: "break-word",
};
// 属性テーブルのみ `th`/`td` をタグセレクタで括る (className ではなく要素スコープ)。
const detailTableCss: SystemStyleObject = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "var(--text-xs)",
  fontFamily: "var(--font-mono)",
  "& th, & td": {
    textAlign: "left",
    verticalAlign: "top",
    padding: "3px 6px",
    borderBottom: "1px solid var(--border-subtle)",
    wordBreak: "break-word",
  },
  "& th": {
    color: "var(--text-muted)",
    fontWeight: 500,
    whiteSpace: "nowrap",
    width: "45%",
  },
  "& td": { color: "var(--text)" },
};

/** 空 / ローディング時のプレースホルダ枠 (`.explain-viewer-empty` 相当)。 */
const EXPLAIN_EMPTY_PROPS = {
  flex: "1 1 auto",
  minHeight: 0,
  minWidth: 0,
  display: "flex",
  flexDirection: "column",
  gap: "10px",
  padding: "var(--space-5)",
  color: "app.textMuted",
  fontSize: "md",
  bg: "app.surface",
  overflow: "auto",
  alignItems: "center",
  justifyContent: "center",
  textAlign: "center",
} as const;

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

type HintSeverity = "info" | "caution" | "warning";

interface PlanHint {
  severity: HintSeverity;
  key: I18nKey;
}

// `rows_examined_per_scan` above these thresholds is flagged so juniors notice
// scans that won't scale. Tuned conservatively to avoid false alarms on the
// small tables that dominate development databases.
const ROWS_CAUTION_THRESHOLD = 100_000;
const ROWS_WARNING_THRESHOLD = 1_000_000;

const SEVERITY_RANK: Record<HintSeverity, number> = { info: 0, caution: 1, warning: 2 };

// Reads a node's raw MySQL EXPLAIN attributes and derives plain-language
// performance hints. Each hint maps to an i18n key explaining the cause and a
// concrete fix. Returns an empty array when nothing notable is found.
function computeHints(node: PlanNode): PlanHint[] {
  const hints: PlanHint[] = [];

  if (node.kind === "table") {
    const access = attrVal(node, "access_type");
    if (access === "ALL") {
      hints.push({ severity: "warning", key: "explainHintFullScan" });
    } else if (access === "index") {
      hints.push({ severity: "caution", key: "explainHintFullIndexScan" });
    }
    if (typeof attrVal(node, "using_join_buffer") === "string") {
      hints.push({ severity: "caution", key: "explainHintJoinBuffer" });
    }
    const rows = parseNum(attrVal(node, "rows_examined_per_scan"));
    if (rows !== null && rows >= ROWS_WARNING_THRESHOLD) {
      hints.push({ severity: "warning", key: "explainHintManyRows" });
    } else if (rows !== null && rows >= ROWS_CAUTION_THRESHOLD) {
      hints.push({ severity: "caution", key: "explainHintManyRows" });
    }
    if (attrVal(node, "using_index") === true) {
      hints.push({ severity: "info", key: "explainHintCoveringIndex" });
    }
  }

  // Sort/group bookkeeping flags can appear on operation nodes regardless of
  // kind, so they are checked on every node.
  if (attrVal(node, "using_temporary_table") === true) {
    hints.push({ severity: "caution", key: "explainHintTempTable" });
  }
  if (attrVal(node, "using_filesort") === true) {
    hints.push({ severity: "caution", key: "explainHintFilesort" });
  }

  return hints;
}

function worstSeverity(hints: PlanHint[]): HintSeverity | null {
  let worst: HintSeverity | null = null;
  for (const h of hints) {
    if (worst === null || SEVERITY_RANK[h.severity] > SEVERITY_RANK[worst]) worst = h.severity;
  }
  return worst;
}

function severityLabelKey(s: HintSeverity): I18nKey {
  if (s === "warning") return "explainSeverityWarning";
  if (s === "caution") return "explainSeverityCaution";
  return "explainSeverityInfo";
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
  hintsLabel: string;
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
  hintsLabel,
}: NodeRowProps) {
  const isCollapsed = collapsed.has(node.id);
  const hasChildren = node.children.length > 0;
  const heat = heatFor(node.cost, max);
  const access = attrVal(node, "access_type");
  const rows = attrVal(node, "rows_produced_per_join") ?? attrVal(node, "rows_examined_per_scan");
  const usingIndex = attrVal(node, "using_index") === true;
  const selected = selectedId === node.id;
  // Only surface a marker for actionable hints (caution / warning); the
  // positive "info" hints are still shown in the detail panel on selection.
  const worstHint = worstSeverity(computeHints(node));
  const showHintMarker = worstHint === "caution" || worstHint === "warning";
  return (
    <>
      <Box
        css={nodeCss(heat, selected)}
        pl={`${6 + depth * 16}px`}
        role="treeitem"
        aria-selected={selected}
        aria-expanded={hasChildren ? !isCollapsed : undefined}
        onClick={() => onSelect(node.id)}
      >
        {hasChildren ? (
          <chakra.button
            css={caretButtonCss}
            title={isCollapsed ? expandLabel : collapseLabel}
            aria-label={isCollapsed ? expandLabel : collapseLabel}
            onClick={(e) => {
              e.stopPropagation();
              onToggle(node.id);
            }}
          >
            {isCollapsed ? "▸" : "▾"}
          </chakra.button>
        ) : (
          <chakra.span css={caretBoxCss} aria-hidden />
        )}
        <chakra.span css={nodeLabelCss}>{node.label}</chakra.span>
        <chakra.span css={nodeBadgesCss}>
          {showHintMarker && (
            <chakra.span css={hintBadgeCss(worstHint)} title={hintsLabel} aria-label={hintsLabel}>
              !
            </chakra.span>
          )}
          {typeof access === "string" && (
            <chakra.span css={accessBadgeCss(access === "ALL")}>{access}</chakra.span>
          )}
          {usingIndex && <chakra.span css={indexBadgeCss}>index</chakra.span>}
          {node.cost !== null && (
            <chakra.span css={costBadgeCss(heat)}>{formatNumber(node.cost)}</chakra.span>
          )}
          {parseNum(rows) !== null && (
            <chakra.span css={badgeBaseCss}>{formatNumber(parseNum(rows) as number)} rows</chakra.span>
          )}
        </chakra.span>
      </Box>
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
            hintsLabel={hintsLabel}
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
  const selectedHints = useMemo(() => (selected ? computeHints(selected) : []), [selected]);

  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (streaming && !root) {
    return (
      <Box {...EXPLAIN_EMPTY_PROPS}>{t("explainLoading")}</Box>
    );
  }
  if (!raw) {
    return (
      <Box {...EXPLAIN_EMPTY_PROPS}>{t("explainEmpty")}</Box>
    );
  }
  if (error || !root) {
    return (
      <Box
        flex="1 1 auto"
        minHeight={0}
        minWidth={0}
        display="flex"
        flexDirection="column"
        gap="10px"
        padding="var(--space-5)"
        color="app.textMuted"
        fontSize="md"
        bg="app.surface"
        overflow="auto"
      >
        <chakra.p color="app.textError" margin={0}>
          {t("explainParseError", { error: error ?? "unknown" })}
        </chakra.p>
        <chakra.pre
          margin={0}
          padding="10px"
          fontFamily="var(--font-mono)"
          fontSize="xs"
          whiteSpace="pre-wrap"
          wordBreak="break-all"
          bg="app.surfaceMuted"
          border="1px solid"
          borderColor="app.border"
          borderRadius="md"
          color="app.textSecondary"
        >
          {raw}
        </chakra.pre>
      </Box>
    );
  }

  return (
    <Box
      flex="1 1 auto"
      minHeight={0}
      minWidth={0}
      display="flex"
      flexDirection="row"
      bg="app.surface"
      overflow="hidden"
    >
      <Box css={treePaneCss}>
        <Box css={toolbarCss}>
          {root.cost !== null && (
            <chakra.span css={totalCostCss}>
              {t("explainTotalCost", { cost: formatNumber(root.cost) })}
            </chakra.span>
          )}
          <chakra.span flex={1} />
          <Button
            size="sm"
            px="10px"
            onClick={() => setCollapsed(new Set())}
            title={t("explainExpandAll")}
          >
            {t("explainExpandAll")}
          </Button>
          <Button
            size="sm"
            px="10px"
            onClick={() => setCollapsed(new Set(allIds))}
            title={t("explainCollapseAll")}
          >
            {t("explainCollapseAll")}
          </Button>
        </Box>
        <Box css={treeCss} role="tree">
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
            hintsLabel={t("explainHintsTitle")}
          />
        </Box>
      </Box>
      <Box css={detailCss}>
        <Box css={detailHeaderCss}>{t("explainDetailTitle")}</Box>
        {selected ? (
          <Box css={detailBodyCss}>
            <Box css={detailLabelCss}>{selected.label}</Box>
            {selectedHints.length > 0 && (
              <chakra.ul css={hintsListCss}>
                {selectedHints.map((h, i) => (
                  <chakra.li key={i} css={hintItemCss(h.severity)}>
                    <chakra.span css={hintSevCss(h.severity)}>{t(severityLabelKey(h.severity))}</chakra.span>
                    <chakra.span css={hintTextCss}>{t(h.key)}</chakra.span>
                  </chakra.li>
                ))}
              </chakra.ul>
            )}
            {selected.attrs.length === 0 ? (
              <chakra.p css={detailHintCss}>{t("explainNoAttrs")}</chakra.p>
            ) : (
              <chakra.table css={detailTableCss}>
                <tbody>
                  {selected.attrs.map(([k, v]) => (
                    <tr key={k}>
                      <th>{k}</th>
                      <td>{formatValue(v)}</td>
                    </tr>
                  ))}
                </tbody>
              </chakra.table>
            )}
          </Box>
        ) : (
          <chakra.p css={detailHintCss}>{t("explainSelectHint")}</chakra.p>
        )}
      </Box>
    </Box>
  );
}
