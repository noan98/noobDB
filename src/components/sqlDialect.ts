import { MySQL, PostgreSQL, SQLite, type SQLDialect } from "@codemirror/lang-sql";

/**
 * Driver-aware SQL dialect helpers shared by the query editor and builder.
 * `driver` is the profile's driver string ("mysql" | "postgres" | "sqlite").
 * Unknown values fall back to MySQL behaviour.
 */

/**
 * Identifier quoting: backticks for MySQL, double quotes for
 * Postgres/SQLite (mirrors `db::sync::quote_ident` on the backend).
 */
export function quoteIdentFor(driver: string, name: string): string {
  if (driver === "postgres" || driver === "sqlite") {
    return '"' + name.replace(/"/g, '""') + '"';
  }
  return "`" + name.replace(/`/g, "``") + "`";
}

/**
 * テーブルを開く初回 SELECT (LIMIT なし)。`open_table` (Rust の
 * `commands::table_open::table_select_sql`) と同一の SQL を返す — 共有ゴールデン
 * `fixtures/tableSelectSql.json` で固定 (#1263)。
 *
 * `hiddenColumn`, when given, appends a driver pseudo-column (SQLite
 * `rowid` / PostgreSQL `ctid`) to the SELECT list so it comes back as an
 * ordinary result column — the row-identity fallback for tables with no
 * primary key (#849). Aliased to its own bare name (`AS rowid` / `AS ctid`)
 * so `resolveRowIdentity` can find it by name in the result; harmless when
 * the table happens to also declare a real column with that name; SQLite
 * `SELECT *, rowid` and Postgres `SELECT *, ctid` are both unambiguous
 * because the star expansion and the pseudo-column reference different
 * namespaces.
 */
export function qualifiedTableSql(
  driver: string,
  database: string | null | undefined,
  table: string,
  hiddenColumn?: string | null,
): string {
  const extra = hiddenColumn ? `, ${hiddenColumn}` : "";
  return `SELECT *${extra} FROM ${qualifiedTableName(driver, database, table)}`;
}

/**
 * SQLite で `database` が修飾不要の `main` (空文字・大文字小文字違いを含む) か (#2129)。
 * ツリーの `main` は仮ラベルで、SQL には出さない。
 */
export function isSqliteMainDatabase(database: string | null | undefined): boolean {
  return !database || database.toLowerCase() === "main";
}

/**
 * `db.table` 形式の修飾テーブル名 (識別子はドライバ別にクォート済み)。**表参照の修飾規則はここに
 * 一本化している** (`qualifiedTableSql` / JOIN 雛形 `fkJoin.ts` / `cellEdit.ts` / 保守系 SQL が共有、#1540)。
 *
 * SQLite は `main` / 空なら DB 修飾を付けず (移植性を保つ)、設定でアタッチしたファイルの別名だけ
 * `"別名"."表"` にする (#2129)。修飾なしの名前は temp → main → アタッチ順に探されるため、
 * main に同名の表があると別名側のつもりで main を読み書きしてしまうのを防ぐ。
 * Rust の `db::sync::sqlite_table_ref` と同じ規則 (共有ゴールデン `tableSelectSql.json`)。
 */
export function qualifiedTableName(
  driver: string,
  database: string | null | undefined,
  table: string,
): string {
  if (!database || (driver === "sqlite" && isSqliteMainDatabase(database)))
    return quoteIdentFor(driver, table);
  return `${quoteIdentFor(driver, database)}.${quoteIdentFor(driver, table)}`;
}

const MYSQL_SYSTEM_DATABASES = new Set(["information_schema", "performance_schema", "mysql", "sys"]);

/**
 * Whether an entry from `listDatabases` is an internal namespace that should
 * not be auto-selected as the builder's default. The Postgres backend lists
 * schemas with system ones already excluded server-side, and SQLite exposes a
 * single synthetic database, so only MySQL needs a client-side filter.
 */
export function isSystemDatabase(driver: string, name: string): boolean {
  if (driver === "postgres" || driver === "sqlite") return false;
  return MYSQL_SYSTEM_DATABASES.has(name.toLowerCase());
}

/** CodeMirror SQL dialect for highlighting and completion. */
export function codeMirrorSqlDialectFor(driver: string): SQLDialect {
  if (driver === "postgres") return PostgreSQL;
  if (driver === "sqlite") return SQLite;
  return MySQL;
}

/** `sql-formatter` language identifier. */
export function sqlFormatterLanguageFor(driver: string): "mysql" | "postgresql" | "sqlite" {
  if (driver === "postgres") return "postgresql";
  if (driver === "sqlite") return "sqlite";
  return "mysql";
}

/**
 * 行追加で DB 側に評価させる関数 (#1357)。UI の関数値チップと INSERT の式の単一ソース。
 * 利用者の入力文字列はここを経由せず、固定カタログからのみ式が生まれる。
 */
export type InsertFunctionId = "current_timestamp" | "now" | "current_date" | "current_time" | "uuid";

/**
 * 関数の SQL 式を方言ごとに返す。そのドライバに存在しない関数は `null` (UI は
 * チップを出さない)。未知のドライバは MySQL 扱い (本ファイルの他の関数と同じ規約)。
 * - `now`: SQLite に `NOW()` は無い
 * - `uuid`: PostgreSQL は `gen_random_uuid()` (PG 13 以降の組み込み)、MySQL は `UUID()`、
 *   SQLite は UUID 生成関数を持たないため無し
 */
export function insertFunctionSql(driver: string, fn: InsertFunctionId): string | null {
  switch (fn) {
    case "current_timestamp":
      return "CURRENT_TIMESTAMP";
    case "current_date":
      return "CURRENT_DATE";
    case "current_time":
      return "CURRENT_TIME";
    case "now":
      return driver === "sqlite" ? null : "NOW()";
    case "uuid":
      if (driver === "sqlite") return null;
      return driver === "postgres" ? "gen_random_uuid()" : "UUID()";
  }
}

/** PostgreSQL の識別子の上限 (バイト)。 */
export const PG_IDENT_MAX_BYTES = 63;

/** UTF-8 で `maxBytes` バイトを超えない先頭部分を返す (文字の途中では切らない)。 */
export function truncateUtf8(text: string, maxBytes: number): string {
  const enc = new TextEncoder();
  let out = "";
  let used = 0;
  for (const ch of text) {
    const n = enc.encode(ch).length;
    if (used + n > maxBytes) break;
    out += ch;
    used += n;
  }
  return out;
}

/**
 * 自動命名した PostgreSQL の制約名 / インデックス名を 63 バイトに収める (#2240)。`suffix` (`_fkey` など) は必ず残し、
 * 前半だけを UTF-8 の文字境界で切る。`taken` にある名前とは、PostgreSQL と同じく末尾に連番 (`_fkey1`) を付けて避ける。
 */
export function fitPgName(stem: string, suffix: string, taken: ReadonlySet<string>): string {
  const room = (extra: string) =>
    truncateUtf8(stem, PG_IDENT_MAX_BYTES - new TextEncoder().encode(suffix + extra).length);
  const first = `${room("")}${suffix}`;
  if (!taken.has(first)) return first;
  for (let n = 1; ; n++) {
    const cand = `${room(String(n))}${suffix}${n}`;
    if (!taken.has(cand)) return cand;
  }
}
