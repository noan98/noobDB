import { useState, type ComponentProps } from "react";
import { chakra } from "@chakra-ui/react";
import { useT } from "../i18n";
import { Icon, ICON_SIZES } from "./Icon";
import { Tooltip } from "./Tooltip";
import { Input } from "./ui";

/**
 * パスフレーズ入力欄 + 表示切替ボタン (#1529)。バックアップの書き出し / 取り込みで、
 * 入力内容を確認する手段を共通にする。ボタンは `aria-pressed` で状態を伝える。
 * 入力欄そのものの属性 (`id` / `ref` / `aria-describedby` など) はそのまま Input へ渡す。
 */
export function PassphraseInput(props: Omit<ComponentProps<typeof Input>, "type">) {
  const t = useT();
  const [shown, setShown] = useState(false);
  const label = shown ? t("passphraseHide") : t("passphraseShow");
  return (
    <chakra.div display="flex" alignItems="center" gap="1.5">
      <Input {...props} type={shown ? "text" : "password"} flex="1" minW="0" />
      <Tooltip label={label}>
        <chakra.button
          type="button"
          aria-label={label}
          aria-pressed={shown}
          disabled={props.disabled}
          onClick={() => setShown((v) => !v)}
          display="inline-flex"
          alignItems="center"
          justifyContent="center"
          boxSize="8"
          flexShrink={0}
          p="0"
          bg="transparent"
          border="none"
          borderRadius="sm"
          color="app.textMuted"
          cursor="pointer"
          _hover={{ bg: "app.hover", color: "app.text" }}
          _disabled={{ opacity: 0.5, cursor: "not-allowed" }}
          _focusVisible={{ outline: "none", boxShadow: "var(--focus-ring)" }}
        >
          <Icon name={shown ? "eye-off" : "eye"} size={ICON_SIZES.md} />
        </chakra.button>
      </Tooltip>
    </chakra.div>
  );
}
