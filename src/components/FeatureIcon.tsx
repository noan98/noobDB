import { Flex } from "@chakra-ui/react";
import { AnimatePresence, motion } from "motion/react";
import { transitions, variants } from "../motion";
import { Icon, ICON_SIZES, ICON_STROKE, type IconName } from "./Icon";

/** タイルの寸法。`FONT_SCALE` に追従させるため calc で組む (px 直値はフォント拡大に取り残される)。 */
const TILE_SIZES = {
  sm: "calc(34px * var(--font-scale))",
  md: "calc(40px * var(--font-scale))",
  lg: "calc(56px * var(--font-scale))",
} as const;

/** タイルの中のアイコンサイズ。タイルが大きいほど少しだけ大きくする。 */
const GLYPH_SIZES = {
  sm: ICON_SIZES.lg,
  md: ICON_SIZES.lg,
  lg: ICON_SIZES["2xl"],
} as const;

export type FeatureIconSize = keyof typeof TILE_SIZES;
export type FeatureIconTone = "accent" | "muted";

interface Props {
  icon: IconName;
  /** sm=34px (コンパクト空状態・ツアー) / md=40px (ウェルカムカード) / lg=56px (空状態)。既定 `md`。 */
  size?: FeatureIconSize;
  /** accent=アクセント淡色地 + アクセント色 (既定) / muted=無彩色。控えめにしたい面だけ muted。 */
  tone?: FeatureIconTone;
  /** 指定すると値が変わるたびにアイコンをクロスフェードする (ツアーのステップ切替, #819)。 */
  transitionKey?: string | number;
}

/**
 * フィーチャーアイコンタイル (#1954)。「塗りつぶし角丸スクエアの中にアイコンを置き、
 * 見出しの上に添える」モチーフの単一ソース。`EmptyState` / `WelcomeView` /
 * `OnboardingTour` が共有し、寸法・角丸・色味を揃える。装飾なので常に `aria-hidden`。
 * 既定の `accent` は `--accent-subtle` (アクセント追従の淡色地) + `app.accent` で、
 * 空状態にも「生きた」第一印象を持たせる。
 */
export function FeatureIcon({ icon, size = "md", tone = "accent", transitionKey }: Props) {
  const glyph = <Icon name={icon} size={GLYPH_SIZES[size]} strokeWidth={ICON_STROKE.thin} />;
  return (
    <Flex
      as="span"
      aria-hidden
      align="center"
      justify="center"
      flexShrink={0}
      boxSize={TILE_SIZES[size]}
      rounded="lg"
      overflow="hidden"
      bg={tone === "accent" ? "var(--accent-subtle)" : "app.surfaceMuted"}
      color={tone === "accent" ? "app.accent" : "app.textSecondary"}
      data-feature-icon={size}
      data-tone={tone}
    >
      {transitionKey === undefined ? (
        glyph
      ) : (
        // key をステップ番号にして毎回入れ替え、initial={false} で初回マウント時のフェード
        // インは抑える。reduced-motion はルートの MotionConfig が自動吸収。
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={transitionKey}
            initial={variants.fade.initial}
            animate={variants.fade.animate}
            exit={variants.fade.exit}
            transition={transitions.crossfade}
            style={{ display: "inline-flex" }}
          >
            {glyph}
          </motion.span>
        </AnimatePresence>
      )}
    </Flex>
  );
}
