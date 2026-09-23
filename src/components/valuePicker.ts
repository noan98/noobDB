// FK / ENUM / SET / CHECK 対応のスマート値ピッカー (#1067) の純ロジック。
//
// セル編集・行追加の入力欄に「参照先テーブルの有効値」や「型・制約が許す値」を
// 候補として出すため、次の 3 つを副作用なしで担う:
//
// 1. 候補取得用の **読み取り専用 SQL** の生成 (識別子は `quoteIdentFor`、値・検索語は
//    `quoteString` + `escapeLikeWildcards` の既存リテラル生成規約に従う。自前で
//    クオートしない)。FK 候補は必ず行数上限 (LIMIT / TOP) を付ける。
// 2. 型定義 (`enum('a','b')` / `set(...)` / DuckDB の `ENUM('a', 'b')`) と CHECK 制約式
//    (`col IN (...)` / `col = ANY (ARRAY[...])` / `col = 'a' OR col = 'b'`) からの
//    許可値の抽出。
// 3. 取得結果の行 → 候補文字列への変換。
//
// 候補は入力欄の補完にすぎず、選んだ値は既存のインライン編集バッファ /
// 行追加バッファ (`PendingEdits` / `PendingInsertRow`) にそのまま載る。DB への
// 新しい書き込み経路は作らない (確定は従来どおり Apply)。
//
// ## ドライバごとの対応範囲 (取れないものは「候補なし = 従来のテキスト入力」に縮退)
//
// | ドライバ | FK 候補 | ENUM / SET | CHECK 許可値 |
// |---|---|---|---|
// | MySQL / MariaDB | ○ | ○ (`COLUMN_TYPE` を解析、追加クエリ不要) | ○ (`information_schema.CHECK_CONSTRAINTS`。8.0.16 未満の MySQL は表が無くクエリが失敗 → CHECK のみ縮退) |
// | PostgreSQL | ○ | ○ (ユーザ定義 ENUM を `pg_enum` から取得) | ○ (`pg_get_constraintdef`) |
// | SQLite | ○ | — (ENUM 型が無い) | ○ (`sqlite_master.sql` の CHECK 句を解析) |
// | DuckDB | ○ | ○ (`information_schema.columns.data_type` の `ENUM(...)`) | ○ (`duckdb_constraints()`) |
// | SQL Server | ○ | — (ENUM 型が無い) | ○ (`sys.check_constraints.definition`) |
//
// CHECK は「列 = 定数の列挙」と読める形 (IN リスト / `= ANY (ARRAY[...])` / 同一列の
// 等値比較だけを OR で繋いだもの) だけを候補化する。範囲 (`BETWEEN` / `>`)・関数・
// 複数列にまたがる式などは許可値の有限集合にならないため候補を出さない。

import type { CellValue, QueryResult, TableColumnInfo } from "../api/tauri";
import { escapeLikeWildcards } from "./dataSearch";
import { qualifiedTableRef, quoteString } from "./cellEdit";
import { quoteIdentFor } from "./sqlDialect";

/** FK 候補 1 回の取得で返す既定の最大件数。 */
export const FK_CANDIDATE_LIMIT = 50;
/** 許可値 (PG ENUM / CHECK 定義) 取得の行数上限 (バックエンド側上限 1000 以内)。 */
export const ALLOWED_VALUES_ROW_CAP = 1000;

/** 候補の出どころ。UI のバッジ表示にも使う。 */
export type PickerKind = "fk" | "enum" | "set" | "check";

/** 列ごとの許可値 (有限集合)。 */
export interface AllowedValues {
  kind: Exclude<PickerKind, "fk">;
  values: string[];
}

// ---------------------------------------------------------------------------
// 1. SQL 生成
// ---------------------------------------------------------------------------

/** 前方一致フィルタ用に列を文字列へキャストする式 (ドライバ方言)。 */
function textCastExpr(driver: string, quotedCol: string): string {
  switch (driver) {
    case "postgres":
    case "sqlite":
      return `CAST(${quotedCol} AS TEXT)`;
    case "duckdb":
      return `CAST(${quotedCol} AS VARCHAR)`;
    case "mssql":
      return `CAST(${quotedCol} AS NVARCHAR(4000))`;
    default:
      return `CAST(${quotedCol} AS CHAR)`;
  }
}

function tableRef(driver: string, database: string | null | undefined, table: string): string {
  return database ? qualifiedTableRef(driver, database, table) : quoteIdentFor(driver, table);
}

export interface FkCandidatesParams {
  driver: string;
  /** 編集中テーブルのデータベース (PostgreSQL / DuckDB ではスキーマ)。参照先も同じ場所にある前提。 */
  database?: string | null;
  refTable: string;
  refColumn: string;
  /** 入力中の文字列。空でなければ前方一致でサーバ側フィルタする。 */
  search?: string;
  /** 最大件数 (1 以上に丸める)。 */
  limit?: number;
}

/**
 * FK 列の候補値 (参照先テーブルの DISTINCT 値) を引く読み取り専用 SQL。
 * NULL は候補にしない (NULL は `null` と打てば従来どおり入る)。必ず行数上限付き。
 */
export function buildFkCandidatesSql(p: FkCandidatesParams): string {
  const limit = Math.max(1, Math.floor(p.limit ?? FK_CANDIDATE_LIMIT));
  const col = quoteIdentFor(p.driver, p.refColumn);
  const where = [`${col} IS NOT NULL`];
  const search = p.search ?? "";
  if (search !== "") {
    const pattern = quoteString(p.driver, `${escapeLikeWildcards(search)}%`);
    where.push(`${textCastExpr(p.driver, col)} LIKE ${pattern} ESCAPE ${quoteString(p.driver, "\\")}`);
  }
  const from = tableRef(p.driver, p.database, p.refTable);
  const top = p.driver === "mssql" ? `TOP (${limit}) ` : "";
  const tail = p.driver === "mssql" ? "" : ` LIMIT ${limit}`;
  return `SELECT DISTINCT ${top}${col} FROM ${from} WHERE ${where.join(" AND ")} ORDER BY ${col}${tail}`;
}

/** 許可値取得クエリの用途。 */
export type AllowedValuesQueryPurpose = "pgEnum" | "check";

export interface AllowedValuesQuery {
  purpose: AllowedValuesQueryPurpose;
  sql: string;
}

/**
 * テーブル 1 つぶんの許可値を集めるための読み取り専用 SQL 群。
 *
 * - `pgEnum` (PostgreSQL のみ): 行 = `[列名, ENUM ラベル]` (列順・定義順)。
 * - `check`: 行 = `[制約定義テキスト]`。SQLite は CREATE TABLE 文全体を返す
 *   (列制約・表制約の CHECK をまとめて解析する)。
 *
 * MySQL の ENUM / SET と DuckDB の ENUM は型名に値が入っているのでクエリ不要。
 */
export function buildAllowedValuesQueries(
  driver: string,
  database: string | null | undefined,
  table: string,
): AllowedValuesQuery[] {
  const lit = (s: string) => quoteString(driver, s);
  switch (driver) {
    case "postgres": {
      const schema = database ? lit(database) : "current_schema()";
      return [
        {
          purpose: "pgEnum",
          sql:
            "SELECT a.attname, e.enumlabel FROM pg_catalog.pg_attribute a" +
            " JOIN pg_catalog.pg_class c ON c.oid = a.attrelid" +
            " JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace" +
            " JOIN pg_catalog.pg_enum e ON e.enumtypid = a.atttypid" +
            ` WHERE n.nspname = ${schema} AND c.relname = ${lit(table)}` +
            " AND a.attnum > 0 AND NOT a.attisdropped" +
            " ORDER BY a.attnum, e.enumsortorder",
        },
        {
          purpose: "check",
          sql:
            "SELECT pg_catalog.pg_get_constraintdef(k.oid) FROM pg_catalog.pg_constraint k" +
            " JOIN pg_catalog.pg_class c ON c.oid = k.conrelid" +
            " JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace" +
            ` WHERE k.contype = 'c' AND n.nspname = ${schema} AND c.relname = ${lit(table)}`,
        },
      ];
    }
    case "mysql": {
      const schema = database ? lit(database) : "DATABASE()";
      return [
        {
          purpose: "check",
          sql:
            "SELECT cc.CHECK_CLAUSE FROM information_schema.TABLE_CONSTRAINTS tc" +
            " JOIN information_schema.CHECK_CONSTRAINTS cc" +
            " ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME" +
            ` WHERE tc.CONSTRAINT_TYPE = 'CHECK' AND tc.TABLE_SCHEMA = ${schema} AND tc.TABLE_NAME = ${lit(table)}`,
        },
      ];
    }
    case "sqlite":
      return [
        {
          purpose: "check",
          sql: `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ${lit(table)}`,
        },
      ];
    case "duckdb": {
      const schema = database ? lit(database) : "current_schema()";
      return [
        {
          purpose: "check",
          sql:
            "SELECT constraint_text FROM duckdb_constraints()" +
            ` WHERE constraint_type = 'CHECK' AND schema_name = ${schema} AND table_name = ${lit(table)}`,
        },
      ];
    }
    case "mssql": {
      // バックエンドのスキーマ introspection は dbo スキーマ前提 (`qualifiedTableRef` と同じ)。
      const prefix = database ? `${quoteIdentFor(driver, database)}.` : "";
      return [
        {
          purpose: "check",
          sql:
            `SELECT cc.definition FROM ${prefix}sys.check_constraints cc` +
            ` JOIN ${prefix}sys.tables t ON t.object_id = cc.parent_object_id` +
            ` JOIN ${prefix}sys.schemas s ON s.schema_id = t.schema_id` +
            ` WHERE s.name = N'dbo' AND t.name = ${lit(table)}`,
        },
      ];
    }
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// 2. 許可値の抽出
// ---------------------------------------------------------------------------

type Token =
  | { t: "id"; v: string; quoted: boolean }
  | { t: "str"; v: string }
  | { t: "num"; v: string }
  | { t: "op"; v: string };

/** CHECK 式 / 型定義を解析用のトークン列へ分解する (ドライバの文字列エスケープ規則に従う)。 */
function tokenize(driver: string, src: string): Token[] {
  const out: Token[] = [];
  const backslashEscapes = driver === "mysql";
  const bracketIdents = driver === "mssql" || driver === "sqlite";
  let i = 0;
  const n = src.length;
  const readString = (quote: string): string => {
    // src[i] は開きクオート
    i++;
    let s = "";
    while (i < n) {
      const ch = src[i];
      if (backslashEscapes && ch === "\\" && i + 1 < n) {
        const nx = src[i + 1];
        s += nx === "n" ? "\n" : nx === "t" ? "\t" : nx === "0" ? "\0" : nx;
        i += 2;
        continue;
      }
      if (ch === quote) {
        if (src[i + 1] === quote) {
          s += quote;
          i += 2;
          continue;
        }
        i++;
        return s;
      }
      s += ch;
      i++;
    }
    return s;
  };
  while (i < n) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "'") {
      out.push({ t: "str", v: readString("'") });
      continue;
    }
    if (ch === '"' || ch === "`") {
      out.push({ t: "id", v: readString(ch), quoted: true });
      continue;
    }
    if (ch === "[" && bracketIdents) {
      const end = src.indexOf("]", i + 1);
      const stop = end < 0 ? n : end;
      out.push({ t: "id", v: src.slice(i + 1, stop), quoted: true });
      i = stop + 1;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      const m = /^\d*\.?\d+(?:[eE][+-]?\d+)?/.exec(src.slice(i));
      const v = m ? m[0] : ch;
      out.push({ t: "num", v });
      i += v.length;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(src.slice(i));
      const word = m ? m[0] : ch;
      i += word.length;
      // 文字列の接頭辞: N'..' (MSSQL の Unicode) / E'..' (PG) / _utf8mb4'..' (MySQL のイントロデューサ)。
      if (src[i] === "'" && (/^[NnEe]$/.test(word) || word.startsWith("_"))) {
        out.push({ t: "str", v: readString("'") });
        continue;
      }
      out.push({ t: "id", v: word, quoted: false });
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === "::" || two === "<>" || two === "!=" || two === ">=" || two === "<=") {
      out.push({ t: "op", v: two });
      i += 2;
      continue;
    }
    out.push({ t: "op", v: ch });
    i++;
  }
  return out;
}

const isKw = (tok: Token | undefined, kw: string): boolean =>
  !!tok && tok.t === "id" && !tok.quoted && tok.v.toUpperCase() === kw;
const isOp = (tok: Token | undefined, op: string): boolean => !!tok && tok.t === "op" && tok.v === op;

/** `::type` / `::character varying(10)[]` のような PostgreSQL 系キャストを取り除く。 */
function stripCasts(tokens: Token[]): Token[] {
  const out: Token[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (!isOp(tokens[i], "::")) {
      out.push(tokens[i]);
      continue;
    }
    let j = i + 1;
    while (j < tokens.length && tokens[j].t === "id") j++;
    if (isOp(tokens[j], "(")) {
      let k = j + 1;
      while (k < tokens.length && (tokens[k].t === "num" || isOp(tokens[k], ","))) k++;
      if (isOp(tokens[k], ")")) j = k + 1;
    }
    while (isOp(tokens[j], "[") && isOp(tokens[j + 1], "]")) j += 2;
    i = j - 1;
  }
  return out;
}

/** `( X )` の形で 1 トークンだけを包む冗長な括弧を外す (`(status)::text` → `status`)。 */
function stripSingletonParens(tokens: Token[]): Token[] {
  let cur = tokens;
  for (;;) {
    const next: Token[] = [];
    let changed = false;
    for (let i = 0; i < cur.length; i++) {
      if (
        isOp(cur[i], "(") &&
        cur[i + 1] &&
        cur[i + 1].t !== "op" &&
        isOp(cur[i + 2], ")") &&
        // `IN ('a')` / 関数呼び出し `f(x)` の括弧は構文の一部なので残す。
        !(cur[i - 1] && cur[i - 1].t === "id" && !(cur[i - 1] as { quoted: boolean }).quoted)
      ) {
        next.push(cur[i + 1]);
        i += 2;
        changed = true;
        continue;
      }
      next.push(cur[i]);
    }
    cur = next;
    if (!changed) return cur;
  }
}

/** 位置 `i` から定数リテラルを 1 つ読む。読めなければ null。 */
function readLiteral(tokens: Token[], i: number): { value: string; next: number } | null {
  const tok = tokens[i];
  if (!tok) return null;
  if (tok.t === "str" || tok.t === "num") return { value: tok.v, next: i + 1 };
  if (isOp(tok, "-") && tokens[i + 1]?.t === "num") {
    return { value: `-${tokens[i + 1].v}`, next: i + 2 };
  }
  return null;
}

/** `lit, lit, ... <close>` を読む。 */
function readLiteralList(tokens: Token[], i: number, close: string): string[] | null {
  const values: string[] = [];
  let j = i;
  for (;;) {
    const lit = readLiteral(tokens, j);
    if (!lit) return null;
    values.push(lit.value);
    j = lit.next;
    if (isOp(tokens[j], ",")) {
      j++;
      continue;
    }
    return isOp(tokens[j], close) ? values : null;
  }
}

const sameColumn = (tok: Token | undefined, column: string): boolean =>
  !!tok && tok.t === "id" && tok.v.toLowerCase() === column.toLowerCase();

/** 1 つの CHECK 式 (トークン列) から `column` の許可値を取り出す。 */
function allowedFromExpr(tokens: Token[], column: string): string[] | null {
  const toks = stripSingletonParens(stripCasts(tokens));
  for (let i = 0; i < toks.length; i++) {
    if (!sameColumn(toks[i], column)) continue;
    // `NOT (col IN (...))` のような否定は許可値にならない。
    let p = i - 1;
    while (p >= 0 && isOp(toks[p], "(")) p--;
    if (isKw(toks[p], "NOT")) continue;
    // A. col IN (lit, ...)
    if (isKw(toks[i + 1], "IN") && isOp(toks[i + 2], "(")) {
      const vals = readLiteralList(toks, i + 3, ")");
      if (vals) return vals;
    }
    // B. col = ANY (ARRAY[lit, ...])
    if (isOp(toks[i + 1], "=") && isKw(toks[i + 2], "ANY")) {
      let j = i + 3;
      while (isOp(toks[j], "(")) j++;
      if (isKw(toks[j], "ARRAY") && isOp(toks[j + 1], "[")) {
        const vals = readLiteralList(toks, j + 2, "]");
        if (vals) return vals;
      }
    }
  }
  // C. col = lit OR col = lit ... (式全体が同一列の等値比較の OR だけでできている)
  const flat = toks.filter((t) => !isOp(t, "(") && !isOp(t, ")"));
  const values: string[] = [];
  let j = 0;
  while (j < flat.length) {
    let lit: { value: string; next: number } | null = null;
    if (sameColumn(flat[j], column) && isOp(flat[j + 1], "=")) {
      lit = readLiteral(flat, j + 2);
    } else {
      const l = readLiteral(flat, j);
      if (l && isOp(flat[l.next], "=") && sameColumn(flat[l.next + 1], column)) {
        lit = { value: l.value, next: l.next + 2 };
      }
    }
    if (!lit) return null;
    values.push(lit.value);
    j = lit.next;
    if (j === flat.length) break;
    if (!isKw(flat[j], "OR")) return null;
    j++;
  }
  return values.length > 0 ? values : null;
}

/** トークン列から `CHECK ( ... )` の中身を切り出す。CHECK キーワードが無ければ全体を 1 式とみなす。 */
function splitCheckBodies(tokens: Token[]): Token[][] {
  const bodies: Token[][] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (!isKw(tokens[i], "CHECK") || !isOp(tokens[i + 1], "(")) continue;
    let depth = 0;
    let j = i + 1;
    for (; j < tokens.length; j++) {
      if (isOp(tokens[j], "(")) depth++;
      else if (isOp(tokens[j], ")")) {
        depth--;
        if (depth === 0) break;
      }
    }
    bodies.push(tokens.slice(i + 2, j));
    i = j;
  }
  return bodies.length > 0 ? bodies : [tokens];
}

/**
 * MySQL 8.0 の一部バージョンは `information_schema.CHECK_CONSTRAINTS` の文字列
 * リテラルを `_utf8mb4\'a\'` のようにバックスラッシュ付きで返す。イントロデューサ
 * 直後の `\'` が見つかったら、その表記だとみなしてクオートを戻す。
 */
function normalizeMysqlCheckClause(src: string): string {
  return /_[A-Za-z0-9]+\\'/.test(src) ? src.replace(/\\'/g, "'") : src;
}

/**
 * 制約定義テキスト (複数可) から `column` の許可値を抽出する。最初に候補化できた
 * 制約を採用し、どれも「定数の列挙」と読めなければ null (= 候補なし)。
 */
export function allowedValuesFromCheck(
  driver: string,
  definitions: string[],
  column: string,
): string[] | null {
  for (const def of definitions) {
    const src = driver === "mysql" ? normalizeMysqlCheckClause(def) : def;
    for (const body of splitCheckBodies(tokenize(driver, src))) {
      const vals = allowedFromExpr(body, column);
      if (vals) return dedupe(vals);
    }
  }
  return null;
}

/**
 * 型定義文字列から ENUM / SET の許可値を抽出する。MySQL の `COLUMN_TYPE`
 * (`enum('a','b')` / `set('x','y')`) と DuckDB の `ENUM('a', 'b')` に対応。
 * それ以外の型は null。
 */
export function allowedValuesFromType(driver: string, dataType: string): AllowedValues | null {
  const m = /^\s*(enum|set)\s*\(([\s\S]*)\)\s*$/i.exec(dataType);
  if (!m) return null;
  const kind = m[1].toLowerCase() === "set" ? "set" : "enum";
  // DuckDB に SET 型は無い (`set(` で始まる型名は来ない想定だが念のため弾く)。
  if (kind === "set" && driver !== "mysql") return null;
  const values = readLiteralList(tokenize(driver, `${m[2]})`), 0, ")");
  return values ? { kind, values } : null;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * テーブル全列の許可値マップを組み立てる。
 *
 * - 型由来 (MySQL ENUM/SET・DuckDB ENUM) は `columns` だけで決まる。
 * - `pgEnumRows` は `buildAllowedValuesQueries` の `pgEnum` 結果 (`[列名, ラベル]`)。
 * - `checkDefinitions` は `check` 結果の定義テキスト。
 *
 * 優先順位は 型 (ENUM/SET) > CHECK。取得に失敗したクエリは空配列で渡せばよい
 * (その種類の候補だけが静かに欠ける)。
 */
export function collectAllowedValues(
  driver: string,
  columns: TableColumnInfo[],
  pgEnumRows: CellValue[][] = [],
  checkDefinitions: string[] = [],
): Map<string, AllowedValues> {
  const out = new Map<string, AllowedValues>();
  const pgEnums = new Map<string, string[]>();
  for (const row of pgEnumRows) {
    const col = row[0];
    const label = row[1];
    if (col === null || col === undefined || label === null || label === undefined) continue;
    const list = pgEnums.get(String(col)) ?? [];
    list.push(String(label));
    pgEnums.set(String(col), list);
  }
  for (const c of columns) {
    const fromType = allowedValuesFromType(driver, c.data_type);
    if (fromType) {
      out.set(c.name, fromType);
      continue;
    }
    const pg = pgEnums.get(c.name);
    if (pg && pg.length > 0) {
      out.set(c.name, { kind: "enum", values: dedupe(pg) });
      continue;
    }
    const fromCheck = checkDefinitions.length
      ? allowedValuesFromCheck(driver, checkDefinitions, c.name)
      : null;
    if (fromCheck) out.set(c.name, { kind: "check", values: fromCheck });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3. 結果の変換・種別判定
// ---------------------------------------------------------------------------

/**
 * 候補取得結果の先頭列を候補文字列の配列にする。表示・入力と同じく `String(v)`
 * で文字列化する (64bit 整数はバックエンドが `Value::from_*_lossless` で安全整数を
 * 超える値を文字列として返すため、ここで数値に戻さず桁を保ったまま候補になる)。
 * NULL は除外し、重複は落とす。
 */
export function candidatesFromResult(result: Pick<QueryResult, "rows">): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const row of result.rows) {
    const v = row[0];
    if (v === null || v === undefined) continue;
    const s = String(v);
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/** 定義テキストの結果 (1 列目) を文字列配列にする。 */
export function definitionsFromResult(result: Pick<QueryResult, "rows">): string[] {
  return candidatesFromResult(result);
}

/**
 * 列のピッカー種別を決める。許可値 (ENUM / SET / CHECK) があればそれを優先し、
 * 無ければ FK (参照先の列が分かるときだけ)。どちらでもなければ null (= 従来の
 * テキスト入力)。
 */
export function pickerKindFor(
  meta: Pick<TableColumnInfo, "referenced_table" | "referenced_column"> | undefined,
  allowed: AllowedValues | undefined,
): PickerKind | null {
  if (allowed && allowed.values.length > 0) return allowed.kind;
  if (meta?.referenced_table && meta.referenced_column) return "fk";
  return null;
}

/**
 * 入力中の値から FK 前方一致検索に使う語を決める。前後の空白は無視し、SQL の
 * NULL を意味する `null` (大文字小文字不問) そのものは検索語にしない (全候補を出す)。
 */
export function fkSearchTerm(typed: string): string {
  const t = typed.trim();
  return /^null$/i.test(t) ? "" : t;
}
