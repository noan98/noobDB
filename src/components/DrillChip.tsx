import { Flex, chakra } from "@chakra-ui/react";
import { motion } from "motion/react";

import { useT } from "../i18n";
import { springs } from "../motion";
import type { DrillSource } from "./drillFilter";
import { Icon, ICON_SIZES } from "./Icon";
import { Button } from "./ui";

/**
 * ピボット / チャートから絞り込んで移ったグリッドの上に出す帯 (#2236)。
 * 「ピボットから絞り込み中: region=東京 × status=paid」と、元のビューへ戻る / 絞り込みを外す
 * 操作を持つ。`springs.snappy` で出入りする (reduced-motion はルートの `MotionConfig` が
 * transform を即時化し、不透明度の補間だけが残る)。`AnimatePresence` の直下に置いて使う。
 *
 * `count` は table タブのサーバ側ページングで、絞り込みが取得済みの行だけに効くことを
 * 明記するための件数 (ピボットの集計がそもそも取得済み行に対するクライアント集計のため)。
 */
export function DrillChip({
  source,
  summary,
  count,
  onBack,
  onClear,
}: {
  source: DrillSource;
  summary: string;
  count?: number;
  onBack: () => void;
  onClear: () => void;
}) {
  const t = useT();
  const sourceLabel = source === "pivot" ? t("drillSourcePivot") : t("drillSourceChart");
  const text =
    count === undefined
      ? t("drillChipLabel", { source: sourceLabel, summary })
      : t("drillChipLabelRange", { source: sourceLabel, summary, count });
  return (
    <motion.div
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={springs.snappy}
      style={{ flex: "none" }}
    >
      <Flex
        role="group"
        aria-label={t("drillChipAria", { source: sourceLabel })}
        data-testid="drill-chip"
        align="center"
        gap="2.5"
        px="3"
        py="1.5"
        borderBottomWidth="1px"
        borderBottomColor="app.border"
        bg="color-mix(in srgb, var(--accent) 8%, transparent)"
        fontSize="sm"
      >
        <Icon name="filter" size={ICON_SIZES.md} />
        <chakra.span color="app.text" minW={0} truncate>
          {text}
        </chakra.span>
        <chakra.span flex="1" />
        <Button type="button" variant="secondary" size="sm" onClick={onBack}>
          <Icon name="chevron-left" size={ICON_SIZES.md} />{" "}
          {source === "pivot" ? t("drillBackToPivot") : t("drillBackToChart")}
        </Button>
        <Button type="button" variant="secondary" size="sm" onClick={onClear}>
          <Icon name="close" size={ICON_SIZES.md} /> {t("drillClear")}
        </Button>
      </Flex>
    </motion.div>
  );
}
