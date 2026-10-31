// スキーマ認識のセマンティック lint (#1940) の純ロジック。
//
// 接続中スキーマ (テーブル → 列) を使い、`FROM` / `JOIN` / `UPDATE` / `INSERT INTO` /
// `DELETE FROM` の対象テーブルと、式中の列参照が**明らかに存在しない**ときだけ
// `warning` を返す。`sqlLint.ts` (構文/キーワード) とは目的が別で、あくまで編集支援の
// ベストエフォート。安全網 (`dangerousSql.ts` / バックエンド `is_read_only_sql`) とは無関係。
//
// 方針は「偽陽性を出すより見逃す」。次のものを解決し、解決できないものは黙る。
// - エイリアス (`FROM users u` / `u.name`)・CTE (`WITH x AS (...)`)・派生テーブル
//   (`FROM (SELECT ...) s`) の出力列・SELECT 句の別名 (`ORDER BY total`)
// - 関数呼び出し (`count(x)` の `count` は列ではない)・`*` / `t.*`・キーワード
//   (パースツリー上で `Identifier` でない語)・暗黙の別名・変数/プレースホルダ
// - 他 DB/スキーマ修飾 (`other.t`)・テーブル関数・`LATERAL`・入れ子の JOIN 括弧・
//   同じスクリプト内で `CREATE` された表・Postgres のマテビュー等 (`extraTableNames`)
// 構文木 (Lezer) は寛容で `u.*` などにエラーノードが混ざるため、構造は自前のトークナイザ
// で読み、キーワードか識別子かの判定にだけ構文木のリーフ種別を使う (方言の表に追従)。
//
// 副作用が無いので Vitest (`src/__tests__/sqlSemanticLint.test.ts`) でユニットテストする。

import type { Tree } from "@lezer/common";
import type { Diagnostic } from "@codemirror/lint";

/** 診断メッセージ (i18n 経由で注入)。`{name}` を対象の識別子に置き換える。 */
export interface SqlSemanticMessages {
  unknownTable: string;
  unknownColumn: string;
}

/** セマンティック lint が参照するスキーマ。 */
export interface SemanticSchema {
  driver: string;
  /** 小文字のテーブル名 → 小文字の列集合。列が不明 (未取得) なら null。 */
  tables: Map<string, Set<string> | null>;
  /** 既定 DB/スキーマ名 (小文字)。`db.table` の `db` がこれと一致するときだけ検証する。 */
  defaultDatabase: string | null;
  /** 列は不明だが存在するテーブル名 (小文字。マテビューなど)。 */
  extraTables: Set<string>;
}

/** `buildSemanticSchema` の入力。 */
export interface SemanticSchemaInput {
  driver: string;
  /** DB 全体の `table → columns` (スキーマ概観)。これが空/未取得なら lint しない。 */
  databaseSchema: ReadonlyArray<{ name: string; columns: string[] }> | null | undefined;
  /** アクティブテーブル。概観で列が空のときの補完に使う。 */
  schemaTable?: { name: string; columns: string[] } | null;
  defaultDatabase?: string | null;
  /** 概観に出ないが存在するテーブル相当の名前 (Postgres のマテビューなど)。 */
  extraTableNames?: Iterable<string>;
}

/**
 * スキーマ概観からセマンティック lint 用の索引を作る。概観が空 (未取得) なら null を返し、
 * 呼び出し側は何も警告しない (「全テーブルが未知」になる誤検知を避ける)。
 */
export function buildSemanticSchema(input: SemanticSchemaInput): SemanticSchema | null {
  const overview = input.databaseSchema;
  if (!overview || overview.length === 0) return null;
  const tables = new Map<string, Set<string> | null>();
  for (const t of overview) {
    let cols = t.columns;
    if (cols.length === 0 && input.schemaTable && input.schemaTable.name === t.name) {
      cols = input.schemaTable.columns;
    }
    const key = t.name.toLowerCase();
    const set = cols.length > 0 ? new Set(cols.map((c) => c.toLowerCase())) : null;
    if (tables.has(key)) {
      // 大文字小文字だけ違う表名の衝突は列を和集合にする (どちらかが不明なら不明)。
      const old = tables.get(key) ?? null;
      tables.set(key, old && set ? new Set([...old, ...set]) : null);
    } else {
      tables.set(key, set);
    }
  }
  return {
    driver: input.driver,
    tables,
    defaultDatabase: input.defaultDatabase ? input.defaultDatabase.toLowerCase() : null,
    extraTables: new Set([...(input.extraTableNames ?? [])].map((n) => n.toLowerCase())),
  };
}

/** `semanticDiagnostics` の追加入力。 */
export interface SemanticOptions {
  /** カーソル位置。入力中の識別子 (カーソルがその範囲内) は報告しない。 */
  cursor?: number;
}

// ---------------------------------------------------------------------------
// トークナイザ
// ---------------------------------------------------------------------------

type TokKind = "word" | "qid" | "str" | "num" | "var" | "punct";

interface Tok {
  kind: TokKind;
  /** word は小文字化、qid は引用符を外して小文字化。それ以外は元の文字。 */
  norm: string;
  from: number;
  to: number;
}

interface Group {
  kind: "group";
  items: Item[];
  from: number;
  to: number;
}

type Item = Tok | Group;

/** 引用符が閉じていない等、読み取れない箇所を示す印。含む文は丸ごと解析しない。 */
const BAD = "\u0000bad";

const WORD_START = /[A-Za-z_\u0080-￿]/;
const WORD_PART = /[A-Za-z0-9_$\u0080-￿]/;

function scanQuoted(doc: string, start: number, quote: string, backslash: boolean): number {
  // start は開き引用符の位置。閉じ引用符の次の位置を返す。閉じていなければ -1。
  let i = start + 1;
  while (i < doc.length) {
    const c = doc[i];
    if (backslash && c === "\\") {
      i += 2;
      continue;
    }
    if (c === quote) {
      if (doc[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  return -1;
}

function tokenize(doc: string, driver: string): Tok[] {
  const toks: Tok[] = [];
  const push = (kind: TokKind, from: number, to: number, norm?: string) => {
    toks.push({ kind, norm: norm ?? doc.slice(from, to), from, to });
  };
  const mysql = driver !== "postgres" && driver !== "sqlite";
  const unquote = (from: number, to: number, q: string) =>
    doc
      .slice(from + 1, to - 1)
      .split(q + q)
      .join(q)
      .toLowerCase();
  let i = 0;
  while (i < doc.length) {
    if (toks.length > MAX_TOKENS) return toks;
    const c = doc[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "-" && doc[i + 1] === "-") {
      while (i < doc.length && doc[i] !== "\n") i++;
      continue;
    }
    if (c === "#" && mysql) {
      while (i < doc.length && doc[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && doc[i + 1] === "*") {
      const end = doc.indexOf("*/", i + 2);
      if (end < 0) {
        push("punct", i, doc.length, BAD);
        return toks;
      }
      i = end + 2;
      continue;
    }
    if (c === "'" || (c === '"' && mysql)) {
      const end = scanQuoted(doc, i, c, mysql);
      if (end < 0) {
        push("punct", i, doc.length, BAD);
        return toks;
      }
      push("str", i, end);
      i = end;
      continue;
    }
    if (c === '"' || c === "`") {
      if (c === "`" && driver === "postgres") {
        push("punct", i, i + 1);
        i++;
        continue;
      }
      const end = scanQuoted(doc, i, c, false);
      if (end < 0) {
        push("punct", i, doc.length, BAD);
        return toks;
      }
      push("qid", i, end, unquote(i, end, c));
      i = end;
      continue;
    }
    if (c === "[" && driver === "sqlite") {
      const m = /^\[[^\]\n]+\]/.exec(doc.slice(i));
      if (m) {
        push("qid", i, i + m[0].length, m[0].slice(1, -1).toLowerCase());
        i += m[0].length;
        continue;
      }
    }
    if (c === "$" && driver === "postgres") {
      const m = /^\$([A-Za-z_]\w*)?\$/.exec(doc.slice(i, i + 80));
      if (m) {
        const end = doc.indexOf(m[0], i + m[0].length);
        if (end < 0) {
          push("punct", i, doc.length, BAD);
          return toks;
        }
        push("str", i, end + m[0].length);
        i = end + m[0].length;
        continue;
      }
    }
    if (WORD_START.test(c)) {
      let j = i + 1;
      while (j < doc.length && WORD_PART.test(doc[j])) j++;
      // E'..' / B'..' / X'..' / N'..' の接頭辞は文字列の一部。
      if (j === i + 1 && /[eEbBxXnN]/.test(c) && doc[j] === "'") {
        const end = scanQuoted(doc, j, "'", c === "e" || c === "E" || mysql);
        if (end < 0) {
          push("punct", i, doc.length, BAD);
          return toks;
        }
        push("str", i, end);
        i = end;
        continue;
      }
      push("word", i, j, doc.slice(i, j).toLowerCase());
      i = j;
      continue;
    }
    if (/\d/.test(c) || (c === "." && /\d/.test(doc[i + 1] ?? ""))) {
      let j = i + 1;
      while (j < doc.length && /[\d.]/.test(doc[j])) j++;
      if (/[eE]/.test(doc[j] ?? "") && /[\d+-]/.test(doc[j + 1] ?? "")) {
        j += 2;
        while (j < doc.length && /\d/.test(doc[j])) j++;
      }
      push("num", i, j);
      i = j;
      continue;
    }
    if (c === ":" && doc[i + 1] === ":") {
      push("punct", i, i + 2);
      i += 2;
      continue;
    }
    if ((c === "@" || c === ":") && /[A-Za-z0-9_@]/.test(doc[i + 1] ?? "")) {
      let j = i + 1;
      while (j < doc.length && /[A-Za-z0-9_@.$]/.test(doc[j])) j++;
      push("var", i, j);
      i = j;
      continue;
    }
    push("punct", i, i + 1);
    i++;
  }
  return toks;
}

/** トークン列を括弧でグループ化する。括弧が釣り合わなければ null。 */
function buildItems(toks: Tok[]): Item[] | null {
  const root: Item[] = [];
  const stack: Array<{ items: Item[]; from: number }> = [];
  let cur = root;
  for (const t of toks) {
    if (t.kind === "punct" && t.norm === BAD) return null;
    if (t.kind === "punct" && t.norm === "(") {
      stack.push({ items: cur, from: t.from });
      cur = [];
    } else if (t.kind === "punct" && t.norm === ")") {
      const top = stack.pop();
      if (!top) return null;
      top.items.push({ kind: "group", items: cur, from: top.from, to: t.to });
      cur = top.items;
    } else {
      cur.push(t);
    }
  }
  return stack.length === 0 ? root : null;
}

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

/** 列集合。null は「不明 (何が来ても否定しない)」。 */
type Cols = Set<string> | null;

interface Source {
  /** 修飾に使う名前 (エイリアス、無ければテーブル名)。小文字。 */
  alias: string;
  columns: Cols;
}

interface Scope {
  sources: Source[];
  /** SELECT 句の出力名 (別名)。WHERE/ORDER BY などが参照しうる。 */
  names: Set<string>;
  /** 列を確定できない (FROM が無い・入れ子 JOIN・テーブル関数 …)。列参照は検証しない。 */
  opaque: boolean;
  parent: Scope | null;
}

interface Env {
  schema: SemanticSchema;
  out: Diagnostic[];
  msgs: SqlSemanticMessages;
  /** 構文木上で `Identifier` / `QuotedIdentifier` と判定された語の開始位置。 */
  idents: Set<number>;
  /** このスクリプトで `CREATE` / `RENAME` された表の名前 (小文字)。 */
  created: Set<string>;
  cursor: number | undefined;
  doc: string;
}

type Ctes = Map<string, Cols>;

const isGroup = (it: Item | undefined): it is Group => !!it && it.kind === "group";
const isWord = (it: Item | undefined, ...ws: string[]): boolean =>
  !!it && it.kind === "word" && ws.includes(it.norm);
const isPunct = (it: Item | undefined, ch: string): boolean => !!it && it.kind === "punct" && it.norm === ch;
const isNameTok = (it: Item | undefined): it is Tok => !!it && (it.kind === "word" || it.kind === "qid");

/** 集合演算。分割して各 SELECT を別個に解析する。 */
const SET_OPS = new Set(["union", "intersect", "except"]);

/** SELECT のテーブル節 (FROM …) を終わらせる句キーワード。 */
const FROM_END = new Set([
  "where",
  "group",
  "having",
  "order",
  "limit",
  "offset",
  "window",
  "qualify",
  "fetch",
  "for",
  "lock",
  "into",
  "returning",
]);

/** 以降の列参照を検証しない語 (ロック句・ウィンドウ定義・INSERT の ON CONFLICT など)。 */
const STOP_TAIL = new Set([
  "for",
  "lock",
  "window",
  "fetch",
  "limit",
  "offset",
  "into",
  "qualify",
  "on",
  "returning",
]);

const JOIN_WORDS = new Set([
  "natural",
  "left",
  "right",
  "full",
  "inner",
  "outer",
  "cross",
  "join",
  "straight_join",
]);

/** エイリアス位置に来ても別名とみなさない語。 */
const NOT_ALIAS = new Set([
  ...JOIN_WORDS,
  ...FROM_END,
  "using",
  "set",
  "union",
  "intersect",
  "except",
  "as",
  "lateral",
  "tablesample",
  "values",
  "select",
]);

/** この語の直後の識別子は列参照 (演算の被演算子)。それ以外の語/値の直後は別名とみなして読み飛ばす。 */
const OPERAND_EXPECTING = new Set([
  "and",
  "or",
  "not",
  "xor",
  "in",
  "is",
  "like",
  "ilike",
  "rlike",
  "regexp",
  "similar",
  "between",
  "then",
  "else",
  "when",
  "case",
  "select",
  "distinct",
  "all",
  "from",
  "on",
  "using",
  "by",
  "where",
  "having",
  "set",
  "join",
  "exists",
  "any",
  "some",
]);

/** 列として扱わない語 (方言の表に載り漏れうるもの)。 */
const NOT_COLUMN = new Set([
  "partition",
  "over",
  "true",
  "false",
  "null",
  "unknown",
  "default",
  "current_date",
  "current_time",
  "current_timestamp",
  "current_user",
  "current_schema",
  "current_catalog",
  "localtime",
  "localtimestamp",
  "session_user",
  "user",
  "sysdate",
  "rowid",
  "_rowid_",
  "oid",
  "ctid",
  "tableoid",
  "xmin",
  "xmax",
  "cmin",
  "cmax",
  "nulls",
  "first",
  "last",
  "asc",
  "desc",
  "rows",
  "range",
  "groups",
  "unbounded",
  "preceding",
  "following",
  "current",
  "row",
  "exclude",
  "ties",
  "others",
  "no",
  "filter",
  "within",
  "ordinality",
  "separator",
  "lateral",
  "excluded",
  "new",
  "old",
  // EXTRACT(year FROM x) などの日時要素
  "year",
  "quarter",
  "month",
  "week",
  "day",
  "hour",
  "minute",
  "second",
  "millisecond",
  "microsecond",
  "epoch",
  "dow",
  "doy",
  "isodow",
  "isoyear",
  "timezone",
  "century",
  "decade",
  "millennium",
  "milliseconds",
  "microseconds",
  "julian",
  "timezone_hour",
  "timezone_minute",
]);

/** `DISTINCT` など SELECT 句の先頭に置ける修飾語。 */
const SELECT_MODIFIERS = new Set([
  "distinct",
  "all",
  "distinctrow",
  "straight_join",
  "sql_calc_found_rows",
  "sql_no_cache",
  "sql_cache",
  "high_priority",
  "sql_small_result",
  "sql_big_result",
  "sql_buffer_result",
]);

const SYSTEM_TABLE_PREFIXES = ["sqlite_", "pg_"];

function isSubquery(it: Item | undefined): boolean {
  if (!isGroup(it)) return false;
  const first = it.items[0];
  if (isWord(first, "select", "with")) return true;
  return it.items.length === 1 && isSubquery(first);
}

function topIndex(items: Item[], from: number, words: Set<string>): number {
  for (let i = from; i < items.length; i++) {
    const it = items[i];
    if (it.kind === "word" && words.has(it.norm)) return i;
  }
  return -1;
}

function typing(env: Env, t: Tok): boolean {
  return env.cursor !== undefined && env.cursor >= t.from && env.cursor <= t.to;
}

function warn(env: Env, t: Tok, template: string) {
  if (typing(env, t)) return;
  // 表示は元の綴り (引用符は外す)。
  const raw = env.doc.slice(t.from, t.to);
  const name = t.kind === "qid" ? raw.slice(1, -1) : raw;
  env.out.push({
    from: t.from,
    to: t.to,
    severity: "warning",
    message: template.split("{name}").join(name),
    source: "sql-semantic",
  });
}

/** `a.b.c` のように `.` で連なる識別子の鎖を読む。`*` で終わる鎖は star = true。 */
function readChain(items: Item[], i: number): { names: Tok[]; end: number; star: boolean } {
  const names: Tok[] = [];
  let j = i;
  let star = false;
  while (j < items.length) {
    const it = items[j];
    if (!isNameTok(it)) break;
    names.push(it);
    j++;
    if (isPunct(items[j], ".")) {
      if (isPunct(items[j + 1], "*")) {
        star = true;
        j += 2;
        break;
      }
      if (isNameTok(items[j + 1])) {
        j++;
        continue;
      }
    }
    break;
  }
  return { names, end: j, star };
}

/** テーブル参照を解決する。未知のテーブルは警告し、列は「不明」にする。 */
function resolveTable(chain: Tok[], ctes: Ctes, env: Env): Cols {
  if (chain.length > 2) return null;
  const nameTok = chain[chain.length - 1];
  const name = nameTok.norm;
  const { schema } = env;
  if (chain.length === 2) {
    const db = chain[0].norm;
    const isDefault = db === schema.defaultDatabase || (schema.driver === "sqlite" && db === "main");
    if (!isDefault) return null; // 他 DB/スキーマは概観に無いので検証できない
  } else {
    const cte = ctes.get(name);
    if (cte !== undefined) return cte;
  }
  if (schema.tables.has(name)) return schema.tables.get(name) ?? null;
  if (
    env.created.has(name) ||
    schema.extraTables.has(name) ||
    name === "dual" ||
    SYSTEM_TABLE_PREFIXES.some((p) => name.startsWith(p))
  ) {
    return null;
  }
  warn(env, nameTok, env.msgs.unknownTable);
  return null;
}

/** 列別名リストの適用。一部だけ指定の場合に備え、元の列との和集合にする (元が不明なら不明)。 */
function withAliases(aliases: Cols, base: Cols): Cols {
  if (aliases === null || base === null) return null;
  return new Set([...base, ...aliases]);
}

/** `(a, b)` のような括弧内の名前列。名前以外が混ざれば null。 */
function namesOfGroup(g: Group): Cols {
  const out = new Set<string>();
  for (let i = 0; i < g.items.length; i += 2) {
    const it = g.items[i];
    if (!isNameTok(it)) return null;
    out.add(it.norm);
    const sep = g.items[i + 1];
    if (sep !== undefined && !isPunct(sep, ",")) return null;
  }
  return out;
}

/** FROM / JOIN / UPDATE / DELETE のテーブル節を読み、`scope.sources` を埋める。 */
function parseSources(items: Item[], scope: Scope, ctes: Ctes, env: Env, runs: Item[][]) {
  let i = 0;
  let expectSource = true;
  while (i < items.length) {
    const it = items[i];
    if (expectSource) {
      while (isWord(items[i], "only")) i++;
      const cur = items[i];
      let alias: string | null = null;
      let columns: Cols = null;
      if (isGroup(cur)) {
        if (!isSubquery(cur)) {
          scope.opaque = true; // 入れ子の JOIN 括弧など
          return;
        }
        columns = analyzeQuery(cur.items, scope.parent, ctes, env);
        i++;
      } else if (isNameTok(cur)) {
        if (isWord(cur, "lateral")) {
          scope.opaque = true;
          return;
        }
        const chain = readChain(items, i);
        i = chain.end;
        if (chain.star) {
          scope.opaque = true;
          return;
        }
        if (isGroup(items[i])) {
          // テーブル関数 (generate_series(...) など): 列は不明
          i++;
          columns = null;
        } else {
          columns = resolveTable(chain.names, ctes, env);
          alias = chain.names[chain.names.length - 1].norm;
        }
      } else {
        scope.opaque = true;
        return;
      }
      // 別名 (`AS` 有無) と列別名リスト。
      let hasAs = false;
      if (isWord(items[i], "as")) {
        hasAs = true;
        i++;
      }
      const aliasTok = items[i];
      if (
        isNameTok(aliasTok) &&
        (hasAs || aliasTok.kind === "qid" || (!NOT_ALIAS.has(aliasTok.norm) && env.idents.has(aliasTok.from)))
      ) {
        alias = aliasTok.norm;
        i++;
        if (isGroup(items[i]) && !isSubquery(items[i])) {
          columns = withAliases(namesOfGroup(items[i] as Group), columns);
          i++;
        }
      } else if (hasAs) {
        scope.opaque = true;
        return;
      }
      if (alias === null) {
        // 別名の無い派生テーブル/関数: 修飾できないので列は検証しない。
        scope.opaque = true;
      } else {
        scope.sources.push({ alias, columns });
      }
      expectSource = false;
      continue;
    }
    if (isPunct(it, ",")) {
      expectSource = true;
      i++;
    } else if (isWord(it, ...JOIN_WORDS) && !(isWord(it, "left", "right") && isGroup(items[i + 1]))) {
      if (isWord(items[i + 1], "lateral")) {
        scope.opaque = true;
        return;
      }
      // natural left outer join … : join 修飾語を読み飛ばして最後の JOIN まで進む。
      while (i < items.length && isWord(items[i], ...JOIN_WORDS)) {
        const w = items[i] as Tok;
        i++;
        if (w.norm === "join" || w.norm === "straight_join") break;
      }
      expectSource = true;
    } else if (isWord(it, "on")) {
      let j = i + 1;
      while (
        j < items.length &&
        !isPunct(items[j], ",") &&
        !(isWord(items[j], ...JOIN_WORDS) && !(isWord(items[j], "left", "right") && isGroup(items[j + 1])))
      ) {
        j++;
      }
      runs.push(items.slice(i + 1, j));
      i = j;
    } else if (isWord(it, "using") && isGroup(items[i + 1])) {
      runs.push((items[i + 1] as Group).items);
      i += 2;
    } else {
      scope.opaque = true; // インデックスヒント・TABLESAMPLE など想定外
      return;
    }
  }
}

/** SELECT 句の項目 (カンマ区切り) とその出力名。star や名前不明の式があれば columns は null。 */
function analyzeSelectList(list: Item[]): { columns: Cols; aliases: Set<string> } {
  const aliases = new Set<string>();
  let columns: Cols = new Set<string>();
  const parts: Item[][] = [[]];
  for (const it of list) {
    if (isPunct(it, ",")) parts.push([]);
    else parts[parts.length - 1].push(it);
  }
  for (const part of parts) {
    let p = part;
    while (p.length > 1 && isWord(p[0], ...SELECT_MODIFIERS)) p = p.slice(1);
    if (p.length === 0) continue;
    if (isWord(p[0], "on") && isWord(part[0], "distinct")) columns = null;
    const last = p[p.length - 1];
    const prev = p[p.length - 2];
    let name: string | null = null;
    let isAlias = false;
    if (isPunct(last, "*")) {
      columns = null; // `*` / `t.*`
      continue;
    }
    if (isNameTok(last)) {
      if (p.length === 1) name = last.norm;
      else if (isPunct(prev, ".")) name = last.norm;
      else if (prev && isOperandEnd(prev)) {
        name = last.norm; // `expr AS x` / `expr x` (暗黙の別名)
        isAlias = true;
      }
    }
    if (name === null) {
      columns = null; // 式に名前が付かない (方言ごとに自動名が違う)
    } else {
      if (isAlias) aliases.add(name);
      if (columns) columns.add(name);
    }
  }
  return { columns, aliases };
}

function analyzeSelect(items: Item[], outer: Scope | null, ctes: Ctes, env: Env, skipTail: boolean): Cols {
  const scope: Scope = { sources: [], names: new Set(), opaque: false, parent: outer };
  const runs: Item[][] = [];
  if (topIndex(items, 1, new Set(["into"])) >= 0 && topIndex(items, 1, new Set(["from"])) < 0) {
    // SELECT … INTO (変数/新表): 解析しない
    scope.opaque = true;
  }
  const fromIdx = topIndex(items, 1, new Set(["from"]));
  const listEnd = fromIdx < 0 ? items.length : fromIdx;
  const listStop = topIndex(items, 1, new Set(["into", "limit", "offset", "for", "lock", "window"]));
  const list = items.slice(1, listStop >= 0 && listStop < listEnd ? listStop : listEnd);
  const { columns, aliases } = analyzeSelectList(list);
  scope.names = aliases;
  runs.push(list);

  if (fromIdx < 0) {
    scope.opaque = true; // FROM 無し (入力途中・定数式): 列は検証しない
  } else {
    const fromEnd = topIndex(items, fromIdx + 1, FROM_END);
    const end = fromEnd < 0 ? items.length : fromEnd;
    parseSources(items.slice(fromIdx + 1, end), scope, ctes, env, runs);
    if (fromEnd >= 0) {
      const stop = topIndex(items, fromEnd, skipTail ? new Set([...STOP_TAIL, "order"]) : STOP_TAIL);
      runs.push(items.slice(fromEnd, stop < 0 ? items.length : stop));
    }
  }
  for (const run of runs) checkRun(run, scope, ctes, env);
  return columns;
}

function analyzeDml(items: Item[], outer: Scope | null, ctes: Ctes, env: Env): Cols {
  const first = items[0] as Tok;
  const scope: Scope = { sources: [], names: new Set(), opaque: false, parent: outer };
  const runs: Item[][] = [];
  if (first.norm === "update") {
    let s = 1;
    while (isWord(items[s], "or", "ignore", "low_priority", "replace", "rollback", "abort", "fail")) s++;
    const setIdx = topIndex(items, s, new Set(["set"]));
    if (setIdx < 0) return null;
    parseSources(items.slice(s, setIdx), scope, ctes, env, runs);
    const bound = new Set(["from", "where", "order", "limit", "returning"]);
    const fromIdx = topIndex(items, setIdx + 1, bound);
    const setEnd = fromIdx < 0 ? items.length : fromIdx;
    runs.push(items.slice(setIdx + 1, setEnd));
    if (fromIdx >= 0) {
      let rest = fromIdx;
      if (isWord(items[fromIdx], "from")) {
        const e = topIndex(items, fromIdx + 1, new Set(["where", "order", "limit", "returning"]));
        parseSources(items.slice(fromIdx + 1, e < 0 ? items.length : e), scope, ctes, env, runs);
        rest = e < 0 ? items.length : e;
      }
      const stop = topIndex(items, rest, new Set(["returning", "limit", "order"]));
      runs.push(items.slice(rest, stop < 0 ? items.length : stop));
    }
  } else if (first.norm === "delete") {
    if (!isWord(items[1], "from")) return null; // マルチテーブル DELETE 等は解析しない
    const bound = new Set(["using", "where", "order", "limit", "returning"]);
    const e = topIndex(items, 2, bound);
    parseSources(items.slice(2, e < 0 ? items.length : e), scope, ctes, env, runs);
    if (e >= 0) {
      let rest = e;
      if (isWord(items[e], "using")) {
        const e2 = topIndex(items, e + 1, new Set(["where", "order", "limit", "returning"]));
        parseSources(items.slice(e + 1, e2 < 0 ? items.length : e2), scope, ctes, env, runs);
        rest = e2 < 0 ? items.length : e2;
      }
      const stop = topIndex(items, rest, new Set(["returning", "limit", "order"]));
      runs.push(items.slice(rest, stop < 0 ? items.length : stop));
    }
  } else {
    // INSERT [OR …] INTO t [(cols)] …
    let s = 1;
    while (
      isWord(
        items[s],
        "or",
        "ignore",
        "low_priority",
        "delayed",
        "high_priority",
        "replace",
        "abort",
        "fail",
        "rollback",
      )
    )
      s++;
    if (!isWord(items[s], "into")) return null;
    s++;
    const chain = readChain(items, s);
    if (chain.names.length === 0 || chain.star) return null;
    const cols = resolveTable(chain.names, ctes, env);
    let i = chain.end;
    const colList = items[i];
    if (isGroup(colList) && !isSubquery(colList)) {
      i++;
      // SQLite は FTS5 の特殊コマンド (INSERT INTO docs(docs) VALUES('optimize')) などで
      // 表名や隠し列を列リストに書けるので、列の警告は出さない方針をここにも適用する。
      if (cols && env.schema.driver !== "sqlite") {
        for (const it of colList.items) {
          if (isNameTok(it) && !cols.has(it.norm)) warn(env, it, env.msgs.unknownColumn);
        }
      }
    }
    let rest = items.slice(i);
    // ON CONFLICT / ON DUPLICATE KEY UPDATE 以降は対象表の列を指す式なので解析しない。
    const onIdx = rest.findIndex((x, k) => isWord(x, "on") && isWord(rest[k + 1], "conflict", "duplicate"));
    if (onIdx >= 0) rest = rest.slice(0, onIdx);
    if (isWord(rest[0], "select", "with") || isSubquery(rest[0])) analyzeQuery(rest, outer, ctes, env);
    return null;
  }
  scope.opaque = scope.opaque || scope.sources.length === 0;
  for (const run of runs) checkRun(run, scope, ctes, env);
  return null;
}

/** WITH 句と集合演算を処理し、各クエリブロックを解析する。先頭ブロックの出力列を返す。 */
function analyzeQuery(items: Item[], outer: Scope | null, ctes: Ctes, env: Env): Cols {
  let i = 0;
  let scoped = ctes;
  if (isWord(items[0], "with")) {
    scoped = new Map(ctes);
    i = 1;
    if (isWord(items[i], "recursive")) i++;
    for (;;) {
      const nameTok = items[i];
      if (!isNameTok(nameTok)) return null;
      i++;
      let explicit: Cols = null;
      let hasList = false;
      if (isGroup(items[i])) {
        explicit = namesOfGroup(items[i] as Group);
        hasList = true;
        i++;
      }
      if (!isWord(items[i], "as")) return null;
      i++;
      if (isWord(items[i], "not")) i++;
      if (isWord(items[i], "materialized")) i++;
      const body = items[i];
      if (!isGroup(body)) return null;
      i++;
      const inner = new Map(scoped);
      inner.set(nameTok.norm, null); // 再帰参照は列不明
      const cols = analyzeQuery(body.items, outer, inner, env);
      scoped.set(nameTok.norm, hasList ? withAliases(explicit, cols) : cols);
      if (isPunct(items[i], ",")) {
        i++;
        continue;
      }
      break;
    }
  }
  const rest = items.slice(i);
  const segments: Item[][] = [[]];
  for (const it of rest) {
    if (it.kind === "word" && SET_OPS.has(it.norm)) segments.push([]);
    else segments[segments.length - 1].push(it);
  }
  const chain = segments.length > 1;
  let firstCols: Cols = null;
  segments.forEach((seg, idx) => {
    let cols: Cols = null;
    const head = seg[0];
    if (isGroup(head)) {
      cols = analyzeQuery(head.items, outer, scoped, env);
      if (seg.length > 1) cols = null;
    } else if (isWord(head, "select")) {
      cols = analyzeSelect(seg, outer, scoped, env, chain);
    } else if (isWord(head, "update", "delete", "insert", "replace")) {
      cols = analyzeDml(
        head.norm === "replace" ? [{ ...head, norm: "insert" }, ...seg.slice(1)] : seg,
        outer,
        scoped,
        env,
      );
    }
    if (idx === 0) firstCols = cols;
  });
  return firstCols;
}

/** 式の並び (SELECT 句・WHERE など) の列参照を検証する。副問い合わせは再帰する。 */
function checkRun(items: Item[], scope: Scope, ctes: Ctes, env: Env) {
  let i = 0;
  while (i < items.length) {
    const it = items[i];
    if (isGroup(it)) {
      if (isSubquery(it)) analyzeQuery(it.items, scope, ctes, env);
      else if (isWord(items[i - 1], "extract")) {
        // EXTRACT(<日時要素> FROM x): FROM より前は列ではない。
        const f = it.items.findIndex((x) => isWord(x, "from"));
        checkRun(f < 0 ? [] : it.items.slice(f), scope, ctes, env);
      } else checkRun(it.items, scope, ctes, env);
      i++;
      continue;
    }
    if (!isNameTok(it)) {
      i++;
      continue;
    }
    const prev = items[i - 1];
    const chain = readChain(items, i);
    const end = chain.end;
    i = end;
    // 直前が値/名前なら暗黙の別名・型名・修飾語など (`x alias` / `1 day` / `OVER w`)。
    if (prev !== undefined && isOperandEnd(prev)) continue;
    // CONVERT(x USING utf8mb4) / CHARACTER SET utf8mb4 の文字セット名。
    if (isWord(prev, "using", "set")) continue;
    // PG の名前付き引数 (`days => 1` / `days := 1`)。
    if (
      (isPunct(items[end], "=") && isPunct(items[end + 1], ">")) ||
      (isPunct(items[end], ":") && isPunct(items[end + 1], "="))
    )
      continue;
    if (isGroup(items[end]) && chain.names.length <= 2) continue; // 関数呼び出し
    if (chain.star) continue;
    if (chain.names.length === 1) {
      const t = chain.names[0];
      if (!isColumnCandidate(t, env)) continue;
      if (isPunct(prev, ":") || isPunct(prev, "::")) continue;
      resolveBare(t, scope, env);
    } else if (chain.names.length === 2) {
      resolveQualified(chain.names[0], chain.names[1], scope, env);
    }
  }
}

/** 直前のトークンが「式の末尾」(値・名前) か。そうなら続く識別子は別名/型名などで列ではない。 */
function isOperandEnd(prev: Item): boolean {
  if (isGroup(prev)) return true;
  switch (prev.kind) {
    case "word":
      return !OPERAND_EXPECTING.has(prev.norm);
    case "qid":
    case "str":
    case "num":
    case "var":
      return true;
    default:
      return false;
  }
}

function isColumnCandidate(t: Tok, env: Env): boolean {
  if (t.kind === "qid") return true;
  if (NOT_COLUMN.has(t.norm)) return false;
  return env.idents.has(t.from);
}

function resolveBare(t: Tok, scope: Scope, env: Env) {
  const name = t.norm;
  // SQLite は生成列・FTS5 の rank など pragma に出ない列があり、存在しない "名前" は
  // 文字列リテラルとして扱われるので、列の警告は出さない。
  if (env.schema.driver === "sqlite") return;
  for (let s: Scope | null = scope; s; s = s.parent) {
    if (s.opaque || s.names.has(name)) return;
    for (const src of s.sources) {
      if (src.columns === null || src.columns.has(name) || src.alias === name) return;
    }
  }
  warn(env, t, env.msgs.unknownColumn);
}

function resolveQualified(q: Tok, c: Tok, scope: Scope, env: Env) {
  if (!(q.kind === "qid" || env.idents.has(q.from))) return;
  if (!(c.kind === "qid" || env.idents.has(c.from))) return;
  for (let s: Scope | null = scope; s; s = s.parent) {
    const src = s.sources.find((x) => x.alias === q.norm);
    if (!src) continue;
    if (src.columns === null || src.columns.has(c.norm)) return;
    if (env.schema.driver === "sqlite") return;
    warn(env, c, env.msgs.unknownColumn);
    return;
  }
}

/** スクリプト内で CREATE / RENAME された表名を集める (後続文で未知扱いしないため)。 */
function collectCreated(statements: Item[][]): Set<string> {
  const created = new Set<string>();
  for (const st of statements) {
    if (isWord(st[0], "create")) {
      let k = 1;
      while (k < st.length && k < 10 && !isWord(st[k], "table", "view")) k++;
      if (!isWord(st[k], "table", "view")) continue;
      k++;
      if (isWord(st[k], "if") && isWord(st[k + 1], "not") && isWord(st[k + 2], "exists")) k += 3;
      const chain = readChain(st, k);
      if (chain.names.length > 0) created.add(chain.names[chain.names.length - 1].norm);
    } else if (isWord(st[0], "alter")) {
      const r = st.findIndex((x, idx) => isWord(x, "rename") && isWord(st[idx + 1], "to"));
      if (r >= 0) {
        const chain = readChain(st, r + 2);
        if (chain.names.length > 0) created.add(chain.names[chain.names.length - 1].norm);
      }
    } else if (isWord(st[0], "select")) {
      const into = topIndex(st, 1, new Set(["into"]));
      if (into >= 0) {
        const chain = readChain(st, into + 1);
        if (chain.names.length > 0) created.add(chain.names[chain.names.length - 1].norm);
      }
    }
  }
  return created;
}

const MAX_TOKENS = 20000;

/**
 * `doc` の未知テーブル/列を `warning` として返す。`schema` が null (未取得) なら空。
 * 解析できない文は黙って飛ばし、例外は握りつぶして空を返す (エディタを止めない)。
 */
export function semanticDiagnostics(
  tree: Tree,
  doc: string,
  schema: SemanticSchema | null,
  messages: SqlSemanticMessages,
  options: SemanticOptions = {},
): Diagnostic[] {
  if (!schema) return [];
  try {
    const toks = tokenize(doc, schema.driver);
    if (toks.length === 0 || toks.length > MAX_TOKENS) return [];
    // ストアド/トリガー/イベントの本体は `;` で割れ、ローカル変数や引数が列に見えるので解析しない。
    // OR REPLACE / DEFINER=... / TEMP などを読み飛ばし、最初に来るオブジェクト種別の語だけを見る
    // (CREATE TABLE logs (event varchar(10)) の列名 event で文書全体を黙らせないため)。
    for (let k = 0; k < toks.length; k++) {
      if (!isWord(toks[k], "create")) continue;
      for (const x of toks.slice(k + 1, k + 9)) {
        if (isWord(x, "procedure", "function", "trigger", "event")) return [];
        if (isWord(x, "table", "index", "view", "schema", "database", "sequence", "type", "materialized"))
          break;
      }
    }
    const idents = new Set<number>();
    tree.iterate({
      enter(node) {
        if (
          !node.node.firstChild &&
          (node.type.name === "Identifier" || node.type.name === "QuotedIdentifier")
        ) {
          idents.add(node.from);
        }
      },
    });
    const statements: Tok[][] = [[]];
    for (const t of toks) {
      if (t.kind === "punct" && t.norm === ";") statements.push([]);
      else statements[statements.length - 1].push(t);
    }
    const parsed = statements.map((s) => buildItems(s));
    const created = collectCreated(parsed.filter((p): p is Item[] => p !== null));
    const out: Diagnostic[] = [];
    const env: Env = { schema, out, msgs: messages, idents, created, cursor: options.cursor, doc };
    for (const items of parsed) {
      if (!items || items.length === 0) continue;
      const head = items[0];
      if (!isWord(head, "select", "with", "update", "delete", "insert", "replace") && !isGroup(head))
        continue;
      const before = out.length;
      analyzeQuery(items, null, new Map(), env);
      // 同じ範囲の重複報告を除く。
      const seen = new Set<string>();
      const kept = out.splice(before).filter((d) => {
        const key = `${d.from}:${d.to}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      out.push(...kept);
    }
    return out;
  } catch {
    return [];
  }
}
