import type { ComponentProps, ReactNode } from "react";
import { Box, chakra } from "@chakra-ui/react";
import { motion } from "motion/react";
import { transitions, variants } from "../motion";
import { semanticColorToken, type SemanticRole } from "../semanticColors";
import { Icon, ICON_SIZES, type IconName } from "./Icon";

/**
 * 状態を告げる帯 (成功 / 警告 / 危険 / 情報) の共有プリミティブ (#1145)。
 *
 * `semanticColors.ts` の 4 段トークンのうち、バナー用途で全テーマ AA を満たす
 * 組み合わせ (`subtle` 地 + `border` 枠 + `text` 文字) をここで 1 度だけ組み立てる。
 * #1145 以前は同じ帯を画面ごとに手組みしており、枠線だけ無彩色 (`ErrorNote`)・
 * 左ボーダーだけ (`DangerousQueryDialog`)・旧 2 段トークン (`app.bgError`) と
 * 最低 3 系統に分裂していた。
 *
 * - `tone` — 意味役割。先頭アイコンも役割から決まる (`CALLOUT_ICONS` が単一ソース)。
 *   アイコンを差し替えたいときは `icon`、出さないときは `icon={null}`。
 * - `title` — 太字の 1 行目。本文 (`children`) はその下に続く。
 * - `action` — 右端に置くボタンなど (再試行・詳細を開く …)。
 * - 出現は `variants.slideUp` + `transitions.enter`。`AnimatePresence` の直下に
 *   置けば退場も同じ語彙で動く。reduced-motion はルートの `MotionConfig` が抑制する。
 * - `role` は呼び出し側が決める (操作を止めるエラーは `"alert"`、結果の通知は
 *   `"status"`)。帯そのものは意味を押し付けない。
 * - 余白・文字サイズ・`gridColumn` などの Chakra スタイル props はそのまま渡せる
 *   (既定値を上書きする)。
 */

/** 役割 → 先頭アイコン。警告の三角と区別できるよう、危険 / 情報は円形に揃える。 */
export const CALLOUT_ICONS: Record<SemanticRole, IconName> = {
  success: "check",
  warning: "warning",
  danger: "alert-circle",
  info: "info",
};

// motion 用 props は Chakra のスタイルプロップに飲まれないよう forwardProps で
// 素通しする (`ConnectionForm` の旧 ResultBanner / `ActivityCenter` と同じパターン)。
const MotionCallout = chakra(motion.div, {}, {
  forwardProps: ["initial", "animate", "exit", "transition"],
});

type CalloutProps = Omit<ComponentProps<typeof MotionCallout>, "title"> & {
  tone: SemanticRole;
  title?: ReactNode;
  /** 既定は `CALLOUT_ICONS[tone]`。`null` でアイコンを出さない。 */
  icon?: IconName | null;
  action?: ReactNode;
  children?: ReactNode;
};

export function Callout({ tone, title, icon, action, children, ...rest }: CalloutProps) {
  const iconName = icon === undefined ? CALLOUT_ICONS[tone] : icon;
  return (
    <MotionCallout
      initial={variants.slideUp.initial}
      animate={variants.slideUp.animate}
      exit={variants.slideUp.exit}
      transition={transitions.enter}
      display="flex"
      alignItems="flex-start"
      gap="2"
      py="2"
      px="2.5"
      border="1px solid"
      borderColor={semanticColorToken(tone, "border")}
      bg={semanticColorToken(tone, "subtle")}
      color={semanticColorToken(tone, "text")}
      borderRadius="md"
      fontSize="sm"
      lineHeight="normal"
      data-tone={tone}
      {...rest}
    >
      {iconName && (
        // 1 行目のベースラインに揃える (行の高さとアイコンの差の半分)。
        <chakra.span aria-hidden display="inline-flex" flexShrink={0} mt="0.5">
          <Icon name={iconName} size={ICON_SIZES.sm} />
        </chakra.span>
      )}
      {/* 本文は flex にしない — 文字列とインライン要素が混ざる子が行ごとに割れるため。 */}
      <Box flex="1" minW={0}>
        {title && <chakra.div fontWeight={600}>{title}</chakra.div>}
        {children}
      </Box>
      {action && (
        <Box flexShrink={0} alignSelf="center">
          {action}
        </Box>
      )}
    </MotionCallout>
  );
}
