import type { ComponentProps } from "react";
import { useT } from "../i18n";
import { TEXT_ENCODING_OPTIONS } from "../sqlFileIO";
import { Select } from "./ui";

type Props = Omit<ComponentProps<typeof Select>, "children"> & {
  /** 先頭に「自動判定」(値は空文字) を出す。読み込み側で使い、保存側では出さない。 */
  allowAuto?: boolean;
};

/** 文字コード選択。ファイルを読む / 保存するモーダルで選択肢と自動判定の扱いを揃える。 */
export function TextEncodingSelect({ allowAuto = false, ...rest }: Props) {
  const t = useT();
  return (
    <Select {...rest}>
      {allowAuto && <option value="">{t("scriptEncodingAuto")}</option>}
      {TEXT_ENCODING_OPTIONS.map((o) => (
        <option key={o.id} value={o.id}>
          {o.label}
        </option>
      ))}
    </Select>
  );
}
