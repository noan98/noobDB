// CREATE TABLE ウィザードの SQL 生成 (純ロジック)。
//
// フォームのカラム定義 (CreateTableForm) から方言に応じた CREATE TABLE 文を組み立てる。
// 識別子のクオートは sqlDialect.ts、DEFAULT のリテラルエスケープは cellEdit.ts の
// quoteString を流用する。副作用が無いので Vitest でユニットテストする。

import type { TableColumnInfo } from "../api/tauri";
import { quoteIdentFor } from "./sqlDialect";
import { quoteString } from "./cellEdit";
import {
  checkClause,
  foreignKeyClause,
  isCompleteCheck,
  isCompleteForeignKey,
  type CheckDef,
  type ForeignKeyDef,
} from "./tableConstraints";

export interface ColumnDef {
  name: string;
  /** 型名 (例: VARCHAR(255), INT, TEXT)。ユーザ入力をそのまま使う。 */
  type: string;
  notNull: boolean;
  primaryKey: boolean;
  unique: boolean;
  /** 自動採番 (MySQL AUTO_INCREMENT / PostgreSQL IDENTITY / SQLite AUTOINCREMENT)。 */
  autoIncrement: boolean;
  /** DEFAULT 値。空なら付与しない。数値/キーワードは素通し、それ以外は文字列リテラル化。 */
  defaultValue: string;
}

export interface CreateTableForm {
  database?: string | null;
  table: string;
  columns: ColumnDef[];
  /** 外部キー (#1191)。不完全な行 (列・参照先が未入力) は無視する。 */
  foreignKeys?: ForeignKeyDef[];
  /** CHECK 制約 (#1191)。式が空の行は無視する。 */
  checks?: CheckDef[];
}

const NUMERIC_TYPE_RE =
  /^(tinyint|smallint|mediumint|bigint|int\d*|integer|serial\d*|smallserial|bigserial|numeric|decimal|dec|float\d*|double|real|number|money|bit)\b/i;
const BOOL_TYPE_RE = /^(bool|boolean)\b/i;

/** 対応する `)` の次の位置を返す (文字列リテラル内の括弧は無視)。`s[open]` は `(`。無ければ -1。 */
export function matchParen(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === "'") {
      i++;
      while (i < s.length && !(s[i] === "'" && s[i + 1] !== "'")) i += s[i] === "'" ? 2 : 1;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i + 1;
  }
  return -1;
}

const CAST_TAIL_RE = /^\s*::\s*[A-Za-z][\w\s]*(\(\s*\d+(\s*,\s*\d+)?\s*\))?(\[\])?$/;

/**
 * DEFAULT 入力の形。先頭が閉じた `'...'` ("quoted")・全体を括る `(...)` ("paren")・
 * `ident(...)` ("call") のいずれかで、その直後が末尾か `::型` のときだけ式とみなす。
 * `Error::NotFound` や `fe80::abcd` のような通常の文字列は null (リテラル扱い)。
 */
function defaultExprKind(v: string): "quoted" | "paren" | "call" | null {
  const okTail = (end: number) => end === v.length || CAST_TAIL_RE.test(v.slice(end));
  if (v[0] === "'") {
    const m = /^'(?:[^']|'')*'/.exec(v);
    return m && okTail(m[0].length) ? "quoted" : null;
  }
  if (v[0] === "(") {
    const end = matchParen(v, 0);
    return end > 0 && okTail(end) ? "paren" : null;
  }
  const m = /^[A-Za-z_][\w.]*\(/.exec(v);
  if (m) {
    const end = matchParen(v, m[0].length - 1);
    return end > 0 && okTail(end) ? "call" : null;
  }
  return null;
}

/** 括らずに出せる現在時刻系の関数呼び出し (MySQL の `DEFAULT CURRENT_TIMESTAMP(6)` 等)。 */
export const CURRENT_TIME_FN_RE =
  /^(current_timestamp|now|localtime|localtimestamp|current_date|current_time)\s*(\(\s*\d*\s*\))?$/i;

export interface FormatDefaultOptions {
  /** true なら式判定をせず、数値/キーワード以外は常に文字列リテラルにする (既存列の未変更既定値用)。 */
  literal?: boolean;
}

/**
 * DEFAULT 句を組み立てる。空なら null。式 (`'..'`・`(..)`・`関数(..)` とその `::型`) と
 * 既知キーワードは素通し、それ以外は文字列化。MySQL / SQLite は括弧なしの関数呼び出し
 * を `(...)` で包む (現在時刻系を除く。PostgreSQL は逐語)。数値リテラルは `type` が
 * 数値型のときだけ素通しし、文字列列の `007` が `7` になるのを防ぐ。`true`/`false` は
 * 数値型と真偽型だけ素通し。`type` 省略時は従来どおり型を問わず素通し。
 */
export function formatDefault(
  driver: string,
  raw: string,
  type?: string,
  options: FormatDefaultOptions = {},
): string | null {
  const v = raw.trim();
  if (!v) return null;
  const t = type?.trim();
  const numericType = t === undefined || t === "" ? undefined : NUMERIC_TYPE_RE.test(t);
  const boolType = t === undefined || t === "" ? undefined : BOOL_TYPE_RE.test(t);
  if (/^-?\d+(\.\d+)?$/.test(v) && numericType !== false) return v;
  const upper = v.toUpperCase();
  if (upper === "TRUE" || upper === "FALSE") {
    if (numericType === false && boolType === false) return quoteString(driver, v);
    return upper;
  }
  const keywords = new Set(["NULL", "CURRENT_TIMESTAMP", "CURRENT_DATE", "CURRENT_TIME", "NOW()"]);
  if (keywords.has(upper)) return upper;
  if (!options.literal) {
    const kind = defaultExprKind(v);
    if (kind === "call" && driver !== "postgres" && !CURRENT_TIME_FN_RE.test(v)) return `(${v})`;
    if (kind !== null) return v;
  }
  return quoteString(driver, v);
}

/** 完全修飾したテーブル名 (SQLite はスキーマ非対応なので table のみ)。 */
function qualifiedName(driver: string, database: string | null | undefined, table: string): string {
  if (driver === "sqlite" || !database) return quoteIdentFor(driver, table);
  return `${quoteIdentFor(driver, database)}.${quoteIdentFor(driver, table)}`;
}

/**
 * フォーム定義から CREATE TABLE 文を生成する。空のテーブル名/カラム名はそのまま
 * (UI 側でバリデーション)。SQLite の `INTEGER PRIMARY KEY AUTOINCREMENT` 特殊形に対応。
 */
export function buildCreateTableSql(driver: string, form: CreateTableForm): string {
  const cols = form.columns;
  const pkCols = cols.filter((c) => c.primaryKey);

  // SQLite の AUTOINCREMENT は単一 INTEGER PRIMARY KEY のときだけ有効。その場合は
  // インライン宣言にし、テーブルレベルの PRIMARY KEY 制約は付けない。
  const sqliteAutoPk =
    driver === "sqlite" &&
    pkCols.length === 1 &&
    pkCols[0].autoIncrement &&
    cols.filter((c) => c.autoIncrement).length === 1;

  const lines: string[] = cols.map((c) => columnLine(driver, c, { sqliteAutoPk }));

  // テーブルレベル PRIMARY KEY (SQLite 自動採番の特殊形を除く)。
  if (pkCols.length > 0 && !sqliteAutoPk) {
    const pkList = pkCols.map((c) => quoteIdentFor(driver, c.name)).join(", ");
    lines.push(`PRIMARY KEY (${pkList})`);
  }

  // FK / CHECK はテーブル制約として末尾に並べる (SQLite でも CREATE TABLE 内なら可)。
  for (const fk of form.foreignKeys ?? []) {
    if (isCompleteForeignKey(fk)) lines.push(foreignKeyClause(driver, form.database, fk));
  }
  for (const ck of form.checks ?? []) {
    if (isCompleteCheck(ck)) lines.push(checkClause(driver, ck));
  }

  const name = qualifiedName(driver, form.database, form.table);
  return `CREATE TABLE ${name} (\n  ${lines.join(",\n  ")}\n);`;
}

function columnLine(driver: string, col: ColumnDef, opts: { sqliteAutoPk: boolean }): string {
  const name = quoteIdentFor(driver, col.name);
  const parts: string[] = [name];

  // SQLite 自動採番 PK の特殊形: `INTEGER PRIMARY KEY AUTOINCREMENT`。
  if (opts.sqliteAutoPk && col.primaryKey && col.autoIncrement) {
    parts.push("INTEGER", "PRIMARY KEY", "AUTOINCREMENT");
    return parts.join(" ");
  }

  parts.push(col.type.trim() || "TEXT");

  // NOT NULL: テーブルレベル PK が NOT NULL を含意するが、明示指定も尊重する。
  if (col.notNull) parts.push("NOT NULL");
  if (col.unique && !col.primaryKey) parts.push("UNIQUE");

  if (col.autoIncrement) {
    if (driver === "mysql") parts.push("AUTO_INCREMENT");
    else if (driver === "postgres") parts.push("GENERATED BY DEFAULT AS IDENTITY");
    // SQLite の非 PK 自動採番は無効なので無視する。
  }

  const def = formatDefault(driver, col.defaultValue, col.type);
  if (def !== null) parts.push(`DEFAULT ${def}`);

  return parts.join(" ");
}

/**
 * 既存テーブルの列メタデータから CREATE TABLE ウィザードの列定義の雛形を作る (#1540)。
 *
 * 型名は方言のまま (`data_type` を逐語) 渡すので、同じドライバの接続なら追加変換なしで
 * 使える。主キー (`PRI`)・単一列 UNIQUE (`UNI`)・NOT NULL・既定値を引き継ぐ。
 * - 自動採番 (MySQL `auto_increment` / PostgreSQL の `nextval(...)` 既定値) は
 *   `autoIncrement` に写し、既定値は空にする (`nextval` は元テーブルのシーケンスを指すため)。
 * - 生成列 (`GENERATED`、`DEFAULT_GENERATED` を除く) は式が取れないので既定値なしの通常列として写す。
 * - 外部キー・CHECK・インデックスは引き継がない (必要なら制約エディタで足す)。
 */
export function columnDefsFromTableInfo(columns: readonly TableColumnInfo[]): ColumnDef[] {
  return columns.map((c) => {
    const extra = c.extra.toLowerCase();
    const def = (c.default ?? "").trim();
    const serial = /^nextval\(/i.test(def);
    const autoIncrement = extra.includes("auto_increment") || serial;
    const generated = extra.replace("default_generated", "").includes("generated");
    const primaryKey = c.key.toUpperCase() === "PRI";
    return {
      name: c.name,
      type: c.data_type,
      notNull: !c.nullable || primaryKey,
      primaryKey,
      unique: c.key.toUpperCase() === "UNI",
      autoIncrement,
      defaultValue: autoIncrement || generated ? "" : def,
    };
  });
}
