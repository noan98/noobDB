import { useState } from "react";
import { useT } from "../i18n";
import { CodePreview } from "./modalForm";
import { Checkbox } from "./ui";

interface Props {
  table: string;
  column: string;
  /** 「下げる」の可否ごとの実行 SQL。 */
  buildSql: (lower: boolean) => string | null;
  /** チェック状態を呼び出し側 (確認後の実行) へ伝える。 */
  onLowerChange: (lower: boolean) => void;
}

/** 採番同期の確認ダイアログ本文。既定は採番値を下げず、チェックで max+1 にそろえる。 */
export function IdentitySyncBody({ table, column, buildSql, onLowerChange }: Props) {
  const t = useT();
  const [lower, setLower] = useState(false);
  return (
    <>
      {t("identitySyncConfirmBody", { table, column })}
      <br />
      <br />
      <Checkbox
        checked={lower}
        onChange={(e) => {
          setLower(e.target.checked);
          onLowerChange(e.target.checked);
        }}
      >
        {t("identitySyncLower")}
      </Checkbox>
      <br />
      <CodePreview minH="40px">{buildSql(lower) ?? ""}</CodePreview>
    </>
  );
}
