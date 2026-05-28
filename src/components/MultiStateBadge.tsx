import { chakra } from "@chakra-ui/react";
import { AnimatePresence, motion } from "motion/react";
import { type ReactNode } from "react";

/**
 * 状態キーに応じてラベル・色・アイコンが `motion` でアニメーション遷移する Badge。
 *
 * 単一ボタンに「idle / running / disabled」のような複数の見え方を持たせたいときに、
 * Chakra Button では表現しきれない状態遷移 (背景色のクロスフェード + ラベル幅の
 * `layout` アニメーション + アイコンの `AnimatePresence` クロスフェード) を担う。
 *
 * `tone` は `theme.ts` の semantic token (`app.successBg` 等) に解決され、
 * ライト/ダーク・アクセント色追従はそのまま活きる。`prefers-reduced-motion: reduce`
 * は親の `<MotionConfig reducedMotion="user">` (`main.tsx`) が伝播するため、
 * 本コンポーネント側で個別対応は不要。
 *
 * アクセシビリティ:
 * - ルートは `<button>` 要素。`disabled` はそのまま属性として反映される。
 * - 状態が変わったことを SR にアナウンスするため `aria-live="polite"` を付与。
 */

export type BadgeTone = "neutral" | "success" | "warning" | "danger" | "info";

export interface BadgeState {
  label: string;
  tone: BadgeTone;
  icon?: ReactNode;
}

interface Props<S extends string> {
  state: S;
  states: Record<S, BadgeState>;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
  /** Optional keyboard label. Defaults to the active state's label. */
  "aria-label"?: string;
}

// tone → Chakra トークン (bg, fg, hoverBg, hoverFg, borderColor)
const TONE_TOKENS: Record<BadgeTone, {
  bg: string;
  fg: string;
  hoverBg: string;
  border: string;
}> = {
  neutral: {
    bg: "app.surface",
    fg: "app.text",
    hoverBg: "app.hover",
    border: "app.borderStrong",
  },
  success: {
    bg: "app.successBg",
    fg: "app.successFg",
    hoverBg: "app.successBgHover",
    border: "app.successBg",
  },
  warning: {
    bg: "app.warningBg",
    fg: "app.warningFg",
    hoverBg: "app.warningBgHover",
    border: "app.warningBg",
  },
  danger: {
    bg: "app.dangerBg",
    fg: "app.dangerFg",
    hoverBg: "app.dangerBgHover",
    border: "app.dangerBg",
  },
  info: {
    bg: "app.infoBg",
    fg: "app.infoFg",
    hoverBg: "app.infoBgHover",
    border: "app.infoBg",
  },
};

const MotionInner = chakra(
  motion.span,
  {},
  { forwardProps: ["transition", "layout", "initial", "animate", "exit"] },
);

const focusRing = "0 0 0 2px color-mix(in srgb, var(--accent) 25%, transparent)";

export function MultiStateBadge<S extends string>({
  state,
  states,
  onClick,
  disabled,
  title,
  "aria-label": ariaLabel,
}: Props<S>) {
  const current = states[state];
  const tone = TONE_TOKENS[current.tone];

  return (
    <chakra.button
      type="button"
      onClick={() => !disabled && onClick?.()}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel ?? current.label}
      aria-live="polite"
      display="inline-flex"
      alignItems="center"
      gap="6px"
      px="12px"
      py="6px"
      border="1px solid"
      borderColor={tone.border}
      bg={tone.bg}
      color={tone.fg}
      borderRadius="md"
      fontFamily="inherit"
      fontSize="inherit"
      cursor={disabled ? "not-allowed" : "pointer"}
      whiteSpace="nowrap"
      flexShrink={0}
      opacity={disabled ? 0.5 : 1}
      transitionProperty="background, border-color, color, box-shadow"
      transitionDuration="var(--dur-fast)"
      transitionTimingFunction="var(--ease)"
      _hover={!disabled ? { bg: tone.hoverBg, borderColor: tone.hoverBg } : undefined}
      _focusVisible={{ outline: "none", boxShadow: focusRing }}
      _active={!disabled ? { transform: "translateY(1px)" } : undefined}
    >
      <MotionInner
        layout
        transition={{ duration: 0.18, ease: [0.4, 0, 0.2, 1] }}
        display="inline-flex"
        alignItems="center"
        gap="6px"
      >
        {current.icon !== undefined && (
          <AnimatePresence mode="wait" initial={false}>
            <MotionInner
              key={`icon-${state}`}
              initial={{ opacity: 0, scale: 0.7 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.7 }}
              transition={{ duration: 0.15 }}
              display="inline-flex"
              flexShrink={0}
              aria-hidden
            >
              {current.icon}
            </MotionInner>
          </AnimatePresence>
        )}
        <AnimatePresence mode="wait" initial={false}>
          <MotionInner
            key={`label-${state}`}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.15 }}
            display="inline-block"
          >
            {current.label}
          </MotionInner>
        </AnimatePresence>
      </MotionInner>
    </chakra.button>
  );
}
