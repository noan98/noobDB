import { chakra } from "@chakra-ui/react";
import { useT } from "../i18n";
import { semanticColorToken } from "../semanticColors";
import { preflightTone, type PreflightTone } from "./preflight";
import type { PreflightResult } from "./usePreflight";

/**
 * 実行前の影響行数プリフライト (#737) のバッジ。エディタツールバーの実行ボタン付近に、
 * 「影響: 約 1,240 行」「影響: 全行」「影響: 推定不可」をゼロ操作で常時表示する。
 *
 * 表示専用の非対話要素 (`role="status"` + `aria-live="polite"`) で、クリック操作は
 * 持たない。色は影響規模で段階表示し (#664 の意味色トークン): 少数 = 中立 /
 * 多数 = 警告 / 全行 = 危険。数字は実行時点とズレうる推定である旨をツールチップに
 * 明記する。`result` が null (書き込み DML 以外・空・未接続) のときは何も描画しない。
 */
interface Props {
  result: PreflightResult | null;
}

const TONE_STYLE: Record<PreflightTone, { bg: string; border: string; fg: string }> = {
  neutral: { bg: "app.toolbar", border: "app.border", fg: "app.textMuted" },
  warning: {
    bg: semanticColorToken("warning", "subtle"),
    border: semanticColorToken("warning", "border"),
    fg: semanticColorToken("warning", "text"),
  },
  danger: {
    bg: semanticColorToken("danger", "subtle"),
    border: semanticColorToken("danger", "border"),
    fg: semanticColorToken("danger", "text"),
  },
};

export function PreflightBadge({ result }: Props) {
  const t = useT();
  if (!result) return null;

  let label: string;
  let tone: PreflightTone = "neutral";
  let title: string;

  if (result.status === "counting") {
    label = t("editorPreflightCounting");
    title = t("editorPreflightTooltip");
  } else if (result.status === "unestimable" || result.status === "error") {
    label = t("editorPreflightUnestimable");
    title = t("editorPreflightUnestimableTooltip");
  } else if (result.plan.allRows) {
    // 全行 (WHERE なし) は件数の有無に関わらず危険トーン。
    label =
      result.count !== null
        ? t("editorPreflightAllRows", { count: result.count.toLocaleString() })
        : t("editorPreflightAllRowsNoCount");
    tone = "danger";
    title = t("editorPreflightAllRowsTooltip");
  } else {
    const count = result.count ?? 0;
    label = t("editorPreflightImpact", { count: count.toLocaleString() });
    tone = preflightTone(false, result.count);
    title = t("editorPreflightTooltip");
  }

  const style = TONE_STYLE[tone];

  return (
    <chakra.span
      role="status"
      aria-live="polite"
      title={title}
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
      fontSize="xs"
      fontWeight={600}
      whiteSpace="nowrap"
      flexShrink={0}
    >
      <chakra.span display="inline-flex" flexShrink={0} aria-hidden>
        {/* 影響 = 対象行を表す簡素な行アイコン。 */}
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="3" width="12" height="10" rx="1.5" />
          <path d="M2 6.5h12M6 3v10" />
        </svg>
      </chakra.span>
      {label}
    </chakra.span>
  );
}
