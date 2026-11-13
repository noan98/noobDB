import { useId, useState, type ReactNode } from "react";
import { chakra } from "@chakra-ui/react";
import { AnimatePresence, motion, useReducedMotionConfig } from "motion/react";
import { useT, type I18nKey } from "../i18n";
import { staggerContainer, transitions, variants } from "../motion";
import { semanticColorToken, type SemanticRole } from "../semanticColors";
import { Icon, ICON_SIZES, type IconName } from "./Icon";
import { prefersStaticMotion } from "./revealOrigin";

/**
 * 破壊的 DDL / DML の「影響の及ぶ先」を描く共通の影響ツリー (#2295)。
 *
 * 左に起点チップ (テーブル / 列)、右へ枝分かれする木で依存先を並べる。依存先は種別グリフ + 名前 (mono) +
 * 結果バッジ (連鎖削除 / ブロック / NULL 化 / 作り直し …)。色だけに頼らず、グリフと文言を必ず併記する。
 * 外枠は呼び出し側の `Callout` のままで、中身だけをこの部品に差し替える。
 *
 * - `groups` — 起点ごとの塊。起点が 1 つしかなければ 1 要素でよい。`origin` を省くと起点チップなしの木になる。
 * - `ImpactNode.children` — 多段の依存は字下げとコネクタ線で入れ子に描く。
 * - 先頭 `maxVisible` 件 (起点をまたいだトップレベルの通し数) を超えた分は「ほか N 件」に畳み、押すと
 *   `variants.collapse` で全件を展開する。
 * - 入場は `staggerContainer` + `variants.staggerItem` (段数は `IMPACT_TREE_MAX_STAGGER_STEPS` で頭打ち)。
 *   reduced-motion / ハイコントラストでは入場も展開も即時。
 */

/** 依存先・起点の種別。グリフは `KIND_ICON` が単一ソース。 */
export type ImpactKind =
  | "table"
  | "column"
  | "view"
  | "matview"
  | "trigger"
  | "index"
  | "foreign_key"
  | "function"
  | "other";

const KIND_ICON: Record<ImpactKind, IconName> = {
  table: "table",
  column: "columns",
  view: "view",
  matview: "view",
  trigger: "trigger",
  index: "hash",
  foreign_key: "link",
  function: "routine",
  other: "list",
};

/** 巻き込まれ方。バッジの文言と配色は `OUTCOME` が決める。 */
export type ImpactOutcome = "cascade" | "block" | "setNull" | "setDefault" | "rebuild" | "break" | "change";

type BadgeTone = SemanticRole | "accent";

const OUTCOME: Record<ImpactOutcome, { tone: BadgeTone; label: I18nKey; icon: IconName }> = {
  cascade: { tone: "danger", label: "impactOutcomeCascade", icon: "trash" },
  block: { tone: "warning", label: "impactOutcomeBlock", icon: "lock" },
  setNull: { tone: "info", label: "impactOutcomeSetNull", icon: "info" },
  setDefault: { tone: "info", label: "impactOutcomeSetDefault", icon: "info" },
  rebuild: { tone: "accent", label: "impactOutcomeRebuild", icon: "refresh" },
  break: { tone: "danger", label: "impactOutcomeBreak", icon: "alert-circle" },
  change: { tone: "info", label: "impactOutcomeChange", icon: "pencil" },
};

export interface ImpactNode {
  /** 兄弟の中で一意なキー。 */
  key: string;
  kind: ImpactKind;
  /** 種別の表示名 (「ビュー」「トリガー」など)。省略可。 */
  kindLabel?: string;
  /** 名前 (等幅で出す)。 */
  name: string;
  outcome?: ImpactOutcome;
  /** 名前の下に出す補足 (行数・ON DELETE など)。 */
  meta?: ReactNode;
  /** 行末に置く操作 (「子行を開く」など)。 */
  action?: ReactNode;
  children?: ImpactNode[];
  testId?: string;
}

export interface ImpactOrigin {
  kind: ImpactKind;
  name: string;
}

export interface ImpactGroup {
  key: string;
  origin?: ImpactOrigin;
  nodes: ImpactNode[];
}

interface Props {
  groups: ImpactGroup[];
  /** 畳まずに出すトップレベルの依存先の数 (起点をまたいだ通し数)。既定 8。 */
  maxVisible?: number;
  /** 展開時に木の高さをこの値で頭打ちにしてスクロールさせる (例: "12rem")。省略時は伸びるだけ。 */
  expandedMaxH?: string;
  testId?: string;
}

/** 入場 stagger の段数の上限 (WhatsNewModal / firstBatchReveal と同じ 12 段)。超えた分は遅延なしで即表示。 */
export const IMPACT_TREE_MAX_STAGGER_STEPS = 12;

const DEFAULT_MAX_VISIBLE = 8;
const INSTANT = { duration: 0 } as const;

const MotionList = chakra(motion.ul, {}, { forwardProps: ["variants", "initial", "animate"] });
const MotionItem = chakra(motion.li, {}, { forwardProps: ["variants"] });
const MotionCollapse = chakra(
  motion.div,
  {},
  { forwardProps: ["variants", "initial", "animate", "exit", "transition"] },
);

export function ImpactTree({ groups, maxVisible = DEFAULT_MAX_VISIBLE, expandedMaxH, testId }: Props) {
  const t = useT();
  const listId = useId();
  const reducedConfig = useReducedMotionConfig() ?? false;
  // MotionConfig の reduced-motion は stagger の遅延と height 補間を止めないので、ハイコントラストも含めて明示的に止める。
  const still = reducedConfig || prefersStaticMotion();
  const [expanded, setExpanded] = useState(false);

  // 起点をまたいだ通し数で先頭 maxVisible 件だけ出し、残りは畳む。
  let budget = Math.max(maxVisible, 1);
  const split = groups.map((g) => {
    const head = g.nodes.slice(0, budget);
    budget -= head.length;
    return { group: g, head, rest: g.nodes.slice(head.length) };
  });
  const hiddenCount = split.reduce((n, s) => n + s.rest.length, 0);

  let step = 0;
  return (
    <chakra.div display="flex" flexDirection="column" gap="2" mt="2" data-testid={testId}>
      <chakra.div
        id={listId}
        display="flex"
        flexDirection="column"
        gap="2"
        maxH={expanded ? expandedMaxH : undefined}
        overflowY={expanded && expandedMaxH ? "auto" : undefined}
      >
        {split.map(({ group, head, rest }) => {
          const hasRest = rest.length > 0;
          // 通し数の上限で全件が畳まれた起点は、チップだけが残って「影響なし」に見えるので展開するまで描かない。
          // 依存が 0 件の起点はそもそも畳まれていないので描く (呼び出し元が渡した場合でも消さない)。
          if (!expanded && head.length === 0 && hasRest) return null;
          return (
            <chakra.div key={group.key} display="flex" alignItems="flex-start" gap="2">
              {group.origin && <OriginChip origin={group.origin} />}
              <chakra.div flex="1" minW={0} display="flex" flexDirection="column">
                <MotionList
                  variants={staggerContainer(still)}
                  initial="initial"
                  animate="animate"
                  m={0}
                  p={0}
                  listStyleType="none"
                  display="flex"
                  flexDirection="column"
                >
                  {head.map((node, i) => (
                    // 段数に上限を付ける: 超えた分は variants を渡さず (= 親の伝播を受けず) 即表示する。
                    <MotionItem
                      key={node.key}
                      variants={step++ < IMPACT_TREE_MAX_STAGGER_STEPS ? variants.staggerItem : undefined}
                      listStyleType="none"
                    >
                      <NodeRow node={node} last={!hasRest && i === head.length - 1} />
                    </MotionItem>
                  ))}
                </MotionList>
                <AnimatePresence initial={false}>
                  {expanded && hasRest && (
                    <MotionCollapse
                      key="rest"
                      variants={variants.collapse}
                      initial="initial"
                      animate="animate"
                      exit="exit"
                      transition={still ? INSTANT : transitions.enter}
                    >
                      <chakra.ul m={0} p={0} listStyleType="none" display="flex" flexDirection="column">
                        {rest.map((node, i) => (
                          <chakra.li key={node.key} listStyleType="none">
                            <NodeRow node={node} last={i === rest.length - 1} />
                          </chakra.li>
                        ))}
                      </chakra.ul>
                    </MotionCollapse>
                  )}
                </AnimatePresence>
              </chakra.div>
            </chakra.div>
          );
        })}
      </chakra.div>
      {hiddenCount > 0 && (
        <chakra.button
          type="button"
          aria-expanded={expanded}
          aria-controls={listId}
          onClick={() => setExpanded((v) => !v)}
          alignSelf="flex-start"
          display="inline-flex"
          alignItems="center"
          gap="1"
          px="1.5"
          py="0.5"
          borderRadius="sm"
          textStyle="caption"
          color="app.textSecondary"
          cursor="pointer"
          _hover={{ bg: "app.hover", color: "app.text" }}
          data-testid="impact-tree-toggle"
        >
          <Icon name={expanded ? "chevron-down" : "chevron-right"} size="sm" />
          {expanded ? t("impactTreeLess") : t("dropReferencedByMore", { count: hiddenCount })}
        </chakra.button>
      )}
    </chakra.div>
  );
}

/** 起点 (テーブル / 列) のチップ。木の左に置く。 */
function OriginChip({ origin }: { origin: ImpactOrigin }) {
  return (
    <chakra.span
      display="inline-flex"
      alignItems="center"
      gap="1"
      px="2"
      py="0.5"
      maxW="40%"
      flexShrink={0}
      borderRadius="full"
      border="1px solid"
      borderColor="app.border"
      bg="app.surface"
      color="app.text"
      fontFamily="mono"
      fontSize="sm"
      wordBreak="break-all"
      data-testid="impact-origin"
    >
      <chakra.span aria-hidden display="inline-flex" flexShrink={0}>
        <Icon name={KIND_ICON[origin.kind]} size={ICON_SIZES.sm} />
      </chakra.span>
      {origin.name}
    </chakra.span>
  );
}

/** コネクタ線 (縦線 + 横の枝) つきの 1 行。`children` があれば字下げして入れ子に描く。 */
function NodeRow({ node, last }: { node: ImpactNode; last: boolean }) {
  return (
    <chakra.div
      position="relative"
      pl="4"
      py="0.5"
      _before={{
        content: '""',
        position: "absolute",
        left: 0,
        top: 0,
        height: last ? "50%" : "100%",
        borderLeftWidth: "1px",
        borderColor: "app.border",
      }}
      _after={{
        content: '""',
        position: "absolute",
        left: 0,
        top: "50%",
        width: "3",
        borderTopWidth: "1px",
        borderColor: "app.border",
      }}
    >
      <NodeBody node={node} />
      {node.children && node.children.length > 0 && (
        <chakra.ul m={0} mt="0.5" ml="3" p={0} listStyleType="none">
          {node.children.map((c, i) => (
            <chakra.li key={c.key} listStyleType="none">
              <NodeRow node={c} last={i === node.children!.length - 1} />
            </chakra.li>
          ))}
        </chakra.ul>
      )}
    </chakra.div>
  );
}

function NodeBody({ node }: { node: ImpactNode }) {
  const t = useT();
  const outcome = node.outcome ? OUTCOME[node.outcome] : null;
  return (
    <chakra.div display="flex" alignItems="center" gap="2" data-testid={node.testId}>
      <chakra.span aria-hidden display="inline-flex" flexShrink={0} color="app.textSecondary">
        <Icon name={KIND_ICON[node.kind]} size={ICON_SIZES.sm} />
      </chakra.span>
      <chakra.div flex="1" minW={0} fontSize="sm">
        <chakra.div display="flex" flexWrap="wrap" alignItems="center" columnGap="2">
          {node.kindLabel && (
            <chakra.span textStyle="caption" color="app.textMuted">
              {node.kindLabel}
            </chakra.span>
          )}
          <chakra.span fontFamily="mono" wordBreak="break-all">
            {node.name}
          </chakra.span>
          {outcome && <OutcomeBadge tone={outcome.tone} icon={outcome.icon} label={t(outcome.label)} />}
        </chakra.div>
        {node.meta && (
          <chakra.div textStyle="caption" color="app.textMuted">
            {node.meta}
          </chakra.div>
        )}
      </chakra.div>
      {node.action}
    </chakra.div>
  );
}

/**
 * 結果バッジ。面の上の文字なので意味色は `text` 段 (`dangerFg` 等のベタ塗り用前景は使わない)。
 * `accent` は `app.accentHighlight` の淡い地に通常文字色。
 */
function OutcomeBadge({ tone, icon, label }: { tone: BadgeTone; icon: IconName; label: string }) {
  const accent = tone === "accent";
  return (
    <chakra.span
      display="inline-flex"
      alignItems="center"
      gap="1"
      px="1.5"
      py="0"
      textStyle="overline"
      lineHeight={1.4}
      borderRadius="sm"
      whiteSpace="nowrap"
      border="1px solid"
      bg={accent ? "app.accentHighlight" : semanticColorToken(tone, "subtle")}
      color={accent ? "app.text" : semanticColorToken(tone, "text")}
      borderColor={accent ? "app.accent" : semanticColorToken(tone, "border")}
      data-outcome-tone={tone}
    >
      <Icon name={icon} size={ICON_SIZES.sm} />
      {label}
    </chakra.span>
  );
}
