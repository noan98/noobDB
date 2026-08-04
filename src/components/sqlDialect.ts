import { MSSQL, MySQL, PostgreSQL, SQLite, type SQLDialect } from "@codemirror/lang-sql";

/**
 * Driver-aware SQL dialect helpers shared by the query editor and builder.
 * `driver` is the profile's driver string
 * ("mysql" | "postgres" | "sqlite" | "mssql", #729). Unknown values fall
 * back to MySQL behaviour.
 */

/**
 * Identifier quoting: backticks for MySQL, double quotes for Postgres/SQLite,
 * square brackets for MSSQL (mirrors `db::sync::quote_ident` on the backend).
 */
export function quoteIdentFor(driver: string, name: string): string {
  if (driver === "postgres" || driver === "sqlite") {
    return '"' + name.replace(/"/g, '""') + '"';
  }
  if (driver === "mssql") {
    return "[" + name.replace(/]/g, "]]") + "]";
  }
  return "`" + name.replace(/`/g, "``") + "`";
}

const MYSQL_SYSTEM_DATABASES = new Set([
  "information_schema",
  "performance_schema",
  "mysql",
  "sys",
]);

const MSSQL_SYSTEM_DATABASES = new Set(["master", "tempdb", "model", "msdb"]);

/**
 * Whether an entry from `listDatabases` is an internal namespace that should
 * not be auto-selected as the builder's default. The Postgres backend lists
 * schemas with system ones already excluded server-side, and SQLite exposes a
 * single synthetic database, so only MySQL/MSSQL need a client-side filter
 * (MSSQL's `sys.databases` includes the 4 built-in system databases).
 */
export function isSystemDatabase(driver: string, name: string): boolean {
  if (driver === "postgres" || driver === "sqlite") return false;
  if (driver === "mssql") return MSSQL_SYSTEM_DATABASES.has(name.toLowerCase());
  return MYSQL_SYSTEM_DATABASES.has(name.toLowerCase());
}

/** CodeMirror SQL dialect for highlighting and completion. */
export function codeMirrorSqlDialectFor(driver: string): SQLDialect {
  if (driver === "postgres") return PostgreSQL;
  if (driver === "sqlite") return SQLite;
  if (driver === "mssql") return MSSQL;
  return MySQL;
}

/** `sql-formatter` language identifier. */
export function sqlFormatterLanguageFor(
  driver: string,
): "mysql" | "postgresql" | "sqlite" | "tsql" {
  if (driver === "postgres") return "postgresql";
  if (driver === "sqlite") return "sqlite";
  if (driver === "mssql") return "tsql";
  return "mysql";
}
