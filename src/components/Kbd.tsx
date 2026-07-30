import { chakra, Flex } from "@chakra-ui/react";
import { type ComponentProps } from "react";
import { splitComboKeys } from "../shortcutKeys";

/**
 * 共有キーキャップ (kbd チップ) プリミティブ (#844)。
 *
 * `ShortcutCheatSheet` / `CommandPalette` (旧 `Hint`) / `ContextMenu` にほぼ同一の
 * インライン `chakra.kbd` 実装が重複していたのを 1 箇所に集約する。挙動は変更しない
 * 純粋なスタイル集約で、既存のテーマトークン (`app.border` / `app.surface` /
 * `app.textSecondary` / `app.textMuted`) をそのまま使う。
 *
 * - `tone="secondary"` (既定): 枠線 + 背景ありのチップ表示。`ShortcutCheatSheet` /
 *   `CommandPalette` の行末ヒントが使う見た目。
 * - `tone="muted"`: 枠線・背景・パディングなしの控えめな表示。`ContextMenu` の
 *   行内ショートカットヒントが使う見た目 (元々チップ化されていなかったため、
 *   `secondary` とは異なりパディング等を持たせない)。
 * - `splitCombo`: `formatCombo` の出力 (`"Cmd/Ctrl+Enter"`) のような `+` 区切りの
 *   コンボ文字列を、キーごとに個別のキーキャップとして並べて描く洗練表現。分割は
 *   `shortcutKeys.ts` の純関数 `splitComboKeys` (`shortcutKeys.test.ts` でテスト済み)
 *   に委譲する。現状はどの画面からも有効化しておらず (#844 は既存 3 箇所の見た目
 *   集約が主眼)、将来の個別採用に備えて用意するオプトインの表現。
 *
 * `tone` 由来のデフォルト以外のスタイル (danger 時の `color="inherit"`・
 * `disabled` 時の `opacity`・`ml`・`flexShrink` など呼び出し側固有の調整) は
 * Chakra の style props としてそのまま上書きできる。
 */

export type KbdTone = "secondary" | "muted";

export interface KbdProps extends Omit<ComponentProps<typeof chakra.kbd>, "children"> {
  /** 表示するキー/コンボ文字列 (例: `"Esc"`、`formatCombo` の出力)。 */
  children: string;
  tone?: KbdTone;
  /** `+` 区切りのコンボをキーごとに個別キャップへ分割して描画する。既定 false。 */
  splitCombo?: boolean;
}

const TONE_STYLE: Record<KbdTone, ComponentProps<typeof chakra.kbd>> = {
  secondary: {
    px: "1.5",
    py: "1px",
    borderRadius: "sm",
    borderWidth: "1px",
    borderColor: "app.border",
    bg: "app.surface",
    color: "app.textSecondary",
  },
  muted: {
    color: "app.textMuted",
  },
};

export function Kbd({ children, tone = "secondary", splitCombo = false, ...rest }: KbdProps) {
  const chipProps: ComponentProps<typeof chakra.kbd> = {
    fontSize: "xs",
    fontFamily: "inherit",
    whiteSpace: "nowrap",
    ...TONE_STYLE[tone],
    ...rest,
  };

  const keys = splitCombo ? splitComboKeys(children) : [children];
  if (keys.length <= 1) {
    return <chakra.kbd {...chipProps}>{children}</chakra.kbd>;
  }

  return (
    <Flex as="span" display="inline-flex" alignItems="center" gap="0.5">
      {keys.map((key, i) => (
        <chakra.kbd key={`${key}-${i}`} {...chipProps}>
          {key}
        </chakra.kbd>
      ))}
    </Flex>
  );
}
