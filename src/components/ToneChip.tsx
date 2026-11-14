import { chakra } from "@chakra-ui/react";
import { semanticColorToken, type SemanticRole } from "../semanticColors";

/** 小さな状態チップの色調。意味色 4 段 + アクセント。 */
export type ChipTone = SemanticRole | "accent";

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
}: {
  tone: ChipTone;
  children: string;
  mono?: boolean;
  /** 長い文言を省略表示へ縮める (既定は縮まない)。 */
  shrink?: boolean;
  testId?: string;
}) {
  const accent = tone === "accent";
  return (
    <chakra.span
      display="inline-flex"
      alignItems="center"
      minW="0"
      flexShrink={shrink ? 1 : 0}
      px="1.5"
      textStyle="caption"
      fontFamily={mono ? "mono" : undefined}
      borderRadius="sm"
      whiteSpace="nowrap"
      border="1px solid"
      bg={accent ? "app.accentHighlight" : semanticColorToken(tone, "subtle")}
      color={accent ? "app.text" : semanticColorToken(tone, "text")}
      borderColor={accent ? "app.accent" : semanticColorToken(tone, "border")}
      data-chip-tone={tone}
      data-testid={testId}
    >
      <chakra.span minW="0" truncate>
        {children}
      </chakra.span>
    </chakra.span>
  );
}
