import { Box, chakra, Flex, VisuallyHidden } from "@chakra-ui/react";
import { useEffect, useId, useState } from "react";

import type { ProcessInfo } from "../api/tauri";
import { useT } from "../i18n";
import { semanticColorToken, semanticColorVar } from "../semanticColors";
import {
  BLOCKING_GRAPH_UNITS,
  layoutBlockingGraph,
  type BlockingGraphEdge,
  type BlockingGraphNode,
  type WaitLevel,
} from "./blockingGraph";
import { formatProcessTime } from "./processList";
import { Tooltip } from "./Tooltip";
import { Button } from "./ui";

/**
 * ロック待機グラフ (#2237)。根のブロッカー → 待たされているプロセスを、左から右へのノード + 矢印で描く。
 * 配置は `layoutBlockingGraph` (純関数)、ここは描画だけ。矢印の色と太さは待ち時間の段階、
 * デッドロックの循環は danger の弧、一覧にないブロッカーは点線の枠。
 * 座標はユニット (`--space-1`) で、タイルは絶対配置・矢印は 1 枚の SVG (viewBox = ユニット) で重ねる。
 * 線は描き入れる (`.lock-graph-edge`)。reduced-motion / hc-* は `App.css` 側で即時。
 */

function edgeColor(level: WaitLevel, cycle: boolean): string {
  if (cycle) return semanticColorVar("danger", "solid");
  switch (level) {
    case "long":
      return semanticColorVar("danger", "solid");
    case "medium":
      return semanticColorVar("warning", "solid");
    case "short":
      return semanticColorVar("info", "solid");
    default:
      return "var(--text-muted)";
  }
}

/** 太さ (ユニット)。 */
const STROKE_UNITS = { 1: 0.5, 2: 0.9, 3: 1.4 } as const;

const units = (n: number) => `calc(${n} * var(--space-1))`;

/** マウント直後に 1 回だけ線を描き入れる (`.lock-graph-edge[data-lit]`)。 */
function useDrawIn(): boolean {
  const [lit, setLit] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setLit(true));
    return () => cancelAnimationFrame(id);
  }, []);
  return lit;
}

const MARKER_LEVELS: { key: string; color: string }[] = [
  { key: "danger", color: semanticColorVar("danger", "solid") },
  { key: "warning", color: semanticColorVar("warning", "solid") },
  { key: "info", color: semanticColorVar("info", "solid") },
  { key: "muted", color: "var(--text-muted)" },
];

function markerKey(e: BlockingGraphEdge): string {
  if (e.cycle || e.level === "long") return "danger";
  if (e.level === "medium") return "warning";
  if (e.level === "short") return "info";
  return "muted";
}

function Tile({
  node,
  readOnly,
  killing,
  onKill,
}: {
  node: BlockingGraphNode;
  readOnly: boolean;
  killing: boolean;
  onKill: (id: number) => void;
}) {
  const t = useT();
  const { process: p } = node;
  const danger = node.isRoot || node.inCycle;
  const canKill = !node.external && node.victims > 0;
  const status = node.inCycle
    ? t("processBlockingDeadlock")
    : node.external
      ? t("processBlockingExternal", { id: p.id, count: node.victims })
      : node.isRoot
        ? t("processBlockingRoot", { count: node.victims })
        : null;
  const label = [
    `#${p.id}`,
    p.user ?? "",
    p.time_secs != null ? formatProcessTime(p.time_secs) : "",
    status ?? "",
    p.query_summary ?? "",
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <Flex
      className="lock-graph-node"
      role="group"
      aria-label={label}
      data-testid="blocking-node"
      data-id={p.id}
      data-root={node.isRoot ? "true" : "false"}
      data-external={node.external ? "true" : "false"}
      data-deadlock={node.inCycle ? "true" : "false"}
      direction="column"
      gap="0.5"
      px="2"
      py="1"
      position="absolute"
      borderRadius="md"
      borderWidth="2px"
      borderStyle={node.external ? "dashed" : "solid"}
      borderColor={danger ? semanticColorToken("danger", "border") : "app.borderStrong"}
      bg={danger ? semanticColorToken("danger", "subtle") : "app.surface"}
      overflow="hidden"
      style={{
        left: units(node.x),
        top: units(node.y),
        width: units(BLOCKING_GRAPH_UNITS.tileW),
        height: units(BLOCKING_GRAPH_UNITS.tileH),
      }}
    >
      <Flex align="baseline" gap="1.5" minW={0} fontFamily="var(--font-mono)" fontSize="xs">
        <chakra.span fontWeight={node.isRoot ? 700 : 600} color="app.text" flexShrink={0}>
          #{p.id}
        </chakra.span>
        <chakra.span color="app.textMuted" overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap">
          {p.user ?? "–"}
        </chakra.span>
        {p.time_secs != null && (
          <chakra.span textStyle="numeric" color="app.textMuted" ml="auto" flexShrink={0}>
            {formatProcessTime(p.time_secs)}
          </chakra.span>
        )}
      </Flex>
      <chakra.span
        fontFamily="var(--font-mono)"
        fontSize="xs"
        color="app.textSecondary"
        overflow="hidden"
        textOverflow="ellipsis"
        whiteSpace="nowrap"
        title={p.query_summary ?? undefined}
      >
        {p.query_summary ?? ""}
      </chakra.span>
      <Flex align="center" gap="1.5" minW={0} mt="auto">
        {p.is_self && (
          <chakra.span
            px="1.5"
            fontSize="var(--text-xs)"
            color="var(--accent)"
            border="1px solid var(--accent)"
            borderRadius="var(--radius-sm)"
            flexShrink={0}
          >
            {t("processSelfBadge")}
          </chakra.span>
        )}
        {status && (
          <chakra.span
            textStyle="caption"
            color={node.external ? "app.textWarning" : "app.textError"}
            overflow="hidden"
            textOverflow="ellipsis"
            whiteSpace="nowrap"
            title={status}
          >
            {status}
          </chakra.span>
        )}
        {canKill && node.isRoot && (
          <Box ml="auto" flexShrink={0}>
            <Tooltip label={readOnly ? t("processReadOnlyHint") : undefined} focusableWrapper={readOnly}>
              <Button
                type="button"
                variant="danger"
                size="sm"
                disabled={readOnly || killing}
                aria-label={t("processBlockingKillAria", { id: p.id })}
                onClick={() => onKill(p.id)}
              >
                {t("processBlockingKill")}
              </Button>
            </Tooltip>
          </Box>
        )}
      </Flex>
    </Flex>
  );
}

export function BlockingGraph({
  processes,
  readOnly,
  killing,
  onKill,
}: {
  processes: readonly ProcessInfo[];
  readOnly: boolean;
  killing: boolean;
  onKill: (id: number) => void;
}) {
  const t = useT();
  const lit = useDrawIn();
  const markerId = useId();
  const layout = layoutBlockingGraph(processes);
  if (layout.nodes.length === 0) return null;

  const idLabel = (id: number) => `#${id}`;
  return (
    <Box data-testid="blocking-graph">
      <chakra.p textStyle="caption" color="app.textMuted" mb="2" data-testid="blocking-legend">
        {t("processBlockingLegend")}
      </chakra.p>
      {/* 低い親 (Bottom Panel) の flex 子として縮まないよう flexShrink=0。はみ出しは内側でスクロール。 */}
      <Box
        flexShrink={0}
        overflow="auto"
        maxH="28rem"
        p="1"
        tabIndex={0}
        role="group"
        aria-label={t("processBlockingGraphAria")}
        borderRadius="md"
        borderWidth="1px"
        borderColor="app.border"
        bg="app.surfaceMuted"
      >
        <Box
          position="relative"
          flexShrink={0}
          style={{ width: units(layout.width), height: units(layout.height) }}
        >
          <svg
            width="100%"
            height="100%"
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            preserveAspectRatio="none"
            aria-hidden
            style={{ position: "absolute", inset: 0, overflow: "visible" }}
          >
            <defs>
              {MARKER_LEVELS.map((m) => (
                <marker
                  key={m.key}
                  id={`${markerId}-${m.key}`}
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="3"
                  markerHeight="3"
                  markerUnits="userSpaceOnUse"
                  orient="auto"
                >
                  <path d="M0 0 L10 5 L0 10 z" style={{ fill: m.color }} />
                </marker>
              ))}
            </defs>
            {layout.edges.map((e) => (
              <path
                key={e.key}
                className="lock-graph-edge"
                data-testid="blocking-edge"
                data-level={e.level}
                data-cycle={e.cycle ? "true" : "false"}
                data-lit={lit ? "true" : "false"}
                d={e.path}
                pathLength={1}
                fill="none"
                strokeWidth={STROKE_UNITS[e.thickness]}
                strokeLinecap="round"
                style={{ stroke: edgeColor(e.level, e.cycle) }}
                markerEnd={`url(#${markerId}-${markerKey(e)})`}
              />
            ))}
          </svg>
          {layout.nodes.map((n) => (
            <Tile key={n.id} node={n} readOnly={readOnly} killing={killing} onKill={onKill} />
          ))}
        </Box>
      </Box>
      {/* スクリーンリーダー向け: 従来のリスト表現 (待ち関係を文で)。 */}
      <VisuallyHidden>
        <ul>
          {layout.nodes.map((n) => (
            <li key={n.id}>
              {n.blockers.length > 0
                ? t("processBlockingSrWaits", {
                    id: idLabel(n.id),
                    blockers: n.blockers.map(idLabel).join(", "),
                  })
                : n.external
                  ? t("processBlockingSrExternal", { id: idLabel(n.id), count: n.victims })
                  : t("processBlockingSrRoot", { id: idLabel(n.id), count: n.victims })}
              {n.inCycle ? ` ${t("processBlockingSrDeadlock")}` : ""}
            </li>
          ))}
        </ul>
      </VisuallyHidden>
    </Box>
  );
}
