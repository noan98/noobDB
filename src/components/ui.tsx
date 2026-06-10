import { chakra } from "@chakra-ui/react";
import { type ComponentProps } from "react";
import { motion } from "motion/react";
import {
  buttonRecipe,
  checkboxRecipe,
  inputRecipe,
  selectRecipe,
  textareaRecipe,
} from "../theme";
import { springs } from "../motion";

/**
 * `theme.ts` の共通 recipe を `chakra(...)` ファクトリでラッパーコンポーネント化
 * したもの。`App.css` の className ベースの見た目を Chakra recipe + style props で
 * 置き換えるための共通 UI プリミティブで、後続のコンポーネント移行はここから
 * import して使う (素の見た目を毎回書かない)。recipe の variant / size はそのまま
 * props として受け取れる (例: `<Button variant="primary" size="sm">`)。
 */

export const Button = chakra("button", buttonRecipe);
export const Input = chakra("input", inputRecipe);
export const Select = chakra("select", selectRecipe);
export const Textarea = chakra("textarea", textareaRecipe);

const CheckboxRoot = chakra("input", checkboxRecipe);

/** ネイティブチェックボックス。`type="checkbox"` を常に強制する
 *  (`type` は受け取らず、spread の後ろに固定で付与する)。
 *
 *  「2 値の on/off 切替」として使われる場面では、より直感的な `Switch`
 *  (`./Switch.tsx`) を使うこと。Checkbox は一括選択 (SchemaCompare / History 等)
 *  など「複数項目から複数を選ぶ」場面に限定する。 */
export function Checkbox(props: Omit<ComponentProps<typeof CheckboxRoot>, "type">) {
  return <CheckboxRoot {...props} type="checkbox" />;
}

/**
 * press feedback つきの CTA ボタン (`#541`)。
 *
 * `Button` を `motion.span` で包み、ホバー時の微細 scale アップと押下時の
 * scale ダウンを `springs.gentle` で spring アニメーションする。
 *
 * ## 設計メモ
 *
 * - `motion.span` を外側に被せ、内側の `Button` は既存のままにする方式。
 *   `Button` 自体を `motion.create()` すると Chakra recipe の forwardProps
 *   管理が複雑になるため、thin-wrapper 方式を採用する。
 * - `buttonRecipe` の `"&:active:not(:disabled)": { transform: "translateY(1px)" }`
 *   と二重にならないよう、`PressableButton` に包まれたボタンは内側の `Button` の
 *   CSS active 変位を `data-pressable` 属性で打ち消す。
 * - `disabled` な場合は motion を無効化し、デフォルトの opacity/cursor に任せる。
 * - `prefers-reduced-motion: reduce` 時はルートの `<MotionConfig reducedMotion="user">`
 *   (`src/main.tsx`) により spring が即時化されるため、個別の分岐は不要。
 * - 対象は主要 CTA (primary / danger / warning / success) に限定し、密度の高い
 *   小ボタン群 (グリッドヘッダー操作等) には使わない。
 */
export function PressableButton({
  children,
  ...rest
}: ComponentProps<typeof Button>) {
  const disabled = !!rest.disabled;
  return (
    <motion.span
      style={{ display: "inline-flex" }}
      whileHover={!disabled ? { scale: 1.03 } : undefined}
      whileTap={!disabled ? { scale: 0.97 } : undefined}
      transition={springs.gentle}
    >
      {/* data-pressable を付与し、App.css / buttonRecipe の :active translateY を
          打ち消す。motion の whileTap がスケールで表現するため CSS 変位は不要。 */}
      <Button data-pressable="true" {...rest}>
        {children}
      </Button>
    </motion.span>
  );
}

export { Switch } from "./Switch";
