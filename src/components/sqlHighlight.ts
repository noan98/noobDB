// 読み取り専用の SQL 表示 (Ask Agent の提案 SQL など) 向けの軽量シンタックスハイライト。
//
// 編集しない表示のために CodeMirror の EditorView を立ち上げるのは重いので、エディタと同じ
// lang-sql のパーサで構文木だけを作り、`highlightCode` でトークンごとの区切りに分ける。
// 色はエディタ (`QueryEditor` の `noobDBHighlightStyle`) と同じ `--syntax-*` 変数を使うので、
// 設定画面のシンタックス配色とテーマに追従する。

import { sql as sqlLang } from "@codemirror/lang-sql";
import { highlightCode, tagHighlighter, tags } from "@lezer/highlight";
import { codeMirrorSqlDialectFor } from "./sqlDialect";

/** 1 区切り。`kind` が null の部分は通常の文字色。改行は `text: "\n"` の区切りとして入る。 */
export interface SqlHighlightSegment {
  text: string;
  kind: SqlTokenKind | null;
}

export type SqlTokenKind = "keyword" | "string" | "number" | "comment" | "function" | "operator";

const highlighter = tagHighlighter([
  { tag: tags.keyword, class: "keyword" },
  { tag: [tags.string, tags.special(tags.string)], class: "string" },
  { tag: [tags.number, tags.bool, tags.null], class: "number" },
  { tag: [tags.lineComment, tags.blockComment, tags.docComment], class: "comment" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], class: "function" },
  { tag: tags.operator, class: "operator" },
]);

/** トークンの種類から、エディタと同じ配色の CSS 変数を返す。 */
export const SQL_TOKEN_STYLE: Record<SqlTokenKind, { color: string; fontWeight?: string; fontStyle?: string }> = {
  keyword: { color: "var(--syntax-keyword)", fontWeight: "bold" },
  string: { color: "var(--syntax-string)" },
  number: { color: "var(--syntax-number)" },
  comment: { color: "var(--syntax-comment)", fontStyle: "italic" },
  function: { color: "var(--syntax-function)" },
  operator: { color: "var(--syntax-operator)" },
};

/** `sql` をドライバの方言で解析し、色分け用の区切りに分ける。連結すると元の文字列に戻る。 */
export function sqlHighlightSegments(sql: string, driver: string): SqlHighlightSegment[] {
  const language = sqlLang({ dialect: codeMirrorSqlDialectFor(driver) }).language;
  const tree = language.parser.parse(sql);
  const out: SqlHighlightSegment[] = [];
  highlightCode(
    sql,
    tree,
    highlighter,
    (text, classes) => {
      // 複数タグが付いたときは先頭のクラスを使う (エディタも最初に一致したスタイルが勝つ)。
      const first = classes.split(" ")[0] as SqlTokenKind | "";
      out.push({ text, kind: first === "" ? null : first });
    },
    () => out.push({ text: "\n", kind: null }),
  );
  return out;
}
