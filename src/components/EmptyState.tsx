import { Flex, Text } from "@chakra-ui/react";
import { Button } from "./ui";
import { Icon, type IconName } from "./Icon";

interface Props {
  /** Optional glyph shown above the title. */
  icon?: IconName;
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
 * 本コンポーネントは Chakra UI 導入の見本。スタイルは `app.*` トークン経由で
 * 既存の CSS 変数を参照するため、ライト/ダーク・アクセント色に自動追従する。
 */
export function EmptyState({ icon, title, description, action, compact = false }: Props) {
  return (
    <Flex
      direction="column"
      align={compact ? "flex-start" : "center"}
      justify="center"
      gap={compact ? "6px" : "var(--space-2)"}
      px={compact ? "16px" : "20px"}
      py={compact ? "20px" : "32px"}
      textAlign={compact ? "left" : "center"}
    >
      {icon && (
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
      )}
      <Text
        fontWeight="600"
        color="app.text"
        fontSize={compact ? "var(--text-sm)" : "var(--text-md)"}
      >
        {title}
      </Text>
      {description && (
        <Text
          color="app.textMuted"
          fontSize="var(--text-sm)"
          lineHeight="1.5"
          maxW={compact ? "none" : "34ch"}
        >
          {description}
        </Text>
      )}
      {action && (
        <Button type="button" variant="primary" onClick={action.onClick} mt="var(--space-1)">
          {action.label}
        </Button>
      )}
    </Flex>
  );
}
