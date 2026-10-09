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
  database: string,
  table: string,
  hiddenColumn?: string | null,
): string {
  const extra = hiddenColumn ? `, ${hiddenColumn}` : "";
  // SQLite has a single attached namespace ("main"); leaving the
  // db.table qualification off keeps the generated SELECT portable.
  if (driver === "sqlite") return `SELECT *${extra} FROM ${quoteIdentFor(driver, table)}`;
  return `SELECT *${extra} FROM ${quoteIdentFor(driver, database)}.${quoteIdentFor(driver, table)}`;
}


const MYSQL_SYSTEM_DATABASES = new Set([
  "information_schema",
  "performance_schema",
  "mysql",
  "sys",
]);

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
