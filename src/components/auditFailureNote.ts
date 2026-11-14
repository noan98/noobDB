import type { I18nKey } from "../i18n";

/**
 * 監査トリガーの実行に失敗したときにトーストへ足す注記のキー (#2335)。
 * MySQL は DDL が暗黙コミットされるので、新規作成でも監査表だけが残りうる (再生成・削除ではトリガーが外れたまま)。
 * MySQL 以外は 1 つのトランザクションで巻き戻るので注記は不要。
 */
export function auditFailureNoteKey(driver: string | undefined, mode: string): I18nKey | null {
  if (driver !== "mysql") return null;
  return mode === "create" ? "auditMysqlPartialCreateNote" : "auditMysqlPartialNote";
}
