import { chakra } from "@chakra-ui/react";
import { useT } from "../i18n";
import { Icon, ICON_SIZES, ICON_STROKE } from "./Icon";
import type { PreflightTone } from "./preflight";
import { PREFLIGHT_TONE_STYLE } from "./PreflightBadge";
import { scanTone } from "./scanPreflight";
import { Tooltip } from "./Tooltip";
import type { ScanPreflightResult } from "./useScanPreflight";

/**
 * SELECT 実行前のスキャン行数 / フルスキャン警告プリフライト (#1508) のバッジ。
 * 影響行数バッジ (`PreflightBadge`) と同じ見た目・置き場で、「全表スキャンの可能性
 * (約 N 行)」「スキャン: 約 N 行」「スキャン: 推定不可」をゼロ操作で表示する。
 * 表示専用の非対話要素。`result` が null (SELECT 以外・オフ・EXPLAIN 失敗) のときは
 * 何も描画しない。
 */
interface Props {
  result: ScanPreflightResult | null;
}

export function ScanPreflightBadge({ result }: Props) {
  const t = useT();
  if (!result) return null;

  let label: string;
  let tone: PreflightTone = "neutral";
  let title: string;

  if (result.status === "estimating") {
    label = t("editorScanEstimating");
    title = t("editorScanTooltip");
  } else if (result.status === "unestimable" || !result.summary) {
    label = t("editorScanUnestimable");
    title = t("editorScanUnestimableTooltip");
  } else {
    const s = result.summary;
    tone = scanTone(s, result.cheapLimit);
    const fmt = (n: number | null) => (n !== null ? Math.round(n).toLocaleString() : null);
    if (s.fullScan) {
      // 全表スキャンの行数は全表スキャンのノードだけから取る。行数不明の全表スキャンが
      // 混ざるときは、他ノードの小さな数字で誤解させないよう行数を出さない。
      const count = s.unknownRowsFullScan ? null : fmt(s.fullScanRows);
      label = count !== null ? t("editorScanFullScanRows", { count }) : t("editorScanFullScan");
      title = t("editorScanFullScanTooltip", {
        tables: s.fullScanTables.length > 0 ? s.fullScanTables.join(", ") : "-",
      });
      if (result.cheapLimit) title = `${title} ${t("editorScanLimitedNote")}`;
    } else {
      const count = fmt(s.scanRows);
      label = count !== null ? t("editorScanRows", { count }) : t("editorScanIndexed");
      title = t("editorScanTooltip");
    }
  }

  const style = PREFLIGHT_TONE_STYLE[tone];
  return (
    <Tooltip label={title} focusableWrapper>
      <chakra.span
        role="status"
        aria-live="polite"
        display="inline-flex"
        alignItems="center"
        gap="1.5"
        px="2.5"
        py="1.5"
        border="1px solid"
        borderColor={style.border}
        bg={style.bg}
        color={style.fg}
        borderRadius="md"
        textStyle="overline"
        whiteSpace="nowrap"
        flexShrink={0}
      >
        <chakra.span display="inline-flex" flexShrink={0} aria-hidden>
          <Icon name="table" size={ICON_SIZES.sm} strokeWidth={ICON_STROKE.thin} />
        </chakra.span>
        {label}
      </chakra.span>
    </Tooltip>
  );
}
