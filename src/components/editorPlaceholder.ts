// 空の SQL エディタに出すゴースト・プレースホルダの文面 (#1785)。
//
// CodeMirror の `placeholder` はドキュメントが空のときだけ描画されるので、入力すれば消え、
// AI インライン補完 (inlineCompleteExtension) とも競合しない。ここは文面だけを作る純関数で、
// 表示語 (コメント行) は呼び出し側が i18n から渡す。

import { quoteIdentFor } from "./sqlDialect";

/** 例示に使うテーブル名を選ぶ。選択中 > スキーマ先頭 > なし (汎用例示)。 */
export function pickExampleTable(
  active: { name: string } | null | undefined,
  schemaTable: { name: string } | null | undefined,
  tables: readonly { name: string }[] | null | undefined,
): string | null {
  return active?.name || schemaTable?.name || tables?.[0]?.name || null;
}

/**
 * 例示 SQL + 実行ショートカットのコメント行。テーブル名が分かれば実名 (ドライバに合わせて
 * 引用)、無ければ汎用のプレースホルダ語 `genericTable` を使う。
 */
export function buildEditorPlaceholder(opts: {
  driver: string;
  table: string | null;
  genericTable: string;
  /** 例: `-- Ctrl+Enter で実行` のコメント全文 (呼び出し側で i18n 解決済み)。 */
  hint: string;
}): string {
  const target = opts.table ? quoteIdentFor(opts.driver, opts.table) : opts.genericTable;
  return `SELECT * FROM ${target} LIMIT 100;\n${opts.hint}`;
}
