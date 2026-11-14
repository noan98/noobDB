import { chakra } from "@chakra-ui/react";
import { semanticColorToken, type SemanticRole } from "../semanticColors";

/** 小さな状態チップの色調。意味色 4 段 + アクセント。 */
export type ChipTone = SemanticRole | "accent" | "muted";

/**
 * 辿り図のノード・対応表・列ルールで使う小さなチップ。意味色は `semanticColors.ts` の subtle / border / text。
 * `accent` は `app.accentHighlight` の淡い地に通常文字色。色だけに頼らず、必ず文言を持つ。
 */
export function ToneChip({
  tone,
  children,
  mono = false,
  shrink = false,
  testId,
  pill = false,
  ariaLabel,
}: {
  tone: ChipTone;
  children: string;
  mono?: boolean;
  /** 長い文言を省略表示へ縮める (既定は縮まない)。 */
  shrink?: boolean;
  testId?: string;
  pill?: boolean;
  ariaLabel?: string;
}) {
  const accent = tone === "accent";
  const muted = tone === "muted";
  return (
    <chakra.span
      display="inline-flex"
      alignItems="center"
      minW="0"
      flexShrink={shrink ? 1 : 0}
      px="1.5"
      textStyle="caption"
      fontFamily={mono ? "mono" : undefined}
      whiteSpace="nowrap"
      border="1px solid"
      bg={accent ? "app.accentHighlight" : muted ? "app.bgInput" : semanticColorToken(tone, "subtle")}
      color={accent ? "app.text" : muted ? "app.textMuted" : semanticColorToken(tone, "text")}
      borderColor={accent ? "app.accent" : muted ? "app.border" : semanticColorToken(tone, "border")}
      borderRadius={pill ? "pill" : "sm"}
      data-chip-tone={tone}
      data-testid={testId}
      aria-label={ariaLabel}
    >
      <chakra.span minW="0" truncate>
        {children}
      </chakra.span>
    </chakra.span>
  );
}
