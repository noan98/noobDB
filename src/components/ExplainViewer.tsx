import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { Box, chakra, type SystemStyleObject } from "@chakra-ui/react";
import { QueryResult } from "../api/tauri";
import { useT, type I18nKey } from "../i18n";
import { Button } from "./ui";
import { Spinner } from "./Spinner";
import {
  type Heat,
  type HintSeverity,
  type PlanNode,
  type ScoreBand,
  attrVal,
  collectIds,
  computeHints,
  findNode,
  formatNumber,
  formatValue,
  heatFor,
  maxCost,
  parseExplainForDriver,
  parseNum,
  scorePlan,
  severityLabelKey,
  worstSeverity,
} from "./explainPlan";

const ExplainGraphView = lazy(() =>
  import("./ExplainGraphView").then((m) => ({ default: m.ExplainGraphView })),
);

/**
 * EXPLAIN プラン可視化のツリー/詳細パネルのスタイル。各要素へ直接 `css`
 * (状態依存はヘルパで分岐) を適用する。ヒート (warm/hot) はハードコード色で、
 * ダークテーマの上書きを持つ。
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
  gap: "1.5",
  py: "1",
  px: "2",
  background: "var(--bg-toolbar)",
  borderBottom: "1px solid var(--border-subtle)",
  flexShrink: 0,
};
const totalCostCss: SystemStyleObject = {
  fontSize: "var(--text-sm)",
  color: "var(--text-secondary)",
  fontWeight: 500,
};

/**
 * 重さスコアのバッジ (0〜100)。band (low/mid/high) で配色を切り替える。
 * low は緑 (--status-success)、mid は warm (--status-warning)、high は hot
 * (--status-error) でヒート色と揃える。文字色は --text-warning / --text-success を
 * 使い、ライト/ダークの追従はトークン側に任せる (手書き _dark 分岐を持たない)。
 */
function scoreBadgeCss(band: ScoreBand): SystemStyleObject {
  const base: SystemStyleObject = {
    display: "inline-flex",
    alignItems: "center",
    gap: "5px",
    fontSize: "var(--text-sm)",
    fontWeight: 700,
    lineHeight: 1,
    padding: "3px 9px",
    borderRadius: "var(--radius-pill)",
    border: "1px solid",
    cursor: "default",
  };
  if (band === "high") {
    return {
      ...base,
      background: "color-mix(in srgb, var(--status-error) 16%, transparent)",
      borderColor: "color-mix(in srgb, var(--status-error) 45%, transparent)",
      color: "var(--text-error)",
    };
  }
  if (band === "mid") {
    return {
      ...base,
      background: "color-mix(in srgb, var(--status-warning) 16%, transparent)",
      borderColor: "color-mix(in srgb, var(--status-warning) 45%, transparent)",
      color: "var(--text-warning)",
    };
  }
  return {
    ...base,
    background: "color-mix(in srgb, var(--status-success) 16%, transparent)",
    borderColor: "color-mix(in srgb, var(--status-success) 45%, transparent)",
    color: "var(--text-success)",
  };
}
const scoreValueCss: SystemStyleObject = {
  fontVariantNumeric: "tabular-nums",
};
const scoreBandCss: SystemStyleObject = {
  fontSize: "var(--text-2xs)",
  fontWeight: 600,
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  opacity: 0.85,
};

function scoreBandLabelKey(band: ScoreBand): I18nKey {
  if (band === "high") return "explainScoreHigh";
  if (band === "mid") return "explainScoreMid";
  return "explainScoreLow";
}
const treeCss: SystemStyleObject = {
  flex: 1,
  overflow: "auto",
  minHeight: 0,
  padding: "4px 0",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-sm)",
};

/** ツリー行。ヒートと選択状態で背景/ホバーを切り替える。 */
function nodeCss(heat: Heat, selected: boolean): SystemStyleObject {
  const base: SystemStyleObject = {
    display: "flex",
    alignItems: "center",
    gap: "1.5",
    padding: "3px 10px 3px 0",
    cursor: "pointer",
    whiteSpace: "nowrap",
    borderLeft: "2px solid transparent",
  };
  if (selected) {
    const bg =
      heat === "hot"
        ? "color-mix(in srgb, var(--status-error) 24%, var(--bg-active))"
        : heat === "warm"
          ? "color-mix(in srgb, var(--status-warning) 22%, var(--bg-active))"
          : "var(--bg-active)";
    // 選択行はホバーしても選択色を維持する。
    return { ...base, background: bg, borderLeftColor: "var(--accent)", _hover: { background: bg } };
  }
  if (heat === "hot") {
    return {
      ...base,
      background: "color-mix(in srgb, var(--status-error) 16%, transparent)",
      _hover: { background: "color-mix(in srgb, var(--status-error) 24%, transparent)" },
    };
  }
  if (heat === "warm") {
    return {
      ...base,
      background: "color-mix(in srgb, var(--status-warning) 14%, transparent)",
      _hover: { background: "color-mix(in srgb, var(--status-warning) 22%, transparent)" },
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
  gap: "1",
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
type SeverityTone = "error" | "warning";

/**
 * caution/warning (ヒートの warm/hot も同義) の重大度カテゴリから、状態バッジ・
 * ボーダーで使う色トークンをまとめて返す共通ヘルパー。`status` は生の
 * `--status-*` トークン (border-left など単色でそのまま使う箇所向け)、`text` は
 * `--text-*` トークン、`bg`/`border` はバッジの背景/枠線用に `color-mix` で
 * 薄めた値 (枠線の混合率は呼び出し元で異なるため `borderPct` で指定、既定 40%)。
 * `accessBadgeCss` / `costBadgeCss` / `hintBadgeCss` / `hintItemCss` /
 * `hintSevCss` が共通で利用する。
 */
function severityTokens(
  tone: SeverityTone,
  borderPct = 40,
): { status: string; text: string; bg: string; border: string } {
  const status = tone === "error" ? "var(--status-error)" : "var(--status-warning)";
  const text = tone === "error" ? "var(--text-error)" : "var(--text-warning)";
  return {
    status,
    text,
    bg: `color-mix(in srgb, ${status} 16%, transparent)`,
    border: `color-mix(in srgb, ${status} ${borderPct}%, transparent)`,
  };
}

/** access バッジ。`ALL` (フルスキャン) のときだけ警告色にする。 */
function accessBadgeCss(bad: boolean): SystemStyleObject {
  if (bad) {
    const tone = severityTokens("error");
    return {
      ...badgeBaseCss,
      fontWeight: 600,
      background: tone.bg,
      borderColor: tone.border,
      color: tone.text,
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
    const tone = severityTokens("warning");
    return { ...badgeBaseCss, color: tone.text, borderColor: tone.border };
  }
  if (heat === "hot") {
    const tone = severityTokens("error");
    return { ...badgeBaseCss, color: tone.text, borderColor: tone.border };
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
    py: "0.5", px: "1",
  };
  const tone = severityTokens(sev === "caution" ? "warning" : "error", 45);
  return { ...base, background: tone.bg, borderColor: tone.border, color: tone.text };
}

const hintsListCss: SystemStyleObject = {
  listStyle: "none",
  margin: "0 0 10px",
  padding: 0,
  display: "flex",
  flexDirection: "column",
  gap: "1.5",
};
/** 詳細パネルのヒント 1 件。重大度で左枠色を変える。 */
function hintItemCss(sev: HintSeverity): SystemStyleObject {
  const borderLeftColor =
    sev === "info" ? "var(--accent)" : severityTokens(sev === "caution" ? "warning" : "error").status;
  return {
    display: "flex",
    flexDirection: "column",
    gap: "3px",
    padding: "7px 9px",
    borderRadius: "var(--radius-sm)",
    border: "1px solid var(--border)",
    borderLeftWidth: "3px",
    borderLeftColor,
    background: "var(--bg-muted)",
    fontSize: "var(--text-sm)",
    lineHeight: 1.45,
  };
}
/** ヒントの重大度ラベル。 */
function hintSevCss(sev: HintSeverity): SystemStyleObject {
  const color =
    sev === "info" ? "var(--accent)" : severityTokens(sev === "warning" ? "error" : "warning").text;
  return {
    fontWeight: 600,
    fontSize: "var(--text-2xs)",
    letterSpacing: "0.04em",
    textTransform: "uppercase",
    color,
  };
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
  py: "1.5",
  px: "3",
  fontSize: "var(--text-sm)",
  fontWeight: 600,
  color: "var(--text-secondary)",
  borderBottom: "1px solid var(--border-subtle)",
  background: "var(--bg-toolbar)",
  flexShrink: 0,
};
const detailBodyCss: SystemStyleObject = { overflow: "auto", py: "2.5", px: "3" };
const detailHintCss: SystemStyleObject = {
  padding: "3",
  color: "var(--text-muted)",
  fontSize: "var(--text-sm)",
};
const detailLabelCss: SystemStyleObject = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-md)",
  fontWeight: 600,
  color: "var(--text)",
  marginBottom: "2",
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

/** 空 / ローディング時のプレースホルダ枠。 */
const EXPLAIN_EMPTY_PROPS = {
  flex: "1 1 auto",
  minHeight: 0,
  minWidth: 0,
  display: "flex",
  flexDirection: "column",
  gap: "2.5",
  padding: "5",
  color: "app.textMuted",
  fontSize: "md",
  bg: "app.surface",
  overflow: "auto",
  alignItems: "center",
  justifyContent: "center",
  textAlign: "center",
} as const;

interface Props {
  /** EXPLAIN result. MySQL/PostgreSQL: single JSON cell. SQLite: plan rows. */
  result: QueryResult | null;
  /** Driver, selects the EXPLAIN output parser. */
  driver: string;
  /** True while the EXPLAIN command is still streaming its (single) row. */
  streaming?: boolean;
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

export function ExplainViewer({ result, driver, streaming }: Props) {
  const t = useT();
  const { raw, root, error } = useMemo(
    () => parseExplainForDriver(driver, result),
    [driver, result],
  );
  const [view, setView] = useState<"tree" | "graph">("tree");
  const max = useMemo(() => (root ? maxCost(root) : 0), [root]);
  const score = useMemo(() => (root ? scorePlan(root) : null), [root]);
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
      /* EXPLAIN_EMPTY_PROPS は column/center 配置なので Spinner をテキストの
         上に重ねて縦積みローディング表示にする。 */
      <Box {...EXPLAIN_EMPTY_PROPS}>
        <Spinner size={13} />
        {t("explainLoading")}
      </Box>
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
        gap="2.5"
        padding="5"
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
          padding="2.5"
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
          {score && (
            <chakra.span
              css={scoreBadgeCss(score.band)}
              title={t("explainScoreTooltip", {
                cost: score.costMissing ? "—" : score.costScore,
                risk: score.riskScore,
              })}
              aria-label={t("explainScoreAria", {
                score: score.score,
                band: t(scoreBandLabelKey(score.band)),
              })}
            >
              <chakra.span>{t("explainScoreLabel")}</chakra.span>
              <chakra.span css={scoreValueCss}>{score.score}</chakra.span>
              <chakra.span css={scoreBandCss}>{t(scoreBandLabelKey(score.band))}</chakra.span>
            </chakra.span>
          )}
          {root.cost !== null && (
            <chakra.span css={totalCostCss}>
              {t("explainTotalCost", { cost: formatNumber(root.cost) })}
            </chakra.span>
          )}
          <chakra.span flex={1} />
          <Button
            size="sm"
            px="2.5"
            variant={view === "tree" ? "primary" : "secondary"}
            onClick={() => setView("tree")}
            title={t("explainViewTree")}
          >
            {t("explainViewTree")}
          </Button>
          <Button
            size="sm"
            px="2.5"
            variant={view === "graph" ? "primary" : "secondary"}
            onClick={() => setView("graph")}
            title={t("explainViewGraph")}
          >
            {t("explainViewGraph")}
          </Button>
          {view === "tree" && (
            <>
              <Button
                size="sm"
                px="2.5"
                onClick={() => setCollapsed(new Set())}
                title={t("explainExpandAll")}
              >
                {t("explainExpandAll")}
              </Button>
              <Button
                size="sm"
                px="2.5"
                onClick={() => setCollapsed(new Set(allIds))}
                title={t("explainCollapseAll")}
              >
                {t("explainCollapseAll")}
              </Button>
            </>
          )}
        </Box>
        {view === "graph" ? (
          <Box flex="1" minHeight={0} position="relative">
            <Suspense
              fallback={
                <Box position="absolute" inset={0} display="flex" alignItems="center" justifyContent="center" color="app.textMuted">
                  <Spinner size={18} />
                </Box>
              }
            >
              <ExplainGraphView
                root={root}
                maxCost={max}
                selectedId={selectedId}
                onSelect={setSelectedId}
              />
            </Suspense>
          </Box>
        ) : (
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
        )}
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
