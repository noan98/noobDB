// クエリエディタのリアルタイム SQL 構文チェック (#704) の純ロジック。
//
// `@codemirror/lang-sql` が既に構築している Lezer パースツリーを再利用し、
// エラーノード (`node.type.isError`) と未終端の文字列/引用符ノードから
// `@codemirror/lint` の `Diagnostic[]` を組み立てる。追加パースを行わないため
// コストはほぼゼロ (エディタ側は `syntaxTree(state)` を渡すだけ)。
//
// これは**編集支援 (ベストエフォート)** であって安全判定ではない。Lezer の SQL
// 文法は寛容 (error-tolerant) で、キーワードのタイポやカンマ抜けなど多くの誤りは
// エラーにならない。検出できるのは主に「括弧の不整合」と「未終端の文字列/引用符」
// で、`apply_auto_limit` と同じく**誤検出を出すより見逃す側に倒す**保守的方針を
// とる。安全網 (`dangerousSql.ts` / バックエンド `is_read_only_sql`) とは目的も
// 経路も別物で、判定ロジックは共有しない。
//
// 副作用が無いので Vitest (`src/__tests__/sqlLint.test.ts`) でユニットテストする。

import type { Tree } from "@lezer/common";
import type { SQLDialect } from "@codemirror/lang-sql";
import type { Diagnostic } from "@codemirror/lint";

/** 診断メッセージ (i18n 経由で日英を注入する)。 */
export interface SqlLintMessages {
  /** 一般的な構文崩れ (括弧の不整合など) のメッセージ。 */
  syntaxError: string;
  /** 未終端の文字列リテラル / 引用符付き識別子のメッセージ。 */
  unterminated: string;
}

/** 文字列/引用符の開始とみなすクオート文字。 */
const QUOTE_CHARS = new Set(["'", '"', "`"]);

/**
 * ノードのテキストが「閉じられていないクオート」かどうか。開始クオート文字で
 * 始まり、かつ (長さが 1 以下、または末尾がその同じクオート文字でない) とき真。
 * ドル引用 (`$$...$$`) など非クオート開始のノードは対象外 (保守側に倒す)。
 */
function isUnterminatedQuote(text: string): boolean {
  const first = text[0];
  if (!QUOTE_CHARS.has(first)) return false;
  if (text.length < 2) return true;
  return text[text.length - 1] !== first;
}

/**
 * Lezer パースツリーから `Diagnostic[]` を計算する純関数。エディタ側は
 * `syntaxTree(view.state)` の結果を、テストは `parseSqlTree` の結果を渡す。
 *
 * - **エラーノード** (`node.type.isError`): 隣接/重複するものは 1 件へマージし、
 *   ゼロ幅 (欠落位置マーカー) は下線が付くよう最小 1 文字へ広げる。`syntaxError`。
 * - **未終端の文字列/引用符**: `String` / `QuotedIdentifier` などクオート開始で
 *   閉じられていないノードを、その範囲で `unterminated` として報告する。Lezer は
 *   未終端文字列をエラーにせず EOF まで伸びる 1 トークンにするため、ツリーから
 *   別途拾う必要がある。
 */
export function diagnosticsFromTree(
  tree: Tree,
  doc: string,
  messages: SqlLintMessages,
): Diagnostic[] {
  // エラーノードの生の範囲を収集する。
  const errorRanges: Array<{ from: number; to: number }> = [];
  const unterminated: Diagnostic[] = [];

  tree.iterate({
    enter(node) {
      if (node.type.isError) {
        errorRanges.push({ from: node.from, to: node.to });
        return;
      }
      // クオート開始トークン (文字列/引用符付き識別子) の未終端を拾う。ノード名は
      // 方言で異なりうる (String / QuotedIdentifier など) ため、テキストの見た目で
      // 判定して方言非依存にする。
      if (node.to > node.from) {
        const text = doc.slice(node.from, node.to);
        if (isUnterminatedQuote(text)) {
          unterminated.push({
            from: node.from,
            to: node.to,
            severity: "error",
            message: messages.unterminated,
            source: "sql-syntax",
          });
        }
      }
    },
  });

  const docLen = doc.length;
  const errors = mergeErrorRanges(errorRanges).map(({ from, to }) => {
    // ゼロ幅のエラー (欠落位置マーカー。多くは EOF での括弧未閉じ) は下線が付くよう
    // 最小 1 文字に広げる。末尾なら直前の文字、先頭なら直後の文字を指す。
    let f = from;
    let ta = to;
    if (ta <= f) {
      if (f > 0) f = f - 1;
      else ta = Math.min(1, docLen);
    }
    return {
      from: f,
      to: ta,
      severity: "error",
      message: messages.syntaxError,
      source: "sql-syntax",
    } satisfies Diagnostic;
  });

  return [...unterminated, ...errors];
}

/**
 * 隣接/重複するエラー範囲を 1 つにまとめる (`SELECT * FROM t))` の連続する `)` を
 * 1 件へ)。入力は from 昇順とは限らないのでソートしてから畳む。gap が 1 以下の
 * (間に空白 1 文字程度しかない) 範囲も同一の崩れとみなして結合する。
 */
function mergeErrorRanges(
  ranges: Array<{ from: number; to: number }>,
): Array<{ from: number; to: number }> {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a.from - b.from || a.to - b.to);
  const out: Array<{ from: number; to: number }> = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.from <= last.to + 1) {
      last.to = Math.max(last.to, r.to);
    } else {
      out.push({ from: r.from, to: r.to });
    }
  }
  return out;
}

/**
 * `dialect` の Lezer パーサで `doc` をパースしてツリーを返す。エディタでは
 * `syntaxTree(state)` が同じツリーを共有済みだが、テストや (ツリー未取得時の)
 * フォールバックのためにここでも生成できるようにしておく。
 */
export function parseSqlTree(doc: string, dialect: SQLDialect): Tree {
  return dialect.language.parser.parse(doc);
}

/**
 * `doc` を `dialect` でパースして診断を返す便宜関数 (テスト用 / フォールバック)。
 */
export function computeSqlDiagnostics(
  doc: string,
  dialect: SQLDialect,
  messages: SqlLintMessages,
): Diagnostic[] {
  return diagnosticsFromTree(parseSqlTree(doc, dialect), doc, messages);
}
