import { chakra, Flex } from "@chakra-ui/react";
import { type ComponentProps } from "react";
import { Spinner } from "./Spinner";
import { Button, PressableButton } from "./ui";

/**
 * 非同期操作向けのインラインスピナー付きボタン (#538)。
 *
 * `loading` が true のとき:
 *   - ボタン内にスピナー (小サイズ) を表示しラベルを保持
 *   - `disabled` + `aria-busy` を自動付与して二重発火を防ぐ
 *   - スピナーは既存 `Spinner.tsx` の方針に従い `prefers-reduced-motion` を
 *     尊重する (App.css に `@media (prefers-reduced-motion)` で回転を静止させる
 *     ルールが既に定義されている)
 *
 * `loading` 中にも "プライマリ背景上でスピナーが埋もれない" よう、primary /
 * success / danger / warning の各 variant ではスピナーのボーダー色を currentColor
 * 系に寄せる。secondary / ghost / default は既存の `app.borderStrong` /
 * `app.accent` で十分なため調整不要。
 *
 * `pressable` を併用すると、土台が `PressableButton` (#541) になり Motion spring の
 * press feedback も付く。主要 CTA (保存・実行など) ではこちらを使う。
 *
 * ### 使い方
 * ```tsx
 * <LoadingButton
 *   pressable
 *   variant="primary"
 *   loading={isSaving}
 *   onClick={handleSave}
 * >
 *   {t("formSave")}
 * </LoadingButton>
 * ```
 */
type ButtonProps = ComponentProps<typeof Button>;

const SOLID_VARIANTS = new Set(["primary", "success", "danger", "warning", "info"]);

export function LoadingButton({
  loading,
  children,
  disabled,
  variant,
  pressable,
  ...rest
}: ButtonProps & { loading?: boolean; pressable?: boolean }) {
  const isSolid = SOLID_VARIANTS.has(variant as string);
  const Comp = pressable ? PressableButton : Button;

  return (
    <Comp
      variant={variant}
      disabled={loading || disabled}
      aria-busy={loading ? true : undefined}
      {...rest}
    >
      {loading ? (
        <Flex as="span" display="inline-flex" align="center" gap="6px">
          {/* solid 背景の上では currentColor ベースで描画して見切れを防ぐ */}
          {isSolid ? (
            <chakra.span
              display="inline-flex"
              flexShrink={0}
              aria-hidden
              css={{
                "& > span": {
                  borderColor: "color-mix(in srgb, currentColor 35%, transparent)",
                  borderTopColor: "currentColor",
                },
              }}
            >
              <Spinner size={13} />
            </chakra.span>
          ) : (
            <Spinner size={13} />
          )}
          {children}
        </Flex>
      ) : (
        children
      )}
    </Comp>
  );
}
