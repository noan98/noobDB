import { quoteIfNeeded } from "./sqlJoinCompletion";

/**
 * スキーマツリーの列を SQL エディタへ挿入するテキストの整形 (#1352)。
 * クォートの要否・ドライバ別のクォート文字は `quoteIfNeeded` (→ `quoteIdentFor`) に委ね、
 * ここでは「列名だけ」「表.列」の組み立てだけを持つ。ドラッグ挿入 (#1414) も再利用する。
 */

/** 列名のみ (`id` / 必要なら `` `order` `` / `"UserId"`)。 */
export function columnInsertText(driver: string, column: string): string {
  return quoteIfNeeded(driver, column);
}

/** 修飾名 `表.列` (`users.id`)。データベース / スキーマ名は含めない (FROM 句側で解決される前提)。 */
export function qualifiedColumnInsertText(driver: string, table: string, column: string): string {
  return `${quoteIfNeeded(driver, table)}.${quoteIfNeeded(driver, column)}`;
}
