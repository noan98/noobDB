import { type ReactNode, useState } from "react";
import { chakra } from "@chakra-ui/react";
import { motion, useReducedMotionConfig } from "motion/react";
import type { CloneColumnRule, CloneRowsOutcome } from "../api/tauri";
import { useT } from "../i18n";
import { staggerContainer, variants } from "../motion";
import { CLONE_MAPPING_VISIBLE, cellText, describeRule } from "./cloneRows";
import { prefersStaticMotion } from "./revealOrigin";
import { ToneChip } from "./ToneChip";

/**
 * 子行の複製 (#2304) の完了後の「旧キー → 新キー」の対応を、表ごとの小さな表で見せる (#2323)。
 * 起点の行はアクセント色のピル、件数の多い表は先頭 `CLONE_MAPPING_VISIBLE` 件だけ出して「ほか n 件」へ畳む
 * (`ImpactTree` と同じ作法)。行は stagger で入場し、reduced-motion では即時。
 */

const MotionRows = chakra(motion.div, {}, { forwardProps: ["variants", "initial", "animate"] });
const MotionRow = chakra(motion.div, {}, { forwardProps: ["variants"] });

/** 入場を順次にする先頭行数 (多い表を全件遅延させない)。 */
const STAGGER_CAP = 12;

const COLUMNS = "1fr auto 1fr auto";

function TableMapping({ table }: { table: CloneRowsOutcome["tables"][number] }) {
  const t = useT();
  const reduced = (useReducedMotionConfig() ?? false) || prefersStaticMotion();
  const [expanded, setExpanded] = useState(false);
  const hidden = Math.max(0, table.mappings.length - CLONE_MAPPING_VISIBLE);
  const shown = expanded ? table.mappings : table.mappings.slice(0, CLONE_MAPPING_VISIBLE);
  return (
    <chakra.div
      border="1px solid"
      borderColor="app.border"
      borderRadius="md"
      overflow="hidden"
      data-testid="clone-mapping-table"
      data-table={table.table}
    >
      <chakra.div
        display="flex"
        alignItems="baseline"
        gap="2"
        px="3"
        py="1.5"
        bg="app.bgInput"
        borderBottom="1px solid"
        borderColor="app.border"
      >
        <chakra.span fontFamily="mono" fontSize="sm" flex="1" minW="0" wordBreak="break-all">
          {table.table}
        </chakra.span>
        {table.keyColumns.length > 0 && (
          <chakra.span textStyle="caption" color="app.textMuted" fontFamily="mono">
            [{table.keyColumns.join(", ")}]
          </chakra.span>
        )}
        <chakra.span textStyle="caption" color="app.textMuted" fontFamily="mono">
          {t("cloneRowsMappingCount", { rows: table.rows })}
        </chakra.span>
      </chakra.div>
      {table.keyColumns.length === 0 ? (
        <chakra.div px="3" py="2" textStyle="caption" color="app.textMuted">
          {t("cloneRowsNoKeyMapping")}
        </chakra.div>
      ) : (
        <chakra.div display="flex" flexDirection="column">
          <chakra.div
            display="grid"
            gridTemplateColumns={COLUMNS}
            gap="2"
            px="3"
            py="1"
            textStyle="overline"
            color="app.textMuted"
          >
            <span>{t("cloneRowsMappingOld")}</span>
            <span aria-hidden="true" />
            <span>{t("cloneRowsMappingNew")}</span>
            <span aria-hidden="true" />
          </chakra.div>
          <MotionRows
            key={expanded ? "all" : "head"}
            variants={staggerContainer(reduced)}
            initial="initial"
            animate="animate"
            display="flex"
            flexDirection="column"
          >
            {shown.map((m, i) => (
              <MotionRow
                key={JSON.stringify(m.oldKey)}
                variants={i < STAGGER_CAP ? variants.staggerItem : undefined}
                display="grid"
                gridTemplateColumns={COLUMNS}
                gap="2"
                alignItems="center"
                px="3"
                py="1"
                borderTop="1px solid"
                borderColor="app.border"
                fontFamily="mono"
                fontSize="sm"
                data-testid="clone-mapping-row"
                data-root={m.root ? "true" : "false"}
              >
                <chakra.span wordBreak="break-all">{m.oldKey.map(cellText).join(", ")}</chakra.span>
                <chakra.span color="app.textMuted" aria-hidden="true">
                  →
                </chakra.span>
                <chakra.span wordBreak="break-all">{m.newKey.map(cellText).join(", ")}</chakra.span>
                <chakra.span display="inline-flex">
                  {m.root && (
                    <ToneChip tone="accent" pill>
                      {t("cloneRowsMappingRoot")}
                    </ToneChip>
                  )}
                </chakra.span>
              </MotionRow>
            ))}
          </MotionRows>
          {hidden > 0 && (
            <chakra.button
              type="button"
              px="3"
              py="1.5"
              textAlign="left"
              textStyle="caption"
              color="app.accent"
              cursor="pointer"
              borderTop="1px solid"
              borderColor="app.border"
              aria-expanded={expanded}
              data-testid="clone-mapping-more"
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? t("impactTreeLess") : t("dropReferencedByMore", { count: hidden })}
            </chakra.button>
          )}
        </chakra.div>
      )}
    </chakra.div>
  );
}

export function CloneOutcomeTables({ outcome }: { outcome: CloneRowsOutcome }) {
  return (
    <chakra.div display="flex" flexDirection="column" gap="2" data-testid="clone-mapping">
      {outcome.tables.map((tb) => (
        <TableMapping key={tb.table} table={tb} />
      ))}
    </chakra.div>
  );
}

/** 追加した列ルールを `表.列` のチップ + 規則の種類のバッジ + 内容で並べる。 */
export function CloneRuleRow({ rule, action }: { rule: CloneColumnRule; action: ReactNode }) {
  const t = useT();
  const kind =
    rule.rule.kind === "expression"
      ? t("cloneRowsKindExpressionShort")
      : rule.rule.value === null
        ? t("cloneRowsKindNull")
        : t("cloneRowsKindValueShort");
  return (
    <chakra.div display="flex" alignItems="center" gap="2" fontSize="sm" data-testid="clone-rule">
      <ToneChip tone="accent" mono>
        {`${rule.table}.${rule.column}`}
      </ToneChip>
      <ToneChip tone={rule.rule.kind === "expression" ? "info" : "success"} testId="clone-rule-kind">
        {kind}
      </ToneChip>
      <chakra.span fontFamily="mono" flex="1" minW="0" wordBreak="break-all">
        {describeRule(rule)}
      </chakra.span>
      {action}
    </chakra.div>
  );
}
