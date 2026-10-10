import { chakra, Flex } from "@chakra-ui/react";
import { useAiKeyKnown, useAiKeyPresent } from "../ai/aiKeyStore";
import { requestOpenAiSettings } from "../ai/aiSettingsNav";
import { useT } from "../i18n";
import { setAiHideSetupHint, useSettings } from "../settings";
import { Icon, ICON_SIZES } from "./Icon";
import { Tooltip } from "./Tooltip";
import { Button } from "./ui";

/**
 * AI が無効 (設定オフ / API キー未登録) のときだけ出す、控えめな案内 1 行 (#1475)。
 * 「AI で解説 (設定で有効化)」を押すと AI 設定を開く。何も送信しない。
 * 「今後表示しない」は設定 (`ai.hideSetupHint`) に保存し、AI 設定画面から戻せる。
 * AI が使えるとき・非表示設定のとき・キーの有無が未確定のときは何も描かない。
 * 各入口では AI 無効の分岐 (`return null`) の代わりに `<AiSetupHint label=... />` と書く。
 */
export function AiSetupHint({ label }: { label?: string }) {
  const t = useT();
  const ai = useSettings().ai;
  const hasKey = useAiKeyPresent();
  const keyKnown = useAiKeyKnown();
  if (ai.hideSetupHint) return null;
  // 有効化済みでもキー取得前は「未登録」と断定できないので、確定するまで出さない。
  const unavailable = !ai.enabled || (keyKnown && !hasKey);
  if (!unavailable) return null;
  return (
    <Flex
      align="center"
      gap="2"
      px="3.5"
      py="1"
      textStyle="caption"
      data-testid="ai-setup-hint"
    >
      <Tooltip label={t("aiSetupHintTooltip")}>
        <Button type="button" variant="ghost" size="sm" onClick={requestOpenAiSettings}>
          <Icon name="sparkles" size={ICON_SIZES.sm} />
          <chakra.span>{label ?? t("aiSetupHintLabel")}</chakra.span>
        </Button>
      </Tooltip>
      <Button type="button" variant="ghost" size="sm" onClick={() => setAiHideSetupHint(true)}>
        {t("aiSetupHintDismiss")}
      </Button>
    </Flex>
  );
}
