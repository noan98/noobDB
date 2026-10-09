// スキーマツリーのノード (列など) を SQL エディタへ挿入する / コピーするときの
// テキスト整形 (#1352)。コンポーネントから切り離した純関数で、ドラッグ挿入 (#1414)
// からも再利用する。識別子のクォートは `quoteIdentFor` に必ず委ねる。

import { quoteIdentFor } from "./components/sqlDialect";

/** 列名のみ (`col`)。 */
export function columnInsertText(driver: string, column: string): string {
  return quoteIdentFor(driver, column);
}

/**
 * 修飾名 (`table.col`)。データベース / スキーマ名は含めない — 編集中のクエリの
 * FROM 句はたいてい表名だけで参照するため、`表.列` の形が最も貼り付けやすい。
 */
export function qualifiedColumnInsertText(driver: string, table: string, column: string): string {
  return `${quoteIdentFor(driver, table)}.${quoteIdentFor(driver, column)}`;
}
