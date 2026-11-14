import { Box, Flex, VisuallyHidden, chakra } from "@chakra-ui/react";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { useT } from "../i18n";
import { transitions, variants } from "../motion";
import { semanticColorToken } from "../semanticColors";
import { Icon, ICON_SIZES } from "./Icon";
import {
  OP_ROLE,
  buildSampleCards,
  selectedOps,
  type AuditSampleOp,
  type SampleCard,
  type SampleCell,
  type SampleColumn,
  type SampleOptions,
} from "./auditSampleModel";
import { TypeGlyph } from "./TypeGlyph";

/**
 * 監査トリガーのウィザード (#2324) の図解: 「元の表 → AFTER トリガー → 監査表」の流れの小図と、
 * 選んだ操作ごとの「監査表に残る 1 行」の見本。見本の値は型から作るダミーで実データは使わない。
 * 組み立ては `auditSample.ts` (純関数)。ここは描画だけ。
 * 出入りと列の詰まりは motion (reduced-motion はルートの MotionConfig が抑制する)。
 */

const MotionChip = chakra(
  motion.span,
  {},
  { forwardProps: ["initial", "animate", "exit", "transition", "layout"] },
);
const MotionCard = chakra(
  motion.div,
  {},
  { forwardProps: ["initial", "animate", "exit", "transition", "layout"] },
);
const MotionCell = chakra(motion.span, {}, { forwardProps: ["layout", "transition"] });

const OP_LABEL_KEY = {
  insert: "auditSampleOpInsert",
  update: "auditSampleOpUpdate",
  delete: "auditSampleOpDelete",
} as const;

/** 操作チップ (INSERT=success / UPDATE=warning / DELETE=danger)。 */
function OpChip({ op, animated = false }: { op: AuditSampleOp; animated?: boolean }) {
  const role = OP_ROLE[op];
  const props = {
    display: "inline-flex",
    alignItems: "center",
    px: "2",
    py: "0.5",
    borderRadius: "full",
    border: "1px solid",
    borderColor: semanticColorToken(role, "border"),
    bg: semanticColorToken(role, "subtle"),
    color: semanticColorToken(role, "text"),
    fontFamily: "mono",
    fontSize: "xs",
    fontWeight: 600,
    "data-testid": `audit-op-chip-${op}`,
    "data-tone": role,
  } as const;
  if (!animated) return <chakra.span {...props}>{op.toUpperCase()}</chakra.span>;
  return (
    <MotionChip
      {...props}
      layout
      initial={variants.fadeScale.initial}
      animate={variants.fadeScale.animate}
      exit={variants.fadeScale.exit}
      transition={transitions.enter}
    >
      {op.toUpperCase()}
    </MotionChip>
  );
}

function FlowNode({ label, name, testId }: { label: string; name: string; testId: string }) {
  return (
    <Flex
      direction="column"
      align="center"
      gap="1"
      minW={0}
      px="3"
      py="2"
      border="1px solid"
      borderColor="app.borderStrong"
      borderRadius="md"
      bg="app.surface"
      data-testid={testId}
    >
      <chakra.span fontSize="2xs" color="app.textMuted" lineHeight="1.2">
        {label}
      </chakra.span>
      <chakra.span fontFamily="mono" fontSize="sm" color="app.text" wordBreak="break-all" textAlign="center">
        {name}
      </chakra.span>
    </Flex>
  );
}

function FlowArrow() {
  return (
    <chakra.span aria-hidden color="app.textMuted" display="inline-flex" flexShrink={0}>
      <Icon name="chevron-right" size={ICON_SIZES.md} />
    </chakra.span>
  );
}

/** 流れの小図。真ん中のトリガーに、選んだ操作がチップで出入りする。 */
export function AuditFlowDiagram({
  table,
  auditTable,
  options,
}: {
  table: string;
  auditTable: string;
  options: SampleOptions;
}) {
  const t = useT();
  const ops = selectedOps(options);
  const opsText = ops.map((o) => o.toUpperCase()).join(", ") || "-";
  return (
    <Flex
      role="img"
      aria-label={t("auditFlowAria", { table, ops: opsText, audit: auditTable })}
      data-testid="audit-flow-diagram"
      align="center"
      justify="center"
      gap="2"
      w="100%"
      minW={0}
    >
      <FlowNode label={t("auditFlowSource")} name={table} testId="audit-flow-source" />
      <FlowArrow />
      <Flex
        direction="column"
        align="center"
        gap="1"
        minW="0"
        px="3"
        py="2"
        border="1px solid"
        borderColor="app.borderStrong"
        borderRadius="md"
        bg="app.surface"
        data-testid="audit-flow-trigger"
      >
        <chakra.span fontSize="2xs" color="app.textMuted" lineHeight="1.2">
          {t("auditFlowTrigger")}
        </chakra.span>
        <Flex gap="1" flexWrap="wrap" justify="center" minH="5">
          <AnimatePresence initial={false}>
            {ops.map((op) => (
              <OpChip key={op} op={op} animated />
            ))}
          </AnimatePresence>
        </Flex>
      </Flex>
      <FlowArrow />
      <FlowNode label={t("auditFlowTarget")} name={auditTable} testId="audit-flow-target" />
    </Flex>
  );
}

function CellList({ cells }: { cells: SampleCell[] }) {
  const t = useT();
  return (
    <Flex gap="1.5" flexWrap="wrap" minW={0}>
      {cells.map((c) => (
        <MotionCell
          key={c.name}
          layout
          transition={transitions.layout}
          display="inline-flex"
          alignItems="center"
          gap="1"
          px="1.5"
          py="0.5"
          borderRadius="sm"
          bg="app.surfaceMuted"
          fontFamily="mono"
          fontSize="xs"
          color={c.excluded ? "app.textMuted" : "app.text"}
          opacity={c.excluded ? 0.5 : 1}
          textDecoration={c.excluded ? "line-through" : undefined}
          data-testid={`audit-sample-cell-${c.name}`}
          data-excluded={c.excluded ? "true" : "false"}
        >
          <TypeGlyph kind={c.kind} />
          {c.name}={c.value}
          {c.excluded && <VisuallyHidden>{t("auditSampleExcludedCell")}</VisuallyHidden>}
        </MotionCell>
      ))}
    </Flex>
  );
}

function RowField({
  label,
  cells,
  emptyLabel,
}: {
  label: string;
  cells: SampleCell[] | null;
  emptyLabel: string;
}) {
  return (
    <Flex gap="2" align="baseline" minW={0}>
      <chakra.span w="16" flexShrink={0} fontFamily="mono" textStyle="caption" color="app.textMuted">
        {label}
      </chakra.span>
      {cells ? (
        <CellList cells={cells} />
      ) : (
        <chakra.span fontFamily="mono" textStyle="caption" color="app.textMuted">
          {emptyLabel}
        </chakra.span>
      )}
    </Flex>
  );
}

function SampleCardView({ card }: { card: SampleCard }) {
  const t = useT();
  return (
    <MotionCard
      layout
      initial={variants.slideUp.initial}
      animate={variants.slideUp.animate}
      exit={variants.slideUp.exit}
      transition={transitions.enter}
      display="flex"
      flexDirection="column"
      gap="1.5"
      p="2.5"
      border="1px solid"
      borderColor="app.border"
      borderRadius="md"
      bg="app.surface"
      data-testid={`audit-sample-card-${card.op}`}
    >
      <Flex align="center" gap="2" flexWrap="wrap">
        <OpChip op={card.op} />
        <chakra.span fontSize="xs" color="app.textSecondary">
          {t(OP_LABEL_KEY[card.op])}
        </chakra.span>
        {card.skipsUnchanged && (
          <chakra.span
            display="inline-flex"
            px="2"
            py="0.5"
            borderRadius="full"
            border="1px solid"
            borderColor="app.border"
            bg="app.surfaceMuted"
            fontSize="2xs"
            color="app.textSecondary"
            data-testid="audit-sample-skip-badge"
          >
            {t("auditSampleSkipUnchanged")}
          </chakra.span>
        )}
      </Flex>
      <RowField label="pk" cells={card.pk} emptyLabel="NULL" />
      <RowField label="old_row" cells={card.oldRow} emptyLabel="NULL" />
      <RowField label="new_row" cells={card.newRow} emptyLabel="NULL" />
    </MotionCard>
  );
}

/** 選んだ操作ごとの、監査表に残る 1 行の見本。 */
export function AuditSample({
  columns,
  options,
}: {
  columns: readonly SampleColumn[];
  options: SampleOptions;
}) {
  const t = useT();
  const cards = buildSampleCards(columns, options);
  return (
    <Box data-testid="audit-sample">
      <LayoutGroup>
        <Flex direction="column" gap="2">
          <AnimatePresence initial={false}>
            {cards.map((card) => (
              <SampleCardView key={card.op} card={card} />
            ))}
          </AnimatePresence>
        </Flex>
      </LayoutGroup>
      <chakra.span display="block" mt="1.5" textStyle="caption" color="app.textMuted">
        {t("auditSampleNote")}
      </chakra.span>
    </Box>
  );
}
