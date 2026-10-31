import { useMemo } from "react";
import { useT } from "../i18n";
import { TEXT_ENCODING_OPTIONS } from "../sqlFileIO";
import { ListboxSelect, type ListboxSelectProps } from "./ListboxSelect";

type Props = Omit<ListboxSelectProps, "options"> & {
  /** 先頭に「自動判定」(値は空文字) を出す。読み込み側で使い、保存側では出さない。 */
  allowAuto?: boolean;
};

/** 文字コード選択。ファイルを読む / 保存するモーダルで選択肢と自動判定の扱いを揃える。 */
export function TextEncodingSelect({ allowAuto = false, ...rest }: Props) {
  const t = useT();
  const options = useMemo(() => {
    const list = TEXT_ENCODING_OPTIONS.map((o) => ({ value: o.id as string, label: o.label }));
    return allowAuto ? [{ value: "", label: t("scriptEncodingAuto") }, ...list] : list;
  }, [allowAuto, t]);
  return <ListboxSelect {...rest} options={options} />;
}
