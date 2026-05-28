import { chakra } from "@chakra-ui/react";
import { type ComponentProps } from "react";
import {
  buttonRecipe,
  checkboxRecipe,
  inputRecipe,
  selectRecipe,
  textareaRecipe,
} from "../theme";

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

export { Switch } from "./Switch";
