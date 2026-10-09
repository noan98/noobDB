// スキーマツリーのノード (列など) を SQL エディタへ挿入する / コピーするときの
// テキスト整形 (#1352)。コンポーネントから切り離した純関数で、ドラッグ挿入 (#1414)
// からも再利用する。識別子は `quoteIfNeeded` に委ね、素の識別子 (`id`, `users.id`) は
// クォートせず、大文字を含む PG 名・予約語・記号/空白入りの名前だけクォートする。

import { quoteIfNeeded } from "./components/sqlJoinCompletion";

/** 列名のみ (`col`)。 */
export function columnInsertText(driver: string, column: string): string {
  return quoteIfNeeded(driver, column);
}

/**
 * 修飾名 (`table.col`)。データベース / スキーマ名は含めない — 編集中のクエリの
 * FROM 句はたいてい表名だけで参照するため、`表.列` の形が最も貼り付けやすい。
 */
export function qualifiedColumnInsertText(driver: string, table: string, column: string): string {
  return `${quoteIfNeeded(driver, table)}.${quoteIfNeeded(driver, column)}`;
}

/**
 * 修飾テーブル名 (`db.table`)。SQLite は名前空間が 1 つ ("main") なので `table` のみ。
 * 編集中の FROM 句へそのまま貼れる形 (ドラッグ挿入 #1414)。
 */
export function tableInsertText(driver: string, database: string, table: string): string {
  if (driver === "sqlite") return quoteIfNeeded(driver, table);
  return `${quoteIfNeeded(driver, database)}.${quoteIfNeeded(driver, table)}`;
}
