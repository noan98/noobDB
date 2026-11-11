import type { CSSProperties, ReactElement } from "react";
import { chakra } from "@chakra-ui/react";
import { AnimatePresence, MotionConfig, motion, useReducedMotionConfig } from "motion/react";
import { rampStops, readableInk, sampleRamp, SEQUENTIAL_RAMPS, useIsDarkTheme } from "../colorScale";
import { useT } from "../i18n";
import { transitions, variants } from "../motion";
import { Icon, ICON_SIZES } from "./Icon";
import {
  type PartitionRibbon as Ribbon,
  type RibbonGhost,
  type RibbonSegment,
  HOT_FACTOR,
} from "./partitionRibbon";
import { formatBytes, formatRowCount } from "./tableSize";
import { Tooltip } from "./Tooltip";

/**
 * パーティション構成の「範囲の帯」(#2238)。構造パネルの一覧の上と、追加ダイアログ (`compact` + `ghost`) に置く。
 *
 * - 各パーティションを等幅のセグメントで並べ、濃さ = サイズ (`colorScale.ts` の sequential ランプ)。
 *   DEFAULT は斜線 + 破線、MAXVALUE は二重線 + 文言、隙間は破線の細い印 + 「隙間」の文言で、色以外でも区別できる。
 * - 偏り (平均の `HOT_FACTOR` 倍以上) のセグメントには ▲ を付ける。サブパーティションは 2 段目の細い帯。
 * - `activeId` / `onActive` で一覧の行と相互にハイライトする (ホバー / フォーカス)。
 * - ゴーストは破線のセグメントで、`layout` アニメーションで差し込む (reduced-motion では即時)。
 */

const MotionItem = chakra(
  motion.div,
  {},
  { forwardProps: ["layout", "variants", "initial", "animate", "exit"] },
);

interface Props {
  ribbon: Ribbon;
  ariaLabel: string;
  compact?: boolean;
  ghost?: RibbonGhost | null;
  activeId?: string | null;
  onActive?: (id: string | null) => void;
}

export function PartitionRibbon({
  ribbon,
  ariaLabel,
  compact = false,
  ghost = null,
  activeId = null,
  onActive,
}: Props) {
  const t = useT();
  const reduced = useReducedMotionConfig() ?? false;
  const stops = rampStops(SEQUENTIAL_RAMPS.teal, useIsDarkTheme());

  const heatStyle = (heat: number | null): CSSProperties | undefined => {
    if (heat === null) return undefined;
    const bg = sampleRamp(heat, stops);
    return { backgroundColor: bg, color: readableInk(bg) };
  };

  const noteOf = (seg: RibbonSegment): string | null =>
    ghost?.splitId === seg.id
      ? t("partitionRibbonReorganize")
      : ghost?.scanId === seg.id
        ? t("partitionRibbonScan")
        : null;

  const describe = (seg: RibbonSegment): string => {
    const parts = [seg.name || t("partitionRibbonEmptySlot"), seg.label];
    if (seg.sizeBytes !== null) parts.push(formatBytes(seg.sizeBytes));
    if (seg.rows !== null) parts.push(`${formatRowCount(seg.rows)} ${t("structurePartitionRows")}`);
    if (seg.sizeShare !== null)
      parts.push(t("partitionRibbonShare", { percent: Math.round(seg.sizeShare * 100) }));
    if (seg.hot) parts.push(t("partitionRibbonHotTip", { factor: HOT_FACTOR }));
    return parts.join(" / ");
  };

  const ghostEls = ghost
    ? ghost.items.map((it) => (
        <MotionItem
          key={`ghost:${it.key}`}
          layout="position"
          variants={variants.fade}
          initial="initial"
          animate="animate"
          exit="exit"
          className="pr-ribbon-item"
          data-testid="partition-ribbon-ghost"
        >
          <div
            className="pr-ghost"
            role="listitem"
            aria-label={t("partitionRibbonGhostAria", { label: it.label || t("partitionRibbonGhost") })}
          >
            {it.label || t("partitionRibbonGhost")}
          </div>
        </MotionItem>
      ))
    : [];

  const segmentEl = (seg: RibbonSegment) => {
    const active = activeId === seg.id;
    const note = noteOf(seg);
    return (
      <MotionItem
        key={seg.id}
        layout="position"
        className="pr-ribbon-item"
        data-testid="partition-ribbon-item"
      >
        <Tooltip label={describe(seg)}>
          <div
            className="pr-seg"
            role="listitem"
            tabIndex={seg.kind === "hashEmpty" ? -1 : 0}
            aria-label={describe(seg)}
            data-segment-id={seg.id}
            data-kind={seg.kind}
            data-active={active}
            data-note={note ?? undefined}
            data-hot={seg.hot}
            style={seg.kind === "hashEmpty" ? undefined : heatStyle(seg.heat)}
            onMouseEnter={() => onActive?.(seg.id)}
            onMouseLeave={() => onActive?.(null)}
            onFocus={() => onActive?.(seg.id)}
            onBlur={() => onActive?.(null)}
          >
            <span className="pr-seg-name">{seg.name || seg.label}</span>
            {!compact && seg.name !== "" && <span className="pr-seg-label">{seg.label}</span>}
            {seg.kind === "hashEmpty" && !compact && (
              <span className="pr-seg-label">{t("partitionRibbonEmptySlot")}</span>
            )}
            {note && <span className="pr-seg-note">{note}</span>}
            {seg.hot && (
              <span className="pr-seg-hot" aria-hidden="true">
                ▲
              </span>
            )}
          </div>
        </Tooltip>
        {seg.subs.length > 0 && (
          <div className="pr-subs" role="list" aria-label={t("partitionRibbonSubs", { partition: seg.name })}>
            {seg.subs.map((s) => (
              <div
                key={s.id}
                className="pr-sub"
                role="listitem"
                aria-label={`${s.name}: ${s.label}`}
                data-active={activeId === s.id}
                style={heatStyle(s.heat)}
                onMouseEnter={() => onActive?.(s.id)}
                onMouseLeave={() => onActive?.(null)}
              />
            ))}
          </div>
        )}
      </MotionItem>
    );
  };

  const children: ReactElement[] = [];
  ribbon.segments.forEach((seg, i) => {
    if (ghost && ghost.index === i) children.push(...ghostEls);
    if (seg.gapBefore) {
      children.push(
        <chakra.span
          key={`gap:${seg.id}`}
          className="pr-gap"
          role="listitem"
          aria-label={t("partitionRibbonGapAria")}
          data-testid="partition-ribbon-gap"
        >
          <Icon name="warning" size={ICON_SIZES.sm} />
        </chakra.span>,
      );
    }
    if (ghost?.replaces !== seg.id) children.push(segmentEl(seg));
  });
  if (ghost && ghost.index >= ribbon.segments.length) children.push(...ghostEls);

  return (
    <MotionConfig transition={reduced ? { duration: 0 } : transitions.layout}>
      <div
        className="pr-ribbon"
        role="list"
        aria-label={ariaLabel}
        data-compact={compact}
        data-testid="partition-ribbon"
      >
        <AnimatePresence initial={false}>{children}</AnimatePresence>
      </div>
      {!compact && (
        <chakra.div textStyle="caption" color="app.textMuted">
          {t("partitionRibbonLegend")}
        </chakra.div>
      )}
    </MotionConfig>
  );
}
