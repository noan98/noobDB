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
// パースツリー上で先頭トークンが Keyword にならない文)」、および DML 文のトップレベル
// トークン列に対するパターン判定 (句キーワードのタイポ・空の句・余分なカンマ・
// BY の抜け・途中で終わった文) で、`apply_auto_limit` と
// 同じく**誤検出を出すより見逃す側に倒す**保守的方針をとる。エディタの
// `closeBrackets()` が括弧/クオートをタイプ中に自動で閉じるため、括弧系の検出は
// 主に貼り付け・削除後に効き、タイプ中の主戦力は文頭キーワード判定になる。
// 安全網 (`dangerousSql.ts` / バックエンド `is_read_only_sql`) とは目的も
// 経路も別物で、判定ロジックは共有しない。
//
// 副作用が無いので Vitest (`src/__tests__/sqlLint.test.ts`) でユニットテストする。

import type { SyntaxNode, Tree } from "@lezer/common";
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
  /** 句の順序ミス (`ORDER BY` の後の `WHERE` など) のメッセージ。 */
  clauseOrder: string;
  /**
   * 句キーワードのタイポ (`FRM` → `FROM` など) のメッセージ。`{keyword}` を
   * 推定したキーワード (大文字) に置き換える。
   */
  keywordTypo: string;
  /** 句の中身が空 (`FROM WHERE` / `id = AND` など) のメッセージ。 */
  missingOperand: string;
  /** 余分なカンマ (`id, FROM` / `a, , b` など) のメッセージ。 */
  extraComma: string;
  /** `GROUP` / `ORDER` の後に `BY` が無いときのメッセージ。 */
  missingBy: string;
  /** 文が途中で終わっている (`... WHERE;` など) ときのメッセージ。 */
  incompleteStatement: string;
}

/** `diagnosticsFromTree` の追加入力。 */
export interface SqlLintOptions {
  /**
   * カーソル位置 (エディタの選択 head)。「文が途中で終わっている」判定で、
   * カーソルがその文の末尾にある (= まだ入力中) なら報告しないために使う。
   * 未指定のときは `;` で閉じられた文だけを報告する。
   */
  cursor?: number;
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
 * 句順序判定 (#704 フォロー) の正規の並び。SELECT 系の文は
 * `WHERE → GROUP BY → HAVING → ORDER BY → LIMIT` の順でなければならない
 * (MySQL / PostgreSQL / SQLite 共通)。値が小さい句ほど前に置く。
 * `OFFSET` / `FETCH` は意図的に含めない: MySQL では `offset` が非予約語で
 * 列名として現れうるうえ、PostgreSQL は `OFFSET ... LIMIT ...` の順も
 * 受理するため、順序判定に使うと誤検出の芽になる。
 */
const CLAUSE_RANK = new Map<string, number>([
  ["where", 1],
  ["group", 2],
  ["having", 3],
  ["order", 4],
  ["limit", 5],
]);

/**
 * 順序違反として**報告してよい**句キーワード (小文字)。3 方言すべてで完全予約語
 * のため、クオート無しで列名等として現れることがなく誤検出しない。`limit` は
 * ランク付けのみで報告対象にしない (報告する状況が事実上ないため)。
 */
const CLAUSE_TRIGGER = new Set(["where", "group", "having", "order"]);

/**
 * 句ランクの追跡をリセットするキーワード (小文字)。`SELECT` は新しい選択リストの
 * 開始 (`INSERT ... SELECT` / `CREATE TABLE ... AS SELECT` を含む)、集合演算は
 * 後続に完全な SELECT が続くため、いずれも以前の句ランクを引き継がない。
 */
const CLAUSE_RESET = new Set(["select", "union", "intersect", "except"]);

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
 * - **DML 文のトークンパターン** (`collectTokenPatternIssues`): 句キーワードの
 *   タイポ (`FRM` / `WHER`)・空の句 (`FROM WHERE`)・余分なカンマ (`id, FROM`)・
 *   BY の抜け (`GROUP id`)・途中で終わった文 (`... WHERE;`)。Lezer の SQL 文法は
 *   これらをエラーにしないため、トップレベルのトークン列を見て判定する。
 * - **句の順序ミス**: `SELECT * FROM t ORDER BY x WHERE ...` のように、文の
 *   トップレベルで句キーワードが正規の並び (`WHERE → GROUP BY → HAVING →
 *   ORDER BY → LIMIT`) に反して現れたとき、その句を `warning` で報告する。
 *   サブクエリ / `OVER (...)` 内の句は `Parens` ノードに包まれて文の直下に
 *   現れないため誤検出しない。`clauseOrder`。
 */
export function diagnosticsFromTree(
  tree: Tree,
  doc: string,
  messages: SqlLintMessages,
  options: SqlLintOptions = {},
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
  const clauseOrder = collectClauseOrderIssues(tree, doc, messages);
  const patterns = collectTokenPatternIssues(tree, doc, messages, options.cursor);

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

  return [...unterminated, ...unknownStarts, ...clauseOrder, ...patterns, ...errors];
}

/**
 * 各トップレベル `Statement` の**直下の** `Keyword` トークン列を走査し、句の順序
 * 違反 (`ORDER BY` の後の `WHERE` など) を `warning` として報告する。
 *
 * - 走査は文の直下のみでネストへ降りない。サブクエリ / ウィンドウ関数の
 *   `OVER (...)` / 関数引数内の句キーワードは `Parens` に包まれるため対象外。
 * - `CLAUSE_RESET` (SELECT / UNION / INTERSECT / EXCEPT) でランクをリセットし、
 *   `INSERT ... SELECT` や集合演算の後続 SELECT を誤検出しない。
 * - 報告対象は完全予約語のみ (`CLAUSE_TRIGGER`)。`offset` のような非予約語は
 *   列名と区別できないため順序判定に一切使わない (保守側)。
 */
function collectClauseOrderIssues(
  tree: Tree,
  doc: string,
  messages: SqlLintMessages,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (let stmt = tree.topNode.firstChild; stmt; stmt = stmt.nextSibling) {
    if (stmt.type.name !== "Statement") continue;
    let maxRank = 0;
    for (let child = stmt.firstChild; child; child = child.nextSibling) {
      if (child.type.name !== "Keyword") continue;
      const word = doc.slice(child.from, child.to).toLowerCase();
      if (CLAUSE_RESET.has(word)) {
        maxRank = 0;
        continue;
      }
      const rank = CLAUSE_RANK.get(word);
      if (rank === undefined) continue;
      if (rank < maxRank && CLAUSE_TRIGGER.has(word)) {
        out.push({
          from: child.from,
          to: child.to,
          severity: "warning",
          message: messages.clauseOrder,
          source: "sql-syntax",
        });
      }
      if (rank > maxRank) maxRank = rank;
    }
  }
  return out;
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

// ---------------------------------------------------------------------------
// DML 文のトークンパターン判定 (#704 フォロー)
//
// Lezer の SQL 文法は「トークンを並べるだけ」に近く、`SELECT * FRM users` も
// `Keyword Operator Identifier Identifier` という正常な並びとして受理する。そこで
// 文の**直下の**トークン列 (`Parens` の中には降りない) に、正当な SQL では起こり
// えない並びだけを探す。誤検出を避けるため次の 3 点で対象を絞る。
//
// - 対象は DML 文 (`DML_START` で始まる文) だけ。`GRANT SELECT, INSERT ON ...` や
//   `CREATE GROUP` など、DDL / DCL では同じ単語が別の意味で並ぶため。
// - 「キーワード」の判定は `RESERVED` (3 方言で予約語の語) に限る。PostgreSQL の
//   方言表は `id` などの非予約語も `Keyword` としてトークン化するため、トークン
//   種別だけで判定すると列名を構文要素と取り違える。
// - `SELECT FROM t` (PostgreSQL では合法) や `SELECT;` のように方言で合法なものは
//   報告しない。
// ---------------------------------------------------------------------------

/** パターン判定の対象にする文の先頭キーワード (小文字)。 */
const DML_START = new Set(["select", "with", "insert", "update", "delete", "replace", "values"]);

/**
 * 構文上の役割を持つ語 (小文字)。3 方言とも予約語で、クオート無しで列名・別名に
 * ならない。これ以外の `Keyword` トークン (PostgreSQL の `id` など) は名前とみなす。
 */
const RESERVED = new Set([
  "select", "from", "where", "group", "order", "by", "having", "limit", "offset",
  "join", "inner", "left", "right", "full", "outer", "cross", "natural", "on", "using",
  "and", "or", "not", "as", "union", "intersect", "except", "all", "distinct",
  "insert", "into", "values", "update", "set", "delete", "with", "case", "when",
  "then", "else", "end", "in", "is", "like", "between", "exists", "null", "true",
  "false", "asc", "desc", "returning", "for", "window", "fetch",
]);

/** 直後に式・名前が必要な語 (小文字)。直後に `CLAUSE_FOLLOWER` が来たら空の句。 */
const NEEDS_OPERAND = new Set(["from", "where", "set", "having", "by", "join", "on", "and", "or"]);

/**
 * 式・名前の直後にしか来ない語 (小文字)。`NEEDS_OPERAND` / 比較演算子 / カンマの
 * 直後に現れたら、その間の要素が抜けている。`FROM` は `SELECT FROM t`
 * (PostgreSQL では合法) を誤検出しないよう含めない。
 */
const CLAUSE_FOLLOWER = new Set(["where", "group", "order", "having", "limit", "and", "or", "on"]);

/** 直後にカンマが来てはいけない語 (`SELECT , a` / `ORDER BY , a` / `SET , a`)。 */
const NO_COMMA_AFTER = new Set(["select", "by", "set"]);

/**
 * 文の最後のトークンになりえない語 (小文字)。`SELECT;` (PostgreSQL では合法) と
 * `DEFAULT VALUES` があるため `select` / `values` は含めない。
 */
const DANGLING_END = new Set([
  "from", "where", "and", "or", "set", "by", "having", "join", "on", "limit", "group", "order",
]);

/** タイポ判定の候補にする句キーワード (小文字)。 */
const TYPO_TARGETS = ["from", "where", "group", "order", "having", "limit", "join", "union"];

/** `JOIN` の直前に来る語。`LEFT JION b` のように前が予約語でもタイポ判定する。 */
const JOIN_PREFIX = new Set(["left", "right", "inner", "outer", "full", "cross", "natural"]);

const BY = new Set(["by"]);
const GROUP_ORDER = new Set(["group", "order"]);
const FROM = new Set(["from"]);
/** `UNION` のタイポの直後に来る語 (`UNOIN SELECT` / `UNOIN ALL`)。 */
const UNION_NEXT = new Set(["select", "all"]);

/** 名前・値として扱うトークン種別。 */
const NAME_LIKE_TYPES = new Set([
  "Identifier", "QuotedIdentifier", "CompositeIdentifier", "Number", "String",
]);

/** キーワード系のトークン種別 (方言表により語が振り分けられる)。 */
const KEYWORD_TYPES = new Set(["Keyword", "Type", "Builtin"]);

interface Tok {
  type: string;
  /** 小文字化したテキスト。 */
  word: string;
  from: number;
  to: number;
}

function isReserved(tok: Tok | undefined, set: Set<string> = RESERVED): boolean {
  return !!tok && tok.type === "Keyword" && set.has(tok.word);
}

/** 名前・値に当たるトークンか (非予約語のキーワードを含む)。 */
function isNameLike(tok: Tok | undefined): boolean {
  if (!tok) return false;
  if (NAME_LIKE_TYPES.has(tok.type)) return true;
  return KEYWORD_TYPES.has(tok.type) && !RESERVED.has(tok.word);
}

function isComma(tok: Tok | undefined): boolean {
  return !!tok && tok.type === "Punctuation" && tok.word === ",";
}

/** 二項の比較・算術演算子か。`SELECT *` の `*` は列の全選択なので除く。 */
function isBinaryOperator(tok: Tok | undefined): boolean {
  return !!tok && tok.type === "Operator" && tok.word !== "*";
}

/**
 * 制限付き Damerau-Levenshtein 距離 (隣接文字の入れ替えを 1 とする)。
 * 短い単語同士の比較にしか使わないので素直な DP で十分。
 */
function editDistance(a: string, b: string): number {
  const d: number[][] = [];
  for (let i = 0; i <= a.length; i++) d.push([i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, d[i - 2][j - 2] + 1);
      }
      d[i][j] = v;
    }
  }
  return d[a.length][b.length];
}

/** `word` がどの句キーワードのタイポらしいか。先頭文字一致 + 距離 1 のみ。 */
function typoTarget(word: string): string | null {
  if (word.length < 3 || !WORD_RE.test(word)) return null;
  for (const kw of TYPO_TARGETS) {
    if (word[0] === kw[0] && word !== kw && editDistance(word, kw) === 1) return kw;
  }
  return null;
}

/** 文の直下のトークン列 (コメントを除く) と、`;` で閉じているかを返す。 */
function statementTokens(stmt: SyntaxNode, doc: string): { toks: Tok[]; terminated: boolean } {
  const toks: Tok[] = [];
  let terminated = false;
  for (let c = stmt.firstChild; c; c = c.nextSibling) {
    const type = c.type.name;
    if (type === "LineComment" || type === "BlockComment") continue;
    if (type === ";") {
      terminated = true;
      continue;
    }
    toks.push({ type, word: doc.slice(c.from, c.to).toLowerCase(), from: c.from, to: c.to });
  }
  return { toks, terminated };
}

/**
 * DML 文のトップレベルのトークン列から、Lezer がエラーにしない典型的な誤りを
 * 報告する (判定の考え方はこのセクション冒頭のコメント参照)。
 */
function collectTokenPatternIssues(
  tree: Tree,
  doc: string,
  messages: SqlLintMessages,
  cursor: number | undefined,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const push = (
    tok: Tok,
    message: string,
    severity: Diagnostic["severity"] = "error",
  ) => {
    out.push({ from: tok.from, to: tok.to, severity, message, source: "sql-syntax" });
  };

  for (let stmt = tree.topNode.firstChild; stmt; stmt = stmt.nextSibling) {
    if (stmt.type.name !== "Statement") continue;
    const { toks, terminated } = statementTokens(stmt, doc);
    if (toks.length === 0 || !isReserved(toks[0], DML_START)) continue;

    for (let i = 0; i < toks.length; i++) {
      const prev = toks[i - 1];
      const tok = toks[i];
      const next = toks[i + 1];

      // 句キーワードのタイポ: 名前と名前に挟まれた位置の素の識別子。
      // 打ちかけ (後ろにまだ何も無い) は報告しない。
      if (tok.type === "Identifier" && prev && next) {
        const kw = typoTarget(tok.word);
        if (kw) {
          const prevOk =
            isNameLike(prev) ||
            prev.type === "Parens" ||
            (prev.type === "Operator" && prev.word === "*") ||
            (kw === "join" && isReserved(prev, JOIN_PREFIX));
          const nextOk =
            isNameLike(next) ||
            ((kw === "group" || kw === "order") && isReserved(next, BY)) ||
            (kw === "union" && isReserved(next, UNION_NEXT));
          if (prevOk && nextOk) {
            push(tok, messages.keywordTypo.split("{keyword}").join(kw.toUpperCase()), "warning");
            continue;
          }
        }
      }

      // 余分なカンマ: `a, FROM` / `a, , b` / `SELECT , a`。
      if (isComma(tok)) {
        if (
          isReserved(next, CLAUSE_FOLLOWER) ||
          isReserved(next, FROM) ||
          isComma(next) ||
          isReserved(prev, NO_COMMA_AFTER)
        ) {
          push(tok, messages.extraComma);
        }
        continue;
      }

      // 空の句: `FROM WHERE` / `SET WHERE` / `id = AND` / `JOIN ON`。
      if (
        (isReserved(tok, NEEDS_OPERAND) || isBinaryOperator(tok)) &&
        isReserved(next, CLAUSE_FOLLOWER)
      ) {
        push(tok, messages.missingOperand);
        continue;
      }

      // BY の抜け: `GROUP id` / `ORDER id`。`WITHIN GROUP (ORDER BY ...)` は
      // 直後が Parens なので対象外。`ORDER B` (BY の打ちかけ) も報告しない。
      if (
        isReserved(tok, GROUP_ORDER) &&
        next &&
        !isReserved(next, BY) &&
        next.type !== "Parens" &&
        !(next.type === "Identifier" && "by".startsWith(next.word))
      ) {
        push(tok, messages.missingBy);
      }
    }

    // 途中で終わった文: 最後のトークンが句キーワード・演算子・カンマ。
    // 入力中 (カーソルが最後のトークン〜直後の空白にある) は報告しない。カーソル不明時は
    // `;` で閉じた文だけを対象にする。
    const last = toks[toks.length - 1];
    const dangling = isReserved(last, DANGLING_END) || isBinaryOperator(last) || isComma(last);
    if (toks.length > 1 && dangling) {
      let end = last.to;
      while (end < doc.length && /\s/.test(doc[end])) end++;
      const typing = cursor !== undefined && cursor >= last.from && cursor <= end;
      const report = cursor === undefined ? terminated : !typing;
      // カンマ・BY 抜けで既に報告済みの末尾トークンは二重に出さない。
      const already = out.some((d) => d.from === last.from && d.to === last.to);
      if (report && !already) push(last, messages.incompleteStatement);
    }
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
  options: SqlLintOptions = {},
): Diagnostic[] {
  return diagnosticsFromTree(parseSqlTree(doc, dialect), doc, messages, options);
}
