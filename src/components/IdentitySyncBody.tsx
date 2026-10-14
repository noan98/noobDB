import { useState } from "react";
import { useT } from "../i18n";
import { CodePreview, FieldError } from "./modalForm";
import { Switch } from "./ui";

interface Props {
  table: string;
  column: string;
  /** 「下げる」の可否ごとの実行 SQL。 */
  buildSql: (lower: boolean) => string | null;
  /** チェック状態を呼び出し側 (確認後の実行) へ伝える。 */
  onLowerChange: (lower: boolean) => void;
  /** 「下げる」切替を出すか。SQLite は SQL に影響しない (常に下げない) ので出さない。 */
  showLower: boolean;
  /** 「下げる」がオフのとき SQL を作れない理由 (MySQL で現在値を読めなかった場合)。 */
  unavailable?: string | null;
}

/** 採番同期の確認ダイアログ本文。既定は採番値を下げず、チェックで max+1 にそろえる。 */
export function IdentitySyncBody({ table, column, buildSql, onLowerChange, showLower, unavailable }: Props) {
  const t = useT();
  const [lower, setLower] = useState(false);
  return (
    <>
      {t("identitySyncConfirmBody", { table, column })}
      <br />
      <br />
      {showLower && (
        <Switch
          checked={lower}
          onChange={(next) => {
            setLower(next);
            onLowerChange(next);
          }}
          label={t("identitySyncLower")}
        />
      )}
      <br />
      <CodePreview minH="10">{buildSql(lower) ?? ""}</CodePreview>
      {unavailable && !lower && <FieldError>{unavailable}</FieldError>}
    </>
  );
}
