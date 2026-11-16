import { useT } from "../i18n";
import { identLimit } from "./sqlDialect";
import { FieldError } from "./modalForm";

/**
 * 識別子 (テーブル名・列名) が方言の上限を超えているときのエラー (#2384)。MySQL は ERROR 1059 で失敗し、
 * PostgreSQL は成功扱いのまま名前だけを黙って切り詰めるので、確定する前に止める。`names` が空なら何も出さない。
 */
export function IdentLengthError({ driver, names }: { driver: string; names: string[] }) {
  const t = useT();
  const lim = identLimit(driver);
  if (!lim || names.length === 0) return null;
  return (
    <FieldError data-testid="ident-too-long">
      {t(lim.bytes ? "identTooLongBytes" : "identTooLongChars", {
        names: names.join(", "),
        limit: lim.limit,
      })}
    </FieldError>
  );
}
