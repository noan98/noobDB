// データ比較・テーブルタイムラプスが行の対応付けに使った識別子 (#1838) を、利用者に伝える注記へ変える。
// PK のときは当たり前なので注記を出さない (null)。

import type { RowKeyKind } from "./api/tauri";
import type { I18nKey } from "./i18n";

/** PK 以外の識別子を使ったときだけ、注記の i18n キーと差し込み値を返す。 */
export function rowKeyNote(
  kind: RowKeyKind | undefined,
  columns: readonly string[],
): { key: I18nKey; vars: { columns: string } } | null {
  switch (kind) {
    case "unique_key":
      return { key: "rowKeyUnique", vars: { columns: columns.join(", ") } };
    case "rowid":
      return { key: "rowKeyRowid", vars: { columns: columns.join(", ") } };
    default:
      return null;
  }
}
