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
// ただし PostgreSQL の再構成 DDL (db/table_ddl.rs) は配列/enum/CHECK/identity/部分インデックスを
// 落とすので、PostgreSQL だけは `CREATE TABLE new (LIKE old INCLUDING ALL)` でネイティブに写し、
// 再構成 DDL からは外部キー制約だけを抜き出して `ALTER TABLE ... ADD CONSTRAINT` で足す。

import { quoteIdentFor } from "./components/sqlDialect";

// `versioned` は MySQL のバージョン付きコメント (`/*!80023 INVISIBLE */`、`/*!50100 PARTITION BY ... */`)。
// サーバが SQL として実行するので、通常のコメントと違い捨てずに不透明トークンとして保持する。
type TokenKind = "ws" | "comment" | "versioned" | "string" | "qident" | "word" | "punct";

interface Token {
  kind: TokenKind;
  text: string;
  /** `qident` のときだけ: クオートを外してエスケープを戻した識別子の実体。 */
  value?: string;
}

const PUNCT = new Set(["(", ")", ",", ";", ".", "="]);

/** DDL を字句に分割する。`tokens.map(t => t.text).join("")` は入力と一致する。 */
function tokenize(sql: string, driver: string): Token[] {
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
      out.push({ kind: sql[i + 2] === "!" ? "versioned" : "comment", text: sql.slice(i, j) });
      i = j;
    } else if (c === "'" || c === '"' || c === "`" || c === "[") {
      const close = c === "[" ? "]" : c;
      // バックスラッシュが文字列エスケープなのは MySQL と PostgreSQL の E'...' だけ。
      // SQLite / PostgreSQL の通常文字列では `'\'` で文字列が閉じる。
      const backslashEscapes =
        driver === "mysql" || (driver === "postgres" && /[eE]/.test(sql[i - 1] ?? "") && !/\w/.test(sql[i - 2] ?? ""));
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "\\" && c === "'" && backslashEscapes) {
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

/** トップレベルの `;` で文に分ける。文頭/文末のコメント (PostgreSQL の注意書きなど) と空文は除き、文中のコメントは残す。 */
function splitStatements(tokens: Token[]): Token[][] {
  const stmts: Token[][] = [];
  let cur: Token[] = [];
  for (const t of tokens) {
    if (t.kind === "punct" && t.text === ";") {
      stmts.push(cur);
      cur = [];
    } else {
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
  while (a < b && (tokens[a].kind === "ws" || tokens[a].kind === "comment")) a++;
  while (b > a && (tokens[b - 1].kind === "ws" || tokens[b - 1].kind === "comment")) b--;
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
  for (let i = from; i < tokens.length; i++) {
    if (tokens[i].kind !== "ws" && tokens[i].kind !== "comment") return i;
  }
  return -1;
}

/**
 * `from` 以降の (修飾付きかもしれない) 名前を読み、`[開始, 終了)` と最後の部品の実体を返す。
 * `a`.`b` / a.b / "b" のいずれも対象。名前でなければ null。
 */
function readQualifiedName(
  tokens: Token[],
  from: number,
): { start: number; end: number; last: string; qualifier: string | null } | null {
  const start = nextSig(tokens, from);
  if (start < 0 || !isName(tokens[start])) return null;
  let end = start + 1;
  let last = nameValue(tokens[start]);
  let qualifier: string | null = null;
  for (;;) {
    const dot = nextSig(tokens, end);
    if (dot < 0 || tokens[dot].text !== "." || tokens[dot].kind !== "punct") break;
    const part = nextSig(tokens, dot + 1);
    if (part < 0 || !isName(tokens[part])) break;
    end = part + 1;
    qualifier = last;
    last = nameValue(tokens[part]);
  }
  return { start, end, last, qualifier };
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
      ? name.replace(sourceTable, () => newTable)
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
  /**
   * INSERT ... SELECT の明示列リスト (`insertableColumns` の結果)。未指定なら `SELECT *`。
   * 生成列があるテーブルで `SELECT *` は失敗するので、列メタが取れたときは必ず渡す。
   */
  columns?: string[] | null;
  /**
   * PostgreSQL: 列の種別 (`parsePgColumnFlags`)。identity / serial 列の setval と serial 専用
   * シーケンスの作成に使う。未指定なら serial は元のシーケンスを共有したままになる。
   */
  pgColumns?: PgColumnFlags | null;
  /**
   * PostgreSQL: `pg_constraint` から取った外部キー定義 (`parsePgForeignKeys`)。再構成 DDL は
   * ON DELETE/UPDATE・DEFERRABLE・複合キーの列対応・別スキーマ参照を正しく出せないので使わない。
   */
  pgForeignKeys?: PgForeignKey[] | null;
  /** 既に使われているインデックス/制約名 (あれば衝突回避に使う)。 */
  existingNames?: string[];
}

const stripTrailingSemicolon = (s: string) => s.replace(/\s*;+\s*$/, "");

/** `REFERENCES` の参照先が複製元テーブル自身か。別 DB/スキーマの同名テーブルは自己参照ではない。 */
function isSelfReference(
  o: CloneOptions,
  ref: { last: string; qualifier: string | null },
): boolean {
  const ci = o.driver !== "postgres";
  const eq = (a: string, b: string) => (ci ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (!eq(ref.last, o.sourceTable)) return false;
  if (o.driver === "sqlite" || ref.qualifier === null || o.database === null) return true;
  return eq(ref.qualifier, o.database);
}

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
  const sameTable = (ref: { last: string; qualifier: string | null }) => isSelfReference(o, ref);

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
        if (ref && sameTable(ref)) {
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

/** `REFERENCES` が複製元自身を指していたら新テーブルに付け替えたトークン列を返す。 */
function retargetSelfReferences(tokens: Token[], o: CloneOptions, newName: string): Token[] {
  const out: Token[] = [];
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.kind === "word" && t.text.toUpperCase() === "REFERENCES") {
      const ref = readQualifiedName(tokens, k + 1);
      if (ref && isSelfReference(o, ref)) {
        out.push(t, ...tokens.slice(k + 1, ref.start), { kind: "word", text: newName });
        k = ref.end - 1;
        continue;
      }
    }
    out.push(t);
  }
  return out;
}

/**
 * PostgreSQL: `pg_get_constraintdef` の定義から `ALTER TABLE new ADD CONSTRAINT <衝突回避名> <定義>`
 * を作る。参照先は search_path 次第でスキーマ修飾付き/無しのどちらでも来るので、自己参照は
 * 両方を `isSelfReference` で判定して新名に書き換える。
 */
function pgForeignKeyAlters(o: CloneOptions, used: Set<string>): string[] {
  const newName = qualified(o.driver, o.database, o.newTable);
  return (o.pgForeignKeys ?? []).map((fk) => {
    const def = retargetSelfReferences(tokenize(fk.def, o.driver), o, newName);
    const name = cloneObjectName(o.driver, fk.name, o.sourceTable, o.newTable, used);
    return `ALTER TABLE ${newName} ADD CONSTRAINT ${quoteIdentFor(o.driver, name)} ${render(def)}`;
  });
}

/**
 * MySQL でデータ込み複製するとき、自己参照 FK を CREATE TABLE から外して `ALTER TABLE ... ADD` に
 * する (INSERT ... SELECT の行順で親より先に子が入ると 1452 で失敗するため)。`FOREIGN_KEY_CHECKS`
 * は触らない。`tokens` は既に新名向けに書き換え済みで、自己参照は新テーブルを指している。
 */
function detachSelfForeignKeys(
  tokens: Token[],
  o: CloneOptions,
): { tokens: Token[]; alters: string[] } {
  const open = tokens.findIndex((t) => t.kind === "punct" && t.text === "(");
  if (open < 0) return { tokens, alters: [] };
  const segs: Token[][] = [];
  let cur: Token[] = [];
  let depth = 0;
  let close = -1;
  for (let i = open; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind === "punct" && t.text === "(") {
      depth++;
      if (depth === 1) continue;
    } else if (t.kind === "punct" && t.text === ")") {
      depth--;
      if (depth === 0) {
        segs.push(cur);
        close = i;
        break;
      }
    } else if (t.kind === "punct" && t.text === "," && depth === 1) {
      segs.push(cur);
      cur = [];
      continue;
    }
    cur.push(t);
  }
  if (close < 0) return { tokens, alters: [] };
  const newName = qualified(o.driver, o.database, o.newTable);
  const kept: Token[][] = [];
  const alters: string[] = [];
  for (const seg of segs) {
    let i = nextSig(seg, 0);
    let isSelfFk = false;
    if (i >= 0) {
      if (seg[i].text.toUpperCase() === "CONSTRAINT") {
        const n = nextSig(seg, i + 1);
        i = n >= 0 ? nextSig(seg, n + 1) : -1;
      }
      if (i >= 0 && seg[i].text.toUpperCase() === "FOREIGN") {
        const refIdx = seg.findIndex((t) => t.kind === "word" && t.text.toUpperCase() === "REFERENCES");
        const ref = refIdx >= 0 ? readQualifiedName(seg, refIdx + 1) : null;
        // 書き換え済みの自己参照は `newName` (修飾付き 1 トークン) になっている
        isSelfFk = !!ref && ref.last === newName;
      }
    }
    if (isSelfFk) alters.push(`ALTER TABLE ${newName} ADD ${render(seg)}`);
    else kept.push(seg);
  }
  if (alters.length === 0) return { tokens, alters };
  const out: Token[] = tokens.slice(0, open + 1);
  kept.forEach((seg, idx) => {
    if (idx > 0) out.push({ kind: "punct", text: "," });
    out.push(...seg);
  });
  out.push(...tokens.slice(close));
  return { tokens: out, alters };
}

/**
 * 書き換え後の 1 文が操作する対象テーブル名 (最後の名前部品)。CREATE TABLE / CREATE INDEX /
 * ALTER TABLE / INSERT INTO を見る。解釈できなければ null。
 */
function targetTableOf(sql: string, driver: string): string | null {
  const tokens = tokenize(sql, driver);
  const kw = (i: number) => (i >= 0 ? tokens[i].text.toUpperCase() : "");
  let i = nextSig(tokens, 0);
  const first = kw(i);
  const skipIfNotExists = (from: number) => {
    let k = from;
    if (kw(k) === "IF") {
      for (let n = 0; n < 3; n++) k = nextSig(tokens, k + 1);
    }
    return k;
  };
  if (first === "CREATE") {
    i = nextSig(tokens, i + 1);
    if (kw(i) === "UNIQUE") i = nextSig(tokens, i + 1);
    if (kw(i) === "TABLE") {
      i = skipIfNotExists(nextSig(tokens, i + 1));
      return readQualifiedName(tokens, i)?.last ?? null;
    }
    if (kw(i) === "SEQUENCE") {
      // CREATE SEQUENCE <名> OWNED BY <schema>.<table>.<column> — 所有先テーブルが対象
      const o = tokens.findIndex((t) => t.kind === "word" && t.text.toUpperCase() === "OWNED");
      if (o < 0) return null;
      const by = nextSig(tokens, o + 1);
      return kw(by) === "BY" ? (readQualifiedName(tokens, by + 1)?.qualifier ?? null) : null;
    }
    if (kw(i) === "INDEX") {
      i = skipIfNotExists(nextSig(tokens, i + 1));
      const idx = readQualifiedName(tokens, i);
      if (!idx) return null;
      const on = nextSig(tokens, idx.end);
      return kw(on) === "ON" ? (readQualifiedName(tokens, on + 1)?.last ?? null) : null;
    }
    return null;
  }
  if (first === "ALTER") {
    i = nextSig(tokens, i + 1);
    if (kw(i) !== "TABLE") return null;
    i = nextSig(tokens, i + 1);
    if (kw(i) === "ONLY") i = nextSig(tokens, i + 1);
    return readQualifiedName(tokens, i)?.last ?? null;
  }
  if (first === "SELECT") {
    // SELECT setval(...) FROM <新テーブル> ...: トップレベルの FROM の直後が対象
    let depth = 0;
    for (let k = 0; k < tokens.length; k++) {
      const t = tokens[k];
      if (t.kind === "punct" && t.text === "(") depth++;
      else if (t.kind === "punct" && t.text === ")") depth--;
      else if (depth === 0 && t.kind === "word" && t.text.toUpperCase() === "FROM") {
        return readQualifiedName(tokens, k + 1)?.last ?? null;
      }
    }
    return null;
  }
  if (first === "INSERT") {
    i = nextSig(tokens, i + 1);
    if (kw(i) !== "INTO") return null;
    return readQualifiedName(tokens, i + 1)?.last ?? null;
  }
  return null;
}

export interface CloneResult {
  /** 実行順の文。末尾に `;` を付けない (`run_query_transaction` 向け)。 */
  statements: string[];
  /** DDL を解釈できず省いた文などの注意 (原文の先頭を載せる)。 */
  skipped: string[];
  /** 書換結果が新テーブル以外 (複製元など) を操作しうる、等の致命的な問題。あれば statements は空。 */
  errors: string[];
  /** PostgreSQL: serial の `nextval(...)` 既定値が複製元のシーケンスを共有する。 */
  sharedSequence: boolean;
}

/**
 * 複製に必要な文の列を作る。
 *
 * - MySQL / SQLite: `CREATE TABLE` → `CREATE INDEX` (SQLite) → 任意で INSERT ... SELECT
 * - PostgreSQL: `CREATE TABLE new (LIKE old INCLUDING ALL)` → 任意で INSERT ... SELECT →
 *   外部キーの `ALTER TABLE ... ADD CONSTRAINT` (データ投入後に検証される)
 *
 * DDL の先頭が CREATE TABLE でなければ (ビューなど) `statements` は空。
 */
export function buildCloneStatements(o: CloneOptions): CloneResult {
  const used = new Set((o.existingNames ?? []).map((s) => s.toLowerCase()));
  const skipped: string[] = [];
  const empty: CloneResult = { statements: [], skipped, errors: [], sharedSequence: false };
  const stmts = splitStatements(tokenize(o.ddl, o.driver));
  if (stmts.length === 0) return empty;

  const newName = qualified(o.driver, o.database, o.newTable);
  const oldName = qualified(o.driver, o.database, o.sourceTable);
  // 複製先が元と同名 (衝突チェックをすり抜けた入力) だと元テーブルを操作する文になるので弾く。
  const sameName =
    o.driver === "postgres" ? o.newTable === o.sourceTable : o.newTable.toLowerCase() === o.sourceTable.toLowerCase();
  if (sameName) return { ...empty, errors: [`same table name: ${o.newTable}`] };
  const head: string[] = [];
  const afterData: string[] = [];
  const q = (c: string) => quoteIdentFor(o.driver, c);
  const lit = (x: string) => `'${x.replace(/'/g, "''")}'`;

  if (o.driver === "postgres") {
    if (!rewriteCreateTable(stmts[0], { ...o, driver: "postgres" }, new Set())) return empty;
    head.push(`CREATE TABLE ${newName} (LIKE ${oldName} INCLUDING ALL)`);
    // serial 列は元のシーケンスを共有してしまう (元テーブルを DROP できなくなる) ので、新テーブル専用の
    // シーケンスを作って付け替える。
    for (const col of o.pgColumns?.serial ?? []) {
      const seq = qualified(o.driver, o.database, seqName(o, col));
      head.push(`CREATE SEQUENCE ${seq} OWNED BY ${newName}.${q(col)}`);
      head.push(`ALTER TABLE ${newName} ALTER COLUMN ${q(col)} SET DEFAULT nextval(${lit(seq)}::regclass)`);
    }
    // identity / serial のシーケンスは新規作成で開始値のままなので、データ込みなら現在の最大値に進める
    // (さもないと複製先への最初の INSERT が必ず重複キーになる)。
    if (o.includeData) {
      const cols = [...(o.pgColumns?.identity ?? []), ...(o.pgColumns?.serial ?? [])];
      for (const col of cols) {
        afterData.push(
          `SELECT setval(pg_get_serial_sequence(${lit(newName)}, ${lit(col)}), max(${q(col)})) ` +
            `FROM ${newName} HAVING max(${q(col)}) >= (SELECT seqmin FROM pg_sequence WHERE seqrelid = ` +
            `pg_get_serial_sequence(${lit(newName)}, ${lit(col)})::regclass)`,
        );
      }
    }
    afterData.push(...pgForeignKeyAlters(o, used));
  } else {
    let rewritten = rewriteCreateTable(stmts[0], o, used);
    if (!rewritten) return empty;
    if (o.driver === "mysql" && o.includeData) {
      const d = detachSelfForeignKeys(rewritten, o);
      rewritten = d.tokens;
      afterData.push(...d.alters);
    }
    head.push(stripTrailingSemicolon(render(rewritten)));
    stmts.slice(1).forEach((s) => {
      const r = rewriteCreateIndex(s, o, used);
      if (r) head.push(stripTrailingSemicolon(render(r)));
      else skipped.push(render(s).slice(0, 80));
    });
  }

  const statements = [...head];
  if (o.includeData) statements.push(buildInsertSelect(o, newName, oldName));
  statements.push(...afterData);

  // 保険: 書き換えた各文の対象が新テーブルであること (複製元を触る文を絶対に流さない)。
  const errors: string[] = [];
  for (const sql of statements) {
    const target = targetTableOf(sql, o.driver);
    const ok =
      target !== null &&
      (o.driver === "postgres" ? target === o.newTable : target.toLowerCase() === o.newTable.toLowerCase());
    if (!ok || violatesLiteralRules(sql, o)) errors.push(sql.slice(0, 80));
  }
  if (errors.length > 0) return { statements: [], skipped, errors, sharedSequence: false };
  return {
    statements,
    skipped,
    errors,
    // 列種別が取れていない (serial 専用シーケンスを作れなかった) ときだけ共有の注意を出す
    sharedSequence: o.driver === "postgres" && !o.pgColumns && /nextval\s*\(/i.test(o.ddl),
  };
}

/**
 * 対象テーブル検証の補強 (PostgreSQL の補助文)。文字列リテラルが元テーブルを指す文は弾く。
 * - `SELECT setval(pg_get_serial_sequence('<リテラル>', ...))`: 最初のリテラルが新テーブル名と一致すること
 * - `CREATE SEQUENCE` / `ALTER ... SET DEFAULT nextval('<リテラル>')`: リテラルが指す名前 (テーブル/
 *   シーケンス) の末尾部品が元テーブル名と一致しないこと。CREATE SEQUENCE の名前自体も同様。
 * 該当しない文 (CREATE TABLE / INSERT / FK の ALTER など) は対象外で false。
 */
export function violatesLiteralRules(sql: string, o: CloneOptions): boolean {
  const tokens = tokenize(sql, o.driver);
  const first = tokens.find((t) => t.kind === "word")?.text.toUpperCase();
  const lits = tokens
    .filter((t) => t.kind === "string")
    .map((t) => t.text.slice(1, -1).replace(/''/g, "'"));
  const isSource = (name: string) => {
    const nm = readQualifiedName(tokenize(name, o.driver), 0);
    return !!nm && nm.last.toLowerCase() === o.sourceTable.toLowerCase();
  };
  if (first === "SELECT") {
    const newName = qualified(o.driver, o.database, o.newTable);
    return !/^SELECT\s+setval\s*\(\s*pg_get_serial_sequence\s*\(/i.test(sql.trim()) || lits[0] !== newName;
  }
  const isSeq = first === "CREATE" && tokens.some((t) => t.text.toUpperCase() === "SEQUENCE");
  const isDefault = first === "ALTER" && tokens.some((t) => t.text.toUpperCase() === "DEFAULT");
  if (!isSeq && !isDefault) return false;
  if (lits.some(isSource)) return true;
  if (isSeq) {
    const seq = tokens.findIndex((t) => t.text.toUpperCase() === "SEQUENCE");
    const nm = readQualifiedName(tokens, seq + 1);
    if (nm && nm.last.toLowerCase() === o.sourceTable.toLowerCase()) return true;
  }
  return false;
}

function buildInsertSelect(o: CloneOptions, newName: string, oldName: string): string {
  const cols = o.columns && o.columns.length > 0 ? o.columns.map((c) => quoteIdentFor(o.driver, c)).join(", ") : null;
  // PostgreSQL の GENERATED ALWAYS AS IDENTITY は OVERRIDING SYSTEM VALUE が無いと値を入れられない
  // (identity 列が無くても構文上は許される)。
  const override = o.driver === "postgres" && cols ? " OVERRIDING SYSTEM VALUE" : "";
  return cols
    ? `INSERT INTO ${newName} (${cols})${override} SELECT ${cols} FROM ${oldName}`
    : `INSERT INTO ${newName} SELECT * FROM ${oldName}`;
}

/** MySQL の `EXTRA` が生成列 (VIRTUAL / STORED GENERATED) を示すか。`DEFAULT_GENERATED` は式既定値なので生成列ではない。 */
const MYSQL_GENERATED_COLUMN = /\b(?:VIRTUAL|STORED)\s+GENERATED\b/i;

/**
 * INSERT ... SELECT に使う明示列リスト。生成列は値を入れられないので除く。
 * - MySQL: `EXTRA` に `VIRTUAL GENERATED` / `STORED GENERATED` を含む列
 * - PostgreSQL: `generatedNames` (information_schema.columns.is_generated = 'ALWAYS') の列
 * - SQLite: `PRAGMA table_info` が生成列を返さないので除外不要
 * 列が 1 つも無ければ null (呼び出し側は `SELECT *` に退避)。
 */
export function insertableColumns(
  driver: string,
  columns: { name: string; extra?: string }[],
  generatedNames: string[] = [],
): string[] | null {
  const gen = new Set(generatedNames);
  const out = columns
    .filter((c) => !(driver === "mysql" && MYSQL_GENERATED_COLUMN.test(c.extra ?? "")))
    .filter((c) => !(driver === "postgres" && gen.has(c.name)))
    .map((c) => c.name);
  return out.length > 0 ? out : null;
}

const sqlLit = (x: string) => `'${x.replace(/'/g, "''")}'`;

/** PostgreSQL の列種別。 */
export interface PgColumnFlags {
  /** GENERATED ALWAYS AS (expr) STORED の列 (INSERT から除く)。 */
  generated: string[];
  /** identity 列 (ALWAYS / BY DEFAULT)。 */
  identity: string[];
  /** `nextval('...'::regclass)` を既定値に持つ serial 列 (identity は含めない)。 */
  serial: string[];
}

/** PostgreSQL: 列の生成/identity/serial 種別を引く読み取りクエリ。 */
export function buildPgColumnFlagsSql(schema: string, table: string): string {
  return (
    "SELECT column_name, is_generated, is_identity, column_default FROM information_schema.columns " +
    `WHERE table_schema = ${sqlLit(schema)} AND table_name = ${sqlLit(table)} ORDER BY ordinal_position`
  );
}

/** `buildPgColumnFlagsSql` の結果行 (列名, is_generated, is_identity, column_default) を分類する。 */
export function parsePgColumnFlags(rows: unknown[][]): PgColumnFlags {
  const out: PgColumnFlags = { generated: [], identity: [], serial: [] };
  for (const r of rows) {
    const name = String(r[0]);
    if (String(r[1]) === "ALWAYS") out.generated.push(name);
    else if (String(r[2]) === "YES") out.identity.push(name);
    else if (/^nextval\(.*::regclass\)$/s.test(String(r[3] ?? ""))) out.serial.push(name);
  }
  return out;
}

/** PostgreSQL: 外部キー定義 (`pg_get_constraintdef`) を引く読み取りクエリ。 */
export function buildPgForeignKeysSql(schema: string, table: string): string {
  const rel = `${quoteIdentFor("postgres", schema)}.${quoteIdentFor("postgres", table)}`;
  return (
    "SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint " +
    `WHERE conrelid = to_regclass(${sqlLit(rel)}) AND contype = 'f' ORDER BY conname`
  );
}

export interface PgForeignKey {
  name: string;
  def: string;
}

export function parsePgForeignKeys(rows: unknown[][]): PgForeignKey[] {
  return rows.map((r) => ({ name: String(r[0]), def: String(r[1]) }));
}

/** serial 列用に新規作成するシーケンス名 (`<新>_<列>_seq`、PostgreSQL の 63 文字に収める)。 */
function seqName(o: CloneOptions, col: string): string {
  const base = `${o.newTable}_${col}`;
  return `${base.slice(0, 63 - 4)}_seq`;
}

/**
 * MySQL は CREATE TABLE が暗黙コミットなので、後続の文 (INSERT など) が失敗すると空の複製が
 * 残る。失敗後にテーブル一覧を見て、新名が存在すれば「作成済みだが後続が失敗」と判定する。
 */
export function isPartialCloneFailure(
  driver: string,
  statementCount: number,
  tablesAfterFailure: string[] | null,
  newTable: string,
): boolean {
  if (driver !== "mysql" || statementCount < 2 || !tablesAfterFailure) return false;
  const want = newTable.toLowerCase();
  return tablesAfterFailure.some((t) => t.toLowerCase() === want);
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
