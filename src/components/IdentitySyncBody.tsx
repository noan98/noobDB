import { useState } from "react";
import { chakra } from "@chakra-ui/react";
import { useT } from "../i18n";
import { Callout } from "./Callout";
import { identitySyncPreview } from "./identitySync";
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
  /**
   * 同期前後の採番値の表示用の素の値 (#1626)。`maxRaw` は実データの最大値、`currentRaw` は現在の採番値
   * (`identitySyncPreview` を参照)。渡さない / 読めなければ「同期後の次の値」の行を出さない。
   */
  stats?: { driver: string; maxRaw: unknown; currentRaw: unknown } | null;
}

/** 採番同期の確認ダイアログ本文。既定は採番値を下げず、チェックで max+1 にそろえる。 */
export function IdentitySyncBody({
  table,
  column,
  buildSql,
  onLowerChange,
  showLower,
  unavailable,
  stats,
}: Props) {
  const t = useT();
  const [lower, setLower] = useState(false);
  const preview = stats ? identitySyncPreview({ ...stats, lower }) : null;
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
      {preview && preview.nextAfter !== null && (
        <>
          <chakra.div fontWeight={600} data-testid="identity-sync-next">
            {t("identitySyncNextValue", {
              before: preview.currentNext ?? "?",
              after: preview.nextAfter,
              max: preview.max ?? "?",
            })}
          </chakra.div>
          {preview.decreases && (
            <Callout tone="warning" role="status">
              {t("identitySyncDecreases")}
            </Callout>
          )}
          <br />
        </>
      )}
      <CodePreview minH="10">{buildSql(lower) ?? ""}</CodePreview>
      {unavailable && !lower && <FieldError>{unavailable}</FieldError>}
    </>
  );
}
