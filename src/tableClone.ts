// テーブル複製 (#1398) の純ロジック。
//
// `get_object_definition(kind="table")` が返す CREATE TABLE DDL (MySQL = SHOW CREATE TABLE、
// SQLite = sqlite_master.sql + CREATE INDEX、PostgreSQL = introspection からの再構成) を
// 新しいテーブル名向けに書き換え、既存の書き込み経路 (`run_query_transaction`) へ渡す
// 文の列にする。パーサではなく「コメント/文字列/引用識別子を壊さない字句分割」で、
// 次の 3 点だけを書き換える。
//
//   1. `CREATE TABLE <名前>` の名前 (と自己参照 FK の `REFERENCES <旧名>`)
//   2. スキーマ/データベース内で一意でなければならない名前の衝突回避
//      - MySQL: `CONSTRAINT <名前>` (FK / CHECK はデータベース内で一意)
//      - PostgreSQL: `CONSTRAINT <名前>` と `CREATE INDEX <名前>` (スキーマ内で一意)
//      - SQLite: `CREATE INDEX <名前>` (データベース全体で一意)
//   3. MySQL の `AUTO_INCREMENT=<n>` テーブルオプション (複製先は 1 から数え直す)
//
// 方言差は識別子クオート (`sqlDialect.quoteIdentFor`) と上の一意性規則だけ。

import { quoteIdentFor } from "./components/sqlDialect";

type TokenKind = "ws" | "comment" | "string" | "qident" | "word" | "punct";

interface Token {
  kind: TokenKind;
  text: string;
  /** `qident` のときだけ: クオートを外してエスケープを戻した識別子の実体。 */
  value?: string;
}

const PUNCT = new Set(["(", ")", ",", ";", ".", "="]);

/** DDL を字句に分割する。`tokens.map(t => t.text).join("")` は入力と一致する。 */
function tokenize(sql: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    if (/\s/.test(c)) {
      let j = i + 1;
      while (j < n && /\s/.test(sql[j])) j++;
      out.push({ kind: "ws", text: sql.slice(i, j) });
      i = j;
    } else if (c === "-" && next === "-") {
      let j = i + 2;
      while (j < n && sql[j] !== "\n") j++;
      out.push({ kind: "comment", text: sql.slice(i, j) });
      i = j;
    } else if (c === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      const j = end === -1 ? n : end + 2;
      out.push({ kind: "comment", text: sql.slice(i, j) });
      i = j;
    } else if (c === "'" || c === '"' || c === "`" || c === "[") {
      const close = c === "[" ? "]" : c;
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "\\" && c === "'") {
          j += 2;
          continue;
        }
        if (sql[j] === close) {
          // 同じ記号の二重化はエスケープ (`[` の `]]` も同様)
          if (sql[j + 1] === close) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      const text = sql.slice(i, Math.min(j + 1, n));
      if (c === "'") {
        out.push({ kind: "string", text });
      } else {
        const inner = text.slice(1, text.endsWith(close) && text.length > 1 ? -1 : undefined);
        out.push({ kind: "qident", text, value: inner.split(close + close).join(close) });
      }
      i = j + 1;
    } else if (PUNCT.has(c)) {
      out.push({ kind: "punct", text: c });
      i++;
    } else {
      let j = i + 1;
      while (j < n) {
        const d = sql[j];
        if (/\s/.test(d) || PUNCT.has(d) || d === "'" || d === '"' || d === "`" || d === "[") break;
        if ((d === "-" && sql[j + 1] === "-") || (d === "/" && sql[j + 1] === "*")) break;
        j++;
      }
      out.push({ kind: "word", text: sql.slice(i, j) });
      i = j;
    }
  }
  return out;
}

/** トップレベルの `;` で文に分け、コメントと空文を除く。 */
function splitStatements(tokens: Token[]): Token[][] {
  const stmts: Token[][] = [];
  let cur: Token[] = [];
  for (const t of tokens) {
    if (t.kind === "punct" && t.text === ";") {
      stmts.push(cur);
      cur = [];
    } else if (t.kind !== "comment") {
      cur.push(t);
    }
  }
  stmts.push(cur);
  return stmts
    .map(trimWs)
    .filter((s) => s.length > 0);
}

function trimWs(tokens: Token[]): Token[] {
  let a = 0;
  let b = tokens.length;
  while (a < b && tokens[a].kind === "ws") a++;
  while (b > a && tokens[b - 1].kind === "ws") b--;
  return tokens.slice(a, b);
}

function isName(t: Token | undefined): t is Token {
  return !!t && (t.kind === "word" || t.kind === "qident");
}

function nameValue(t: Token): string {
  return t.kind === "qident" ? (t.value ?? t.text) : t.text;
}

/** 空白を飛ばして次の有意トークンの添字を返す (無ければ -1)。 */
function nextSig(tokens: Token[], from: number): number {
  for (let i = from; i < tokens.length; i++) if (tokens[i].kind !== "ws") return i;
  return -1;
}

/**
 * `from` 以降の (修飾付きかもしれない) 名前を読み、`[開始, 終了)` と最後の部品の実体を返す。
 * `a`.`b` / a.b / "b" のいずれも対象。名前でなければ null。
 */
function readQualifiedName(
  tokens: Token[],
  from: number,
): { start: number; end: number; last: string } | null {
  const start = nextSig(tokens, from);
  if (start < 0 || !isName(tokens[start])) return null;
  let end = start + 1;
  let last = nameValue(tokens[start]);
  for (;;) {
    const dot = nextSig(tokens, end);
    if (dot < 0 || tokens[dot].text !== "." || tokens[dot].kind !== "punct") break;
    const part = nextSig(tokens, dot + 1);
    if (part < 0 || !isName(tokens[part])) break;
    end = part + 1;
    last = nameValue(tokens[part]);
  }
  return { start, end, last };
}

function qualified(driver: string, database: string | null | undefined, table: string): string {
  if (driver === "sqlite" || !database) return quoteIdentFor(driver, table);
  return `${quoteIdentFor(driver, database)}.${quoteIdentFor(driver, table)}`;
}

/** 識別子の最大長 (MySQL 64 / PostgreSQL 63)。SQLite は実質無制限。 */
function maxIdentLength(driver: string): number {
  if (driver === "postgres") return 63;
  if (driver === "mysql") return 64;
  return Number.POSITIVE_INFINITY;
}

/**
 * 一意でなければならない制約名・インデックス名の複製先での名前。
 * 旧テーブル名を含んでいればその部分を新テーブル名に置換 (`users_email_idx` →
 * `users_copy_email_idx`)、含まなければ `<名前>_<新テーブル名>` とする。最大長に収め、
 * `used` (今回の複製内で採番済み + 呼び出し側が渡した既存名、小文字比較) と衝突したら
 * `_2`, `_3` ... を付ける。
 */
export function cloneObjectName(
  driver: string,
  name: string,
  sourceTable: string,
  newTable: string,
  used: Set<string>,
): string {
  const max = maxIdentLength(driver);
  const fit = (s: string, suffix = "") => {
    const room = max - suffix.length;
    return (s.length > room ? s.slice(0, Math.max(room, 1)) : s) + suffix;
  };
  const base =
    sourceTable && name.includes(sourceTable)
      ? name.replace(sourceTable, newTable)
      : `${name}_${newTable}`;
  let candidate = fit(base);
  let n = 2;
  while (used.has(candidate.toLowerCase())) {
    candidate = fit(base, `_${n}`);
    n++;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

export interface CloneOptions {
  driver: string;
  /** MySQL = データベース / PostgreSQL = スキーマ。SQLite では無視。 */
  database: string | null;
  sourceTable: string;
  newTable: string;
  /** `get_object_definition(kind="table")` の戻り値。 */
  ddl: string;
  includeData: boolean;
  /** 既に使われているインデックス/制約名 (あれば衝突回避に使う)。 */
  existingNames?: string[];
}

export interface CloneResult {
  /** 実行順の文。末尾に `;` を付けない (`run_query_transaction` 向け)。 */
  statements: string[];
  /** DDL を解釈できず省いた文などの注意 (原文の先頭を載せる)。 */
  skipped: string[];
}

const stripTrailingSemicolon = (s: string) => s.replace(/\s*;+\s*$/, "");

/** CREATE TABLE 文を書き換える。 */
function rewriteCreateTable(
  tokens: Token[],
  o: CloneOptions,
  used: Set<string>,
): Token[] | null {
  let i = nextSig(tokens, 0);
  if (i < 0 || tokens[i].text.toUpperCase() !== "CREATE") return null;
  i = nextSig(tokens, i + 1);
  // TEMPORARY / TEMP は複製しても意味が変わるので対象外 (通常テーブルのみ)
  if (i < 0 || tokens[i].text.toUpperCase() !== "TABLE") return null;
  i = nextSig(tokens, i + 1);
  if (i >= 0 && tokens[i].text.toUpperCase() === "IF") {
    for (const kw of ["IF", "NOT", "EXISTS"]) {
      const k = nextSig(tokens, i);
      if (k < 0 || tokens[k].text.toUpperCase() !== kw) return null;
      i = k + 1;
    }
  }
  const nm = readQualifiedName(tokens, i);
  if (!nm) return null;
  const newName = qualified(o.driver, o.database, o.newTable);
  const out: Token[] = [
    ...tokens.slice(0, nm.start),
    { kind: "word", text: newName },
  ];
  const sameTable = (name: string) =>
    o.driver === "postgres" ? name === o.sourceTable : name.toLowerCase() === o.sourceTable.toLowerCase();

  let depth = 0;
  const rest = tokens.slice(nm.end);
  for (let k = 0; k < rest.length; k++) {
    const t = rest[k];
    if (t.kind === "punct" && t.text === "(") depth++;
    if (t.kind === "punct" && t.text === ")") depth--;

    if (t.kind === "word") {
      const kw = t.text.toUpperCase();
      // MySQL: テーブルオプション AUTO_INCREMENT=<n> を落とす (列定義内の AUTO_INCREMENT は
      // `=` を伴わないので区別できる)。
      if (o.driver === "mysql" && depth === 0 && kw === "AUTO_INCREMENT") {
        const eq = nextSig(rest, k + 1);
        const num = eq >= 0 ? nextSig(rest, eq + 1) : -1;
        if (eq >= 0 && rest[eq].text === "=" && num >= 0 && rest[num].kind === "word") {
          // 直前の空白も 1 つ落として二重空白を避ける
          if (out.length > 0 && out[out.length - 1].kind === "ws") out.pop();
          k = num;
          continue;
        }
      }
      if (kw === "CONSTRAINT" && o.driver !== "sqlite") {
        const nameIdx = nextSig(rest, k + 1);
        if (nameIdx >= 0 && isName(rest[nameIdx])) {
          const renamed = cloneObjectName(
            o.driver,
            nameValue(rest[nameIdx]),
            o.sourceTable,
            o.newTable,
            used,
          );
          out.push(t, ...rest.slice(k + 1, nameIdx), {
            kind: "word",
            text: quoteIdentFor(o.driver, renamed),
          });
          k = nameIdx;
          continue;
        }
      }
      if (kw === "REFERENCES") {
        const ref = readQualifiedName(rest, k + 1);
        if (ref && sameTable(ref.last)) {
          out.push(t, ...rest.slice(k + 1, ref.start), { kind: "word", text: newName });
          k = ref.end - 1;
          continue;
        }
      }
    }
    out.push(t);
  }
  return out;
}

/** CREATE [UNIQUE] INDEX 文を書き換える。 */
function rewriteCreateIndex(
  tokens: Token[],
  o: CloneOptions,
  used: Set<string>,
): Token[] | null {
  let i = nextSig(tokens, 0);
  if (i < 0 || tokens[i].text.toUpperCase() !== "CREATE") return null;
  i = nextSig(tokens, i + 1);
  if (i >= 0 && tokens[i].text.toUpperCase() === "UNIQUE") i = nextSig(tokens, i + 1);
  if (i < 0 || tokens[i].text.toUpperCase() !== "INDEX") return null;
  i = nextSig(tokens, i + 1);
  if (i >= 0 && tokens[i].text.toUpperCase() === "IF") {
    for (const kw of ["IF", "NOT", "EXISTS"]) {
      const k = nextSig(tokens, i);
      if (k < 0 || tokens[k].text.toUpperCase() !== kw) return null;
      i = k + 1;
    }
  }
  const idx = readQualifiedName(tokens, i);
  if (!idx) return null;
  const on = nextSig(tokens, idx.end);
  if (on < 0 || tokens[on].text.toUpperCase() !== "ON") return null;
  const target = readQualifiedName(tokens, on + 1);
  if (!target) return null;

  // MySQL のインデックス名はテーブル内で一意なので名前はそのまま。
  const indexName =
    o.driver === "mysql"
      ? quoteIdentFor(o.driver, idx.last)
      : quoteIdentFor(
          o.driver,
          cloneObjectName(o.driver, idx.last, o.sourceTable, o.newTable, used),
        );
  // PostgreSQL のインデックスは対象テーブルと同じスキーマに作られる (名前は修飾しない)。
  return [
    ...tokens.slice(0, idx.start),
    { kind: "word", text: indexName },
    ...tokens.slice(idx.end, target.start),
    { kind: "word", text: qualified(o.driver, o.database, o.newTable) },
    ...tokens.slice(target.end),
  ];
}

const render = (tokens: Token[]) => tokens.map((t) => t.text).join("").trim();

/**
 * 複製に必要な文の列を作る。先頭は CREATE TABLE、続いて CREATE INDEX、`includeData` なら
 * 最後に `INSERT INTO <新> SELECT * FROM <旧>`。DDL の先頭が CREATE TABLE でなければ
 * `statements` は空になる (呼び出し側は確定ボタンを無効にする)。
 */
export function buildCloneStatements(o: CloneOptions): CloneResult {
  const used = new Set((o.existingNames ?? []).map((s) => s.toLowerCase()));
  const statements: string[] = [];
  const skipped: string[] = [];
  const stmts = splitStatements(tokenize(o.ddl));
  stmts.forEach((s, idx) => {
    const rewritten =
      idx === 0 ? rewriteCreateTable(s, o, used) : rewriteCreateIndex(s, o, used);
    if (rewritten) statements.push(stripTrailingSemicolon(render(rewritten)));
    else if (idx > 0) skipped.push(render(s).slice(0, 80));
  });
  if (statements.length === 0) return { statements: [], skipped };
  if (o.includeData) {
    statements.push(
      `INSERT INTO ${qualified(o.driver, o.database, o.newTable)} SELECT * FROM ${qualified(
        o.driver,
        o.database,
        o.sourceTable,
      )}`,
    );
  }
  return { statements, skipped };
}

/** プレビュー用: 各文の末尾に `;` を付けて空行で区切る。 */
export function formatCloneStatements(statements: string[]): string {
  return statements.map((s) => `${s};`).join("\n\n");
}

/** 既定の複製先名。`<元>_copy`、衝突すれば `<元>_copy2`, `_copy3` ... (大小無視)。 */
export function suggestCloneName(existingTables: string[], table: string): string {
  const lower = new Set(existingTables.map((t) => t.toLowerCase()));
  let candidate = `${table}_copy`;
  for (let n = 2; lower.has(candidate.toLowerCase()); n++) candidate = `${table}_copy${n}`;
  return candidate;
}
