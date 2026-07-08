// クエリエディタのリアルタイム SQL 構文チェック (#704) の純ロジック。
//
// `@codemirror/lang-sql` が既に構築している Lezer パースツリーを再利用し、
// エラーノード (`node.type.isError`) と未終端の文字列/引用符ノードから
// `@codemirror/lint` の `Diagnostic[]` を組み立てる。追加パースを行わないため
// コストはほぼゼロ (エディタ側は `syntaxTree(state)` を渡すだけ)。
//
// これは**編集支援 (ベストエフォート)** であって安全判定ではない。Lezer の SQL
// 文法は寛容 (error-tolerant) で、カンマ抜けや文中のタイポなど多くの誤りは
// エラーにならない。検出できるのは「括弧の不整合」「未終端の文字列/引用符」
// 「未終端のブロックコメント」と、「文の先頭キーワードのタイポ (`SELEC` など。
// パースツリー上で先頭トークンが Keyword にならない文)」で、`apply_auto_limit` と
// 同じく**誤検出を出すより見逃す側に倒す**保守的方針をとる。エディタの
// `closeBrackets()` が括弧/クオートをタイプ中に自動で閉じるため、括弧系の検出は
// 主に貼り付け・削除後に効き、タイプ中の主戦力は文頭キーワード判定になる。
// 安全網 (`dangerousSql.ts` / バックエンド `is_read_only_sql`) とは目的も
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
  /** 文の先頭キーワードを認識できない (タイポの可能性) のメッセージ。 */
  unknownStatementStart: string;
  /** 未終端のブロックコメント (`/*` が閉じられていない) のメッセージ。 */
  unterminatedComment: string;
}

/** 文字列/引用符の開始とみなすクオート文字。 */
const QUOTE_CHARS = new Set(["'", '"', "`"]);

/**
 * 文の先頭トークンとして許容する単語の追加許可リスト (小文字)。
 * 一次判定は「先頭トークンがパースツリー上で `Keyword` / `Type` / `Builtin` か」で
 * 行い、方言のキーワード表に自動追従する。このリストはその**安全弁**で、方言表に
 * 載っていない (または載り漏れうる) 正当な文開始語を誤検出しないための二重ゲート。
 * ここに無い語を見逃しても (= flag しなくても) 害はないため、広めに列挙してよい。
 */
const STATEMENT_START_EXTRA = new Set([
  // トランザクション / セッション系
  "abort", "savepoint", "release", "discard", "checkpoint",
  // メンテナンス / ユーティリティ系
  "vacuum", "analyze", "analyse", "reindex", "cluster", "optimize", "repair",
  "checksum", "flush", "reset", "purge", "kill", "backup", "restore",
  // PostgreSQL
  "copy", "listen", "unlisten", "notify", "merge", "comment", "refresh",
  "reassign", "security", "declare", "fetch", "move", "close", "import",
  // MySQL
  "handler", "load", "install", "uninstall", "change", "stop", "start", "xa",
  "help", "source", "do",
  // SQLite
  "pragma", "attach", "detach",
  // プリペアド / その他
  "prepare", "execute", "deallocate", "call", "values", "table", "replace",
  "grant", "revoke", "deny",
]);

/** 文頭タイポ判定の対象にする「素の単語」トークンか (プレースホルダ等を除外)。 */
const WORD_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

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
 * - **未終端のブロックコメント**: `/*` で始まり閉じられていない `BlockComment`
 *   ノード。Lezer は EOF までコメント扱いにするが、サーバは構文エラーとして
 *   拒否する。`unterminatedComment`。
 * - **文の先頭キーワードのタイポ**: 各 `Statement` の先頭トークンが `Keyword` 系
 *   でなく素の `Identifier` の文 (`SELEC * FROM ...` 等)。SQL の文は必ず
 *   キーワードで始まるため誤検出リスクが低い。打ちかけの単語を焦って
 *   flag しないよう、先頭トークンの後に別トークンが続くときだけ報告し、
 *   ヒューリスティックである旨を込めて severity は `warning` にする。
 *   `unknownStatementStart`。
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
      // 以降の判定はリーフトークン限定。Script / Statement などのコンテナノードに
      // テキスト先頭の見た目判定を適用すると、クオートで始まる文全体 (`` `t` ... ``
      // や `'a' ...`) を「未終端」と誤検出してしまう。
      if (node.to > node.from && !node.node.firstChild) {
        const text = doc.slice(node.from, node.to);
        // クオート開始トークン (文字列/引用符付き識別子) の未終端を拾う。ノード名は
        // 方言で異なりうる (String / QuotedIdentifier など) ため、テキストの見た目で
        // 判定して方言非依存にする。
        if (isUnterminatedQuote(text)) {
          unterminated.push({
            from: node.from,
            to: node.to,
            severity: "error",
            message: messages.unterminated,
            source: "sql-syntax",
          });
        } else if (
          node.type.name === "BlockComment" &&
          text.startsWith("/*") &&
          (text.length < 4 || !text.endsWith("*/"))
        ) {
          // 未終端のブロックコメント。Lezer は EOF までを 1 コメントにするが、
          // サーバへ送れば構文エラーになる。`/*/` (長さ < 4) も未終端。
          unterminated.push({
            from: node.from,
            to: node.to,
            severity: "error",
            message: messages.unterminatedComment,
            source: "sql-syntax",
          });
        }
      }
    },
  });

  const unknownStarts = collectUnknownStatementStarts(tree, doc, messages);

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

  return [...unterminated, ...unknownStarts, ...errors];
}

/**
 * 各トップレベル `Statement` の先頭トークンが SQL キーワードとして認識されていない
 * 文 (`SELEC * FROM ...` のようなタイポ) を `warning` として報告する。
 *
 * - 一次判定はパースツリーのトークン種別: 正規の文開始語は方言のキーワード表に
 *   より `Keyword` (稀に `Type` / `Builtin`) としてトークナイズされ、タイポは素の
 *   `Identifier` になる。方言追従は自動。
 * - `STATEMENT_START_EXTRA` の許可リストを安全弁として重ね、方言表に載っていない
 *   正当な文開始語 (PRAGMA / VACUUM / COPY など) を誤検出しない。
 * - 打ちかけ (先頭単語の後にまだ何も無い) は flag しない。`(SELECT ...)` や
 *   `{{param}}` のような単語以外で始まる文、引用符付き識別子も対象外 (保守側)。
 */
function collectUnknownStatementStarts(
  tree: Tree,
  doc: string,
  messages: SqlLintMessages,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (let stmt = tree.topNode.firstChild; stmt; stmt = stmt.nextSibling) {
    if (stmt.type.name !== "Statement") continue;
    // 先頭の (文内に取り込まれた) コメントは読み飛ばす。
    let first = stmt.firstChild;
    while (
      first &&
      (first.type.name === "LineComment" || first.type.name === "BlockComment")
    ) {
      first = first.nextSibling;
    }
    if (!first || first.type.name !== "Identifier") continue;
    const word = doc.slice(first.from, first.to);
    if (!WORD_RE.test(word)) continue;
    if (STATEMENT_START_EXTRA.has(word.toLowerCase())) continue;
    // 先頭トークンの後に続きが無ければ「まだ打ちかけ」とみなして報告しない。
    let next = first.nextSibling;
    while (
      next &&
      (next.type.name === "LineComment" || next.type.name === "BlockComment")
    ) {
      next = next.nextSibling;
    }
    if (!next) continue;
    out.push({
      from: first.from,
      to: first.to,
      severity: "warning",
      message: messages.unknownStatementStart,
      source: "sql-syntax",
    });
  }
  return out;
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
