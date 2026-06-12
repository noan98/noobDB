import type { ReactNode } from "react";
import { chakra, Flex, Text } from "@chakra-ui/react";
import { motion } from "motion/react";
import { transitions } from "../motion";
import { PressableButton } from "./ui";
import { Icon, type IconName } from "./Icon";

/** ルートを motion 化するラッパー。`transition` を motion へ転送する
 *  (`TabBar` / `Modal` と同方式)。`Flex` のショートハンド (direction/align/justify)
 *  は使えないため、対応する style プロップ名で同じレイアウトを再現する。 */
const MotionRoot = chakra(motion.div, {}, { forwardProps: ["transition"] });

interface Props {
  /** Optional glyph shown above the title. */
  icon?: IconName;
  /**
   * Optional richer inline-SVG illustration shown above the title.
   * Takes precedence over `icon` for prominent onboarding/empty states.
   * Ignored in `compact` layout, which keeps the small icon badge.
   */
  illustration?: ReactNode;
  title: string;
  /** Optional supporting line under the title. */
  description?: string;
  /** Optional primary call-to-action button. */
  action?: { label: string; onClick: () => void };
  /** Tighter layout for inline use (e.g. inside the result grid body). */
  compact?: boolean;
}

/**
 * Shared empty / onboarding state: an optional icon, a short title, an optional
 * description, and an optional primary action. Used across the connection list,
 * editor pane, snippet/history panels and the result grid so "nothing here yet"
 * reads consistently and points the user at the next step.
 *
 * スタイルは `app.*` トークン経由で
 * 既存の CSS 変数を参照するため、ライト/ダーク・アクセント色に自動追従する。
 */
export function EmptyState({
  icon,
  illustration,
  title,
  description,
  action,
  compact = false,
}: Props) {
  return (
    // 一時表示 (空/オンボーディング) の控えめな fade-in。マウント時のみ動かす
    // enter で、reduced-motion 時は MotionConfig により即時化される。
    <MotionRoot
      display="flex"
      flexDirection="column"
      alignItems={compact ? "flex-start" : "center"}
      justifyContent="center"
      gap={compact ? "6px" : "2"}
      px={compact ? "16px" : "20px"}
      py={compact ? "20px" : "32px"}
      textAlign={compact ? "left" : "center"}
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={transitions.enter}
    >
      {illustration && !compact ? (
        // リッチなイラスト (オンボーディング/主要空状態)。軽い scale-in を添える。
        <motion.div
          aria-hidden
          style={{ marginBottom: "var(--space-1)" }}
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={transitions.emphasized}
        >
          {illustration}
        </motion.div>
      ) : (
        icon && (
          <Flex
            as="span"
            aria-hidden
            align="center"
            justify="center"
            boxSize={compact ? "34px" : "56px"}
            rounded="lg"
            bg="app.surfaceMuted"
            color="app.textSecondary"
          >
            <Icon name={icon} size={compact ? 22 : 32} strokeWidth={1.5} />
          </Flex>
        )
      )}
      <Text
        fontWeight="600"
        color="app.text"
        fontSize={compact ? "sm" : "md"}
      >
        {title}
      </Text>
      {description && (
        <Text
          color="app.textMuted"
          fontSize="sm"
          lineHeight="1.5"
          maxW={compact ? "none" : "34ch"}
        >
          {description}
        </Text>
      )}
      {action && (
        <PressableButton type="button" variant="primary" onClick={action.onClick} mt="1">
          {action.label}
        </PressableButton>
      )}
    </MotionRoot>
  );
}
